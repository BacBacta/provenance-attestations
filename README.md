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

**A silence and a finding are different things.** `Payment.NotDeclared` says
the file was read and declares no payment at all. Without it, that honest
review shared one stored zero with "nobody has evaluated this yet" *and* — via
`paymentTx == 0` — with a claim that was malformed or on a chain this attester
does not query. So a consumer separating reviews that claim a payment from
reviews that do not was putting a fabricated claim in the same bucket as a
review that never made one, which is the exact population the census exists to
name. Read the `payment` rung, never `paymentTx == 0`. A file that could not be
retrieved stays `Unknown`: a retrieval failure of ours is not evidence about
somebody's document.

**Both are sticky.** `Payment.Unknown` and `Evidence.Unknown` mean *this pass
had nothing to say*, and each leaves that dimension's stored state alone. A
settled transfer does not stop having happened when its evidence file goes
offline years later; and a sweep driven by the narrower payment-claims export —
which carries no documentary columns at all — must not flip `hasIntactEvidence`
to false for files that are still intact, nor quietly withdraw a published
accusation by returning it to "not evaluated". `observedAt` follows the same
rule: `0` means "not stated", so it never overwrites a date already recorded.

### Coverage: making omission falsifiable

Events prove what was written. They cannot prove that everything which *should*
have been written was — so an attester with something to hide never had to lie,
it only had to stay quiet, and silence left no trace anywhere. That is the
strongest objection to a single-attester ledger and it is not answered by
publishing more verdicts.

`commitSweep(fromBlock, toBlock, observed, attested, recordsRoot)` answers it by
making coverage a **claim** instead of an assumption:

- `observed` — how many `NewFeedback` events the attester says the registry
  emitted in that range;
- `attested` — how many of those it wrote a verdict for;
- `recordsRoot` — a Merkle root over the sorted `key(...)` of every **observed**
  record. Over the *attested* subset it would prove only what the events already
  prove; over what was *seen*, it is what an omission is measured against. Zero
  means counts were published without a root, which is a weaker claim and reads
  as one.

The scope is deterministic, so refutation is cheap: re-index the same range,
count, rebuild the root. A count that does not match is proof of omission, and
an inclusion proof names *which* record was dropped without this contract
storing any of them. `script/coverage.mjs` and the audit's
`src/coverage.mjs` are the same file byte for byte, so the root the indexer
publishes and the root a challenger rebuilds cannot drift apart.

The contract cannot verify a sweep — it cannot read the registry's history, and
pretending to check would be theatre. What it does enforce is that a sweep
cannot contradict itself or the record: `toBlock` must be mined, `attested` may
not exceed `observed`, and `attested` may not exceed `totalAttestations`, the
one quantity this contract measures for itself.

**Coverage is one contiguous frontier, and that is what makes the read cheap.**
A new sweep must push `toBlock` further on and must not start beyond the
frontier, so there are no holes for a record to fall into unnoticed. Re-sweeping
ground already covered is the normal case — a full-history census does it every
pass — so overlap is allowed; reaching back *before* where coverage began is
not, because that moves the floor under every answer already given.
`isWithinSweep` is then two loads: **860 gas, flat, at any history length**.

That number is the whole point. A linear scan cost 2,543 + 2,753 per sweep, so
eleven thousand junk entries — about five dollars — bricked the one read that
incriminates the attester, permanently, in a contract with no purge and no
proxy; honest operation hit the same wall in fifteen months. The first fix,
strictly ordered disjoint ranges with a binary search, cost 7,960 gas at 1,024
sweeps and was **worse than the disease**: the census sweeps from the registry's
deployment block every pass, so the second run paid for its entire backfill and
then reverted on the one call it exists to make. The coverage layer could
publish exactly once.

`retractSweep(index)` withdraws a claim, newest first: withdrawing one that
later claims have superseded would change nothing while looking as though it
did, so only the newest standing claim can go, and each withdrawal rolls the
frontier back to where the claim before it left off. It **marks rather than
deletes** — the entry, its original numbers and its date stay readable through
`sweepAt`, with `SweepRetracted` beside them. A claim withdrawn is not a claim
unmade, and the record of having made it is the point. Withdraw them all and the
service reads as never having stated its coverage, not as having covered
nothing.

This does not prevent censorship. It converts it from invisible into
falsifiable — the same standard this service applies to everyone it publishes a
verdict about.

### Reading it

| Call | Question it answers |
|---|---|
| `isPaymentAttributed(...)` | did **this reviewer** pay **this agent**? |
| `isPaymentAttributedAtLeast(..., min, token)` | …and was it worth at least `min`? |
| `isPaymentBacked(...)` | did it settle, with nothing on chain contradicting it? |
| `hasIntactEvidence(...)` | did the file resolve and match its attested hash? |
| `evidenceOf(...)` / `paymentOf(...)` | either dimension on its own |
| `isWithinSweep(block)` | did the attester claim to have swept this block? |
| `coverage()` | the covered span, and how many standing claims make it up |
| `sweepCount()` / `sweepAt(i)` / `latestSweep()` | the coverage claims themselves |

**`false` is not a verdict.** Every boolean above returns `false` for a record
that was never attested, exactly as it does for one checked and found wanting.
Reading `getAttestation(...).verdict == None` separates them, and `isWithinSweep`
answers the harder question — whether the attester ever *claimed* to have looked
at the block that record was written in. A `false` inside a swept range is a
finding; outside one it is only silence. **This matters right now:** the
canonical deployment (v3, below) is live and empty, so today every one of these
calls returns `false` for every address on Celo. Anyone wiring the integration
in before the backfill lands is filtering out 100% of the registry while
believing they applied a verified filter.

`isPaymentBacked` excludes `PaymentPartyMismatch`, though that transaction did
settle. There the document says A paid B and the chain says C paid D: the
citation is not merely unproven, it is refuted, and a record the chain
contradicts must not read as backed by anything. So it answers, precisely: the
cited transaction exists, succeeded, moved value, and nothing about it
contradicts the claim.

Even so, `isPaymentBacked` is deliberately the weak one. Anyone may cite any real
transfer on the chain, so it is a signal, not a filter — use
`isPaymentAttributed` where a payment is meant to be a barrier to entry. And
because a verified transfer has no floor, the settled `amount` and its token are
stored, so a consumer can apply its own threshold in the same call rather than
trusting the rung to imply one.

### Two events, because one could not tell the truth

`FeedbackAttested` fires on every write. It carries the merged state — what a
reader of the mapping sees — *and* what the pass itself claimed
(`statedEvidence`, `statedPayment`, `Unknown` meaning it did not look). Both are
needed: with only the merged values, a re-verification and a value carried
forward from months ago are the same log line, and the history the stickiness
rule leans on cannot be reconstructed per dimension.

`PaymentAttested` fires only when a pass actually evaluated the payment, with
the resulting rung as an indexed topic. That is the subscribable form of the
strongest claim here. `FeedbackAttested` indexes `verdict`, a merged headline,
and since the dimensions separated the pipeline routinely writes an attributed
payment under a documentary verdict — so a consumer filtering `verdict` topics
for attributed payments gets a different set than `isPaymentAttributed`. Its
absence is information too: a record written without it had its payment carried
forward, not re-checked.

Records are keyed by the registry's own tuple `(agentId, clientAddress,
feedbackIndex)`. Re-attestation is allowed by design — verdicts can change (a
file dies later, a transaction appears later) — and bumps a `revision` counter;
prior states remain in the immutable event history.

`revision` and `totalAttestations` count **writes**, not verifications, and are
documented as such. Either dimension may arrive as `Unknown`, so a record can be
written ten times with its payment examined once, and a rewrite identical to the
stored state is accepted and counted. The honest per-record answer to "when was
this last actually checked" is `evidenceObservedAt` / `paymentObservedAt`, which
only a pass that looked can move. `checkedAt` is the block that recorded the
write — a liveness signal, and nothing more.

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

No framework: `solc` compiles, `@ethereumjs/vm` executes. 109 tests across
three suites:

- **contract** — authorization, the two-step handover, overwrite semantics, the
  sticky payment dimension, event contents, batching, the payload invariants,
  the unforgeability of the "never attested" state, and the coverage surface:
  the frontier rules, retraction rolling it back, the bound on `attested`, and
  a gas measurement at 1,024 sweeps that fails if the lookup ever gets more
  expensive than it is at one.
- **backfill** — the CSV format as a contract with the audit, the join defect
  that used to leave records unattested, rows that must never reach the chain,
  and resume across a changed batch size.
- **integration** — the audit's own CSV writer through this service's reader to
  a real EVM, including a hostile `feedbackURI` that tries to forge an
  attestation at every layer.

Measured on the harness, not estimated: a 100-row batch of documentary verdicts
costs 6.12M gas (61,235 per attestation, up from ~51k in v2 — the extra slot
carries the settled amount, its token and a separate observation date per
dimension). A row carrying an attributed payment costs ~109k, because it writes
a transaction hash, a full amount/token slot and the second event as well.
`commitSweep` is 115,020 gas the first time and 58,250 after that;
`isWithinSweep` is 860 gas and does not move with history — measured identical
at 1, 64 and 1,024 sweeps.

The full historical backfill is ~20,100 rows: **1.23 billion gas, at least 42
transactions** at a 30M block limit. At 25 gwei that is roughly 31 CELO — tens
of dollars, not cents. An earlier draft of this file said "a few transactions
for cents"; it was wrong by three orders of magnitude and is corrected here.

The sources of **every deployment that is still on chain** are frozen under
`contracts/deployed/`, and a test rebuilds each one, so an address stays
verifiable from this repository even though the working contract has moved on:

```bash
CONTRACT_SOURCE=contracts/deployed/ProvenanceAttestationsV3.sol npm run compile
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
| **v4** | `contracts/ProvenanceAttestations.sol` — **not deployed.** Adds the coverage commitments above and a separate observation date per dimension. |
| **v3** | [`0xAD6202F6…6807`](https://celo.blockscout.com/address/0xAD6202F635e97f17f193524CCa66B5D288ab6807) — block 76,082,999, live, **still empty**: no backfill has been written to it |
| owner | `0x6141C737…C4ef` — cold, its only power is rotating the attester |
| attester | `0xC2Dc6B28…972A` — signs verdicts, and nothing else |
| **v2** | [`0x3ed53c9b…01ab`](https://celo.blockscout.com/address/0x3ed53c9bf7f7b5026eae83e4d62abdbd748a01ab) — still live, holds the 20,097 verdicts, one key for both roles |

The key split the counter-analysis asked for is in v3's creation transaction
itself, not a later handover. `npm run deploy` refuses to run at all while
`deployments/celo.json` names a contract that still has code on this chain,
unless `REDEPLOY=1` says so deliberately.

### Deploying a new version over a live one

Each version is a **new contract at a new address**. The 20,097 verdicts stay on
`0x3ed53c…01ab` under v2's semantics, and a new contract starts empty — every
record reads `None` until it is backfilled. Three consequences worth stating
before you deploy:

- Anything already reading the old address keeps reading it. Announce the new
  address rather than assuming a migration happened.
- The backfill needs an export from a **current** audit run: v3 records the
  attribution, amount and observation date that older exports do not carry, and
  v4 adds the coverage root.
  `deployments/backfill-progress.json` from an earlier run must not be reused —
  the script refuses it, because those rows are on a different contract.
- v3 and v4 share function selectors, so `VERSION()` answering is not proof you
  are talking to the contract you compiled. The backfill compares the **deployed
  bytecode** against `out/ProvenanceAttestations.deployed.bin`; without that, a
  v4 run against v3 would land every batch and revert only on `commitSweep`.

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

Before the first batch, the script compares the **deployed bytecode** at the
address in `deployments/celo.json` against `out/ProvenanceAttestations.deployed.bin`
(metadata tail stripped) and stops unless they match and the key is the
attester. Asking `VERSION()` was not enough: consecutive versions share function
selectors, so a v3 contract answering "3.0.0" passed a v4 run — every batch
would land and only `commitSweep` would revert. That file and `out/` are written
by different commands, and sending a batch encoded for one contract to another
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

A **completed** run finishes by committing the coverage claim in the audit's
`out/sweep.json` (path overridable via `SWEEP_JSON`); a partial run commits
nothing, because a sweep must describe a pass that actually finished, and a
missing manifest or a manifest with no `observedRoot` is reported rather than
silently skipped. The root is the one the **indexer** computed over
the records it observed, carried through untouched: rebuilding it here from the
rows being written would produce a root over the attested subset, which proves
only what the events already prove and would quietly answer a different question
than the one `recordsRoot` is documented to answer.

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
- **The attester can still omit.** `commitSweep` makes silence *falsifiable* —
  a published count and root that anybody can re-derive — but it does not make
  it impossible. An attester who simply never commits a sweep for a range has
  claimed nothing about it, and the absence of a claim is not itself evidence.
  A second independent attester remains the fix; this is the honest half-step.
- **A coverage claim is unverified on chain.** The contract cannot read the
  registry's history. It checks only that a sweep does not contradict itself or
  exceed the writes it has actually recorded. Everything else about a sweep is
  an assertion — precise, dated, attributable and cheap to refute, which is the
  most a ledger can offer here, and not the same thing as proof.

## Roadmap

Deploy v4 and backfill it · attester service running continuously on new
feedback, committing a sweep per run · ERC-8004 registration and Self Agent ID
for the service itself · read SDK + MCP endpoint · periodic delta
re-verification · second independent attester, then quorum · a challenge window
with a stake.

MIT.
