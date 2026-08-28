import assert from 'node:assert/strict'
import { parseClaimsCsv, verdictOf, paymentTxOf, indexCache, buildAttestations, Verdict, chunk } from '../script/backfill-lib.mjs'

let passed = 0
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}`); throw e }
}

console.log('\nbackfill logic')

const CSV = [
  '"timestamp","block","agentId","reviewer","claimNetwork","claimTxHash","txExistsOnCelo","paymentVerified","note","feedbackURI"',
  '"2026-08-20T17:34:44Z","73000001","9742","0xAAA0000000000000000000000000000000000001","celo","0x' + '11'.repeat(32) + '","true","true","","https://x.example/a.json"',
  '"2026-08-20T17:35:00Z","73000002","9742","0xAAA0000000000000000000000000000000000001","celo","0x' + '22'.repeat(32) + '","false","false","transaction not found on chain","https://x.example/b.json"',
  '"2026-08-20T17:36:00Z","73000003","9700","0xAAA0000000000000000000000000000000000002","celo","0x' + '33'.repeat(32) + '","true","false","transfer of zero","https://x.example/c, with comma.json"',
  '"2026-08-20T17:37:00Z","73000004","9700","0xAAA0000000000000000000000000000000000002","celo","not-a-hash","false","false","malformed transaction hash","https://x.example/d.json"',
].join('\n')

check('CSV parsing survives quoted commas and yields named fields', () => {
  const rows = parseClaimsCsv(CSV)
  assert.equal(rows.length, 4)
  assert.equal(rows[0].agentId, '9742')
  assert.equal(rows[2].feedbackURI, 'https://x.example/c, with comma.json')
})

check('the legacy claims file still maps correctly without a rung column', () => {
  const [ok, notFound, zero, malformed] = parseClaimsCsv(CSV)
  assert.equal(verdictOf(ok), Verdict.PaymentVerified)
  assert.equal(verdictOf(notFound), Verdict.PaymentTxNotFound)
  assert.equal(verdictOf(zero), Verdict.PaymentNoValue)
  assert.equal(verdictOf(malformed), Verdict.PaymentTxNotFound)
})

check('when the audit names the rung, that name wins over re-derivation', () => {
  // One ladder, defined once in the audit. Two implementations would drift.
  assert.equal(verdictOf({ rung: 'EvidenceIntact' }), Verdict.EvidenceIntact)
  assert.equal(verdictOf({ rung: 'EvidenceAbsent' }), Verdict.EvidenceAbsent)
  assert.equal(verdictOf({ rung: 'PaymentVerified', paymentVerified: 'false' }), Verdict.PaymentVerified)
})

check('an unknown rung falls through to the booleans rather than writing garbage', () => {
  assert.equal(verdictOf({ rung: 'SomethingNew', fetched: 'true', hashMatched: 'true' }), Verdict.EvidenceIntact)
})

check('the non-payment rungs are reachable from booleans alone', () => {
  assert.equal(verdictOf({ fetched: 'true', hashMatched: 'true' }), Verdict.EvidenceIntact)
  assert.equal(verdictOf({ fetched: 'true', hashMatched: 'false' }), Verdict.EvidenceUnhashed)
  assert.equal(verdictOf({ fetched: 'false', hasURI: 'true' }), Verdict.EvidenceUnreachable)
  assert.equal(verdictOf({ fetched: 'false', hasURI: 'false' }), Verdict.EvidenceAbsent)
})

check('a malformed hash becomes the zero payment reference, a valid one is kept', () => {
  const [ok, , , malformed] = parseClaimsCsv(CSV)
  assert.equal(paymentTxOf(ok), '0x' + '11'.repeat(32))
  assert.equal(paymentTxOf(malformed), '0x' + '00'.repeat(32))
})

const cacheLines = [
  JSON.stringify({ args: { agentId: { __bigint: '9742' }, clientAddress: '0xaaa0000000000000000000000000000000000001', feedbackIndex: { __bigint: '5' }, feedbackURI: 'https://x.example/a.json', feedbackHash: '0x' + 'aa'.repeat(32) } }),
  JSON.stringify({ args: { agentId: { __bigint: '9742' }, clientAddress: '0xaaa0000000000000000000000000000000000001', feedbackIndex: { __bigint: '6' }, feedbackURI: 'https://x.example/b.json', feedbackHash: '0x' + 'bb'.repeat(32) } }),
]

check('the cache join recovers feedbackIndex and evidenceHash', () => {
  const idx = indexCache(cacheLines)
  const { rows, missing } = buildAttestations(parseClaimsCsv(CSV).slice(0, 2), idx)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].feedbackIndex, 5n)
  assert.equal(rows[0].evidenceHash, '0x' + 'aa'.repeat(32))
  assert.equal(rows[1].feedbackIndex, 6n)
  assert.equal(missing.length, 0)
})

check('claims that fail the join are reported missing, never silently dropped', () => {
  const idx = indexCache(cacheLines)
  const { rows, missing } = buildAttestations(parseClaimsCsv(CSV), idx)
  assert.equal(rows.length, 2)
  assert.equal(missing.length, 2)
})

check('case differences between CSV and cache addresses do not break the join', () => {
  const idx = indexCache(cacheLines)
  const upper = parseClaimsCsv(CSV.replace(/0xaaa/gi, '0xAAA')).slice(0, 1)
  const { rows } = buildAttestations(upper, idx)
  assert.equal(rows.length, 1)
})

check('chunking splits without losing rows', () => {
  const parts = chunk([1, 2, 3, 4, 5], 2)
  assert.deepEqual(parts, [[1, 2], [3, 4], [5]])
})

console.log(`\n${passed} passed\n`)
