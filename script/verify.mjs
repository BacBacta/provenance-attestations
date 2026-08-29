/**
 * Submit the contract source to Blockscout for verification.
 *
 *   npm run verify
 *
 * Uses the standard-JSON-input route, which is the only one that reproduces
 * bytecode reliably: the explorer recompiles with the exact same settings the
 * deployment used (optimizer runs, evmVersion, metadata hash), rather than
 * guessing them from a flattened file.
 *
 * Constructor arguments are encoded from the recorded deployment rather than
 * auto-detected — the attester address is known exactly, and a wrong guess is
 * the most common reason a correct source fails to verify.
 */
import { readFileSync, existsSync } from 'node:fs'
import { encodeAbiParameters } from 'viem'

const EXPLORER = process.env.EXPLORER ?? 'https://celo.blockscout.com'

if (!existsSync('deployments/celo.json')) {
  console.error('deployments/celo.json not found — deploy first.')
  process.exit(1)
}
const dep = JSON.parse(readFileSync('deployments/celo.json', 'utf8'))
const standardInput = readFileSync('out/standard-input.json', 'utf8')

/**
 * Submitting a source that cannot produce the deployed bytecode wastes the
 * explorer's time and, worse, leaves a contract looking unverifiable when it is
 * simply being described by the wrong file. `out/` is whatever was compiled
 * last, which after the source moved to v3 was no longer the contract recorded
 * in deployments/celo.json.
 */
const deployedPath = 'out/ProvenanceAttestations.deployed.bin'
if (existsSync(deployedPath)) {
  const local = readFileSync(deployedPath, 'utf8').trim().toLowerCase()
  /**
   * An unanswered question is not a match.
   *
   * `.catch(() => null)` and a JSON-RPC error both left `onChain` empty, and
   * the guard began with `if (onChain && …)` — so any transport failure or
   * node error skipped the comparison entirely and the script went on to
   * submit a source it had never confronted with the chain. That is the exact
   * mistake this block exists to prevent, made by the block itself.
   */
  let res
  try {
    res = await fetch(process.env.CELO_RPC_URL ?? 'https://forno.celo.org', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [dep.address, 'latest'] }),
    }).then((r) => r.json())
  } catch (e) {
    console.error(`Cannot read the bytecode at ${dep.address}: ${e.message}`)
    console.error('Refusing to submit a source that was never compared with the chain.')
    process.exit(1)
  }
  if (res?.error || typeof res?.result !== 'string') {
    console.error(`The node did not return code for ${dep.address}: ${JSON.stringify(res?.error ?? res)}`)
    console.error('Refusing to submit a source that was never compared with the chain.')
    process.exit(1)
  }
  const onChain = res.result.replace(/^0x/, '').toLowerCase()
  if (!onChain) {
    console.error(`There is no contract at ${dep.address}.`)
    process.exit(1)
  }
  // Metadata hashes differ per compilation, so compare the body, not the tail.
  const body = (h) => h.slice(0, Math.max(0, h.length - 106))
  if (body(onChain) !== body(local)) {
    console.error(`The source in out/ does not match the bytecode at ${dep.address}.`)
    console.error('Compile the source that was actually deployed before verifying, e.g.')
    console.error(`  CONTRACT_SOURCE=contracts/deployed/ProvenanceAttestationsV${dep.version ? String(dep.version).split('.')[0] : '3'}.sol npm run compile`)
    console.error('  (then re-run this script; npm run verify would recompile the current source)')
    process.exit(1)
  }
}
const metadata = JSON.parse(readFileSync('out/metadata.json', 'utf8'))
const compilerVersion = `v${metadata.compiler.version}`

/**
 * constructor(address initialAttester) — strip 0x, the API wants bare hex.
 *
 * `attester` in the record is what the contract answered when it was
 * deployed, and rotating it is the OWNER'S ONLY POWER: after one setAttester
 * the recorded value is no longer the constructor argument, the encoded args
 * stop matching the creation transaction, and verification fails with nothing
 * explaining why. `constructorAttester` is written by deploy.mjs as the
 * argument it actually passed; the older field is the fallback, with a warning
 * rather than silence.
 */
if (!dep.constructorAttester) {
  console.log('  ! this record predates constructorAttester; using the recorded attester.')
  console.log('    If it has been rotated since deployment, verification will fail here.')
}
const ctorAttester = dep.constructorAttester ?? dep.attester
const constructorArgs = encodeAbiParameters([{ type: 'address' }], [ctorAttester]).slice(2)

console.log(`address    ${dep.address}`)
console.log(`compiler   ${compilerVersion}`)
console.log(`ctor arg   ${ctorAttester}  (attester at deployment)`)
console.log(`ctor args  ${constructorArgs.slice(0, 24)}…`)

/**
 * The flag's state BEFORE this submission, so a tick afterwards means this
 * build was published rather than that the address had been verified once.
 */
const wasVerifiedBefore = await fetch(`${EXPLORER}/api/v2/addresses/${dep.address}`)
  .then((r) => r.json()).then((b) => b?.is_verified === true).catch(() => false)
if (wasVerifiedBefore) {
  console.log('  ! this address already reads as verified; a tick below will not prove')
  console.log('    that THIS build is the published one.')
}

const form = new FormData()
form.append('compiler_version', compilerVersion)
form.append('license_type', 'mit')
form.append('autodetect_constructor_args', 'false')
form.append('constructor_args', constructorArgs)
form.append(
  'files[0]',
  new Blob([standardInput], { type: 'application/json' }),
  'standard-input.json',
)

const url = `${EXPLORER}/api/v2/smart-contracts/${dep.address}/verification/via/standard-input`
console.log(`\nsubmitting to ${url}`)

const res = await fetch(url, { method: 'POST', body: form })
const text = await res.text()
console.log(`HTTP ${res.status}`)
console.log(text.slice(0, 600))

if (res.status >= 400) {
  console.error('\nSubmission rejected. The web form is the fallback:')
  console.error(`  ${EXPLORER}/address/${dep.address}/contract-verification`)
  console.error('  Standard JSON input → out/standard-input.json → compiler ' + compilerVersion)
  process.exit(1)
}

/**
 * `is_verified` is a property of the ADDRESS, not a result of this submission.
 *
 * It is already true if the contract was verified earlier — by the web form,
 * by an automatic match, by a previous run — so the loop printed a tick for a
 * submission that may have been rejected outright, and the operator walked
 * away believing this build was the one published. It is read once BEFORE
 * submitting, and a tick afterwards means the flag CHANGED.
 */
console.log('\nsubmitted; polling for confirmation…')
let verified = false
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 6000))
  const check = await fetch(`${EXPLORER}/api/v2/addresses/${dep.address}`)
  const body = await check.json().catch(() => ({}))
  if (body.is_verified) { verified = true; break }
  process.stdout.write(`\r  waiting… ${(i + 1) * 6}s`)
}
if (verified) {
  if (wasVerifiedBefore) {
    console.log(`\n· the address already read as verified before this submission, so the`)
    console.log('  flag says nothing about THIS build. Compare the published source by hand:')
    console.log(`  ${EXPLORER}/address/${dep.address}?tab=contract`)
    process.exit(0)
  }
  console.log(`\n✓ verified — ${EXPLORER}/address/${dep.address}?tab=contract`)
  process.exit(0)
}
console.log('\n\nStill pending. Verification can lag a few minutes; check:')
console.log(`  ${EXPLORER}/address/${dep.address}?tab=contract`)
