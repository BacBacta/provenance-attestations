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
}

export const VERDICT_NAMES = Object.fromEntries(Object.entries(Verdict).map(([k, v]) => [v, k]))

/** Rungs that assert the transaction was found, so must carry its hash. */
const ASSERTS_TX_EXISTS = new Set([
  Verdict.PaymentVerified,
  Verdict.PaymentAttributed,
  Verdict.PaymentPartyMismatch,
  Verdict.PaymentTxFailed,
  Verdict.PaymentNoValue,
])

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
export function verdictOf(row) {
  if (row.rung && Verdict[row.rung] !== undefined) return Verdict[row.rung]

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
  if (row.evidenceRung && Evidence[row.evidenceRung] !== undefined) return Evidence[row.evidenceRung]
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
export function paymentOf(row, verdict) {
  return PAYMENT_OF_VERDICT[verdict] ?? Payment.Unknown
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
export function parseUint(value, label) {
  const raw = String(value ?? '').trim()
  if (!/^\d+$/.test(raw)) throw new Error(`${label} is not an unsigned integer: ${JSON.stringify(raw)}`)
  return BigInt(raw)
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
        feedbackIndex = parseUint(c.feedbackIndex, 'feedbackIndex')
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
    const payment = paymentOf(c, verdict)
    const paymentTx = paymentTxOf(c)
    const amount = payment === Payment.Unknown ? 0n : amountOf(c)
    const token = (c.token ?? '').trim()
    const paymentToken = amount > 0n && ADDRESS.test(token) ? token.toLowerCase() : ZERO_ADDRESS
    const decimals = Number((c.decimals ?? '').trim() || 0)

    /**
     * Refuse claims the contract itself would reject, here rather than at the
     * 74th batch. `verdictOf` and `paymentTxOf` read independent columns and
     * nothing used to reconcile them, so a rung asserting the transaction was
     * found could be paired with a zero hash.
     */
    const problem = incoherence({ verdict, paymentTx, amount, paymentToken })
    if (problem) {
      rejected.push({ row: i + 2, reason: problem, claim: c })
      continue
    }

    const claim = {
      agentId,
      clientAddress,
      feedbackIndex,
      verdict,
      evidence: evidenceOf(c),
      payment,
      paymentTx,
      evidenceHash: evidenceHash ?? ZERO32,
      amount: amount > 0n && paymentToken !== ZERO_ADDRESS ? amount : 0n,
      paymentToken: amount > 0n && paymentToken !== ZERO_ADDRESS ? paymentToken : ZERO_ADDRESS,
      amountDecimals: Number.isInteger(decimals) && decimals >= 0 && decimals < 256 ? decimals : 0,
      observedAt: observedAtOf(c),
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
      txUsers.get(paymentTx).push({ agentId: agentId.toString(), reviewer: clientAddress, feedbackIndex })
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
    .filter(([, users]) => users.length > 1)
    .map(([tx, users]) => ({ tx, users }))
    .sort((a, b) => b.users.length - a.users.length)

  return { rows, missing, rejected, duplicateTxs, cacheCollisions }
}

/** The contract's own invariants, checked before a batch is ever assembled. */
export function incoherence({ verdict, paymentTx, amount, paymentToken }) {
  if (verdict === Verdict.None) return 'verdict None can never be written'
  if (ASSERTS_TX_EXISTS.has(verdict) && paymentTx === ZERO32) {
    return `${VERDICT_NAMES[verdict]} asserts the transaction was found but carries no hash`
  }
  if (verdict === Verdict.PaymentAttributed && amount === 0n) {
    return 'PaymentAttributed with no amount: attribution is about who moved money'
  }
  if (amount > 0n && paymentToken === ZERO_ADDRESS) {
    return 'an amount denominated in no token cannot be compared to a threshold'
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
  // The contract rejects an observation dated after the block recording it.
  const now = Math.floor(Date.now() / 1000)
  return secs > now ? now : Math.max(0, secs)
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
    feed(`${r.agentId}|${r.clientAddress}|${r.feedbackIndex}|${r.verdict}|${r.evidence}|${r.payment}|${r.paymentTx}|${r.evidenceHash}|${r.amount}|${r.paymentToken};`)
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
