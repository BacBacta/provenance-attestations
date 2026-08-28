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
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { parseClaimsCsv, indexCache, buildAttestations, chunk } from './backfill-lib.mjs'

const DRY = process.env.DRY_RUN !== '0'
const RPC = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'
// Defaults to the full evidence ladder; CLAIMS_CSV still points it at the
// narrower payment-claims file when only those are wanted.
const CLAIMS = process.env.CLAIMS_CSV ?? '../celo-agent-feedback-audit/out/evidence.csv'
const CACHE = process.env.FEEDBACK_CACHE ?? '../celo-agent-feedback-audit/data-bs/feedback-58396729.jsonl'
const BATCH = Number(process.env.BATCH_SIZE ?? 100)
// Batches already written, so an interrupted backfill of ~10,000 rows resumes
// instead of paying twice and doubling every revision counter.
const PROGRESS = process.env.PROGRESS_FILE ?? 'deployments/backfill-progress.json'

for (const [name, path] of [['input csv', CLAIMS], ['feedback cache', CACHE]]) {
  if (!existsSync(path)) {
    console.error(`${name} not found at ${path} — set CLAIMS_CSV / FEEDBACK_CACHE.`)
    process.exit(1)
  }
}

const claims = parseClaimsCsv(readFileSync(CLAIMS, 'utf8'))
const cacheIndex = indexCache(readFileSync(CACHE, 'utf8').split('\n').filter(Boolean))
const { rows, missing } = buildAttestations(claims, cacheIndex)

const NAMES = ['None', 'PaymentVerified', 'EvidenceIntact', 'EvidenceUnbound', 'EvidenceUnhashed',
  'PaymentTxNotFound', 'PaymentTxFailed', 'PaymentNoValue', 'EvidenceUnreachable', 'EvidenceAbsent']
const byVerdict = {}
for (const r of rows) byVerdict[NAMES[r.verdict] ?? r.verdict] = (byVerdict[NAMES[r.verdict] ?? r.verdict] ?? 0) + 1
console.log(`input rows    ${claims.length}`)
console.log(`joined        ${rows.length}`)
console.log('verdicts:')
for (const [k, n] of Object.entries(byVerdict).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${String(n).padStart(6)}`)
}
console.log(`batches       ${Math.ceil(rows.length / BATCH)} of up to ${BATCH}`)
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

let doneBatches = 0
try { doneBatches = JSON.parse(readFileSync(PROGRESS, 'utf8')).completedBatches ?? 0 } catch { /* first run */ }
const allBatches = chunk(rows, BATCH)
if (doneBatches) console.log(`resuming after ${doneBatches} completed batch(es)`)

for (const [i, part] of allBatches.entries()) {
  if (i < doneBatches) continue
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
  console.log(`batch ${i + 1}/${allBatches.length}: ${part.length} attestations — ${receipt.status} — ${hash}`)
  if (receipt.status !== 'success') process.exit(1)
  writeFileSync(PROGRESS, JSON.stringify({ completedBatches: i + 1, of: allBatches.length, updatedAt: new Date().toISOString() }))
}
console.log('\nBackfill complete.')
