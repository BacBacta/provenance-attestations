/**
 * One command for a sweep, because the last two took a 286-character line.
 *
 *   npm run sweep                      # plan and dry run, spends nothing
 *   KEY_FILE=~/attester.key npm run sweep
 *   DRY_RUN=0 KEY_FILE=~/attester.key npm run sweep
 *
 * The frontier decides the range, the manifest decides the filenames, and
 * nothing is typed. That matters beyond convenience: the pair of paths that had
 * to be pasted by hand were an export and a coverage manifest which MUST come
 * from the same run, and a single wrong character would have published one run's
 * coverage claim over another run's verdicts. Deriving both from the manifest
 * the audit just wrote removes the possibility rather than guarding it.
 *
 * Every step is printed before it runs and nothing is sent unless DRY_RUN=0.
 */
import { createPublicClient, http, formatEther } from 'viem'
import { celo } from 'viem/chains'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { nextRange, snapshotBase, estimate, manifestMatchesPlan, DEFAULT_CONFIRMATIONS, MIN_SPAN } from './sweep-plan.mjs'

const RPC = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'
const AUDIT = process.env.AUDIT_REPO ?? '../celo-agent-feedback-audit'
const DRY = process.env.DRY_RUN !== '0'
const CONFIRMATIONS = BigInt(process.env.CONFIRMATIONS ?? DEFAULT_CONFIRMATIONS)
const SPAN = BigInt(process.env.MIN_SPAN ?? MIN_SPAN)
const DEPLOY_BLOCK = 58_396_729n

const die = (lines) => { for (const l of [].concat(lines)) console.error(l); process.exit(1) }
const step = (n, what) => console.log(`\n\x1b[1m[${n}]\x1b[0m ${what}`)

if (!existsSync(AUDIT)) {
  die([`No audit repository at ${AUDIT}.`, 'Set AUDIT_REPO, or clone celo-agent-feedback-audit beside this one.'])
}
if (!existsSync('deployments/celo.json')) die('deployments/celo.json not found — nothing is deployed.')

const deployment = JSON.parse(readFileSync('deployments/celo.json', 'utf8'))
const abi = JSON.parse(readFileSync('out/ProvenanceAttestations.abi.json', 'utf8'))
const client = createPublicClient({ chain: celo, transport: http(RPC) })

step(1, 'reading the coverage frontier from chain')
const [[coveredFrom, coveredTo, liveClaims], head, total, balance, gasPrice] = await Promise.all([
  client.readContract({ address: deployment.address, abi, functionName: 'coverage' }),
  client.getBlockNumber(),
  client.readContract({ address: deployment.address, abi, functionName: 'totalAttestations' }),
  client.getBalance({ address: deployment.attester }),
  client.getGasPrice(),
])
console.log(`    ledger    ${deployment.address}  v${deployment.version}`)
console.log(`    coverage  ${coveredFrom}–${coveredTo}, ${liveClaims} standing claim(s), ${total} attestation(s)`)
console.log(`    head      ${head}  (leaving ${CONFIRMATIONS} for confirmations)`)

const plan = nextRange({
  coveredFrom, coveredTo, liveClaims, head,
  deployBlock: DEPLOY_BLOCK, confirmations: CONFIRMATIONS, minSpan: SPAN,
})
if (!plan.ok) {
  console.log('')
  for (const l of plan.lines) console.log(`    ${l}`)
  process.exit(plan.reason === 'nothing-new' || plan.reason === 'too-soon' ? 0 : 1)
}
console.log(`    next      ${plan.fromBlock}–${plan.toBlock}  (${plan.span} blocks)${plan.firstEver ? '  — first claim ever' : ''}`)

step(2, `auditing blocks ${plan.fromBlock}–${plan.toBlock}`)
const run = (cmd, args, cwd, env = {}) => {
  console.log(`    $ ${cmd} ${args.join(' ')}${cwd ? `   (in ${cwd})` : ''}`)
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
  if (r.status !== 0) die(`\n${cmd} exited ${r.status}. Nothing further was run, and nothing was sent.`)
}
run('npm', ['run', 'audit'], AUDIT, {
  AUDIT_FROM_BLOCK: String(plan.fromBlock),
  AUDIT_TO_BLOCK: String(plan.toBlock),
  AUDIT_WINDOW: '',
})

step(3, 'publishing the snapshot')
run('npm', ['run', 'publish-report'], AUDIT)

step(4, 'locating the published pair')
const manifestPath = `${AUDIT}/out/sweep.json`
if (!existsSync(manifestPath)) die(`${manifestPath} was not written; the audit produced no coverage manifest.`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

/**
 * Freshness before anything else. The audit exits early and writes nothing when
 * a window holds no feedback records, leaving the previous run in out/ — which
 * publish-report then republishes unchanged, and which every later check agrees
 * with perfectly, because it is internally consistent. Only the range shows it.
 */
const fresh = manifestMatchesPlan(manifest, plan)
if (!fresh.ok) {
  console.log('')
  for (const l of fresh.lines) console.log(`    ${l}`)
  console.log('')
  console.log(`    Blocks ${plan.fromBlock}–${plan.toBlock} hold no feedback records, so there is`)
  console.log('    nothing to attest for them. Coverage stays at the current frontier:')
  console.log('    a range with no records cannot be claimed today, because a coverage')
  console.log('    claim needs a root over an observed set and the audit publishes none')
  console.log('    for an empty window. Nothing was sent.')
  process.exit(0)
}

const named = snapshotBase(manifest)
if (!named.ok) die(named.lines)

const csv = `${AUDIT}/docs/${named.base}.evidence.csv`
const sweep = `${AUDIT}/docs/${named.base}.sweep.json`
for (const p of [csv, sweep]) if (!existsSync(p)) die(`Expected ${p} and it is not there. The snapshot did not publish under the name its manifest describes.`)

/**
 * The manifest just written must be the one that was just published. Comparing
 * the two files rather than trusting the name catches a `docs/` entry left by an
 * earlier run under a colliding name — the one way deriving the path could still
 * pair the wrong two files.
 */
const published = JSON.parse(readFileSync(sweep, 'utf8'))
if (published.observedRoot !== manifest.observedRoot || String(published.exportedRows) !== String(manifest.exportedRows)) {
  die([
    `${sweep} is not the run that just finished.`,
    `  just written  root ${manifest.observedRoot}, ${manifest.exportedRows} rows`,
    `  published     root ${published.observedRoot}, ${published.exportedRows} rows`,
  ])
}
console.log(`    ${named.base}`)
console.log(`    observed ${manifest.observed} · exported ${manifest.exportedRows} · root ${manifest.observedRoot.slice(0, 18)}…`)

const cost = estimate({ rows: Number(manifest.exportedRows), gasPriceWei: gasPrice })
console.log(`\n    attester  ${formatEther(balance)} CELO at ${Number(gasPrice) / 1e9} gwei`)
console.log(`    estimate  ${formatEther(cost.lowWei)} – ${formatEther(cost.highWei)} CELO`)
console.log('              the high end is where a payment-heavy window lands; a blended')
console.log('              average understated the last one by 45%.')
if (balance < cost.highWei) {
  die(['\nThe attester cannot cover the high end of that estimate. Nothing was sent.'])
}

step(5, DRY ? 'dry run (nothing will be sent)' : 'writing to chain')
run('npm', ['run', 'backfill'], undefined, {
  CLAIMS_CSV: csv,
  SWEEP_JSON: sweep,
  DRY_RUN: DRY ? '1' : '0',
})

console.log(DRY
  ? '\nPlan is sound and nothing was sent. Re-run with DRY_RUN=0 and KEY_FILE set to write.'
  : '\nSweep complete.')
