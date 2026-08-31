/**
 * The consumer's view of the ledger.
 *
 * The decision under test is the three-way standing, because it is the one a
 * reader gets wrong by default. `getAttestation` returns None both for a record
 * the attester looked at and said nothing about, and for a record in a range
 * the attester never claimed to have swept. Collapsing those is the misreading
 * this module exists to prevent, so every test below is about keeping them
 * apart — including the case where the silence is explained by the registry
 * event the reader already holds.
 */
import assert from 'node:assert/strict'
import {
  standingOf, derivableFromRegistry, summarise, STANDING, EVIDENCE_NAMES, PAYMENT_NAMES,
} from '../script/ledger.mjs'
import { Verdict, Evidence, Payment } from '../script/backfill-lib.mjs'

let passed = 0
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}`); throw e }
}

const ZERO32 = `0x${'0'.repeat(64)}`
const HASH = `0x${'ab'.repeat(32)}`
const none = { verdict: 0, evidence: 0, payment: 0, revision: 0 }
const written = {
  verdict: Verdict.EvidenceIntact, evidence: Evidence.Intact, payment: Payment.NotDeclared,
  revision: 1, evidenceObservedAt: 1_788_104_773, evidenceHash: HASH, paymentTx: ZERO32,
  amount: 0n, paymentToken: `0x${'0'.repeat(40)}`, amountDecimals: 0,
}

check('a written verdict reads as attested, with its rungs named', () => {
  const r = standingOf({ attestation: written, withinSweep: true, record: {} })
  assert.equal(r.standing, STANDING.ATTESTED)
  assert.equal(r.verdict, 'EvidenceIntact')
  assert.equal(r.evidence, 'Intact')
  assert.equal(r.payment, 'NotDeclared')
  assert.equal(r.revision, 1)
})

check('silence inside a sweep is not the same answer as silence outside one', () => {
  // The entire point. Both return None from the contract.
  const inside = standingOf({ attestation: none, withinSweep: true, record: {} })
  const outside = standingOf({ attestation: none, withinSweep: false, record: {} })
  assert.equal(inside.standing, STANDING.SILENT)
  assert.equal(outside.standing, STANDING.UNCOVERED)
  assert.notEqual(inside.standing, outside.standing)
  assert.ok(inside.why.includes('wrote nothing'), inside.why)
  assert.ok(outside.why.includes('never claimed to look'), outside.why)
})

check('an attested record is attested whether or not a sweep covers it', () => {
  // A verdict on chain is a fact about the record. Coverage answers a different
  // question — what the attester claims to have examined — and cannot unwrite
  // an attestation. A reader that required both would drop real verdicts.
  const r = standingOf({ attestation: written, withinSweep: false, record: {} })
  assert.equal(r.standing, STANDING.ATTESTED)
})

check('silence the registry itself explains is labelled, not counted against the attester', () => {
  // The 9,628 rows SKIP_ABSENT omitted. They read None inside a claimed sweep,
  // which looks exactly like ducking the question; the answer is in the event.
  const derivable = { feedbackURI: '', feedbackHash: HASH }
  const r = standingOf({ attestation: none, withinSweep: true, record: derivable })
  assert.equal(r.standing, STANDING.SILENT)
  assert.equal(r.derivable, 'EvidenceAbsent')
  assert.ok(r.why.includes('registry event decides'), r.why)
})

check('the derivable predicate is the registry one, both ways', () => {
  assert.equal(derivableFromRegistry({ feedbackURI: '', feedbackHash: HASH }), 'EvidenceAbsent')
  // A URI means the file could be fetched, so the rung is not derivable.
  assert.equal(derivableFromRegistry({ feedbackURI: 'https://x/y.json', feedbackHash: HASH }), null)
  // No hash either: nothing was claimed at all, and this never reached the export.
  assert.equal(derivableFromRegistry({ feedbackURI: '', feedbackHash: ZERO32 }), null)
  // Missing fields are unknown, not false — the caller simply did not supply them.
  assert.equal(derivableFromRegistry({}), null)
  assert.equal(derivableFromRegistry(undefined), null)
})

check('a record without registry fields is silent but not claimed derivable', () => {
  const r = standingOf({ attestation: none, withinSweep: true, record: {} })
  assert.equal(r.standing, STANDING.SILENT)
  assert.equal(r.derivable, null)
  assert.ok(!r.why.includes('registry event decides'))
})

check('revision 0 is the test for silence, not a zero verdict', () => {
  // Verdict.None is 0 and so is an unwritten slot. A record attested AS None
  // would be indistinguishable by verdict alone; revision counts real writes.
  const attestedNone = { ...none, revision: 3 }
  assert.equal(standingOf({ attestation: attestedNone, withinSweep: true, record: {} }).standing, STANDING.ATTESTED)
  assert.equal(standingOf({ attestation: none, withinSweep: true, record: {} }).standing, STANDING.SILENT)
})

check('the enum tables match the contract, including the appended NotDeclared', () => {
  assert.equal(EVIDENCE_NAMES[Evidence.Intact], 'Intact')
  assert.equal(EVIDENCE_NAMES[6], 'Absent')
  assert.equal(PAYMENT_NAMES[Payment.Attributed], 'Attributed')
  assert.equal(PAYMENT_NAMES[8], 'NotDeclared')
  // Append-only discipline: 0 must stay Unknown in both dimensions.
  assert.equal(EVIDENCE_NAMES[0], 'Unknown')
  assert.equal(PAYMENT_NAMES[0], 'Unknown')
})

check('the summary separates explained silence from unexplained', () => {
  const rows = [
    standingOf({ attestation: written, withinSweep: true, record: {} }),
    standingOf({ attestation: written, withinSweep: true, record: {} }),
    standingOf({ attestation: none, withinSweep: true, record: { feedbackURI: '', feedbackHash: HASH } }),
    standingOf({ attestation: none, withinSweep: true, record: {} }),
    standingOf({ attestation: none, withinSweep: false, record: {} }),
  ]
  const s = summarise(rows)
  assert.equal(s.total, 5)
  assert.equal(s.attested, 2)
  assert.equal(s.silent, 2)
  assert.equal(s.silentDerivable, 1, 'one of the two silences is explained by the registry')
  assert.equal(s.uncovered, 1)
  assert.equal(s.verdicts.EvidenceIntact, 2)
  // The counts must partition the rows; a reader adding them up must get the total.
  assert.equal(s.attested + s.silent + s.uncovered + s.other, s.total)
})

console.log(`\n${passed} passed\n`)
