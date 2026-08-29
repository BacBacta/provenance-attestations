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
  const res = await fetch(process.env.CELO_RPC_URL ?? 'https://forno.celo.org', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [dep.address, 'latest'] }),
  }).then((r) => r.json()).catch(() => null)
  const onChain = String(res?.result ?? '').replace(/^0x/, '').toLowerCase()
  // Metadata hashes differ per compilation, so compare the body, not the tail.
  const body = (h) => h.slice(0, Math.max(0, h.length - 106))
  if (onChain && body(onChain) !== body(local)) {
    console.error(`The source in out/ does not match the bytecode at ${dep.address}.`)
    console.error('Compile the source that was actually deployed before verifying:')
    console.error('  CONTRACT_SOURCE=contracts/deployed/ProvenanceAttestationsV2.sol npm run compile')
    process.exit(1)
  }
}
const metadata = JSON.parse(readFileSync('out/metadata.json', 'utf8'))
const compilerVersion = `v${metadata.compiler.version}`

// constructor(address initialAttester) — strip 0x, the API wants bare hex.
const constructorArgs = encodeAbiParameters([{ type: 'address' }], [dep.attester]).slice(2)

console.log(`address    ${dep.address}`)
console.log(`compiler   ${compilerVersion}`)
console.log(`attester   ${dep.attester}`)
console.log(`ctor args  ${constructorArgs.slice(0, 24)}…`)

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

// Verification is queued, not instant — poll until the explorer flips the flag.
console.log('\nsubmitted; polling for confirmation…')
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 6000))
  const check = await fetch(`${EXPLORER}/api/v2/addresses/${dep.address}`)
  const body = await check.json().catch(() => ({}))
  if (body.is_verified) {
    console.log(`\n✓ verified — ${EXPLORER}/address/${dep.address}?tab=contract`)
    process.exit(0)
  }
  process.stdout.write(`\r  waiting… ${(i + 1) * 6}s`)
}
console.log('\n\nStill pending. Verification can lag a few minutes; check:')
console.log(`  ${EXPLORER}/address/${dep.address}?tab=contract`)
