import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  CGWeightTreeStorage,
  Chronos,
  ContextGraphValueStorage,
  Hub,
} from '../../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Tree: CGWeightTreeStorage;
  CGV: ContextGraphValueStorage;
  Chronos: Chronos;
  Hub: Hub;
};

describe('@unit CGWeightTreeStorage', () => {
  let accounts: SignerWithAddress[];
  let Tree: CGWeightTreeStorage;
  let CGV: ContextGraphValueStorage;
  let ChronosCtr: Chronos;

  async function deployFixture(): Promise<Fixture> {
    await hre.deployments.fixture(['CGWeightTreeStorage']);
    const TreeLocal =
      await hre.ethers.getContract<CGWeightTreeStorage>('CGWeightTreeStorage');
    const CGVLocal = await hre.ethers.getContract<ContextGraphValueStorage>(
      'ContextGraphValueStorage',
    );
    const ChronosLocal = await hre.ethers.getContract<Chronos>('Chronos');
    const HubLocal = await hre.ethers.getContract<Hub>('Hub');
    return {
      accounts: await hre.ethers.getSigners(),
      Tree: TreeLocal,
      CGV: CGVLocal,
      Chronos: ChronosLocal,
      Hub: HubLocal,
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Tree,
      CGV,
      Chronos: ChronosCtr,
    } = await loadFixture(deployFixture));
  });

  // ---- brute-force oracles (JS) ----
  const sortedCgs = (w: Map<number, bigint>) =>
    [...w.keys()].sort((a, b) => a - b);

  function bruteFind(
    w: Map<number, bigint>,
    r: bigint,
    excluded: Set<number> = new Set(),
  ): number {
    let acc = 0n;
    for (const cg of sortedCgs(w)) {
      if (excluded.has(cg)) continue;
      acc += w.get(cg)!;
      if (acc > r) return cg;
    }
    return 0; // r >= total (callers stay within [0, total))
  }

  const total = (w: Map<number, bigint>, excluded: Set<number> = new Set()) =>
    [...w.entries()].reduce(
      (s, [cg, x]) => s + (excluded.has(cg) ? 0n : x),
      0n,
    );

  async function seedAll(w: Map<number, bigint>) {
    for (const [cg, weight] of w) await Tree.seed(cg, weight);
  }

  it('Should have correct name and version', async () => {
    expect(await Tree.name()).to.equal('CGWeightTreeStorage');
    expect(await Tree.version()).to.equal('1.0.0');
  });

  it('Capacity is a power of two and starts backfill-locked', async () => {
    const cap = await Tree.BIT_CAPACITY();
    expect(cap & (cap - 1n)).to.equal(0n);
    expect(await Tree.backfillLocked()).to.equal(true);
  });

  it('seed updates cgWeight and bitTotal (and adjusts in place)', async () => {
    await Tree.seed(3, 10n);
    await Tree.seed(7, 25n);
    expect(await Tree.cgWeight(3)).to.equal(10n);
    expect(await Tree.cgWeight(7)).to.equal(25n);
    expect(await Tree.bitTotal()).to.equal(35n);
    await Tree.seed(3, 4n);
    expect(await Tree.cgWeight(3)).to.equal(4n);
    expect(await Tree.bitTotal()).to.equal(29n);
  });

  it('Distribution parity: findStrictGt matches brute-force prefix lower-bound for all r', async () => {
    const w = new Map<number, bigint>([
      [1, 10n],
      [2, 0n],
      [3, 5n],
      [5, 7n],
      [8, 3n],
      [13, 1n],
    ]);
    await seedAll(w);
    const T = total(w);
    expect(await Tree.bitTotal()).to.equal(T);
    for (let r = 0n; r < T; r++) {
      expect(Number(await Tree.findStrictGt(r))).to.equal(
        bruteFind(w, r),
        `r=${r}`,
      );
    }
  });

  it('Zero-weight leaves are never drawn', async () => {
    const w = new Map<number, bigint>([
      [1, 0n],
      [2, 10n],
      [3, 0n],
      [4, 0n],
      [5, 5n],
    ]);
    await seedAll(w);
    const T = total(w);
    const landed = new Set<number>();
    for (let r = 0n; r < T; r++)
      landed.add(Number(await Tree.findStrictGt(r)));
    expect([...landed].sort((a, b) => a - b)).to.deep.equal([2, 5]);
  });

  it('Renormalization: exclude-one over equal weights stays UNIFORM (the regression)', async () => {
    // 4 equal-weight CGs, exclude CG2 -> survivors {1,3,4} must be EQUIPROBABLE.
    // The rejected "advance to next nonzero leaf" approach would yield 1=1/3, 3=2/3, 4=0.
    const w = new Map<number, bigint>([
      [1, 10n],
      [2, 10n],
      [3, 10n],
      [4, 10n],
    ]);
    await seedAll(w);
    const excluded = [2];
    const wt = await Tree.workingTotal(excluded);
    expect(wt).to.equal(30n);
    const counts: Record<number, number> = {};
    for (let r = 0n; r < wt; r++) {
      const cg = Number(await Tree.findStrictGtExcluding(r, excluded));
      counts[cg] = (counts[cg] || 0) + 1;
    }
    expect(counts[2] ?? 0).to.equal(0); // excluded never drawn
    expect(counts[1]).to.equal(10); // each survivor = exactly 1/3 of [0,30)
    expect(counts[3]).to.equal(10);
    expect(counts[4]).to.equal(10); // tail NOT starved
  });

  it('Renormalization: random weights and excluded sets match brute force exactly', async () => {
    const w = new Map<number, bigint>([
      [1, 3n],
      [2, 11n],
      [4, 1n],
      [6, 7n],
      [9, 5n],
      [12, 9n],
      [20, 2n],
    ]);
    await seedAll(w);
    const excludedSets = [[], [2], [1, 20], [6, 9, 12], [2, 4, 6, 9]];
    for (const ex of excludedSets) {
      const set = new Set(ex);
      const wt = total(w, set);
      expect(await Tree.workingTotal(ex)).to.equal(wt);
      for (let r = 0n; r < wt; r++) {
        expect(Number(await Tree.findStrictGtExcluding(r, ex))).to.equal(
          bruteFind(w, r, set),
          `ex=${ex} r=${r}`,
        );
      }
    }
  });

  it('Fixed capacity: correct across multiple 2^k boundaries (growth-corruption regression)', async () => {
    // ids straddling internal-node boundaries 4, 8, 16, 32, 64.
    const w = new Map<number, bigint>([
      [3, 5n],
      [5, 8n],
      [9, 2n],
      [17, 6n],
      [33, 4n],
      [64, 9n],
    ]);
    await seedAll(w);
    const T = total(w);
    expect(await Tree.bitTotal()).to.equal(T);
    for (let r = 0n; r < T; r++) {
      expect(Number(await Tree.findStrictGt(r))).to.equal(
        bruteFind(w, r),
        `r=${r}`,
      );
    }
  });

  it('_bitUpdate guard: id 0 and id >= BIT_CAPACITY revert', async () => {
    const cap = await Tree.BIT_CAPACITY();
    await expect(Tree.seed(0, 1n)).to.be.revertedWithCustomError(
      Tree,
      'CgIdOutOfBitCapacity',
    );
    await expect(Tree.seed(cap, 1n)).to.be.revertedWithCustomError(
      Tree,
      'CgIdOutOfBitCapacity',
    );
    await expect(Tree.seed(cap + 5n, 1n)).to.be.revertedWithCustomError(
      Tree,
      'CgIdOutOfBitCapacity',
    );
  });

  it('seed is gated to the backfill window', async () => {
    await Tree.seed(1, 5n);
    await Tree.finishBackfill();
    expect(await Tree.backfillLocked()).to.equal(false);
    await expect(Tree.seed(1, 9n)).to.be.revertedWithCustomError(
      Tree,
      'NotBackfilling',
    );
  });

  it('settle reconciles a leaf to ledger truth and self-heals on expiry', async () => {
    await Tree.finishBackfill();
    const cg = 1n;
    const epoch = await ChronosCtr.getCurrentEpoch();
    await CGV.addCGValueForEpochRange(cg, epoch, 1, 1000); // value 1000, lifetime 1 epoch
    await Tree.settle(cg);
    expect(await Tree.cgWeight(cg)).to.equal(1000n);
    expect(await Tree.bitTotal()).to.equal(1000n);
    expect(await CGV.getCGValueAtEpoch(cg, epoch)).to.equal(1000n);

    // advance one epoch -> window lapsed; settle-on-miss zeroes the leaf
    const epochSeconds = Number(await ChronosCtr.epochLength());
    await time.increase(epochSeconds + 1);
    await Tree.settle(cg);
    expect(await Tree.cgWeight(cg)).to.equal(0n);
    expect(await Tree.bitTotal()).to.equal(0n);
  });
});
