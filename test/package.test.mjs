/**
 * The published package must describe the contract that is actually deployed.
 *
 * A package pins two things a repository can silently move underneath it: an
 * ABI and an address. Both are exactly the staleness this project measures in
 * other people's metadata — and it has already been caught by it once, when the
 * service's own ERC-8004 registration went on naming a superseded contract while
 * resolving perfectly. These tests are the guard that would have failed then.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CELO, contract, abi } from '../packages/ledger/index.mjs'
import * as pkg from '../packages/ledger/index.mjs'
import { Verdict, Evidence, Payment } from '../packages/ledger/enums.mjs'
import * as lib from '../script/backfill-lib.mjs'

let passed = 0
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { console.error(`  ✗ ${name}`); throw e }
}

const compiled = JSON.parse(readFileSync('out/ProvenanceAttestations.abi.json', 'utf8'))
const deployment = JSON.parse(readFileSync('deployments/celo.json', 'utf8'))
const manifest = JSON.parse(readFileSync('packages/ledger/package.json', 'utf8'))

check('every entry the package ships is byte-identical to the compiled ABI', () => {
  // The package ships a subset — the read surface a consumer needs — so the
  // test is containment, not equality. An entry that drifted would differ here
  // even though both files still parse.
  for (const entry of abi) {
    const match = compiled.find((c) => c.type === entry.type && c.name === entry.name)
    assert.ok(match, `${entry.type} ${entry.name} is not in the compiled ABI at all`)
    assert.deepEqual(entry, match, `${entry.type} ${entry.name} drifted from the compiled ABI`)
  }
})

check('the package ships every read function a consumer is told to use', () => {
  // Named explicitly rather than derived from the ABI: deriving it would make
  // the test agree with whatever the package happens to contain.
  for (const fn of [
    'getAttestation', 'evidenceOf', 'paymentOf', 'hasIntactEvidence',
    'isPaymentAttributed', 'isPaymentAttributedAtLeast', 'isPaymentBacked',
    'isWithinSweep', 'coverage', 'sweepAt', 'sweepCount', 'latestSweep',
    'totalAttestations', 'attester', 'owner', 'VERSION',
  ]) {
    assert.ok(abi.some((e) => e.type === 'function' && e.name === fn), `${fn} missing`)
  }
  for (const ev of ['FeedbackAttested', 'PaymentAttested', 'SweepCommitted', 'SweepRetracted']) {
    assert.ok(abi.some((e) => e.type === 'event' && e.name === ev), `${ev} missing`)
  }
})

check('the package ships no write function, because it is a reader', () => {
  // Shipping attest or commitSweep would invite a consumer to think this
  // package can write, and put a mutating selector in a read-only dependency.
  for (const e of abi.filter((x) => x.type === 'function')) {
    assert.ok(
      e.stateMutability === 'view' || e.stateMutability === 'pure',
      `${e.name} is ${e.stateMutability}, not a read`,
    )
  }
})

check('the pinned address and version are the deployment on record', () => {
  assert.equal(CELO.address.toLowerCase(), deployment.address.toLowerCase())
  assert.equal(CELO.version, deployment.version)
  assert.equal(CELO.chainId, deployment.chainId)
  assert.equal(CELO.deployedAtBlock, BigInt(deployment.block))
  assert.equal(contract.address, CELO.address)
})

check('the enums are one table, not two that agree today', () => {
  // backfill-lib re-exports the package's enums rather than keeping a copy.
  // Identity, not deep equality: a copy would pass deepEqual and drift later.
  assert.equal(lib.Verdict, Verdict)
  assert.equal(lib.Evidence, Evidence)
  assert.equal(lib.Payment, Payment)
})

check('the enums still match the contract, value by value', () => {
  // The append-only promise: a consumer that stored 2 last year still means
  // EvidenceIntact today. Read from the contract source, not from our copy.
  const sol = readFileSync('contracts/ProvenanceAttestations.sol', 'utf8')
  const enumBody = (name) => {
    const m = sol.match(new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`))
    assert.ok(m, `enum ${name} not found in the contract source`)
    // Members carry trailing `// n — meaning` comments, and Payment.NotDeclared
    // carries a multi-line block comment explaining why it was appended rather
    // than inserted. Both must go before splitting, or a comment counts as a
    // rung: stripping only `//` found 29 members in a nine-member enum.
    return m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim().replace(/,$/, '').trim())
      .filter(Boolean)
  }
  for (const [name, table] of [['Verdict', Verdict], ['Evidence', Evidence], ['Payment', Payment]]) {
    const declared = enumBody(name)
    assert.equal(declared.length, Object.keys(table).length, `${name} has a different number of rungs`)
    declared.forEach((member, i) => {
      assert.equal(table[member], i, `${name}.${member} is ${table[member]} here and ${i} on chain`)
    })
  }
})

check('the manifest points at files that exist and a real entry point', () => {
  assert.equal(manifest.name, 'provenance-ledger')
  assert.equal(manifest.type, 'module')
  assert.ok(manifest.peerDependencies?.viem, 'viem must be a peer, not a dependency')
  assert.ok(!manifest.dependencies || Object.keys(manifest.dependencies).length === 0,
    'a reader should have no runtime dependencies of its own')
  for (const f of manifest.files) {
    assert.ok(readFileSync(`packages/ledger/${f}`), `${f} is listed in files but missing`)
  }
  assert.ok(typeof pkg.readLedger === 'function')
  assert.ok(typeof pkg.standingOf === 'function')
  assert.ok(typeof pkg.summarise === 'function')
  assert.ok(pkg.STANDING.ATTESTED && pkg.STANDING.SILENT && pkg.STANDING.UNCOVERED)
})

console.log(`\n${passed} passed\n`)
