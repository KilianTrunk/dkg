# Architecture — DKG monorepo

This document tracks the high-level architectural shape of the DKG monorepo
that is observable from `packages/*` and the deploy pipeline. It is curated
by the orchestrator's explorer subagent across runs; implementer subagents
read it but only the `V8/V9 archived` subsection is appended to as the
archive-non-V10 effort closes.

The canonical narrative architecture lives in root-level `ARCHITECTURE.md`.
This file complements it with the V10-only protocol surface and a precise
inventory of what was archived in PR #500.

## V10 protocol family (kept)

The live protocol surface after PR #500 lands.

### Contracts

- `KnowledgeAssetsV10.sol`
- `StakingV10.sol`
- `DKGStakingConvictionNFT.sol`
- `DKGPublishingConvictionNFT.sol`
- `RandomSampling.sol`
- `StakingKPI.sol`
- `Profile.sol`
- `Identity.sol`
- `Ask.sol`
- `ContextGraphs.sol`
- `Hub.sol`
- `Token.sol`
- `contracts/abstract/ContractStatus.sol`
- `contracts/abstract/HubDependent.sol`

### V10 storages

- `ConvictionStakingStorage`
- `ContextGraphStorage`
- `ContextGraphValueStorage`
- `ContextGraphKnowledgeCollectionsRegistry`

### Off-chain packages (V10-only after PR #500)

- `packages/chain` — chain-adapter; V8/V9 method surface moved to `src/archive/`.
- `packages/publisher` — `chain-event-poller` consumes V10
  `ContextGraphCreated`/`KCCreated` only; `dkg-publisher` uses
  `publishToContextGraph`. The V9 `KnowledgeBatchCreated` subscription and
  the V9 `updateKnowledgeAssets` call path were stripped in TB-5.
- `packages/agent` — already V10-only by intent; the `sync-responder`
  per-CGID-meta path was confirmed during TB-6 spot-check.

## V8/V9 archived

This subsection enumerates everything the `archive-non-V10-contracts`
effort removed from the live protocol surface. Source is preserved under
`archive/` subdirectories — nothing was deleted — so future audits and
forensic queries can still reconstruct the exact contract bodies, ABIs,
and adapter methods that ran on mainnet between V8 and V9.

### Why we archived

Trust model: `Hub.owner` = TracLabs multisig, trusted. Going forward,
single protocol = V10. Leaving V8/V9 in-tree forced ~14 kLOC of unit and
integration tests on permanent maintenance load for code paths no
production caller in `publisher` or `agent` exercises, kept audit-flagged
dead code with bugs deployed into the Hub registry on every fresh deploy
(M-10, M-11, L-1, L-2, L-3, L-4, L-5), and forced the chain-adapter to
ship V8/V9 method stubs that only legacy chain-adapter tests called.

### Contracts archived

Moved under `packages/evm-module/contracts/archive/`:

- `Staking.sol` (V8)
- `KnowledgeAssets.sol` (V8)
- `KnowledgeCollection.sol` (V8)
- `PublishingConvictionAccount.sol` (V9 PCA)
- `Paymaster.sol` (V9)
- `ContextGraphNameRegistry.sol` (V9)
- `storage/PaymasterManager.sol`
- `storage/DelegatorsInfo.sol`
- `storage/KnowledgeAssetsStorage.sol`
- `interfaces/IPaymaster.sol`

### Deploy scripts archived

Moved under `packages/evm-module/deploy/archive/`:

- `016_deploy_paymaster_manager.ts`
- `021_deploy_delegatorsInfo.ts`
- `023_deploy_staking.ts`
- `026_deploy_knowledge_collection.ts`
- `040_deploy_knowledge_assets_storage.ts`
- `041_deploy_knowledge_assets.ts`
- `042_deploy_context_graph_name_registry.ts`
- `043_deploy_publishing_conviction_account.ts`

hardhat-deploy's `paths.deploy = ['deploy']` does not recurse into
`deploy/archive/`, so these scripts no longer run on a fresh devnet boot
or a fresh V10 mainnet deploy.

### Chain-adapter source archived

Moved under `packages/chain/src/archive/evm-adapter-v8-v9-methods.ts`
(verbatim bodies preserved from `orch/archive-non-v10-contracts/0003`):

- V8 staking lock: `stakeWithLock`, `stakeWithLockTier`
- V9 publish: `publishKnowledgeAssets`, `permanentPublish`,
  `extendStoringPeriod`, `transferNamespace`
- V9 KA queries: `getKnowledgeAsset`, `updateKnowledgeAsset` (V9 shape)
- PCA family: `createAccount`, `addFunds`, `extendLock`,
  `coverPublishingCost`, `getAccountInfo`, `getDiscountInfo`,
  `getDelegatorConvictionMultiplier`, `isPCAAuthorizedKey`,
  `addPCAAuthorizedKey`

Bundled ABIs corresponding to archived contracts moved under
`packages/chain/abi/archive/`.

### Tests archived

`packages/evm-module/test/archive/`:

- `test/unit/KnowledgeCollection.test.ts`
- `test/unit/PublishingConvictionAccount.test.ts`
- `test/unit/Paymaster.test.ts`
- `test/unit/Staking.test.ts`
- `test/unit/DelegatorsInfo.test.ts`
- `test/integration/Staking.test.ts`
- `test/integration/StakingRewards.test.ts`
- `test/integration/D26TimeAccurateStaking.test.ts`
- `test/pentest/PT-2-staking-v8.test.ts`
- `test/pentest/PT-3-conviction-h1-pca-lock-bypass.test.ts`
- `test/v10-reward-flywheel.test.ts` (V8↔V10 mixed-mode coverage)

`packages/chain/test/archive/`:

- `test/conviction-account.test.ts` (9 PCA tests)
- `test/staking-conviction.test.ts` (4 V8 stakeWithLock tests)
- `test/evm-e2e.test.ts` (9 V8 publish/update/extend/transferNamespace)
- `test/permanent-publishing.test.ts` (2 V8 KA permanent publish)

`packages/publisher/test/archive/`: any pure V9 publisher tests
identified in TB-5.

### Surgical refactors (V8/V9 setup stripped, V10 logic preserved)

- `packages/evm-module/test/unit/KnowledgeAssetsV10.test.ts`
- `packages/evm-module/test/v10-e2e-conviction.test.ts`
- `packages/evm-module/test/v10-conviction.test.ts`
- `packages/evm-module/test/pentest/PT-3-conviction-fixture.ts`
- `packages/chain/test/chain-lifecycle-extra.test.ts`
- `packages/chain/test/evm-adapter-random-sampling.test.ts`
- `packages/chain/test/evm-adapter-hub-rotation.e2e.test.ts`
- `packages/publisher/src/chain-event-poller.ts`
- `packages/publisher/src/dkg-publisher.ts`
- `packages/publisher/test/chain-event-poller-extra.test.ts`
- `packages/publisher/test/publisher-evm-e2e.test.ts`
- `packages/publisher/test/dkg-publisher.test.ts`
- `packages/publisher/test/publish-lifecycle.test.ts`
- Deploy script dependency arrays: `024`, `025`, `031`, `052`, `055`, `998`.

### Audit findings closed by the archive

- **M-10** Paymaster.coverCost no sender/target binding — Paymaster
  archived → not redeployed → not in Hub registry on next V10 deploy.
- **M-11** V9 quorum signature replay across chains/deployments —
  KAv8 + KC archived → V9 signatures no longer redeemable on V10 Hub.
- **L-1** PCA admin balance drain bypass — PCA archived.
- **L-2** DelegatorsInfo.migrate() unrestricted — DelegatorsInfo archived.
- **L-3/L-4/L-5** Hub ContractStatus dead-with-bug dance — the V8/V9
  participants in the broken `setStatus(false)` dance are gone after
  PR #500. The final `abstract/ContractStatus` removal is tracked as a
  separate follow-up (see `.ai/todo.md`).

### Verification matrix

- `pnpm -r build` exits 0 from repo root after TB-7.
- `cd .devnet && DKG_HOME=.devnet/node1 NODE2_DKG_HOME=.devnet/node2 node run.mjs --no-pause` exits 0 iff a live publish/query smoke completes end-to-end. The entrypoint is `.devnet/run.mjs` — the only checked-in file under `.devnet/` (see `!.devnet/run.mjs` in `.gitignore`); everything else under `.devnet/` is gitignored runtime state created by `scripts/devnet.sh start`. The shim chdir's back to repo root, then:
  1. Actively probes Hardhat RPC + node1 `/api/status` + node2 `/api/status` using the auth bearer from `.devnet/nodeN/auth.token`. Filesystem markers alone (`.devnet/hardhat/deployed`, per-node directories) are NOT trusted — a previous boot can leave them present while the daemons are gone, and running the demo against dead daemons would fail with `DKG daemon is not responding` instead of triggering a fresh boot.
  2. If any probe fails, stops any partial devnet, wipes per-node state, and runs `scripts/devnet.sh start 2`. The shim checks port freeness (Hardhat 8545, API base 9201, libp2p base 10001) first and shifts the entire devnet by +10000 if anything on the standard ports belongs to another listener; this prevents wedging at `EADDRINUSE` on shared dev machines. It also sets `DEVNET_ENABLE_PUBLISHER=1` so the per-node publisher answers Phase 1 captures.
  3. After boot the shim re-probes for up to 30 s, aborts with non-zero if liveness still fails, and only then hands off to `demo/epcis-bike/run.mjs`. Exit propagates from the demo.
  Modes via `DEVNET_SMOKE_MODE` (default `full`): `full` = the runtime smoke described above with no fallback (failed runtime smoke fails the test_command); `offline` = static post-archive structural invariants only (no devnet, exit 0 iff every V8/V9 method is absent from `evm-adapter.ts`, `KnowledgeBatchCreated` is gone from `chain-event-poller.ts`, and `.updateKnowledgeAssets(` is gone from `dkg-publisher.ts`). There is intentionally NO auto-fallback from a failed runtime smoke to a structural check — per project memory `feedback_devnet_runtime_verify.md` static checks alone are insufficient.
- `pnpm --filter @origintrail-official/dkg-chain test` green.
- `pnpm --filter @origintrail-official/dkg-publisher test` green.
- `pnpm --filter @origintrail-official/dkg-agent test` green.
- PR #500 CI: every Tornado / Solidity / chain / publisher / agent lane
  is in {SUCCESS, SKIPPED, NEUTRAL}.
