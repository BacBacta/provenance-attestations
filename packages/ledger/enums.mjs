/**
 * The contract's enums, and the canonical copy of them.
 *
 * These are the on-chain values, not our names for them: the numbers are what a
 * consumer reads out of `getAttestation`, and the names are the contract's. Both
 * dimensions are append-only — a value's meaning never changes and new rungs are
 * added at the end — so a consumer that stored `2` last year still means
 * `EvidenceIntact` today.
 *
 * This file is the single source. script/backfill-lib.mjs re-exports it rather
 * than keeping its own copy: two tables that must agree and are maintained apart
 * are two tables that will eventually disagree, and the one place that would
 * show it is a verdict written under the wrong name.
 */

/**
 * The headline verdict. One slot, so for any record declaring a payment the
 * payment rungs outrank the documentary ones — which is exactly why the two
 * dimensions below exist alongside it.
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

/** The documentary dimension: what happened when the declared file was opened. */
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
 * The payment dimension. `Unknown` is not "no payment" — it means the pass had
 * nothing to say, and the contract preserves whatever it already knew. A settled
 * transfer must not be erased by a later pass that could no longer read the file
 * naming it.
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

const invert = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]))

export const VERDICT_NAMES = invert(Verdict)
export const EVIDENCE_NAMES = invert(Evidence)
export const PAYMENT_NAMES = invert(Payment)
