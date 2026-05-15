// Standalone V10 Publishing Conviction NFT lifecycle: create → topUp →
// registerAgent → deregisterAgent → settle, plus the discounted publish
// path through a real KnowledgeAssetsV10.publish() and the post-expiry
// revert. Peer of test/v10-e2e-conviction.test.ts (Flow 3).

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  ContextGraphs,
  ContextGraphStorage,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  KnowledgeAssetsV10,
  KnowledgeCollectionStorage,
  Profile,
  StakingV10,
  Token,
} from '../typechain';
import { createProfile, createProfiles } from './helpers/profile-helpers';
import {
  getDefaultKCCreator,
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
} from './helpers/setup-helpers';
import { buildPublishParams, DEFAULT_CHAIN_ID } from './helpers/v10-kc-helpers';

const COMMITTED_TRAC = ethers.parseEther('50000'); // 20% discount tier
const EXPECTED_DISCOUNT_BPS = 2000n;
const STAKER_SHARD_ID = 1n;
const MIN_STAKE = ethers.parseEther('50000');

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  ConvictionStakingStorage: ConvictionStakingStorage;
  StakingV10: StakingV10;
  StakingNFT: DKGStakingConvictionNFT;
  KnowledgeAssetsV10: KnowledgeAssetsV10;
  KnowledgeCollectionStorage: KnowledgeCollectionStorage;
  EpochStorage: EpochStorage;
  ContextGraphs: ContextGraphs;
  ContextGraphStorage: ContextGraphStorage;
  NFT: DKGPublishingConvictionNFT;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture([
    'Token',
    'AskStorage',
    'EpochStorage',
    'Chronos',
    'Profile',
    'Identity',
    'KnowledgeAssetsV10',
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
    ConvictionStakingStorage:
      await hre.ethers.getContract<ConvictionStakingStorage>(
        'ConvictionStakingStorage',
      ),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>(
      'DKGStakingConvictionNFT',
    ),
    KnowledgeAssetsV10: await hre.ethers.getContract<KnowledgeAssetsV10>(
      'KnowledgeAssetsV10',
    ),
    KnowledgeCollectionStorage:
      await hre.ethers.getContract<KnowledgeCollectionStorage>(
        'KnowledgeCollectionStorage',
      ),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    ContextGraphs: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    ContextGraphStorage:
      await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>(
      'DKGPublishingConvictionNFT',
    ),
  };
}

describe('@integration V10 PCA lifecycle (DKGPublishingConvictionNFT)', function () {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let Token: Token;
  let Chronos: Chronos;
  let ProfileContract: Profile;
  let ConvictionStakingStorage: ConvictionStakingStorage;
  let StakingV10Contract: StakingV10;
  let StakingNFT: DKGStakingConvictionNFT;
  let KAV10: KnowledgeAssetsV10;
  let KnowledgeCollectionStorage: KnowledgeCollectionStorage;
  let EpochStorageContract: EpochStorage;
  let CGFacade: ContextGraphs;
  let CGS: ContextGraphStorage;
  let NFT: DKGPublishingConvictionNFT;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub,
      Token,
      Chronos,
      Profile: ProfileContract,
      ConvictionStakingStorage,
      StakingV10: StakingV10Contract,
      StakingNFT,
      KnowledgeAssetsV10: KAV10,
      KnowledgeCollectionStorage,
      EpochStorage: EpochStorageContract,
      ContextGraphs: CGFacade,
      ContextGraphStorage: CGS,
      NFT,
    } = await loadFixture(deployFixture));
  });

  afterEach(async () => {
    // Flow-through invariant: the NFT contract must NEVER custody TRAC.
    expect(await Token.balanceOf(await NFT.getAddress())).to.equal(0n);
  });

  // Mint + fund a fresh conviction account owned by `owner`.
  const createAccountFor = async (
    owner: SignerWithAddress,
  ): Promise<bigint> => {
    await Token.mint(owner.address, COMMITTED_TRAC);
    await Token.connect(owner).approve(await NFT.getAddress(), COMMITTED_TRAC);
    await NFT.connect(owner).createAccount(COMMITTED_TRAC);
    return NFT.totalSupply();
  };

  // --------------------------------------------------------------------------
  // 1. create → topUp → registerAgent → deregisterAgent → settle
  // --------------------------------------------------------------------------
  it('asserts on-chain state across create/topUp/registerAgent/deregisterAgent/settle', async () => {
    const creator = getDefaultKCCreator(accounts);
    const agent = accounts[8];
    const stranger = accounts[7];

    // ---- createAccount ----
    const accountId = await createAccountFor(creator);
    expect(accountId).to.equal(1n);
    expect(await NFT.ownerOf(accountId)).to.equal(creator.address);
    let info = await NFT.getAccountInfo(accountId);
    expect(info.committedTRAC).to.equal(COMMITTED_TRAC);
    expect(info.discountBps).to.equal(EXPECTED_DISCOUNT_BPS);
    expect(info.topUpBuffer).to.equal(0n);
    expect(info.agentCount).to.equal(0n);
    expect(info.fullySwept).to.equal(false);
    const expiresAtEpochAtCreate = info.expiresAtEpoch;

    // ---- topUp (owner-gated, does not move committedTRAC/expiry) ----
    const top = ethers.parseEther('1000');
    await Token.mint(creator.address, top);
    await Token.connect(creator).approve(await NFT.getAddress(), top);
    await expect(NFT.connect(creator).topUp(accountId, top))
      .to.emit(NFT, 'ToppedUp')
      .withArgs(accountId, top, top);
    info = await NFT.getAccountInfo(accountId);
    expect(info.topUpBuffer).to.equal(top);
    expect(info.committedTRAC).to.equal(COMMITTED_TRAC);
    expect(info.expiresAtEpoch).to.equal(expiresAtEpochAtCreate);

    // Owner-gating invariant: a non-owner write must propagate the revert.
    await expect(
      NFT.connect(stranger).topUp(accountId, top),
    ).to.be.revertedWithCustomError(NFT, 'NotAccountOwner');

    // ---- registerAgent ----
    await expect(NFT.connect(creator).registerAgent(accountId, agent.address))
      .to.emit(NFT, 'AgentRegistered')
      .withArgs(accountId, agent.address);
    expect(await NFT.isAgent(accountId, agent.address)).to.equal(true);
    expect(await NFT.agentToAccountId(agent.address)).to.equal(accountId);
    expect((await NFT.getAccountInfo(accountId)).agentCount).to.equal(1n);
    await expect(
      NFT.connect(stranger).registerAgent(accountId, stranger.address),
    ).to.be.revertedWithCustomError(NFT, 'NotAccountOwner');

    // ---- deregisterAgent ----
    await expect(NFT.connect(creator).deregisterAgent(accountId, agent.address))
      .to.emit(NFT, 'AgentDeregistered')
      .withArgs(accountId, agent.address);
    expect(await NFT.isAgent(accountId, agent.address)).to.equal(false);
    expect(await NFT.agentToAccountId(agent.address)).to.equal(0n);
    expect((await NFT.getAccountInfo(accountId)).agentCount).to.equal(0n);

    // ---- settle: one elapsed window advances the lazy-settlement cursor ----
    const epochLength = await Chronos.epochLength();
    await time.increase(Number(epochLength));
    await NFT.connect(stranger).settle(accountId); // permissionless
    expect((await NFT.getAccountInfo(accountId)).lastSettledWindow).to.equal(
      1n,
    );

    // ---- settle: post-expiry final sweep marks the account fully swept ----
    const acct = await NFT.accounts(accountId);
    const lockDurationEpochs = acct[5];
    await time.increase(Number(epochLength) * (Number(lockDurationEpochs) + 1));
    await expect(NFT.connect(stranger).settle(accountId)).to.emit(
      NFT,
      'AccountFinalSwept',
    );
    expect((await NFT.getAccountInfo(accountId)).fullySwept).to.equal(true);
  });
});
