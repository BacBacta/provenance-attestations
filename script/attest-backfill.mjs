/**
 * Publish the audit's verdicts on chain — the first real activity of the
 * Provenance attestation contract.
 *
 *   DRY_RUN=1 npm run backfill      # default: print what would be written
 *   DRY_RUN=0 npm run backfill      # actually send
 *
 * Reads the audit's claims.csv and joins it against the audit's event cache to
 * recover each record's feedbackIndex. Anything that fails the join is listed,
 * never silently dropped — an attestation ledger must not begin its life by
 * quietly losing rows.
 */
import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { readFileSync, existsSync } from 'node:fs'
import { parseClaimsCsv, indexCache, buildAttestations, chunk } from './backfill-lib.mjs'

const DRY = process.env.DRY_RUN !== '0'
const RPC = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'
const CLAIMS = process.env.CLAIMS_CSV ?? '../celo-agent-feedback-audit/out/claims.csv'
const CACHE = process.env.FEEDBACK_CACHE ?? '../celo-agent-feedback-audit/data-bs/feedback-58396729.jsonl'
const BATCH = Number(process.env.BATCH_SIZE ?? 60)

for (const [name, path] of [['claims.csv', CLAIMS], ['feedback cache', CACHE]]) {
  if (!existsSync(path)) {
    console.error(`${name} not found at ${path} — set CLAIMS_CSV / FEEDBACK_CACHE.`)
    process.exit(1)
  }
}

const claims = parseClaimsCsv(readFileSync(CLAIMS, 'utf8'))
const cacheIndex = indexCache(readFileSync(CACHE, 'utf8').split('\n').filter(Boolean))
const { rows, missing } = buildAttestations(claims, cacheIndex)

const byVerdict = {}
for (const r of rows) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1
console.log(`claims        ${claims.length}`)
console.log(`joined        ${rows.length}`)
console.log(`verdicts      ${JSON.stringify(byVerdict)}  (1=verified 2=notfound 3=failed 4=novalue)`)
if (missing.length) {
  console.log(`\nNOT JOINED (${missing.length}) — investigate before a real run:`)
  for (const m of missing) console.log(`  agent ${m.agentId} reviewer ${m.reviewer} uri ${m.feedbackURI}`)
}

if (DRY) {
  console.log('\nDRY RUN — nothing sent. Re-run with DRY_RUN=0 to write on chain.')
  process.exit(missing.length ? 2 : 0)
}

const PK = process.env.PRIVATE_KEY
if (!PK) { console.error('PRIVATE_KEY is not set.'); process.exit(1) }
const deployment = JSON.parse(readFileSync('deployments/celo.json', 'utf8'))
const abi = JSON.parse(readFileSync('out/ProvenanceAttestations.abi.json', 'utf8'))
const account = privateKeyToAccount(PK.startsWith('0x') ? PK : `0x${PK}`)
const pub = createPublicClient({ chain: celo, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: celo, transport: http(RPC) })

console.log(`\ncontract      ${deployment.address}`)
console.log(`attester      ${account.address}`)

for (const [i, part] of chunk(rows, BATCH).entries()) {
  const hash = await wallet.writeContract({
    address: deployment.address,
    abi,
    functionName: 'attestBatch',
    args: [
      part.map((r) => r.agentId),
      part.map((r) => r.clientAddress),
      part.map((r) => r.feedbackIndex),
      part.map((r) => r.verdict),
      part.map((r) => r.paymentTx),
      part.map((r) => r.evidenceHash),
    ],
  })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  console.log(`batch ${i + 1}: ${part.length} attestations — ${receipt.status} — ${hash}`)
  if (receipt.status !== 'success') process.exit(1)
}
console.log('\nBackfill complete.')
