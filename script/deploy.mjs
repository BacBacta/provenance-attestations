/**
 * Deploy ProvenanceAttestations to Celo mainnet.
 *
 *   read -s PRIVATE_KEY && export PRIVATE_KEY     # avoids shell history
 *   npm run deploy
 *
 * Uses a plain wallet transaction — no framework, no factory. The deployer
 * becomes the owner; the attester defaults to the deployer and can be rotated
 * later with setAttester.
 *
 * SPLIT THE ROLES. The two roles are not the same risk and should not be the
 * same key. The attester signs constantly and lives wherever the pipeline runs;
 * the owner signs almost never and exists to rotate a compromised attester. Put
 * them on one key and that defence is gone the moment the hot key is: whoever
 * takes it can also rotate itself back in.
 *
 *   ATTESTER=0x<hot key> npm run deploy     # deploy from the COLD key
 *
 * With ATTESTER set, the deployer (cold) owns the contract and the hot key does
 * nothing but attest. If you must deploy from the hot key, hand ownership over
 * afterwards — the transfer is two-step, so the cold key has to accept before it
 * takes effect and a mistyped address cannot lock the contract:
 *
 *   transferOwnership(<cold>)   from the hot key
 *   acceptOwnership()           from the cold key
 */
import {
  createWalletClient, createPublicClient, http, formatEther, getContractAddress,
  encodeAbiParameters,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

const RPC = process.env.CELO_RPC_URL ?? 'https://forno.celo.org'
const PK = process.env.PRIVATE_KEY
if (!PK) {
  console.error('PRIVATE_KEY is not set.\n  read -s PRIVATE_KEY && export PRIVATE_KEY')
  process.exit(1)
}

const account = privateKeyToAccount(PK.startsWith('0x') ? PK : `0x${PK}`)
const attester = process.env.ATTESTER ?? account.address

const abi = JSON.parse(readFileSync('out/ProvenanceAttestations.abi.json', 'utf8'))
const bytecode = '0x' + readFileSync('out/ProvenanceAttestations.bin', 'utf8').trim()

const pub = createPublicClient({ chain: celo, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: celo, transport: http(RPC) })

const balance = await pub.getBalance({ address: account.address })
console.log(`deployer  ${account.address}  (becomes owner)`)
console.log(`balance   ${formatEther(balance)} CELO`)
console.log(`attester  ${attester}`)
if (attester.toLowerCase() === account.address.toLowerCase()) {
  console.log('')
  console.log('  ! owner and attester will be the SAME key.')
  console.log('    The owner\'s only power is rotating a compromised attester, and that')
  console.log('    defence is worthless if the same key is the one compromised.')
  console.log('    Deploy from a cold key with ATTESTER=<hot key>, or hand ownership')
  console.log('    over afterwards with transferOwnership + acceptOwnership.')
}
/**
 * Price the deployment before attempting it.
 *
 * A balance too small to cover the gas fails inside viem's estimation with
 * "Transaction creation failed" — a message that says nothing about funds, and
 * that reads exactly like the transaction was rejected on its merits. Saying
 * the actual number costs one RPC call.
 */
const gasPrice = await pub.getGasPrice()
/**
 * Estimate the deployment, do not guess it.
 *
 * The guard budgeted a flat 2,000,000 gas. v4 costs 2,655,194 — so the check
 * passed on a balance that could not pay, and the operator got the very
 * "Transaction creation failed" this block exists to translate. A constant
 * cannot track a contract that keeps growing; an estimate can, and the 25%
 * headroom covers the gap between estimation and the block that lands it.
 */
let gasNeeded
try {
  gasNeeded = await pub.estimateGas({
    account,
    data: bytecode + encodeAbiParameters([{ type: 'address' }], [attester]).slice(2),
  })
} catch (e) {
  gasNeeded = 3_500_000n
  console.log(`  (gas estimation failed: ${e.shortMessage ?? e.message}; budgeting ${gasNeeded})`)
}
const needed = (gasNeeded * 125n) / 100n * gasPrice
if (balance < needed) {
  console.error(
    `\nThe deployer cannot cover this deployment.\n` +
    `  balance  ${formatEther(balance)} CELO\n` +
    `  needed   ~${formatEther(needed)} CELO for ${gasNeeded} gas ` +
      `at ${formatEther(gasPrice * 1_000_000_000n)} gwei (25% headroom)\n` +
    `Fund ${account.address} and re-run.`,
  )
  process.exit(1)
}

/**
 * A deployment is decided by the chain, never by the SDK's exception.
 *
 * The v3 deployment was broadcast, mined and correct, and this script reported
 * "Transaction creation failed" and exited non-zero: the node accepted the
 * transaction and the reply was lost on the way back over a mobile link. An
 * operator who believes that message redeploys — a second contract, a second
 * address, a forked ledger, and the first one still live and unrecorded.
 *
 * So the address is computed BEFORE sending, from the deployer and its nonce,
 * which is what CREATE will use. If code is already there, the deployment has
 * already happened and this run must not repeat it. If the send throws, the
 * same address decides the outcome instead of the error.
 */
/**
 * Refuse to deploy a second contract while a first one is live.
 *
 * Checking only the CREATE address for the CURRENT nonce does not protect
 * anything: a successful deployment increments the nonce, so the next address
 * is fresh and empty and the check waves the second deployment straight
 * through. The thing that must not be duplicated is the SERVICE, and what
 * records it is deployments/celo.json — so that is what gets consulted.
 *
 * This matters more than a wasted fee. Two live contracts is a forked ledger:
 * consumers read one, the attester writes the other, and both look correct.
 */
if (existsSync('deployments/celo.json')) {
  const prior = JSON.parse(readFileSync('deployments/celo.json', 'utf8'))
  if (prior.chainId === celo.id && prior.address) {
    /**
     * "I could not ask" is not "there is nothing there".
     *
     * This read used to swallow every RPC failure into `null`, which is
     * exactly the value that means "no code at this address" — so a node
     * answering -32000, a timeout or a dropped connection silently disarmed
     * the one guard standing between a rerun and two live contracts. The
     * failure mode it protects against is a forked ledger, so an unanswered
     * question has to stop the deployment, not wave it through.
     */
    let priorCode
    try {
      priorCode = await pub.getBytecode({ address: prior.address })
    } catch (e) {
      console.error(
        `\nCannot tell whether ${prior.address} is still live: ${e.shortMessage ?? e.message}\n` +
        'Refusing to deploy on an unanswered question — two live contracts is a forked\n' +
        'ledger, with consumers reading one while the attester writes the other.\n' +
        'Retry, or set REDEPLOY=1 if you have checked the address by hand.',
      )
      if (process.env.REDEPLOY !== '1') process.exit(1)
      console.error('REDEPLOY=1 — proceeding on an unverified prior address.\n')
      priorCode = null
    }
    if (priorCode) {
      console.error(
        `\nA contract is already deployed and recorded for this chain.\n` +
        `  address  ${prior.address}${prior.version ? ` (v${prior.version})` : ''}\n` +
        `  owner    ${prior.owner ?? prior.deployer}\n` +
        `  attester ${prior.attester}\n` +
        `Deploying again would leave two live contracts: consumers reading one\n` +
        `while the attester writes the other, both looking correct.\n` +
        `Set REDEPLOY=1 if a second deployment is genuinely what you want.`,
      )
      if (process.env.REDEPLOY !== '1') process.exit(1)
      console.error('REDEPLOY=1 — proceeding anyway.\n')
    }
  }
}

/**
 * The nonce viem will actually use, which is the PENDING one.
 *
 * This read took viem's default, blockTag 'latest', while
 * prepareTransactionRequest fills the transaction from 'pending'. With one of
 * the deployer's transactions still in the mempool the two differ by one, so
 * the script computed CREATE(N), watched CREATE(N) for code, found none, and
 * announced that nothing had been deployed — while the contract was being
 * created at CREATE(N+1). The recovery path printed below would then have been
 * followed for a deployment that had in fact succeeded, at an address nobody
 * had written down.
 */
const nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' })
const mined = await pub.getTransactionCount({ address: account.address, blockTag: 'latest' })
if (nonce !== mined) {
  console.error(
    `\nThe deployer has ${nonce - mined} transaction(s) still in the mempool ` +
    `(latest ${mined}, pending ${nonce}).\n` +
    'Deploying now stacks this contract behind them, and its address depends on\n' +
    'whether they land. Wait for them to confirm and re-run.',
  )
  process.exit(1)
}
const expected = getContractAddress({ from: account.address, nonce: BigInt(nonce) })
console.log(`address   ${expected}  (deterministic: deployer + nonce ${nonce})`)

if (await pub.getBytecode({ address: expected })) {
  /**
   * Say it, and then actually do it.
   *
   * This branch announced "recording it instead of repeating it" and exited
   * without writing anything, so the one path that exists to recover a
   * deployment whose receipt was lost left the operator exactly where they
   * started: a live contract at a known address, and no record of it. That is
   * the state this project spent an afternoon recovering from by hand.
   */
  console.error(
    `\nA contract already exists at ${expected}.\n` +
    'This deployment has already happened. Recording it from chain state.',
  )
  const read = (fn) => pub.readContract({ address: expected, abi, functionName: fn }).catch(() => null)
  const [v, o, a] = await Promise.all([read('VERSION'), read('owner'), read('attester')])
  if (!o || !a) {
    console.error(
      'But its owner and attester could not be read, so nothing was written.\n' +
      'Check the address by hand before trusting deployments/celo.json.',
    )
    process.exit(1)
  }
  mkdirSync('deployments', { recursive: true })
  if (existsSync('deployments/celo.json')) {
    const prior = JSON.parse(readFileSync('deployments/celo.json', 'utf8'))
    if (prior.address && prior.address.toLowerCase() !== expected.toLowerCase()) {
      writeFileSync('deployments/celo-previous.json', JSON.stringify(prior, null, 2))
    }
  }
  writeFileSync('deployments/celo.json', JSON.stringify({
    contract: 'ProvenanceAttestations',
    version: v,
    address: expected,
    deployer: account.address,
    owner: o,
    attester: a,
    txHash: null,
    block: null,
    chainId: celo.id,
    deployedAt: new Date().toISOString(),
    note: 'Recovered from chain state: the contract was found already deployed at the ' +
      'address this deployer and nonce produce. txHash and block are unknown because ' +
      'this run did not send the transaction.',
  }, null, 2))
  console.error(`Wrote deployments/celo.json — version ${v ?? 'unreadable'}, owner ${o}, attester ${a}.`)
  process.exit(1)
}

console.log('\ndeploying…')
let hash = null
try {
  hash = await wallet.deployContract({ abi, bytecode, args: [attester] })
  console.log(`tx        ${hash}`)
} catch (err) {
  console.error(`\nThe send reported: ${err.shortMessage ?? err.message}`)
  console.error('Asking the chain whether it landed anyway…')
}

/**
 * Give a broadcast transaction time to appear before believing it did not.
 * A lost reply and a rejected transaction look identical from here, and only
 * one of them means there is nothing on chain.
 */
let code = null
for (let i = 0; i < 30 && !code; i++) {
  if (i) await new Promise((r) => setTimeout(r, 4000))
  code = await pub.getBytecode({ address: expected }).catch(() => null)
  if (!code) process.stdout.write(`\r  waiting for code at ${expected}… ${i * 4}s   `)
}
process.stdout.write('\n')

if (!code) {
  console.error(`\nNothing was deployed at ${expected}. Nonce ${nonce} is still free;`)
  console.error('re-running is safe.')
  process.exit(1)
}

const receipt = hash ? await pub.waitForTransactionReceipt({ hash }).catch(() => null) : null
if (receipt && receipt.status !== 'success') {
  console.error('Deployment reverted.')
  process.exit(1)
}
if (!hash) console.log('Recovered: the transaction had landed. No second deployment was made.')

mkdirSync('deployments', { recursive: true })

/**
 * Keep the record this one replaces.
 *
 * `deployments/celo.json` is the only place the address of a live contract is
 * written down, and overwriting it in place erases the identity of a contract
 * that is still on chain holding published verdicts. Anything reading that file
 * afterwards — the backfill, the verifier — silently describes a different
 * deployment. The previous record is archived under its own version first.
 */
if (existsSync('deployments/celo.json')) {
  const prior = JSON.parse(readFileSync('deployments/celo.json', 'utf8'))
  let archive = `deployments/celo-${prior.version ? `v${prior.version.split('.')[0]}` : 'previous'}.json`
  for (let n = 2; existsSync(archive); n++) archive = archive.replace(/(-\d+)?\.json$/, `-${n}.json`)
  writeFileSync(archive, JSON.stringify(prior, null, 2))
  console.log(`\narchived  ${prior.address} → ${archive}`)
}

let version = null
try {
  version = await pub.readContract({ address: expected, abi, functionName: 'VERSION' })
} catch { /* a contract without VERSION() predates it */ }

// Read back what was actually deployed rather than what was intended.
const onChainOwner = await pub.readContract({ address: expected, abi, functionName: 'owner' })
const onChainAttester = await pub.readContract({ address: expected, abi, functionName: 'attester' })

const record = {
  contract: 'ProvenanceAttestations',
  version,
  address: expected,
  deployer: account.address,
  owner: onChainOwner,
  attester: onChainAttester,
  txHash: hash,
  block: receipt ? receipt.blockNumber.toString() : null,
  chainId: celo.id,
  deployedAt: new Date().toISOString(),
}
writeFileSync('deployments/celo.json', JSON.stringify(record, null, 2))

console.log(`\ndeployed  ${expected}`)
if (receipt) console.log(`block     ${receipt.blockNumber}`)
console.log(`owner     ${onChainOwner}`)
console.log(`attester  ${onChainAttester}`)
if (String(onChainOwner).toLowerCase() === String(onChainAttester).toLowerCase()) {
  console.log('  ! owner and attester are the same key — see the note above.')
}
console.log(`explorer  https://celo.blockscout.com/address/${expected}`)
console.log('\nNext: verify the source on the explorer (Contract → Verify & publish →')
console.log('Standard JSON input → upload out/standard-input.json, compiler v0.8.28).')
if (attester.toLowerCase() === account.address.toLowerCase()) {
  console.log('Then: move ownership to a cold key — transferOwnership(<cold>) here,')
  console.log('      acceptOwnership() from the cold key.')
}
console.log('Then: DRY_RUN=1 npm run backfill')
