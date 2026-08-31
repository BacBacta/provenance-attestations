// SPDX-License-Identifier: MIT
//
// FROZEN — do not edit.
//
// The exact source of the contract live on Celo mainnet at
// 0xAD6202F635e97f17f193524CCa66B5D288ab6807, verified on Blockscout. Kept
// verbatim so that deployment stays reproducible from this repository's HEAD
// after the working contract moved on to v4. A repository that can no longer
// rebuild the bytecode of its own live contract has quietly withdrawn it, and
// falsifiability is the whole premise here.
//
// Build it with:  CONTRACT_SOURCE=contracts/deployed/ProvenanceAttestationsV3.sol npm run compile
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
/// @dev    WHAT CHANGED FROM v2
///         v2's own counter-analysis found the top of its ladder usurpable and
///         its read surface misleading. Four repairs follow from that, and none
///         of them renumbers an existing value: 20,097 verdicts are already
///         published under values 0–9 and indexers depend on them, so the new
///         rungs are appended at 10–13 and the old ones keep their meanings.
///
///         1. `PaymentVerified` says a cited transaction settled. It never said
///            the payer was the reviewer or the payee the agent, so anyone could
///            cite any real transfer on the chain and collect the strongest
///            verdict in the system. `PaymentAttributed` (10) is that stronger
///            claim, with both ends confirmed; `PaymentPartyMismatch` (11) is
///            the accusation when they provably belong to somebody else.
///         2. A record has two independent dimensions — what its file does and
///            what its payment does — and v2 had one slot for both. The payment
///            rungs outranked every documentary rung, so for every record that
///            declared a payment the state of its file was measured and then
///            discarded. They are now stored side by side.
///         3. `hasIntactEvidence` returned true for `PaymentVerified`, which
///            asserts nothing whatsoever about a file. It now answers only the
///            question it names.
///         4. A settled payment is immutable, but v2's single slot let a later
///            re-attestation overwrite it — a file dying years afterwards would
///            flip `isPaymentBacked` from true to false about a transaction
///            that had not changed. The payment dimension is now sticky: a pass
///            with nothing to say about the payment leaves it alone.
///
///         Also new: the settled amount and its token, so "payment-backed" can
///         be told apart from a dust transfer without an off-chain lookup; and
///         `observedAt`, because `checkedAt` is the block that recorded the
///         verdict, which for a backfill is days after the observation.
///
/// @dev    TRUST MODEL, STATED PLAINLY
///         Verdicts are written by a single accountable attester, rotatable by
///         the owner. This is honest centralization: the attestation process is
///         open source and reproducible, so any party can re-run it and dispute
///         a verdict publicly. Decentralizing the attester (staked re-execution,
///         multi-attester quorum) is roadmap, not premise. The contract
///         custodies no funds, has no payable path, and makes no external calls.
///
///         Ownership transfer is two-step on purpose. The owner's only power is
///         rotating the attester, which is the sole defence if the attesting key
///         is compromised — and a one-step transfer to a mistyped address
///         destroys that defence permanently and silently. Two steps also make
///         it safe to move ownership to a cold key held apart from the hot
///         attesting key, which is the configuration this service should run in
///         and the one a single-key deployment cannot express.
contract ProvenanceAttestations {
    // ---------------------------------------------------------------- types

    /// @notice How far a feedback record's evidence survives verification.
    /// @dev    `None` is the mapping default and can never be written, so
    ///         "never attested" stays unforgeable. Values are append-only:
    ///         0–9 are published on chain under v2 and must never be renumbered
    ///         or redefined.
    enum Verdict {
        None,                 // 0 — never attested
        PaymentVerified,      // 1 — declared payment exists, succeeded, moved value. NOT attributed.
        EvidenceIntact,       // 2 — file resolves as valid JSON and matches its attested hash
        EvidenceUnbound,      // 3 — file resolves as valid JSON but no hash was attested: nothing binds it
        EvidenceUnhashed,     // 4 — file resolves as valid JSON and contradicts its attested hash
        PaymentTxNotFound,    // 5 — a payment was declared; it is not on this chain
        PaymentTxFailed,      // 6 — declared payment exists but reverted
        PaymentNoValue,       // 7 — declared payment succeeded but moved nothing relevant
        EvidenceUnreachable,  // 8 — a host answered that the declared file is gone
        EvidenceAbsent,       // 9 — a hash was attested with no file published at all
        PaymentAttributed,    // 10 — …and this reviewer paid this agent. The strong rung.
        PaymentPartyMismatch, // 11 — settled, but its parties contradict the claim
        PaymentForeignChain,  // 12 — declared on a chain the attester does not query
        EvidenceInconclusive  // 13 — retrieval failed in a way that proves nothing
    }

    /// @notice The documentary dimension, recorded whatever the payment says.
    /// @dev    `Unknown` means this pass did not evaluate the file.
    enum Evidence {
        Unknown,      // 0
        Intact,       // 1
        Unbound,      // 2
        Unhashed,     // 3
        Unreachable,  // 4
        Inconclusive, // 5
        Absent        // 6
    }

    /// @notice The payment dimension, recorded whatever the file says.
    /// @dev    `Unknown` is not "no payment": it is "this pass had nothing to
    ///         say", and writing it PRESERVES whatever was known before. A
    ///         settled transfer is a permanent fact about the chain, and must
    ///         not be erased by a later pass that could no longer read the file
    ///         naming it.
    enum Payment {
        Unknown,       // 0 — nothing evaluated this pass; prior state is kept
        Attributed,    // 1
        Verified,      // 2
        PartyMismatch, // 3
        NoValue,       // 4
        Failed,        // 5
        NotFound,      // 6
        ForeignChain   // 7
    }

    struct Attestation {
        Verdict verdict;       // headline rung of the latest check
        Evidence evidence;     // documentary dimension
        Payment payment;       // payment dimension (sticky — see {Payment})
        uint40 checkedAt;      // block.timestamp of the latest write
        uint40 observedAt;     // when the check actually ran; 0 when not stated
        uint32 revision;       // number of times this record has been attested
        uint8 amountDecimals;  // decimals of `amount`, from the token
        bytes32 paymentTx;     // declared payment tx hash (0x0 when none was declared)
        bytes32 evidenceHash;  // the registry's own feedbackHash, for cross-reference
        uint96 amount;         // settled amount in token base units; 0 when unknown
        address paymentToken;  // token the amount is denominated in
    }

    /// @notice One record's verification outcome, as submitted by the attester.
    /// @dev    A struct rather than six parallel arrays. The arrays had to be
    ///         length-checked at runtime because nothing else stopped them from
    ///         drifting out of step, and a mis-zipped batch writes correct-looking
    ///         verdicts onto the wrong records.
    struct Claim {
        uint256 agentId;
        address clientAddress;
        uint64 feedbackIndex;
        Verdict verdict;
        Evidence evidence;
        Payment payment;
        bytes32 paymentTx;
        bytes32 evidenceHash;
        uint96 amount;
        address paymentToken;
        uint8 amountDecimals;
        uint40 observedAt;
    }

    // ---------------------------------------------------------------- state

    address public owner;
    /// @notice Owner-elect under the two-step handover. Zero when none pending.
    address public pendingOwner;
    address public attester;

    /// @dev key(agentId, clientAddress, feedbackIndex) => latest attestation.
    ///      Prior revisions stay fully reconstructable from event history.
    mapping(bytes32 => Attestation) private _attestations;

    /// @notice Total attestation writes, including re-attestations. Cheap
    ///         liveness signal for anyone watching the service.
    uint256 public totalAttestations;

    /// @notice Contract revision, for consumers that read across deployments.
    string public constant VERSION = "3.0.0";

    // ---------------------------------------------------------------- events

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AttesterChanged(address indexed previousAttester, address indexed newAttester);

    /// @notice Emitted on every attestation, including re-attestations.
    /// @dev    Mirrors the registry's own (agentId, clientAddress, feedbackIndex)
    ///         keying so indexers can join without holding state. `verdict` is
    ///         indexed so a consumer can subscribe to one rung — "tell me about
    ///         attributed payments" — without filtering the whole stream.
    event FeedbackAttested(
        uint256 indexed agentId,
        address indexed clientAddress,
        Verdict indexed verdict,
        uint64 feedbackIndex,
        Evidence evidence,
        Payment payment,
        bytes32 paymentTx,
        bytes32 evidenceHash,
        uint96 amount,
        address paymentToken,
        uint8 amountDecimals,
        uint40 observedAt,
        uint32 revision
    );

    // ---------------------------------------------------------------- errors

    error NotOwner();
    error NotPendingOwner();
    error NotAttester();
    error ZeroAddress();
    error InvalidVerdict();
    error EmptyBatch();
    /// @dev A rung asserting the transaction was found, carrying no transaction.
    error MissingPaymentTx();
    /// @dev An attributed payment that moved nothing, or an amount with no token.
    error IncoherentAmount();
    /// @dev An observation timestamped after the block that records it.
    error ObservationInFuture();
    /// @dev The headline verdict and the payment dimension name different outcomes.
    error DimensionMismatch();

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

    /// @notice Begin handing ownership to `newOwner`, who must accept it.
    /// @dev    Two steps because the owner's only power is rotating a
    ///         compromised attester, and a one-step transfer to an address
    ///         nobody holds destroys that power with no way back. Passing the
    ///         zero address cancels a pending handover.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Complete the handover. Only the owner-elect can call this, which
    ///         is what proves the key exists and is controlled.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
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
    ///         rewritten. The one exception is the payment dimension, which is
    ///         preserved when this pass reports `Payment.Unknown`: a settled
    ///         transfer does not stop having happened because its evidence file
    ///         later went offline.
    function attest(Claim calldata c) public onlyAttester {
        _validate(c);

        Attestation storage a = _attestations[key(c.agentId, c.clientAddress, c.feedbackIndex)];
        a.verdict = c.verdict;
        // Both dimensions are preserved by an `Unknown`, not just the payment.
        // The asymmetry was a real hazard rather than a stylistic one: a sweep
        // driven by the narrower payment-claims export carries no documentary
        // columns at all, so every row arrived as `Evidence.Unknown` — which
        // means "this pass did not look at the file", not "the file is no
        // longer intact". Writing it flipped hasIntactEvidence to false for
        // files that were still intact, and quietly withdrew every published
        // accusation by returning it to "not evaluated".
        if (c.evidence != Evidence.Unknown) {
            a.evidence = c.evidence;
            // The registry's own feedbackHash is the documentary dimension's
            // cross-reference, so it travels with it. Zeroing it separately
            // made a checked record indistinguishable from one whose registry
            // entry attested no hash at all — the basis of EvidenceUnbound.
            a.evidenceHash = c.evidenceHash;
        }
        if (c.payment != Payment.Unknown) {
            a.payment = c.payment;
            a.amount = c.amount;
            a.paymentToken = c.paymentToken;
            a.amountDecimals = c.amountDecimals;
            a.paymentTx = c.paymentTx;
        }
        a.checkedAt = uint40(block.timestamp);
        // 0 means "not stated". Writing it over a known observation date
        // replaces information with its absence, and re-dates facts this pass
        // never re-checked.
        if (c.observedAt != 0) a.observedAt = c.observedAt;
        unchecked { a.revision += 1; }

        unchecked { totalAttestations += 1; }

        emit FeedbackAttested(
            c.agentId,
            c.clientAddress,
            c.verdict,
            c.feedbackIndex,
            a.evidence,
            a.payment,
            a.paymentTx,
            a.evidenceHash,
            a.amount,
            a.paymentToken,
            a.amountDecimals,
            a.observedAt,
            a.revision
        );
    }

    /// @notice Batch form of {attest}, for backfills and periodic sweeps.
    /// @dev    All-or-nothing: one bad claim reverts the batch rather than
    ///         writing the rest. A partially applied backfill is indistinguishable
    ///         from a complete one at read time, and the resume marker would then
    ///         record progress that did not happen.
    function attestBatch(Claim[] calldata claims) external onlyAttester {
        uint256 n = claims.length;
        if (n == 0) revert EmptyBatch();
        for (uint256 i = 0; i < n; i++) {
            attest(claims[i]);
        }
    }

    /// @dev Rungs are claims about the world, and some of them are refuted by
    ///      their own payload. A verdict saying the transaction was found while
    ///      carrying no transaction hash, or an attributed payment that moved
    ///      nothing, is not a verdict — it is a bug reaching the ledger.
    ///
    ///      Both dimensions are checked, not just the headline. `isPaymentBacked`
    ///      and `isPaymentAttributed` read the PAYMENT field, so guarding only
    ///      `verdict` left the strongest claim in the system reachable with
    ///      nothing behind it: a claim carrying `verdict: EvidenceIntact` and
    ///      `payment: Attributed` passed every check and then answered true to
    ///      `isPaymentAttributed`, with no transaction and no amount.
    function _validate(Claim calldata c) private view {
        if (c.verdict == Verdict.None) revert InvalidVerdict();
        if (c.observedAt > uint40(block.timestamp)) revert ObservationInFuture();

        // The two dimensions must agree. A headline that names a payment
        // outcome while the payment dimension says "nothing evaluated" is a
        // record whose two readers disagree about the same fact.
        Payment implied = _impliedPayment(c.verdict);
        if (implied != Payment.Unknown && c.payment != implied) revert DimensionMismatch();

        // The same rule on the documentary side. Without it a headline of
        // `EvidenceAbsent` could carry `evidence: Intact`, and hasIntactEvidence
        // then contradicted the verdict printed beside it.
        Evidence impliedEvidence = _impliedEvidence(c.verdict);
        if (impliedEvidence != Evidence.Unknown && c.evidence != impliedEvidence) revert DimensionMismatch();

        // States that assert the transaction was found must name it. `NotFound`
        // and `ForeignChain` are exempt: a malformed or unqueryable claim is
        // exactly the case where there is no well-formed hash to carry.
        if (_assertsTxExists(c.verdict) || _assertsTxExists(c.payment)) {
            if (c.paymentTx == bytes32(0)) revert MissingPaymentTx();
        }

        // An attribution with no value is a contradiction: attribution is about
        // who moved money, so nothing moved means nothing to attribute.
        if (
            (c.verdict == Verdict.PaymentAttributed || c.payment == Payment.Attributed) &&
            c.amount == 0
        ) revert IncoherentAmount();
        // An amount denominated in nothing cannot be compared to a threshold,
        // which is the only reason to publish it.
        if (c.amount != 0 && c.paymentToken == address(0)) revert IncoherentAmount();
        // …and a token with no amount is the same incoherence the other way up.
        if (c.amount == 0 && c.paymentToken != address(0)) revert IncoherentAmount();
    }

    /// @dev The payment state a headline rung implies, or `Unknown` for the
    ///      documentary rungs, which say nothing about a payment either way.
    function _impliedPayment(Verdict v) private pure returns (Payment) {
        if (v == Verdict.PaymentAttributed) return Payment.Attributed;
        if (v == Verdict.PaymentVerified) return Payment.Verified;
        if (v == Verdict.PaymentPartyMismatch) return Payment.PartyMismatch;
        if (v == Verdict.PaymentNoValue) return Payment.NoValue;
        if (v == Verdict.PaymentTxFailed) return Payment.Failed;
        if (v == Verdict.PaymentTxNotFound) return Payment.NotFound;
        if (v == Verdict.PaymentForeignChain) return Payment.ForeignChain;
        return Payment.Unknown;
    }

    /// @dev The documentary state a headline rung implies, or `Unknown` for the
    ///      payment rungs, which say nothing about the file either way — that is
    ///      exactly why the second dimension exists.
    function _impliedEvidence(Verdict v) private pure returns (Evidence) {
        if (v == Verdict.EvidenceIntact) return Evidence.Intact;
        if (v == Verdict.EvidenceUnbound) return Evidence.Unbound;
        if (v == Verdict.EvidenceUnhashed) return Evidence.Unhashed;
        if (v == Verdict.EvidenceUnreachable) return Evidence.Unreachable;
        if (v == Verdict.EvidenceInconclusive) return Evidence.Inconclusive;
        if (v == Verdict.EvidenceAbsent) return Evidence.Absent;
        return Evidence.Unknown;
    }

    function _assertsTxExists(Verdict v) private pure returns (bool) {
        return v == Verdict.PaymentVerified || v == Verdict.PaymentAttributed ||
               v == Verdict.PaymentPartyMismatch || v == Verdict.PaymentTxFailed ||
               v == Verdict.PaymentNoValue;
    }

    function _assertsTxExists(Payment p) private pure returns (bool) {
        return p == Payment.Verified || p == Payment.Attributed ||
               p == Payment.PartyMismatch || p == Payment.Failed ||
               p == Payment.NoValue;
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

    /// @notice Strictest integration surface: was this feedback paid for, by
    ///         this reviewer, to this agent?
    /// @dev    This is the question {isPaymentBacked} was assumed to answer and
    ///         did not. Use it when a payment is meant to be a barrier to entry,
    ///         because it is the only rung an adversary cannot reach by citing
    ///         somebody else's transaction.
    function isPaymentAttributed(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external view returns (bool)
    {
        return _attestations[key(agentId, clientAddress, feedbackIndex)].payment == Payment.Attributed;
    }

    /// @notice Did the transaction this feedback names actually settle?
    /// @dev    Weaker than it sounds, and deliberately kept: a settled payment
    ///         cited by a review says something happened, not that it happened
    ///         between these two parties. Anyone may name any real transfer. For
    ///         a filter rather than a signal, use {isPaymentAttributed}.
    function isPaymentBacked(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external view returns (bool)
    {
        Payment p = _attestations[key(agentId, clientAddress, feedbackIndex)].payment;
        return p == Payment.Attributed || p == Payment.Verified;
    }

    /// @notice An attributed payment of at least `minAmount` of `token`.
    /// @dev    `movedValue` has no floor, so a transfer of one millionth of a
    ///         dollar reaches the same rung as a five-hundred-dollar settlement.
    ///         Publishing the amount lets a consumer set its own floor in the
    ///         same call rather than trusting the rung to imply one.
    function isPaymentAttributedAtLeast(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        uint96 minAmount,
        address token
    ) external view returns (bool) {
        Attestation storage a = _attestations[key(agentId, clientAddress, feedbackIndex)];
        return a.payment == Payment.Attributed && a.amount >= minAmount && a.paymentToken == token;
    }

    /// @notice Did the evidence file resolve and match the hash attested for it?
    /// @dev    Answers only about the file. v2 also returned true for
    ///         `PaymentVerified`, which asserts nothing about any file, so a
    ///         router filtering on this held a document guarantee it had not
    ///         been given. The two questions are now asked separately.
    function hasIntactEvidence(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external view returns (bool)
    {
        return _attestations[key(agentId, clientAddress, feedbackIndex)].evidence == Evidence.Intact;
    }

    /// @notice The documentary dimension on its own.
    function evidenceOf(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external view returns (Evidence)
    {
        return _attestations[key(agentId, clientAddress, feedbackIndex)].evidence;
    }

    /// @notice The payment dimension on its own.
    function paymentOf(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external view returns (Payment)
    {
        return _attestations[key(agentId, clientAddress, feedbackIndex)].payment;
    }
}
