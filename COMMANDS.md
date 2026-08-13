# Test commands

Every feature of `Voting.sol`, as a runnable command with the output to expect.

Run everything from the repo root. Commands read `CONTRACT_ID` from `.env`, so
none of them need `--contract` unless you want to point at a different deploy.

**Your accounts** (from `npm run accounts` — the *alias* is what the contract
sees as `msg.sender`):

| Label | Account | Alias address |
|---|---|---|
| operator (owner) | `0.0.9960336` | `0x932944ac6c79eab4d3b1238f406e11b52f5f31ae` |
| voter1 | `0.0.9992395` | `0xad910182b6c9075a6808f2e0d65675c2dd629c4c` |
| voter2 | `0.0.10027089` | `0x826aeb65840e04a0d23cb4e8d26dd4403bd5722e` |
| voter3 | `0.0.10027108` | `0x4f6b0be57e6c276950cab3ea4ae2ac7c20f35b25` |

**Legend**

- 🟢 **cheap** — a query: answered by one node, changes no state, and costs a
  small query fee rather than gas (not literally free, but ~1000× cheaper)
- 🔵 **costs gas** — a real transaction that goes through consensus
- ⚠️ **one-way** — cannot be undone on this deployment
- 🆕 **needs a fresh deploy** — the current contract is past the phase this needs

---

## A. Read-only inspection

Safe at any time, in any phase, as often as you like. 🟢

### Who owns the contract

```bash
node call.js --method owner --return address
```

Returns the operator's alias — the account that deployed it.

### What phase are we in

```bash
node call.js --method phaseName --return string
```

`Setup` → `Open` → `Closed`.

### How many topics

```bash
node call.js --method topicCount --return uint256
```

### A topic's name

```bash
node call.js --method topicName --uint256 0 --return string
```

### A topic's vote count

```bash
node call.js --method voteCount --uint256 0 --return uint256
```

### A printable result line

```bash
node call.js --method resultLine --uint256 0 --return string
```

Returns e.g. `Pizza: 1` — the contract formatting its own result, entirely
on-chain. This is the "the result of the voting can be printed" requirement met
inside Solidity rather than in JavaScript.

### Total votes cast

```bash
node call.js --method totalVotes --return uint256
```

### The leader, and whether it's actually a win

```bash
node call.js --method winningTopicName --return string
```

```bash
node call.js --method winningVoteCount --return uint256
```

```bash
node call.js --method isTie --return bool
```

`winningTopicName()` breaks a tie by lowest topic id, so **always check
`isTie()` before calling something a win.** Right now this returns `true`.

### Has a specific account voted

```bash
node call.js --method hasVoted --address 0xad910182b6c9075a6808f2e0d65675c2dd629c4c --return bool
```

### Is a specific account blacklisted

```bash
node call.js --method blacklisted --address 0x826aeb65840e04a0d23cb4e8d26dd4403bd5722e --return bool
```

### The whole tally at once

```bash
node results.js
```

### Every configured account, with balances and both address forms

```bash
npm run accounts
```

---

## B. Identity — the Hedera gotcha

### What address does the contract see for me?

```bash
node call.js --method whoAmI --mode query --as voter1 --return address
```

🟢 A query, and it returns the same answer as the transaction version:

```bash
node call.js --method whoAmI --mode execute --as voter1 --return address
```

🔵 Use `execute` only when you want the answer recorded on-ledger as evidence.

Both return `0xad91…9c4c` — the **alias**, not the long-zero `0x0000…9878cb`.
That distinction is the single easiest way to break this contract; see test D4.

---

## C. Security tests — these should all FAIL

The whole point. Each prints a decoded Solidity error rather than a bare
`CONTRACT_REVERT_EXECUTED`. All 🔵 (a revert still costs gas).

### C1. A blacklisted account cannot vote

```bash
node call.js --method vote --mode execute --as voter2 --uint256 0 --return null
```

→ `AccountIsBlacklisted()  [0xab73372a]`

Then confirm nothing changed:

```bash
node call.js --method totalVotes --return uint256
```

### C2. Nobody votes twice

```bash
node call.js --method vote --mode execute --as voter1 --uint256 2 --return null
```

→ `AlreadyVoted()  [0x7c9a1cf9]` — voter1 already voted, and cannot switch topic.

### C3. Only the owner can administrate

```bash
node call.js --method closeVoting --mode execute --as voter1 --return null
```

→ `NotOwner()  [0x30cd7471]`

```bash
node call.js --method setBlacklisted --mode execute --as voter1 --address 0xad910182b6c9075a6808f2e0d65675c2dd629c4c --bool true --return null
```

→ `NotOwner()` — a voter cannot blacklist their rivals.

### C4. The blacklist is frozen once voting opens

```bash
node call.js --method setBlacklisted --mode execute --address 0x4f6b0be57e6c276950cab3ea4ae2ac7c20f35b25 --bool true --return null
```

→ `WrongPhase(0, 1)` — "needs Setup, we are in Open".

**This is the most important test in the file.** Even the owner cannot blacklist
someone after seeing how they voted. Without this, the admin could watch the
tally and remove voters they dislike.

### C5. Voting can't be re-opened

```bash
node call.js --method openVoting --mode execute --return null
```

→ `WrongPhase(0, 1)`

### C6. A topic that doesn't exist

```bash
node call.js --method topicName --uint256 99 --return string
```

→ `InvalidTopic(99)  [0xcf9ce92c]` — 🟢 a query, since it's a view function, so
no gas is burned even though it reverts.

Phase numbers in `WrongPhase(required, current)`: **0 = Setup, 1 = Open, 2 = Closed**.

**Which error wins.** Only the *first* failing check reports, and `vote()` checks
in this order: phase → topic id → blacklist → already-voted. Both the phase and
topic-id checks are modifiers, so they run before the function body. An account
that has already voted and passes a bad topic id gets `InvalidTopic`, not
`AlreadyVoted`.

---

## D. Tests that need their own deploy 🆕

Your current contract is in `Open`, so anything Setup-phase needs a new one.
Each deploy is a few HBAR of Testnet money — you have plenty.

### D1. Voting before it opens

```bash
node deploy.js ./artifacts/Voting.json --gas 3000000 --arg-string-array "Yes,No"
```

Then, **without** opening it (use the new id):

```bash
node call.js --contract 0.0.NEW --method vote --mode execute --uint256 0 --return null
```

→ `WrongPhase(1, 0)` — "needs Open, we are in Setup".

### D2. Closing, then voting

On that same contract:

```bash
node call.js --contract 0.0.NEW --method openVoting --mode execute --return null
```

```bash
node call.js --contract 0.0.NEW --method closeVoting --mode execute --return null
```

```bash
node call.js --contract 0.0.NEW --method vote --mode execute --uint256 0 --return null
```

→ `WrongPhase(1, 2)`. Results stay readable forever:

```bash
node results.js --contract 0.0.NEW
```

### D3. Blacklisting the zero address

```bash
node call.js --contract 0.0.NEW --method setBlacklisted --mode execute --address 0x0000000000000000000000000000000000000000 --bool true --return null
```

→ `ZeroAddress()  [0xd92e233d]` — needs a contract still in `Setup`.

### D4. Blacklisting the WRONG address form ⭐

The most instructive failure in the whole project. On a fresh contract, blacklist
voter2's **long-zero** address instead of the alias:

```bash
node call.js --contract 0.0.NEW --method setBlacklisted --mode execute --address 0.0.10027089 --bool true --return null
```

(`--address` accepts a `0.0.x` id and converts it to the long-zero form.)

Confirm it registered:

```bash
node call.js --contract 0.0.NEW --method blacklisted --address 0.0.10027089 --return bool
```

→ `true`. Now open voting and let voter2 vote anyway:

```bash
node call.js --contract 0.0.NEW --method openVoting --mode execute --return null
```

```bash
node call.js --contract 0.0.NEW --method vote --mode execute --as voter2 --uint256 0 --return null
```

→ **SUCCESS.** The blacklist entry exists, the account is blocked on paper, and
the vote lands regardless — because `msg.sender` is the alias, not the long-zero
address. A silent, total bypass of the security control, with no error anywhere.

This is why `whoAmI()` exists.

**Already done for you on `0.0.10045338`**, so you can show it without spending
a deploy:

```bash
node call.js --contract 0.0.10045338 --method blacklisted --address 0.0.10027089 --return bool
```

→ `true` (the long-zero form is blacklisted)

```bash
node call.js --contract 0.0.10045338 --method blacklisted --address 0x826aeb65840e04a0d23cb4e8d26dd4403bd5722e --return bool
```

→ `false` (the alias — the form the contract actually checks — is not)

```bash
node call.js --contract 0.0.10045338 --method hasVoted --address 0x826aeb65840e04a0d23cb4e8d26dd4403bd5722e --return bool
```

→ `true`. The "blacklisted" account voted.

### D5. Un-blacklisting

On a Setup-phase contract, the flag goes both ways:

```bash
node call.js --contract 0.0.NEW --method setBlacklisted --mode execute --address 0x826aeb65840e04a0d23cb4e8d26dd4403bd5722e --bool false --return null
```

### D6. Deploying with no topics

```bash
node deploy.js ./artifacts/Voting.json --gas 3000000 --arg-string-array ""
```

→ the deploy fails before a contract exists:

```
❌ Deployment error: CONTRACT_REVERT_EXECUTED — constructor reverted: NoTopics()  [0xb50bca14]
```

The constructor refuses to create a vote nobody can participate in.

### D7. A single-topic vote

```bash
node deploy.js ./artifacts/Voting.json --gas 3000000 --arg-string-array "OnlyOption"
```

Valid: one topic, `isTie()` stays `false`, the winner is trivially topic 0.

### D8. Duplicate topic names

```bash
node deploy.js ./artifacts/Voting.json --gas 3000000 --arg-string-array "Pizza,Pizza,Pasta"
```

Deploys happily — **the contract does not deduplicate topics.** Two identical
names with separate counters, which splits the vote. Worth mentioning as a known
limitation, or fix it with a check in the constructor.

### D9. An outright winner instead of a draw

Deploy fresh, blacklist nobody, and have all three voters pick the same topic:

```bash
node call.js --contract 0.0.NEW --method vote --mode execute --as voter1 --uint256 0 --return null
```

```bash
node call.js --contract 0.0.NEW --method vote --mode execute --as voter2 --uint256 0 --return null
```

```bash
node call.js --contract 0.0.NEW --method vote --mode execute --as voter3 --uint256 1 --return null
```

```bash
node results.js --contract 0.0.NEW
```

→ `Winner: Pizza (2 of 3)` and `isTie()` = `false`. Run this to show the winner
path as well as the draw path.

### D10. The owner votes too

Nothing stops the admin from voting — they're an eligible account like any
other:

```bash
node call.js --contract 0.0.NEW --method vote --mode execute --uint256 1 --return null
```

Decide whether that's intended and be ready to justify it.

---

## E. Tooling and deployment

### Compile

```bash
npm run compile
```

### Compile without the optimizer (bigger bytecode, easier to read)

```bash
node compile.js ./artifacts/Voting.sol --no-optimize
```

### Compile for a newer EVM

```bash
node compile.js ./artifacts/Voting.sol --evm-version shanghai
```

### Deploy with a memo

```bash
node deploy.js ./artifacts/Voting.json --gas 3000000 --memo "OTH final demo" --arg-string-array "Pizza,Pasta,Sushi"
```

### Deploy with too little gas

```bash
node deploy.js ./artifacts/Voting.json --gas 1000000 --arg-string-array "Pizza,Pasta,Sushi"
```

→ `INSUFFICIENT_GAS`. Hedera does not refund unused gas, so the fix is 3 000 000,
not "as much as possible".

### Point a command at an old deployment

```bash
node results.js --contract 0.0.10045007
```

---

## F. Proving it on-ledger

Open the contract on HashScan:

**https://hashscan.io/testnet/contract/0.0.10045177**

Check the **Contract Calls** tab, where every test above appears — successes and
reverts both — and the **Events** tab for the audit trail the contract emits:

| Event | Emitted by |
|---|---|
| `PhaseChanged` | constructor, `openVoting`, `closeVoting` |
| `BlacklistUpdated` | `setBlacklisted` |
| `VoteCast` | `vote` |

Every state change in the contract emits one, so the full history of the vote is
reconstructable from the ledger by anyone, without trusting your machine or
these scripts. That is the property that makes this worth putting on a
blockchain at all.

---

## Suggested demo order

Fifteen minutes, showing every requirement:

1. `npm run compile` — the contract builds
2. `node deploy.js … --arg-string-array "Pizza,Pasta,Sushi"` — topics fixed by the constructor
3. `npm run accounts` + `whoAmI` — identify the voters
4. `setBlacklisted` voter2 — the admin bars an account
5. `openVoting` — the blacklist freezes
6. Vote as voter1 and voter3 — normal participation
7. **C1** blacklisted vote → `AccountIsBlacklisted()`
8. **C2** double vote → `AlreadyVoted()`
9. **C3** admin call as a voter → `NotOwner()`
10. **C4** late blacklist → `WrongPhase(0, 1)` — the censorship defence
11. `node results.js` — printed result, with the draw handled honestly
12. `closeVoting`, then vote → `WrongPhase(1, 2)`
13. HashScan — the events prove all of it

Keep **D4** in your back pocket. If someone asks whether the blacklist is
actually secure, that's the honest answer: it's only as good as knowing which
address form the contract checks.
