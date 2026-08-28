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

`contracts/ProvenanceAttestations.sol` — a single self-contained file, ~215
lines, no dependencies, no funds custody, no external calls, no payable path.

| Verdict | Meaning |
|---|---|
| `1 PaymentVerified` | claimed tx exists, succeeded, moved value |
| `2 TxNotFound` | claimed tx absent from Celo (or claim malformed) |
| `3 TxFailed` | claimed tx exists but reverted |
| `4 NoValueMoved` | tx exists, succeeded, moved nothing relevant |
| `5 EvidenceUnreachable` | the feedback file no longer resolves |

Records are keyed by the registry's own tuple `(agentId, clientAddress,
feedbackIndex)`. Re-attestation is allowed by design — verdicts can change (a
file dies later, a transaction appears later) — and bumps a `revision` counter;
prior states remain in the immutable event history.

**Trust model, stated plainly:** verdicts are written by a single accountable
attester, rotatable by the owner. This is honest centralization: the attestation
process is open source and reproducible, so anyone can re-run it and dispute a
verdict publicly. Decentralizing the attester (staked re-execution, quorum) is
roadmap, not premise.

## Build & test

```bash
npm install
npm test        # compiles, then runs the suite on a real in-process EVM
```

No framework: `solc` compiles, `@ethereumjs/vm` executes. 21 tests cover
authorization, overwrite semantics, event contents, batching and the
unforgeability of the "never attested" state. A 100-row batch costs ~5.1M gas
(~51k per attestation — the full historical backfill fits in two transactions
for cents).

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

Reads the audit's `claims.csv` and event cache (paths overridable via
`CLAIMS_CSV` / `FEEDBACK_CACHE`), recovers each record's `feedbackIndex` by
join, maps audited outcomes to verdicts, and refuses to silently drop anything
that fails the join.

## Roadmap

Attester service running continuously on new feedback · ERC-8004 registration
and Self Agent ID for the service itself · read SDK + MCP endpoint · multi-
attester verification.

MIT.
