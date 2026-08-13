/**
 * Deploy a compiled smart contract to the Hedera Testnet.
 *
 * Usage:
 *   node deploy.js <artifact-or-bin-file> [--gas 200000] [--memo "..."] [ABI-encoded constructor args...]
 *
 * Examples:
 *   node deploy.js ./artifacts/MyContract.json
 *   node deploy.js ./build/MyContract.bin --gas 300000
 *   node deploy.js ./artifacts/MyToken.json --arg-string "MyToken" --arg-string "MTK" --arg-uint256 1000000
 *   node deploy.js ./artifacts/Voting.json --gas 1000000 --arg-string-array "Pizza,Pasta,Sushi"
 *
 * Requires a .env file (see .env.example) with:
 *   HEDERA_OPERATOR_ID   e.g. 0.0.12345
 *   HEDERA_OPERATOR_KEY  ECDSA or ED25519 private key (hex or DER)
 */

import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import {
  Client,
  PrivateKey,
  AccountId,
  ContractCreateFlow,
  ContractFunctionParameters,
  TransactionRecordQuery,
  Hbar,
} from "@hashgraph/sdk";
import { describeRevert, loadErrorSelectors } from "./call.js";

/* ------------------------------------------------------------------ */
/* 1. Read the compiled bytecode                                       */
/* ------------------------------------------------------------------ */

/**
 * Accepts either:
 *   - a raw .bin file containing the hex bytecode, or
 *   - a compiler artifact JSON (Hardhat / Foundry / solc) that carries the
 *     bytecode under one of the common field names.
 */
function loadBytecode(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();

  // Raw .bin / .hex file: just the bytecode string.
  if (filePath.endsWith(".bin") || filePath.endsWith(".hex")) {
    return normalizeHex(raw);
  }

  // JSON artifact from solc / Hardhat / Foundry.
  const artifact = JSON.parse(raw);

  const candidate =
    artifact.bytecode ??                       // solc / Hardhat
    artifact.bytecode?.object ??               // some solc variants
    artifact.deployedBytecode?.object ??
    artifact.data?.bytecode?.object ??         // solc standard-json output
    artifact.evm?.bytecode?.object;            // solc contract output

  if (!candidate) {
    throw new Error(
      `Could not find a bytecode field in ${filePath}. ` +
        `Expected one of: bytecode, bytecode.object, evm.bytecode.object.`
    );
  }
  return normalizeHex(typeof candidate === "string" ? candidate : candidate.object);
}

function normalizeHex(hex) {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length === 0) {
    throw new Error("Bytecode is empty.");
  }
  if (!/^[0-9a-fA-F]+$/.test(stripped)) {
    throw new Error("Bytecode is not valid hex.");
  }
  return stripped;
}

/* ------------------------------------------------------------------ */
/* 2. Parse CLI args (gas, memo, constructor parameters)               */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const [, , file, ...rest] = argv;
  if (!file) {
    console.error(
      "Usage: node deploy.js <artifact-or-bin-file> [--gas N] [--memo TEXT] " +
        "[--arg-string V] [--arg-string-array \"A,B,C\"] [--arg-address 0.0.x|0x..] " +
        "[--arg-uint256 N] [--arg-bool true|false]"
    );
    process.exit(1);
  }

  const opts = { file, gas: 200_000, memo: "", constructorArgs: [] };

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    switch (token) {
      case "--gas":
        opts.gas = Number(rest[++i]);
        break;
      case "--memo":
        opts.memo = rest[++i];
        break;
      case "--arg-string":
        opts.constructorArgs.push(["addString", rest[++i]]);
        break;
      case "--arg-string-array": {
        // Comma-separated list, e.g. --arg-string-array "Pizza,Pasta,Sushi".
        // Individual entries therefore cannot contain a comma.
        // An empty string means an empty array (useful for testing NoTopics()).
        const raw = rest[++i];
        opts.constructorArgs.push([
          "addStringArray",
          raw === "" ? [] : raw.split(",").map((s) => s.trim()),
        ]);
        break;
      }
      case "--arg-address":
        opts.constructorArgs.push(["addAddress", toEvmAddress(rest[++i])]);
        break;
      case "--arg-uint256":
        opts.constructorArgs.push(["addUint256", rest[++i]]);
        break;
      case "--arg-bool":
        opts.constructorArgs.push(["addBool", rest[++i] === "true"]);
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  return opts;
}

/** Convert a Hedera 0.0.x id or a 0x EVM address to a solidity address. */
function toEvmAddress(value) {
  if (value.startsWith("0x")) return value;
  return AccountId.fromString(value).toSolidityAddress();
}

/** Build the ContractFunctionParameters object from parsed constructor args. */
function buildConstructorParams(argSpecs) {
  if (argSpecs.length === 0) return null;
  const params = new ContractFunctionParameters();
  for (const [method, value] of argSpecs) {
    params[method](value);
  }
  return params;
}

/* ------------------------------------------------------------------ */
/* 3. Build the Hedera client for Testnet                              */
/* ------------------------------------------------------------------ */

/** Parse a private key that may be DER-encoded or a raw ECDSA/ED25519 hex string. */
function parsePrivateKey(raw) {
  try {
    return PrivateKey.fromStringDer(raw);
  } catch {
    // Fall back to raw ECDSA hex (Hedera Portal "HEX Encoded Private Key").
    return PrivateKey.fromStringECDSA(raw);
  }
}

function makeTestnetClient() {
  const operatorId = process.env.HEDERA_OPERATOR_ID;
  const operatorKeyRaw = process.env.HEDERA_OPERATOR_KEY;

  if (!operatorId || !operatorKeyRaw) {
    throw new Error(
      "Please set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY in your environment (.env)."
    );
  }

  // Works for both ECDSA and ED25519 keys, DER- or hex-encoded.
  const operatorKey = parsePrivateKey(operatorKeyRaw);

  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(operatorId), operatorKey);
  // Cap accidental fee spend; adjust as needed.
  client.setDefaultMaxTransactionFee(new Hbar(20));
  return client;
}

/* ------------------------------------------------------------------ */
/* 4. Deploy                                                           */
/* ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv);
  const bytecode = loadBytecode(path.resolve(opts.file));
  const client = makeTestnetClient();

  console.log(`Deploying ${path.basename(opts.file)} to Hedera Testnet ...`);
  console.log(`  gas:  ${opts.gas}`);
  if (opts.memo) console.log(`  memo: ${opts.memo}`);

  // ContractCreateFlow uploads the bytecode to a file (chunked automatically
  // for large contracts) and creates the contract in one convenient step.
  const flow = new ContractCreateFlow()
    .setGas(opts.gas)
    .setBytecode(bytecode);

  if (opts.memo) flow.setContractMemo(opts.memo);

  const params = buildConstructorParams(opts.constructorArgs);
  if (params) flow.setConstructorParameters(params);

  const txResponse = await flow.execute(client);

  let receipt;
  try {
    receipt = await txResponse.getReceipt(client);
  } catch (err) {
    // A constructor can revert (e.g. NoTopics()). Pull the record anyway so we
    // can name the error instead of printing a bare status.
    const record = await new TransactionRecordQuery()
      .setTransactionId(txResponse.transactionId)
      .setValidateReceiptStatus(false)
      .execute(client);

    const reason = describeRevert(
      record.contractFunctionResult?.errorMessage,
      loadErrorSelectors()
    );
    throw new Error(`${err.status?.toString() ?? "FAILED"} — constructor reverted: ${reason}`);
  }

  const contractId = receipt.contractId;
  if (!contractId) {
    throw new Error(`Deployment failed with status: ${receipt.status.toString()}`);
  }

  const evmAddress = contractId.toSolidityAddress();

  console.log("\n✅ Contract deployed successfully");
  console.log(`  Contract ID : ${contractId.toString()}`);
  console.log(`  EVM address : 0x${evmAddress}`);
  console.log(`  HashScan    : https://hashscan.io/testnet/contract/${contractId.toString()}`);

  client.close();
  return contractId.toString();
}

main().catch((err) => {
  console.error("\n❌ Deployment error:", err.message ?? err);
  process.exit(1);
});
