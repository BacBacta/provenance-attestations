/**
 * provenance-ledger — read ERC-8004 reputation the way the ledger means it.
 *
 * The contract answers one question per record and answers it honestly, but the
 * honest answer is ambiguous: `getAttestation` returns `None` both for a record
 * the attester looked at and said nothing about, and for one in a range it never
 * claimed to sweep. Reading both as "no evidence" is wrong in one direction;
 * reading both as "not checked yet" is wrong in the other.
 *
 *   import { readLedger, summarise, contract } from 'provenance-ledger'
 *
 *   const rows = await readLedger(publicClient, contract, records)
 *   // each row: standing 'attested' | 'silent' | 'uncovered', and when the
 *   // registry event itself decides the record, `derivable` names the rung.
 *
 * `viem` is a peer dependency: the package does no networking of its own and
 * borrows the client you already have.
 */
export {
  Verdict, Evidence, Payment,
  VERDICT_NAMES, EVIDENCE_NAMES, PAYMENT_NAMES,
} from './enums.mjs'

export {
  STANDING, standingOf, derivableFromRegistry, readLedger, summarise,
} from './ledger.mjs'

export { CELO, contract, abi } from './deployment.mjs'
