/**
 * Decide what an RPC failure means, as a pure function.
 *
 * Written after a backfill of 105 paid transactions died on its twentieth with
 * `nonce too low: next nonce 229, tx nonce 228` — 1,900 attestations already on
 * chain and 18.29 CELO already spent. Nothing was corrupt and nothing was lost;
 * the run simply stopped, and a run that stops halfway through a public ledger
 * is the failure this whole script exists to avoid.
 *
 * The classification lives apart from the sending so it can be tested against
 * the exact strings these nodes emit, rather than being reasoned about once and
 * then trusted forever.
 */

/**
 * The node already has this nonce. With a locally managed counter this should
 * be unreachable; it is classified anyway because "unreachable" was the
 * assumption that produced the failure above.
 */
const NONCE_LOW = /nonce too low|nonce is too low|OldNonce|already known|replacement transaction underpriced/i

/**
 * The request did not arrive, or its answer did not come back. Retrying the
 * same signed payload is safe: the node either never saw it, or saw it and will
 * reject the duplicate by nonce.
 */
const TRANSIENT = /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|fetch failed|failed to fetch|rate ?limit|too many requests|\b(429|500|502|503|504)\b|service unavailable|bad gateway|internal error/i

/**
 * Names a real refusal by the chain: retrying changes nothing and only costs
 * gas. `insufficient funds` is here rather than under transient because a
 * balance does not recover by itself, and a loop that retries it would burn the
 * operator's attention while the run goes nowhere.
 */
const FATAL = /insufficient funds|execution reverted|intrinsic gas|exceeds block gas limit|invalid sender|gas required exceeds|oversized data|nonce too high/i

/**
 * Pull every string an RPC error might hide its reason in.
 *
 * viem nests the node's message three deep — `details`, `shortMessage`,
 * `cause.message` — and which one carries the text varies by node and by error.
 * Reading only `message` is why the first version of this classified a nonce
 * error as unknown.
 */
export function errorText(err) {
  const parts = []
  const walk = (e, depth) => {
    if (!e || depth > 4) return
    for (const k of ['details', 'shortMessage', 'message', 'reason']) {
      if (typeof e[k] === 'string') parts.push(e[k])
    }
    if (Array.isArray(e.metaMessages)) parts.push(...e.metaMessages.filter((m) => typeof m === 'string'))
    walk(e.cause, depth + 1)
  }
  walk(err, 0)
  return parts.join(' | ')
}

/**
 * `fatal` wins over `transient` deliberately.
 *
 * A revert served with a 502 is still a revert, and several of these nodes
 * decorate a real refusal with transport wording. Retrying a refusal is the
 * expensive mistake; retrying something that was actually fatal costs a
 * confusing message, so the tie goes to stopping.
 */
export function classifyRpcError(err) {
  const text = errorText(err)
  if (!text) return { kind: 'unknown', text: '' }
  if (FATAL.test(text)) return { kind: 'fatal', text }
  if (NONCE_LOW.test(text)) return { kind: 'nonce-low', text }
  if (TRANSIENT.test(text)) return { kind: 'transient', text }
  return { kind: 'unknown', text }
}

/** Exponential backoff, capped, in milliseconds. */
export function backoffMs(attempt) {
  return Math.min(2000 * 2 ** (attempt - 1), 30_000)
}

export const MAX_ATTEMPTS = 6
