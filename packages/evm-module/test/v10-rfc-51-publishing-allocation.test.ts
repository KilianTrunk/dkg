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
} from '../typechain';
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
};

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
});
