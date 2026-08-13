// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Voting
 * @notice A single-round voting contract. Topics are fixed by the constructor,
 *         every address may vote exactly once, and the deploying account (the
 *         owner / admin) can block accounts from voting via a blacklist.
 *
 * @dev Lifecycle — Setup -> Open -> Closed
 *
 *      Setup   The owner blacklists accounts. Nobody can vote yet.
 *      Open    Voting is live and THE BLACKLIST IS FROZEN.
 *      Closed  No further votes. Results stay readable forever.
 *
 *      Freezing the blacklist at `openVoting()` is the central security
 *      decision. If the owner could blacklist at any time, they could watch the
 *      tally and censor voters reactively — the admin would effectively control
 *      the outcome. Freezing makes the eligible set auditable on-ledger before
 *      a single vote is cast. See SECURITY.md for the alternatives.
 *
 * @dev Security properties
 *      - Topics are written once in the constructor; no function can change them.
 *      - One vote per address, enforced by the `hasVoted` mapping.
 *      - Admin functions are guarded by `onlyOwner`; `owner` is immutable, so
 *        there is no ownership-transfer bug to have.
 *      - No function is `payable` and the contract makes no external calls, so
 *        there is no reentrancy or fund-drain surface.
 *      - `vote()` writes `hasVoted` before touching the tally (checks-effects).
 *      - Every loop lives in a `view` function; no write path can run out of gas
 *        as the number of topics grows.
 *      - Every state change emits an event, so the full history is on HashScan.
 *
 * @dev Known limitation: a blacklist cannot stop someone from creating a fresh
 *      account and voting again (a Sybil attack). Only an allowlist closes that
 *      hole — see option 5 in SECURITY.md.
 */
contract Voting {
    /* ------------------------------------------------------------------ */
    /* Types                                                               */
    /* ------------------------------------------------------------------ */

    enum Phase {
        Setup,
        Open,
        Closed
    }

    /* ------------------------------------------------------------------ */
    /* Errors — cheaper than require-strings and unambiguous in a trace     */
    /* ------------------------------------------------------------------ */

    error NotOwner();
    error WrongPhase(Phase required, Phase current);
    error AccountIsBlacklisted();
    error AlreadyVoted();
    error InvalidTopic(uint256 topicId);
    error NoTopics();
    error ZeroAddress();

    /* ------------------------------------------------------------------ */
    /* Events                                                              */
    /* ------------------------------------------------------------------ */

    event VoteCast(address indexed voter, uint256 indexed topicId);
    event BlacklistUpdated(address indexed account, bool blocked);
    event PhaseChanged(Phase newPhase);

    /* ------------------------------------------------------------------ */
    /* State                                                               */
    /* ------------------------------------------------------------------ */

    /// @notice The account that deployed the contract. Cannot be changed.
    address public immutable owner;

    /// @notice Current lifecycle phase.
    Phase public phase;

    /// @notice Total number of votes cast across all topics.
    uint256 public totalVotes;

    /// @notice True once `account` has voted.
    mapping(address => bool) public hasVoted;

    /// @notice True if `account` is barred from voting.
    mapping(address => bool) public blacklisted;

    string[] private _topics;
    uint256[] private _tally; // parallel to _topics

    /* ------------------------------------------------------------------ */
    /* Modifiers                                                           */
    /* ------------------------------------------------------------------ */

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier inPhase(Phase required) {
        if (phase != required) revert WrongPhase(required, phase);
        _;
    }

    /* ------------------------------------------------------------------ */
    /* Construction                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * @param topics_ The topics to vote on. Fixed for the life of the contract.
     */
    constructor(string[] memory topics_) {
        if (topics_.length == 0) revert NoTopics();

        owner = msg.sender;
        _topics = topics_;
        _tally = new uint256[](topics_.length);
        phase = Phase.Setup;

        emit PhaseChanged(Phase.Setup);
    }

    /* ------------------------------------------------------------------ */
    /* Admin                                                               */
    /* ------------------------------------------------------------------ */

    /**
     * @notice Block or unblock an account. Only possible during Setup — once
     *         voting opens the blacklist is frozen.
     */
    function setBlacklisted(address account, bool blocked)
        external
        onlyOwner
        inPhase(Phase.Setup)
    {
        if (account == address(0)) revert ZeroAddress();

        blacklisted[account] = blocked;
        emit BlacklistUpdated(account, blocked);
    }

    /// @notice Freeze the blacklist and open voting.
    function openVoting() external onlyOwner inPhase(Phase.Setup) {
        phase = Phase.Open;
        emit PhaseChanged(Phase.Open);
    }

    /// @notice Close voting. The result becomes final.
    function closeVoting() external onlyOwner inPhase(Phase.Open) {
        phase = Phase.Closed;
        emit PhaseChanged(Phase.Closed);
    }

    /* ------------------------------------------------------------------ */
    /* Voting                                                              */
    /* ------------------------------------------------------------------ */

    /**
     * @notice Cast your single vote for `topicId`.
     * @dev Reverts if voting is not open, the caller is blacklisted, the caller
     *      has already voted, or the topic does not exist.
     */
    function vote(uint256 topicId) external inPhase(Phase.Open) {
        if (blacklisted[msg.sender]) revert AccountIsBlacklisted();
        if (hasVoted[msg.sender]) revert AlreadyVoted();
        if (topicId >= _topics.length) revert InvalidTopic(topicId);

        // Effects before the tally update.
        hasVoted[msg.sender] = true;

        unchecked {
            // Bounded by the number of accounts; cannot realistically overflow.
            _tally[topicId] += 1;
            totalVotes += 1;
        }

        emit VoteCast(msg.sender, topicId);
    }

    /* ------------------------------------------------------------------ */
    /* Views — each returns exactly ONE scalar so call.js can decode it     */
    /* ------------------------------------------------------------------ */

    /// @notice Number of topics.
    function topicCount() external view returns (uint256) {
        return _topics.length;
    }

    /// @notice Name of topic `topicId`.
    function topicName(uint256 topicId) external view returns (string memory) {
        if (topicId >= _topics.length) revert InvalidTopic(topicId);
        return _topics[topicId];
    }

    /// @notice Votes cast for topic `topicId`.
    function voteCount(uint256 topicId) external view returns (uint256) {
        if (topicId >= _topics.length) revert InvalidTopic(topicId);
        return _tally[topicId];
    }

    /// @notice The topic with the most votes. Ties resolve to the lowest id.
    function winningTopicId() external view returns (uint256) {
        return _winningTopicId();
    }

    /// @notice Name of the winning topic.
    function winningTopicName() external view returns (string memory) {
        return _topics[_winningTopicId()];
    }

    /// @notice One printable result line, e.g. `"Pizza: 3"`.
    function resultLine(uint256 topicId) external view returns (string memory) {
        if (topicId >= _topics.length) revert InvalidTopic(topicId);
        return string.concat(_topics[topicId], ": ", _toString(_tally[topicId]));
    }

    /// @notice Current phase as text: `"Setup"`, `"Open"` or `"Closed"`.
    function phaseName() external view returns (string memory) {
        if (phase == Phase.Setup) return "Setup";
        if (phase == Phase.Open) return "Open";
        return "Closed";
    }

    /**
     * @notice Returns the address the contract sees as the caller.
     * @dev On Hedera an account can appear either as its long-zero address or
     *      as its ECDSA alias address. Call this from each voter before
     *      blacklisting anyone, so you blacklist the address that `vote()` will
     *      actually check.
     */
    function whoAmI() external view returns (address) {
        return msg.sender;
    }

    /* ------------------------------------------------------------------ */
    /* Internals                                                           */
    /* ------------------------------------------------------------------ */

    function _winningTopicId() private view returns (uint256 winner) {
        uint256 best = _tally[0];
        winner = 0;
        for (uint256 i = 1; i < _tally.length; i++) {
            if (_tally[i] > best) {
                best = _tally[i];
                winner = i;
            }
        }
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";

        uint256 digits;
        for (uint256 tmp = value; tmp != 0; tmp /= 10) {
            digits++;
        }

        bytes memory buffer = new bytes(digits);
        for (uint256 i = digits; i > 0; i--) {
            buffer[i - 1] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
