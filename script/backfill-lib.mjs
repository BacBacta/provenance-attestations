/**
 * Pure logic of the backfill, kept separate from I/O so it can be tested —
 * this code decides what gets written to mainnet, which is exactly the code
 * that must not be trusted untested.
 */

/** Minimal parser for the audit's claims.csv (every field double-quoted). */
export function parseClaimsCsv(text) {
  const lines = text.split('\n').filter(Boolean)
  const header = splitRow(lines[0])
  return lines.slice(1).map((line) => {
    const cells = splitRow(line)
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']))
  })
}

function splitRow(line) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

export const Verdict = {
  None: 0, PaymentVerified: 1, TxNotFound: 2, TxFailed: 3, NoValueMoved: 4, EvidenceUnreachable: 5,
}

/**
 * Map one audited claim to its on-chain verdict.
 *
 * The order matters: a verified payment wins outright; a transaction that was
 * never found (or a malformed hash — same epistemic state: nothing checkable
 * at that reference) is TxNotFound; an existing transaction that moved nothing
 * relevant is NoValueMoved; what remains is an existing transaction that
 * failed.
 */
export function verdictOf(row) {
  if (row.paymentVerified === 'true') return Verdict.PaymentVerified
  if (row.txExistsOnCelo !== 'true') return Verdict.TxNotFound
  const note = (row.note ?? '').toLowerCase()
  if (note.includes('transfer of zero') || note.includes('no stablecoin')) return Verdict.NoValueMoved
  return Verdict.TxFailed
}

const WELL_FORMED = /^0x[0-9a-fA-F]{64}$/

export function paymentTxOf(row) {
  return WELL_FORMED.test(row.claimTxHash) ? row.claimTxHash.toLowerCase() : '0x' + '00'.repeat(32)
}

/**
 * The registry keys feedback by (agentId, clientAddress, feedbackIndex), but
 * claims.csv does not carry feedbackIndex — it is recovered by joining against
 * the audit's event cache on (agentId, reviewer, feedbackURI), which is unique
 * per record because the URI embeds a per-file timestamp.
 */
export function indexCache(cacheLines) {
  const map = new Map()
  for (const line of cacheLines) {
    const o = JSON.parse(line)
    const a = o.args ?? {}
    const agentId = big(a.agentId)
    const reviewer = String(a.clientAddress ?? '').toLowerCase()
    const uri = String(a.feedbackURI ?? '')
    map.set(`${agentId}|${reviewer}|${uri}`, {
      feedbackIndex: big(a.feedbackIndex),
      evidenceHash: String(a.feedbackHash ?? '0x' + '00'.repeat(32)),
    })
  }
  return map
}

function big(v) {
  if (v && typeof v === 'object' && v.__bigint) return BigInt(v.__bigint)
  return BigInt(v ?? 0)
}

/** Join claims to cache; returns { rows, missing } — missing must be reported, never dropped silently. */
export function buildAttestations(claims, cacheIndex) {
  const rows = []
  const missing = []
  for (const c of claims) {
    const key = `${BigInt(c.agentId)}|${c.reviewer.toLowerCase()}|${c.feedbackURI}`
    const hit = cacheIndex.get(key)
    if (!hit) { missing.push(c); continue }
    rows.push({
      agentId: BigInt(c.agentId),
      clientAddress: c.reviewer.toLowerCase(),
      feedbackIndex: hit.feedbackIndex,
      verdict: verdictOf(c),
      paymentTx: paymentTxOf(c),
      evidenceHash: hit.evidenceHash,
    })
  }
  return { rows, missing }
}

export function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
