# Hedera Testnet Contract Deployer

Deploys a **compiled** smart contract (solc / Hardhat / Foundry bytecode) to the
**Hedera Testnet** using the official [`@hashgraph/sdk`](https://www.npmjs.com/package/@hashgraph/sdk).

It uses `ContractCreateFlow`, which automatically uploads the bytecode to a
Hedera file (chunked for large contracts) and creates the contract in one step —
so you don't need separate `FileCreateTransaction` / `FileAppendTransaction`
calls.

## 1. Setup

```bash
npm install
cp .env.example .env      # then fill in your Testnet operator ID + key
```

Get free Testnet credentials at the [Hedera Portal](https://portal.hedera.com/).

## 2. Deploy

Point the script at either a compiler **artifact JSON** or a raw **`.bin`** file:

```bash
# Hardhat / Foundry / solc artifact JSON
node deploy.js ./artifacts/MyContract.json

# raw bytecode file
node deploy.js ./build/MyContract.bin --gas 300000
```

### Constructor arguments

Pass typed arguments in the order the constructor expects them:

```bash
node deploy.js ./artifacts/MyToken.json \
  --arg-string  "MyToken" \
  --arg-string  "MTK" \
  --arg-uint256 1000000
```

Supported flags: `--arg-string`, `--arg-address` (accepts `0.0.x` or `0x…`),
`--arg-uint256`, `--arg-bool`. Extend `parseArgs`/`buildConstructorParams` in
`deploy.js` for further Solidity types.

### Options

| Flag     | Default  | Description                          |
|----------|----------|--------------------------------------|
| `--gas`  | `200000` | Gas limit for contract creation      |
| `--memo` | *(none)* | Optional contract memo               |

## 3. Call a method (`call.js`)

`call.js` invokes a method on an already-deployed contract. Every setting has a
default in the `CONFIG` block at the top of the file and can be overridden from
the command line, so you normally don't need to edit it:

| Flag | Meaning |
|------|---------|
| `--contract 0.0.x` | the contract to call (default: `CONTRACT_ID` from `.env`) |
| `--mode query\|execute` | `query` for view/pure functions (free), `execute` for state-changing ones (costs gas, returns a receipt status) |
| `--method NAME` | the Solidity function name |
| `--as LABEL` | **which account signs and pays** — i.e. what the contract sees as `msg.sender`. Maps to `<LABEL>_ID`/`<LABEL>_KEY` in `.env`; omit for the operator |
| `--gas N` | gas limit |
| `--return TYPE` | decode the single return value as `TYPE`, or `null` for none (**multiple return values are not supported**) |
| `--string` / `--uint256` / `--address` / `--bool` / `--string-array` | call arguments, applied in the order given |

```bash
node call.js --method topicCount --return uint256
node call.js --method vote --mode execute --as voter1 --uint256 0 --return null
```

It prints the decoded return value, its type, and the call status:

```
Result
  Return value : Hello Hedera
  Return type  : string
  Call status  : SUCCESS
```

Supported return types: `string`, `bool`, `address`, `uint256`, `int256`,
`uint64`, `int64`, `uint32`, `int32`, `bytes`, `bytes32`.

When a call reverts, the script names the Solidity error rather than just
failing, by matching the revert selector against the ABI in
`artifacts/Voting.json`:

```
Result
  Call status  : CONTRACT_REVERT_EXECUTED
  Reverted     : AlreadyVoted()  [0x7c9a1cf9]
  HashScan     : https://hashscan.io/testnet/transaction/...
```

## 4. Deploy output

On success you get the Hedera Contract ID, the EVM address, and a HashScan link:

```
✅ Contract deployed successfully
  Contract ID : 0.0.1234567
  EVM address : 0x0000000000000000000000000000000000012d687
  HashScan    : https://hashscan.io/testnet/contract/0.0.1234567
```

---

# The voting contract

`artifacts/Voting.sol` is the course-test contract: voting on topics fixed by
the constructor, one vote per account, printable results, and an admin-managed
blacklist of accounts that may not vote.

The security model is **owner + blacklist mapping, frozen when voting opens**.
[SECURITY.md](SECURITY.md) explains that choice and documents six alternatives
(multi-admin, two-step ownership, allowlist, Merkle root, EIP-712 signatures)
with the concrete diff for each.

## Lifecycle

```
   deploy                openVoting()            closeVoting()
      │                       │                        │
      ▼                       ▼                        ▼
 ┌─────────┐            ┌──────────┐             ┌──────────┐
 │  Setup  │───────────▶│   Open   │────────────▶│  Closed  │
 └─────────┘            └──────────┘             └──────────┘
 blacklist editable     blacklist FROZEN          results final
 nobody can vote        everyone votes once       nobody can vote
```

The blacklist freezes at `openVoting()` on purpose: an admin who can blacklist
while votes are landing can watch the tally and censor voters, which would make
the admin the real decider. See [SECURITY.md](SECURITY.md) option 2.

## Setup

```bash
npm install
cp .env.example .env      # fill in the operator + at least two voter accounts
```

## 1. Compile

```bash
npm run compile
```

Compiles `artifacts/Voting.sol` to `artifacts/Voting.json` (`{abi, bytecode}` —
exactly the shape `deploy.js` reads). Targets the `paris` EVM so the bytecode
contains no `PUSH0`; override with `--evm-version` if you need something newer.

You can also paste the `.sol` into [remix.ethereum.org](https://remix.ethereum.org)
— it has no imports — and save the bytecode as a `.bin` file instead.

## 2. Deploy

```bash
node deploy.js ./artifacts/Voting.json --gas 3000000 --arg-string-array "Pizza,Pasta,Sushi"
```

`--arg-string-array` is a comma-separated list, so **topic names cannot contain
a comma**.

**Gas:** the default `--gas 200000` is nowhere near enough for a constructor
that stores a string array — even `1000000` fails with `INSUFFICIENT_GAS`
(measured on Testnet). Use `3000000` for the deploy. Unused gas is not
refunded on Hedera, but on Testnet that costs you nothing. The default
`100000` in `call.js` is fine for every method on this contract.

Put the resulting contract id in `.env` as `CONTRACT_ID` so you can drop
`--contract` from every later command.

## 3. Find out what address the contract sees

```bash
npm run accounts
```

Lists every account in `.env` with its balance and **both** EVM address forms.
This matters: on Hedera an account can appear as its *long-zero* address
(`0x0…04d2`, derived from `0.0.1234`) or as its *alias* address (derived from an
ECDSA key). `blacklisted[msg.sender]` only matches one of them — blacklist the
wrong form and the account votes anyway, with no error.

Confirm the real one straight from the contract:

```bash
node call.js --method whoAmI --mode execute --as voter1 --return address
```

`--mode query` is free and gives the same answer (`call.js` sets the query's
sender account); use `--mode execute` only if you want it recorded on-ledger.

In Testnet runs with portal ECDSA accounts, `whoAmI()` returned the **alias**
address, not the long-zero one — so that is the form to blacklist. Getting this
wrong is a silent bypass, not an error: see test D4 in
[COMMANDS.md](COMMANDS.md).

## 4. Blacklist, then open voting

```bash
node call.js --method setBlacklisted --mode execute --address 0x<voter2-address> --bool true --return null
node call.js --method openVoting --mode execute --return null
```

Both are owner-only, so run them **without** `--as` (the operator deployed the
contract and is therefore the owner).

## 5. Vote

```bash
node call.js --method vote --mode execute --as voter1 --uint256 0 --return null
node call.js --method vote --mode execute --as voter3 --uint256 1 --return null
```

## 6. Print the result

```bash
npm run results
```

```
Voting results — contract 0.0.1234567
  phase: Open    total votes: 2

   0  Pizza  ██████████··········  1
   1  Pasta  ██████████··········  1
   2  Sushi  ····················  0

  Winner: Pizza
```

`results.js` loops the contract's single-scalar getters (`topicCount`,
`topicName`, `voteCount`) because `call.js` can only decode one return value —
that constraint is why the contract has no array-returning getter.

## 7. Close voting

```bash
node call.js --method closeVoting --mode execute --return null
```

## Demonstrating that the security works

Each of these should **fail**, and the script names the error:

| Command | Expected error |
|---|---|
| `vote` twice from the same account | `AlreadyVoted()` |
| `vote --as` a blacklisted account | `AccountIsBlacklisted()` |
| `openVoting`/`closeVoting`/`setBlacklisted --as voter1` | `NotOwner()` |
| `setBlacklisted` after `openVoting` | `WrongPhase(0, 1)` |
| `vote` before `openVoting` | `WrongPhase(1, 0)` |
| `vote` after `closeVoting` | `WrongPhase(1, 2)` |
| `topicName`/`voteCount`/`vote` with `--uint256 99` | `InvalidTopic(99)` |
| deploy with an empty topic list | `NoTopics()` |

`WrongPhase(required, current)` uses the enum's numbers: **0 = Setup, 1 = Open,
2 = Closed**. So `WrongPhase(1, 0)` means "this needs Open, but we're in Setup".

A revert is not a thrown exception — it comes back as a failed status with the
revert data attached. `call.js` matches the 4-byte selector against the ABI in
`artifacts/Voting.json` and decodes the arguments, in **both** query and execute
mode, so you get the error name instead of a bare `CONTRACT_REVERT_EXECUTED`.

## Contract API

| Function | Who | Notes |
|---|---|---|
| `constructor(string[] topics)` | deployer | becomes `owner`; phase = `Setup` |
| `setBlacklisted(address, bool)` | owner | `Setup` only |
| `openVoting()` / `closeVoting()` | owner | phase transitions |
| `vote(uint256 topicId)` | anyone eligible | `Open` only, once per address |
| `topicCount()` `topicName(id)` `voteCount(id)` | anyone | `uint256` / `string` / `uint256` |
| `totalVotes()` `winningTopicId()` `winningTopicName()` `winningVoteCount()` | anyone | on a tie, returns the **lowest tied id** — check `isTie()` first |
| `isTie()` | anyone | `true` when two or more topics share the top score |
| `resultLine(id)` | anyone | e.g. `"Pizza: 3"` |
| `phaseName()` | anyone | `"Setup"` / `"Open"` / `"Closed"` |
| `hasVoted(address)` `blacklisted(address)` `owner()` | anyone | public state |
| `whoAmI()` | anyone | returns `msg.sender` |

Events: `VoteCast`, `BlacklistUpdated`, `PhaseChanged` — all visible on HashScan.
