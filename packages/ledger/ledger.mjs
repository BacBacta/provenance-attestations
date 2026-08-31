/**
 * Read the attestation ledger the way a consumer should, not the way the
 * contract stores it.
 *
 * The contract answers one question per record and answers it honestly, but the
 * honest answer is ambiguous in a way that will mislead anyone who reads it
 * straight. `getAttestation` returns `None` for a record nobody attested — and
 * `None` means two entirely different things:
 *
 *   the record's block sits inside a standing sweep, so the attester DID claim
 *   to look at that range and wrote nothing about this record; or
 *
 *   the record's block sits outside every standing sweep, so the attester never
 *   claimed to look at all.
 *
 * A consumer that reads both as "no evidence" is misled in one direction; one
 * that reads both as "not checked yet" is misled in the other. The whole reason
 * `commitSweep` exists is to make the difference answerable, and nothing in the
 * per-record read surface makes it hard to ignore. This module does.
 *
 * There is a third case, and it is the one most likely to be misread. The first
 * backfill deliberately omitted 9,628 records whose rung is derivable from the
 * registry event alone — `feedbackURI == "" && feedbackHash != 0`. Those read
 * `None` inside a claimed sweep, which looks exactly like the attester ducking
 * a question. It is not: the answer is in the event the reader already has. So
 * when the caller supplies the registry fields, silence that the registry
 * itself explains is labelled as such rather than counted against the attester.
 */
import { VERDICT_NAMES, EVIDENCE_NAMES, PAYMENT_NAMES } from './enums.mjs'

/**
 * What the ledger says about one record.
 *
 *   attested   a verdict is on chain
 *   silent     inside a standing sweep, and nothing was written
 *   uncovered  outside every standing sweep — the attester never claimed to look
 */
export const STANDING = { ATTESTED: 'attested', SILENT: 'silent', UNCOVERED: 'uncovered' }

const ZERO32 = `0x${'0'.repeat(64)}`

/**
 * Does the registry event alone decide this record's documentary rung?
 *
 * Pure, and deliberately expressed as the predicate the backfill used rather
 * than as "was it in the skipped set": a reader with the event can check it
 * without trusting anyone's list.
 */
export function derivableFromRegistry(record) {
  if (record?.feedbackURI === undefined || record?.feedbackHash === undefined) return null
  const noUri = String(record.feedbackURI ?? '') === ''
  const hasHash = String(record.feedbackHash ?? ZERO32).toLowerCase() !== ZERO32
  return noUri && hasHash ? 'EvidenceAbsent' : null
}

/**
 * Resolve one record's standing from what was read.
 *
 * Pure, so the three-way decision — the thing this module exists for — is
 * testable without a chain. `withinSweep` is the contract's own answer for the
 * record's block; `attestation` is whatever getAttestation returned.
 */
export function standingOf({ attestation, withinSweep, record }) {
  const revision = Number(attestation?.revision ?? 0)
  if (revision > 0) {
    return {
      standing: STANDING.ATTESTED,
      verdict: VERDICT_NAMES[Number(attestation.verdict)] ?? String(attestation.verdict),
      evidence: EVIDENCE_NAMES[Number(attestation.evidence)] ?? String(attestation.evidence),
      payment: PAYMENT_NAMES[Number(attestation.payment)] ?? String(attestation.payment),
      revision,
      observedAt: Number(attestation.evidenceObservedAt ?? 0),
      evidenceHash: attestation.evidenceHash ?? ZERO32,
      paymentTx: attestation.paymentTx ?? ZERO32,
      amount: attestation.amount ?? 0n,
      paymentToken: attestation.paymentToken ?? `0x${'0'.repeat(40)}`,
      amountDecimals: Number(attestation.amountDecimals ?? 0),
      derivable: null,
    }
  }
  if (!withinSweep) {
    return {
      standing: STANDING.UNCOVERED,
      verdict: null, evidence: null, payment: null, revision: 0,
      derivable: null,
      why: 'no standing sweep covers this block; the attester never claimed to look here',
    }
  }
  const derivable = derivableFromRegistry(record)
  return {
    standing: STANDING.SILENT,
    verdict: null, evidence: null, payment: null, revision: 0,
    derivable,
    why: derivable
      ? `inside a claimed sweep and deliberately not written: the registry event decides this record (${derivable})`
      : 'inside a claimed sweep, and the attester wrote nothing about this record',
  }
}

/**
 * Read a batch of records against a deployed ledger.
 *
 * `client` is a viem public client, `contract` is { address, abi }. Records
 * need agentId, clientAddress and feedbackIndex; supplying blockNumber lets the
 * uncovered case be answered, and feedbackURI/feedbackHash let derivable
 * silence be named. Anything missing degrades the answer rather than inventing
 * one — a record with no blockNumber cannot be told apart from an uncovered
 * one, so it is reported as unknown coverage instead of guessed.
 */
export async function readLedger(client, contract, records) {
  const calls = []
  for (const r of records) {
    calls.push({ ...contract, functionName: 'getAttestation', args: [BigInt(r.agentId), r.clientAddress, BigInt(r.feedbackIndex)] })
  }
  const blocks = [...new Set(records.filter((r) => r.blockNumber !== undefined).map((r) => String(r.blockNumber)))]
  for (const b of blocks) calls.push({ ...contract, functionName: 'isWithinSweep', args: [BigInt(b)] })

  const results = await client.multicall({ contracts: calls, allowFailure: true })
  const withinByBlock = new Map()
  blocks.forEach((b, i) => {
    const res = results[records.length + i]
    withinByBlock.set(b, res.status === 'success' ? res.result : null)
  })

  return records.map((r, i) => {
    const res = results[i]
    const attestation = res.status === 'success' ? res.result : null
    const within = r.blockNumber === undefined ? null : withinByBlock.get(String(r.blockNumber))
    if (res.status !== 'success') {
      return { ...r, standing: 'unreadable', why: String(res.error?.shortMessage ?? res.error?.message ?? 'call failed') }
    }
    if (within === null) {
      const revision = Number(attestation.revision ?? 0)
      if (revision > 0) return { ...r, ...standingOf({ attestation, withinSweep: true, record: r }) }
      return {
        ...r, standing: 'unknown-coverage', verdict: null, evidence: null, payment: null, revision: 0,
        why: 'no block number supplied, so silence cannot be told apart from never having been looked at',
      }
    }
    return { ...r, ...standingOf({ attestation, withinSweep: within, record: r }) }
  })
}

/** Counts by standing, and within `attested`, by rung. */
export function summarise(rows) {
  const out = { total: rows.length, attested: 0, silent: 0, silentDerivable: 0, uncovered: 0, other: 0, verdicts: {} }
  for (const r of rows) {
    if (r.standing === STANDING.ATTESTED) {
      out.attested++
      out.verdicts[r.verdict] = (out.verdicts[r.verdict] ?? 0) + 1
    } else if (r.standing === STANDING.SILENT) {
      out.silent++
      if (r.derivable) out.silentDerivable++
    } else if (r.standing === STANDING.UNCOVERED) out.uncovered++
    else out.other++
  }
  return out
}
