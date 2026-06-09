import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { Chronos, EpochStorage } from '../../typechain';

/**
 * Regression: `addTokensToEpochRange` must never lose tokens credited to an
 * already-finalized epoch, and a credit range must not affect epochs outside
 * it. Finalized epochs can't be paid retroactively, so the credit is clamped
 * forward to the first still-open epoch (funds preserved, distribution bounded).
 */
describe('@unit EpochStorage credit to a finalized epoch is preserved (not dropped)', () => {
  let accounts: SignerWithAddress[];
  let EpochStorage: EpochStorage;
  let Chronos: Chronos;
  let epochSeconds: number;

  async function deployFixture() {
    await hre.deployments.fixture(['EpochStorage', 'Chronos']);
    EpochStorage = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
    Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    epochSeconds = Number(await Chronos.epochLength());
    accounts = await hre.ethers.getSigners();
    return { accounts, EpochStorage, Chronos };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, EpochStorage, Chronos } = await loadFixture(deployFixture));
  });

  async function sumPools(shardId: number, from: number, to: number): Promise<bigint> {
    let total = 0n;
    for (let e = from; e <= to; e++) total += await EpochStorage.getEpochPool(shardId, e);
    return total;
  }

  it('preserves a credit aimed at an already-finalized epoch (clamped forward, not lost)', async () => {
    const shardId = 7001;
    await time.increase(epochSeconds * 5);
    const cur = Number(await Chronos.getCurrentEpoch());

    // Establish finalized history: lastFinalizedEpoch = cur-1.
    await EpochStorage.addTokensToEpochRange(shardId, cur, cur, 1000);
    expect(await EpochStorage.lastFinalizedEpoch(shardId)).to.equal(cur - 1);

    const totalBefore = await sumPools(shardId, cur, cur + 12);
    // Credit aimed at a finalized epoch (cur-2): pre-fix this vanished.
    await EpochStorage.addTokensToEpochRange(shardId, cur - 2, cur - 2, 1000);
    const totalAfter = await sumPools(shardId, cur, cur + 12);

    // The 1000 is preserved in the open range, not dropped.
    expect(totalAfter - totalBefore).to.equal(1000n);
    // A finalized epoch is never retroactively credited.
    expect(await EpochStorage.getEpochPool(shardId, cur - 2)).to.equal(0n);
  });

  it('on an idle shard (lastFinalizedEpoch lags wall clock), a past credit lands in the CURRENT epoch, not a back-dated one', async () => {
    const shardId = 7003;
    await time.increase(epochSeconds * 3);
    const e1 = Number(await Chronos.getCurrentEpoch());

    // Touch the shard once → lastFinalizedEpoch = e1-1, then leave it IDLE.
    await EpochStorage.addTokensToEpochRange(shardId, e1, e1, 1);
    const laggedFinalized = Number(await EpochStorage.lastFinalizedEpoch(shardId)); // e1-1
    expect(laggedFinalized).to.equal(e1 - 1);

    // Wall clock advances well past lastFinalizedEpoch without any shard activity.
    await time.increase(epochSeconds * 5);
    const cur = Number(await Chronos.getCurrentEpoch());
    expect(cur).to.be.greaterThan(laggedFinalized + 1); // the shard is "idle"

    const staleTarget = laggedFinalized + 1; // where a naive clamp would back-date to (a past epoch)
    const curBefore = await EpochStorage.getEpochPool(shardId, cur);
    const staleBefore = await EpochStorage.getEpochPool(shardId, staleTarget);

    // Backfill a credit aimed at a long-past epoch.
    await EpochStorage.addTokensToEpochRange(shardId, laggedFinalized - 1, laggedFinalized - 1, 1000);

    // It lands in the genuinely-open CURRENT epoch — not back-dated into the
    // already-elapsed (and possibly already-claimable) `lastFinalizedEpoch + 1`.
    expect((await EpochStorage.getEpochPool(shardId, cur)) - curBefore).to.equal(1000n);
    expect(await EpochStorage.getEpochPool(shardId, staleTarget)).to.equal(staleBefore);
  });

  it('a settlement range does not corrupt the pool of an epoch outside it', async () => {
    const shardId = 7002;
    await time.increase(epochSeconds * 5);
    const cur = Number(await Chronos.getCurrentEpoch());
    await EpochStorage.addTokensToEpochRange(shardId, cur, cur, 1);

    // Legitimate forward distribution.
    await EpochStorage.addTokensToEpochRange(shardId, cur, cur + 10, 11000);
    const outOfRangeEpoch = cur + 8;
    const legit = await EpochStorage.getEpochPool(shardId, outOfRangeEpoch);
    expect(legit).to.be.greaterThan(0n);

    // A lazy/past-anchored settlement whose intended range ends at cur+5.
    await EpochStorage.addTokensToEpochRange(shardId, cur - 3, cur + 5, 4500);

    // Epoch cur+8 is outside [.., cur+5] → its legitimate pool is untouched.
    expect(await EpochStorage.getEpochPool(shardId, outOfRangeEpoch)).to.equal(legit);
  });
});
