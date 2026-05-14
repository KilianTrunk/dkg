# TODO — Out-of-scope follow-ups from PR #500

This file tracks work that the `archive-non-V10-contracts` effort
(PR #500) deliberately did NOT do. Each entry references parent
PRD §6 of the design run `design-1778745572445069000` and the source
audit in `.scratch/evm-review/triage.md` where applicable.

The list is unordered priority-wise; each is a separate PR.

---

## 1. Add V10 `DKGStakingConvictionNFT.{createConviction,claim}` to chain-adapter

The V10 staking-conviction NFT contract is deployed and exercised by
unit / integration tests, but the chain-adapter (`packages/chain/src`)
has no public TypeScript surface for `createConviction` or `claim`.
SDK consumers (agent, publisher, downstream apps) currently cannot
drive V10 NFT-based staking programmatically. Separate feature PR.

- **Surface needed:** `IChainAdapter.createStakingConviction(...)`,
  `IChainAdapter.claimStakingConviction(...)`.
- **Tests needed:** `packages/chain/test/staking-conviction-v10.test.ts`
  (new file — the legacy `staking-conviction.test.ts` was archived in
  TB-3 as V8-only).
- **Source:** PRD §6 item 1.

## 2. Add V10 `DKGPublishingConvictionNFT.{coverPublishingCost,registerAgent}` to chain-adapter

Same shape as item 1, for the V10 publishing-conviction NFT contract.
Required before any SDK consumer can drive V10 publish-via-NFT flows
without going through the contract ABI directly.

- **Surface needed:** `IChainAdapter.coverPublishingCost(...)`,
  `IChainAdapter.registerPublishingAgent(...)`.
- **Tests needed:** publisher integration test exercising the
  V10 NFT-cover-cost path end-to-end.
- **Source:** PRD §6 item 2.

## 3. Revoke V8/V9 from existing on-chain Hub registries

PR #500 stops V8/V9 from being deployed on every FRESH V10 deploy
(archived deploy scripts don't run). Existing live Hub instances —
`base_sepolia_v10_contracts.json`, mainnet V10 Hub, anything currently
registered — still carry V8/V9 contract addresses in their registry.

This is an ops task, not a code task:

1. For each live Hub, the TracLabs multisig calls
   `Hub.setContractAddress(name, address(0))` (or the registry's
   equivalent retire path) for each V8/V9 entry: `Staking`,
   `KnowledgeAssets`, `KnowledgeCollection`,
   `PublishingConvictionAccount`, `Paymaster`, `PaymasterManager`,
   `DelegatorsInfo`, `KnowledgeAssetsStorage`,
   `ContextGraphNameRegistry`.
2. Verify on-chain Hub view returns the V10 contract set only.
3. Document the runbook step in `docs/RELEASE_PROCESS.md` so future
   fresh deploys never get back into the V8/V9-registered state.

- **Source:** PRD §6 item 3.

## 4. V10-only reward-flywheel coverage

`test/v10-reward-flywheel.test.ts` was archived whole in TB-2 because
its scenarios mixed V8 + V10 stakers (V8 dead → mixed-mode test
proves nothing useful). The V10-native flywheel — `StakingV10` epochs
× `StakingKPI` rewards × `RandomSampling` proof gates — has unit-level
coverage but no end-to-end reward-flywheel coverage that traces a
delegator's stake → epoch → KPI → reward claim in V10-only terms.

- **Test file to add:** `packages/evm-module/test/v10-reward-flywheel-v10-only.test.ts`.
- **Scope:** delegator stakes via `StakingV10.stake`, KPI ticks, RS
  proofs land, reward claim, repeat across at least two epochs.
- **Source:** PRD §6 item 4.

## 5. Delete the `abstract/ContractStatus` mechanism (Proposal 1; L-3/L-4/L-5 closure)

L-3, L-4, L-5 in the audit triage track three bugs in the
`abstract/ContractStatus` + `Hub._setContractAddress` "deactivate the
old contract on re-registration" dance:

- **L-3** `abstract/ContractStatus.sol` has zero non-test consumers.
- **L-4** `Hub._setContractAddress` calls `setStatus(false)` on the
  NEW address instead of the OLD address — the deactivation never
  fires on the contract that was supposed to be retired.
- **L-5** Duplicate `NewContract` event on the new-registration path.

PR #500 archived the V8/V9 contracts that participated in the broken
dance, but the mechanism itself is still in `Hub.sol` and
`abstract/ContractStatus.sol`. The right fix is to delete it outright
(Proposal 1 in the triage doc): single `_setContractAddress` path,
no status flipping, no duplicate event. Depends on PR #500 landing
first — once V8/V9 are no longer redeployed, no live contract needs
the deactivation flow.

- **Files to change:** `packages/evm-module/contracts/Hub.sol`,
  `packages/evm-module/contracts/abstract/ContractStatus.sol`
  (delete file), `packages/evm-module/contracts/abstract/HubDependent.sol`
  (remove ContractStatus inheritance), every V10 contract that
  currently inherits `ContractStatus` indirectly.
- **Tests to update:** Hub registration tests, V10 storage tests
  that incidentally exercise `setStatus`.
- **Source:** PRD §6 item 5; triage rows L-3 / L-4 / L-5.
