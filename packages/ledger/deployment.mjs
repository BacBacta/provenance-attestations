/**
 * Where the ledger is, and which build these names describe.
 *
 * Baked in so a consumer needs no configuration for the common case, and
 * exported by name so nothing is hidden: a package that pins an address is a
 * package that must be republished when the contract moves, and pretending
 * otherwise would be the same class of staleness this project measures in other
 * people's metadata. `VERSION` is the contract's own VERSION() string as of this
 * release — read it from chain if you need to be sure rather than trusting a
 * published constant.
 */
import abi from './abi.json' with { type: 'json' }

export const CELO = {
  chainId: 42220,
  address: '0x86931Ae74F5cE9AA8bf818808e47102516CE78a7',
  version: '5.0.0',
  deployedAtBlock: 76234488n,
  /** The ERC-8004 Reputation Registry these verdicts are about. */
  reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  /** This service's own ERC-8004 identity, so a consumer can check who attests. */
  attesterAgentId: 9786n,
  abi,
}

export { abi }

/** Shape viem's readContract/multicall expect: `{ ...contract, functionName }`. */
export const contract = { address: CELO.address, abi }
