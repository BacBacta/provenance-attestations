# provenance-ledger

Read ERC-8004 reputation attestations from the Provenance ledger on Celo.

```
npm install provenance-ledger viem
```

## The problem this solves

The attestation contract answers one question per record and answers it
honestly, but the honest answer is ambiguous. `getAttestation` returns `None`
for a record nobody attested — and `None` means two entirely different things:

- the record's block is **inside** a standing coverage claim, so the attester
  *did* say it examined that range and wrote nothing about this record; or
- the record's block is **outside** every standing claim, so the attester never
  claimed to look at all.

A consumer that reads both as "no evidence" is misled in one direction; one that
reads both as "not checked yet" is misled in the other. Making that difference
answerable is the whole reason the ledger publishes coverage claims, and nothing
in the raw read surface makes it hard to ignore. This package makes it hard to
ignore.

## Use

```js
import { createPublicClient, http } from 'viem'
import { celo } from 'viem/chains'
import { readLedger, summarise, contract } from 'provenance-ledger'

const client = createPublicClient({ chain: celo, transport: http() })

// Records you already hold — from your own indexer, or from the audit's
// published exports. agentId, clientAddress and feedbackIndex identify a
// record; blockNumber lets coverage be answered; feedbackURI and feedbackHash
// let silence the registry itself explains be named as such.
const rows = await readLedger(client, contract, [
  {
    agentId: 9734n,
    clientAddress: '0x…',
    feedbackIndex: 33n,
    blockNumber: 76246058n,
    feedbackURI: 'https://…/rating.json',
    feedbackHash: '0x…',
  },
])

for (const r of rows) {
  switch (r.standing) {
    case 'attested':  // r.verdict, r.evidence, r.payment, r.amount, r.revision
    case 'silent':    // inside a claim, nothing written. r.derivable may explain it
    case 'uncovered': // outside every claim — NOT the same as "no evidence"
  }
}

summarise(rows) // { total, attested, silent, silentDerivable, uncovered, verdicts }
```

## Two dimensions, not one verdict

A record's file and its payment are independent facts, and one slot cannot carry
both. `evidence` and `payment` are recorded side by side, so you can ask
"settled **and** intact" instead of guessing which question the headline verdict
answered. The payment dimension is sticky: a settled transfer does not stop
having happened because its evidence file went offline years later.

## Explained silence

The first backfill deliberately omitted 9,628 records whose rung is decided by
the registry event alone — `feedbackURI === "" && feedbackHash !== 0`. Those read
`None` inside a claimed sweep, which looks exactly like the attester ducking a
question. It is not, and you already hold the event that proves it. Supply
`feedbackURI` and `feedbackHash` and those rows come back with
`derivable: 'EvidenceAbsent'` rather than counted against the attester.

`derivableFromRegistry(record)` exposes the predicate on its own, so you never
have to trust our list of what was skipped.

## What this does not claim

- **Verified is not attributed.** `PaymentVerified` says a transaction settled,
  not that this reviewer paid this agent. Treat it as weight, never as a filter;
  `PaymentAttributed` is the strong rung.
- **Attribution is a lower bound.** It matches the agent's registered NFT owner,
  so an agent paid at an operator address it controls but does not hold the token
  for reads as unattributed.
- **`EvidenceUnhashed` is not tampering.** It says today's bytes do not hash to
  what was attested; it does not date the divergence, and a publisher who hashed
  with sha256 or whose server re-serialises fails from day one.
- **One attester.** Coverage claims make omission *falsifiable* — a published
  count and Merkle root anyone can re-derive — not impossible. An attester that
  never claims a range has asserted nothing about it, and the absence of a claim
  is not itself evidence.
- **The address is pinned.** `CELO.address` and `CELO.version` describe the
  deployment as of this release. Read `VERSION()` from chain if you need to be
  sure rather than trusting a published constant.

## Verify it yourself

Nothing here asks for trust. The methodology is open source, the retrieval rules
are fingerprinted, and every published run ships the rows it was derived from,
so any verdict can be recomputed:

- ledger — [`0x86931Ae7…78a7`](https://celo.blockscout.com/address/0x86931Ae74F5cE9AA8bf818808e47102516CE78a7) (source verified)
- attester identity — ERC-8004 agent `#9786`
- code and published runs — <https://github.com/BacBacta/provenance-attestations>
- audit methodology — <https://github.com/BacBacta/celo-agent-feedback-audit>

MIT.
