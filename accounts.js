/**
 * List every Hedera account configured in .env, with both of the EVM addresses
 * it can appear as, plus its balance.
 *
 * Usage:
 *   node accounts.js
 *   node accounts.js --no-balances     # offline, no network calls
 *
 * WHY THIS EXISTS
 * ---------------
 * `blacklisted[msg.sender]` compares against whatever address the contract sees
 * as the caller, and on Hedera an account has two possible EVM forms:
 *
 *   long-zero  0x00000000000000000000000000000000000004d2   (derived from 0.0.1234)
 *   alias      0x733ee9e5481ac4db6b74fb10dd16aa0b4b231d5b   (derived from an ECDSA key)
 *
 * Blacklisting the wrong one fails silently — the account votes anyway. Use this
 * script to see the candidates, then confirm the real one with:
 *
 *   node call.js --method whoAmI --mode execute --as voter1 --return address
 */

import "dotenv/config";
import {
  Client,
  PrivateKey,
  AccountId,
  AccountBalanceQuery,
  Hbar,
} from "@hashgraph/sdk";
import { parsePrivateKey } from "./call.js";

/** Find every `<LABEL>_ID` / `<LABEL>_KEY` pair present in the environment. */
function discoverAccounts(env = process.env) {
  const accounts = [];
  for (const key of Object.keys(env)) {
    if (!key.endsWith("_ID")) continue;

    const prefix = key.slice(0, -3);
    if (!env[`${prefix}_KEY`]) continue;
    // Guard against unrelated *_ID variables that happen to be in the shell.
    if (!/^\d+\.\d+\.\d+$/.test(env[key].trim())) continue;

    accounts.push({
      label: prefix === "HEDERA_OPERATOR" ? "operator (owner/admin)" : prefix.toLowerCase(),
      prefix,
      id: env[key],
      key: env[`${prefix}_KEY`],
    });
  }

  // Operator first, then alphabetically.
  return accounts.sort((a, b) => {
    if (a.prefix === "HEDERA_OPERATOR") return -1;
    if (b.prefix === "HEDERA_OPERATOR") return 1;
    return a.prefix.localeCompare(b.prefix);
  });
}

function describe(account) {
  const out = { ...account, longZero: null, alias: null, error: null };

  try {
    out.longZero = `0x${AccountId.fromString(account.id).toSolidityAddress()}`;
  } catch (err) {
    out.error = `bad account id: ${err.message}`;
    return out;
  }

  try {
    const privateKey = parsePrivateKey(account.key);
    // ED25519 keys have no EVM alias — only ECDSA keys do.
    out.alias = `0x${privateKey.publicKey.toEvmAddress()}`;
  } catch {
    out.alias = null;
  }
  return out;
}

async function main() {
  const withBalances = !process.argv.includes("--no-balances");
  const accounts = discoverAccounts().map(describe);

  if (accounts.length === 0) {
    console.error(
      "No accounts found. Copy .env.example to .env and fill in at least " +
        "HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY."
    );
    process.exit(1);
  }

  let client = null;
  if (withBalances && accounts[0].id) {
    client = Client.forTestnet();
    client.setOperator(
      AccountId.fromString(accounts[0].id),
      parsePrivateKey(accounts[0].key)
    );
    client.setDefaultMaxTransactionFee(new Hbar(20));
  }

  console.log(`Accounts configured in .env (${accounts.length})\n`);

  for (const account of accounts) {
    const flag =
      account.prefix === "HEDERA_OPERATOR"
        ? "default — no --as flag needed"
        : `--as ${account.prefix.toLowerCase()}`;
    console.log(`${account.label}  [${flag}]`);
    console.log(`  account id : ${account.id}`);

    if (account.error) {
      console.log(`  ⚠ ${account.error}\n`);
      continue;
    }

    console.log(`  long-zero  : ${account.longZero}`);
    console.log(`  alias      : ${account.alias ?? "— (ED25519 key: no EVM alias)"}`);

    if (client) {
      try {
        const balance = await new AccountBalanceQuery()
          .setAccountId(AccountId.fromString(account.id))
          .execute(client);
        console.log(`  balance    : ${balance.hbars.toString()}`);
      } catch (err) {
        console.log(`  balance    : ⚠ ${err.message}`);
      }
    }
    console.log("");
  }

  console.log(
    "Confirm the address your contract actually sees before blacklisting:\n" +
      "  node call.js --method whoAmI --mode execute --as <label> --return address"
  );

  client?.close();
}

main().catch((err) => {
  console.error("\n❌ accounts error:", err.message ?? err);
  process.exit(1);
});
