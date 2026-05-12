import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Hub,
  IdentityStorage,
  ParametersStorage,
  Profile,
  ProfileStorage,
  StakingStorage,
  Token,
  WhitelistStorage,
} from '../../typechain';

type ProfileFixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  IdentityStorage: IdentityStorage;
  Profile: Profile;
  ParametersStorage: ParametersStorage;
  ProfileStorage: ProfileStorage;
  WhitelistStorage: WhitelistStorage;
  Token: Token;
  StakingStorage: StakingStorage;
};

describe('@unit Profile contract', function () {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let IdentityStorage: IdentityStorage;
  let Profile: Profile;
  let ParametersStorage: ParametersStorage;
  let ProfileStorage: ProfileStorage;
  let WhitelistStorage: WhitelistStorage;
  let Token: Token;
  let StakingStorage: StakingStorage;

  const nodeId1 =
    '0x07f38512786964d9e70453371e7c98975d284100d44bd68dab67fe00b525cb66';
  const identityId1 = 1;

  async function deployProfileFixture(): Promise<ProfileFixture> {
    await hre.deployments.fixture(['Profile']);
    Profile = await hre.ethers.getContract<Profile>('Profile');
    IdentityStorage =
      await hre.ethers.getContract<IdentityStorage>('IdentityStorage');
    ParametersStorage =
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    ProfileStorage =
      await hre.ethers.getContract<ProfileStorage>('ProfileStorage');
    WhitelistStorage =
      await hre.ethers.getContract<WhitelistStorage>('WhitelistStorage');
    Token = await hre.ethers.getContract<Token>('Token');
    StakingStorage =
      await hre.ethers.getContract<StakingStorage>('StakingStorage');
    accounts = await hre.ethers.getSigners();
    Hub = await hre.ethers.getContract<Hub>('Hub');
    await Hub.setContractAddress('HubOwner', accounts[0].address);

    return {
      accounts,
      Hub,
      IdentityStorage,
      Profile,
      ParametersStorage,
      ProfileStorage,
      WhitelistStorage,
      Token,
      StakingStorage,
    };
  }

  beforeEach(async () => {
    ({
      accounts,
      Hub,
      IdentityStorage,
      Profile,
      ParametersStorage,
      ProfileStorage,
      WhitelistStorage,
      Token,
      StakingStorage,
    } = await loadFixture(deployProfileFixture));
  });

  it('The contract is named "Profile"', async () => {
    expect(await Profile.name()).to.equal('Profile');
  });

  it('The contract is version "1.2.0"', async () => {
    expect(await Profile.version()).to.equal('1.2.0');
  });

  it('Create a profile with valid inputs, expect to pass', async () => {
    await expect(
      Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000),
    ).to.not.be.reverted;
  });

  it('Create a profile with additional operational wallets, expect all to be registered', async () => {
    await Profile.createProfile(accounts[1].address, [accounts[2].address], 'Node 1', nodeId1, 1000);
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    const operationalKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[2].address]),
    );
    expect(await IdentityStorage.keyHasPurpose(identityId, operationalKey, 2)).to.equal(true);
  });

  it('Existing operational wallet cannot add operational wallets after profile creation', async () => {
    await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    await expect(
      Profile.addOperationalWallets(identityId, [accounts[2].address]),
    ).to.be.revertedWithCustomError(Profile, 'OnlyProfileAdminFunction');
  });

  it('Admin wallet can add operational wallets after profile creation', async () => {
    await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [accounts[2].address]),
    ).to.not.be.reverted;

    const operationalKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[2].address]),
    );
    expect(await IdentityStorage.keyHasPurpose(identityId, operationalKey, 2)).to.equal(true);
  });

  it('Cannot add the profile admin wallet as an operational wallet', async () => {
    await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [accounts[1].address]),
    ).to.be.revertedWithCustomError(Profile, 'AdminEqualsOperational');
  });

  it('Adding already registered same-identity operational wallets is idempotent', async () => {
    await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [
        accounts[0].address,
        accounts[2].address,
        accounts[2].address,
      ]),
    ).to.not.be.reverted;
    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [accounts[0].address, accounts[2].address]),
    ).to.not.be.reverted;

    const operationalKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[2].address]),
    );
    expect(await IdentityStorage.keyHasPurpose(identityId, operationalKey, 2)).to.equal(true);
  });

  it('Cannot add an operational wallet already registered to another identity', async () => {
    await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    const nodeId2 =
      '0x17f38512786964d9e70453371e7c98975d284100d44bd68dab67fe00b525cb66';
    await Profile.connect(accounts[3]).createProfile(
      accounts[4].address,
      [],
      'Node 2',
      nodeId2,
      1000,
    );
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [accounts[3].address]),
    ).to.be.revertedWithCustomError(Profile, 'OperationalKeyTaken');
  });

  it('Cannot add the zero address as an operational wallet', async () => {
    await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [hre.ethers.ZeroAddress]),
    ).to.be.revertedWithCustomError(Profile, 'OperationalAddressZero');
  });

  it('Cannot exceed the configured operational wallet limit after profile creation', async () => {
    await ParametersStorage.setOpWalletsLimitOnProfileCreation(2);
    await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    const identityId = await IdentityStorage.getIdentityId(accounts[0].address);

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [accounts[2].address]),
    ).to.not.be.reverted;

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [accounts[3].address]),
    ).to.not.be.reverted;

    await expect(
      Profile.connect(accounts[1]).addOperationalWallets(identityId, [accounts[4].address]),
    ).to.be.revertedWithCustomError(Profile, 'TooManyOperationalWallets').withArgs(2, 3);
  });

  it('Cannot create a profile with empty node name, expect to fail', async () => {
    await expect(
      Profile.createProfile(accounts[1].address, [], '', nodeId1, 1000),
    ).to.be.revertedWithCustomError(Profile, 'EmptyNodeName');
  });

  it('Cannot create a profile with empty node ID, expect to fail', async () => {
    await expect(
      Profile.createProfile(accounts[1].address, [], 'Node 1', '0x', 1000),
    ).to.be.revertedWithCustomError(Profile, 'EmptyNodeId');
  });

  it('Cannot create a profile with node ID already taken, expect to fail', async () => {
    await Profile.createProfile(
      accounts[1].address,
      [],
      'Node 1',
      nodeId1,
      1000,
    );

    await expect(
      Profile.connect(accounts[3]).createProfile(
        accounts[2].address,
        [],
        'Node 2',
        nodeId1,
        1000,
      ),
    ).to.be.revertedWithCustomError(Profile, 'NodeIdAlreadyExists');
  });

  it('Cannot create a profile with operator fee greater than 10000, expect to fail', async () => {
    await expect(
      Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 10001),
    ).to.be.revertedWithCustomError(Profile, 'OperatorFeeOutOfRange');
  });

  it('Update ask for a profile with valid input, expect to pass', async () => {
    await Profile.createProfile(
      accounts[1].address,
      [],
      'Node 1',
      nodeId1,
      1000,
    );

    await expect(Profile.updateAsk(identityId1, 2000)).to.not.be.reverted;
  });

  it('Update ask with zero value, expect to fail', async () => {
    await Profile.createProfile(
      accounts[1].address,
      [],
      'Node 1',
      nodeId1,
      1000,
    );

    await expect(
      Profile.connect(accounts[1]).updateAsk(identityId1, 0),
    ).to.be.revertedWithCustomError(Profile, 'ZeroAsk');
  });

  it('Update operator fee with valid input, expect to pass', async () => {
    await Profile.createProfile(
      accounts[1].address,
      [],
      'Node 1',
      nodeId1,
      1000,
    );

    await expect(
      Profile.connect(accounts[1]).updateOperatorFee(identityId1, 500),
    ).to.not.be.reverted;
  });

  it('Update operator fee with value greater than 10000, expect to fail', async () => {
    await Profile.createProfile(
      accounts[1].address,
      [],
      'Node 1',
      nodeId1,
      1000,
    );

    await expect(
      Profile.connect(accounts[1]).updateOperatorFee(identityId1, 10001),
    ).to.be.revertedWithCustomError(Profile, 'InvalidOperatorFee');
  });

  it('Cannot update ask during cooldown, expect to fail', async () => {
    await Profile.createProfile(
      accounts[1].address,
      [],
      'Node 1',
      nodeId1,
      1000,
    );
    await Profile.connect(accounts[1]).updateAsk(identityId1, 2000);

    await expect(
      Profile.connect(accounts[1]).updateAsk(identityId1, 3000),
    ).to.be.revertedWithCustomError(Profile, 'AskUpdateOnCooldown');
  });

  it('Whitelist check prevents unauthorized profile creation, expect to fail', async () => {
    await WhitelistStorage.enableWhitelist();

    await expect(
      Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000),
    ).to.be.revertedWithCustomError(
      Profile,
      'OnlyWhitelistedAddressesFunction',
    );
  });

  // =====================================================================
  // RFC 04 / Issue #461 — relay-capability + multiaddr advertisement.
  // =====================================================================

  describe('Relay registry fields (RFC 04 / Issue #461)', () => {
    const validMultiaddr =
      '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

    beforeEach(async () => {
      await Profile.createProfile(accounts[1].address, [], 'Node 1', nodeId1, 1000);
    });

    it('relayCapable defaults to false and multiaddrs to empty', async () => {
      expect(await ProfileStorage.getRelayCapable(identityId1)).to.equal(false);
      expect(await ProfileStorage.getMultiaddrs(identityId1)).to.deep.equal([]);
    });

    it('admin wallet can flip relayCapable', async () => {
      await expect(Profile.connect(accounts[1]).updateRelayCapable(identityId1, true))
        .to.emit(ProfileStorage, 'RelayCapabilityUpdated')
        .withArgs(identityId1, false, true);
      expect(await ProfileStorage.getRelayCapable(identityId1)).to.equal(true);
    });

    it('operational wallet can flip relayCapable (onlyIdentityOwner = admin OR operational)', async () => {
      await Profile.connect(accounts[1]).addOperationalWallets(identityId1, [accounts[2].address]);
      await expect(Profile.connect(accounts[2]).updateRelayCapable(identityId1, true)).to.not.be.reverted;
      expect(await ProfileStorage.getRelayCapable(identityId1)).to.equal(true);
    });

    it('non-owner cannot flip relayCapable', async () => {
      await expect(
        Profile.connect(accounts[5]).updateRelayCapable(identityId1, true),
      ).to.be.revertedWithCustomError(Profile, 'OnlyProfileAdminOrOperationalAddressesFunction');
    });

    it('updateRelayCapable reverts when profile does not exist', async () => {
      await expect(
        Profile.connect(accounts[1]).updateRelayCapable(9999, true),
      ).to.be.reverted; // onlyIdentityOwner runs first against nonexistent identity
    });

    it('admin wallet can publish multiaddrs and they roundtrip', async () => {
      const addrs = [validMultiaddr, '/dns/relay.example.com/tcp/443/wss/p2p/12D3KooWAbcDef'];
      await expect(Profile.connect(accounts[1]).updateMultiaddrs(identityId1, addrs))
        .to.emit(ProfileStorage, 'MultiaddrsUpdated')
        .withArgs(identityId1, addrs);
      expect(await ProfileStorage.getMultiaddrs(identityId1)).to.deep.equal(addrs);
    });

    it('updateMultiaddrs is wholesale-replacement, not append', async () => {
      await Profile.connect(accounts[1]).updateMultiaddrs(identityId1, [validMultiaddr, '/ip4/10.0.0.1/tcp/9090']);
      await Profile.connect(accounts[1]).updateMultiaddrs(identityId1, [validMultiaddr]);
      expect(await ProfileStorage.getMultiaddrs(identityId1)).to.deep.equal([validMultiaddr]);
    });

    it('passing an empty array clears multiaddrs', async () => {
      await Profile.connect(accounts[1]).updateMultiaddrs(identityId1, [validMultiaddr]);
      await Profile.connect(accounts[1]).updateMultiaddrs(identityId1, []);
      expect(await ProfileStorage.getMultiaddrs(identityId1)).to.deep.equal([]);
    });

    it('rejects more than MAX_MULTIADDRS entries (8)', async () => {
      const tooMany = Array.from({ length: 9 }, (_, i) => `/ip4/10.0.0.${i}/tcp/9090`);
      await expect(
        Profile.connect(accounts[1]).updateMultiaddrs(identityId1, tooMany),
      )
        .to.be.revertedWithCustomError(Profile, 'TooManyMultiaddrs')
        .withArgs(8, 9);
    });

    it('rejects empty multiaddr entries', async () => {
      await expect(
        Profile.connect(accounts[1]).updateMultiaddrs(identityId1, [validMultiaddr, '']),
      )
        .to.be.revertedWithCustomError(Profile, 'EmptyMultiaddr')
        .withArgs(1);
    });

    it('rejects multiaddr entries longer than MAX_MULTIADDR_LENGTH (256)', async () => {
      const tooLong = '/dns/' + 'x'.repeat(260);
      await expect(
        Profile.connect(accounts[1]).updateMultiaddrs(identityId1, [tooLong]),
      )
        .to.be.revertedWithCustomError(Profile, 'MultiaddrTooLong')
        .withArgs(256, tooLong.length);
    });

    it('non-owner cannot updateMultiaddrs', async () => {
      await expect(
        Profile.connect(accounts[5]).updateMultiaddrs(identityId1, [validMultiaddr]),
      ).to.be.revertedWithCustomError(Profile, 'OnlyProfileAdminOrOperationalAddressesFunction');
    });

    it('getProfile surfaces relayCapable and multiaddrs alongside legacy fields', async () => {
      await Profile.connect(accounts[1]).updateRelayCapable(identityId1, true);
      await Profile.connect(accounts[1]).updateMultiaddrs(identityId1, [validMultiaddr]);
      const [name, nodeId, ask, opFees, relayCapable, multiaddrs] = await ProfileStorage.getProfile(identityId1);
      expect(name).to.equal('Node 1');
      expect(nodeId).to.equal(nodeId1);
      expect(ask).to.equal(0n);
      expect(opFees.length).to.equal(1);
      expect(relayCapable).to.equal(true);
      expect(multiaddrs).to.deep.equal([validMultiaddr]);
    });
  });
});
