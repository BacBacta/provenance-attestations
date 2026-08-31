/**
 * Pure logic of the backfill, kept separate from I/O so it can be tested —
 * this code decides what gets written to mainnet, which is exactly the code
 * that must not be trusted untested.
 */
import { parseCsvStrict } from './csv.mjs'

/**
 * Read the audit's export.
 *
 * The parser is the shared one, not a local split: the previous implementation
 * cut the text on newlines BEFORE interpreting quotes, so a `feedbackURI`
 * containing a newline — a string the reviewer writes on chain, and therefore
 * chooses — tore its row in half and left a forged one behind it. Rows whose
 * cell count does not match the header are returned separately rather than
 * padded out, because padding is how a truncated row becomes a plausible record.
 */
export function parseClaimsCsv(text) {
  return parseCsvStrict(text).rows
}

export function parseClaimsCsvStrict(text) {
  return parseCsvStrict(text)
}

/** Mirrors the on-chain enum exactly. Names are the contract's, not ours. */
/**
 * Verdicts and payment states under which a cited transaction CREDITS the row.
 *
 * Everything else that names a transaction is making a statement about the
 * citation rather than being vouched for by it.
 */
export const Verdict = {
  None: 0,
  PaymentVerified: 1,
  EvidenceIntact: 2,
  EvidenceUnbound: 3,
  EvidenceUnhashed: 4,
  PaymentTxNotFound: 5,
  PaymentTxFailed: 6,
  PaymentNoValue: 7,
  EvidenceUnreachable: 8,
  EvidenceAbsent: 9,
  PaymentAttributed: 10,
  PaymentPartyMismatch: 11,
  PaymentForeignChain: 12,
  EvidenceInconclusive: 13,
}

/** The documentary dimension, recorded alongside the headline verdict. */
export const Evidence = {
  Unknown: 0,
  Intact: 1,
  Unbound: 2,
  Unhashed: 3,
  Unreachable: 4,
  Inconclusive: 5,
  Absent: 6,
}

/**
 * The payment dimension. `Unknown` is not "no payment" — it means this pass had
 * nothing to say, and the contract preserves whatever it already knew. A
 * settled transfer must not be erased by a later pass that could no longer read
 * the file naming it.
 */
export const Payment = {
  Unknown: 0,
  Attributed: 1,
  Verified: 2,
  PartyMismatch: 3,
  NoValue: 4,
  Failed: 5,
  NotFound: 6,
  ForeignChain: 7,
  NotDeclared: 8,
}

/**
 * Verdicts and payment states under which a cited transaction CREDITS the row.
 *
 * Everything else that names a transaction is making a statement ABOUT the
 * citation — that it does not exist, that its parties are other people — which
 * is independently true for every review that makes it.
 */
const CREDITS_PAYMENT = new Set([Verdict.PaymentVerified, Verdict.PaymentAttributed])
const CREDITS_PAYMENT_DIM = new Set([Payment.Verified, Payment.Attributed])

export const VERDICT_NAMES = Object.fromEntries(Object.entries(Verdict).map(([k, v]) => [v, k]))

/** Rungs that assert the transaction was found, so must carry its hash. */
const ASSERTS_TX_EXISTS = new Set([
  Verdict.PaymentVerified,
  Verdict.PaymentAttributed,
  Verdict.PaymentPartyMismatch,
  Verdict.PaymentTxFailed,
  Verdict.PaymentNoValue,
])

/**
 * The same rule read off the PAYMENT dimension.
 *
 * `_validate` overloads `_assertsTxExists` for both enums; this side checked
 * only the headline, so a documentary verdict carrying `payment: Verified`
 * with a zero hash passed here and reverted the batch on chain.
 */
const PAYMENT_ASSERTS_TX = new Set([
  Payment.Verified, Payment.Attributed, Payment.PartyMismatch,
  Payment.Failed, Payment.NoValue,
])

/**
 * Which documentary state each headline rung implies.
 *
 * The contract enforces this, so a claim that breaks it reverts the whole batch
 * — mid-spend, after earlier batches have been paid for. Checking it here means
 * the run stops at validation instead.
 */
const EVIDENCE_OF_VERDICT = {
  [Verdict.EvidenceIntact]: Evidence.Intact,
  [Verdict.EvidenceUnbound]: Evidence.Unbound,
  [Verdict.EvidenceUnhashed]: Evidence.Unhashed,
  [Verdict.EvidenceUnreachable]: Evidence.Unreachable,
  [Verdict.EvidenceInconclusive]: Evidence.Inconclusive,
  [Verdict.EvidenceAbsent]: Evidence.Absent,
}

/** Which payment state each headline rung implies. */
const PAYMENT_OF_VERDICT = {
  [Verdict.PaymentAttributed]: Payment.Attributed,
  [Verdict.PaymentVerified]: Payment.Verified,
  [Verdict.PaymentPartyMismatch]: Payment.PartyMismatch,
  [Verdict.PaymentNoValue]: Payment.NoValue,
  [Verdict.PaymentTxFailed]: Payment.Failed,
  [Verdict.PaymentTxNotFound]: Payment.NotFound,
  [Verdict.PaymentForeignChain]: Payment.ForeignChain,
}

/**
 * Map one audited row to its on-chain verdict.
 *
 * The audit already names the rung it reached, in the contract's own
 * vocabulary — so the safe path is to trust that name rather than re-derive it
 * here from booleans. Two implementations of the same ladder would eventually
 * disagree, and the disagreement would be invisible.
 *
 * The boolean fallback exists only for the older claims.csv, which predates the
 * `rung` column. Its note-matching is deliberately identical to the audit's
 * (`includes('zero')`, not `includes('transfer of zero')`): the two used to
 * differ by exactly that, which is the drift this comment is about.
 */
/**
 * A name is only a rung if this object actually declares it.
 *
 * `Verdict[row.rung]` reaches the prototype chain, so a CSV naming a rung of
 * 'constructor' or 'toString' resolved to a function, which is neither
 * undefined nor a number and passed straight through every later check.
 */
const own = (table, name) =>
  typeof name === 'string' && Object.prototype.hasOwnProperty.call(table, name)
    ? table[name]
    : undefined

/**
 * The rung an export uses for a record it never opened.
 *
 * Not a verdict, and deliberately not spelled like one. The fetch cap left
 * 8,724 of 10,469 declared files unopened and the export called every one of
 * them `EvidenceInconclusive` — "we tried and learned nothing", a statement
 * about the record made by a run that had not tried. On chain that is a
 * retrieval failure published against 8,724 publishers nobody contacted, in a
 * ledger whose entire claim is that its verdicts were checked.
 */
export const NOT_CHECKED = 'NotChecked'

/**
 * @returns the on-chain verdict for this row, or `null` when the row is not
 *          something to attest at all.
 */
export function verdictOf(row) {
  /**
   * Before anything else, including the boolean fallback below — which would
   * otherwise read `hasURI && !fetched` as EvidenceUnreachable, "a host
   * answered that the file is gone". That is a worse lie than the first one.
   */
  if (row.rung === NOT_CHECKED) return null

  const named = own(Verdict, row.rung)
  if (named !== undefined) return named

  if (row.paymentAttributed === 'true') return Verdict.PaymentAttributed
  if (row.paymentVerified === 'true') {
    return row.partiesContradicted === 'true' ? Verdict.PaymentPartyMismatch : Verdict.PaymentVerified
  }
  if (row.claimsPayment === 'true' || row.claimTxHash) {
    if (row.onQueryableChain === 'false') return Verdict.PaymentForeignChain
    if (row.txExistsOnCelo !== 'true') return Verdict.PaymentTxNotFound
    const note = (row.note ?? '').toLowerCase()
    if (note.includes('zero') || note.includes('no stablecoin')) return Verdict.PaymentNoValue
    return Verdict.PaymentTxFailed
  }
  if (row.fetched === 'true') return row.hashMatched === 'true' ? Verdict.EvidenceIntact : Verdict.EvidenceUnhashed
  if (row.inconclusive === 'true') return Verdict.EvidenceInconclusive
  return row.hasURI === 'true' ? Verdict.EvidenceUnreachable : Verdict.EvidenceAbsent
}

/**
 * The documentary dimension, which the headline verdict masks whenever a
 * payment outranks it. Recorded separately so a consumer can ask "settled AND
 * intact" instead of guessing which question the one verdict answered.
 */
export function evidenceOf(row) {
  if (row.evidenceRung === NOT_CHECKED) return Evidence.Unknown
  const named = own(Evidence, row.evidenceRung)
  if (named !== undefined) return named
  if (row.fetched === 'true' && row.jsonValid !== 'false') {
    if (row.evidenceHash && /^0x0*$/.test(row.evidenceHash)) return Evidence.Unbound
    return row.hashMatched === 'true' ? Evidence.Intact : Evidence.Unhashed
  }
  if (row.inconclusive === 'true') return Evidence.Inconclusive
  if (row.hasURI === 'true') return Evidence.Unreachable
  if (row.hasURI === 'false') return Evidence.Absent
  return Evidence.Unknown
}

/** The payment dimension implied by the row's rung; Unknown when it says nothing. */
/**
 * The payment dimension for one row.
 *
 * A verdict that names a payment outcome fixes it. For everything else the
 * question is which of two very different things "no payment state" means, and
 * the row can answer it: if the file was retrieved and parsed and declares no
 * payment, that is a finding — `NotDeclared` — not an absence. Leaving it at
 * `Unknown` put an honest review that claims nothing in the same bucket as a
 * record nobody has evaluated yet, and, downstream, in the same bucket as the
 * 76 declared payments that are not on this chain.
 *
 * Anything less certain stays `Unknown`. A file we could not read may well
 * declare a payment; saying it does not would be an accusation built on our
 * own retrieval failure, which is the mistake this pipeline exists to avoid.
 */
export function paymentOf(row, verdict) {
  const implied = PAYMENT_OF_VERDICT[verdict]
  if (implied !== undefined) return implied

  /**
   * `NotDeclared` may only be said about bytes that ARE the document.
   *
   * It asserts on chain that the reviewer's file names no payment, and unlike
   * `Unknown` it OVERWRITES — including over an attributed payment already
   * published. Deciding it on "fetched and parsed" alone meant a 200 whose
   * keccak does not match the attested feedbackHash could carry it: somebody
   * else's file, or today's version of one that has since changed. The
   * pipeline knows the difference and publishes it in the same row as
   * EvidenceUnhashed — so requiring the binding costs nothing and is the
   * whole difference between an observation and an accusation.
   */
  const isTheDocument = row.fetched === 'true' && row.jsonValid === 'true' && row.hashMatched === 'true'
  if (!isTheDocument) return Payment.Unknown

  /**
   * And never against the row's own evidence. A transaction hash present, or
   * `claimsPayment` true, means the pipeline saw a claim — whatever else the
   * row says. Any disagreement between those columns is a reason to stay
   * silent, not to publish the more damaging reading.
   */
  if (row.claimsPayment !== 'false') return Payment.Unknown
  if ((row.claimTxHash ?? '').trim()) return Payment.Unknown

  /**
   * And never when the audit says it saw a proof field it could not read.
   *
   * `proofOfPayment` arrives as a bare hash string and as a list of claims in
   * the wild, and an extractor that understood neither reported "no claim" —
   * which this function then published as the reviewer's own statement that
   * their document declares no payment. Our shortfall became their permanent
   * record. Older exports have no such column; their absence reads as false,
   * which is the pre-existing behaviour and not a new assertion.
   */
  if (row.proofPresent === 'true') return Payment.Unknown
  return Payment.NotDeclared
}

const WELL_FORMED = /^0x[0-9a-fA-F]{64}$/
const ZERO32 = '0x' + '00'.repeat(32)
const ZERO_ADDRESS = '0x' + '00'.repeat(20)

export function paymentTxOf(row) {
  return WELL_FORMED.test(row.claimTxHash ?? '') ? row.claimTxHash.toLowerCase() : ZERO32
}

/** uint96 ceiling — an amount above it would silently wrap on encoding. */
const MAX_UINT96 = (1n << 96n) - 1n

export function amountOf(row) {
  const raw = (row.amount ?? '').trim()
  if (!/^\d+$/.test(raw)) return 0n
  const v = BigInt(raw)
  return v > MAX_UINT96 ? MAX_UINT96 : v
}

/**
 * Parse an integer the CSV supplied, refusing anything that is not one.
 *
 * `BigInt(cell)` used to be called on raw CSV cells with no guard, so a single
 * torn row — which an adversarial `feedbackURI` could manufacture — threw a
 * SyntaxError that stopped the whole backfill. Bad input must fail its own row,
 * loudly, not the run.
 */
export function parseUint(value, label, bits = 256) {
  const raw = String(value ?? '').trim()
  if (!/^\d+$/.test(raw)) throw new Error(`${label} is not an unsigned integer: ${JSON.stringify(raw)}`)
  const v = BigInt(raw)
  /**
   * Width matters, not just sign. `feedbackIndex` is a uint64 on chain, so a
   * larger value encodes as something else entirely — viem throws while the
   * batch is being assembled, which means the run dies partway through the
   * spend rather than at validation, with earlier batches already paid for.
   */
  if (v >= (1n << BigInt(bits))) {
    throw new Error(`${label} does not fit in uint${bits}: ${raw}`)
  }
  return v
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function parseAddress(value, label) {
  const raw = String(value ?? '').trim()
  if (!ADDRESS.test(raw)) throw new Error(`${label} is not an address: ${JSON.stringify(raw)}`)
  return raw.toLowerCase()
}

/**
 * Index the audit's event cache by the registry's own tuple.
 *
 * WHAT WENT WRONG HERE, AND WHY THE KEY CHANGED
 *
 * This map used to be keyed on (agentId, reviewer, feedbackURI), justified by a
 * comment claiming the triple was "unique per record because the URI embeds a
 * per-file timestamp". It is not unique, in two ways that matter:
 *
 *   - the URI is written by the reviewer, so nothing stops two records sharing
 *     one; and
 *   - roughly half the registry publishes NO file at all, and every one of
 *     those records carries the same empty URI. For a reviewer with several
 *     such records against one agent, every key collided.
 *
 * `map.set` overwrote silently, so only the last feedbackIndex survived. Both
 * rows then joined — successfully — onto that one index: one record was
 * attested twice and the other was never attested at all, left reading `None`,
 * the single state this contract advertises as unforgeable. And the guard that
 * was supposed to catch this ("missing must be reported, never dropped") is
 * blind to it by construction, because a collision is a join that SUCCEEDS.
 *
 * The real fix is upstream: the audit now exports `feedbackIndex` directly, so
 * there is no join to get wrong. This cache path remains for older exports, and
 * now refuses to guess — every collision is recorded and the caller must decide.
 */
export function indexCache(cacheLines) {
  const map = new Map()
  const collisions = []
  for (const line of cacheLines) {
    const o = JSON.parse(line)
    const a = o.args ?? {}
    const agentId = big(a.agentId)
    const reviewer = String(a.clientAddress ?? '').toLowerCase()
    const uri = String(a.feedbackURI ?? '')
    const k = `${agentId}|${reviewer}|${uri}`
    const entry = {
      feedbackIndex: big(a.feedbackIndex),
      evidenceHash: String(a.feedbackHash ?? ZERO32),
    }
    const prior = map.get(k)
    if (prior) {
      if (prior.feedbackIndex !== entry.feedbackIndex) {
        collisions.push({ key: k, agentId: agentId.toString(), reviewer, uri, indexes: [prior.feedbackIndex, entry.feedbackIndex] })
      }
      continue // keep the FIRST, so the set of survivors is at least deterministic
    }
    map.set(k, entry)
  }
  return { map, collisions }
}

function big(v) {
  if (v && typeof v === 'object' && v.__bigint) return BigInt(v.__bigint)
  return BigInt(v ?? 0)
}

/**
 * Turn audited rows into claims the contract will accept.
 *
 * Returns { rows, missing, rejected, duplicateTxs }. Nothing is dropped in
 * silence: a row that cannot be joined, cannot be parsed, or contradicts itself
 * is returned in the category that explains why, and the caller must look at
 * all of them before writing anything.
 */
export function buildAttestations(claims, cache) {
  // Accept either the new cache shape { map, collisions } or a bare Map, so an
  // older caller does not silently index `undefined`.
  const cacheIndex = cache instanceof Map ? cache : cache?.map
  const cacheCollisions = cache instanceof Map ? [] : (cache?.collisions ?? [])

  const rows = []
  const missing = []
  const rejected = []
  /**
   * Rows the export deliberately says nothing about. Not an error — a sampled
   * audit must publish which records it skipped — but nothing is written on
   * chain for them, and the count is reported so "complete" never means "we
   * quietly attested a third of the registry from a stride we never opened".
   */
  const skipped = []
  const seenKeys = new Map()
  const txUsers = new Map()

  for (const [i, c] of claims.entries()) {
    let agentId
    let clientAddress
    try {
      agentId = parseUint(c.agentId, 'agentId')
      clientAddress = parseAddress(c.reviewer, 'reviewer')
    } catch (err) {
      rejected.push({ row: i + 2, reason: err.message, claim: c })
      continue
    }

    /**
     * Prefer the index the audit exported. The join below exists only for
     * older files, and is the source of the collision described in
     * {indexCache} — so when the column is present, no join happens at all.
     */
    let feedbackIndex
    let evidenceHash = /^0x[0-9a-fA-F]{64}$/.test(c.evidenceHash ?? '') ? c.evidenceHash : null

    if (c.feedbackIndex !== undefined && String(c.feedbackIndex).trim() !== '') {
      try {
        feedbackIndex = parseUint(c.feedbackIndex, 'feedbackIndex', 64)
      } catch (err) {
        rejected.push({ row: i + 2, reason: err.message, claim: c })
        continue
      }
      if (!evidenceHash) {
        const hit = cacheIndex?.get(`${agentId}|${clientAddress}|${c.feedbackURI ?? ''}`)
        evidenceHash = hit?.evidenceHash ?? ZERO32
      }
    } else {
      if (!cacheIndex) { missing.push(c); continue }
      const hit = cacheIndex.get(`${agentId}|${clientAddress}|${c.feedbackURI ?? ''}`)
      if (!hit) { missing.push(c); continue }
      feedbackIndex = hit.feedbackIndex
      if (!evidenceHash) evidenceHash = hit.evidenceHash
    }

    const verdict = verdictOf(c)
    if (verdict === null) {
      skipped.push({ row: i + 2, claim: c })
      continue
    }
    const payment = paymentOf(c, verdict)
    // `NotDeclared` asserts the document names no payment, so it must carry
    // none — the contract refuses the contradiction and this is where it would
    // otherwise be discovered, mid-spend, at the 74th batch.
    const paymentTx = payment === Payment.NotDeclared ? ZERO32 : paymentTxOf(c)
    const amount = payment === Payment.Unknown || payment === Payment.NotDeclared ? 0n : amountOf(c)
    const token = (c.token ?? '').trim()
    const paymentToken = amount > 0n && ADDRESS.test(token) ? token.toLowerCase() : ZERO_ADDRESS
    const decimals = Number((c.decimals ?? '').trim() || 0)

    /**
     * Refuse claims the contract itself would reject, here rather than at the
     * 74th batch. `verdictOf` and `paymentTxOf` read independent columns and
     * nothing used to reconcile them, so a rung asserting the transaction was
     * found could be paired with a zero hash.
     */
    const evidence = evidenceOf(c)
    // Exactly the values that go into the claim below, so the mirror checks
    // what will actually be sent rather than something adjacent to it.
    const finalHash = evidenceHash ?? ZERO32
    const finalObservedAt = observedAtOf(c)
    const problem = incoherence({
      verdict, evidence, payment, paymentTx, amount, paymentToken,
      evidenceHash: finalHash, observedAt: finalObservedAt,
    })
    if (problem) {
      rejected.push({ row: i + 2, reason: problem, claim: c })
      continue
    }

    const claim = {
      agentId,
      clientAddress,
      feedbackIndex,
      verdict,
      evidence,
      payment,
      paymentTx,
      evidenceHash: finalHash,
      amount: amount > 0n && paymentToken !== ZERO_ADDRESS ? amount : 0n,
      paymentToken: amount > 0n && paymentToken !== ZERO_ADDRESS ? paymentToken : ZERO_ADDRESS,
      amountDecimals: Number.isInteger(decimals) && decimals >= 0 && decimals < 256 ? decimals : 0,
      observedAt: finalObservedAt,
      /**
       * The block the registry wrote this record in. Not part of the on-chain
       * claim — `toClaimStruct` selects fields explicitly — but the backfill
       * needs it to check that every row it attests really falls inside the
       * range the coverage manifest claims to cover.
       */
      block: /^\d+$/.test((c.block ?? '').trim()) ? BigInt(c.block.trim()) : null,
    }

    /**
     * One tuple, one claim per run. Two rows for the same record would be two
     * writes in one backfill — double gas, a revision counter that lies about
     * how many times the record was checked, and, if they disagree, a verdict
     * decided by array order.
     */
    const tupleKey = `${agentId}|${clientAddress}|${feedbackIndex}`
    const prior = seenKeys.get(tupleKey)
    if (prior !== undefined) {
      rejected.push({
        row: i + 2,
        reason: `duplicate of row ${prior}: same (agentId, reviewer, feedbackIndex)`,
        claim: c,
      })
      continue
    }
    seenKeys.set(tupleKey, i + 2)

    if (paymentTx !== ZERO32) {
      if (!txUsers.has(paymentTx)) txUsers.set(paymentTx, [])
      txUsers.get(paymentTx).push({
        agentId: agentId.toString(), reviewer: clientAddress, feedbackIndex,
        /**
         * Whether THIS row would be credited by the transaction it cites.
         *
         * The reuse guard exists because a payment backs at most one review and
         * the ledger cannot say which. That reasoning only bites when more than
         * one of the sharers is actually being credited. A row whose verdict is
         * `PaymentTxNotFound` claims the cited transaction does not exist, and
         * `PaymentPartyMismatch` claims it exists between other parties — both
         * are statements ABOUT the citation, independently true for every
         * review that makes it, and neither vouches for anybody.
         *
         * Measured on the full export: all 23 rows sharing a transaction are 18
         * TxNotFound and 5 PartyMismatch, and none is Verified or Attributed.
         * The guard was blocking the entire backfill over citations it was
         * never written to catch.
         */
        credited: CREDITS_PAYMENT.has(claim.verdict) || CREDITS_PAYMENT_DIM.has(claim.payment),
      })
    }

    rows.push(claim)
  }

  /**
   * A transaction cited by several reviews backs at most one of them. Nothing
   * on chain or in this pipeline enforces uniqueness, so a single real payment
   * can underwrite an entire fabricated history. This does not reject the rows
   * — the reuse is a fact about the registry, and hiding it would be worse —
   * but it must reach the operator before anything is written.
   */
  const duplicateTxs = [...txUsers.entries()]
    .filter(([, users]) => users.filter((u) => u.credited).length > 1)
    .map(([tx, users]) => ({ tx, users }))
    .sort((a, b) => b.users.length - a.users.length)

  /**
   * Shared citations that credit at most one review are still reported, just
   * not as a reason to stop. They are a fact about the registry and the
   * operator should see them; they are simply not the thing the block is for.
   */
  const sharedTxs = [...txUsers.entries()]
    .filter(([, users]) => users.length > 1 && users.filter((u) => u.credited).length <= 1)
    .map(([tx, users]) => ({ tx, users }))
    .sort((a, b) => b.users.length - a.users.length)

  return { rows, missing, rejected, skipped, duplicateTxs, sharedTxs, cacheCollisions }
}

/** The contract's own invariants, checked before a batch is ever assembled. */
/**
 * The contract's own invariants, checked before a batch is ever assembled.
 *
 * This must be a MIRROR of `_validate`, not an approximation of it. It was an
 * approximation: an enumeration of Verdict x Evidence x Payment against a real
 * EVM found 253 combinations the contract rejects and this function accepted,
 * every one of which would have reverted an entire batch mid-spend, after the
 * gas for it was already paid. The test `both sides of the invariant agree, on
 * every combination there is` now runs that enumeration on every commit, so
 * the two can no longer drift.
 *
 * @returns a reason string when the contract would refuse this claim, else null
 */
export function incoherence({
  verdict, evidence, payment, paymentTx, amount, paymentToken, evidenceHash, observedAt,
}) {
  if (verdict === Verdict.None) return 'verdict None can never be written'

  // Both cross-dimension rules, in both directions.
  const impliedPayment = PAYMENT_OF_VERDICT[verdict]
  if (impliedPayment !== undefined && payment !== undefined && payment !== impliedPayment) {
    return `${VERDICT_NAMES[verdict]} implies payment state ${impliedPayment}, not ${payment}`
  }
  const impliedEvidence = EVIDENCE_OF_VERDICT[verdict]
  if (impliedEvidence !== undefined && evidence !== undefined && evidence !== impliedEvidence) {
    return `${VERDICT_NAMES[verdict]} implies evidence state ${impliedEvidence}, not ${evidence}`
  }

  // A state asserting the transaction was found must name it — from EITHER
  // dimension. Guarding only the headline left the payment field unchecked,
  // and isPaymentBacked reads the payment field.
  if ((ASSERTS_TX_EXISTS.has(verdict) || PAYMENT_ASSERTS_TX.has(payment)) && paymentTx === ZERO32) {
    return `${VERDICT_NAMES[verdict]}/payment ${payment} asserts the transaction was found but carries no hash`
  }

  // Attribution is about who moved money, so nothing moved means nothing to
  // attribute — again from either dimension.
  if ((verdict === Verdict.PaymentAttributed || payment === Payment.Attributed) && amount === 0n) {
    return 'PaymentAttributed with no amount: attribution is about who moved money'
  }
  /**
   * …and the mirror: a rung saying nothing relevant moved cannot carry a sum.
   *
   * From EITHER dimension. This read the headline alone, exactly as the
   * contract's own guard did, four lines under a comment saying the opposite —
   * so `evidence: Intact` with `payment: NoValue` and a settled amount passed
   * both validators and reached the ledger. The two-dimension model exists so
   * the payment dimension can travel under a documentary headline; a guard
   * that only reads the headline does not cover it.
   */
  if (amount !== 0n && (
    verdict === Verdict.PaymentNoValue ||
    verdict === Verdict.PaymentTxNotFound ||
    verdict === Verdict.PaymentForeignChain ||
    payment === Payment.NoValue ||
    payment === Payment.NotFound ||
    payment === Payment.ForeignChain
  )) {
    return 'a rung saying nothing settled cannot carry an amount'
  }
  if (amount !== 0n && paymentToken === ZERO_ADDRESS) {
    return 'an amount denominated in no token cannot be compared to a threshold'
  }
  if (amount === 0n && paymentToken !== ZERO_ADDRESS) {
    return 'a token with no amount is the same incoherence the other way up'
  }
  // A claim that the document names no payment cannot itself carry one.
  if (payment === Payment.NotDeclared &&
      (paymentTx !== ZERO32 || amount !== 0n || paymentToken !== ZERO_ADDRESS)) {
    return 'NotDeclared carries a payment: the row contradicts itself'
  }
  // `Intact` means the bytes matched an attested hash. With no hash there is
  // nothing they can have matched — that state is Unbound.
  if ((evidence === Evidence.Intact || verdict === Verdict.EvidenceIntact) &&
      (evidenceHash === undefined || evidenceHash === ZERO32)) {
    return 'EvidenceIntact claims a match against a hash that is not there'
  }
  /**
   * And the same for the rung that accuses instead of confirming.
   *
   * `Unhashed` says the bytes CONTRADICT an attested hash. With no hash there
   * is nothing they can have contradicted, and the row is byte-identical in
   * its hash field to `Unbound`, which means no hash was ever attested. An
   * accusation nobody can check is the one thing this ledger must not publish.
   */
  if ((evidence === Evidence.Unhashed || verdict === Verdict.EvidenceUnhashed) &&
      (evidenceHash === undefined || evidenceHash === ZERO32)) {
    return 'EvidenceUnhashed contradicts a hash that is not there'
  }
  /**
   * And `Absent`, whose definition is "a hash was attested with no file".
   *
   * The deployed v5 ACCEPTS this shape — the guard was extended to Intact and
   * Unhashed and not to Absent, and the contract is immutable, so the pipeline
   * is where it gets refused. Measured: an Absent row with a zero hash costs
   * 42,701 gas against 62,792 with the hash, which is a standing 39 CELO
   * temptation across the 9,628 rows of this class. Taking it would publish
   * "a hash was attested" in a record whose hash field reads zero —
   * byte-identical, in the field that matters, to `Unbound`, which means no
   * hash was ever attested. Cheaper is not a reason to say something else.
   *
   * This is the one place the library is deliberately stricter than the chain.
   * The integration test enumerates that divergence rather than allowing any.
   */
  if ((evidence === Evidence.Absent || verdict === Verdict.EvidenceAbsent) &&
      (evidenceHash === undefined || evidenceHash === ZERO32)) {
    return 'EvidenceAbsent says a hash was attested, so it must carry the hash'
  }
  // A dimension that is stated must say when it was looked at.
  if (observedAt !== undefined && observedAt === 0 &&
      ((evidence !== undefined && evidence !== Evidence.Unknown) ||
       (payment !== undefined && payment !== Payment.Unknown))) {
    return 'a stated dimension with no observation date behind it'
  }
  return null
}

/**
 * When the check actually ran, as opposed to when it is being written.
 *
 * `checkedAt` is the block timestamp of the write, which for a backfill is days
 * after the observation. A verdict whose only date is the day it was published
 * cannot be aged by anyone reading it.
 */
export function observedAtOf(row) {
  const raw = (row.observedAt ?? '').trim()
  if (!raw) return 0
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return 0
  const secs = Math.floor(ms / 1000)
  const now = Math.floor(Date.now() / 1000)
  /**
   * An impossible date is unknown, not "now".
   *
   * Clamping a year-2200 timestamp to the moment of the run manufactured
   * exactly the date this field exists to avoid — the write time wearing the
   * observation's name. 0 already means "not stated", and the contract reads it
   * that way. A date beyond uint40 is out of range for the same reason.
   */
  if (secs < 0 || secs > now || secs >= 2 ** 40) return 0
  return secs
}

export function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * A fingerprint of the exact rows a run is about to write.
 *
 * The resume marker used to store a COUNT OF BATCHES, and the batch size came
 * from the environment. Resuming with a different BATCH_SIZE re-cut the same
 * rows into different chunks, so "3 batches done" silently meant a different
 * set of rows than it had when it was written: rows were re-attested (paying
 * twice, inflating every revision counter) or skipped entirely, with no entry
 * in `missing` because they had joined perfectly. Progress is now counted in
 * ROWS and tied to a digest of the row set, so a changed input or a changed
 * batch size is detected instead of silently reinterpreted.
 */
export function fingerprint(rows) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const feed = (s) => {
    for (let i = 0; i < s.length; i++) {
      h1 = (Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0)
      h2 = (Math.imul(h2 + s.charCodeAt(i), 0x85ebca6b) >>> 0)
    }
  }
  for (const r of rows) {
    // Every field that reaches the chain. Two of them were missing, so a run
    // whose only change was an amount's decimals or an observation date carried
    // the previous run's fingerprint and resumed as if nothing had changed.
    feed(`${r.agentId}|${r.clientAddress}|${r.feedbackIndex}|${r.verdict}|${r.evidence}|${r.payment}|${r.paymentTx}|${r.evidenceHash}|${r.amount}|${r.paymentToken}|${r.amountDecimals}|${r.observedAt};`)
  }
  return `${rows.length}-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

/** Shape a claim for the contract's `Claim` struct, in ABI field order. */
export function toClaimStruct(r) {
  return {
    agentId: r.agentId,
    clientAddress: r.clientAddress,
    feedbackIndex: r.feedbackIndex,
    verdict: r.verdict,
    evidence: r.evidence,
    payment: r.payment,
    paymentTx: r.paymentTx,
    evidenceHash: r.evidenceHash,
    amount: r.amount,
    paymentToken: r.paymentToken,
    amountDecimals: r.amountDecimals,
    observedAt: r.observedAt,
  }
}

// The coverage tree lives in its own module, shared byte-for-byte with the
// audit that computes the root this service publishes.
export { recordKey, merkleRoot } from './coverage.mjs'

/**
 * Where a run's resume marker lives.
 *
 * One shared filename was fine while there was one backfill. The moment sweeps
 * become a series it is a trap: the marker from the completed run describes a
 * different row set, so the next run is refused — correctly — with "delete it
 * and start over". An operator who does that, and then re-runs the OLD export
 * by habit or by a stale shell, has no marker left to stop them re-attesting
 * 10,469 rows and paying for all of it a second time. The guard that existed to
 * prevent exactly that was the thing they were told to remove.
 *
 * Naming the marker after the fingerprint of its row set removes the choice.
 * Each run keeps its own; a completed run's marker is still there to say "every
 * row is already on chain" if that export is ever run again; and nothing has to
 * be deleted for the next sweep to proceed.
 *
 * `legacyExists` is asked rather than assumed so an upgrade mid-run does not
 * strand a marker: if the old shared file is the one describing THIS row set,
 * it stays authoritative for this run.
 */
export function progressPathFor({ override, fingerprint, legacyPath, legacyExists, legacyFingerprint }) {
  if (override) return { path: override, why: 'PROGRESS_FILE' }
  if (legacyExists && legacyFingerprint === fingerprint) {
    return { path: legacyPath, why: 'legacy marker for this same row set' }
  }
  return { path: legacyPath.replace(/\.json$/, `-${fingerprint}.json`), why: 'named for this row set' }
}
