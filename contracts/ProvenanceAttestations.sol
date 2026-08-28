// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title  ProvenanceAttestations
/// @notice On-chain verification verdicts for ERC-8004 reputation feedback on Celo.
///
/// @dev    WHY THIS EXISTS
///         The ERC-8004 Reputation Registry lets anyone score any agent. The
///         standard leaves a slot for evidence — an optional `proofOfPayment`
///         naming the transaction a review is about — but nothing requires it
///         and nothing checks it. A full-history census of the Celo registry
///         (27,520 records, Feb–Aug 2026) found 93 records declaring a payment,
///         of which 76 name transactions that do not exist on Celo, and a third
///         of the registry attesting hashes with no file published at all.
///
///         This contract is the missing verifier's ledger: for a given feedback
///         record, it stores the outcome of actually checking the claim against
///         the chain. It scores nothing and ranks nothing — it records whether
///         the evidence holds, so that scorers, marketplaces and routers can
///         weight feedback by something harder than assertion.
///
/// @dev    TRUST MODEL, STATED PLAINLY
///         Verdicts are written by a single accountable attester (rotatable by
///         the owner). This is honest centralization: the attestation process
///         is open source and reproducible (github.com/BacBacta/celo-agent-
///         feedback-audit), so any party can re-run it and dispute a verdict
///         publicly. Decentralizing the attester (staked re-execution, multi-
///         attester quorum) is roadmap, not premise. The contract custodies no
///         funds, has no payable path, and makes no external calls.
contract ProvenanceAttestations {
    // ---------------------------------------------------------------- types

    /// @notice Outcome of verifying one feedback record's payment claim.
    /// @dev    Values are stable API — indexers depend on them. Append only.
    enum Verdict {
        None,                // 0 — never attested (mapping default; never written)
        PaymentVerified,     // 1 — claimed tx exists, succeeded, moved value
        TxNotFound,          // 2 — claimed tx absent from Celo (or claim malformed)
        TxFailed,            // 3 — claimed tx exists but reverted
        NoValueMoved,        // 4 — claimed tx exists, succeeded, moved nothing relevant
        EvidenceUnreachable  // 5 — feedback file no longer resolvable at check time
    }

    struct Attestation {
        Verdict verdict;      // outcome of the latest check
        uint40 checkedAt;     // block.timestamp of the latest check
        uint32 revision;      // number of times this record has been attested
        bytes32 paymentTx;    // claimed payment tx hash (0x0 when none was checkable)
        bytes32 evidenceHash; // registry's feedbackHash for the record, for cross-reference
    }

    // ---------------------------------------------------------------- state

    address public owner;
    address public attester;

    /// @dev key(agentId, clientAddress, feedbackIndex) => latest attestation.
    ///      Prior revisions remain fully reconstructable from event history.
    mapping(bytes32 => Attestation) private _attestations;

    // ---------------------------------------------------------------- events

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AttesterChanged(address indexed previousAttester, address indexed newAttester);

    /// @notice Emitted on every attestation, including re-attestations.
    /// @dev    The full (agentId, clientAddress, feedbackIndex) tuple mirrors the
    ///         ERC-8004 registry's own keying, so indexers can join without state.
    event FeedbackAttested(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        Verdict verdict,
        bytes32 paymentTx,
        bytes32 evidenceHash,
        uint32 revision
    );

    // ---------------------------------------------------------------- errors

    error NotOwner();
    error NotAttester();
    error ZeroAddress();
    error LengthMismatch();
    error InvalidVerdict();

    // ------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAttester() {
        if (msg.sender != attester) revert NotAttester();
        _;
    }

    // ---------------------------------------------------------- construction

    constructor(address initialAttester) {
        if (initialAttester == address(0)) revert ZeroAddress();
        owner = msg.sender;
        attester = initialAttester;
        emit OwnershipTransferred(address(0), msg.sender);
        emit AttesterChanged(address(0), initialAttester);
    }

    // ---------------------------------------------------------------- admin

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setAttester(address newAttester) external onlyOwner {
        if (newAttester == address(0)) revert ZeroAddress();
        emit AttesterChanged(attester, newAttester);
        attester = newAttester;
    }

    // ---------------------------------------------------------------- write

    /// @notice Record the verification outcome for one feedback record.
    /// @dev    Re-attesting the same record overwrites the stored latest state
    ///         and bumps `revision` — deliberately, because verdicts can change:
    ///         a file dies later, a transaction appears later. History lives in
    ///         events, which cannot be rewritten.
    function attest(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        Verdict verdict,
        bytes32 paymentTx,
        bytes32 evidenceHash
    ) public onlyAttester {
        // None is the "absence" value; writing it would let an attestation
        // masquerade as no-attestation.
        if (verdict == Verdict.None) revert InvalidVerdict();

        bytes32 k = key(agentId, clientAddress, feedbackIndex);
        Attestation storage a = _attestations[k];

        a.verdict = verdict;
        a.checkedAt = uint40(block.timestamp);
        unchecked {
            // 2^32 re-attestations of one record is not a realistic path; if it
            // ever wraps, events still carry the truth.
            a.revision += 1;
        }
        a.paymentTx = paymentTx;
        a.evidenceHash = evidenceHash;

        emit FeedbackAttested(
            agentId, clientAddress, feedbackIndex, verdict, paymentTx, evidenceHash, a.revision
        );
    }

    /// @notice Batch form of {attest}, for backfills and periodic sweeps.
    function attestBatch(
        uint256[] calldata agentIds,
        address[] calldata clientAddresses,
        uint64[] calldata feedbackIndexes,
        Verdict[] calldata verdicts,
        bytes32[] calldata paymentTxs,
        bytes32[] calldata evidenceHashes
    ) external onlyAttester {
        uint256 n = agentIds.length;
        if (
            clientAddresses.length != n || feedbackIndexes.length != n ||
            verdicts.length != n || paymentTxs.length != n || evidenceHashes.length != n
        ) revert LengthMismatch();

        for (uint256 i = 0; i < n; i++) {
            attest(
                agentIds[i], clientAddresses[i], feedbackIndexes[i],
                verdicts[i], paymentTxs[i], evidenceHashes[i]
            );
        }
    }

    // ----------------------------------------------------------------- read

    /// @notice Canonical storage key for a feedback record, mirroring the
    ///         ERC-8004 registry's (agentId, clientAddress, feedbackIndex) tuple.
    function key(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(agentId, clientAddress, feedbackIndex));
    }

    /// @notice Latest attestation for a feedback record. `verdict == None`
    ///         means the record has never been attested.
    function getAttestation(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (Attestation memory)
    {
        return _attestations[key(agentId, clientAddress, feedbackIndex)];
    }

    /// @notice One-call integration surface: does this feedback rest on a
    ///         verified settled payment, as of the latest check?
    function isPaymentBacked(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (bool)
    {
        return _attestations[key(agentId, clientAddress, feedbackIndex)].verdict
            == Verdict.PaymentVerified;
    }
}
