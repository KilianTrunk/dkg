module.exports = {
  mocha: {
    timeout: 600_000,
  },
  providerOptions: {
    allowUnlimitedContractSize: true,
  },
  configureYulOptimizer: true,
  // Coverage instrumentation skip list. Two distinct reasons today:
  //
  // 1. `Identity.sol` — cannot be instrumented under the production solc
  //    settings (Solidity 0.8.20 + viaIR + optimizer runs=200):
  //    solidity-coverage's instrumentation adds extra locals to
  //    `addOperationalWallets`, which already sits at the edge of the EVM
  //    stack budget under viaIR, causing `YulException: Variable _3 is 1
  //    too deep in the stack` in CI's push safety net.
  //
  //    Skipped from coverage *instrumentation only*. Production compile
  //    (`hardhat compile` / `hardhat test` / Tornado: Solidity [N/4])
  //    and the contract's bytecode are untouched. The full Hardhat test
  //    suite still exercises every code path in this file at its real
  //    bytecode in the PR sharded Solidity job — the skip removes only
  //    line/branch reporting for this file in the HTML/lcov output.
  //
  // 2. `archive/` — V8/V9 legacy contracts that were intentionally moved
  //    out of the active deploy set in commit 929e29fe
  //    (`refactor(evm-module): archive 9 V8/V9 test files under
  //    test/archive/`). The matching test fixtures were moved to
  //    `test/archive/` in the same change and `hardhat.node.config.ts`
  //    was patched to exclude them from `TASK_TEST_GET_TEST_FILES`. The
  //    contract sources stayed in the tree (kept on-disk for git history
  //    + reference) but nothing in the active deploy set imports them
  //    and no live tests exercise them.
  //
  //    Without this exclusion, solidity-coverage instruments those ~888
  //    lines of dead V8/V9 code, reports them as "0% covered" and drags
  //    the totals beneath the ratchet floors — the post-archive push
  //    safety-net failure is exactly that, not a real coverage
  //    regression on living code. Excluding `archive/` makes the ratchet
  //    measure what we actually ship.
  //
  //    Safety verification — three independent greps that all return
  //    empty are what make this skip safe. Re-run any of them if the
  //    deploy/test layout changes:
  //
  //      A) No active Solidity contract imports anything from `archive/`:
  //         grep -rPn '(from\s+"\./archive|import.*archive)' \
  //              contracts/ --include='*.sol' \
  //              | grep -v 'contracts/archive/'
  //
  //      B) No active deploy script under `deploy/active/` references
  //         an archived contract by name (would trigger a runtime
  //         lookup against the deployments JSON):
  //         for name in KnowledgeAssets KnowledgeAssetsStorage \
  //                     KnowledgeCollection Paymaster PaymasterManager \
  //                     PublishingConvictionAccount Staking \
  //                     DelegatorsInfo ContextGraphNameRegistry IPaymaster
  //         do
  //           grep -rPn "(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|\$)" \
  //                deploy/active/ \
  //             | grep -v 'StakingV10\|StakingStorage\|StakingKPI\|StakingLib\|KnowledgeAssetsV10\|KnowledgeCollectionStorage\|KnowledgeCollectionLib\|KnowledgeAssetsLib\|PublishingConvictionStorage\|PublishingConviction\b\|PaymasterManager\|IPaymaster'
  //         done
  //
  //      C) No active unit/integration test references an archived
  //         contract by name. Same loop as (B), targeting
  //         `test/unit/`, `test/integration/` and `test/helpers/`.
  //
  //    All three were empty when this exclusion was added. Hardhat
  //    `TASK_TEST_GET_TEST_FILES` already excludes `test/archive/`, so
  //    no archived test fixture is ever exercised either.
  skipFiles: ['Identity.sol', 'archive'],
};
