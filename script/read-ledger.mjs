/**
 * Ask the ledger about records you already have.
 *
 *   node script/read-ledger.mjs --agent 9734
 *   node script/read-ledger.mjs --reviewer 0x1030…13C7 --limit 40
 *   node script/read-ledger.mjs --agent 9734 --scan 20000
 *
 * This is the consumer's view, and its shape is the point. A consumer does not
 * re-scan seventeen million blocks of registry history to ask a question about
 * one agent — it already holds the records, from its own indexer or from the
 * audit's published export, and wants to know what the ledger says about them.
 * So records come from the published export by default, and `--scan N` adds a
 * live tail of the last N blocks for anything newer than the last publication.
 *
 * The first version scanned the registry from its deploy block in 200,000-block
 * chunks. forno caps eth_getLogs at 5,000, which would have made it 3,560
 * requests — but the cap only exposed the design error, it did not cause it.
 *
 * Nothing here needs a key. It is all eth_call and eth_getLogs.
 */
import { createPublicClient, http, parseAbiItem, formatUnits } from 'viem'
import { celo } from 'viem/chains'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { readLedger, summarise, STANDING } from './ledger.mjs'
import { parseCsvStrict } from './csv.mjs'

const RPC = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'
const REGISTRY = process.env.REPUTATION_REGISTRY ?? '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63'
const DOCS = process.env.AUDIT_DOCS ?? '../celo-agent-feedback-audit/docs'
/** forno's cap. Asking for more is refused, not truncated. */
const LOG_STEP = 5_000n

const NEW_FEEDBACK = parseAbiItem(
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
)

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1] }
const agent = arg('agent')
const reviewer = (arg('reviewer') ?? '').toLowerCase() || undefined
const limit = Number(arg('limit') ?? 60)
const scan = arg('scan') === undefined ? 0n : BigInt(arg('scan'))
if (!agent && !reviewer) {
  console.error('Usage: node script/read-ledger.mjs --agent <id> | --reviewer <address> [--limit n] [--scan blocks]')
  console.error('\nRecords come from the audit\'s published export; --scan adds a live tail.')
  process.exit(1)
}

/**
 * Every published export, newest range last. They are content-addressed by
 * range and rules, so reading all of them is how a consumer covers the whole
 * published history without choosing which snapshot to trust.
 */
const exports_ = existsSync(DOCS)
  ? readdirSync(DOCS).filter((f) => f.endsWith('.evidence.csv')).sort()
  : []
const records = []
const seen = new Set()
for (const f of exports_) {
  // parseCsvStrict returns rows keyed by column name, not by position.
  const { rows } = parseCsvStrict(readFileSync(`${DOCS}/${f}`, 'utf8'))
  for (const r of rows) {
    const a = r.agentId, c = String(r.reviewer).toLowerCase(), i = r.feedbackIndex
    if (agent && String(a) !== String(agent)) continue
    if (reviewer && c !== reviewer) continue
    const key = `${a}|${c}|${i}`
    if (seen.has(key)) continue
    seen.add(key)
    records.push({
      agentId: BigInt(a), clientAddress: r.reviewer, feedbackIndex: BigInt(i),
      blockNumber: BigInt(r.block),
      /**
       * The export carries the registry's own feedbackURI, and `evidenceHash`
       * is the hash the registry recorded. Both are what `derivableFromRegistry`
       * needs, so silence this audit deliberately left can be named as such.
       */
      feedbackURI: r.feedbackURI ?? '',
      feedbackHash: r.evidenceHash || `0x${'0'.repeat(64)}`,
      source: f.replace(/^audit-|-r8.*$/g, ''),
    })
  }
}
console.log(`${records.length} record(s) from ${exports_.length} published export(s)`)

const client = createPublicClient({ chain: celo, transport: http(RPC) })

if (scan > 0n) {
  const head = await client.getBlockNumber()
  let found = 0
  for (let from = head - scan; from <= head; from += LOG_STEP) {
    const to = from + LOG_STEP - 1n > head ? head : from + LOG_STEP - 1n
    const logs = await client.getLogs({
      address: REGISTRY, event: NEW_FEEDBACK,
      args: agent ? { agentId: BigInt(agent) } : { clientAddress: arg('reviewer') },
      fromBlock: from, toBlock: to,
    })
    for (const l of logs) {
      const key = `${l.args.agentId}|${String(l.args.clientAddress).toLowerCase()}|${l.args.feedbackIndex}`
      if (seen.has(key)) continue
      seen.add(key); found++
      records.push({
        agentId: l.args.agentId, clientAddress: l.args.clientAddress, feedbackIndex: l.args.feedbackIndex,
        blockNumber: l.blockNumber, feedbackURI: l.args.feedbackURI, feedbackHash: l.args.feedbackHash,
        source: 'live',
      })
    }
  }
  console.log(`${found} further record(s) from a live scan of the last ${scan} blocks`)
}

if (!records.length) {
  console.log('\nNo records match that filter.')
  process.exit(0)
}
records.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1))

const deployment = JSON.parse(readFileSync('deployments/celo.json', 'utf8'))
const abi = JSON.parse(readFileSync('out/ProvenanceAttestations.abi.json', 'utf8'))
const contract = { address: deployment.address, abi }

const shown = records.slice(0, limit)
const rows = await readLedger(client, contract, shown)
const s = summarise(rows)
const [from, to, live] = await client.readContract({ ...contract, functionName: 'coverage' })

console.log(`\nledger    ${deployment.address}  v${deployment.version}`)
console.log(`coverage  blocks ${from}–${to}, ${live} standing claim(s)\n`)

const pad = (v, n) => String(v).padEnd(n)
console.log(pad('block', 10) + pad('idx', 5) + pad('standing', 11) + pad('verdict', 23) + pad('evidence', 14) + pad('payment', 14) + 'amount')
console.log('─'.repeat(100))
for (const r of rows) {
  const amt = r.amount && r.amount > 0n ? formatUnits(r.amount, r.amountDecimals || 0) : ''
  console.log(
    pad(r.blockNumber, 10) + pad(r.feedbackIndex, 5) + pad(r.standing, 11) +
    pad(r.verdict ?? '—', 23) + pad(r.evidence ?? '—', 14) + pad(r.payment ?? '—', 14) + amt,
  )
}
if (records.length > shown.length) console.log(`… ${records.length - shown.length} more (raise --limit)`)

console.log(`\n${s.total} record(s) read from the ledger`)
console.log(`  attested   ${s.attested}`)
for (const [k, v] of Object.entries(s.verdicts).sort((a, b) => b[1] - a[1])) console.log(`      ${pad(k, 24)}${v}`)
console.log(`  silent     ${s.silent}${s.silentDerivable ? `  (${s.silentDerivable} decided by the registry event itself)` : ''}`)
console.log(`  uncovered  ${s.uncovered}`)
if (s.other) console.log(`  other      ${s.other}`)

/**
 * The distinction this tool exists to make, said out loud rather than left to
 * be inferred from a column heading.
 */
const unexplained = s.silent - s.silentDerivable
if (unexplained > 0) {
  console.log(
    `\n${unexplained} record(s) sit inside a claimed sweep with nothing written about them —\n` +
    'the attester saying nothing about a record it says it looked at.',
  )
}
if (s.uncovered > 0) {
  console.log(
    `\n${s.uncovered} record(s) fall outside every standing sweep. Reading those as "no\n` +
    'evidence" would be wrong: the attester never claimed to have looked there.',
  )
}
