// SPDX-License-Identifier: MIT
//
// FROZEN — do not edit.
//
// This is the exact source of the contract live on Celo mainnet at
// 0x3ed53c9bf7f7b5026eae83e4d62abdbd748a01ab, under which 20,097 verdicts were
// published. It is kept verbatim so that deployment stays verifiable from this
// repository's HEAD after the working contract moved on to v3. Falsifiability
// is the whole premise of this project; a repository that can no longer
// reproduce the bytecode of its own live contract has quietly withdrawn it.
//
// Build it with:  CONTRACT_SOURCE=contracts/deployed/ProvenanceAttestationsV2.sol npm run compile
//
pragma solidity 0.8.28;

/// @title  ProvenanceAttestations
/// @notice On-chain evidence-integrity verdicts for ERC-8004 reputation
///         feedback on Celo.
///
/// @dev    WHY THIS EXISTS
///         The ERC-8004 Reputation Registry lets anyone score any agent. The
///         standard leaves room for evidence — an off-chain file, its attested
///         hash, and an optional `proofOfPayment` naming the transaction the
///         review is about — but nothing requires any of it and nothing checks
///         it. A full-history census of the Celo registry (27,520 records,
///         Feb–Aug 2026) found that 38% declare an evidence file, three
///         quarters of those files are dead links, 35% attest a hash while
///         publishing no file at all, 93 records name a payment, and 17 of
///         those payments exist.
///
///         This contract is the verifier's ledger: for a given feedback record
///         it stores how far its evidence actually holds up. It scores nothing
///         and ranks nothing — scorers, marketplaces and routers read it to
///         weight feedback by something harder than assertion.
///
/// @dev    WHAT CHANGED FROM v1
///         v1 could only express payment outcomes, so it could only speak about
///         the 93 records that declare a payment — a third of a percent of the
///         registry. The verdict set below covers the whole evidence ladder, of
///         which a settled payment is simply the top rung. Its own audit then
///         forced two refinements before deployment: a dead file served as an
///         HTML page with HTTP 200 is unreachable, not mismatched; and a live
///         file with no attested hash is unbound, not mismatched — there was
///         never anything to contradict. Values are append-only from here:
///         indexers depend on them.
///
/// @dev    TRUST MODEL, STATED PLAINLY
///         Verdicts are written by a single accountable attester, rotatable by
///         the owner. This is honest centralization: the attestation process is
///         open source and reproducible, so any party can re-run it and dispute
///         a verdict publicly. Decentralizing the attester (staked re-execution,
///         multi-attester quorum) is roadmap, not premise. The contract
///         custodies no funds, has no payable path, and makes no external calls.
contract ProvenanceAttestations {
    // ---------------------------------------------------------------- types

    /// @notice How far a feedback record's evidence survives verification.
    /// @dev    Ordered strongest to weakest. `None` is the mapping default and
    ///         can never be written, so "never attested" stays unforgeable.
    enum Verdict {
        None,                 // 0 — never attested
        PaymentVerified,      // 1 — declared payment exists, succeeded, moved value
        EvidenceIntact,       // 2 — file resolves as valid JSON and matches its attested hash
        EvidenceUnbound,      // 3 — file resolves as valid JSON but no hash was attested: nothing binds it
        EvidenceUnhashed,     // 4 — file resolves as valid JSON and contradicts its attested hash
        PaymentTxNotFound,    // 5 — a payment was declared; it is not on this chain
        PaymentTxFailed,      // 6 — declared payment exists but reverted
        PaymentNoValue,       // 7 — declared payment succeeded but moved nothing relevant
        EvidenceUnreachable,  // 8 — the declared file no longer resolves to evidence (dead link or soft-404)
        EvidenceAbsent        // 9 — a hash was attested with no file published at all
    }

    struct Attestation {
        Verdict verdict;      // outcome of the latest check
        uint40 checkedAt;     // block.timestamp of the latest check
        uint32 revision;      // number of times this record has been attested
        bytes32 paymentTx;    // declared payment tx hash (0x0 when none was declared)
        bytes32 evidenceHash; // the registry's own feedbackHash, for cross-reference
    }

    // ---------------------------------------------------------------- state

    address public owner;
    address public attester;

    /// @dev key(agentId, clientAddress, feedbackIndex) => latest attestation.
    ///      Prior revisions stay fully reconstructable from event history.
    mapping(bytes32 => Attestation) private _attestations;

    /// @notice Total attestation writes, including re-attestations. Cheap
    ///         liveness signal for anyone watching the service.
    uint256 public totalAttestations;

    // ---------------------------------------------------------------- events

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AttesterChanged(address indexed previousAttester, address indexed newAttester);

    /// @notice Emitted on every attestation, including re-attestations.
    /// @dev    Mirrors the registry's own (agentId, clientAddress, feedbackIndex)
    ///         keying so indexers can join without holding state.
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
    error EmptyBatch();

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
    /// @dev    Re-attesting overwrites the stored state and bumps `revision`,
    ///         deliberately: verdicts change over time — a file dies, a
    ///         transaction appears. History lives in events, which cannot be
    ///         rewritten.
    function attest(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        Verdict verdict,
        bytes32 paymentTx,
        bytes32 evidenceHash
    ) public onlyAttester {
        if (verdict == Verdict.None) revert InvalidVerdict();

        Attestation storage a = _attestations[key(agentId, clientAddress, feedbackIndex)];
        a.verdict = verdict;
        a.checkedAt = uint40(block.timestamp);
        unchecked { a.revision += 1; }
        a.paymentTx = paymentTx;
        a.evidenceHash = evidenceHash;

        unchecked { totalAttestations += 1; }

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
        if (n == 0) revert EmptyBatch();
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

    /// @notice Canonical storage key, mirroring the ERC-8004 registry's tuple.
    function key(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode(agentId, clientAddress, feedbackIndex));
    }

    /// @notice Latest attestation. `verdict == None` means never attested.
    function getAttestation(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external view returns (Attestation memory)
    {
        return _attestations[key(agentId, clientAddress, feedbackIndex)];
    }

    /// @notice Strictest integration surface: is this feedback backed by a
    ///         payment that was verified to have settled?
    function isPaymentBacked(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external view returns (bool)
    {
        return _attestations[key(agentId, clientAddress, feedbackIndex)].verdict
            == Verdict.PaymentVerified;
    }

    /// @notice Looser surface for consumers that only need to discard feedback
    ///         resting on nothing: true when the evidence was retrievable and
    ///         matched what was attested on chain, whether or not a payment was
    ///         declared.
    function hasIntactEvidence(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external view returns (bool)
    {
        Verdict v = _attestations[key(agentId, clientAddress, feedbackIndex)].verdict;
        return v == Verdict.PaymentVerified || v == Verdict.EvidenceIntact;
    }
}
