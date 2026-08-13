/**
 * Compile a Solidity source file to a deploy-ready artifact.
 *
 * Writes `<name>.json` next to the source, in the { abi, bytecode } shape that
 * `deploy.js` already understands — so you can go straight from here to:
 *
 *   node deploy.js ./artifacts/Voting.json --gas 1000000 --arg-string-array "A,B,C"
 *
 * Usage:
 *   node compile.js                              # defaults to artifacts/Voting.sol
 *   node compile.js ./artifacts/Voting.sol
 *   node compile.js ./artifacts/Voting.sol --contract Voting --evm-version paris
 *
 * Requires the `solc` devDependency (npm install).
 */

import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const DEFAULT_SOURCE = "./artifacts/Voting.sol";

/**
 * Hedera's EVM tracks upstream releases, but "paris" produces bytecode without
 * the PUSH0 opcode and therefore runs on every Hedera network version. Override
 * with --evm-version if you know your target supports something newer.
 */
const DEFAULT_EVM_VERSION = "paris";

function parseArgs(argv) {
  const [, , ...rest] = argv;
  const opts = {
    file: DEFAULT_SOURCE,
    contract: null,
    evmVersion: DEFAULT_EVM_VERSION,
    optimize: true,
  };

  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case "--contract":
        opts.contract = rest[++i];
        break;
      case "--evm-version":
        opts.evmVersion = rest[++i];
        break;
      case "--no-optimize":
        opts.optimize = false;
        break;
      default:
        if (rest[i].startsWith("--")) {
          throw new Error(`Unknown argument: ${rest[i]}`);
        }
        positional.push(rest[i]);
    }
  }

  if (positional.length > 0) opts.file = positional[0];
  return opts;
}

function compile(opts) {
  const sourcePath = path.resolve(opts.file);
  const fileName = path.basename(sourcePath);
  const content = fs.readFileSync(sourcePath, "utf8");

  const input = {
    language: "Solidity",
    sources: { [fileName]: { content } },
    settings: {
      optimizer: { enabled: opts.optimize, runs: 200 },
      evmVersion: opts.evmVersion,
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object"] },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  // solc reports warnings and errors in the same array; only errors are fatal.
  const diagnostics = output.errors ?? [];
  for (const d of diagnostics.filter((d) => d.severity !== "error")) {
    console.warn(d.formattedMessage ?? d.message);
  }

  const fatal = diagnostics.filter((d) => d.severity === "error");
  if (fatal.length > 0) {
    for (const d of fatal) console.error(d.formattedMessage ?? d.message);
    throw new Error(`Compilation failed with ${fatal.length} error(s).`);
  }

  const compiled = output.contracts?.[fileName] ?? {};
  const names = Object.keys(compiled);
  if (names.length === 0) {
    throw new Error(`No contracts found in ${fileName}.`);
  }

  const name = opts.contract ?? names[0];
  if (!compiled[name]) {
    throw new Error(
      `Contract "${name}" not found in ${fileName}. Available: ${names.join(", ")}.`
    );
  }

  return { sourcePath, name, contract: compiled[name] };
}

function main() {
  const opts = parseArgs(process.argv);
  const { sourcePath, name, contract } = compile(opts);

  const bytecode = contract.evm.bytecode.object;
  if (!bytecode) {
    throw new Error(
      `${name} produced no bytecode — is it an interface or an abstract contract?`
    );
  }

  const artifact = {
    contractName: name,
    abi: contract.abi,
    bytecode, // deploy.js reads this field directly
    compiler: solc.version(),
    evmVersion: opts.evmVersion,
    optimizer: { enabled: opts.optimize, runs: 200 },
  };

  const outPath = path.join(path.dirname(sourcePath), `${name}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  console.log(`Compiled ${path.basename(sourcePath)} -> ${path.relative(process.cwd(), outPath)}`);
  console.log(`  contract    : ${name}`);
  console.log(`  solc        : ${solc.version()}`);
  console.log(`  evmVersion  : ${opts.evmVersion}`);
  console.log(`  bytecode    : ${bytecode.length / 2} bytes`);
}

try {
  main();
} catch (err) {
  console.error(`\n❌ Compile error: ${err.message ?? err}`);
  process.exit(1);
}
