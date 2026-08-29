/**
 * Publish the audit's verdicts on chain — the first real activity of the
 * Provenance attestation contract.
 *
 *   DRY_RUN=1 npm run backfill      # default: print what would be written
 *   DRY_RUN=0 npm run backfill      # actually send
 *
 * Reads the audit's evidence.csv, which now carries `feedbackIndex` directly.
 * Older exports without that column are joined against the audit's event cache
 * instead; that join is reported in full, including collisions, because a join
 * that succeeds onto the WRONG index is invisible to a missing-row check.
 *
 * Nothing is written until every row is accounted for. A row that fails to
 * join, fails to parse, or contradicts itself blocks the run — an attestation
 * ledger must not begin its life by quietly losing rows, and must not begin it
 * by quietly inventing them either.
 */
import { createWalletClient, createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import {
  parseClaimsCsvStrict, indexCache, buildAttestations, chunk,
  fingerprint, toClaimStruct, VERDICT_NAMES,
} from './backfill-lib.mjs'

const DRY = process.env.DRY_RUN !== '0'
const RPC = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'
// Defaults to the full evidence ladder; CLAIMS_CSV still points it at the
// narrower payment-claims file when only those are wanted.
const CLAIMS = process.env.CLAIMS_CSV ?? '../celo-agent-feedback-audit/out/evidence.csv'
const CACHE = process.env.FEEDBACK_CACHE ?? '../celo-agent-feedback-audit/data-bs/feedback-58396729.jsonl'
const BATCH = Number(process.env.BATCH_SIZE ?? 100)
// Rows already written, so an interrupted backfill of ~10,000 rows resumes
// instead of paying twice and doubling every revision counter.
const PROGRESS = process.env.PROGRESS_FILE ?? 'deployments/backfill-progress.json'
/**
 * Escape hatch for an operator who has looked at the problems and decided to
 * proceed anyway. It exists so that "I know" is a deliberate, recorded act
 * rather than the default behaviour of a script nobody read.
 */
const FORCE = process.env.FORCE === '1'

if (!existsSync(CLAIMS)) {
  console.error(`input csv not found at ${CLAIMS} — set CLAIMS_CSV.`)
  process.exit(1)
}

const parsed = parseClaimsCsvStrict(readFileSync(CLAIMS, 'utf8'))
const claims = parsed.rows
const usesJoin = !parsed.header.includes('feedbackIndex')

let cache = { map: new Map(), collisions: [] }
if (usesJoin) {
  if (!existsSync(CACHE)) {
    console.error(
      `${CLAIMS} has no feedbackIndex column, so it must be joined against the\n` +
      `event cache — and none was found at ${CACHE}. Set FEEDBACK_CACHE, or\n` +
      `re-export from a current audit, which carries the column directly.`,
    )
    process.exit(1)
  }
  cache = indexCache(readFileSync(CACHE, 'utf8').split('\n').filter(Boolean))
}

const { rows, missing, rejected, duplicateTxs, cacheCollisions } = buildAttestations(claims, cache)

const byVerdict = {}
for (const r of rows) {
  const name = VERDICT_NAMES[r.verdict] ?? r.verdict
  byVerdict[name] = (byVerdict[name] ?? 0) + 1
}

const print = fingerprint(rows)
console.log(`input rows    ${claims.length}`)
console.log(`index source  ${usesJoin ? 'joined against the event cache (legacy export)' : 'feedbackIndex column (no join)'}`)
console.log(`joined        ${rows.length}`)
console.log(`fingerprint   ${print}`)
console.log('verdicts:')
for (const [k, n] of Object.entries(byVerdict).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(22)} ${String(n).padStart(6)}`)
}
console.log(`batches       ${Math.ceil(rows.length / BATCH)} of up to ${BATCH}`)

// ---------------------------------------------------------------------------
// Everything that must be looked at before a single verdict is written.
// ---------------------------------------------------------------------------
let blocking = 0

if (parsed.malformed.length) {
  blocking++
  console.log(`\nMALFORMED ROWS (${parsed.malformed.length}) — the export does not match its own header:`)
  for (const m of parsed.malformed.slice(0, 10)) {
    console.log(`  line ${m.line}: ${m.cells} cells, expected ${m.expected} — ${m.raw.slice(0, 90)}`)
  }
  if (parsed.malformed.length > 10) console.log(`  … and ${parsed.malformed.length - 10} more`)
}

if (cacheCollisions.length) {
  blocking++
  console.log(`\nJOIN COLLISIONS (${cacheCollisions.length}) — one key, several feedbackIndexes:`)
  console.log('  Each of these is a record that would be attested under another record\'s')
  console.log('  index, leaving the real one reading None — "never attested".')
  for (const c of cacheCollisions.slice(0, 10)) {
    console.log(`  agent ${c.agentId} reviewer ${c.reviewer} uri ${JSON.stringify(c.uri).slice(0, 40)} → indexes ${c.indexes.join(', ')}`)
  }
  if (cacheCollisions.length > 10) console.log(`  … and ${cacheCollisions.length - 10} more`)
  console.log('  Re-export from a current audit: it carries feedbackIndex and needs no join.')
}

if (rejected.length) {
  blocking++
  console.log(`\nREJECTED (${rejected.length}) — rows the contract would refuse or that contradict themselves:`)
  for (const r of rejected.slice(0, 10)) console.log(`  line ${r.row}: ${r.reason}`)
  if (rejected.length > 10) console.log(`  … and ${rejected.length - 10} more`)
}

if (missing.length) {
  blocking++
  console.log(`\nNOT JOINED (${missing.length}) — no feedbackIndex could be established:`)
  for (const m of missing.slice(0, 10)) console.log(`  agent ${m.agentId} reviewer ${m.reviewer} uri ${m.feedbackURI}`)
  if (missing.length > 10) console.log(`  … and ${missing.length - 10} more`)
}

if (duplicateTxs.length) {
  // Reported, not blocking: the reuse is a fact about the registry, and
  // refusing to attest it would hide the finding rather than publish it.
  const affected = duplicateTxs.reduce((s, d) => s + d.users.length, 0)
  console.log(`\nREUSED PAYMENTS (${duplicateTxs.length} transactions across ${affected} reviews):`)
  for (const d of duplicateTxs.slice(0, 10)) {
    console.log(`  ${d.tx.slice(0, 18)}… cited by ${d.users.length} reviews ` +
      `(${new Set(d.users.map((u) => u.reviewer)).size} reviewer(s), ${new Set(d.users.map((u) => u.agentId)).size} agent(s))`)
  }
  if (duplicateTxs.length > 10) console.log(`  … and ${duplicateTxs.length - 10} more`)
  console.log('  A payment cited by several reviews backs at most one of them.')
}

if (blocking && !FORCE) {
  console.log(`\n${blocking} category of problem must be resolved before writing.`)
  console.log('Fix the export, or set FORCE=1 to attest the rows that did pass anyway.')
  if (!DRY) process.exit(2)
}

if (DRY) {
  console.log('\nDRY RUN — nothing sent. Re-run with DRY_RUN=0 to write on chain.')
  process.exit(blocking ? 2 : 0)
}

if (!rows.length) {
  console.error('\nNothing to write. Refusing to report a completed backfill of zero rows.')
  process.exit(1)
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

/**
 * Resume by ROWS COMPLETED against a fingerprint of the row set.
 *
 * A batch counter alone is meaningless the moment BATCH_SIZE or the input
 * changes: the same "3 batches done" then covers a different set of rows, and
 * the difference is either paid for twice or never written at all. Neither
 * failure raises anything, because both look like a clean run.
 */
const TARGET = String(deployment.address).toLowerCase()

let doneRows = 0
if (existsSync(PROGRESS)) {
  try {
    const prior = JSON.parse(readFileSync(PROGRESS, 'utf8'))

    /**
     * A missing fingerprint is a mismatch, not a dispensation.
     *
     * The previous guard only fired when a fingerprint was present, so a marker
     * in the older format skipped it entirely and was then reinterpreted as
     * `completedBatches * BATCH_SIZE` — a row count that changes with an
     * environment variable. The v2 backfill left `{completedBatches: 201}`
     * behind at the default batch of 100, so re-running this script against it
     * computed 20,100 rows already written, found nothing pending, and reported
     * success while writing nothing at all.
     */
    if (prior.fingerprint !== print) {
      console.error(
        `\nThe resume marker describes a different set of rows.\n` +
        `  marker      ${prior.fingerprint ?? 'none — pre-fingerprint format, a batch count that cannot be reinterpreted'}\n` +
        `  this run    ${print}\n` +
        `Resuming would re-attest some rows and skip others in silence.\n` +
        `Delete ${PROGRESS} to start over, or restore the original input.`,
      )
      process.exit(1)
    }

    /**
     * The marker must also name WHERE those rows went.
     *
     * `deployments/celo.json` is rewritten in place by every deployment, so
     * after deploying a new contract the same file describes a different
     * target. A marker that records only "20,097 rows done" then applies to a
     * contract that has never been written to, and the script reports a
     * complete backfill of an empty ledger — every record reading None, the one
     * state this contract advertises as unforgeable.
     */
    if (String(prior.address ?? '').toLowerCase() !== TARGET || (prior.chainId ?? 0) !== celo.id) {
      console.error(
        `\nThe resume marker was written for a different target.\n` +
        `  marker      ${prior.address ?? '(none recorded)'} on chain ${prior.chainId ?? '(none)'}\n` +
        `  this run    ${deployment.address} on chain ${celo.id}\n` +
        `Those rows are on that contract, not this one. Resuming would leave this\n` +
        `contract reading None for every record.\n` +
        `Delete ${PROGRESS} to backfill this contract from row 0.`,
      )
      process.exit(1)
    }

    doneRows = prior.completedRows ?? 0

    /**
     * A batch may have been broadcast and its receipt lost — a dropped
     * connection, a killed process. The marker records that in flight, and the
     * next run must not assume the transaction never landed.
     */
    if (prior.inFlight) {
      console.error(
        `\nThe previous run broadcast a batch and never recorded its outcome.\n` +
        `  transaction ${prior.inFlight.hash}\n` +
        `  rows        ${prior.inFlight.fromRow}–${prior.inFlight.toRow - 1}\n` +
        `Check whether it landed before resuming: if it did and this run starts\n` +
        `at row ${doneRows}, those rows are attested twice, each paying gas again and\n` +
        `inflating a revision counter that is supposed to count real checks.\n` +
        `Once you know, edit completedRows and remove inFlight from ${PROGRESS}.`,
      )
      process.exit(1)
    }
  } catch (err) {
    console.error(`\n${PROGRESS} exists but could not be read: ${err.message}`)
    console.error('Refusing to guess how much was already written.')
    process.exit(1)
  }
}

const pending = rows.slice(doneRows)
if (doneRows) console.log(`resuming after ${doneRows} completed row(s); ${pending.length} to go`)
if (!pending.length) {
  console.log('\nNothing left to write — the marker says every row is already on chain.')
  process.exit(0)
}

const allBatches = chunk(pending, BATCH)
let written = doneRows

const marker = (extra) => JSON.stringify({
  fingerprint: print,
  // The marker names its target, so it cannot be applied to a contract those
  // rows were never written to.
  address: TARGET,
  chainId: celo.id,
  completedRows: written,
  totalRows: rows.length,
  batchSize: BATCH,
  updatedAt: new Date().toISOString(),
  ...extra,
}, null, 2)

for (const [i, part] of allBatches.entries()) {
  const fromRow = written
  const hash = await wallet.writeContract({
    address: deployment.address,
    abi,
    functionName: 'attestBatch',
    args: [part.map(toClaimStruct)],
  })
  /**
   * Recorded BEFORE waiting for the receipt. A batch that is broadcast and then
   * loses its receipt — a dropped connection, a killed process — has landed or
   * will land, and a marker written only on success cannot tell the next run
   * that. It would resume at the same row and attest the whole batch again.
   */
  writeFileSync(PROGRESS, marker({ inFlight: { hash, fromRow, toRow: fromRow + part.length } }))

  const receipt = await pub.waitForTransactionReceipt({ hash })
  console.log(`batch ${i + 1}/${allBatches.length}: ${part.length} attestations — ${receipt.status} — ${hash}`)
  if (receipt.status !== 'success') process.exit(1)
  written += part.length
  writeFileSync(PROGRESS, marker({}))
}
console.log(`\nBackfill complete — ${written} of ${rows.length} rows attested.`)
