/**
 * Register the Provenance attestation service in the ERC-8004 Identity
 * Registry on Celo — the registry it verifies.
 *
 *   DRY_RUN=1 npm run register    # inspect the registration file and args
 *   DRY_RUN=0 npm run register    # send
 *
 * The registration file is served from the public repository at a commit-stable
 * raw URL. That choice is deliberate: the audit behind this service found that
 * 76% of the evidence files referenced by this very registry are dead links.
 * An attestation service whose own metadata rots would be self-refuting.
 */
import { createWalletClient, createPublicClient, http, parseAbi, decodeEventLog } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const DRY = process.env.DRY_RUN !== '0'
const RPC = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
const AGENT_URI =
  process.env.AGENT_URI ??
  'https://raw.githubusercontent.com/BacBacta/provenance-attestations/main/agent.json'

// Exact signatures read from the verified registry implementation, not guessed.
const ABI = parseAbi([
  'function register(string agentURI) external returns (uint256 agentId)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
])

const local = JSON.parse(readFileSync('agent.json', 'utf8'))
console.log(`name       ${local.name}`)
console.log(`services   ${local.services.map((s) => s.name).join(', ')}`)
console.log(`agentURI   ${AGENT_URI}`)
console.log(`registry   ${IDENTITY_REGISTRY}`)

// A registration pointing at an unreachable file is exactly the failure this
// project exists to measure, so the URI is fetched and compared before sending.
process.stdout.write('\nchecking the URI resolves… ')
try {
  const res = await fetch(AGENT_URI)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const remote = await res.json()
  if (remote.name !== local.name) throw new Error('remote file does not match local agent.json')
  console.log('ok, and matches the local file')
} catch (e) {
  console.log(`FAILED — ${e.message}`)
  console.error('\nPush agent.json to the repository first; the registration must not')
  console.error('point at a file that does not resolve.')
  process.exit(1)
}

if (DRY) {
  console.log('\nDRY RUN — nothing sent. Re-run with DRY_RUN=0 to register.')
  process.exit(0)
}

const PK = (process.env.PRIVATE_KEY ?? '').trim()
if (!PK) { console.error('PRIVATE_KEY is not set.'); process.exit(1) }
const account = privateKeyToAccount(PK.startsWith('0x') ? PK : `0x${PK}`)
const pub = createPublicClient({ chain: celo, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: celo, transport: http(RPC) })

console.log(`\nregistering as ${account.address}…`)
const hash = await wallet.writeContract({
  address: IDENTITY_REGISTRY,
  abi: ABI,
  functionName: 'register',
  args: [AGENT_URI],
})
const receipt = await pub.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') { console.error('Registration reverted.'); process.exit(1) }

let agentId
for (const log of receipt.logs) {
  try {
    const ev = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics })
    if (ev.eventName === 'Registered') agentId = ev.args.agentId
  } catch { /* other events in the same tx */ }
}

mkdirSync('deployments', { recursive: true })
writeFileSync(
  'deployments/erc8004.json',
  JSON.stringify(
    { agentId: agentId?.toString(), agentURI: AGENT_URI, registry: IDENTITY_REGISTRY,
      owner: account.address, txHash: hash, block: receipt.blockNumber.toString(),
      registeredAt: new Date().toISOString() },
    null, 2,
  ),
)

console.log(`\n✓ registered — agentId ${agentId}`)
console.log(`tx        ${hash}`)
console.log(`explorer  https://celo.blockscout.com/tx/${hash}`)
console.log(`8004scan  https://8004scan.io/agent/celo/${agentId}`)
