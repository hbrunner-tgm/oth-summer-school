/**
 * Trace a blocked vote end to end, dumping the raw bytes at each hop.
 */
import "dotenv/config";
import sha3 from "js-sha3";
import {
  Client, AccountId, ContractId, ContractExecuteTransaction, ContractCallQuery,
  ContractFunctionParameters, TransactionRecordQuery, Hbar,
} from "@hashgraph/sdk";
import { parsePrivateKey, loadErrorSelectors, describeRevert } from "./call.js";

const { keccak256 } = sha3;
const CONTRACT = process.env.CONTRACT_ID;
const VOTER = "VOTER2";
const TOPIC = 0;

const hex = (u8) => Buffer.from(u8).toString("hex");
const rule = (t) => console.log(`\n${"─".repeat(72)}\n${t}\n${"─".repeat(72)}`);

const client = Client.forTestnet();
client.setOperator(
  AccountId.fromString(process.env.HEDERA_OPERATOR_ID),
  parsePrivateKey(process.env.HEDERA_OPERATOR_KEY)
);
client.setDefaultMaxTransactionFee(new Hbar(20));

const contractId = ContractId.fromString(CONTRACT);
const voterId = process.env[`${VOTER}_ID`];
const voterKey = parsePrivateKey(process.env[`${VOTER}_KEY`]);
const voterAlias = `0x${voterKey.publicKey.toEvmAddress()}`;
const voterLongZero = `0x${AccountId.fromString(voterId).toSolidityAddress()}`;

const query = async (fn, params, dec) => {
  const r = await new ContractCallQuery()
    .setContractId(contractId).setGas(100000)
    .setSenderAccountId(AccountId.fromString(process.env.HEDERA_OPERATOR_ID))
    .setFunction(fn, params ?? new ContractFunctionParameters())
    .execute(client);
  return dec(r);
};

/* 1 ─ what we're about to send ------------------------------------------- */
rule("1. ENCODING THE CALL");
const sig = "vote(uint256)";
const selector = keccak256(sig).slice(0, 8);
console.log(`signature      : ${sig}`);
console.log(`keccak256      : 0x${keccak256(sig)}`);
console.log(`selector (4B)  : 0x${selector}`);

const params = new ContractFunctionParameters().addUint256(TOPIC);
console.log(`argument       : uint256 ${TOPIC}`);
console.log(`calldata       : 0x${hex(params._build("vote"))}`);

/* 2 ─ who is calling ------------------------------------------------------ */
rule("2. THE CALLER");
console.log(`account id     : ${voterId}   (${VOTER})`);
console.log(`long-zero      : ${voterLongZero}`);
console.log(`alias          : ${voterAlias}   <- this becomes msg.sender`);

/* 3 ─ state before -------------------------------------------------------- */
rule("3. STATE BEFORE");
const before = {
  phase: await query("phaseName", null, (r) => r.getString(0)),
  total: await query("totalVotes", null, (r) => r.getUint256(0).toString()),
  tally0: await query("voteCount", new ContractFunctionParameters().addUint256(0), (r) => r.getUint256(0).toString()),
  voted: await query("hasVoted", new ContractFunctionParameters().addAddress(voterAlias), (r) => r.getBool(0)),
  blocked: await query("blacklisted", new ContractFunctionParameters().addAddress(voterAlias), (r) => r.getBool(0)),
};
console.log(`phase                    : ${before.phase}`);
console.log(`totalVotes               : ${before.total}`);
console.log(`voteCount(0)             : ${before.tally0}`);
console.log(`hasVoted[${voterAlias}] : ${before.voted}`);
console.log(`blacklisted[…]           : ${before.blocked}`);

/* 4 ─ send it ------------------------------------------------------------- */
rule("4. SUBMITTING THE TRANSACTION");
const voterClient = Client.forTestnet();
voterClient.setOperator(AccountId.fromString(voterId), voterKey);
voterClient.setDefaultMaxTransactionFee(new Hbar(20));

const tx = new ContractExecuteTransaction()
  .setContractId(contractId).setGas(100000).setFunction("vote", params);

const response = await tx.execute(voterClient);
console.log(`transaction id : ${response.transactionId.toString()}`);
console.log(`signed by      : ${voterId} (${VOTER}) — this is what sets msg.sender`);

let status = "SUCCESS";
try {
  await response.getReceipt(voterClient);
} catch (err) {
  status = err.status?.toString() ?? "FAILED";
}
console.log(`receipt status : ${status}`);

/* 5 ─ the record ---------------------------------------------------------- */
rule("5. THE RECORD (fetched with validation off)");
const record = await new TransactionRecordQuery()
  .setTransactionId(response.transactionId)
  .setValidateReceiptStatus(false)
  .execute(voterClient);

const cfr = record.contractFunctionResult;
console.log(`fee charged    : ${record.transactionFee.toString()}`);
console.log(`gas used       : ${cfr?.gasUsed?.toString()}`);
console.log(`events emitted : ${cfr?.logs?.length ?? 0}`);
console.log(`revert data    : ${cfr?.errorMessage}`);

/* 6 ─ decode -------------------------------------------------------------- */
rule("6. DECODING THE REVERT");
const raw = cfr?.errorMessage ?? "";
console.log(`selector       : ${raw.slice(0, 10)}`);
console.log(`keccak check   : 0x${keccak256("AccountIsBlacklisted()").slice(0, 8)}  <- AccountIsBlacklisted()`);
console.log(`decoded        : ${describeRevert(raw, loadErrorSelectors())}`);

/* 7 ─ state after --------------------------------------------------------- */
rule("7. STATE AFTER — nothing moved");
const after = {
  total: await query("totalVotes", null, (r) => r.getUint256(0).toString()),
  tally0: await query("voteCount", new ContractFunctionParameters().addUint256(0), (r) => r.getUint256(0).toString()),
  voted: await query("hasVoted", new ContractFunctionParameters().addAddress(voterAlias), (r) => r.getBool(0)),
};
console.log(`totalVotes     : ${before.total} -> ${after.total}`);
console.log(`voteCount(0)   : ${before.tally0} -> ${after.tally0}`);
console.log(`hasVoted       : ${before.voted} -> ${after.voted}`);
console.log(`\nHashScan       : https://hashscan.io/testnet/transaction/${record.transactionId.toString()}`);

client.close();
voterClient.close();
