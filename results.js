/**
 * Print the voting result.
 *
 * The contract deliberately exposes only single-scalar getters (so the generic
 * decoder in call.js can handle them); this script loops those getters and
 * assembles the table.
 *
 * Usage:
 *   node results.js
 *   node results.js --contract 0.0.1234567
 */

import "dotenv/config";
import {
  ContractId,
  ContractCallQuery,
  ContractFunctionParameters,
  AccountId,
} from "@hashgraph/sdk";
import { makeTestnetClient, decodeReturn } from "./call.js";

const GAS = 100_000;

function parseArgs(argv) {
  const [, , ...rest] = argv;
  let contractId = process.env.CONTRACT_ID;
  let as = null;

  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--contract") contractId = rest[++i];
    else if (rest[i] === "--as") as = rest[++i];
    else throw new Error(`Unknown argument: ${rest[i]}`);
  }

  if (!contractId || contractId.includes("x")) {
    throw new Error(
      "No contract id. Set CONTRACT_ID in .env or pass --contract 0.0.1234567."
    );
  }
  return { contractId, as };
}

async function main() {
  const { contractId: contractIdStr, as } = parseArgs(process.argv);
  const { client, account } = makeTestnetClient(as);
  const contractId = ContractId.fromString(contractIdStr);
  const sender = AccountId.fromString(account.id);

  /** Run one view function and decode its single return value. */
  async function view(method, type, buildArgs = () => new ContractFunctionParameters()) {
    const result = await new ContractCallQuery()
      .setContractId(contractId)
      .setGas(GAS)
      .setSenderAccountId(sender)
      .setFunction(method, buildArgs())
      .execute(client);
    return decodeReturn(result, type).value;
  }

  const phase = await view("phaseName", "string");
  const count = Number(await view("topicCount", "uint256"));
  const total = await view("totalVotes", "uint256");

  console.log(`Voting results — contract ${contractIdStr}`);
  console.log(`  phase: ${phase}    total votes: ${total}\n`);

  const rows = [];
  for (let i = 0; i < count; i++) {
    const name = await view("topicName", "string", () =>
      new ContractFunctionParameters().addUint256(i)
    );
    const votes = Number(
      await view("voteCount", "uint256", () =>
        new ContractFunctionParameters().addUint256(i)
      )
    );
    rows.push({ id: i, name, votes });
  }

  const nameWidth = Math.max(5, ...rows.map((r) => r.name.length));
  const totalVotes = Number(total);

  // Work the leaders out here rather than asking the contract, so a tie can be
  // reported honestly instead of being hidden by the lowest-id tie-break.
  const topVotes = Math.max(...rows.map((r) => r.votes));
  const leaders = rows.filter((r) => r.votes === topVotes);

  for (const row of rows) {
    const share = totalVotes === 0 ? 0 : Math.round((row.votes / totalVotes) * 20);
    const bar = "█".repeat(share).padEnd(20, "·");
    const mark = totalVotes > 0 && row.votes === topVotes ? "◄" : " ";
    console.log(
      `  ${String(row.id).padStart(2)}  ${row.name.padEnd(nameWidth)}  ${bar}  ${String(row.votes).padStart(3)} ${mark}`
    );
  }

  if (totalVotes === 0) {
    console.log("\n  No votes cast yet.");
  } else if (leaders.length === 1) {
    console.log(`\n  Winner: ${leaders[0].name} (${topVotes} of ${totalVotes})`);
  } else {
    const names = leaders.map((r) => r.name).join(", ");
    console.log(`\n  Draw: ${names} — ${topVotes} vote(s) each`);
  }

  console.log(`\n  HashScan: https://hashscan.io/testnet/contract/${contractIdStr}`);
  client.close();
}

main().catch((err) => {
  console.error("\n❌ results error:", err.message ?? err);
  process.exit(1);
});
