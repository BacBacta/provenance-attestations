# Provenance

On-chain verification verdicts for ERC-8004 reputation feedback on Celo — the
validity layer the registry left out.

## Why

A [full-history census](https://github.com/BacBacta/celo-agent-feedback-audit)
of Celo's canonical ERC-8004 Reputation Registry (27,520 records, Feb–Aug 2026)
found that evidence is almost never attached, and almost never verifiable when
it is: 93 records declare the payment they are about; 76 of those name
transactions that do not exist on Celo; a third of the registry attests hashes
with no file published at all.

The spec has the slot (`proofOfPayment`), the chain has the payments (Celo's
x402 facilitator settles hundreds of thousands of attributable stablecoin
transfers) — what's missing is anything that **checks**. Provenance is that
verifier's ledger: for a given feedback record, it stores the outcome of
actually verifying the claim against the chain.

It scores nothing and ranks nothing. Scorers, marketplaces and routers read it
(`isPaymentBacked(...)`, one call) to weight feedback by something harder than
assertion.

## The contract

`contracts/ProvenanceAttestations.sol` — a single self-contained file, no
dependencies, no funds custody, no external calls, no payable path.

Verdict values are **append-only**: 0–9 are already published on chain by v2 and
keep their meanings exactly. 10–13 are new.

| Verdict | Meaning |
|---|---|
| `10 PaymentAttributed` | settled **and** paid by this reviewer to this agent |
| `1 PaymentVerified` | claimed tx exists, succeeded, moved value — **not** attributed |
| `11 PaymentPartyMismatch` | settled, but its parties contradict the claim |
| `2 EvidenceIntact` | file resolves as valid JSON and matches its attested hash |
| `3 EvidenceUnbound` | file resolves, but no hash was attested: nothing binds it |
| `4 EvidenceUnhashed` | file resolves and contradicts its attested hash |
| `12 PaymentForeignChain` | declared on a chain the attester does not query |
| `5 PaymentTxNotFound` | a payment was declared; it is not on this chain |
| `6 PaymentTxFailed` | declared payment exists but reverted |
| `7 PaymentNoValue` | declared payment succeeded but moved nothing relevant |
| `13 EvidenceInconclusive` | retrieval failed in a way that proves nothing |
| `8 EvidenceUnreachable` | a host answered that the declared file is gone |
| `9 EvidenceAbsent` | a hash was attested with no file published at all |

### Two dimensions, not one

A record's file and its payment are independent facts, and one verdict slot
cannot carry both — the payment rungs outranked every documentary rung, so for
every record declaring a payment the state of its file was measured and thrown
away. They are stored side by side now, and the payment dimension is **sticky**:
a pass with nothing to say about the payment leaves it alone, because a settled
transfer does not stop having happened when its evidence file goes offline
years later.

### Reading it

| Call | Question it answers |
|---|---|
| `isPaymentAttributed(...)` | did **this reviewer** pay **this agent**? |
| `isPaymentAttributedAtLeast(..., min, token)` | …and was it worth at least `min`? |
| `isPaymentBacked(...)` | did the cited transaction settle at all? (weaker) |
| `hasIntactEvidence(...)` | did the file resolve and match its attested hash? |
| `evidenceOf(...)` / `paymentOf(...)` | either dimension on its own |

`isPaymentBacked` is deliberately the weak one. Anyone may cite any real
transfer on the chain, so it is a signal, not a filter — use
`isPaymentAttributed` where a payment is meant to be a barrier to entry. And
because a verified transfer has no floor, the settled `amount` and its token are
stored, so a consumer can apply its own threshold in the same call rather than
trusting the rung to imply one.

Records are keyed by the registry's own tuple `(agentId, clientAddress,
feedbackIndex)`. Re-attestation is allowed by design — verdicts can change (a
file dies later, a transaction appears later) — and bumps a `revision` counter;
prior states remain in the immutable event history. `checkedAt` is the block
that recorded the verdict; `observedAt` is when the check actually ran, which
for a backfill is days earlier.

**Trust model, stated plainly:** verdicts are written by a single accountable
attester, rotatable by the owner. This is honest centralization: the attestation
process is open source and reproducible, so anyone can re-run it and dispute a
verdict publicly. Decentralizing the attester (staked re-execution, quorum) is
roadmap, not premise.

**Split the keys.** The attester signs constantly; the owner signs almost never
and exists to rotate a compromised attester. One key for both means that defence
is gone the moment the hot key is. Deploy from a cold key with
`ATTESTER=0x<hot>`, or hand ownership over afterwards — `transferOwnership` is
two-step, so the cold key must `acceptOwnership()` before it takes effect and a
mistyped address cannot lock the contract.

## Build & test

```bash
npm install
npm test        # compiles, then runs the suite on a real in-process EVM
```

No framework: `solc` compiles, `@ethereumjs/vm` executes. 68 tests across three
suites:

- **contract** — authorization, the two-step handover, overwrite semantics, the
  sticky payment dimension, event contents, batching, the payload invariants,
  and the unforgeability of the "never attested" state.
- **backfill** — the CSV format as a contract with the audit, the join defect
  that used to leave records unattested, rows that must never reach the chain,
  and resume across a changed batch size.
- **integration** — the audit's own CSV writer through this service's reader to
  a real EVM, including a hostile `feedbackURI` that tries to forge an
  attestation at every layer.

A 100-row batch costs ~5.5–5.9M gas (~55–59k per attestation, up from ~51k in
v2: the extra slot carries the settled amount, its token and the observation
date). The full historical backfill still fits in a few transactions for cents.

The source of the **live v2 deployment** is frozen at
`contracts/deployed/ProvenanceAttestationsV2.sol` and still compiles, so
`0x3ed53c…01ab` stays verifiable from this repository even though the working
contract has moved on:

```bash
CONTRACT_SOURCE=contracts/deployed/ProvenanceAttestationsV2.sol npm run compile
```

## Deploy (Celo mainnet)

```bash
read -s PRIVATE_KEY && export PRIVATE_KEY    # fresh key, a few CELO, never a main wallet
npm run deploy
```

Writes `deployments/celo.json`. Then verify the source on the explorer:
Contract → Verify & publish → Standard JSON input → upload
`out/standard-input.json` (compiler v0.8.28). The bytecode targets `paris`, so
it runs identically on any EVM chain.

## Backfill the audit's verdicts

```bash
DRY_RUN=1 npm run backfill     # print what would be written; joins are checked
DRY_RUN=0 npm run backfill     # write on chain
```

Reads the audit's `evidence.csv` (path overridable via `CLAIMS_CSV`). Current
exports carry `feedbackIndex` directly, so there is no join: older ones are
still joined against the event cache (`FEEDBACK_CACHE`), and every collision in
that join is reported, because a collision is a join that *succeeds onto the
wrong index* and is therefore invisible to a missing-row check.

Nothing is written until every row is accounted for. Malformed rows, rows that
fail to join, rows the contract would refuse, and duplicate records each block
the run — in a real run, not only in the dry run. Payment transactions cited by
more than one review are reported but not blocked: the reuse is a fact about the
registry, and suppressing it would hide the finding rather than publish it. Set
`FORCE=1` to proceed anyway, deliberately.

Resume is by **rows written**, fingerprinted against the exact row set. A marker
that describes a different input is refused rather than reinterpreted: it used
to store a batch *count*, so resuming at a different `BATCH_SIZE` silently
re-attested some rows and skipped others.

## What this does not claim

- **Verified is not attributed.** `PaymentVerified` says a transaction settled,
  not that it was this reviewer paying this agent. Treat it as weight, never as
  a filter.
- **Attribution is a lower bound.** It matches against the agent's registered
  NFT owner, so an agent paid at an operator address it controls but does not
  hold the token for reads as unattributed.
- **`EvidenceUnhashed` is not tampering.** It says today's bytes do not hash to
  what was attested; it does not date the divergence, and a publisher who hashed
  with sha256 or whose server re-serialises fails from day one.
- **The attester can omit.** Events prove what was written, never that
  everything that should have been written was. Censorship by silence is not
  addressed by this design, and a second independent attester is the fix.

## Roadmap

Attester service running continuously on new feedback · ERC-8004 registration
and Self Agent ID for the service itself · read SDK + MCP endpoint · periodic
delta re-verification · second independent attester, then quorum · a challenge
window with a stake.

MIT.
