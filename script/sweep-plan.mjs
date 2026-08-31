/**
 * Where the next sweep starts and ends, and what its snapshot will be called.
 *
 * Both are pure, because both were done by hand twice and both are the kind of
 * arithmetic that is obviously right until it is off by one. The frontier is the
 * contract's own `coverage()`, so the range cannot be guessed: `commitSweep`
 * refuses a claim starting more than one block past what is already covered, and
 * refuses one that does not advance the frontier at all.
 */

/** Blocks left unswept at the head, so a reorg cannot orphan an attested range. */
export const DEFAULT_CONFIRMATIONS = 100n

/**
 * A range worth paying for. Below this the fixed cost of a transaction and a
 * coverage claim dominates, and the honest thing is to wait rather than publish
 * a claim about almost nothing.
 */
export const MIN_SPAN = 1_000n

export function nextRange({ coveredFrom, coveredTo, liveClaims, head, deployBlock, confirmations = DEFAULT_CONFIRMATIONS, minSpan = MIN_SPAN }) {
  const to = head - confirmations
  if (to <= 0n) return { ok: false, reason: 'head-too-low', lines: [`The chain head (${head}) is below the confirmation margin (${confirmations}).`] }

  /**
   * With no standing claim the frontier does not exist yet, so the first sweep
   * starts where the registry does. Anywhere later would silently declare the
   * blocks before it out of scope forever: `commitSweep` refuses a later claim
   * that reaches back before where coverage began.
   */
  const from = liveClaims === 0n ? deployBlock : coveredTo + 1n

  if (from > to) {
    return {
      ok: false, reason: 'nothing-new',
      lines: [
        `Coverage already reaches block ${coveredTo}, and the safe head is ${to}.`,
        `Nothing new to sweep. ${from - to} more block(s) must be mined and confirmed.`,
      ],
    }
  }
  const span = to - from + 1n
  if (span < minSpan) {
    return {
      ok: false, reason: 'too-soon',
      lines: [
        `Only ${span} block(s) since the frontier at ${coveredTo}.`,
        `Below ${minSpan} the fixed cost of a batch and a coverage claim dominates.`,
        `Set MIN_SPAN=${span} to sweep anyway.`,
      ],
    }
  }
  return { ok: true, fromBlock: from, toBlock: to, span, firstEver: liveClaims === 0n }
}

/**
 * The published snapshot's basename, derived rather than typed.
 *
 * Typing it is what produced a 286-character command line, pasted twice on a
 * phone, in which a single wrong character would have paired one run's coverage
 * claim with another run's verdicts. Every part of the name is load-bearing:
 * both endpoints, because a windowed run and a full-history run can end at the
 * same head; the rules NAME, because what counts as a dead file is a property of
 * how it was asked for; and the rules FINGERPRINT, which digests every setting
 * that could change a verdict.
 */
export function snapshotBase(manifest) {
  for (const field of ['fromBlock', 'toBlock', 'retrievalRulesName', 'retrievalRules']) {
    if (manifest?.[field] === undefined || manifest[field] === null || manifest[field] === '') {
      return { ok: false, lines: [`The manifest has no ${field}, so its snapshot cannot be named.`] }
    }
  }
  return {
    ok: true,
    base: `audit-${manifest.fromBlock}-${manifest.toBlock}-${manifest.retrievalRulesName}-${manifest.retrievalRules}`,
  }
}

/**
 * Rough cost, bracketed, from what the completed sweeps actually paid.
 *
 * 93,579 gas per row measured on payment-bearing rows and 47,529 on the
 * cheapest — a blend of the two is what misled an earlier estimate by 45%, so
 * this quotes a range and never a number.
 *
 * The first version added a flat per-transaction cost to the low end and a
 * per-batch one to the high end, which inverted the bracket at zero rows: it
 * printed "0.0346 – 0.0304 CELO", a low above its own high. Both ends now count
 * the same batches, and the coverage claim's own cost is itself a range,
 * bracketing the 83,284 gas measured against a fresh contract and the 137,392
 * measured on chain.
 */
export function estimate({ rows, gasPriceWei }) {
  const n = BigInt(rows)
  const batches = BigInt(Math.ceil(rows / 100))
  const lo = n * 47_529n + batches * 21_000n + 80_000n
  const hi = n * 93_579n + batches * 21_000n + 160_000n
  return { lowGas: lo, highGas: hi, lowWei: lo * BigInt(gasPriceWei), highWei: hi * BigInt(gasPriceWei) }
}

/**
 * Is this manifest the run we just asked for, or the one before it?
 *
 * The first version of the sweep checked that the local manifest and the
 * published one agreed — and they did, perfectly, because both were the same
 * stale file. The audit exits early without writing anything when a window holds
 * no feedback records, so `out/` still held the previous run, `publish-report`
 * republished it unchanged, and the sweep handed the PREVIOUS export to the
 * backfill as if it were new. A check that verifies agreement is not a check
 * that verifies freshness, and only the range can tell them apart.
 */
export function manifestMatchesPlan(manifest, plan) {
  const from = String(manifest?.fromBlock ?? '')
  const to = String(manifest?.toBlock ?? '')
  if (from === String(plan.fromBlock) && to === String(plan.toBlock)) return { ok: true }
  return {
    ok: false,
    lines: [
      'The manifest does not describe the range this sweep just asked for.',
      `  asked for  ${plan.fromBlock}–${plan.toBlock}`,
      `  manifest   ${from || '(none)'}–${to || '(none)'}`,
      'The audit writes nothing when a window holds no feedback records, so this',
      'is almost certainly the previous run still sitting in out/. Attesting it',
      "would re-send an already-published export under this sweep's name.",
    ],
  }
}
