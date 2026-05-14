# Architecture Decision Records

Project-level architectural decisions, newest first. Each ADR is a
self-contained record: context, decision, rationale, consequences.

---

## ADR-0001 — kill V8/V9 backward compatibility, V10-only going forward

- **Date:** 2026-05-14
- **Status:** Accepted
- **PR:** #500 (`feat/archive-non-v10-contracts`)
- **Authors:** explorer, implementer, reviewer subagents (orchestrator
  run `design-1778745572445069000` → continuation
  `continue-1778745572445069000-1778758643045304000`)

### Context

The DKG monorepo carried V8 (`Staking`, `KnowledgeAssets`,
`KnowledgeCollection`) and V9 (`PublishingConvictionAccount`,
`Paymaster*`, `DelegatorsInfo`, `ContextGraphNameRegistry`) contracts
alongside their V10 successors. The V10 family — `KnowledgeAssetsV10`,
`StakingV10`, `DKGStakingConvictionNFT`, `DKGPublishingConvictionNFT`,
`ContextGraphs`, plus the V10 storages — fully covers every V8/V9
production surface that any caller in `publisher` or `agent` exercises.

Leaving V8/V9 in-tree had three concrete costs:

1. **~14 kLOC of tests** plus ~5 kLOC of chain-adapter back-compat code
   were on permanent maintenance load, all testing dead code paths.
   When a contract change rippled into V10, somebody still had to fix
   the V8/V9 fixtures even though no production caller cared.
2. **Audit-flagged dead code with bugs kept getting redeployed.** Every
   fresh V10 deploy re-registered V8/V9 contracts into the Hub
   registry: M-10 (Paymaster.coverCost trust gap), M-11 (V9 quorum
   signature replay across chains and deployments), L-1 (PCA admin
   bypass), L-2 (DelegatorsInfo unrestricted migrate), L-3..L-5
   (`abstract/ContractStatus` dead with bugs). These were dead-code-
   with-bugs in the sense that no production caller exercised them but
   they were still on-chain and live.
3. **Chain-adapter dragged V8/V9 method stubs** (`stakeWithLock*`,
   `publishKnowledgeAssets`, the PCA family, `transferNamespace`,
   `permanentPublish`, `extendStoringPeriod`) that only legacy
   chain-adapter tests called. The adapter still chained
   `createKnowledgeAssetsV10` AFTER a V9 `publishKnowledgeAssets` in
   one code path — an architectural bug surfaced by the explorer pass
   that exists only because the V9 path is still wired up.

The trust model — `Hub.owner` = TracLabs multisig, trusted — was
re-confirmed during the explorer pass. Going forward, single protocol
= V10.

### Decision

Archive V8 and V9 contracts, their deploy scripts, the chain-adapter
method stubs that bound to them, the bundled legacy ABIs, and every
unit / integration test file that only exercised V8/V9 paths. Archive
means move under `archive/` subdirectories — NOT delete — so source
remains in-tree for forensic audit and historical reference.

Concretely, in PR #500:

- `packages/evm-module/contracts/archive/` holds the 10 archived
  Solidity files.
- `packages/evm-module/deploy/archive/` holds the 8 archived
  hardhat-deploy scripts; hardhat-deploy's
  `paths.deploy = ['deploy']` does not recurse into `archive/`.
- `packages/chain/src/archive/evm-adapter-v8-v9-methods.ts` holds
  verbatim source of the 15 archived adapter methods (V8 staking lock,
  V9 publish, V9 KA queries, full PCA family).
- `packages/chain/abi/archive/` holds the V8/V9 contract ABIs.
- `packages/evm-module/test/archive/`, `packages/chain/test/archive/`,
  `packages/publisher/test/archive/` hold the pure V8/V9 test files.
- Surgical refactors strip V8/V9 fixture lines from V10 tests that
  still have useful V10 assertions (`KnowledgeAssetsV10.test.ts`,
  `v10-e2e-conviction.test.ts` Flow 3, `v10-conviction.test.ts`,
  `chain-lifecycle-extra.test.ts`, `evm-adapter-random-sampling`,
  `evm-adapter-hub-rotation.e2e`).
- `packages/publisher/src/chain-event-poller.ts` no longer subscribes
  to V9 `KnowledgeBatchCreated`. `packages/publisher/src/dkg-publisher.ts`
  no longer calls V9 `updateKnowledgeAssets`. V10
  `publishToContextGraph` is the single publish path.

### Rationale

- **Trust-model alignment.** A single trusted operator (TracLabs
  multisig) running a single protocol family (V10) removes the
  combinatorial test surface that came from having two protocols live
  side-by-side. Pre-V10, V8 ↔ V10 mixed-mode flows like
  `v10-reward-flywheel.test.ts` made sense; once V8 is dead, they
  test no production scenario.
- **Audit hygiene.** Each of M-10, M-11, L-1, L-2 closes simply by not
  re-deploying the corresponding contract. No code patch on a dead
  contract is justifiable; we just stop redeploying it.
- **Source preservation, not deletion.** Archive (not delete) keeps
  every V8/V9 byte in-tree for `git show` lookups and audit reproduction
  without paying the maintenance cost of compiling and testing it on
  every CI run.
- **Consumer-side archive in the same PR.** PR #500's earlier failure
  mode was archiving contracts without archiving their consumer tests
  → red CI on the chain-adapter and publisher packages. This run
  explicitly archives downstream consumers (TBs 3, 4, 5, 6) in the
  same PR so the verification matrix can go fully green before push.

### Consequences

**Positive:**

- Test suite shrinks by ~14 kLOC; the matrix that has to stay green
  reflects only the V10 protocol surface.
- New audit findings on V8/V9 contracts route to "won't fix —
  archived" rather than patches that re-litigate dead code paths.
- Chain-adapter's public TypeScript surface drops every `@deprecated`
  V8 signature, simplifying agent and publisher type-checking.
- Fresh V10 mainnet deploys produce a Hub registry with V10 contracts
  only, eliminating M-10 / M-11 / L-1 / L-2 on the next clean deploy.

**Negative / follow-up work** (see `.ai/todo.md`):

- Existing Hub instances still carry V8/V9 registrations — ops task
  to revoke (separate PR / runbook).
- No V10-native chain-adapter surface yet for
  `DKGStakingConvictionNFT.{createConviction,claim}` or
  `DKGPublishingConvictionNFT.{coverPublishingCost,registerAgent}` —
  these need to be added by separate feature PRs before SDK consumers
  can drive V10 NFT-based staking / publishing programmatically.
- L-3 / L-4 / L-5 require a separate Hub-cleanup PR to delete the
  `abstract/ContractStatus` mechanism and the broken
  `_setContractAddress` deactivation logic. That PR depends on this
  archive landing first.
- The `v10-reward-flywheel.test.ts` mixed-mode tests were archived
  whole; a V10-only flywheel coverage test is a separate add.

### References

- Parent PRD §1..§9: `.orchestrator/runs/design-1778745572445069000/prd.md`
- Continuation PRD: `.orchestrator/runs/continue-1778745572445069000-1778758643045304000/prd.md`
- Triage findings: `.scratch/evm-review/triage.md` (M-10, M-11, L-1..L-5)
- Architecture inventory: `.ai/architecture.md` § V8/V9 archived
- Follow-ups: `.ai/todo.md`
