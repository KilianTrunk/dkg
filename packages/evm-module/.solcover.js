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
  //    Without this exclusion, solidity-coverage instruments those ~3K
  //    lines of dead V8/V9 code, reports them as "0% covered" and drags
  //    the totals beneath the ratchet floors — the post-archive push
  //    safety-net failure is exactly that, not a real coverage
  //    regression on living code. Excluding `archive/` makes the ratchet
  //    measure what we actually ship.
  //
  //    Verified before adding: `grep -r 'from "\\./archive\\|import.*archive'
  //    contracts/ --include='*.sol' | grep -v 'contracts/archive/'`
  //    returns nothing — no active contract imports anything in
  //    `archive/`, so the skip is safe.
  skipFiles: ['Identity.sol', 'archive'],
};
