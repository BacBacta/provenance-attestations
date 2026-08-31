import { createPublicClient, http } from 'viem'
import { celo } from 'viem/chains'
import { readFileSync } from 'node:fs'
import { parseClaimsCsvStrict, indexCache, buildAttestations, chunk, toClaimStruct } from './script/backfill-lib.mjs'

const dep = JSON.parse(readFileSync('deployments/celo.json', 'utf8'))
const abi = JSON.parse(readFileSync('out/ProvenanceAttestations.abi.json', 'utf8'))
const pub = createPublicClient({ chain: celo, transport: http('https://forno.celo.org') })

console.log('contrat   ', dep.address)
console.log('attester() =', await pub.readContract({ address: dep.address, abi, functionName: 'attester' }))
console.log('owner()    =', await pub.readContract({ address: dep.address, abi, functionName: 'owner' }))
console.log('sender     =', dep.attester)

const CSV = process.env.CLAIMS_CSV ?? '../celo-agent-feedback-audit/out/evidence.csv'
const CACHE = process.env.FEEDBACK_CACHE ?? '../celo-agent-feedback-audit/data-bs/feedback-58396729.jsonl'

const parsed = parseClaimsCsvStrict(readFileSync(CSV, 'utf8'))
const cache = parsed.header.includes('feedbackIndex')
  ? { map: new Map(), collisions: [] }
  : indexCache(readFileSync(CACHE, 'utf8').split('\n').filter(Boolean))
const { rows, missing, rejected, duplicateTxs, cacheCollisions } = buildAttestations(parsed.rows, cache)

console.log('lignes    =', parsed.rows.length, '| jointes:', rows.length)
for (const [label, list] of [['malformées', parsed.malformed], ['rejetées', rejected], ['non jointes', missing], ['collisions de clé', cacheCollisions]]) {
  if (list.length) console.log(`  ${label}: ${list.length}`)
}
if (duplicateTxs.length) console.log(`  transactions réutilisées: ${duplicateTxs.length}`)
if (!rows.length) { console.log('\nRien à simuler.'); process.exit(1) }

const part = chunk(rows, 100)[0]
console.log('lot 1     =', part.length, 'lignes, verdicts min/max:', Math.min(...part.map(r=>r.verdict)), '/', Math.max(...part.map(r=>r.verdict)))

try {
  const { request } = await pub.simulateContract({
    account: dep.attester,
    address: dep.address,
    abi,
    functionName: 'attestBatch',
    args: [part.map(toClaimStruct)],
  })
  const gas = await pub.estimateContractGas({ account: dep.attester, address: dep.address, abi, functionName: 'attestBatch', args: request.args })
  console.log('\nSIMULATION OK — gas estimé:', gas.toString())
} catch (e) {
  console.log('\nSIMULATION ÉCHOUE:')
  console.log('  message :', e.shortMessage ?? e.message)
  let c = e
  while (c) { if (c.data) console.log('  data    :', JSON.stringify(c.data).slice(0,200)); if (c.signature) console.log('  signature:', c.signature); c = c.cause }
}
