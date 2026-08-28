/**
 * ProvenanceAttestations — behavioural suite on a real EVM.
 *
 *   npm test
 *
 * Every test deploys fresh state. Assertions target behaviour a consumer or an
 * adversary would care about: who may write, what overwriting means, what the
 * events carry, and that the "absence" value can never be forged.
 */
import assert from 'node:assert/strict'
import { encodeAbiParameters } from 'viem'
import { newChain, ERRORS } from './harness.mjs'

const OWNER    = '0x00000000000000000000000000000000000000a1'
const ATTESTER = '0x00000000000000000000000000000000000000a2'
const STRANGER = '0x00000000000000000000000000000000000000a3'
const REVIEWER = '0x00000000000000000000000000000000000000b1'

const TX1 = '0x' + '11'.repeat(32)
const EH1 = '0x' + '22'.repeat(32)
const ZERO32 = '0x' + '00'.repeat(32)

const V = { None: 0, PaymentVerified: 1, TxNotFound: 2, TxFailed: 3, NoValueMoved: 4, EvidenceUnreachable: 5 }

async function fresh() {
  const chain = await newChain()
  const ctor = encodeAbiParameters([{ type: 'address' }], [ATTESTER])
  const addr = await chain.deploy(OWNER, ctor)
  return { chain, addr }
}

let passed = 0
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}`); throw e }
}

console.log('\ndeployment')

await check('constructor sets owner and attester, and refuses a zero attester', async () => {
  const { chain, addr } = await fresh()
  assert.equal((await chain.call(STRANGER, addr, 'owner', [])).result.toLowerCase(), OWNER)
  assert.equal((await chain.call(STRANGER, addr, 'attester', [])).result.toLowerCase(), ATTESTER)
  const zeroCtor = encodeAbiParameters([{ type: 'address' }], ['0x' + '00'.repeat(20)])
  await assert.rejects(() => chain.deploy(OWNER, zeroCtor))
})

console.log('\nauthorization')

await check('only the attester can attest — not the owner, not a stranger', async () => {
  const { chain, addr } = await fresh()
  const args = [1n, REVIEWER, 0n, V.PaymentVerified, TX1, EH1]
  for (const who of [OWNER, STRANGER]) {
    const r = await chain.call(who, addr, 'attest', args)
    assert.equal(r.reverted, true)
    assert.equal(r.selector, ERRORS.NotAttester)
  }
  assert.equal((await chain.call(ATTESTER, addr, 'attest', args)).reverted, false)
})

await check('only the owner rotates the attester, and never to the zero address', async () => {
  const { chain, addr } = await fresh()
  let r = await chain.call(STRANGER, addr, 'setAttester', [STRANGER])
  assert.equal(r.selector, ERRORS.NotOwner)
  r = await chain.call(OWNER, addr, 'setAttester', ['0x' + '00'.repeat(20)])
  assert.equal(r.selector, ERRORS.ZeroAddress)
  r = await chain.call(OWNER, addr, 'setAttester', [STRANGER])
  assert.equal(r.reverted, false)
  // Old attester is locked out immediately; new one works.
  const args = [1n, REVIEWER, 0n, V.TxNotFound, ZERO32, EH1]
  assert.equal((await chain.call(ATTESTER, addr, 'attest', args)).selector, ERRORS.NotAttester)
  assert.equal((await chain.call(STRANGER, addr, 'attest', args)).reverted, false)
})

await check('ownership transfers, and the zero address is refused', async () => {
  const { chain, addr } = await fresh()
  assert.equal((await chain.call(OWNER, addr, 'transferOwnership', ['0x' + '00'.repeat(20)])).selector, ERRORS.ZeroAddress)
  assert.equal((await chain.call(OWNER, addr, 'transferOwnership', [STRANGER])).reverted, false)
  assert.equal((await chain.call(OWNER, addr, 'setAttester', [OWNER])).selector, ERRORS.NotOwner)
  assert.equal((await chain.call(STRANGER, addr, 'setAttester', [STRANGER])).reverted, false)
})

console.log('\nattestation semantics')

await check('a verdict is stored and readable exactly as written', async () => {
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [7n, REVIEWER, 3n, V.PaymentVerified, TX1, EH1])
  const a = (await chain.call(STRANGER, addr, 'getAttestation', [7n, REVIEWER, 3n])).result
  assert.equal(a.verdict, V.PaymentVerified)
  assert.equal(a.paymentTx, TX1)
  assert.equal(a.evidenceHash, EH1)
  assert.equal(a.revision, 1)
  assert.equal(typeof a.checkedAt, 'number') // uint40 decodes as number; bare-EVM timestamp is 0
})

await check('None can never be written — absence stays unforgeable', async () => {
  const { chain, addr } = await fresh()
  const r = await chain.call(ATTESTER, addr, 'attest', [1n, REVIEWER, 0n, V.None, ZERO32, ZERO32])
  assert.equal(r.selector, ERRORS.InvalidVerdict)
})

await check('an unattested record reads as None and is not payment-backed', async () => {
  const { chain, addr } = await fresh()
  const a = (await chain.call(STRANGER, addr, 'getAttestation', [99n, REVIEWER, 0n])).result
  assert.equal(a.verdict, V.None)
  assert.equal(a.revision, 0)
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentBacked', [99n, REVIEWER, 0n])).result, false)
})

await check('re-attestation overwrites the verdict and bumps the revision', async () => {
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [1n, REVIEWER, 0n, V.TxNotFound, ZERO32, EH1])
  // The claimed tx later appears on chain: verdict flips.
  await chain.call(ATTESTER, addr, 'attest', [1n, REVIEWER, 0n, V.PaymentVerified, TX1, EH1])
  const a = (await chain.call(STRANGER, addr, 'getAttestation', [1n, REVIEWER, 0n])).result
  assert.equal(a.verdict, V.PaymentVerified)
  assert.equal(a.revision, 2)
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentBacked', [1n, REVIEWER, 0n])).result, true)
})

await check('isPaymentBacked is true only for PaymentVerified', async () => {
  const { chain, addr } = await fresh()
  for (const v of [V.TxNotFound, V.TxFailed, V.NoValueMoved, V.EvidenceUnreachable]) {
    await chain.call(ATTESTER, addr, 'attest', [10n, REVIEWER, BigInt(v), v, ZERO32, EH1])
    const backed = (await chain.call(STRANGER, addr, 'isPaymentBacked', [10n, REVIEWER, BigInt(v)])).result
    assert.equal(backed, false, `verdict ${v} must not count as backed`)
  }
})

await check('records are keyed by the full tuple — no cross-talk', async () => {
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [1n, REVIEWER, 0n, V.PaymentVerified, TX1, EH1])
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentBacked', [1n, REVIEWER, 1n])).result, false)
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentBacked', [2n, REVIEWER, 0n])).result, false)
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentBacked', [1n, STRANGER, 0n])).result, false)
})

console.log('\nevents')

await check('FeedbackAttested carries the tuple, verdict and revision', async () => {
  const { chain, addr } = await fresh()
  const r = await chain.call(ATTESTER, addr, 'attest', [5n, REVIEWER, 2n, V.NoValueMoved, TX1, EH1])
  const ev = r.logs.find((l) => l.eventName === 'FeedbackAttested')
  assert.ok(ev, 'event emitted')
  assert.equal(ev.args.agentId, 5n)
  assert.equal(ev.args.clientAddress.toLowerCase(), REVIEWER)
  assert.equal(ev.args.feedbackIndex, 2n)
  assert.equal(ev.args.verdict, V.NoValueMoved)
  assert.equal(ev.args.paymentTx, TX1)
  assert.equal(ev.args.revision, 1)
})

console.log('\nbatch')

await check('attestBatch writes every row and enforces the attester gate', async () => {
  const { chain, addr } = await fresh()
  const rows = [
    [1n, V.PaymentVerified, TX1],
    [2n, V.TxNotFound, ZERO32],
    [3n, V.EvidenceUnreachable, ZERO32],
  ]
  const args = [
    rows.map((r) => r[0]),
    rows.map(() => REVIEWER),
    rows.map(() => 0n),
    rows.map((r) => r[1]),
    rows.map((r) => r[2]),
    rows.map(() => EH1),
  ]
  assert.equal((await chain.call(STRANGER, addr, 'attestBatch', args)).selector, ERRORS.NotAttester)
  const ok = await chain.call(ATTESTER, addr, 'attestBatch', args)
  assert.equal(ok.reverted, false)
  assert.equal(ok.logs.filter((l) => l.eventName === 'FeedbackAttested').length, 3)
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentBacked', [1n, REVIEWER, 0n])).result, true)
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentBacked', [2n, REVIEWER, 0n])).result, false)
})

await check('attestBatch rejects mismatched array lengths', async () => {
  const { chain, addr } = await fresh()
  const r = await chain.call(ATTESTER, addr, 'attestBatch', [
    [1n, 2n], [REVIEWER], [0n, 0n], [V.TxNotFound, V.TxNotFound], [ZERO32, ZERO32], [EH1, EH1],
  ])
  assert.equal(r.selector, ERRORS.LengthMismatch)
})

await check('a batch of 100 rows fits comfortably in a block', async () => {
  const { chain, addr } = await fresh()
  const n = 100
  const args = [
    Array.from({ length: n }, (_, i) => BigInt(i)),
    Array(n).fill(REVIEWER),
    Array(n).fill(0n),
    Array(n).fill(V.TxNotFound),
    Array(n).fill(ZERO32),
    Array(n).fill(EH1),
  ]
  const r = await chain.call(ATTESTER, addr, 'attestBatch', args)
  assert.equal(r.reverted, false)
  assert.ok(r.gasUsed < 8_000_000n, `gas ${r.gasUsed} should stay well under limits`)
  console.log(`      (100 attestations: ${r.gasUsed} gas — ~${(Number(r.gasUsed) / n).toFixed(0)}/row)`)
})

console.log(`\n${passed} passed\n`)
