/**
 * Backfill logic — the code that decides what reaches mainnet.
 *
 * Several of these tests are regressions for defects that would have written
 * wrong verdicts to a public ledger, and they name the defect rather than the
 * function, because in six months the name of the defect is the useful part.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseClaimsCsv, parseClaimsCsvStrict, verdictOf, evidenceOf, paymentOf, paymentTxOf,
  indexCache, buildAttestations, incoherence, fingerprint, amountOf, observedAtOf,
  parseUint, parseAddress, Verdict, Evidence, Payment, chunk,
} from '../script/backfill-lib.mjs'
import { escapeCell, parseCsvStrict } from '../script/csv.mjs'

let passed = 0
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}`); throw e }
}

const AAA = '0xaaa0000000000000000000000000000000000001'
const BBB = '0xbbb0000000000000000000000000000000000002'
const TOKEN = '0xceba9300f2b948710d2653dd7b07f33a8b32118c'
const TX1 = '0x' + '11'.repeat(32)
const TX2 = '0x' + '22'.repeat(32)
const ZERO32 = '0x' + '00'.repeat(32)
const ZERO_ADDR = '0x' + '00'.repeat(20)

/** Build a CSV the way the audit writes one, so tests exercise the real format. */
function csv(header, rows) {
  return [header.join(','), ...rows.map((r) => header.map((h) => escapeCell(r[h] ?? '')).join(','))].join('\n')
}

const HEADER = [
  'timestamp', 'block', 'agentId', 'reviewer', 'feedbackIndex', 'rung', 'evidenceRung',
  'hasURI', 'hasHash', 'fetched', 'jsonValid', 'hashMatched', 'inconclusive',
  'claimsPayment', 'txExistsOnCelo', 'paymentVerified', 'paymentAttributed',
  'partiesContradicted', 'onQueryableChain', 'claimTxHash', 'claimNetwork',
  'amount', 'symbol', 'decimals', 'token', 'evidenceHash', 'observedAt', 'note', 'feedbackURI',
]

const row = (over = {}) => ({
  timestamp: '2026-08-20T17:34:44Z', block: '73000001', agentId: '9742', reviewer: AAA,
  feedbackIndex: '5', rung: 'EvidenceIntact', evidenceRung: 'Intact',
  hasURI: 'true', hasHash: 'true', fetched: 'true', jsonValid: 'true', hashMatched: 'true',
  inconclusive: 'false', claimsPayment: 'false', txExistsOnCelo: 'false',
  paymentVerified: 'false', paymentAttributed: 'false', partiesContradicted: 'false',
  onQueryableChain: 'true', claimTxHash: '', claimNetwork: '', amount: '', symbol: '',
  decimals: '', token: '', evidenceHash: '0x' + 'aa'.repeat(32), observedAt: '',
  note: '', feedbackURI: 'https://x.example/a.json', ...over,
})

console.log('\nCSV format — the writer and the reader are one contract')

check('the two repositories carry byte-identical parsers', () => {
  // The format's producer lives in the audit repository and its consumer here.
  // Two copies that drift is how a torn row becomes a wrong attestation.
  const mine = readFileSync('script/csv.mjs', 'utf8')
  let theirs
  for (const p of [
    '../celo-agent-feedback-audit/src/csv.mjs',
    '../bacbacta/celo-agent-feedback-audit/src/csv.mjs',
  ]) {
    try { theirs = readFileSync(p, 'utf8'); break } catch { /* not checked out here */ }
  }
  if (theirs === undefined) {
    console.log('    (audit repository not checked out alongside — drift check skipped)')
    return
  }
  assert.equal(mine, theirs, 'script/csv.mjs has drifted from the audit\'s src/csv.mjs')
})

check('a feedbackURI containing a newline cannot forge a second row', () => {
  // The attack: feedbackURI is written on chain by the reviewer. The old writer
  // let a raw newline through and the old reader split on newlines before
  // reading quotes, so one URI tore its row in half and left a forged one.
  const hostile = 'https://x.example/a.json\n"9999","0xdead","PaymentAttributed"'
  const text = csv(HEADER, [row({ feedbackURI: hostile })])
  const { rows, malformed } = parseCsvStrict(text)
  assert.equal(rows.length, 1, 'exactly one record, not two')
  assert.equal(malformed.length, 0)
  assert.equal(rows[0].feedbackURI, hostile, 'and the URI round-trips exactly')
  assert.equal(rows[0].agentId, '9742')
})

check('quoted commas and quotes still survive, as they always did', () => {
  const text = csv(HEADER, [row({ feedbackURI: 'https://x/c, with "quotes".json' })])
  assert.equal(parseClaimsCsv(text)[0].feedbackURI, 'https://x/c, with "quotes".json')
})

check('a CRLF file does not leave a stray carriage return in the last column', () => {
  // It used to, and the last column is feedbackURI — which was the join key.
  const text = csv(HEADER, [row()]).replace(/\n/g, '\r\n')
  const rows = parseClaimsCsv(text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].feedbackURI, 'https://x.example/a.json')
})

check('a row that does not match the header is reported, never padded', () => {
  const text = csv(HEADER, [row()]) + '\n"only","three","cells"'
  const { rows, malformed } = parseClaimsCsvStrict(text)
  assert.equal(rows.length, 1)
  assert.equal(malformed.length, 1)
  assert.equal(malformed[0].cells, 3)
})

console.log('\nthe join — the defect that left records reading "never attested"')

const cacheLines = [
  JSON.stringify({ args: { agentId: { __bigint: '9742' }, clientAddress: AAA, feedbackIndex: { __bigint: '5' }, feedbackURI: 'https://x.example/a.json', feedbackHash: '0x' + 'aa'.repeat(32) } }),
  JSON.stringify({ args: { agentId: { __bigint: '9742' }, clientAddress: AAA, feedbackIndex: { __bigint: '6' }, feedbackURI: 'https://x.example/b.json', feedbackHash: '0x' + 'bb'.repeat(32) } }),
]

check('two hash-only records for one reviewer collide on the legacy key, and it is caught', () => {
  // Roughly half the registry publishes no file, so every one of those records
  // carries the same empty URI. The old key was (agentId, reviewer, uri): for a
  // reviewer with several such records against one agent, every key collided,
  // `map.set` kept the last, and BOTH rows then joined onto that one index —
  // one record attested twice, the other left reading None, the single state
  // this contract advertises as unforgeable. A collision is a join that
  // SUCCEEDS, so the missing-row guard could never see it.
  const collidingCache = [
    JSON.stringify({ args: { agentId: { __bigint: '1' }, clientAddress: BBB, feedbackIndex: { __bigint: '3' }, feedbackURI: '', feedbackHash: ZERO32 } }),
    JSON.stringify({ args: { agentId: { __bigint: '1' }, clientAddress: BBB, feedbackIndex: { __bigint: '7' }, feedbackURI: '', feedbackHash: ZERO32 } }),
  ]
  const cache = indexCache(collidingCache)
  assert.equal(cache.map.size, 1, 'the key genuinely is not unique')
  assert.equal(cache.collisions.length, 1, 'and the collision is reported rather than silently resolved')
  assert.deepEqual(cache.collisions[0].indexes, [3n, 7n])
})

check('the exported feedbackIndex removes the join entirely', () => {
  // The real repair is upstream: with the column present there is nothing to
  // get wrong, and no cache is consulted for the index at all.
  const text = csv(HEADER, [
    row({ agentId: '1', reviewer: BBB, feedbackIndex: '3', hasURI: 'false', rung: 'EvidenceAbsent', evidenceRung: 'Absent', feedbackURI: '' }),
    row({ agentId: '1', reviewer: BBB, feedbackIndex: '7', hasURI: 'false', rung: 'EvidenceAbsent', evidenceRung: 'Absent', feedbackURI: '' }),
  ])
  const { rows, missing, rejected } = buildAttestations(parseClaimsCsv(text), { map: new Map(), collisions: [] })
  assert.equal(rows.length, 2, 'both records are attested')
  assert.deepEqual(rows.map((r) => r.feedbackIndex), [3n, 7n], 'each under its own index')
  assert.equal(missing.length, 0)
  assert.equal(rejected.length, 0)
})

check('a legacy export with no index column still joins, and reports what it cannot', () => {
  const legacyHeader = HEADER.filter((h) => h !== 'feedbackIndex')
  const text = csv(legacyHeader, [row(), row({ feedbackURI: 'https://x.example/unknown.json' })])
  const { rows, missing } = buildAttestations(parseClaimsCsv(text), indexCache(cacheLines))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].feedbackIndex, 5n)
  assert.equal(missing.length, 1)
})

check('case differences between CSV and cache addresses do not break the join', () => {
  const legacyHeader = HEADER.filter((h) => h !== 'feedbackIndex')
  const text = csv(legacyHeader, [row({ reviewer: AAA.toUpperCase().replace('0X', '0x') })])
  const { rows } = buildAttestations(parseClaimsCsv(text), indexCache(cacheLines))
  assert.equal(rows.length, 1)
})

console.log('\nrows that must never reach the chain')

check('a non-numeric agentId fails its own row, not the whole run', () => {
  // `BigInt(cell)` used to be called unguarded, so one torn row threw a
  // SyntaxError that stopped the entire backfill.
  const text = csv(HEADER, [row({ agentId: 'evil' }), row({ agentId: '5', feedbackIndex: '1' })])
  const { rows, rejected } = buildAttestations(parseClaimsCsv(text), { map: new Map(), collisions: [] })
  assert.equal(rows.length, 1, 'the good row still goes through')
  assert.equal(rejected.length, 1)
  assert.match(rejected[0].reason, /agentId is not an unsigned integer/)
})

check('a malformed reviewer address is rejected, not lowercased into something plausible', () => {
  const text = csv(HEADER, [row({ reviewer: '0xnothex' })])
  const { rows, rejected } = buildAttestations(parseClaimsCsv(text), { map: new Map(), collisions: [] })
  assert.equal(rows.length, 0)
  assert.match(rejected[0].reason, /reviewer is not an address/)
})

check('a rung asserting the transaction was found cannot carry a zero hash', () => {
  // verdictOf and paymentTxOf read independent columns and nothing used to
  // reconcile them, so the contract would have reverted at the 74th batch.
  const text = csv(HEADER, [row({ rung: 'PaymentVerified', claimsPayment: 'true', paymentVerified: 'true', claimTxHash: 'not-a-hash' })])
  const { rows, rejected } = buildAttestations(parseClaimsCsv(text), { map: new Map(), collisions: [] })
  assert.equal(rows.length, 0)
  assert.match(rejected[0].reason, /asserts the transaction was found but carries no hash/)
})

check('the same record twice in one input is refused, not attested twice', () => {
  // Two writes in one backfill: double gas, and a revision counter that lies
  // about how many times the record was checked.
  const text = csv(HEADER, [row({ feedbackIndex: '5' }), row({ feedbackIndex: '5', rung: 'EvidenceUnreachable' })])
  const { rows, rejected } = buildAttestations(parseClaimsCsv(text), { map: new Map(), collisions: [] })
  assert.equal(rows.length, 1)
  assert.match(rejected[0].reason, /duplicate of row/)
})

check('the contract invariants are enforced here, before a batch is built', () => {
  assert.match(incoherence({ verdict: Verdict.None, paymentTx: TX1, amount: 0n, paymentToken: ZERO_ADDR }), /None/)
  assert.match(incoherence({ verdict: Verdict.PaymentAttributed, paymentTx: TX1, amount: 0n, paymentToken: TOKEN }), /no amount/)
  assert.match(incoherence({ verdict: Verdict.EvidenceIntact, paymentTx: ZERO32, amount: 5n, paymentToken: ZERO_ADDR }), /no token/)
  assert.equal(incoherence({ verdict: Verdict.PaymentTxNotFound, paymentTx: ZERO32, amount: 0n, paymentToken: ZERO_ADDR }), null)
})

console.log('\npayment reuse — reported, because hiding it would be the worse error')

check('one transaction backing several reviews is surfaced', () => {
  // Nothing enforces uniqueness, so a single real payment can underwrite an
  // entire fabricated history. That is a fact about the registry, so the rows
  // are still attested — but the operator is told before anything is written.
  const paid = (over) => row({
    rung: 'PaymentVerified', evidenceRung: 'Intact', claimsPayment: 'true',
    txExistsOnCelo: 'true', paymentVerified: 'true', claimTxHash: TX1,
    amount: '1000000', token: TOKEN, decimals: '6', ...over,
  })
  const text = csv(HEADER, [paid({ feedbackIndex: '1' }), paid({ feedbackIndex: '2' }), paid({ feedbackIndex: '3', claimTxHash: TX2 })])
  const { rows, duplicateTxs } = buildAttestations(parseClaimsCsv(text), { map: new Map(), collisions: [] })
  assert.equal(rows.length, 3, 'the rows are not suppressed')
  assert.equal(duplicateTxs.length, 1)
  assert.equal(duplicateTxs[0].tx, TX1)
  assert.equal(duplicateTxs[0].users.length, 2)
})

console.log('\nthe ladder, and the dimensions it used to flatten')

check('the audit names the rung, and that name wins over re-derivation', () => {
  assert.equal(verdictOf({ rung: 'PaymentAttributed' }), Verdict.PaymentAttributed)
  assert.equal(verdictOf({ rung: 'EvidenceInconclusive' }), Verdict.EvidenceInconclusive)
  assert.equal(verdictOf({ rung: 'PaymentVerified', paymentVerified: 'false' }), Verdict.PaymentVerified)
})

check('the boolean fallback matches the audit note-for-note', () => {
  // The two implementations of this ladder differed by exactly one substring —
  // 'zero' here against 'transfer of zero' there — and nothing would have
  // surfaced the disagreement.
  assert.equal(verdictOf({ claimsPayment: 'true', txExistsOnCelo: 'true', note: 'transfer of zero' }), Verdict.PaymentNoValue)
  assert.equal(verdictOf({ claimsPayment: 'true', txExistsOnCelo: 'true', note: 'no stablecoin transfer in transaction' }), Verdict.PaymentNoValue)
  assert.equal(verdictOf({ claimsPayment: 'true', txExistsOnCelo: 'true', note: 'reverted' }), Verdict.PaymentTxFailed)
})

check('an unknown rung falls through to the booleans rather than writing garbage', () => {
  assert.equal(verdictOf({ rung: 'SomethingNew', fetched: 'true', hashMatched: 'true' }), Verdict.EvidenceIntact)
})

check('attribution and its refusal are both reachable', () => {
  assert.equal(verdictOf({ paymentAttributed: 'true' }), Verdict.PaymentAttributed)
  assert.equal(verdictOf({ paymentVerified: 'true', partiesContradicted: 'true' }), Verdict.PaymentPartyMismatch)
  assert.equal(verdictOf({ paymentVerified: 'true' }), Verdict.PaymentVerified)
})

check('a payment declared on another chain is not reported as missing from this one', () => {
  assert.equal(verdictOf({ claimsPayment: 'true', onQueryableChain: 'false', txExistsOnCelo: 'false' }), Verdict.PaymentForeignChain)
})

check('an inconclusive retrieval is not a dead link', () => {
  assert.equal(verdictOf({ fetched: 'false', hasURI: 'true', inconclusive: 'true' }), Verdict.EvidenceInconclusive)
  assert.equal(verdictOf({ fetched: 'false', hasURI: 'true', inconclusive: 'false' }), Verdict.EvidenceUnreachable)
})

check('the documentary dimension survives a payment verdict that would mask it', () => {
  const paid = row({ rung: 'PaymentAttributed', evidenceRung: 'Intact' })
  assert.equal(verdictOf(paid), Verdict.PaymentAttributed)
  assert.equal(evidenceOf(paid), Evidence.Intact)
})

check('a pass with nothing to say about the payment writes Unknown, so the chain keeps what it knew', () => {
  assert.equal(paymentOf({}, Verdict.EvidenceUnreachable), Payment.Unknown)
  assert.equal(paymentOf({}, Verdict.PaymentAttributed), Payment.Attributed)
  assert.equal(paymentOf({}, Verdict.PaymentTxNotFound), Payment.NotFound)
})

console.log('\nfield coercion')

check('a malformed hash becomes the zero payment reference, a valid one is kept', () => {
  assert.equal(paymentTxOf({ claimTxHash: TX1.toUpperCase().replace('0X', '0x') }), TX1)
  assert.equal(paymentTxOf({ claimTxHash: 'not-a-hash' }), ZERO32)
  assert.equal(paymentTxOf({}), ZERO32)
})

check('an amount above the uint96 ceiling is clamped, never silently wrapped', () => {
  assert.equal(amountOf({ amount: '1000000' }), 1_000_000n)
  assert.equal(amountOf({ amount: '' }), 0n)
  assert.equal(amountOf({ amount: 'lots' }), 0n)
  assert.equal(amountOf({ amount: ((1n << 96n) + 5n).toString() }), (1n << 96n) - 1n)
})

check('the observation date is carried, and never dated into the future', () => {
  const iso = '2026-08-20T17:34:44Z'
  assert.equal(observedAtOf({ observedAt: iso }), Math.floor(Date.parse(iso) / 1000))
  assert.equal(observedAtOf({ observedAt: '' }), 0)
  assert.equal(observedAtOf({ observedAt: 'not a date' }), 0)
  const future = observedAtOf({ observedAt: '2200-01-01T00:00:00Z' })
  assert.ok(future <= Math.floor(Date.now() / 1000), 'the contract would reject a future observation')
})

check('parseUint and parseAddress refuse what they cannot vouch for', () => {
  assert.equal(parseUint('42', 'x'), 42n)
  assert.throws(() => parseUint('-1', 'x'), /not an unsigned integer/)
  assert.throws(() => parseUint('0x10', 'x'), /not an unsigned integer/)
  assert.equal(parseAddress(AAA.toUpperCase().replace('0X', '0x'), 'x'), AAA)
  assert.throws(() => parseAddress('0x123', 'x'), /not an address/)
})

console.log('\nresume — the marker used to describe a different set of rows than it meant')

check('the fingerprint changes when the row set changes', () => {
  // The marker stored a COUNT OF BATCHES and the batch size came from the
  // environment: resuming with a different BATCH_SIZE re-cut the same rows into
  // different chunks, so "3 batches done" silently covered different rows —
  // some paid for twice, some never written, and no entry in `missing` because
  // they had joined perfectly.
  const a = [{ agentId: 1n, clientAddress: AAA, feedbackIndex: 0n, verdict: 2, evidence: 1, payment: 0, paymentTx: ZERO32, evidenceHash: ZERO32, amount: 0n, paymentToken: ZERO_ADDR }]
  const b = [{ ...a[0], verdict: 8 }]
  assert.notEqual(fingerprint(a), fingerprint(b))
  assert.equal(fingerprint(a), fingerprint([{ ...a[0] }]), 'and is stable for the same rows')
  assert.match(fingerprint(a), /^1-[0-9a-f]{16}$/)
})

check('the fingerprint counts rows, so a truncated input is visible in it', () => {
  const r = { agentId: 1n, clientAddress: AAA, feedbackIndex: 0n, verdict: 2, evidence: 1, payment: 0, paymentTx: ZERO32, evidenceHash: ZERO32, amount: 0n, paymentToken: ZERO_ADDR }
  assert.ok(fingerprint([r, r]).startsWith('2-'))
})

check('chunking splits without losing rows', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

console.log(`\n${passed} passed\n`)
