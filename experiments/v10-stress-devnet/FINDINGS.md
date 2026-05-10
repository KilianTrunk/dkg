# V10 stress devnet — findings

Curated snapshot of bugs and observations surfaced by `pnpm test:devnet:v10-stress` against a fresh 6-core devnet. The suite drives 20 stakers, 100 publishes (mixed lifecycle stages and publisher modes), a mid-run 7th core, RS reconciliation, ERC-721 stake-NFT transfers, and the claim/withdraw/restake reward lifecycle — see the test header for full scope. Runtime evidence is regenerated at `FINDINGS.local.md` on each run.

## Bugs filed

### Bug 1 — `publishFromFinalizedAssertion` bundles all SWM content

**Where:** `packages/agent/src/dkg-agent.ts:4383` — `publishFromFinalizedAssertion` calls `publishFromSharedMemory(contextGraphId, 'all', …)` with the literal selection `'all'`. SWM content is **not** filtered to the named assertion's quads.

**Reproduction:**
1. `POST /api/assertion/create { …, finalize: true, promote: true }` for assertion `A`.
2. `POST /api/assertion/create { …, finalize: true, promote: true }` for assertion `B`.
3. `POST /api/shared-memory/publish { assertionName: A }`.

**Observed:** the publish bundles A∪B's quads into one KC. The publisher derives a merkle root over the actual bundled SWM content, which does not match the seal's merkle root computed at finalize time over only A's quads, so the publisher returns `tentative` with `kcId: "0"` (sentinel rejection) and the on-chain submission is skipped.

**Expected:** publishing assertion `A` by name publishes exactly A's sealed content.

**Fix direction:** either
1. extract the named assertion's rootEntities at finalize time and pass `selection: { rootEntities: [...] }` to `publishFromSharedMemory`, or
2. promote each assertion's quads into a per-assertion graph (e.g. `<assertionUri>/data`) so SWM-wide selection naturally scopes to one assertion. Option 2 is cleaner because it also lets concurrent promotes run without interfering, but it touches the storage layer.

**Workaround in the suite:** drain SWM at phase start (`shared-memory/publish { selection: 'all', clearAfter: true }`), and run all named-publish batches before any "promote and leave in SWM" batch. This preserves the test's intent at the cost of being unrepresentative of real client patterns.

### Bug 2 — Publisher nonce race during back-to-back publishes

**Where:** publisher / chain-adapter nonce management. The publisher's operational-wallet pool reads the on-chain nonce as `latest` rather than `pending`, and a second publish that lands on the same wallet inside the same block window can pick a stale value.

**Reproduction (probabilistic, ~1 in 25 fresh-cluster publishes):** issue rapid-fire `POST /api/shared-memory/publish { assertionName }` calls into the same daemon. Some `token.approve` or KC-create transactions revert with `Nonce too low. Expected nonce to be N+1 but got N`, and the publish flips to `tentative kcId: "0"`.

**Why it doesn't always fire:** the pool rotates through op-wallets, so adjacent publishes usually hit different wallets. Hitting the same wallet within the stale window is what triggers it. Background work (gossip-publish reactions, worker sweeps) can also occupy a wallet behind the scenes, which is what we suspect occasionally beats the foreground request to a nonce.

**Fix direction:** the chain-adapter should switch nonce-fetching to `eth_getTransactionCount(wallet, 'pending')`, OR the op-wallet pool should track per-wallet pending nonces in-process and refuse to dispatch until the previous tx is mined. The latter is more defensive against external tx submissions; the former is a one-line change in the adapter.

**Workaround in the suite:** insert a 2s gap before the VM-custodial batch and retry once on `tentative` after a 2s back-off. This let the test pass in CI but masks the bug for end users.

## Warnings (worth investigating, not necessarily bugs)

### Mid-run added cores do not back-fill historical KCs before RS challenges

**Phase 3 evidence:** spinning up a 7th core mid-run, registering identity, staking, and setting ask works in <30s. RS prover comes online and ticks. But every challenge for ~120s lands on a KC the new node never received gossip for, so the prover correctly reports `kcId-not-synced` and submits zero proofs.

This is **expected** under V10's gossip-only sync (new nodes don't auto-fetch historical chunks), but it means a mid-run core takes one full epoch worth of new publishes (or a manual chunk sync) before it can begin earning RS rewards. Worth confirming whether that's the intended bootstrap UX or whether a "pull missed-publishes since identityId mint" backfill should run at startup.

### RS proof submission rate is below 100% per epoch

**Phase 4 evidence:** of 5 active cores in the proof window, only 2 submitted proofs within 120s of the time-warp. Of those 2, 1 had on-chain score 0 (i.e. the proof was accepted but the score path didn't credit it). The other 3 cores never submitted within the window.

Possibilities to triage:
- challenge distribution doesn't reach all cores within one tick of the proof period
- chunk availability gap (related to Bug 1's bundling — KCs may not have been correctly disseminated in the first place)
- score-formula edge case at low publish counts.

This phase soft-fails (logs the gap, doesn't block the suite) so the test still completes — but the absolute numbers should be tightened before mainnet.

## Confirmed working (no findings)

- **Phase 1 — 20 stakers, mixed tiers (0/1/3/6/12), 4 cores:** total staked 30,000 TRAC, vault delta matches sum-of-stakes exactly, NFT count == 20.
- **Phase 5 — staking NFT transfer:** ERC-721 `safeTransferFrom` succeeds; the new owner can `redelegate` with a stable tokenId; per-node `getNodeStake` correctly rebalances.
- **Phase 5 — KC author-immutability documented:** `KnowledgeCollection.author` is the EIP-712 signer baked into the merkle root at finalize time and is immutable post-publish (verified by absence of any `transfer*`/`setOwner*` selectors in `KnowledgeCollection*.sol`). RFC-001 §9.6 sketches a signed-update flow that would let a new author take over a KC by re-signing the root at update time; not implemented today. The transferable assets in V10 staking are the staking NFTs — KCs themselves are bound to authorship.
- **Phase 6 — claim / atomic withdraw / restake:** withdrew a tier-0 NFT (1000 TRAC out, original stake 1000 TRAC), restaked 500 TRAC at tier-1 with a fresh NFT. NFT burned cleanly, TRAC totals reconcile within 5% (small dilution = RS reward distribution noise from the same wallet).

## Mode coverage matrix (Phase 2)

|                       | WM-only | WM→SWM | WM→SWM→VM |
|-----------------------|---------|--------|-----------|
| custodial-agent       | 25      | 25     | 25        |
| third-party (PCA, mode A) | —   | —      | 25        |
| pre-signed self-sovereign (mode C) | — | — | 0 *      |
| unattributed          | —       | —      | 0 *       |

\* mode C and unattributed mode are exercised in `experiments/agent-provenance-devnet/automated.test.ts` instead — those paths require client-side EIP-712 + V10 merkle-root computation, which is the express scope of the agent-provenance suite.

## Repro

```bash
./scripts/devnet.sh clean
./scripts/devnet.sh start 6
pnpm test:devnet:v10-stress
```

The suite is deterministic given a clean devnet (assertion names are run-tagged with a timestamp, but every other identifier — staker indices, NFT tokenIds, identityIds — is recomputed against the live chain state). Re-running against an already-in-flight devnet is supported (the suite skips identity/registration steps if already present).
