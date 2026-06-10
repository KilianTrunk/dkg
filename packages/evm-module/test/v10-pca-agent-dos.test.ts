// =============================================================================
// V10 PCA — consent-free agent-registration DoS regression (audit fix)
// =============================================================================
//
// Agent registration on a publishing-conviction account (PCA) is
// permissionless and requires NO consent from the agent (RFC-001 §3.6). The
// publish/update entrypoints auto-route a registered agent into the discount
// branch based only on (registered, not-expired, epoch-match) — NOT on whether
// the account can actually fund the cost.
//
// Pre-fix, an attacker could:
//   1. createAccount(1 wei)            -> active PCA, baseAllowance = 1/12 = 0
//   2. registerAgent(accountId, victim) (no consent needed)
// and any victim publish with `epochs == lockDurationEpochs` (or any paid
// victim update) would route into `coverPublishingCost`, hit
// `InsufficientAllowance`, and REVERT — bricking the victim's paid publishes
// and updates indefinitely. The victim cannot self-deregister and cannot
// register their own address (the global reverse map is taken).
//
// The fix makes the conviction branch FALL THROUGH to direct spend on the
// PCA-side payment errors (`InsufficientAllowance` / `AccountExpired`) instead
// of reverting — so a consent-free registration can never block a publisher;
// it just loses the (non-existent) discount and the victim pays full price.
//
// This suite proves: with the attacker's underfunded registration in place and
// the conviction gate ACTIVE (epochs == lockDurationEpochs), the victim's
// publish still succeeds via direct spend (victim's own TRAC moves, KC minted).

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ContextGraphs,
  ContextGraphStorage,
  DKGKnowledgeAssets,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  KnowledgeAssetsLifecycle,
  Profile,
  StakingV10,
  Token,
} from '../typechain';
import { createProfile, createProfiles } from './helpers/profile-helpers';
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

const MIN_STAKE = ethers.parseEther('50000');
const STAKER_SHARD_ID = 1n;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  StakingV10: StakingV10;
  StakingNFT: DKGStakingConvictionNFT;
  KnowledgeAssetsLifecycle: KnowledgeAssetsLifecycle;
  DKGKnowledgeAssets: DKGKnowledgeAssets;
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
    KnowledgeAssetsLifecycle:
      await hre.ethers.getContract<KnowledgeAssetsLifecycle>(
        'KnowledgeAssetsLifecycle',
      ),
    DKGKnowledgeAssets: await hre.ethers.getContract<DKGKnowledgeAssets>(
      'DKGKnowledgeAssets',
    ),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    ContextGraphs: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    ContextGraphStorage: await hre.ethers.getContract<ContextGraphStorage>(
      'ContextGraphStorage',
    ),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>(
      'DKGPublishingConvictionNFT',
    ),
  };
}

describe('@integration V10 PCA — consent-free agent DoS (audit fix)', function () {
  let accounts: SignerWithAddress[];
  let Token: Token;
  let Chronos: Chronos;
  let ProfileContract: Profile;
  let StakingV10Contract: StakingV10;
  let StakingNFT: DKGStakingConvictionNFT;
  let KAV10: KnowledgeAssetsLifecycle;
  let DKGKnowledgeAssets: DKGKnowledgeAssets;
  let EpochStorageContract: EpochStorage;
  let CGFacade: ContextGraphs;
  let CGS: ContextGraphStorage;
  let NFT: DKGPublishingConvictionNFT;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Token,
      Chronos,
      Profile: ProfileContract,
      StakingV10: StakingV10Contract,
      StakingNFT,
      KnowledgeAssetsLifecycle: KAV10,
      DKGKnowledgeAssets,
      EpochStorage: EpochStorageContract,
      ContextGraphs: CGFacade,
      ContextGraphStorage: CGS,
      NFT,
    } = await loadFixture(deployFixture));
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

  const sumActiveSink = (
    logs: readonly { address: string; topics: readonly string[]; data: string }[],
    epochStorageAddr: string,
  ): bigint => {
    let sum = 0n;
    for (const log of logs) {
      if (log.address.toLowerCase() !== epochStorageAddr) continue;
      try {
        const parsed = EpochStorageContract.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'TokensAddedToEpochRange') {
          expect(BigInt(parsed.args.shardId)).to.equal(STAKER_SHARD_ID);
          sum += BigInt(parsed.args.tokenAmount);
        }
      } catch {
        // not our event
      }
    }
    return sum;
  };

  it('attacker-registered, underfunded PCA no longer bricks a victim publish (falls through to direct spend)', async () => {
    // ---- Nodes (V10-staked for the ACK signer gate) ----
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const { identityId: publisherIdentityId } = await createProfile(
      ProfileContract,
      publishingNode,
    );
    const receiverProfiles = await createProfiles(ProfileContract, receivingNodes);
    const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);

    await stakeV10(publishingNode.operational, publisherIdentityId, MIN_STAKE);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeV10(
        receivingNodes[i].operational,
        receiverProfiles[i].identityId,
        MIN_STAKE,
      );
    }

    // ---- Attack: 1-wei PCA, register the victim as a paying agent ----
    const attacker = accounts[8];
    const victim = getDefaultKCCreator(accounts); // accounts[9]

    await Token.mint(attacker.address, 1n);
    await Token.connect(attacker).approve(await NFT.getAddress(), 1n);
    await NFT.connect(attacker).createAccount(1n);
    const attackerAccountId = await NFT.totalSupply();

    await NFT.connect(attacker).registerAgent(attackerAccountId, victim.address);
    // The victim is now globally routed to the attacker's underfunded account.
    expect(await NFT.agentToAccountId(victim.address)).to.equal(
      attackerAccountId,
    );

    // The conviction branch is ACTIVE for this publish: the account is fresh
    // (not expired) and we publish with epochs == lockDurationEpochs. So the
    // publish MUST enter `coverPublishingCost` and rely on the fall-through.
    const lockDurationEpochs = Number((await NFT.accounts(attackerAccountId))[5]);

    // ---- Victim's own context graph (open publish policy) ----
    await CGFacade.connect(victim).createContextGraph(
      [],
      0,
      0,
      1, // open publish policy
      ethers.ZeroAddress,
      0,
      ethers.ZeroHash,
    );
    const cgId = await CGS.getLatestContextGraphId();
    expect(await CGFacade.isAuthorizedPublisher(cgId, victim.address)).to.be
      .true;

    // ---- Victim funds a DIRECT spend (full price) — what they fall back to ----
    const tokenAmount = ethers.parseEther('1000');
    await Token.mint(victim.address, tokenAmount);
    await Token.connect(victim).approve(await KAV10.getAddress(), tokenAmount);

    const currentEpoch = await Chronos.getCurrentEpoch();
    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('pca-dos-regression'));
    const reservedKaId = packReservedKaId(victim.address, 1);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      author: victim,
      contextGraphId: cgId,
      merkleRoot,
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs: lockDurationEpochs,
      tokenAmount,
      isImmutable: false,
      publishOperationId: 'pca-dos-op',
      reservedKaId,
    });

    const victimBalBefore = await Token.balanceOf(victim.address);

    // Pre-fix this reverted InsufficientAllowance and minted no KC.
    const tx = await KAV10.connect(victim).publish(p);
    const receipt = await tx.wait();
    expect(receipt!.status).to.equal(1);

    // Proof it took the DIRECT-spend fall-through, not the discount branch:
    // the victim's own TRAC funded the staker pool (conviction branch would
    // have drawn from the PCA escrow and left the victim's balance intact —
    // and could not have succeeded anyway since the PCA holds 1 wei).
    const epochStorageAddr = (
      await EpochStorageContract.getAddress()
    ).toLowerCase();
    const activeSinkSum = sumActiveSink(receipt!.logs, epochStorageAddr);
    const victimSpent = victimBalBefore - (await Token.balanceOf(victim.address));

    expect(victimSpent).to.equal(tokenAmount);
    // Net-of-treasury distribution funded the pool; it can be ≤ tokenAmount but
    // must be non-zero and cannot exceed what the victim actually paid.
    expect(activeSinkSum).to.be.greaterThan(0n);
    expect(activeSinkSum).to.be.lessThanOrEqual(tokenAmount);

    // KC actually minted to the victim/author.
    expect(await DKGKnowledgeAssets.ownerOf(reservedKaId)).to.equal(
      victim.address,
    );
    const meta = await DKGKnowledgeAssets.getKnowledgeAssetMetadata(reservedKaId);
    expect(meta[6]).to.equal(tokenAmount);

    // The malicious association is still present (consent-free registration is
    // not retroactively removed) but it is now harmless — the victim published.
    expect(await NFT.agentToAccountId(victim.address)).to.equal(
      attackerAccountId,
    );
  });

  it('unexpected (non-payment) reverts from the conviction branch still propagate', async () => {
    // Sanity guard for the selector filter: a victim with NO TRAC and NO
    // approval who falls through to direct spend must still revert
    // (TooLowAllowance / TooLowBalance) rather than silently succeeding — the
    // fall-through is not a free pass, it just removes the PCA-side brick.
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const { identityId: publisherIdentityId } = await createProfile(
      ProfileContract,
      publishingNode,
    );
    const receiverProfiles = await createProfiles(ProfileContract, receivingNodes);
    const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);

    await stakeV10(publishingNode.operational, publisherIdentityId, MIN_STAKE);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeV10(
        receivingNodes[i].operational,
        receiverProfiles[i].identityId,
        MIN_STAKE,
      );
    }

    const attacker = accounts[8];
    const victim = getDefaultKCCreator(accounts);
    await Token.mint(attacker.address, 1n);
    await Token.connect(attacker).approve(await NFT.getAddress(), 1n);
    await NFT.connect(attacker).createAccount(1n);
    const attackerAccountId = await NFT.totalSupply();
    await NFT.connect(attacker).registerAgent(attackerAccountId, victim.address);
    const lockDurationEpochs = Number((await NFT.accounts(attackerAccountId))[5]);

    await CGFacade.connect(victim).createContextGraph(
      [],
      0,
      0,
      1,
      ethers.ZeroAddress,
      0,
      ethers.ZeroHash,
    );
    const cgId = await CGS.getLatestContextGraphId();

    const tokenAmount = ethers.parseEther('1000');
    // NOTE: victim is intentionally NOT funded / NOT approved here.
    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('pca-dos-nofund'));
    const reservedKaId = packReservedKaId(victim.address, 1);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      author: victim,
      contextGraphId: cgId,
      merkleRoot,
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs: lockDurationEpochs,
      tokenAmount,
      isImmutable: false,
      publishOperationId: 'pca-dos-nofund-op',
      reservedKaId,
    });

    // Falls through to direct spend, which reverts on the missing allowance —
    // the publisher pays via direct spend or not at all; it is never bricked
    // by the PCA, but it also isn't handed a free publish.
    await expect(KAV10.connect(victim).publish(p)).to.be.revertedWithCustomError(
      KAV10,
      'TooLowAllowance',
    );
  });
});
