/**
 * Classifying RPC failures, against the strings these nodes actually emit.
 *
 * The case that matters most is the one that stopped a paid run: viem buries
 * the node's reason three levels deep, and a classifier that reads only
 * `err.message` sees "RPC Request failed." — which says nothing about nonces.
 */
import assert from 'node:assert/strict'
import { classifyRpcError, errorText, backoffMs, MAX_ATTEMPTS } from '../script/rpc-retry.mjs'

let passed = 0
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}`); throw e }
}

/** The shape viem threw on batch 20 of the real run, trimmed to its structure. */
const realNonceError = {
  name: 'ContractFunctionExecutionError',
  message: 'The contract function "attestBatch" reverted.',
  shortMessage: 'Nonce provided for the transaction is lower than the current nonce of the account.\nTry increasing the nonce or find the latest nonce with `getTransactionCount`.',
  details: 'nonce too low: next nonce 229, tx nonce 228',
  metaMessages: ['Request Arguments:', '  from:  0xC2Dc…'],
  cause: {
    name: 'NonceTooLowError',
    shortMessage: 'Nonce provided for the transaction is lower than the current nonce of the account.',
    details: 'nonce too low: next nonce 229, tx nonce 228',
    cause: { code: -32000, message: 'nonce too low: next nonce 229, tx nonce 228' },
  },
}

check('the real nonce failure is recognised, not swallowed as unknown', () => {
  const { kind } = classifyRpcError(realNonceError)
  assert.equal(kind, 'nonce-low')
})

check('the reason is read from every level viem hides it in', () => {
  // Reading only `message` yields "The contract function ... reverted." — which
  // would have classified this as fatal and stopped the run for good.
  const onlyMessage = { message: realNonceError.message }
  assert.notEqual(classifyRpcError(onlyMessage).kind, 'nonce-low')
  assert.ok(errorText(realNonceError).includes('next nonce 229'))
})

check('a nonce buried only in a deep cause is still found', () => {
  const deep = { message: 'RPC Request failed.', cause: { cause: { cause: { message: 'nonce too low' } } } }
  assert.equal(classifyRpcError(deep).kind, 'nonce-low')
})

check('transport failures are transient', () => {
  for (const m of [
    'fetch failed', 'socket hang up', 'ETIMEDOUT', 'ECONNRESET', 'request timed out',
    'HTTP request failed. Status: 503 Service Unavailable', '429 Too Many Requests',
    'Status: 502 Bad Gateway', 'EAI_AGAIN forno.celo.org',
  ]) {
    assert.equal(classifyRpcError({ details: m }).kind, 'transient', m)
  }
})

check('a real refusal is fatal, and retrying it is never proposed', () => {
  for (const m of [
    'insufficient funds for gas * price + value',
    'execution reverted',
    'intrinsic gas too low',
    'nonce too high',
  ]) {
    assert.equal(classifyRpcError({ details: m }).kind, 'fatal', m)
  }
})

check('a refusal dressed in transport wording still stops the run', () => {
  // Some nodes return a revert inside a 502. Retrying a revert costs gas and
  // changes nothing, so the tie goes to stopping.
  const both = { details: 'HTTP 502: execution reverted' }
  assert.equal(classifyRpcError(both).kind, 'fatal')
})

check('"already known" is treated as the nonce case, not as transient', () => {
  // The node has this exact transaction. Re-broadcasting it forever would spin;
  // adopting the chain's nonce moves the run forward.
  assert.equal(classifyRpcError({ details: 'already known' }).kind, 'nonce-low')
  assert.equal(classifyRpcError({ details: 'replacement transaction underpriced' }).kind, 'nonce-low')
})

check('an unrecognised failure is unknown, and unknown is retried, not ignored', () => {
  const { kind } = classifyRpcError({ details: 'the moon is in the wrong phase' })
  assert.equal(kind, 'unknown')
  // The send loop retries everything that is not fatal, so an unfamiliar
  // message gets the benefit of the doubt rather than ending a paid run.
  assert.notEqual(kind, 'fatal')
})

check('an empty error is unknown rather than crashing the classifier', () => {
  for (const e of [null, undefined, {}, { cause: null }]) {
    assert.equal(classifyRpcError(e).kind, 'unknown')
  }
})

check('a self-referential cause chain terminates', () => {
  const loop = { message: 'a' }
  loop.cause = loop
  assert.equal(classifyRpcError(loop).kind, 'unknown')
})

check('backoff grows and is capped', () => {
  assert.equal(backoffMs(1), 2000)
  assert.equal(backoffMs(2), 4000)
  assert.equal(backoffMs(3), 8000)
  assert.equal(backoffMs(10), 30_000)
  // Six attempts is a little over a minute of waiting before giving up, which
  // is long enough to outlast a node restart and short enough that an operator
  // watching 105 batches notices.
  let total = 0
  for (let i = 1; i < MAX_ATTEMPTS; i++) total += backoffMs(i)
  assert.ok(total >= 60_000 && total <= 180_000, `total wait ${total}ms`)
})

console.log(`\n${passed} passed\n`)
