/**
 * Backfill logic — the code that decides what reaches mainnet.
 *
 * Several of these tests are regressions for defects that would have written
 * wrong verdicts to a public ledger, and they name the defect rather than the
 * function, because in six months the name of the defect is the useful part.
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import {
  parseClaimsCsv, parseClaimsCsvStrict, verdictOf, evidenceOf, paymentOf, paymentTxOf,
  indexCache, buildAttestations, incoherence, fingerprint, amountOf, observedAtOf,
  parseUint, parseAddress, Verdict, Evidence, Payment, chunk, recordKey, merkleRoot, NOT_CHECKED,
} from '../script/backfill-lib.mjs'
import { escapeCell, parseCsvStrict } from '../script/csv.mjs'
import { keccak256 } from 'viem'

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
  decimals: '', token: '', evidenceHash: '0x' + 'aa'.repeat(32), observedAt: '2026-08-20T09:00:00Z',
  note: '', feedbackURI: 'https://x.example/a.json', ...over,
})

console.log('\nCSV format — the writer and the reader are one contract')

/**
 * Where the audit repository is, if it is checked out beside this one.
 *
 * The drift guards used to each locate it themselves and each `return` with a
 * cheerful ✓ when they could not find it — so a suite that had silently
 * stopped checking anything looked exactly like one that had checked and
 * passed. It is resolved once, reported once, and the guards say plainly that
 * they did not run.
 */
const AUDIT_REPO = [
  '../celo-agent-feedback-audit',
  '../bacbacta/celo-agent-feedback-audit',
].find((p) => existsSync(`${p}/package.json`)) ?? null
if (!AUDIT_REPO) {
  console.log('  ! the audit repository is not checked out alongside.')
  console.log('    The cross-repository drift guards below CANNOT RUN. A ✓ from them')
  console.log('    would mean nothing, so they report as skipped instead.')
}

/**
 * Every file that must stay byte-identical across the two repositories.
 *
 * csv.mjs had this guard; coverage.mjs shipped without one, while both copies
 * state at the top that they must not diverge and the README repeats it as
 * settled fact — "the same file byte for byte, so the root the indexer
 * publishes and the root a challenger rebuilds cannot drift apart". Nothing
 * was holding that. A divergence there does not break a test, it makes every
 * coverage claim unverifiable by the party it is published for.
 */
const SHARED = [
  ['script/csv.mjs', 'src/csv.mjs'],
  ['script/coverage.mjs', 'src/coverage.mjs'],
]

for (const [mineRel, theirsRel] of SHARED) {
  check(`${mineRel} is byte-identical to the audit's ${theirsRel}`, () => {
    if (!AUDIT_REPO) {
      console.log(`    (skipped — cannot compare ${mineRel}: no audit repository found)`)
      return
    }
    const mine = readFileSync(mineRel, 'utf8')
    const theirs = readFileSync(`${AUDIT_REPO}/${theirsRel}`, 'utf8')
    assert.equal(mine, theirs, `${mineRel} has drifted from the audit's ${theirsRel}`)
  })
}

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
  const text = csv(HEADER, [
    row({ feedbackIndex: '5' }),
    row({ feedbackIndex: '5', rung: 'EvidenceUnreachable', evidenceRung: 'Unreachable', fetched: 'false', jsonValid: 'false', hashMatched: 'false' }),
  ])
  const { rows, rejected } = buildAttestations(parseClaimsCsv(text), { map: new Map(), collisions: [] })
  assert.equal(rows.length, 1)
  assert.match(rejected[0].reason, /duplicate of row/)
})

check('the contract invariants are enforced here, before a batch is built', () => {
  // A claim the contract would revert must fail at validation, not at the 74th
  // batch with earlier batches already paid for.
  assert.match(incoherence({ verdict: Verdict.None, paymentTx: TX1, amount: 0n, paymentToken: ZERO_ADDR }), /None/)
  assert.match(incoherence({ verdict: Verdict.PaymentAttributed, paymentTx: TX1, amount: 0n, paymentToken: TOKEN }), /no amount/)
  assert.match(incoherence({ verdict: Verdict.EvidenceIntact, paymentTx: ZERO32, amount: 5n, paymentToken: ZERO_ADDR }), /no token/)
  assert.equal(incoherence({ verdict: Verdict.PaymentTxNotFound, paymentTx: ZERO32, amount: 0n, paymentToken: ZERO_ADDR }), null)
})

check('a headline that disagrees with either dimension is refused here too', () => {
  assert.match(
    incoherence({ verdict: Verdict.EvidenceAbsent, evidence: Evidence.Intact, paymentTx: ZERO32, amount: 0n, paymentToken: ZERO_ADDR }),
    /implies evidence state/,
  )
  assert.match(
    incoherence({ verdict: Verdict.PaymentAttributed, payment: Payment.Verified, paymentTx: TX1, amount: 5n, paymentToken: TOKEN }),
    /implies payment state/,
  )
  // A payment rung may carry any documentary state — that is why there are two.
  assert.equal(
    incoherence({ verdict: Verdict.PaymentAttributed, evidence: Evidence.Unknown, payment: Payment.Attributed, paymentTx: TX1, amount: 5n, paymentToken: TOKEN }),
    null,
  )
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

check('NotDeclared is only written about bytes that ARE the attested document', () => {
  /**
   * `NotDeclared` asserts on chain that the reviewer's document names no
   * payment, and unlike `Unknown` it OVERWRITES — including over an attributed
   * payment already published. So it may only be said about bytes that are
   * cryptographically the document: a 200 whose keccak does not match the
   * attested feedbackHash is somebody else's file, or today's version of one
   * that has since changed, and the pipeline knows it — it publishes exactly
   * that as EvidenceUnhashed in the same row.
   */
  const read = { fetched: 'true', jsonValid: 'true', claimsPayment: 'false', claimTxHash: '' }
  const doc = Verdict.EvidenceIntact

  assert.equal(paymentOf({ ...read, hashMatched: 'true' }, doc), Payment.NotDeclared)

  // Retrieved, parsed — and not the attested document. Silence, not a finding.
  assert.equal(paymentOf({ ...read, hashMatched: 'false' }, doc), Payment.Unknown,
    'unbound bytes must not overwrite a published attribution')
  assert.equal(paymentOf({ ...read }, doc), Payment.Unknown, 'no hashMatched column at all')
  assert.equal(paymentOf({ ...read, hashMatched: 'true', fetched: 'false' }, doc), Payment.Unknown)
  assert.equal(paymentOf({ ...read, hashMatched: 'true', jsonValid: 'false' }, doc), Payment.Unknown)

  /**
   * And never against the row's own evidence. A transaction hash in the row
   * means the document did declare something the pipeline could see, whatever
   * `claimsPayment` says about it.
   */
  assert.equal(
    paymentOf({ ...read, hashMatched: 'true', claimTxHash: TX1 }, doc), Payment.Unknown,
    'a row carrying a transaction hash cannot assert the document declares none',
  )
  assert.equal(
    paymentOf({ ...read, hashMatched: 'true', claimsPayment: 'true' }, doc), Payment.Unknown,
  )

  /**
   * And never when the audit says it saw a proof field it could not read.
   * `proofOfPayment` arrives as a bare hash string and as a list of claims in
   * the wild; an extractor that understood neither reported "no claim", and
   * this function published that as the reviewer's own statement.
   */
  assert.equal(
    paymentOf({ ...read, hashMatched: 'true', proofPresent: 'true' }, doc), Payment.Unknown,
    'our extractor falling short must not become their record',
  )
  // An older export carries no such column, and its absence is not a claim.
  assert.equal(paymentOf({ ...read, hashMatched: 'true' }, doc), Payment.NotDeclared)
})

check('a record nobody opened is not attested at all', () => {
  /**
   * The fetch cap left 8,724 of 10,469 declared files unopened, and the export
   * gave every one of them rung=EvidenceInconclusive. That rung means "we
   * tried and learned nothing" — a statement about the record. We had not
   * tried. Publishing it on chain would put a retrieval failure on 8,724
   * publishers who were never contacted, and it would do so in a ledger whose
   * whole claim is that its verdicts were checked.
   *
   * The row stays in the export — a sampled audit must say which records it
   * skipped, not omit them — but it carries a rung that is not a verdict, and
   * the backfill writes nothing for it. `None` on chain, which means "never
   * attested", is the true statement.
   */
  const skipped = { rung: NOT_CHECKED, evidenceRung: NOT_CHECKED, hasURI: 'true',
                    fetched: 'false', jsonValid: 'false', hashMatched: 'false', inconclusive: 'false' }
  assert.equal(verdictOf(skipped), null, 'an unopened record has no verdict')

  // And the boolean fallback must not rescue it into one. Without the explicit
  // sentinel, `hasURI && !fetched` reads as EvidenceUnreachable — "a host
  // answered that the file is gone" — which is a worse lie than the first.
  assert.notEqual(verdictOf(skipped), Verdict.EvidenceUnreachable)
  assert.notEqual(verdictOf(skipped), Verdict.EvidenceInconclusive)

  const text = csv(HEADER, [row({ rung: NOT_CHECKED, evidenceRung: NOT_CHECKED, fetched: 'false' })])
  const { rows, skipped: sk, rejected } = buildAttestations(parseClaimsCsvStrict(text).rows, { map: new Map(), collisions: [] })
  assert.equal(rows.length, 0, 'nothing may be written for a record nobody opened')
  assert.equal(rejected.length, 0, 'and it is not an error — it is a deliberate skip')
  assert.equal(sk.length, 1, 'the skip must be counted, not silent')
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

check('the fingerprint covers every field that reaches the chain', () => {
  // amountDecimals and observedAt were missing, so a run whose only change was
  // one of those carried the previous run's fingerprint and resumed as if
  // nothing had changed.
  const base = { agentId: 1n, clientAddress: AAA, feedbackIndex: 0n, verdict: 2, evidence: 1, payment: 0, paymentTx: ZERO32, evidenceHash: ZERO32, amount: 0n, paymentToken: ZERO_ADDR, amountDecimals: 0, observedAt: 0 }
  assert.notEqual(fingerprint([base]), fingerprint([{ ...base, amountDecimals: 6 }]))
  assert.notEqual(fingerprint([base]), fingerprint([{ ...base, observedAt: 1_789_000_000 }]))
})

check('a rung named after an inherited property is not a rung', () => {
  // `Verdict[row.rung]` reached the prototype chain, so 'constructor' resolved
  // to a function — neither undefined nor a number — and passed every check.
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const v = verdictOf({ rung: name, fetched: 'false', hasURI: 'true' })
    assert.equal(typeof v, 'number', `${name} produced a non-number verdict`)
    assert.equal(v, Verdict.EvidenceUnreachable, `${name} should fall through to the booleans`)
    assert.equal(typeof evidenceOf({ evidenceRung: name, hasURI: 'true' }), 'number')
  }
})

check('an index too wide for its on-chain type fails validation, not the run', () => {
  // feedbackIndex is a uint64. A larger value used to survive every check and
  // then make viem throw while a later batch was being assembled — after
  // earlier batches had already been paid for.
  const text = csv(HEADER, [row({ feedbackIndex: (2n ** 64n).toString() })])
  const { rows, rejected } = buildAttestations(parseClaimsCsv(text), { map: new Map(), collisions: [] })
  assert.equal(rows.length, 0)
  assert.match(rejected[0].reason, /does not fit in uint64/)
})

check('an impossible observation date is unknown, not the moment of the run', () => {
  // Clamping to now manufactured exactly the date this field exists to avoid:
  // the write time wearing the observation's name.
  assert.equal(observedAtOf({ observedAt: '2200-01-01T00:00:00Z' }), 0)
  assert.equal(observedAtOf({ observedAt: '1600-01-01T00:00:00Z' }), 0)
  const real = '2026-08-20T17:34:44Z'
  assert.equal(observedAtOf({ observedAt: real }), Math.floor(Date.parse(real) / 1000))
})

check('a control character in a URI no longer collapses two records into one', () => {
  /**
   * escapeCell used to DELETE unprintable characters, which made the transform
   * non-injective: two distinct feedbackURI values collapsed to one string, and
   * that string is the legacy join key. The wrong feedbackIndex received the
   * other record's verdict while every collision counter stayed at zero.
   */
  const CTRL = String.fromCharCode(1)
  const a = 'ipfs://QmA' + CTRL
  const b = 'ipfs://QmA'
  assert.notEqual(escapeCell(a), escapeCell(b), 'distinct URIs must stay distinct')
  const text = csv(HEADER, [row({ feedbackURI: a }), row({ feedbackIndex: '6', feedbackURI: b })])
  const parsed = parseClaimsCsv(text)
  assert.equal(parsed[0].feedbackURI, a, 'and round-trip exactly')
  assert.equal(parsed[1].feedbackURI, b)
})

check('chunking splits without losing rows', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

console.log('\ncoverage — the claim about what was NOT written')

check('the off-chain record key is the contract\'s own key', () => {
  // A leaf in the coverage tree must be the value the ledger indexes by, or a
  // proof needs a translation layer and stops being checkable with stock tools.
  const k = recordKey(7, AAA, 3)
  assert.match(k, /^0x[0-9a-f]{64}$/)
  assert.equal(k, recordKey(7n, AAA.toUpperCase().replace('0X', '0x'), 3n), 'case and type must not matter')
  assert.notEqual(k, recordKey(7, AAA, 4))
})

check('the root depends on the set, not on the order it was processed in', () => {
  const ks = [recordKey(1, AAA, 0), recordKey(1, AAA, 1), recordKey(2, BBB, 0)]
  const r = merkleRoot(ks)
  assert.equal(merkleRoot([ks[2], ks[0], ks[1]]), r)
  assert.equal(merkleRoot([...ks, ks[0]]), r, 'a repeated leaf is one member of a set')
  assert.notEqual(merkleRoot(ks.slice(0, 2)), r)
})

check('an empty sweep commits to zero, which reads as "nothing claimed"', () => {
  assert.equal(merkleRoot([]), ZERO32)
})

check('an odd leaf is carried up, never duplicated', () => {
  /**
   * Duplicating the odd node is a real Merkle footgun: it lets one leaf appear
   * twice in the tree, so a proof for it can be replayed at a second position.
   * Checked against both constructions rather than against itself.
   */
  const leaves = [recordKey(1, AAA, 0), recordKey(1, AAA, 1), recordKey(1, AAA, 2)].sort()
  const h = (x, y) => keccak256(('0x' + (x < y ? x.slice(2) + y.slice(2) : y.slice(2) + x.slice(2))))
  const carried = h(h(leaves[0], leaves[1]), leaves[2])
  const duplicated = h(h(leaves[0], leaves[1]), h(leaves[2], leaves[2]))
  assert.notEqual(carried, duplicated, 'the two constructions must actually differ')
  assert.equal(merkleRoot(leaves), carried)
})

console.log(`\n${passed} passed\n`)
