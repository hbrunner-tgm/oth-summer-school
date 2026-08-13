# Security design options

The assignment says *"the contract must be secure"* and *"a whitelist with accounts that are not allowed to vote"* — which describes a **blacklist**. `artifacts/Voting.sol` implements **option 1 + option 2a**. Everything else here is a documented alternative with the concrete change needed to adopt it.

Read this before the demo: most of the marks in a task like this come from being able to say *why* you chose a design and what it does **not** protect against.

---

## What the shipped contract already defends against

| Threat | Defence in `Voting.sol` |
|---|---|
| Voting twice | `hasVoted` mapping, checked and set in `vote()` |
| Voting from a barred account | `blacklisted` mapping, checked in `vote()` |
| Anyone calling admin functions | `onlyOwner` modifier; `owner` is `immutable` |
| Admin changing the topics after deploy | `_topics` written once in the constructor, no setter |
| Admin censoring voters *mid-vote* | Blacklist is frozen when `openVoting()` runs (option 2a) |
| Voting before setup is finished / after close | `Phase` state machine + `inPhase` modifier |
| Integer overflow of the tally | Solidity ≥0.8 checked arithmetic (the one `unchecked` block is a counter that cannot realistically overflow) |
| Reentrancy / stolen funds | No `payable` function, no external calls, no ether held |
| Out-of-gas on a growing topic list | Every loop is in a `view` function; no write path loops |
| Silent state changes | Every mutation emits an event |
| Voting for a topic that doesn't exist | Range check `topicId >= _topics.length` |

**What it does not defend against — say this out loud before someone asks:**

- **Sybil attack.** A blacklisted person can create a new Hedera account and vote. A blacklist is fundamentally leaky; only an allowlist (option 5) closes this.
- **Ballot secrecy.** Votes are public on the ledger. Real secret ballots need commit–reveal or ZK proofs.
- **Lost owner key.** With an `immutable` owner and no recovery, a lost key freezes the contract in its current phase forever. Options 3 and 4 trade simplicity for recoverability.

---

## Option 1 — Owner + blacklist mapping ✅ *implemented*

```solidity
address public immutable owner;
mapping(address => bool) public blacklisted;

modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

function setBlacklisted(address account, bool blocked) external onlyOwner { ... }
```

The deploying account is the admin. Simplest design that satisfies the brief.

- **Pro:** minimal code, minimal gas, nothing to misconfigure. `immutable` means no ownership-transfer bug is possible.
- **Con:** single point of failure. Lose the key and the contract is stuck.

---

## Option 2 — When may the admin edit the blacklist?

### 2a. Frozen once voting opens ✅ *implemented*

`setBlacklisted` carries `inPhase(Phase.Setup)`, so the eligible set is final before the first vote.

**This is the interesting security argument in the whole project.** An admin who can blacklist at any time can watch the tally on HashScan and remove voters who are voting the "wrong" way — the admin effectively decides the outcome, and the vote is theatre. Freezing makes the eligible set publicly auditable *before* anyone votes.

- **Con:** you cannot react to fraud discovered mid-vote; you would have to close voting and redeploy.

### 2b. Always mutable

Delete one modifier:

```diff
-    function setBlacklisted(address account, bool blocked)
-        external
-        onlyOwner
-        inPhase(Phase.Setup)
-    {
+    function setBlacklisted(address account, bool blocked) external onlyOwner {
```

- **Pro:** react to abuse discovered while voting is live. Easier to demo — no phase juggling.
- **Con:** the censorship attack above. If you pick this, at minimum keep the `BlacklistUpdated` event so the manipulation is visible on-ledger.

---

## Option 3 — Multi-admin roles

Replace the single owner with a set:

```solidity
mapping(address => bool) public isAdmin;
uint256 public adminCount;

modifier onlyAdmin() { if (!isAdmin[msg.sender]) revert NotAdmin(); _; }

constructor(string[] memory topics_) {
    isAdmin[msg.sender] = true;
    adminCount = 1;
    ...
}

function addAdmin(address a) external onlyAdmin {
    if (a == address(0)) revert ZeroAddress();
    if (!isAdmin[a]) { isAdmin[a] = true; adminCount++; emit AdminAdded(a); }
}

function removeAdmin(address a) external onlyAdmin {
    if (adminCount == 1) revert LastAdmin();   // never lock yourself out
    if (isAdmin[a]) { isAdmin[a] = false; adminCount--; emit AdminRemoved(a); }
}
```

Then swap every `onlyOwner` for `onlyAdmin` and drop the `owner` field.

- **Pro:** no single point of failure; the `LastAdmin` guard prevents bricking.
- **Con:** *any* admin can add or remove another, so one compromised admin key compromises the whole set. A production system would use OpenZeppelin `AccessControl` with a separate `DEFAULT_ADMIN_ROLE`, or require m-of-n.

---

## Option 4 — Two-step ownership transfer

Only relevant if you drop `immutable`.

```solidity
address public owner;
address public pendingOwner;

function transferOwnership(address newOwner) external onlyOwner {
    if (newOwner == address(0)) revert ZeroAddress();
    pendingOwner = newOwner;             // nothing has changed yet
    emit OwnershipTransferStarted(owner, newOwner);
}

function acceptOwnership() external {
    if (msg.sender != pendingOwner) revert NotPendingOwner();
    emit OwnershipTransferred(owner, pendingOwner);
    owner = pendingOwner;
    pendingOwner = address(0);
}
```

- **Pro:** a typo'd address cannot take ownership, because the new owner must prove control by sending a transaction. One-step `transferOwnership` has burned real projects.
- **Con:** more state, more gas, and `owner` can no longer be `immutable` (slightly higher read cost, and a new bug surface that the shipped design simply doesn't have).

---

## Option 5 — Allowlist instead of blacklist

Invert the check: default-deny.

```diff
-mapping(address => bool) public blacklisted;
+mapping(address => bool) public allowed;

 function vote(uint256 topicId) external inPhase(Phase.Open) {
-    if (blacklisted[msg.sender]) revert AccountIsBlacklisted();
+    if (!allowed[msg.sender]) revert NotEligible();
```

Plus a batch registration function, since you now have to name every voter:

```solidity
function allowVoters(address[] calldata voters) external onlyOwner inPhase(Phase.Setup) {
    for (uint256 i = 0; i < voters.length; i++) {
        allowed[voters[i]] = true;
        emit VoterAllowed(voters[i]);
    }
}
```

- **Pro:** **closes the Sybil hole.** Creating a new account gets you nothing, because new accounts are not on the list. This is the correct model for a vote with a known electorate (a class, a DAO, a shareholder register).
- **Con:** the admin must know every voter up front, and registration costs gas per voter. The loop is bounded by the array the admin passes, so batch in chunks for a large electorate.
- **Note:** the slide says "whitelist", so being able to demo *both* and explain that a blacklist cannot stop Sybils is a strong answer.

---

## Option 6 — Merkle-root eligibility

Store one 32-byte root instead of a list; each voter supplies a proof.

```solidity
bytes32 public eligibilityRoot;      // set by admin in Setup

function vote(uint256 topicId, bytes32[] calldata proof) external inPhase(Phase.Open) {
    bytes32 leaf = keccak256(abi.encodePacked(msg.sender));
    if (!_verify(proof, eligibilityRoot, leaf)) revert NotEligible();
    ...
}
```

- **Pro:** constant on-chain storage for an electorate of any size — 10 or 10 000 voters cost the admin the same. Voters pay a small verification cost (~`log₂(n)` hashes).
- **Con:** needs off-chain tooling to build the tree and hand each voter their proof; the full list must be published somewhere for the root to be auditable. Also more code to get wrong — use OpenZeppelin's `MerkleProof` rather than hand-rolling `_verify`.

---

## Option 7 — Signature-based eligibility (EIP-712)

No on-chain list at all. The admin signs each voter off-chain; the contract recovers the signer.

```solidity
function vote(uint256 topicId, bytes calldata signature) external inPhase(Phase.Open) {
    bytes32 digest = keccak256(abi.encodePacked(
        "\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(VOTE_TYPEHASH, msg.sender))
    ));
    if (ECDSA.recover(digest, signature) != owner) revert NotEligible();
    ...
}
```

- **Pro:** zero admin gas cost — eligibility is granted entirely off-chain, and scales to any number of voters.
- **Con:** the most ways to get it wrong. You need a domain separator (or a signature from one deployment is replayable on another), and the `hasVoted` mapping is what stops replay here — drop it and the same signature votes forever. Signature malleability is handled by using OpenZeppelin's `ECDSA`, not raw `ecrecover`.

---

## Choosing

| If the graders care about… | Pick |
|---|---|
| Meeting the brief cleanly and being able to explain every line | **1 + 2a** *(shipped)* |
| Showing you understand what a blacklist cannot do | **5**, and say why |
| Operational realism | **3 + 4** |
| Gas / scale engineering | **6** or **7** |

Whichever you pick, keep the phase machine, the events, and the `hasVoted` check — those are orthogonal to the eligibility model and each one is a separate mark.
