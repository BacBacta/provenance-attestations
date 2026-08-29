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
import { createWalletClient, createPublicClient, http, formatEther } from 'viem'
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
if (balance === 0n) {
  console.error('\nThe deployer holds no CELO. Fund it with ~2 CELO and re-run.')
  process.exit(1)
}

console.log('\ndeploying…')
const hash = await wallet.deployContract({ abi, bytecode, args: [attester] })
console.log(`tx        ${hash}`)
const receipt = await pub.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success') {
  console.error('Deployment reverted.')
  process.exit(1)
}

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
  version = await pub.readContract({ address: receipt.contractAddress, abi, functionName: 'VERSION' })
} catch { /* a contract without VERSION() predates it */ }

const record = {
  contract: 'ProvenanceAttestations',
  version,
  address: receipt.contractAddress,
  deployer: account.address,
  attester,
  txHash: hash,
  block: receipt.blockNumber.toString(),
  chainId: celo.id,
  deployedAt: new Date().toISOString(),
}
writeFileSync('deployments/celo.json', JSON.stringify(record, null, 2))

console.log(`\ndeployed  ${receipt.contractAddress}`)
console.log(`block     ${receipt.blockNumber}`)
console.log(`explorer  https://celo.blockscout.com/address/${receipt.contractAddress}`)
console.log('\nNext: verify the source on the explorer (Contract → Verify & publish →')
console.log('Standard JSON input → upload out/standard-input.json, compiler v0.8.28).')
if (attester.toLowerCase() === account.address.toLowerCase()) {
  console.log('Then: move ownership to a cold key — transferOwnership(<cold>) here,')
  console.log('      acceptOwnership() from the cold key.')
}
console.log('Then: DRY_RUN=1 npm run backfill')
