// One-time migration: seed the CGWeightTreeStorage Fenwick index from the existing
// ContextGraphValueStorage ledger, validate, then unlock the value-weighted draw.
//
// Works for both a fresh chain (no weighted CGs -> seeds nothing, just unlocks) and an
// upgrade (existing CGs -> seeds active leaves in batches). Run as the Hub owner:
//
//   npx hardhat run scripts/migrate-cg-weight-tree.ts --network base_sepolia_v10 --config hardhat.node.config.ts
//
// Idempotency: aborts if the tree is already unlocked (migration already done).
//
// Why this is cheap: each leaf weight is read off-chain via getCGValueAtEpoch (a view; the
// O(D) per-epoch replay runs on the RPC node for free), and seedMany only does O(k.log)
// SSTOREs. So we batch by COUNT, not gas. The ledger is finalized lazily later (settle-on-
// spend / settle-on-miss), so no O(D) on-chain work happens here.
import hre from 'hardhat';

const BATCH = 200; // CGs per seedMany tx (each seed is O(log); tune down if a tx nears the gas cap)

async function main() {
  const { ethers, deployments } = hre;
  const [signer] = await ethers.getSigners();
  console.log(`migrator (Hub owner): ${signer.address}`);

  const tree = await ethers.getContractAt(
    'CGWeightTreeStorage',
    (await deployments.get('CGWeightTreeStorage')).address,
    signer,
  );
  const cgStorage = await ethers.getContractAt(
    'ContextGraphStorage',
    (await deployments.get('ContextGraphStorage')).address,
    signer,
  );
  const cgValue = await ethers.getContractAt(
    'ContextGraphValueStorage',
    (await deployments.get('ContextGraphValueStorage')).address,
    signer,
  );
  const chronos = await ethers.getContractAt(
    'Chronos',
    (await deployments.get('Chronos')).address,
    signer,
  );

  if (!(await tree.backfillLocked())) {
    console.log('Tree already unlocked (backfillLocked=false) — migration already done. Aborting.');
    return;
  }

  const currentEpoch: bigint = await chronos.getCurrentEpoch();
  const counter: bigint = await cgStorage.getLatestContextGraphId();
  console.log(`currentEpoch=${currentEpoch} cgCount=${counter}`);

  // 1) Off-chain: compute the active, nonzero current-epoch leaf for every CG.
  const cgIds: bigint[] = [];
  const weights: bigint[] = [];
  let expectedTotal = 0n;
  for (let cg = 1n; cg <= counter; cg++) {
    if (!(await cgStorage.isContextGraphActive(cg))) continue; // Invariant 2: inactive -> leaf 0
    let w = 0n;
    try {
      w = await cgValue.getCGValueAtEpoch(cg, currentEpoch);
    } catch (e) {
      console.warn(`  cg ${cg}: getCGValueAtEpoch reverted (${(e as Error).message.slice(0, 60)}) — seeding 0`);
    }
    if (w > 0n) {
      cgIds.push(cg);
      weights.push(w);
      expectedTotal += w;
    }
    if (cg % 500n === 0n) console.log(`  scanned ${cg}/${counter}`);
  }
  console.log(`weighted (active, nonzero) CGs: ${cgIds.length}, Σweight=${expectedTotal}`);

  // 2) On-chain: seed in batches (O(k.log) per batch).
  for (let i = 0; i < cgIds.length; i += BATCH) {
    const cgBatch = cgIds.slice(i, i + BATCH);
    const wBatch = weights.slice(i, i + BATCH);
    const tx = await tree.seedMany(cgBatch, wBatch);
    await tx.wait();
    console.log(`  seeded ${Math.min(i + BATCH, cgIds.length)}/${cgIds.length}`);
  }

  // 3) Validate: bitTotal == Σ seeded leaves, and cross-check against the ledger's global total.
  const bitTotal: bigint = await tree.bitTotal();
  if (bitTotal !== expectedTotal) {
    throw new Error(`bitTotal ${bitTotal} != Σseeded ${expectedTotal} — migration corrupt, NOT unlocking`);
  }
  let globalTotal = 0n;
  try {
    globalTotal = await cgValue.getTotalValueAtEpoch(currentEpoch);
  } catch {
    /* getter may not exist on older deploys; skip cross-check */
  }
  console.log(`bitTotal=${bitTotal} (== Σseeded ✓)  ledger getTotalValueAtEpoch=${globalTotal}`);
  if (globalTotal !== 0n && globalTotal !== bitTotal) {
    console.warn(
      `  NOTE: global total ${globalTotal} != bitTotal ${bitTotal}. Expected only if some CGs are ` +
        `inactive-but-valued (excluded from the tree by Invariant 2). Verify before relying on it.`,
    );
  }

  // 4) Unlock the draw.
  const tx = await tree.finishBackfill();
  await tx.wait();
  console.log('finishBackfill() done — value-weighted draw is live.');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
