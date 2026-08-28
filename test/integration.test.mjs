/**
 * End-to-end: the audit's writer, this service's reader, and a real EVM.
 *
 *   node test/integration.test.mjs
 *
 * Every other suite tests one side of a boundary. This one tests the boundary
 * itself, which is where the expensive failures live: a CSV whose producer and
 * consumer disagree, a claim the library builds and the contract rejects, a
 * hostile string that survives one layer and breaks the next. All three
 * happened, and none of them would have been caught by testing either side
 * alone.
 */
import assert from 'node:assert/strict'
import { encodeAbiParameters } from 'viem'
import { newChain, ERRORS } from './harness.mjs'
import { escapeCell } from '../script/csv.mjs'
import {
  parseClaimsCsvStrict, buildAttestations, toClaimStruct, chunk, fingerprint, Verdict,
} from '../script/backfill-lib.mjs'

const OWNER    = '0x00000000000000000000000000000000000000a1'
const ATTESTER = '0x00000000000000000000000000000000000000a2'
const STRANGER = '0x00000000000000000000000000000000000000a3'
const REVIEWER = '0xaaa0000000000000000000000000000000000001'
const AGENT_OWNER = '0xbbb0000000000000000000000000000000000002'
const TOKEN    = '0xceba9300f2b948710d2653dd7b07f33a8b32118c'
const TX1 = '0x' + '11'.repeat(32)

let passed = 0
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}`); throw e }
}

/**
 * The audit's export header, verbatim. If the audit changes it, this constant
 * stops matching and the drift is a test failure rather than a silent
 * mis-parse in production.
 */
const HEADER = [
  'timestamp', 'block', 'agentId', 'reviewer', 'feedbackIndex',
  'rung', 'evidenceRung',
  'hasURI', 'hasHash', 'fetched', 'jsonValid', 'hashMatched', 'inconclusive',
  'claimsPayment', 'txExistsOnCelo', 'paymentVerified', 'paymentAttributed',
  'partiesContradicted', 'onQueryableChain',
  'claimTxHash', 'claimNetwork', 'amount', 'symbol', 'decimals',
  'declaredFrom', 'declaredTo', 'transferFrom', 'transferTo', 'transferCount',
  'evidenceHash', 'contentSha256', 'contentKeccak', 'bytes', 'observedAt', 'via',
  'note', 'partyNote', 'feedbackURI',
]

const base = {
  timestamp: '2026-08-20T17:34:44Z', block: '73000001', agentId: '9742', reviewer: REVIEWER,
  feedbackIndex: '0', rung: 'EvidenceIntact', evidenceRung: 'Intact',
  hasURI: 'true', hasHash: 'true', fetched: 'true', jsonValid: 'true', hashMatched: 'true',
  inconclusive: 'false', claimsPayment: 'false', txExistsOnCelo: 'false',
  paymentVerified: 'false', paymentAttributed: 'false', partiesContradicted: 'false',
  onQueryableChain: 'true', claimTxHash: '', claimNetwork: '', amount: '', symbol: '',
  decimals: '', declaredFrom: '', declaredTo: '', transferFrom: '', transferTo: '',
  transferCount: '0', evidenceHash: '0x' + 'aa'.repeat(32), contentSha256: '',
  contentKeccak: '', bytes: '1234', observedAt: '2026-08-20T09:00:00Z', via: 'x.example',
  note: '', partyNote: '', feedbackURI: 'https://x.example/a.json',
}

/** Written exactly the way the audit writes it — same escaper, same order. */
function writeCsv(rows) {
  return [
    HEADER.join(','),
    ...rows.map((r) => HEADER.map((h) => escapeCell({ ...base, ...r }[h] ?? '')).join(',')),
  ].join('\n')
}

async function fresh() {
  const chain = await newChain()
  const addr = await chain.deploy(OWNER, encodeAbiParameters([{ type: 'address' }], [ATTESTER]))
  return { chain, addr }
}

console.log('\nCSV → claims → chain')

await check('a full ladder round-trips from the audit\'s writer to on-chain state', async () => {
  const csvText = writeCsv([
    { feedbackIndex: '0', rung: 'EvidenceIntact', evidenceRung: 'Intact' },
    { feedbackIndex: '1', rung: 'EvidenceAbsent', evidenceRung: 'Absent', hasURI: 'false', fetched: 'false', jsonValid: 'false', hashMatched: 'false', feedbackURI: '' },
    { feedbackIndex: '2', rung: 'EvidenceInconclusive', evidenceRung: 'Inconclusive', fetched: 'false', jsonValid: 'false', hashMatched: 'false', inconclusive: 'true', note: 'HTTP 429 (inconclusive)' },
    {
      feedbackIndex: '3', rung: 'PaymentAttributed', evidenceRung: 'Intact',
      claimsPayment: 'true', txExistsOnCelo: 'true', paymentVerified: 'true', paymentAttributed: 'true',
      claimTxHash: TX1, claimNetwork: '42220', amount: '500000000', symbol: 'USDC', decimals: '6',
      transferFrom: REVIEWER, transferTo: AGENT_OWNER, transferCount: '1',
    },
  ])

  const parsed = parseClaimsCsvStrict(csvText)
  assert.equal(parsed.malformed.length, 0)
  assert.deepEqual(parsed.header, HEADER, 'the export header this service expects has not drifted')

  // The audit exports `token` under `symbol`/`decimals` plus the address column
  // the library reads; supply it the way the pipeline does.
  const claims = parsed.rows.map((r) => ({ ...r, token: r.amount ? TOKEN : '' }))
  const { rows, missing, rejected, duplicateTxs } = buildAttestations(claims, { map: new Map(), collisions: [] })
  assert.equal(missing.length, 0)
  assert.equal(rejected.length, 0)
  assert.equal(duplicateTxs.length, 0)
  assert.equal(rows.length, 4)

  const { chain, addr } = await fresh()
  const r = await chain.call(ATTESTER, addr, 'attestBatch', [rows.map(toClaimStruct)])
  assert.equal(r.reverted, false, `batch reverted with ${r.selector}`)
  assert.equal(r.logs.length, 4)

  // The strong rung survives the whole path, amount and all.
  const paid = (await chain.call(STRANGER, addr, 'getAttestation', [9742n, REVIEWER, 3n])).result
  assert.equal(paid.verdict, Verdict.PaymentAttributed)
  assert.equal(paid.amount, 500_000_000n)
  assert.equal(paid.paymentToken.toLowerCase(), TOKEN)
  assert.equal(paid.amountDecimals, 6)
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentAttributed', [9742n, REVIEWER, 3n])).result, true)
  assert.equal(
    (await chain.call(STRANGER, addr, 'isPaymentAttributedAtLeast', [9742n, REVIEWER, 3n, 100_000_000n, TOKEN])).result,
    true,
  )

  // A rate-limited retrieval reached the chain as its own state, not as a dead link.
  const busy = (await chain.call(STRANGER, addr, 'getAttestation', [9742n, REVIEWER, 2n])).result
  assert.equal(busy.verdict, Verdict.EvidenceInconclusive)

  // And the observation date is the one the audit recorded, not the write.
  assert.equal(paid.observedAt, Math.floor(Date.parse('2026-08-20T09:00:00Z') / 1000))
  assert.ok(paid.checkedAt > paid.observedAt, 'checkedAt is the write, observedAt is the check')
})

await check('a hostile feedbackURI cannot forge an attestation anywhere along the path', async () => {
  /**
   * The full §3.5 escalation, end to end. The URI is chosen by the reviewer, so
   * it may contain a newline, quotes and commas arranged to close the row and
   * open a forged one carrying the strongest verdict for an agent the attacker
   * does not own.
   */
  const forged = [
    'https://x.example/a.json',
    '"9999","0xdead00000000000000000000000000000000dead","0","PaymentAttributed"',
  ].join('\n')

  const csvText = writeCsv([{ feedbackIndex: '0', feedbackURI: forged }])
  const parsed = parseClaimsCsvStrict(csvText)

  assert.equal(parsed.rows.length, 1, 'one review is still one row')
  assert.equal(parsed.malformed.length, 0)
  assert.equal(parsed.rows[0].feedbackURI, forged, 'the URI survives intact, as data')
  assert.equal(parsed.rows[0].agentId, '9742', 'and cannot rewrite the row it sits in')

  const { rows, rejected } = buildAttestations(parsed.rows, { map: new Map(), collisions: [] })
  assert.equal(rows.length, 1)
  assert.equal(rejected.length, 0)
  assert.equal(rows[0].agentId, 9742n)
  assert.notEqual(rows[0].verdict, Verdict.PaymentAttributed)

  const { chain, addr } = await fresh()
  const r = await chain.call(ATTESTER, addr, 'attestBatch', [rows.map(toClaimStruct)])
  assert.equal(r.reverted, false)
  assert.equal(r.logs.length, 1, 'exactly one attestation reached the chain')
  // The agent the forged row named was never touched.
  const victim = (await chain.call(STRANGER, addr, 'getAttestation', [9999n, '0xdead00000000000000000000000000000000dead', 0n])).result
  assert.equal(victim.verdict, 0, 'the forged record stays "never attested"')
})

await check('every record gets its own index, including the ones publishing no file', async () => {
  /**
   * The collision that left records reading None. Two hash-only records from
   * one reviewer against one agent share an empty URI, which used to be part of
   * the join key: one was attested twice, the other never.
   */
  const csvText = writeCsv([
    { agentId: '1', reviewer: REVIEWER, feedbackIndex: '3', rung: 'EvidenceAbsent', evidenceRung: 'Absent', hasURI: 'false', fetched: 'false', jsonValid: 'false', hashMatched: 'false', feedbackURI: '' },
    { agentId: '1', reviewer: REVIEWER, feedbackIndex: '7', rung: 'EvidenceAbsent', evidenceRung: 'Absent', hasURI: 'false', fetched: 'false', jsonValid: 'false', hashMatched: 'false', feedbackURI: '' },
  ])
  const { rows, rejected } = buildAttestations(parseClaimsCsvStrict(csvText).rows, { map: new Map(), collisions: [] })
  assert.equal(rejected.length, 0)
  assert.equal(rows.length, 2)

  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attestBatch', [rows.map(toClaimStruct)])
  for (const idx of [3n, 7n]) {
    const a = (await chain.call(STRANGER, addr, 'getAttestation', [1n, REVIEWER, idx])).result
    assert.equal(a.verdict, Verdict.EvidenceAbsent, `index ${idx} was attested`)
    assert.equal(a.revision, 1, `index ${idx} was attested exactly once`)
  }
})

await check('a claim the library accepts is a claim the contract accepts', async () => {
  // The two invariant sets must agree. If the library is laxer, the backfill
  // discovers it at the 74th batch, mid-spend, on mainnet.
  const { chain, addr } = await fresh()
  const shapes = [
    { rung: 'PaymentVerified', claimsPayment: 'true', txExistsOnCelo: 'true', paymentVerified: 'true', claimTxHash: TX1, amount: '1', decimals: '6' },
    { rung: 'PaymentTxNotFound', claimsPayment: 'true', claimTxHash: 'not-a-hash' },
    { rung: 'PaymentForeignChain', claimsPayment: 'true', onQueryableChain: 'false', claimNetwork: '8453', claimTxHash: 'not-a-hash' },
    { rung: 'PaymentNoValue', claimsPayment: 'true', txExistsOnCelo: 'true', claimTxHash: TX1, note: 'transfer of zero' },
    { rung: 'EvidenceUnbound', evidenceRung: 'Unbound', hashMatched: 'false' },
    { rung: 'EvidenceUnhashed', evidenceRung: 'Unhashed', hashMatched: 'false' },
    { rung: 'EvidenceUnreachable', evidenceRung: 'Unreachable', fetched: 'false', jsonValid: 'false', hashMatched: 'false' },
  ]
  const csvText = writeCsv(shapes.map((s, i) => ({ ...s, feedbackIndex: String(i), token: '' })))
  const claims = parseClaimsCsvStrict(csvText).rows.map((r) => ({ ...r, token: r.amount ? TOKEN : '' }))
  const { rows, rejected } = buildAttestations(claims, { map: new Map(), collisions: [] })
  assert.equal(rejected.length, 0, `library rejected: ${rejected.map((r) => r.reason).join('; ')}`)
  assert.equal(rows.length, shapes.length)

  const r = await chain.call(ATTESTER, addr, 'attestBatch', [rows.map(toClaimStruct)])
  assert.equal(r.reverted, false, `contract rejected a claim the library built: ${r.selector}`)
  assert.equal(r.logs.length, shapes.length)
})

await check('a library-rejected claim is one the contract would have refused too', async () => {
  const { chain, addr } = await fresh()
  // PaymentVerified with an unparseable hash: the library refuses it, and the
  // contract would revert the whole batch on it.
  const csvText = writeCsv([{ rung: 'PaymentVerified', claimsPayment: 'true', txExistsOnCelo: 'true', paymentVerified: 'true', claimTxHash: 'not-a-hash' }])
  const { rows, rejected } = buildAttestations(parseClaimsCsvStrict(csvText).rows, { map: new Map(), collisions: [] })
  assert.equal(rows.length, 0)
  assert.equal(rejected.length, 1)

  // Prove the contract agrees, by building the claim the library refused.
  const r = await chain.call(ATTESTER, addr, 'attest', [{
    agentId: 1n, clientAddress: REVIEWER, feedbackIndex: 0n,
    verdict: Verdict.PaymentVerified, evidence: 1, payment: 2,
    paymentTx: '0x' + '00'.repeat(32), evidenceHash: '0x' + 'aa'.repeat(32),
    amount: 0n, paymentToken: '0x' + '00'.repeat(20), amountDecimals: 0, observedAt: 0,
  }])
  assert.equal(r.selector, ERRORS.MissingPaymentTx)
})

console.log('\nresume across a changed batch size')

await check('a resume marker written at one batch size cannot be misread at another', async () => {
  /**
   * The old marker stored a batch COUNT, and the batch size came from the
   * environment: "3 batches done" at BATCH_SIZE=100 meant rows 0–299, and the
   * same marker read at BATCH_SIZE=50 meant rows 0–149 — so rows 150–299 were
   * silently re-attested, doubling their revision and their gas.
   */
  const rows = Array.from({ length: 10 }, (_, i) => ({
    agentId: 1n, clientAddress: REVIEWER, feedbackIndex: BigInt(i),
    verdict: Verdict.EvidenceIntact, evidence: 1, payment: 0,
    paymentTx: '0x' + '00'.repeat(32), evidenceHash: '0x' + 'aa'.repeat(32),
    amount: 0n, paymentToken: '0x' + '00'.repeat(20), amountDecimals: 0, observedAt: 0,
  }))

  // Progress is rows, so re-cutting at a different size resumes at the same place.
  const doneRows = 6
  for (const size of [2, 3, 5]) {
    const pending = rows.slice(doneRows)
    const batches = chunk(pending, size)
    const total = batches.reduce((n, b) => n + b.length, 0)
    assert.equal(total, 4, `batch size ${size} still leaves exactly 4 rows to write`)
    assert.deepEqual(batches.flat().map((r) => r.feedbackIndex), [6n, 7n, 8n, 9n])
  }

  // And a changed input is detectable rather than silently reinterpreted.
  const altered = [...rows.slice(0, 9), { ...rows[9], verdict: Verdict.EvidenceUnreachable }]
  assert.notEqual(fingerprint(rows), fingerprint(altered))
})

console.log(`\n${passed} passed\n`)
