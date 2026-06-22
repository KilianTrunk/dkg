import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  Hub,
  ParametersStorage,
  Profile,
  ShardingTable,
  ShardingTableStorage,
  StakingV10,
  Token,
} from '../../typechain';

// ---------------------------------------------------------------------------
// #1286 — full sharding table must NOT block stake/claim/withdraw/redelegate.
//
// `ShardingTable.insertNode` reverts `ShardingTableIsFull` once `nodesCount`
// reaches `shardingTableSizeLimit`. Previously every opportunistic admission
// call site in StakingV10 (`stake`, `redelegate`, `_claim`, the
// createConviction/stakeForNode path) called `shardingTable.insertNode(...)`
// directly, so a node crossing `minimumStake` while the table was full
// reverted the WHOLE user operation. Because `withdraw` auto-claims (calls
// `_claim`) first, a full table even blocked stakers from withdrawing their
// own raw principal.
//
// The fix routes all four sites through one best-effort helper:
//
//   function _tryAdmitNode(uint72 identityId) internal {
//       try shardingTable.insertNode(identityId) {
//       } catch {
//           emit NodeAdmissionDeferred(identityId, convictionStorage.getNodeStakeV10(identityId));
//       }
//   }
//
// so admission becomes opportunistic housekeeping: on a full table the node
// stays OUT of the ring (deferred) and the user's operation succeeds.
//
// All four call sites share `_tryAdmitNode`, so the `stake()` path (entered via
// `DKGStakingConvictionNFT.createConviction` crossing `minimumStake`) is a
// faithful proof of the helper's behavior for all of them. We additionally
// pin the *cause* of the deferral to `ShardingTableIsFull` (the `catch` is bare
// and would fire on any insert revert) via a direct-insert probe + a positive
// control where the same path admits the node when the table is NOT full.
// ---------------------------------------------------------------------------

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGStakingConvictionNFT;
  StakingV10: StakingV10;
  ConvictionStakingStorage: ConvictionStakingStorage;
  ParametersStorage: ParametersStorage;
  Profile: Profile;
  ShardingTable: ShardingTable;
  ShardingTableStorage: ShardingTableStorage;
  Token: Token;
};

async function deployFixture(): Promise<Fixture> {
  // The `DKGStakingConvictionNFT` + `StakingV10` tags transitively pull in the
  // ShardingTable / ShardingTableStorage / ParametersStorage cluster (see the
  // `func.dependencies` in their deploy scripts), so a single fixture call
  // yields a fully Hub-wired V10 staking stack with sharding-table admission.
  await hre.deployments.fixture(['DKGStakingConvictionNFT', 'StakingV10', 'Profile']);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const NFT = await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT');
  const StakingV10 = await hre.ethers.getContract<StakingV10>('StakingV10');
  const ConvictionStakingStorage = await hre.ethers.getContract<ConvictionStakingStorage>(
    'ConvictionStakingStorage',
  );
  const ParametersStorage = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
  const Profile = await hre.ethers.getContract<Profile>('Profile');
  const ShardingTable = await hre.ethers.getContract<ShardingTable>('ShardingTable');
  const ShardingTableStorage = await hre.ethers.getContract<ShardingTableStorage>(
    'ShardingTableStorage',
  );
  const Token = await hre.ethers.getContract<Token>('Token');

  // HubOwner lets accounts[0] drive the privileged ParametersStorage setter
  // (`setShardingTableSizeLimit`) and the `onlyContracts`-gated ShardingTable
  // insert/remove probes — mirrors `ShardingTable.size-cap.test.ts`.
  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Hub,
    NFT,
    StakingV10,
    ConvictionStakingStorage,
    ParametersStorage,
    Profile,
    ShardingTable,
    ShardingTableStorage,
    Token,
  };
}

describe('@unit StakingV10 full-table admission (#1286)', () => {
  let accounts: SignerWithAddress[];
  let NFT: DKGStakingConvictionNFT;
  let StakingV10Contract: StakingV10;
  let ConvictionStakingStorageContract: ConvictionStakingStorage;
  let ParametersStorage: ParametersStorage;
  let Profile: Profile;
  let ShardingTableContract: ShardingTable;
  let ShardingTableStorage: ShardingTableStorage;
  let Token: Token;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      NFT,
      StakingV10: StakingV10Contract,
      ConvictionStakingStorage: ConvictionStakingStorageContract,
      ParametersStorage,
      Profile,
      ShardingTable: ShardingTableContract,
      ShardingTableStorage,
      Token,
    } = await loadFixture(deployFixture));
  });

  // Helper — mint a profile, using fresh node key material each call.
  // Mirrors `DKGStakingConvictionNFT.test.ts::createProfile`.
  const createProfile = async (
    admin: SignerWithAddress,
    operational: SignerWithAddress,
  ): Promise<number> => {
    const nodeId = '0x' + randomBytes(32).toString('hex');
    const tx = await Profile.connect(operational).createProfile(
      admin.address,
      [],
      `Node ${Math.floor(Math.random() * 1_000_000)}`,
      nodeId,
      0,
    );
    const receipt = await tx.wait();
    return Number(receipt!.logs[0].topics[1]);
  };

  // Helper — mint TRAC to `staker` and approve StakingV10 (it pulls
  // `transferFrom(staker, ConvictionStakingStorage)` inside `stake`).
  const mintAndApprove = async (staker: SignerWithAddress, amount: bigint) => {
    await Token.mint(staker.address, amount);
    await Token.connect(staker).approve(await StakingV10Contract.getAddress(), amount);
  };

  // Helper — fill the sharding table to its size limit with `n` zero-stake
  // dummy nodes inserted directly (as the size-cap test does). These nodes
  // never stake, so no NFT is minted — the staker's first `createConviction`
  // below is therefore tokenId 1. Returns the inserted identityIds so a caller
  // can later free a slot via `removeNode`.
  const fillTable = async (n: number): Promise<number[]> => {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const id = await createProfile(accounts[0], accounts[i + 1]);
      await ShardingTableContract['insertNode(uint72)'](id);
      ids.push(id);
    }
    expect(await ShardingTableStorage.nodesCount()).to.equal(n);
    return ids;
  };

  it('FULL table: createConviction crossing minStake does NOT revert; node deferred, position recorded', async () => {
    const N = 2;
    await ParametersStorage.setShardingTableSizeLimit(N);
    await fillTable(N);

    // Fresh node, NOT in the table, owned/operated by later accounts so its
    // keys don't collide with the dummy fillers.
    const staker = accounts[10];
    const freshId = await createProfile(staker, accounts[11]);
    expect(await ShardingTableStorage.nodeExists(freshId)).to.equal(false);

    const minStake = await ParametersStorage.minimumStake();
    await mintAndApprove(staker, minStake);

    // (a) The call must NOT revert with ShardingTableIsFull — pre-fix this
    //     reverted the whole stake. (b) It emits NodeAdmissionDeferred with the
    //     post-createPosition node stake (== minStake). The NFT mint is tokenId 1.
    const tx = await NFT.connect(staker).createConviction(freshId, minStake, 12);
    await expect(tx)
      .to.emit(StakingV10Contract, 'NodeAdmissionDeferred')
      .withArgs(freshId, minStake);
    // Sanity: it did NOT also emit a positive admission elsewhere — the only
    // way out of the gate on a full table is the deferral.

    // (c) Node is deferred — it stays OUT of the ring.
    expect(await ShardingTableStorage.nodeExists(freshId)).to.equal(false);
    expect(await ShardingTableStorage.nodesCount()).to.equal(N);

    // (d) The user's operation succeeded: node stake + CSS position + NFT all recorded.
    expect(await ConvictionStakingStorageContract.getNodeStakeV10(freshId)).to.equal(minStake);
    const pos = await ConvictionStakingStorageContract.getPosition(1);
    expect(pos.identityId).to.equal(freshId);
    expect(pos.raw).to.equal(minStake);
    expect(await NFT.ownerOf(1)).to.equal(staker.address);

    // Cause-pin: the deferral was caused by fullness specifically. The `catch`
    // in `_tryAdmitNode` is bare, so prove the swallowed error IS
    // `ShardingTableIsFull` by replaying the raw insert directly — the table is
    // still full and the node still out, so this reverts with exactly that error.
    await expect(ShardingTableContract['insertNode(uint72)'](freshId))
      .to.be.revertedWithCustomError(ShardingTableContract, 'ShardingTableIsFull')
      .withArgs(N, N);
  });

  it('POSITIVE CONTROL — NON-full table: the same path DOES admit the node (no deferral)', async () => {
    // The discriminator: same node, same minStake, same `stake()` path, the
    // ONLY difference is the table is not full. Insert succeeds → no
    // NodeAdmissionDeferred, nodeExists == true. This proves the deferral in
    // the full-table case is caused by fullness, not by some unrelated insert
    // precondition failing.
    const N = 5; // room to spare
    await ParametersStorage.setShardingTableSizeLimit(N);
    await fillTable(1); // one occupant, far below the cap

    const staker = accounts[10];
    const freshId = await createProfile(staker, accounts[11]);
    expect(await ShardingTableStorage.nodeExists(freshId)).to.equal(false);

    const minStake = await ParametersStorage.minimumStake();
    await mintAndApprove(staker, minStake);

    const tx = await NFT.connect(staker).createConviction(freshId, minStake, 12);
    await expect(tx).to.not.emit(StakingV10Contract, 'NodeAdmissionDeferred');

    // Admitted — node is in the ring.
    expect(await ShardingTableStorage.nodeExists(freshId)).to.equal(true);
    expect(await ShardingTableStorage.nodesCount()).to.equal(2);

    // Position recorded exactly as in the deferred case.
    expect(await ConvictionStakingStorageContract.getNodeStakeV10(freshId)).to.equal(minStake);
    expect((await ConvictionStakingStorageContract.getPosition(1)).raw).to.equal(minStake);
    expect(await NFT.ownerOf(1)).to.equal(staker.address);
  });

  it('FULL → free a slot → a subsequent stake admits the previously-deferred node', async () => {
    const N = 2;
    await ParametersStorage.setShardingTableSizeLimit(N);
    const fillerIds = await fillTable(N);

    const staker = accounts[10];
    const freshId = await createProfile(staker, accounts[11]);
    const minStake = await ParametersStorage.minimumStake();
    await mintAndApprove(staker, minStake * 2n);

    // First stake on the full table → deferred.
    await expect(NFT.connect(staker).createConviction(freshId, minStake, 12))
      .to.emit(StakingV10Contract, 'NodeAdmissionDeferred')
      .withArgs(freshId, minStake);
    expect(await ShardingTableStorage.nodeExists(freshId)).to.equal(false);

    // Free a slot: remove one of the dummy fillers we inserted in `fillTable`.
    await ShardingTableContract['removeNode(uint72)'](fillerIds[0]);
    expect(await ShardingTableStorage.nodesCount()).to.equal(N - 1);

    // A second stake on the now-non-full table re-attempts admission and
    // succeeds — the deferred node enters the ring.
    const tx = await NFT.connect(staker).createConviction(freshId, minStake, 12);
    await expect(tx).to.not.emit(StakingV10Contract, 'NodeAdmissionDeferred');
    expect(await ShardingTableStorage.nodeExists(freshId)).to.equal(true);
  });
});
