/**
 * ProvenanceAttestations — behavioural suite on a real EVM.
 *
 *   npm test
 *
 * Every test deploys fresh state. Assertions target behaviour a consumer or an
 * adversary would care about: who may write, what overwriting means, what the
 * events carry, that the "absence" value can never be forged, and that a rung
 * cannot be published alongside a payload that refutes it.
 */
import assert from 'node:assert/strict'
import { encodeAbiParameters } from 'viem'
import { newChain, ERRORS } from './harness.mjs'

const OWNER    = '0x00000000000000000000000000000000000000a1'
const ATTESTER = '0x00000000000000000000000000000000000000a2'
const STRANGER = '0x00000000000000000000000000000000000000a3'
const COLD     = '0x00000000000000000000000000000000000000a4'
const REVIEWER = '0x00000000000000000000000000000000000000b1'
const TOKEN    = '0x00000000000000000000000000000000000000c1'

const TX1 = '0x' + '11'.repeat(32)
const TX2 = '0x' + '99'.repeat(32)
const EH1 = '0x' + '22'.repeat(32)
const ZERO32 = '0x' + '00'.repeat(32)
const ZERO_ADDR = '0x' + '00'.repeat(20)

const V = {
  None: 0, PaymentVerified: 1, EvidenceIntact: 2, EvidenceUnbound: 3, EvidenceUnhashed: 4,
  PaymentTxNotFound: 5, PaymentTxFailed: 6, PaymentNoValue: 7,
  EvidenceUnreachable: 8, EvidenceAbsent: 9,
  PaymentAttributed: 10, PaymentPartyMismatch: 11, PaymentForeignChain: 12,
  EvidenceInconclusive: 13,
}
const E = { Unknown: 0, Intact: 1, Unbound: 2, Unhashed: 3, Unreachable: 4, Inconclusive: 5, Absent: 6 }
const P = { Unknown: 0, Attributed: 1, Verified: 2, PartyMismatch: 3, NoValue: 4, Failed: 5, NotFound: 6, ForeignChain: 7 }

/** A well-formed claim, so each test only states what it is actually varying. */
function claim(over = {}) {
  return {
    agentId: 1n,
    clientAddress: REVIEWER,
    feedbackIndex: 0n,
    verdict: V.EvidenceIntact,
    evidence: E.Intact,
    payment: P.Unknown,
    paymentTx: ZERO32,
    evidenceHash: EH1,
    amount: 0n,
    paymentToken: ZERO_ADDR,
    amountDecimals: 0,
    observedAt: 0,
    ...over,
  }
}

/** A settled, attributed payment — the only shape the strong rung accepts. */
const attributed = (over = {}) => claim({
  verdict: V.PaymentAttributed, payment: P.Attributed,
  paymentTx: TX1, amount: 1_000_000n, paymentToken: TOKEN, amountDecimals: 6,
  ...over,
})

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
  const zeroCtor = encodeAbiParameters([{ type: 'address' }], [ZERO_ADDR])
  await assert.rejects(() => chain.deploy(OWNER, zeroCtor))
})

console.log('\nauthorization')

await check('only the attester can attest — not the owner, not a stranger', async () => {
  const { chain, addr } = await fresh()
  for (const who of [OWNER, STRANGER]) {
    const r = await chain.call(who, addr, 'attest', [claim()])
    assert.equal(r.reverted, true)
    assert.equal(r.selector, ERRORS.NotAttester)
  }
  assert.equal((await chain.call(ATTESTER, addr, 'attest', [claim()])).reverted, false)
})

await check('only the owner rotates the attester, and never to the zero address', async () => {
  const { chain, addr } = await fresh()
  assert.equal((await chain.call(STRANGER, addr, 'setAttester', [STRANGER])).selector, ERRORS.NotOwner)
  assert.equal((await chain.call(OWNER, addr, 'setAttester', [ZERO_ADDR])).selector, ERRORS.ZeroAddress)
  assert.equal((await chain.call(OWNER, addr, 'setAttester', [STRANGER])).reverted, false)
  // Old attester is locked out immediately; new one works.
  assert.equal((await chain.call(ATTESTER, addr, 'attest', [claim()])).selector, ERRORS.NotAttester)
  assert.equal((await chain.call(STRANGER, addr, 'attest', [claim()])).reverted, false)
})

console.log('\nownership handover (two-step)')

await check('a transfer does not take effect until the new owner accepts', async () => {
  const { chain, addr } = await fresh()
  assert.equal((await chain.call(OWNER, addr, 'transferOwnership', [COLD])).reverted, false)
  // Still the old owner until acceptance — this is the whole point.
  assert.equal((await chain.call(STRANGER, addr, 'owner', [])).result.toLowerCase(), OWNER)
  assert.equal((await chain.call(STRANGER, addr, 'pendingOwner', [])).result.toLowerCase(), COLD)
  assert.equal((await chain.call(OWNER, addr, 'setAttester', [STRANGER])).reverted, false)
})

await check('only the owner-elect can accept, which is what proves the key exists', async () => {
  const { chain, addr } = await fresh()
  await chain.call(OWNER, addr, 'transferOwnership', [COLD])
  assert.equal((await chain.call(STRANGER, addr, 'acceptOwnership', [])).selector, ERRORS.NotPendingOwner)
  assert.equal((await chain.call(OWNER, addr, 'acceptOwnership', [])).selector, ERRORS.NotPendingOwner)
  assert.equal((await chain.call(COLD, addr, 'acceptOwnership', [])).reverted, false)
  assert.equal((await chain.call(STRANGER, addr, 'owner', [])).result.toLowerCase(), COLD)
  assert.equal((await chain.call(STRANGER, addr, 'pendingOwner', [])).result.toLowerCase(), ZERO_ADDR)
})

await check('a transfer to an unreachable address is survivable, not fatal', async () => {
  // The failure this two-step design exists to prevent: under a one-step
  // transfer, a mistyped address permanently destroys attester rotation — the
  // only defence the trust model has against a compromised attesting key.
  const { chain, addr } = await fresh()
  const TYPO = '0x000000000000000000000000000000000000dead'
  await chain.call(OWNER, addr, 'transferOwnership', [TYPO])
  assert.equal((await chain.call(STRANGER, addr, 'owner', [])).result.toLowerCase(), OWNER)
  // The mistake is cancelled by the still-sitting owner.
  await chain.call(OWNER, addr, 'transferOwnership', [ZERO_ADDR])
  assert.equal((await chain.call(TYPO, addr, 'acceptOwnership', [])).selector, ERRORS.NotPendingOwner)
  assert.equal((await chain.call(OWNER, addr, 'setAttester', [STRANGER])).reverted, false)
})

console.log('\nattestation semantics')

await check('a verdict is stored and readable exactly as written', async () => {
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [attributed({ agentId: 7n, feedbackIndex: 3n, observedAt: 1_700_000_000 })])
  const a = (await chain.call(STRANGER, addr, 'getAttestation', [7n, REVIEWER, 3n])).result
  assert.equal(a.verdict, V.PaymentAttributed)
  assert.equal(a.payment, P.Attributed)
  assert.equal(a.paymentTx, TX1)
  assert.equal(a.evidenceHash, EH1)
  assert.equal(a.amount, 1_000_000n)
  assert.equal(a.paymentToken.toLowerCase(), TOKEN)
  assert.equal(a.amountDecimals, 6)
  assert.equal(a.observedAt, 1_700_000_000)
  assert.equal(a.revision, 1)
})

await check('None can never be written — absence stays unforgeable', async () => {
  const { chain, addr } = await fresh()
  const r = await chain.call(ATTESTER, addr, 'attest', [claim({ verdict: V.None })])
  assert.equal(r.selector, ERRORS.InvalidVerdict)
})

await check('an unattested record reads as None and grants nothing', async () => {
  const { chain, addr } = await fresh()
  const a = (await chain.call(STRANGER, addr, 'getAttestation', [99n, REVIEWER, 0n])).result
  assert.equal(a.verdict, V.None)
  assert.equal(a.revision, 0)
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentBacked', [99n, REVIEWER, 0n])).result, false)
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentAttributed', [99n, REVIEWER, 0n])).result, false)
  assert.equal((await chain.call(STRANGER, addr, 'hasIntactEvidence', [99n, REVIEWER, 0n])).result, false)
})

await check('re-attesting overwrites and bumps the revision', async () => {
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [claim({ verdict: V.EvidenceIntact, evidence: E.Intact })])
  await chain.call(ATTESTER, addr, 'attest', [claim({ verdict: V.EvidenceUnreachable, evidence: E.Unreachable })])
  const a = (await chain.call(STRANGER, addr, 'getAttestation', [1n, REVIEWER, 0n])).result
  assert.equal(a.verdict, V.EvidenceUnreachable)
  assert.equal(a.evidence, E.Unreachable)
  assert.equal(a.revision, 2)
})

console.log('\nthe two dimensions')

await check('a payment verdict no longer erases what the file was', async () => {
  // v2 had one slot: the payment rung outranked every documentary rung, so for
  // every record declaring a payment the state of its file was measured and
  // then discarded.
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [attributed({ evidence: E.Intact })])
  const a = (await chain.call(STRANGER, addr, 'getAttestation', [1n, REVIEWER, 0n])).result
  assert.equal(a.verdict, V.PaymentAttributed)
  assert.equal(a.evidence, E.Intact)
  assert.equal((await chain.call(STRANGER, addr, 'hasIntactEvidence', [1n, REVIEWER, 0n])).result, true)
})

await check('a settled payment survives its evidence file dying later', async () => {
  // The monotonicity bug: a settled transfer is immutable, but under one slot a
  // later pass that could no longer read the file flipped isPaymentBacked to
  // false about a transaction that had not changed.
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [attributed()])
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentAttributed', [1n, REVIEWER, 0n])).result, true)

  // Months later the file 404s. The pass has nothing to say about the payment.
  await chain.call(ATTESTER, addr, 'attest', [claim({
    verdict: V.EvidenceUnreachable, evidence: E.Unreachable, payment: P.Unknown,
  })])
  const a = (await chain.call(STRANGER, addr, 'getAttestation', [1n, REVIEWER, 0n])).result
  assert.equal(a.verdict, V.EvidenceUnreachable)
  assert.equal(a.evidence, E.Unreachable)
  assert.equal(a.payment, P.Attributed, 'the settlement did not stop having happened')
  assert.equal(a.amount, 1_000_000n)
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentAttributed', [1n, REVIEWER, 0n])).result, true)
})

await check('a pass that DOES re-evaluate the payment overwrites it', async () => {
  // Sticky must not mean permanent: an explicit payment state always wins.
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [attributed()])
  await chain.call(ATTESTER, addr, 'attest', [claim({
    verdict: V.PaymentPartyMismatch, payment: P.PartyMismatch, paymentTx: TX2,
    amount: 5n, paymentToken: TOKEN,
  })])
  const a = (await chain.call(STRANGER, addr, 'getAttestation', [1n, REVIEWER, 0n])).result
  assert.equal(a.payment, P.PartyMismatch)
  assert.equal(a.paymentTx, TX2)
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentAttributed', [1n, REVIEWER, 0n])).result, false)
})

await check('a pass that did not look at the file leaves the file alone', async () => {
  /**
   * The mirror of the sticky payment, and it was missing. A sweep driven by the
   * narrower payment-claims export carries no documentary columns at all, so
   * every row arrives as `Evidence.Unknown` — "this pass did not look at the
   * file", not "the file is no longer intact". Writing it flipped
   * hasIntactEvidence to false for files that were still intact, and returned
   * every published accusation to "not evaluated".
   */
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [claim({
    verdict: V.EvidenceIntact, evidence: E.Intact, evidenceHash: EH1, observedAt: 1_789_000_000,
  })])
  assert.equal((await chain.call(STRANGER, addr, 'hasIntactEvidence', [1n, REVIEWER, 0n])).result, true)

  // A later payment-only pass, exactly as the narrower export produces it.
  await chain.call(ATTESTER, addr, 'attest', [claim({
    verdict: V.PaymentAttributed, payment: P.Attributed, evidence: E.Unknown,
    paymentTx: TX1, amount: 1_000_000n, paymentToken: TOKEN, amountDecimals: 6,
    evidenceHash: ZERO32, observedAt: 0,
  })])
  const a = (await chain.call(STRANGER, addr, 'getAttestation', [1n, REVIEWER, 0n])).result
  assert.equal(a.evidence, E.Intact, 'the documentary state survived')
  assert.equal(a.evidenceHash, EH1, 'and so did its cross-reference')
  assert.equal(a.observedAt, 1_789_000_000, 'and the date of the observation it came from')
  assert.equal((await chain.call(STRANGER, addr, 'hasIntactEvidence', [1n, REVIEWER, 0n])).result, true)
  assert.equal(a.payment, P.Attributed, 'while the payment pass still applied')
})

await check('an accusation is not withdrawn by a pass that did not re-check it', async () => {
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [claim({ verdict: V.EvidenceAbsent, evidence: E.Absent })])
  await chain.call(ATTESTER, addr, 'attest', [claim({
    verdict: V.PaymentTxNotFound, payment: P.NotFound, evidence: E.Unknown, evidenceHash: ZERO32,
  })])
  assert.equal((await chain.call(STRANGER, addr, 'evidenceOf', [1n, REVIEWER, 0n])).result, E.Absent)
})

await check('a pass that DOES re-read the file overwrites it', async () => {
  // Preserved must not mean frozen.
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [claim({ verdict: V.EvidenceIntact, evidence: E.Intact })])
  await chain.call(ATTESTER, addr, 'attest', [claim({
    verdict: V.EvidenceUnreachable, evidence: E.Unreachable, evidenceHash: ZERO32,
  })])
  const a = (await chain.call(STRANGER, addr, 'getAttestation', [1n, REVIEWER, 0n])).result
  assert.equal(a.evidence, E.Unreachable)
  assert.equal(a.evidenceHash, ZERO32)
})

await check('the event reports the stored state on both dimensions', async () => {
  // An indexer rebuilding from logs alone must not disagree with a reader.
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [claim({
    verdict: V.EvidenceIntact, evidence: E.Intact, evidenceHash: EH1, observedAt: 1_789_000_000,
  })])
  const r = await chain.call(ATTESTER, addr, 'attest', [claim({
    verdict: V.PaymentAttributed, payment: P.Attributed, evidence: E.Unknown,
    paymentTx: TX1, amount: 1_000_000n, paymentToken: TOKEN, amountDecimals: 6,
    evidenceHash: ZERO32, observedAt: 0,
  })])
  const a = r.logs[0].args
  assert.equal(a.evidence, E.Intact)
  assert.equal(a.evidenceHash, EH1)
  assert.equal(a.observedAt, 1_789_000_000)
  assert.equal(a.payment, P.Attributed)
})

console.log('\nthe read surface')

await check('hasIntactEvidence answers only about the file', async () => {
  // v2 returned true for PaymentVerified, which asserts nothing about a file,
  // so a router filtering on it held a guarantee it had not been given.
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [claim({
    verdict: V.PaymentVerified, payment: P.Verified, paymentTx: TX1,
    evidence: E.Unreachable, amount: 5n, paymentToken: TOKEN,
  })])
  assert.equal((await chain.call(STRANGER, addr, 'hasIntactEvidence', [1n, REVIEWER, 0n])).result, false)
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentBacked', [1n, REVIEWER, 0n])).result, true)
})

await check('a merely verified payment is not an attributed one', async () => {
  // The §3.1 attack: cite any real transfer on the chain. It reaches Verified
  // and must not reach Attributed.
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [claim({
    verdict: V.PaymentVerified, payment: P.Verified, paymentTx: TX1,
    amount: 500n, paymentToken: TOKEN,
  })])
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentBacked', [1n, REVIEWER, 0n])).result, true)
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentAttributed', [1n, REVIEWER, 0n])).result, false)
})

await check('a threshold can be applied in the same call', async () => {
  // Dust and a five-hundred-dollar settlement reach the same rung, so the rung
  // alone cannot mean "economically significant".
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [attributed({ amount: 1n })]) // 0.000001 USDC
  const args = (min) => [1n, REVIEWER, 0n, min, TOKEN]
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentAttributedAtLeast', args(1n))).result, true)
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentAttributedAtLeast', args(1_000_000n))).result, false)
})

await check('a threshold in the wrong token does not pass', async () => {
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [attributed({ amount: 10_000_000n })])
  const other = '0x00000000000000000000000000000000000000c2'
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentAttributedAtLeast', [1n, REVIEWER, 0n, 1n, other])).result, false)
})

console.log('\ninvariants — a rung cannot contradict its own payload')

await check('a rung asserting the transaction was found must carry it', async () => {
  const { chain, addr } = await fresh()
  // Each verdict paired with the payment state it implies, so the failure under
  // test is the missing hash and not the dimension mismatch.
  const pairs = [
    [V.PaymentVerified, P.Verified],
    [V.PaymentAttributed, P.Attributed],
    [V.PaymentPartyMismatch, P.PartyMismatch],
    [V.PaymentTxFailed, P.Failed],
    [V.PaymentNoValue, P.NoValue],
  ]
  for (const [v, p] of pairs) {
    const r = await chain.call(ATTESTER, addr, 'attest', [claim({
      verdict: v, payment: p, paymentTx: ZERO32, amount: 0n,
    })])
    assert.equal(r.selector, ERRORS.MissingPaymentTx, `verdict ${v} accepted a zero tx hash`)
  }
})

await check('NotFound and ForeignChain may carry no hash — a malformed claim has none', async () => {
  const { chain, addr } = await fresh()
  for (const [v, p] of [[V.PaymentTxNotFound, P.NotFound], [V.PaymentForeignChain, P.ForeignChain]]) {
    const r = await chain.call(ATTESTER, addr, 'attest', [claim({ verdict: v, payment: p, paymentTx: ZERO32 })])
    assert.equal(r.reverted, false)
  }
})

await check('an attributed payment that moved nothing is refused', async () => {
  const { chain, addr } = await fresh()
  const r = await chain.call(ATTESTER, addr, 'attest', [attributed({ amount: 0n })])
  assert.equal(r.selector, ERRORS.IncoherentAmount)
})

await check('an amount denominated in no token is refused', async () => {
  const { chain, addr } = await fresh()
  const r = await chain.call(ATTESTER, addr, 'attest', [attributed({ paymentToken: ZERO_ADDR })])
  assert.equal(r.selector, ERRORS.IncoherentAmount)
})

await check('an observation dated after the block recording it is refused', async () => {
  const { chain, addr } = await fresh()
  // The bare EVM reports block.timestamp 0, so any positive observedAt is in
  // its future — which is exactly the condition under test.
  const r = await chain.call(ATTESTER, addr, 'attest', [claim({ observedAt: 2_000_000_000 })])
  assert.equal(r.selector, ERRORS.ObservationInFuture)
})

await check('the strong claim cannot be reached through the payment dimension alone', async () => {
  /**
   * The hole the verdict-only invariants left open. `isPaymentAttributed` and
   * `isPaymentBacked` read the PAYMENT field, but validation only looked at
   * `verdict` — so a claim whose headline was a harmless documentary rung could
   * carry `payment: Attributed` with no transaction and no amount, pass every
   * check, and then answer true to the strongest question in the system.
   */
  const { chain, addr } = await fresh()
  const r = await chain.call(ATTESTER, addr, 'attest', [claim({
    verdict: V.EvidenceIntact, evidence: E.Intact,
    payment: P.Attributed, paymentTx: ZERO32, amount: 0n, paymentToken: ZERO_ADDR,
  })])
  assert.equal(r.reverted, true, 'an attribution with nothing behind it was accepted')
  assert.equal((await chain.call(STRANGER, addr, 'isPaymentAttributed', [1n, REVIEWER, 0n])).result, false)
})

await check('every payment state asserting the transaction exists must name it', async () => {
  const { chain, addr } = await fresh()
  for (const p of [P.Verified, P.PartyMismatch, P.Failed, P.NoValue]) {
    const r = await chain.call(ATTESTER, addr, 'attest', [claim({
      verdict: V.EvidenceIntact, evidence: E.Intact, payment: p, paymentTx: ZERO32,
    })])
    assert.equal(r.selector, ERRORS.MissingPaymentTx, `payment ${p} accepted a zero tx hash`)
  }
})

await check('the headline and the payment dimension cannot name different outcomes', async () => {
  // Otherwise an indexer reading `verdict` and a router reading
  // `isPaymentAttributed` disagree about the same record.
  const { chain, addr } = await fresh()
  const bad = await chain.call(ATTESTER, addr, 'attest', [attributed({ payment: P.Unknown })])
  assert.equal(bad.selector, ERRORS.DimensionMismatch)
  const alsoBad = await chain.call(ATTESTER, addr, 'attest', [attributed({ payment: P.Verified })])
  assert.equal(alsoBad.selector, ERRORS.DimensionMismatch)
  assert.equal((await chain.call(ATTESTER, addr, 'attest', [attributed()])).reverted, false)
})

await check('the headline and the documentary dimension cannot disagree either', async () => {
  // The payment side got this rule first; the file side was left open, so a
  // headline of EvidenceAbsent could carry evidence: Intact and hasIntactEvidence
  // then contradicted the verdict printed beside it.
  const { chain, addr } = await fresh()
  const bad = await chain.call(ATTESTER, addr, 'attest', [claim({
    verdict: V.EvidenceAbsent, evidence: E.Intact,
  })])
  assert.equal(bad.selector, ERRORS.DimensionMismatch)
  assert.equal((await chain.call(STRANGER, addr, 'hasIntactEvidence', [1n, REVIEWER, 0n])).result, false)

  const alsoBad = await chain.call(ATTESTER, addr, 'attest', [claim({
    verdict: V.EvidenceIntact, evidence: E.Unreachable,
  })])
  assert.equal(alsoBad.selector, ERRORS.DimensionMismatch)
})

await check('a payment headline still says nothing about the file, either way', async () => {
  // Which is the whole reason the second dimension exists: a payment rung may
  // carry any documentary state, including Unknown.
  const { chain, addr } = await fresh()
  for (const e of [E.Unknown, E.Intact, E.Unreachable, E.Absent]) {
    const r = await chain.call(ATTESTER, addr, 'attest', [attributed({ evidence: e })])
    assert.equal(r.reverted, false, `payment rung refused evidence ${e}`)
  }
})

await check('a token with no amount is refused, like an amount with no token', async () => {
  const { chain, addr } = await fresh()
  const r = await chain.call(ATTESTER, addr, 'attest', [claim({ amount: 0n, paymentToken: TOKEN })])
  assert.equal(r.selector, ERRORS.IncoherentAmount)
})

await check('a threshold of zero against no token does not pass for an unattested record', async () => {
  // `isPaymentAttributedAtLeast(…, 0, 0x0)` must not be a free "yes".
  const { chain, addr } = await fresh()
  assert.equal(
    (await chain.call(STRANGER, addr, 'isPaymentAttributedAtLeast', [1n, REVIEWER, 0n, 0n, ZERO_ADDR])).result,
    false,
  )
})

await check('a verdict beyond the enum is rejected, not silently coerced', async () => {
  const { chain, addr } = await fresh()
  const r = await chain.call(ATTESTER, addr, 'attest', [claim({ verdict: 14 })])
  assert.equal(r.reverted, true)
})

console.log('\nevents')

await check('every attestation emits one event carrying the full state', async () => {
  const { chain, addr } = await fresh()
  const r = await chain.call(ATTESTER, addr, 'attest', [attributed({ agentId: 42n, feedbackIndex: 5n })])
  assert.equal(r.logs.length, 1)
  const a = r.logs[0].args
  assert.equal(a.agentId, 42n)
  assert.equal(a.clientAddress.toLowerCase(), REVIEWER)
  assert.equal(a.feedbackIndex, 5n)
  assert.equal(a.verdict, V.PaymentAttributed)
  assert.equal(a.evidence, E.Intact)
  assert.equal(a.payment, P.Attributed)
  assert.equal(a.paymentTx, TX1)
  assert.equal(a.evidenceHash, EH1)
  assert.equal(a.amount, 1_000_000n)
  assert.equal(a.paymentToken.toLowerCase(), TOKEN)
  assert.equal(a.amountDecimals, 6)
  assert.equal(a.revision, 1)
})

await check('a batch emits one event per element, so history stays reconstructable', async () => {
  const { chain, addr } = await fresh()
  const batch = [
    claim({ agentId: 1n, feedbackIndex: 0n }),
    claim({ agentId: 2n, feedbackIndex: 1n, verdict: V.EvidenceAbsent, evidence: E.Absent }),
    attributed({ agentId: 3n, feedbackIndex: 2n }),
  ]
  const r = await chain.call(ATTESTER, addr, 'attestBatch', [batch])
  assert.equal(r.reverted, false)
  assert.equal(r.logs.length, 3)
  assert.deepEqual(r.logs.map((l) => l.args.agentId), [1n, 2n, 3n])
  assert.equal((await chain.call(STRANGER, addr, 'totalAttestations', [])).result, 3n)
})

await check('the sticky payment state is what the event reports, not the blank input', async () => {
  // An indexer rebuilding state from events alone must see the same thing a
  // reader of the mapping sees.
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attest', [attributed()])
  const r = await chain.call(ATTESTER, addr, 'attest', [claim({
    verdict: V.EvidenceUnreachable, evidence: E.Unreachable, payment: P.Unknown,
  })])
  assert.equal(r.logs[0].args.paymentTx, TX1)
  assert.equal(r.logs[0].args.amount, 1_000_000n)
  // The field itself, not only its payload: the event used to echo the caller's
  // blank `Unknown` while the mapping kept `Attributed`, so an indexer
  // rebuilding state from events alone disagreed with a direct reader.
  assert.equal(r.logs[0].args.payment, P.Attributed)
  assert.equal(r.logs[0].args.paymentToken.toLowerCase(), TOKEN)
  assert.equal(r.logs[0].args.amountDecimals, 6)
})

console.log('\nbatching')

await check('an empty batch is refused rather than reported as a success', async () => {
  const { chain, addr } = await fresh()
  assert.equal((await chain.call(ATTESTER, addr, 'attestBatch', [[]])).selector, ERRORS.EmptyBatch)
})

await check('one bad claim reverts the whole batch, leaving no partial write', async () => {
  // A partially applied backfill is indistinguishable from a complete one at
  // read time, and the resume marker would record progress that did not happen.
  const { chain, addr } = await fresh()
  const r = await chain.call(ATTESTER, addr, 'attestBatch', [[
    claim({ agentId: 1n }),
    claim({ agentId: 2n, verdict: V.PaymentVerified, payment: P.Verified, paymentTx: ZERO32 }),
  ]])
  assert.equal(r.selector, ERRORS.MissingPaymentTx)
  assert.equal((await chain.call(STRANGER, addr, 'getAttestation', [1n, REVIEWER, 0n])).result.verdict, V.None)
  assert.equal((await chain.call(STRANGER, addr, 'totalAttestations', [])).result, 0n)
})

await check('a duplicate tuple inside one batch is applied twice, and says so', async () => {
  // The contract cannot cheaply de-duplicate a batch, so it does not pretend
  // to: both writes land and `revision` reaches 2. The backfill is what must
  // refuse to build such a batch, and its own suite covers that.
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'attestBatch', [[
    claim({ verdict: V.EvidenceIntact, evidence: E.Intact }),
    claim({ verdict: V.EvidenceUnreachable, evidence: E.Unreachable }),
  ]])
  const a = (await chain.call(STRANGER, addr, 'getAttestation', [1n, REVIEWER, 0n])).result
  assert.equal(a.revision, 2)
  assert.equal(a.verdict, V.EvidenceUnreachable)
})

console.log('\ncoverage — what the attester did NOT write')

await check('a sweep publishes what it covered, and only the attester may', async () => {
  /**
   * Events prove attestations. They cannot prove that everything which should
   * have been attested was, so an attester with something to hide never had to
   * lie — it only had to stay quiet, and silence left no trace. A sweep makes
   * coverage a dated, attributable, refutable claim.
   */
  const { chain, addr } = await fresh()
  assert.equal((await chain.call(STRANGER, addr, 'sweepCount', [])).result, 0n)

  const args = [100n, 200n, 5000, 4800, EH1]
  assert.equal((await chain.call(STRANGER, addr, 'commitSweep', args)).selector, ERRORS.NotAttester)
  assert.equal((await chain.call(OWNER, addr, 'commitSweep', args)).selector, ERRORS.NotAttester)

  const r = await chain.call(ATTESTER, addr, 'commitSweep', args)
  assert.equal(r.reverted, false)
  assert.equal((await chain.call(STRANGER, addr, 'sweepCount', [])).result, 1n)

  const s = (await chain.call(STRANGER, addr, 'latestSweep', [])).result
  assert.equal(s.fromBlock, 100n)
  assert.equal(s.toBlock, 200n)
  assert.equal(s.observed, 5000)
  assert.equal(s.attested, 4800)
  assert.equal(s.recordsRoot, EH1)
  assert.ok(s.committedAt > 0, 'a claim with no date cannot be aged')
})

await check('a sweep that contradicts itself is refused', async () => {
  const { chain, addr } = await fresh()
  // More attested than observed: the claim refutes itself before anyone checks.
  assert.equal(
    (await chain.call(ATTESTER, addr, 'commitSweep', [100n, 200n, 10, 11, ZERO32])).selector,
    ERRORS.AttestedExceedsObserved,
  )
  // An inverted range, and a range that is not yet mined.
  assert.equal((await chain.call(ATTESTER, addr, 'commitSweep', [200n, 100n, 1, 1, ZERO32])).selector, ERRORS.InvalidRange)
  assert.equal(
    (await chain.call(ATTESTER, addr, 'commitSweep', [100n, 99_999_999n, 1, 1, ZERO32])).selector,
    ERRORS.InvalidRange,
  )
})

await check('a gap between observed and attested is published, not hidden', async () => {
  // The gap is not necessarily wrong — a record can be legitimately out of
  // scope — but it is now a number somebody can argue with.
  const { chain, addr } = await fresh()
  const r = await chain.call(ATTESTER, addr, 'commitSweep', [1n, 50n, 27520, 20097, EH1])
  assert.equal(r.logs.length, 1)
  const a = r.logs[0].args
  assert.equal(a.index, 0n)
  assert.equal(a.observed, 27520)
  assert.equal(a.attested, 20097)
  assert.equal(a.recordsRoot, EH1)
})

await check('sweeps are append-only, and coverage is queryable by block', async () => {
  const { chain, addr } = await fresh()
  await chain.call(ATTESTER, addr, 'commitSweep', [100n, 200n, 10, 10, ZERO32])
  await chain.call(ATTESTER, addr, 'commitSweep', [201n, 300n, 20, 18, EH1])
  assert.equal((await chain.call(STRANGER, addr, 'sweepCount', [])).result, 2n)
  assert.equal((await chain.call(STRANGER, addr, 'sweepAt', [0n])).result.toBlock, 200n)
  assert.equal((await chain.call(STRANGER, addr, 'latestSweep', [])).result.fromBlock, 201n)

  for (const [b, inside] of [[99n, false], [100n, true], [250n, true], [300n, true], [301n, false]]) {
    assert.equal((await chain.call(STRANGER, addr, 'isWithinSweep', [b])).result, inside, `block ${b}`)
  }
})

await check('a service that never stated its coverage reads as never having stated it', async () => {
  // Not as having covered nothing: the two are different claims and only one
  // of them is true.
  const { chain, addr } = await fresh()
  assert.equal((await chain.call(STRANGER, addr, 'latestSweep', [])).reverted, true)
  assert.equal((await chain.call(STRANGER, addr, 'isWithinSweep', [150n])).result, false)
})

console.log('\nsurface')

await check('the key mirrors the registry tuple exactly', async () => {
  const { chain, addr } = await fresh()
  const k = (await chain.call(STRANGER, addr, 'key', [7n, REVIEWER, 3n])).result
  const { keccak256, encodeAbiParameters: enc } = await import('viem')
  const expected = keccak256(enc(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'uint64' }],
    [7n, REVIEWER, 3n],
  ))
  assert.equal(k, expected)
})

await check('the contract holds no funds and offers no way in', async () => {
  const { readFileSync } = await import('node:fs')
  // The ABI is the real proof for value: it reports the compiler's own view of
  // every entry point, where prose in a comment proves nothing.
  const { ABI } = await import('./harness.mjs')
  const payables = ABI.filter((e) => e.stateMutability === 'payable')
  assert.deepEqual(payables, [], 'no function may accept value')
  assert.ok(!ABI.some((e) => e.type === 'receive' || e.type === 'fallback'), 'no receive or fallback')

  // Comments stripped, so the check is about the code and not about the text
  // describing it.
  const code = readFileSync('contracts/ProvenanceAttestations.sol', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  for (const forbidden of ['payable', 'selfdestruct', 'delegatecall', 'call{', 'import ', 'assembly']) {
    assert.ok(!code.includes(forbidden), `contract code should not contain "${forbidden}"`)
  }
})

await check('every frozen deployment still compiles', async () => {
  // A repository that cannot rebuild the bytecode of a contract it still has
  // live has quietly withdrawn it, and falsifiability is the whole premise.
  const { execFileSync } = await import('node:child_process')
  const { readdirSync } = await import('node:fs')
  const frozen = readdirSync('contracts/deployed').filter((f) => f.endsWith('.sol'))
  assert.ok(frozen.length >= 2, 'v2 and v3 are both live and must both stay buildable')
  for (const f of frozen) {
    const out = execFileSync('node', ['script/compile.mjs'], {
      env: { ...process.env, CONTRACT_SOURCE: `contracts/deployed/${f}` }, encoding: 'utf8',
    })
    assert.match(out, /compiled: ProvenanceAttestations/, `${f} failed to compile`)
  }
  execFileSync('node', ['script/compile.mjs'], { encoding: 'utf8' }) // restore v4 artifacts
})

await check('the frozen v2 source still compiles, so the live deployment stays verifiable', async () => {
  // Falsifiability is the premise: a repository that can no longer reproduce
  // the bytecode of its own live contract has quietly withdrawn it.
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync('node', ['script/compile.mjs'], {
    env: { ...process.env, CONTRACT_SOURCE: 'contracts/deployed/ProvenanceAttestationsV2.sol' },
    encoding: 'utf8',
  })
  assert.match(out, /compiled: ProvenanceAttestations/)
  // Restore the v3 artifacts the rest of the suite and the deploy script use.
  execFileSync('node', ['script/compile.mjs'], { encoding: 'utf8' })
})

console.log(`\n${passed} passed\n`)
