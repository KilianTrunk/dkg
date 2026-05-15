// .devnet/pca-smoke-lib.mjs — pure helpers for the issue #519 V10 PCA
// HTTP smoke (.devnet/run.mjs). Kept separate so the discount-assertion
// and evidence-report logic is unit-testable without booting a devnet.

// `KnowledgeAssetsV10.publish()` silently demotes to the no-discount
// branch when the publishing wallet is not a registered PCA agent or
// when `epochs != lockDurationEpochs` (PRD §8 risk). A genuine discount
// is `0 < discountedCost < baseCost`; equality means the branch was not
// taken even though HTTP returned 200.
export function assertDiscountTaken({ baseCost, discountedCost }) {
  const base = BigInt(baseCost);
  const disc = BigInt(discountedCost);
  if (disc <= 0n) {
    return { ok: false, reason: `discountedCost=${disc} is not positive` };
  }
  if (disc >= base) {
    return {
      ok: false,
      reason: `no discount applied (silent demotion): discountedCost=${disc} >= baseCost=${base}`,
    };
  }
  return { ok: true, reason: `discount applied: ${disc} < ${base}` };
}
