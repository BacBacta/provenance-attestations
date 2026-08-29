/**
 * Minimal EVM harness on @ethereumjs/vm — no framework, no node, no keys.
 * `runCall` executes at the message level, so any address can be the caller,
 * which is exactly what authorization tests need.
 */
import { createVM } from '@ethereumjs/vm'
import { Common, Mainnet, Hardfork } from '@ethereumjs/common'
import { createAddressFromString } from '@ethereumjs/util'
import { encodeFunctionData, decodeFunctionResult, decodeEventLog } from 'viem'
import { readFileSync } from 'node:fs'

export const ABI = JSON.parse(readFileSync('out/ProvenanceAttestations.abi.json', 'utf8'))
const BYTECODE = readFileSync('out/ProvenanceAttestations.bin', 'utf8').trim()

const hex = (u8) => '0x' + Buffer.from(u8).toString('hex')
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'))

/**
 * A fixed, realistic block timestamp.
 *
 * A bare EVM reports `block.timestamp == 0`, which makes every observation date
 * look like it is in the contract's future and hides the whole `observedAt`
 * path behind a revert. Pinning it also keeps `checkedAt` assertable instead of
 * being noted as untestable.
 */
export const BLOCK_TIMESTAMP = 1_790_000_000n // 2026-09-21, after the audited window
/**
 * A block height in the same world as that timestamp. Left at 1, every
 * realistic block range a test might commit reads as "not yet mined", which
 * hides the range checks behind a revert that has nothing to do with them.
 */
export const BLOCK_NUMBER = 76_100_000n

export async function newChain(timestamp = BLOCK_TIMESTAMP) {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai })
  const vm = await createVM({ common })
  const block = {
    header: {
      number: BLOCK_NUMBER,
      timestamp,
      cliqueSigner: () => createAddressFromString('0x' + '00'.repeat(20)),
      coinbase: createAddressFromString('0x' + '00'.repeat(20)),
      difficulty: 0n,
      prevRandao: new Uint8Array(32),
      gasLimit: 30_000_000n,
      baseFeePerGas: 0n,
      getBlobGasPrice: () => 0n,
    },
  }

  async function deploy(caller, ctorArgs) {
    const data = BYTECODE + ctorArgs.replace(/^0x/, '')
    const res = await vm.evm.runCall({
      caller: createAddressFromString(caller),
      data: bytes('0x' + data),
      gasLimit: 10_000_000n,
      block,
    })
    if (res.execResult.exceptionError) {
      throw new Error(`deploy reverted: ${res.execResult.exceptionError.error}`)
    }
    return hex(res.createdAddress.bytes)
  }

  async function call(caller, to, fn, args) {
    const res = await vm.evm.runCall({
      caller: createAddressFromString(caller),
      to: createAddressFromString(to),
      data: bytes(encodeFunctionData({ abi: ABI, functionName: fn, args })),
      gasLimit: 10_000_000n,
      block,
    })
    const logs = (res.execResult.logs ?? []).map(([addr, topics, data]) =>
      decodeEventLog({ abi: ABI, topics: topics.map(hex), data: hex(data) }),
    )
    if (res.execResult.exceptionError) {
      // Surface the custom error selector so tests can assert WHICH revert.
      const ret = hex(res.execResult.returnValue ?? new Uint8Array())
      return { reverted: true, selector: ret.slice(0, 10), logs: [] }
    }
    let result
    try {
      result = decodeFunctionResult({ abi: ABI, functionName: fn, data: hex(res.execResult.returnValue) })
    } catch { result = undefined }
    return { reverted: false, result, logs, gasUsed: res.execResult.executionGasUsed }
  }

  return { deploy, call }
}

// keccak-256 selectors of the contract's custom errors, for revert assertions.
import { toFunctionSelector } from 'viem'
export const ERRORS = {
  NotOwner: toFunctionSelector('NotOwner()'),
  NotPendingOwner: toFunctionSelector('NotPendingOwner()'),
  NotAttester: toFunctionSelector('NotAttester()'),
  ZeroAddress: toFunctionSelector('ZeroAddress()'),
  EmptyBatch: toFunctionSelector('EmptyBatch()'),
  InvalidVerdict: toFunctionSelector('InvalidVerdict()'),
  MissingPaymentTx: toFunctionSelector('MissingPaymentTx()'),
  IncoherentAmount: toFunctionSelector('IncoherentAmount()'),
  ObservationInFuture: toFunctionSelector('ObservationInFuture()'),
  InvalidRange: toFunctionSelector('InvalidRange()'),
  AttestedExceedsObserved: toFunctionSelector('AttestedExceedsObserved()'),
  DimensionMismatch: toFunctionSelector('DimensionMismatch()'),
}
