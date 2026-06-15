import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  Hub,
  Token,
  Chronos,
  Profile,
  StakingV10,
  DKGStakingConvictionNFT,
  KnowledgeAssetsLifecycle,
  EpochStorage,
  ContextGraphs,
  ContextGraphStorage,
  DKGPublishingConvictionNFT,
  RandomSampling,
  ConvictionStakingStorage,
  ParametersStorage,
  ProfileStorage,
  AskStorage,
} from '../typechain';
import { sqrt } from './helpers/math-helpers';
import { createProfile } from './helpers/profile-helpers';
import {
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
  getDefaultKCCreator,
} from './helpers/setup-helpers';
import {
  buildPublishParams,
  packReservedKaId,
  DEFAULT_CHAIN_ID,
} from './helpers/v10-kc-helpers';

// OT-RFC-51 "Publishing Allocation" — first-pass happy-path coverage.
//
// Asserts the three behaviours the RFC introduced:
//   (a) `createAccount(committedTRAC, primaryNode)` prorate-seeds the
//       committed TRAC as per-epoch publishing allocation onto `primaryNode`;
//       the per-epoch allocations sum to `committedTRAC` across the lock.
//   (b) `setPrimaryNode(accountId, node2)` moves the FUTURE epochs' allocation
//       from the old node to the new one while every epoch's K_total
//       (`getEpochPublishingAllocation`) is byte-identical (net-zero move).
//   (c) a V10 publish no longer credits per-node publishing allocation (K_n)
//       — realized publishing is "off" as a feed for the scoring factor.
//
// The fixture mirrors `v10-e2e-conviction.test.ts` (the only V10-native
// conviction+publish integration test) so node registration + staking +
// publish all go through the existing turnkey helpers.
type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  StakingV10: StakingV10;
  StakingNFT: DKGStakingConvictionNFT;
  KnowledgeAssetsLifecycle: KnowledgeAssetsLifecycle;
  EpochStorage: EpochStorage;
  ContextGraphs: ContextGraphs;
  ContextGraphStorage: ContextGraphStorage;
  PublishingConvictionNFT: DKGPublishingConvictionNFT;
  RandomSampling: RandomSampling;
  ConvictionStakingStorage: ConvictionStakingStorage;
  ParametersStorage: ParametersStorage;
  ProfileStorage: ProfileStorage;
  AskStorage: AskStorage;
};

const SCALE18 = 10n ** 18n;

/**
 * JS mirror of `RandomSampling._calculateNodeScore`. Computes the expected
 * 18-decimal node score from the SAME on-chain inputs the contract reads, so
 * the test asserts the live scoring path rather than a hand-rolled constant:
 *
 *   nodeScore(t) = S(t) * (c + 0.86 * P(t) + 0.60 * A(t) * P(t))
 *
 * with the OT-RFC-51 single-current-epoch publishing-allocation window:
 *   S(t) = sqrt(min(effStake, stakeCap) / stakeCap)          (sublinear stake)
 *   P(t) = K_n / K_total   over the CURRENT EPOCH ONLY        (RFC-51 §4 / D1)
 *   A(t) = 1 - |ask - networkPrice| / networkPrice           (ask alignment)
 *   c    = 0.002 (STAKE_BASELINE_COEFFICIENT)
 *
 * All operations mirror the contract's integer order-of-operations exactly
 * (including OZ Math.sqrt's round-down via the Babylonian `sqrt` helper) so
 * the expected value is byte-identical to the on-chain result.
 */
async function expectedNodeScore(
  identityId: bigint,
  deps: {
    ConvictionStakingStorage: ConvictionStakingStorage;
    ParametersStorage: ParametersStorage;
    ProfileStorage: ProfileStorage;
    AskStorage: AskStorage;
    EpochStorage: EpochStorage;
    Chronos: Chronos;
  },
): Promise<{ score: bigint; stakeFactor: bigint; inner: bigint; p: bigint }> {
  const currentEpoch = await deps.Chronos.getCurrentEpoch();

  // 1. Stake factor S(t) = sqrt(min(effStake, stakeCap) / stakeCap)
  const effStake = await deps.ConvictionStakingStorage.getNodeEffectiveStake(
    identityId,
  );
  const stakeCap = BigInt(await deps.ParametersStorage.maximumStake());
  const capped = effStake > stakeCap ? stakeCap : effStake;
  const stakeRatio18 = (capped * SCALE18) / stakeCap;
  const stakeFactor18 = sqrt(stakeRatio18 * SCALE18);

  // 2. Publishing factor P(t) = K_n / K_total over the current epoch only.
  const nodeKV = BigInt(
    await deps.EpochStorage.getNodeEpochPublishingAllocation(
      identityId,
      currentEpoch,
    ),
  );
  const totalKV = BigInt(
    await deps.EpochStorage.getEpochPublishingAllocation(currentEpoch),
  );
  const publishingFactor18 = totalKV > 0n ? (nodeKV * SCALE18) / totalKV : 0n;

  // 3. Ask alignment factor A(t).
  const nodeAsk = BigInt(await deps.ProfileStorage.getAsk(identityId));
  const networkPrice = BigInt(await deps.AskStorage.getPricePerKbEpoch());
  let askAlignmentFactor18 = 0n;
  if (networkPrice > 0n) {
    const deviation =
      nodeAsk > networkPrice ? nodeAsk - networkPrice : networkPrice - nodeAsk;
    const deviationRatio18 = (deviation * SCALE18) / networkPrice;
    askAlignmentFactor18 =
      deviationRatio18 >= SCALE18 ? 0n : SCALE18 - deviationRatio18;
  }

  const baselineComponent18 = (2n * SCALE18) / 1000n;
  const publishingComponent18 = (86n * publishingFactor18) / 100n;
  const askPublishingComponent18 =
    (60n * askAlignmentFactor18 * publishingFactor18) / (100n * SCALE18);

  const inner18 =
    baselineComponent18 + publishingComponent18 + askPublishingComponent18;
  const score18 = (stakeFactor18 * inner18) / SCALE18;
  return {
    score: score18,
    stakeFactor: stakeFactor18,
    inner: inner18,
    p: publishingFactor18,
  };
}

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture([
    'Token',
    'AskStorage',
    'EpochStorage',
    'Chronos',
    'Profile',
    'Identity',
    'KnowledgeAssetsLifecycle',
    'ContextGraphStorage',
    'ContextGraphs',
    'ContextGraphValueStorage',
    'DKGPublishingConvictionNFT',
    'DKGStakingConvictionNFT',
    'StakingV10',
    // RandomSampling transitively pulls in RandomSamplingStorage,
    // ProfileStorage, AskStorage, ParametersStorage and
    // ConvictionStakingStorage — everything `calculateNodeScore` reads.
    'RandomSampling',
  ]);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>(
      'DKGStakingConvictionNFT',
    ),
    KnowledgeAssetsLifecycle: await hre.ethers.getContract<KnowledgeAssetsLifecycle>(
      'KnowledgeAssetsLifecycle',
    ),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    ContextGraphs: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    ContextGraphStorage: await hre.ethers.getContract<ContextGraphStorage>(
      'ContextGraphStorage',
    ),
    PublishingConvictionNFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>(
      'DKGPublishingConvictionNFT',
    ),
    RandomSampling: await hre.ethers.getContract<RandomSampling>('RandomSampling'),
    ConvictionStakingStorage: await hre.ethers.getContract<ConvictionStakingStorage>(
      'ConvictionStakingStorage',
    ),
    ParametersStorage: await hre.ethers.getContract<ParametersStorage>(
      'ParametersStorage',
    ),
    ProfileStorage: await hre.ethers.getContract<ProfileStorage>('ProfileStorage'),
    AskStorage: await hre.ethers.getContract<AskStorage>('AskStorage'),
  };
}

describe('@integration OT-RFC-51 Publishing Allocation', function () {
  // The fixture deploys the full V10 stack (Profile/Identity/CG/conviction/
  // staking) and the test runs a complete publish flow; under load this far
  // exceeds Mocha's 40s default. `hardhat.node.config.ts` (used by the repo's
  // run-tests.js) does not raise the timeout, so set it per-suite here.
  this.timeout(600000);

  const COMMITTED_TRAC = ethers.parseEther('50000'); // 20% discount tier
  const MIN_STAKE = ethers.parseEther('50000');

  let accounts: SignerWithAddress[];
  let Token: Token;
  let Chronos: Chronos;
  let ProfileContract: Profile;
  let StakingV10Contract: StakingV10;
  let StakingNFT: DKGStakingConvictionNFT;
  let KAV10: KnowledgeAssetsLifecycle;
  let NFT: DKGPublishingConvictionNFT;
  let CGFacade: ContextGraphs;
  let CGS: ContextGraphStorage;
  let EpochStorageContract: EpochStorage;
  let RandomSamplingContract: RandomSampling;
  let CSS: ConvictionStakingStorage;
  let ParametersStorageContract: ParametersStorage;
  let ProfileStorageContract: ProfileStorage;
  let AskStorageContract: AskStorage;
  let kav10Address: string;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const f = await loadFixture(deployFixture);
    accounts = f.accounts;
    Token = f.Token;
    Chronos = f.Chronos;
    ProfileContract = f.Profile;
    StakingV10Contract = f.StakingV10;
    StakingNFT = f.StakingNFT;
    KAV10 = f.KnowledgeAssetsLifecycle;
    NFT = f.PublishingConvictionNFT;
    CGFacade = f.ContextGraphs;
    CGS = f.ContextGraphStorage;
    EpochStorageContract = f.EpochStorage;
    RandomSamplingContract = f.RandomSampling;
    CSS = f.ConvictionStakingStorage;
    ParametersStorageContract = f.ParametersStorage;
    ProfileStorageContract = f.ProfileStorage;
    AskStorageContract = f.AskStorage;
    kav10Address = await KAV10.getAddress();
  });

  const stakeV10 = async (
    staker: SignerWithAddress,
    identityId: number,
    amount: bigint,
  ) => {
    await Token.mint(staker.address, amount);
    await Token.connect(staker).approve(
      await StakingV10Contract.getAddress(),
      amount,
    );
    await StakingNFT.connect(staker).createConviction(identityId, amount, 1);
  };

  it('(a) seeds per-epoch publishing allocation summing to committedTRAC; (b) setPrimaryNode moves future epochs net-zero on K_total; (c) realized publish does not credit K_n', async () => {
    // ---- Node setup: real, staked nodes in the sharding table ----
    // node1 = publishingNode; node2 = a separate dedicated node (accounts[7]/[8])
    // so it never overlaps the publish ACK-quorum receiving set.
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const node2Accounts = { admin: accounts[7], operational: accounts[8] };

    const { identityId: node1Id } = await createProfile(ProfileContract, publishingNode);
    const receiverProfiles = [];
    for (let i = 0; i < receivingNodes.length; i++) {
      receiverProfiles.push(await createProfile(ProfileContract, receivingNodes[i]));
    }
    const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);
    const { identityId: node2Id } = await createProfile(ProfileContract, node2Accounts);

    await stakeV10(publishingNode.operational, node1Id, MIN_STAKE);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeV10(receivingNodes[i].operational, receiverProfiles[i].identityId, MIN_STAKE);
    }
    await stakeV10(node2Accounts.operational, node2Id, MIN_STAKE);

    // ========================================================================
    // (a) createAccount with a real primary node seeds publishing allocation
    // ========================================================================
    const creator = getDefaultKCCreator(accounts);
    await Token.connect(accounts[0]).transfer(creator.address, COMMITTED_TRAC);
    await Token.connect(creator).approve(await NFT.getAddress(), COMMITTED_TRAC);

    await NFT.connect(creator).createAccount(COMMITTED_TRAC, node1Id);
    const accountId = await NFT.totalSupply();
    expect(accountId).to.equal(1n);

    const acct = await NFT.accounts(accountId);
    const createdAtEpoch = acct[1]; // index 1 = createdAtEpoch
    const lockDurationEpochs = BigInt(acct[5]); // index 5
    // RFC-51 fields appended to the Account tuple.
    expect(acct[9]).to.equal(BigInt(node1Id)); // primaryNode
    expect(acct[10]).to.equal(createdAtEpoch); // lastPrimaryNodeChangeEpoch

    // The schedule credits epochs [createdAtEpoch, createdAtEpoch + N].
    const firstEpoch = createdAtEpoch;
    const lastEpoch = createdAtEpoch + lockDurationEpochs;

    let seededSum = 0n;
    const node1Before: bigint[] = [];
    const totalBefore: bigint[] = [];
    for (let e = firstEpoch; e <= lastEpoch; e++) {
      const nodeKV = await EpochStorageContract.getNodeEpochPublishingAllocation(node1Id, e);
      const totalKV = await EpochStorageContract.getEpochPublishingAllocation(e);
      node1Before.push(nodeKV);
      totalBefore.push(totalKV);
      seededSum += nodeKV;
      // node1 is the only contributor, so K_total == node1's allocation.
      expect(totalKV).to.equal(nodeKV);
    }
    // The seeded total over the lock equals committedTRAC exactly.
    expect(seededSum).to.equal(COMMITTED_TRAC);

    // node2 has no allocation yet.
    for (let e = firstEpoch; e <= lastEpoch; e++) {
      expect(await EpochStorageContract.getNodeEpochPublishingAllocation(node2Id, e)).to.equal(0n);
    }

    // ========================================================================
    // (b) setPrimaryNode moves FUTURE epochs net-zero on K_total
    // ========================================================================
    // Advance ~one full chain epoch so the once-per-epoch rate limit passes
    // (lastPrimaryNodeChangeEpoch was set to createdAtEpoch at creation).
    const epochLength = await Chronos.epochLength();
    await time.increase(epochLength);

    const currentEpoch = await Chronos.getCurrentEpoch();
    expect(currentEpoch).to.be.gt(createdAtEpoch); // rate limit will pass

    await NFT.connect(creator).setPrimaryNode(accountId, node2Id);

    const acctAfter = await NFT.accounts(accountId);
    expect(acctAfter[9]).to.equal(BigInt(node2Id)); // primaryNode updated
    expect(acctAfter[10]).to.equal(currentEpoch); // change epoch cursor updated

    // Only future epochs (e >= currentEpoch + 1) move to node2; current/past
    // epochs stay credited to node1. K_total is unchanged for EVERY epoch.
    for (let i = 0; i < node1Before.length; i++) {
      const e = firstEpoch + BigInt(i);
      const node1Now = await EpochStorageContract.getNodeEpochPublishingAllocation(node1Id, e);
      const node2Now = await EpochStorageContract.getNodeEpochPublishingAllocation(node2Id, e);
      const totalNow = await EpochStorageContract.getEpochPublishingAllocation(e);

      // K_total (denominator) is net-zero across the move.
      expect(totalNow).to.equal(totalBefore[i]);

      if (e >= currentEpoch + 1n) {
        // Moved: node1 -> node2, byte-for-byte.
        expect(node1Now).to.equal(0n);
        expect(node2Now).to.equal(node1Before[i]);
      } else {
        // Stayed on node1 (current + past epochs untouched).
        expect(node1Now).to.equal(node1Before[i]);
        expect(node2Now).to.equal(0n);
      }
    }
    // At least one epoch must have actually moved, else the test is vacuous.
    const someFutureEpoch = currentEpoch + 1n;
    expect(someFutureEpoch).to.be.lte(lastEpoch);

    // ========================================================================
    // (c) realized publish does NOT credit K_n (allocation feed is off)
    // ========================================================================
    // Register the creator as its own publishing agent and create an open CG.
    await NFT.connect(creator).registerAgent(accountId, creator.address);
    expect(await NFT.agentToAccountId(creator.address)).to.equal(accountId);

    await CGFacade.connect(creator).createContextGraph(
      [],
      0,
      0,
      1, // open publish policy
      ethers.ZeroAddress,
      0,
      ethers.ZeroHash,
    );
    const cgId = await CGS.getLatestContextGraphId();

    // PCA discount branch requires publishEpochs == lockDurationEpochs.
    const epochsForPublish = Number(lockDurationEpochs);
    const tokenAmount = ethers.parseEther('1000');
    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('rfc51-merkle'));
    const reservedKaId = packReservedKaId(creator.address, 1);

    // Snapshot per-node allocation for BOTH nodes across all credited epochs
    // just before the publish — realized publishing must not move any of them.
    const pubEpoch = await Chronos.getCurrentEpoch();
    const n1PrePublish: Record<string, bigint> = {};
    const n2PrePublish: Record<string, bigint> = {};
    for (let e = firstEpoch; e <= lastEpoch + 2n; e++) {
      n1PrePublish[e.toString()] = await EpochStorageContract.getNodeEpochPublishingAllocation(node1Id, e);
      n2PrePublish[e.toString()] = await EpochStorageContract.getNodeEpochPublishingAllocation(node2Id, e);
    }

    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address,
      receivingNodes,
      publisherIdentityId: node1Id,
      receiverIdentityIds,
      author: creator,
      contextGraphId: cgId,
      merkleRoot,
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs: epochsForPublish,
      tokenAmount,
      isImmutable: false,
      publishOperationId: 'rfc51-op',
      reservedKaId,
    });

    const tx = await KAV10.connect(creator).publish(p);
    const receipt = await tx.wait();
    expect(receipt!.status).to.equal(1);

    // The publish names node1 as publisherNodeIdentityId, but RFC-51 removed
    // the realized-publishing K_n credit. Every per-node allocation is
    // unchanged from the pre-publish snapshot for both nodes.
    for (let e = firstEpoch; e <= lastEpoch + 2n; e++) {
      expect(
        await EpochStorageContract.getNodeEpochPublishingAllocation(node1Id, e),
        `node1 allocation at epoch ${e} must be unchanged by publish`,
      ).to.equal(n1PrePublish[e.toString()]);
      expect(
        await EpochStorageContract.getNodeEpochPublishingAllocation(node2Id, e),
        `node2 allocation at epoch ${e} must be unchanged by publish`,
      ).to.equal(n2PrePublish[e.toString()]);
    }
    // Specifically, the publish epoch's node1 allocation gained nothing.
    expect(
      await EpochStorageContract.getNodeEpochPublishingAllocation(node1Id, pubEpoch),
    ).to.equal(n1PrePublish[pubEpoch.toString()]);
  });

  // ==========================================================================
  // (d) NODE SCORE: publishing allocation drives RandomSampling node score
  // ==========================================================================
  // This is the one RFC-51 behaviour with no other RUNNING test. The V8-flow
  // `test/integration/RandomSampling.test.ts` suite is `describe.skip`-ped
  // (tombstone: V8 staking pipeline incompatible with V10 CSS scoring), so the
  // allocation -> P(t) -> score path is exercised here against live contracts.
  //
  // Setup primitive shared by the score cases: three V10 nodes with EQUAL
  // effective stake (same MIN_STAKE, same lock tier 1) so S(t) is identical and
  // factors out of every ratio. Returns their identityIds.
  const setupThreeEqualStakeNodes = async () => {
    const nodeA = { admin: accounts[1], operational: accounts[2] };
    const nodeB = { admin: accounts[3], operational: accounts[4] };
    const nodeC = { admin: accounts[5], operational: accounts[6] };

    const { identityId: aId } = await createProfile(ProfileContract, nodeA);
    const { identityId: bId } = await createProfile(ProfileContract, nodeB);
    const { identityId: cId } = await createProfile(ProfileContract, nodeC);

    await stakeV10(nodeA.operational, aId, MIN_STAKE);
    await stakeV10(nodeB.operational, bId, MIN_STAKE);
    await stakeV10(nodeC.operational, cId, MIN_STAKE);

    // Equal stake + equal tier => equal effective stake (read at the same
    // block.timestamp via the contract's simulated settle). Assert it, since a
    // zero effective stake here would make every downstream score 0 and the
    // task's blocker condition would apply.
    const effA = await CSS.getNodeEffectiveStake(aId);
    const effB = await CSS.getNodeEffectiveStake(bId);
    const effC = await CSS.getNodeEffectiveStake(cId);
    expect(effA).to.be.gt(0n);
    expect(effA).to.equal(effB);
    expect(effB).to.equal(effC);

    return { aId: BigInt(aId), bId: BigInt(bId), cId: BigInt(cId) };
  };

  const scoreDeps = () => ({
    ConvictionStakingStorage: CSS,
    ParametersStorage: ParametersStorageContract,
    ProfileStorage: ProfileStorageContract,
    AskStorage: AskStorageContract,
    EpochStorage: EpochStorageContract,
    Chronos,
  });

  it('(d.1) allocation drives calculateNodeScore: equal stake, 3:1 seeded allocation => scoreA > scoreB and each matches the (c + 0.86*P) formula', async () => {
    const { aId, bId } = await setupThreeEqualStakeNodes();

    // Seed a 3:1 publishing allocation into the CURRENT epoch directly (the
    // onlyContracts gate accepts hub.owner() = accounts[0]). The current epoch
    // must be read AFTER staking — staking advances block.timestamp but not the
    // epoch boundary.
    const epoch = await Chronos.getCurrentEpoch();
    const K_A = ethers.parseEther('30000');
    const K_B = ethers.parseEther('10000');
    await EpochStorageContract.connect(accounts[0]).addEpochPublishingAllocation(
      aId,
      epoch,
      K_A,
    );
    await EpochStorageContract.connect(accounts[0]).addEpochPublishingAllocation(
      bId,
      epoch,
      K_B,
    );

    // Control the denominator: with a fresh fixture and only these two seeds,
    // K_total for the epoch is exactly K_A + K_B.
    const kTotal = BigInt(
      await EpochStorageContract.getEpochPublishingAllocation(epoch),
    );
    expect(kTotal).to.equal(K_A + K_B);
    expect(
      BigInt(
        await EpochStorageContract.getNodeEpochPublishingAllocation(aId, epoch),
      ),
    ).to.equal(K_A);
    expect(
      BigInt(
        await EpochStorageContract.getNodeEpochPublishingAllocation(bId, epoch),
      ),
    ).to.equal(K_B);

    // Live on-chain scores.
    const scoreA = await RandomSamplingContract.calculateNodeScore(aId);
    const scoreB = await RandomSamplingContract.calculateNodeScore(bId);

    // Allocation must make nodeA's score strictly greater than nodeB's.
    expect(scoreA).to.be.gt(scoreB);
    expect(scoreA).to.be.gt(0n);
    expect(scoreB).to.be.gt(0n);

    // Each live score must equal the value derived from the SAME inputs the
    // contract reads (mirrors `_calculateNodeScore` exactly => byte-identical).
    const expA = await expectedNodeScore(aId, scoreDeps());
    const expB = await expectedNodeScore(bId, scoreDeps());
    expect(scoreA).to.equal(expA.score);
    expect(scoreB).to.equal(expB.score);

    // P(t) ratio: nodeA holds 3/4 of K_total, nodeB holds 1/4.
    expect(expA.p).to.equal((3n * SCALE18) / 4n); // 0.75e18
    expect(expB.p).to.equal((1n * SCALE18) / 4n); // 0.25e18

    // Inner term = c + 0.86 * P(t) (A(t)=0 here: ask=0 => deviation >= 1 or
    // networkPrice=0). Equal stake => stakeFactor identical => the score ratio
    // equals the inner ratio. The baseline c shifts the ratio strictly BELOW
    // the raw 3:1 P ratio (~2.98:1), proving c participates, not just P.
    expect(expA.stakeFactor).to.equal(expB.stakeFactor);
    const baseline18 = (2n * SCALE18) / 1000n; // c = 0.002e18
    expect(expA.inner).to.equal(baseline18 + (86n * expA.p) / 100n);
    expect(expB.inner).to.equal(baseline18 + (86n * expB.p) / 100n);

    // Score ratio (scaled by SCALE18) tracks the inner ratio (equal stake
    // factors out) and sits strictly below the raw 3:1 — i.e. the baseline c in
    // (c + 0.86*P) genuinely shapes it. The score ratio is computed from two
    // separately floored on-chain scores, so it matches the inner ratio only up
    // to a few wei of fixed-point rounding (assert ~equal within a tight bound,
    // not byte-exact — the per-node `score == expected` checks above are the
    // byte-exact ones).
    const scoreRatio18 = (scoreA * SCALE18) / scoreB;
    const innerRatio18 = (expA.inner * SCALE18) / expB.inner;
    const ratioDelta =
      scoreRatio18 > innerRatio18
        ? scoreRatio18 - innerRatio18
        : innerRatio18 - scoreRatio18;
    expect(ratioDelta).to.be.lt(1000n); // < 1e-15 of the ratio
    expect(scoreRatio18).to.be.lt(3n * SCALE18); // strictly under 3:1
    expect(scoreRatio18).to.be.gt((29n * SCALE18) / 10n); // ~2.98 > 2.9
  });

  it('(d.2) a staked node with ZERO allocation has P(t)=0 => inner score ~= baseline c only, far below an allocated peer', async () => {
    const { aId, cId } = await setupThreeEqualStakeNodes();

    // Seed allocation ONLY to nodeA. nodeC gets nothing => P_C = 0. Crucially
    // K_total > 0 (from nodeA), so this is the real divisor case, not the
    // degenerate `totalKV == 0` short-circuit.
    const epoch = await Chronos.getCurrentEpoch();
    const K_A = ethers.parseEther('40000');
    await EpochStorageContract.connect(accounts[0]).addEpochPublishingAllocation(
      aId,
      epoch,
      K_A,
    );
    expect(
      BigInt(await EpochStorageContract.getEpochPublishingAllocation(epoch)),
    ).to.equal(K_A);
    expect(
      BigInt(
        await EpochStorageContract.getNodeEpochPublishingAllocation(cId, epoch),
      ),
    ).to.equal(0n);

    const scoreA = await RandomSamplingContract.calculateNodeScore(aId);
    const scoreC = await RandomSamplingContract.calculateNodeScore(cId);

    const expA = await expectedNodeScore(aId, scoreDeps());
    const expC = await expectedNodeScore(cId, scoreDeps());

    // Live scores match the formula.
    expect(scoreA).to.equal(expA.score);
    expect(scoreC).to.equal(expC.score);

    // nodeC's P(t) is exactly 0; its inner term is the bare baseline c=0.002e18.
    const baseline18 = (2n * SCALE18) / 1000n;
    expect(expC.p).to.equal(0n);
    expect(expC.inner).to.equal(baseline18);

    // nodeA (P=1, sole allocator) inner = c + 0.86 => ~431x the zero-alloc node.
    expect(expA.p).to.equal(SCALE18);
    expect(expA.inner).to.equal(baseline18 + (86n * SCALE18) / 100n);
    expect(scoreA).to.be.gt(scoreC);
    // Concretely "much smaller": zero-alloc score is < 1% of the allocated one.
    expect(scoreC * 100n).to.be.lt(scoreA);
  });

  it('(d.3) setPrimaryNode shifts the FUTURE-epoch score: after moving allocation A->B and advancing one epoch, calculateNodeScore favors nodeB', async () => {
    // Use the real PCA path (createAccount -> setPrimaryNode) so the on-chain
    // move mutator is what drives the score change, not a direct seed.
    const { aId, bId } = await setupThreeEqualStakeNodes();

    const creator = getDefaultKCCreator(accounts);
    await Token.connect(accounts[0]).transfer(creator.address, COMMITTED_TRAC);
    await Token.connect(creator).approve(await NFT.getAddress(), COMMITTED_TRAC);

    // Seed all future epochs' allocation onto nodeA via a real PCA.
    await NFT.connect(creator).createAccount(COMMITTED_TRAC, Number(aId));
    const accountId = await NFT.totalSupply();
    const acct = await NFT.accounts(accountId);
    const createdAtEpoch = acct[1];
    const lockDurationEpochs = BigInt(acct[5]);
    const lastEpoch = createdAtEpoch + lockDurationEpochs;

    // Before the move: at the current epoch nodeA is the sole allocator, so it
    // outscores nodeB (which has equal stake but zero allocation).
    {
      const epochNow = await Chronos.getCurrentEpoch();
      expect(
        BigInt(
          await EpochStorageContract.getNodeEpochPublishingAllocation(
            aId,
            epochNow,
          ),
        ),
      ).to.be.gt(0n);
      const sA = await RandomSamplingContract.calculateNodeScore(aId);
      const sB = await RandomSamplingContract.calculateNodeScore(bId);
      expect(sA).to.be.gt(sB);
    }

    // Advance one full chain epoch so the once-per-epoch rate limit clears and
    // we land on a FUTURE epoch (>= changeEpoch + 1) that the move retargets.
    const epochLength = await Chronos.epochLength();
    await time.increase(epochLength);
    const moveEpoch = await Chronos.getCurrentEpoch();
    expect(moveEpoch).to.be.gt(createdAtEpoch);

    // Move FUTURE epochs' allocation from nodeA to nodeB.
    await NFT.connect(creator).setPrimaryNode(accountId, Number(bId));
    expect((await NFT.accounts(accountId))[9]).to.equal(bId); // primaryNode = B

    // The move retargets epochs >= moveEpoch + 1. Advance into one of those so
    // the CURRENT-epoch score read (which is all calculateNodeScore inspects)
    // sees nodeB holding the allocation. Guard the fixture has room to advance.
    expect(moveEpoch + 1n).to.be.lte(lastEpoch);
    await time.increase(epochLength);
    const futureEpoch = await Chronos.getCurrentEpoch();
    expect(futureEpoch).to.be.gte(moveEpoch + 1n);

    // In this future epoch the allocation now sits on nodeB, not nodeA.
    expect(
      BigInt(
        await EpochStorageContract.getNodeEpochPublishingAllocation(
          aId,
          futureEpoch,
        ),
      ),
    ).to.equal(0n);
    expect(
      BigInt(
        await EpochStorageContract.getNodeEpochPublishingAllocation(
          bId,
          futureEpoch,
        ),
      ),
    ).to.be.gt(0n);

    // Effective stake is still equal across one epoch (boost has not expired),
    // so the score flip is purely from the allocation move, not from S(t).
    const effA = await CSS.getNodeEffectiveStake(aId);
    const effB = await CSS.getNodeEffectiveStake(bId);
    expect(effA).to.be.gt(0n);
    expect(effA).to.equal(effB);

    // The score now favors nodeB: the move shifted the live score, not just the
    // stored accumulator.
    const scoreA = await RandomSamplingContract.calculateNodeScore(aId);
    const scoreB = await RandomSamplingContract.calculateNodeScore(bId);
    expect(scoreB).to.be.gt(scoreA);

    // And both match the formula on these post-move inputs.
    const expA = await expectedNodeScore(aId, scoreDeps());
    const expB = await expectedNodeScore(bId, scoreDeps());
    expect(scoreA).to.equal(expA.score);
    expect(scoreB).to.equal(expB.score);
    // nodeA is now the zero-allocation node => inner = baseline c only.
    const baseline18 = (2n * SCALE18) / 1000n;
    expect(expA.inner).to.equal(baseline18);
    expect(expB.p).to.be.gt(0n);
  });
});
