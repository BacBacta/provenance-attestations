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
(`isPaymentAttributed(...)`, one call) to weight feedback by something harder
than assertion — and `isPaymentAttributedAtLeast(..., min, token)` when a
payment is meant to be a barrier to entry rather than a signal.

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
away. They are stored side by side now.

**Both are sticky.** `Payment.Unknown` and `Evidence.Unknown` mean *this pass
had nothing to say*, and each leaves that dimension's stored state alone. A
settled transfer does not stop having happened when its evidence file goes
offline years later; and a sweep driven by the narrower payment-claims export —
which carries no documentary columns at all — must not flip `hasIntactEvidence`
to false for files that are still intact, nor quietly withdraw a published
accusation by returning it to "not evaluated". `observedAt` follows the same
rule: `0` means "not stated", so it never overwrites a date already recorded.

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

No framework: `solc` compiles, `@ethereumjs/vm` executes. 85 tests across three
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

The deployer becomes the owner, permanently and in the creation transaction, so
**which key you deploy from is the key-split decision** — it cannot be set
afterwards without a handover. Deploy from the cold key:

```bash
# On the machine where the COLD key lives — never in a hosted session.
read -s PRIVATE_KEY && export PRIVATE_KEY        # the cold key: owner
export ATTESTER=0x…                              # the hot key: attests, nothing more
npm ci && npm test && npm run deploy
```

That is the whole split: owner cold, attester hot, from the first block. The
cold key needs roughly 0.05 CELO for the deployment and then never has to be
online again except to rotate a compromised attester.

If you must deploy from the hot key, hand ownership over afterwards — the
transfer is two-step, so a mistyped address cannot lock the contract:

```
transferOwnership(<cold>)   from the hot key
acceptOwnership()           from the cold key
```

Deploying with `ATTESTER` unset makes one key both roles and prints a warning
saying so: the owner's only power is rotating a compromised attester, and that
defence is worthless when the same key is the one compromised.

`npm run deploy` archives the record it replaces (`deployments/celo-v2.json`)
before writing `deployments/celo.json`, so the address of a contract that is
still on chain holding published verdicts is never erased. Then verify the
source:

```bash
npm run verify        # refuses if out/ does not match the deployed bytecode
```

Or by hand: Contract → Verify & publish → Standard JSON input → upload
`out/standard-input.json` (compiler v0.8.28). The bytecode targets `paris`, so
it runs identically on any EVM chain.

### Deployed

| | |
|---|---|
| **v3** | [`0xAD6202F6…6807`](https://celo.blockscout.com/address/0xAD6202F635e97f17f193524CCa66B5D288ab6807) — block 76,082,999, empty until backfilled |
| owner | `0x6141C737…C4ef` — cold, its only power is rotating the attester |
| attester | `0xC2Dc6B28…972A` — signs verdicts, and nothing else |
| **v2** | [`0x3ed53c9b…01ab`](https://celo.blockscout.com/address/0x3ed53c9bf7f7b5026eae83e4d62abdbd748a01ab) — still live, holds the 20,097 verdicts, one key for both roles |

The key split the counter-analysis asked for is in the creation transaction
itself, not a later handover.

### Deploying v3 over a live v2

v3 is a **new contract at a new address**. The 20,097 verdicts stay on
`0x3ed53c…01ab` under v2's semantics, and the new contract starts empty — every
record reads `None` until it is backfilled. Two consequences worth stating
before you deploy:

- Anything already reading the v2 address keeps reading v2. Announce the new
  address rather than assuming a migration happened.
- The backfill needs an export from a **current** audit run: v3 records the
  attribution, amount and observation date that older exports do not carry.
  `deployments/backfill-progress.json` from the v2 run must not be reused — the
  script refuses it, because those rows are on a different contract.

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
fail to join, rows the contract would refuse, duplicate records, and payment
transactions cited by more than one review each block the run — in a real run,
not only in the dry run. A payment cited by several reviews backs at most one of
them and the ledger cannot say which, so attesting all of them would let one
real transfer underwrite a fabricated history; the reuse belongs in the audit's
report, not in an attestation vouching for each. Set `FORCE=1` to proceed
anyway, deliberately and on the record.

Before the first batch, the script reads `VERSION()` and `attester()` from the
contract named in `deployments/celo.json` and stops if the compiled ABI does not
match it or the key is not the attester. That file and `out/` are written by
different commands, and sending a batch encoded for one contract to another
burns the gas and writes nothing.

Resume is by **rows written**, fingerprinted against the exact row set *and* the
contract it was written to. A marker is refused, not reinterpreted, when it
describes a different input, a different contract or chain, or predates the
fingerprint entirely — it used to store a batch *count*, so resuming at a
different `BATCH_SIZE` silently re-attested some rows and skipped others, and a
marker left by an earlier deployment reported a complete backfill of a contract
that had never been written to.

A batch is recorded as **in flight before** its receipt is awaited. A
transaction that is broadcast and then loses its receipt — a dropped connection,
a killed process — has landed or will land, and the next run stops and says so
rather than attesting the batch a second time.

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
