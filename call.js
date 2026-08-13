/**
 * Call a method on a smart contract deployed on the Hedera Testnet.
 *
 * Everything in the CONFIG block below can be overridden from the command line,
 * so for day-to-day use you never need to edit this file:
 *
 *   node call.js --method topicCount --return uint256
 *   node call.js --method vote --mode execute --as voter1 --uint256 0 --return null
 *   node call.js --method setBlacklisted --mode execute --address 0.0.5678 --bool true --return null
 *
 * --as <label> picks WHICH ACCOUNT signs and pays, i.e. what the contract sees
 * as `msg.sender`. The label maps to <LABEL>_ID / <LABEL>_KEY in .env; with no
 * --as flag the HEDERA_OPERATOR_* account is used.
 *
 * Flags:
 *   --contract 0.0.x   contract to call        (default: CONTRACT_ID in .env)
 *   --method NAME      solidity function name
 *   --mode query|execute
 *   --as LABEL         account to call as, e.g. voter1
 *   --gas N
 *   --return TYPE      decode the single return value as TYPE, or "null"
 *   --string V | --uint256 N | --address 0.0.x|0x.. | --bool true|false
 *                      call arguments, applied in the order given
 *
 * Requires a .env file (see .env.example) with HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import sha3 from "js-sha3"; // CommonJS: no named exports
const { keccak256 } = sha3;
import {
  Client,
  PrivateKey,
  AccountId,
  ContractId,
  ContractExecuteTransaction,
  ContractCallQuery,
  ContractFunctionParameters,
  TransactionRecordQuery,
  Hbar,
} from "@hashgraph/sdk";

/* ================================================================== */
/* CONFIG – defaults, all overridable by .env and by CLI flags         */
/* ================================================================== */

// 1. The contract you want to call. Prefer setting CONTRACT_ID in .env.
const CONTRACT_ID = process.env.CONTRACT_ID ?? "0.0.xxxxx";

// 2. "query"   -> read-only view/pure function (free, no state change)
//    "execute" -> state-changing function (costs gas, produces a receipt status)
const MODE = "query";

// 3. Name of the Solidity function to call.
const METHOD_NAME = "topicCount";

// 4. Gas limit (needed for both a query result and an execute transaction).
const GAS = 100_000;

// 5. The single return type to decode. Set to null if the method returns nothing.
//    Supported: "string" | "bool" | "address" | "uint256" | "int256" |
//               "uint64" | "int64" | "uint32" | "int32" | "bytes" | "bytes32"
const RETURN_TYPE = "uint256";

// 6. ABI used only to turn a revert selector back into a readable error name.
const ABI_PATH = "./artifacts/Voting.json";

/* ================================================================== */
/* Below this line is the reusable machinery — no changes needed       */
/* ================================================================== */

/** Parse CLI flags into a config object layered on top of the CONFIG defaults. */
export function parseCli(argv) {
  const [, , ...rest] = argv;
  const cfg = {
    contractId: CONTRACT_ID,
    mode: MODE,
    method: METHOD_NAME,
    gas: GAS,
    returnType: RETURN_TYPE,
    as: null,
    args: [],
  };

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    switch (token) {
      case "--contract":
        cfg.contractId = rest[++i];
        break;
      case "--mode":
        cfg.mode = rest[++i];
        break;
      case "--method":
        cfg.method = rest[++i];
        break;
      case "--as":
        cfg.as = rest[++i];
        break;
      case "--gas":
        cfg.gas = Number(rest[++i]);
        break;
      case "--return": {
        const value = rest[++i];
        cfg.returnType = value === "null" || value === "void" ? null : value;
        break;
      }
      case "--string":
        cfg.args.push(["addString", rest[++i]]);
        break;
      case "--string-array":
        cfg.args.push(["addStringArray", rest[++i].split(",").map((s) => s.trim())]);
        break;
      case "--uint256":
        cfg.args.push(["addUint256", rest[++i]]);
        break;
      case "--address":
        cfg.args.push(["addAddress", toEvmAddress(rest[++i])]);
        break;
      case "--bool":
        cfg.args.push(["addBool", rest[++i] === "true"]);
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (cfg.mode !== "query" && cfg.mode !== "execute") {
    throw new Error(`Unknown mode "${cfg.mode}". Use "query" or "execute".`);
  }
  if (cfg.contractId.includes("x")) {
    throw new Error(
      `No contract id. Set CONTRACT_ID in .env or pass --contract 0.0.1234567.`
    );
  }
  return cfg;
}

/** Convert a Hedera 0.0.x id or a 0x EVM address to a solidity address. */
export function toEvmAddress(value) {
  if (value.startsWith("0x")) return value;
  return AccountId.fromString(value).toSolidityAddress();
}

/** Build the ContractFunctionParameters for the call. */
function buildParams(argSpecs) {
  const params = new ContractFunctionParameters();
  for (const [method, value] of argSpecs) {
    params[method](value);
  }
  return params;
}

/** Decode a single return value from the ContractFunctionResult by type. */
export function decodeReturn(result, type) {
  if (type === null || type === undefined) return { value: undefined, type: "void" };

  const decoders = {
    string: (r) => r.getString(0),
    bool: (r) => r.getBool(0),
    address: (r) => "0x" + r.getAddress(0),
    uint256: (r) => r.getUint256(0).toString(),
    int256: (r) => r.getInt256(0).toString(),
    uint64: (r) => r.getUint64(0).toString(),
    int64: (r) => r.getInt64(0).toString(),
    uint32: (r) => r.getUint32(0),
    int32: (r) => r.getInt32(0),
    bytes: (r) => "0x" + Buffer.from(r.getBytes(0)).toString("hex"),
    bytes32: (r) => "0x" + Buffer.from(r.getBytes32(0)).toString("hex"),
  };

  const decoder = decoders[type];
  if (!decoder) {
    throw new Error(
      `Unsupported RETURN_TYPE "${type}". Supported: ${Object.keys(decoders).join(", ")}.`
    );
  }
  return { value: decoder(result), type };
}

/** Parse a private key that may be DER-encoded or a raw ECDSA/ED25519 hex string. */
export function parsePrivateKey(raw) {
  try {
    return PrivateKey.fromStringDer(raw);
  } catch {
    return PrivateKey.fromStringECDSA(raw);
  }
}

/**
 * Look up credentials for an account label.
 *   resolveAccount(null)      -> HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY
 *   resolveAccount("voter1")  -> VOTER1_ID / VOTER1_KEY
 */
export function resolveAccount(label, env = process.env) {
  const prefix = label ? label.toUpperCase() : "HEDERA_OPERATOR";
  const id = env[`${prefix}_ID`];
  const key = env[`${prefix}_KEY`];

  if (!id || !key) {
    throw new Error(
      label
        ? `No credentials for "${label}". Set ${prefix}_ID and ${prefix}_KEY in .env.`
        : `Please set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY in your environment (.env).`
    );
  }
  return { label: label ?? "operator", id, key };
}

/** Build a Testnet client operated by the given account label. */
export function makeTestnetClient(label) {
  const account = resolveAccount(label);
  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(account.id), parsePrivateKey(account.key));
  client.setDefaultMaxTransactionFee(new Hbar(20));
  return { client, account };
}

/**
 * Map 4-byte revert selectors to the error they identify, e.g.
 * "0x7c9a1cf9" -> AlreadyVoted(). Best-effort: needs the compiled ABI.
 */
export function loadErrorSelectors(abiPath = ABI_PATH) {
  const selectors = new Map();

  // Solidity's built-ins: require(false, "reason") and assert/overflow.
  selectors.set("0x08c379a0", { name: "Error", inputs: ["string"] });
  selectors.set("0x4e487b71", { name: "Panic", inputs: ["uint256"] });

  const resolved = path.resolve(abiPath);
  if (!fs.existsSync(resolved)) return selectors;

  const { abi } = JSON.parse(fs.readFileSync(resolved, "utf8"));
  for (const entry of abi ?? []) {
    if (entry.type !== "error") continue;
    const inputs = (entry.inputs ?? []).map((i) => i.type);
    const signature = `${entry.name}(${inputs.join(",")})`;
    selectors.set(`0x${keccak256(signature).slice(0, 8)}`, { name: entry.name, inputs });
  }
  return selectors;
}

/** Decode one 32-byte ABI word according to a value type. */
function decodeWord(word, type) {
  if (type === "bool") return BigInt(`0x${word}`) !== 0n ? "true" : "false";
  if (type === "address") return `0x${word.slice(24)}`;
  if (type.startsWith("uint") || type.startsWith("int")) return BigInt(`0x${word}`).toString();
  return `0x${word}`; // dynamic types (string/bytes/arrays) are rare in errors
}

/**
 * Turn raw revert data into a human-readable reason, e.g.
 * "0xcf9ce92c0000…0063" -> `InvalidTopic(99)  [0xcf9ce92c]`.
 */
export function describeRevert(errorMessage, selectors) {
  if (!errorMessage) return "no revert data returned";

  const hex = errorMessage.startsWith("0x") ? errorMessage : `0x${errorMessage}`;
  const selector = hex.slice(0, 10);
  const entry = selectors.get(selector);
  if (!entry) return `unknown revert data ${hex}`;

  const body = hex.slice(10);

  if (entry.name === "Error") {
    // ABI-encoded string: offset word, length word, then the bytes.
    const buffer = Buffer.from(body, "hex");
    const length = Number(BigInt(`0x${buffer.subarray(32, 64).toString("hex")}`));
    return `Error("${buffer.subarray(64, 64 + length).toString("utf8")}")`;
  }

  const args = entry.inputs.map((type, i) =>
    decodeWord(body.slice(i * 64, (i + 1) * 64), type)
  );
  return `${entry.name}(${args.join(", ")})  [${selector}]`;
}

/** Print a revert consistently for both query and execute mode. */
function reportRevert(status, errorMessage, selectors, link) {
  console.log("Result");
  console.log(`  Call status  : ${status}`);
  console.log(`  Reverted     : ${describeRevert(errorMessage, selectors)}`);
  if (link) console.log(`  HashScan     : ${link}`);
}

/** Fetch a record even when the receipt status is a failure. */
async function fetchRecordUnvalidated(client, transactionId) {
  return new TransactionRecordQuery()
    .setTransactionId(transactionId)
    .setValidateReceiptStatus(false)
    .execute(client);
}

async function main() {
  const cfg = parseCli(process.argv);
  const { client, account } = makeTestnetClient(cfg.as);
  const contractId = ContractId.fromString(cfg.contractId);
  const params = buildParams(cfg.args);
  const selectors = loadErrorSelectors();

  console.log(`Calling ${cfg.method}() on ${cfg.contractId} (mode: ${cfg.mode})`);
  console.log(`  as: ${account.label} (${account.id})\n`);

  let returnValue;
  let status;

  if (cfg.mode === "query") {
    // Read-only call: no consensus transaction, so there is no receipt.
    // setSenderAccountId makes msg.sender inside the call the --as account.
    const query = new ContractCallQuery()
      .setContractId(contractId)
      .setGas(cfg.gas)
      .setSenderAccountId(AccountId.fromString(account.id))
      .setFunction(cfg.method, params);

    try {
      const result = await query.execute(client);
      returnValue = decodeReturn(result, cfg.returnType);
      status = "SUCCESS";
    } catch (err) {
      // A reverting view function throws instead of returning; the thrown error
      // still carries the revert data, so decode it the same way.
      if (!err.contractFunctionResult) throw err;
      reportRevert(
        err.status?.toString() ?? "FAILED",
        err.contractFunctionResult.errorMessage,
        selectors,
        null
      );
      client.close();
      process.exitCode = 1;
      return;
    }
  } else {
    // State-changing call: submitted as a transaction with a receipt status.
    const txResponse = await new ContractExecuteTransaction()
      .setContractId(contractId)
      .setGas(cfg.gas)
      .setFunction(cfg.method, params)
      .execute(client);

    try {
      const receipt = await txResponse.getReceipt(client);
      status = receipt.status.toString();

      // The return value of a state-changing call lives in the record.
      const record = await txResponse.getRecord(client);
      returnValue = record.contractFunctionResult
        ? decodeReturn(record.contractFunctionResult, cfg.returnType)
        : { value: undefined, type: "void" };
    } catch (err) {
      // A revert is a failed receipt status, not a thrown Solidity error — pull
      // the record anyway so we can name the custom error that fired.
      status = err.status?.toString() ?? "FAILED";
      const record = await fetchRecordUnvalidated(client, txResponse.transactionId);

      reportRevert(
        status,
        record.contractFunctionResult?.errorMessage,
        selectors,
        `https://hashscan.io/testnet/transaction/${record.transactionId.toString()}`
      );
      client.close();
      process.exitCode = 1;
      return;
    }
  }

  console.log("Result");
  console.log(`  Return value : ${returnValue.value}`);
  console.log(`  Return type  : ${returnValue.type}`);
  console.log(`  Call status  : ${status}`);

  client.close();
}

// Only run when invoked directly, so the helpers above stay importable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("\n❌ Call error:", err.message ?? err);
    process.exit(1);
  });
}
