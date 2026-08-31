/**
 * Where the next sweep starts, and what its snapshot is called.
 *
 * Both were done by hand twice, and both are the arithmetic that looks obviously
 * right until it is off by one — at which point `commitSweep` refuses the claim
 * on chain, after the batches have been paid for. The contract's rules are the
 * specification here: a claim may not start more than one block past the
 * frontier, may not fail to advance it, and may not reach back before coverage
 * began.
 */
import assert from 'node:assert/strict'
import { nextRange, snapshotBase, estimate, manifestMatchesPlan, DEFAULT_CONFIRMATIONS, MIN_SPAN } from '../script/sweep-plan.mjs'

let passed = 0
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}`); throw e }
}

const DEPLOY = 58_396_729n
const base = {
  coveredFrom: 58_396_729n, coveredTo: 76_273_643n, liveClaims: 2n,
  head: 76_400_000n, deployBlock: DEPLOY,
}

check('the next range begins exactly one block past the frontier', () => {
  // Not two: CoverageGap. Not zero: InvalidRange, the claim must advance.
  const r = nextRange(base)
  assert.ok(r.ok)
  assert.equal(r.fromBlock, 76_273_644n)
  assert.equal(r.toBlock, 76_400_000n - DEFAULT_CONFIRMATIONS)
})

check('the head is left unswept by the confirmation margin', () => {
  // An attested range that a reorg orphans is a verdict about blocks that no
  // longer exist, and the coverage claim cannot be withdrawn selectively.
  const r = nextRange({ ...base, confirmations: 500n })
  assert.ok(r.ok)
  assert.equal(r.toBlock, 76_400_000n - 500n)
})

check('the first sweep ever starts at the registry, not at the head', () => {
  // With no standing claim there is no frontier. Starting later would declare
  // every earlier block out of scope for good: the contract refuses a later
  // claim that reaches back before coverage began.
  const r = nextRange({ ...base, liveClaims: 0n, coveredFrom: 0n, coveredTo: 0n })
  assert.ok(r.ok)
  assert.equal(r.fromBlock, DEPLOY)
  assert.equal(r.firstEver, true)
})

check('a frontier already at the safe head is nothing to do, not an error', () => {
  const r = nextRange({ ...base, coveredTo: 76_399_950n })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'nothing-new')
  assert.ok(r.lines.join(' ').includes('more block(s) must be mined'))
})

check('a frontier past the safe head is also nothing to do, not a negative span', () => {
  // Possible after a deep reorg or a confirmations bump: coveredTo can exceed
  // head - confirmations. Subtracting would produce an inverted range.
  const r = nextRange({ ...base, coveredTo: 76_400_000n })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'nothing-new')
})

check('a span too small to be worth paying for is refused, and says how to override', () => {
  const r = nextRange({ ...base, head: base.coveredTo + DEFAULT_CONFIRMATIONS + 50n })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'too-soon')
  assert.ok(r.lines.join(' ').includes('MIN_SPAN=50'), r.lines.join(' '))
})

check('exactly MIN_SPAN blocks is enough, one fewer is not', () => {
  const at = nextRange({ ...base, head: base.coveredTo + DEFAULT_CONFIRMATIONS + MIN_SPAN })
  assert.ok(at.ok, 'the boundary is inclusive')
  assert.equal(at.span, MIN_SPAN)
  const under = nextRange({ ...base, head: base.coveredTo + DEFAULT_CONFIRMATIONS + MIN_SPAN - 1n })
  assert.ok(!under.ok)
})

check('a head below the confirmation margin is refused rather than going negative', () => {
  const r = nextRange({ ...base, head: 50n, confirmations: 100n })
  assert.ok(!r.ok)
  assert.equal(r.reason, 'head-too-low')
})

check('the snapshot name is derived from the manifest, both endpoints included', () => {
  // Both endpoints, because a windowed run and a full-history run can end at the
  // same head and are different measurements. The rules NAME because what counts
  // as a dead file depends on how it was asked for; the FINGERPRINT because it
  // digests every setting that could change a verdict.
  const r = snapshotBase({
    fromBlock: '76199591', toBlock: '76273643',
    retrievalRulesName: 'r8-ssrf-cid-datauri', retrievalRules: 'c938a5c3008b50a2',
  })
  assert.ok(r.ok)
  assert.equal(r.base, 'audit-76199591-76273643-r8-ssrf-cid-datauri-c938a5c3008b50a2')
})

check('a manifest missing any naming field is refused, not defaulted', () => {
  // An earlier version defaulted a missing rules name to the literal "rules"
  // and published `audit-…-rules-<fp>` — a filename that invented part of what
  // it claimed to describe.
  const full = {
    fromBlock: '1', toBlock: '2', retrievalRulesName: 'r8', retrievalRules: 'abc',
  }
  for (const f of Object.keys(full)) {
    const partial = { ...full, [f]: undefined }
    const r = snapshotBase(partial)
    assert.ok(!r.ok, `${f} missing should be refused`)
    assert.ok(r.lines.join(' ').includes(f))
  }
  assert.ok(!snapshotBase({ ...full, retrievalRulesName: '' }).ok, 'empty is missing too')
  assert.ok(!snapshotBase(undefined).ok)
})

check('the cost estimate is a range, because a blended average was wrong by 45%', () => {
  const e = estimate({ rows: 17, gasPriceWei: 202_500_000_000n })
  // The 17-row sweep actually consumed 1,728,235 gas. It must fall inside.
  assert.ok(e.lowGas < 1_728_235n, `low ${e.lowGas} should be under the measured 1,728,235`)
  assert.ok(e.highGas > 1_728_235n, `high ${e.highGas} should be over the measured 1,728,235`)
  assert.ok(e.lowWei < e.highWei)
})

check('the estimate brackets the large backfill too', () => {
  // 10,469 rows actually consumed 629,314,830 gas, blended across cheap and
  // expensive rows. A bracket that missed it would be a bracket in name only.
  const e = estimate({ rows: 10_469, gasPriceWei: 202_500_000_000n })
  assert.ok(e.lowGas < 629_314_830n, `low ${e.lowGas}`)
  assert.ok(e.highGas > 629_314_830n, `high ${e.highGas}`)
})

check('a manifest from the previous run is caught by its range, not by agreement', () => {
  // The bug this exists for, reproduced. The audit exits early and writes
  // nothing when a window holds no feedback records, so out/ still held the
  // previous run; publish-report republished it unchanged; and every check that
  // compared the local manifest with the published one agreed perfectly,
  // because they were the same stale file. Only the range tells them apart.
  const plan = { fromBlock: 76_273_644n, toBlock: 76_289_889n }
  const stale = { fromBlock: '76199591', toBlock: '76273643', observedRoot: '0xbec8', exportedRows: 17 }
  const r = manifestMatchesPlan(stale, plan)
  assert.ok(!r.ok)
  const t = r.lines.join(' ')
  assert.ok(t.includes('76273644') && t.includes('76199591'), t)
  assert.ok(t.includes('no feedback records'), t)
})

check('the matching manifest passes, compared as strings not as types', () => {
  // The manifest stores block numbers as strings and the plan carries BigInts.
  // A === between them is always false, which would refuse every honest run.
  const plan = { fromBlock: 76_199_591n, toBlock: 76_273_643n }
  assert.ok(manifestMatchesPlan({ fromBlock: '76199591', toBlock: '76273643' }, plan).ok)
  assert.ok(manifestMatchesPlan({ fromBlock: 76199591, toBlock: 76273643 }, plan).ok, 'numbers too')
})

check('a manifest missing its range is stale, not accepted by default', () => {
  const plan = { fromBlock: 1n, toBlock: 2n }
  assert.ok(!manifestMatchesPlan({}, plan).ok)
  assert.ok(!manifestMatchesPlan(undefined, plan).ok)
  // A manifest whose range is blank must not match a real plan by coercion.
  assert.ok(!manifestMatchesPlan({ fromBlock: '', toBlock: '' }, plan).ok)
  assert.ok(!manifestMatchesPlan({ fromBlock: null, toBlock: null }, plan).ok)
  // And the reported range says "(none)" rather than printing an empty gap.
  assert.ok(manifestMatchesPlan({}, plan).lines.join(' ').includes('(none)'))
})

console.log(`\n${passed} passed\n`)
