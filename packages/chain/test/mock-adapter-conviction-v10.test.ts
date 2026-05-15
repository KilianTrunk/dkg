/**
 * MockChainAdapter V10 Publishing Conviction NFT parity (issue #519 /
 * TB-0002). The mock models an in-memory account map (incrementing id),
 * an agent → accountId reverse map and owner-gating so offline-mode
 * users hit the same owner-revert behaviour as the real chain.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '../src/mock-adapter.js';

const SIGNER = '0x1111111111111111111111111111111111111111';
const COMMITTED = ethers.parseEther('10000');

describe('MockChainAdapter — V10 conviction account create/read', () => {
  it('createConvictionAccount mints to the signer with an incrementing id', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);

    const a = await mock.createConvictionAccount(COMMITTED);
    expect(a.success).toBe(true);
    expect(a.accountId).toBe(1n);
    expect(a.hash).toMatch(/^0x[0-9a-fA-F]{64}/);

    const b = await mock.createConvictionAccount(COMMITTED);
    expect(b.accountId).toBe(2n);
  });

  it('getConvictionAccountInfo returns the V10 shape owned by the signer', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createConvictionAccount(COMMITTED);

    const info = await mock.getConvictionAccountInfo(accountId);
    expect(info).not.toBeNull();
    expect(info!.owner.toLowerCase()).toBe(SIGNER.toLowerCase());
    expect(info!.committedTRAC).toBe(COMMITTED);
    expect(info!.topUpBuffer).toBe(0n);
    expect(info!.agentCount).toBe(0);

    expect(await mock.getConvictionAccountInfo(999n)).toBeNull();
  });
});

describe('MockChainAdapter — V10 conviction agent register/deregister', () => {
  it('registers an agent, exposes it via isConvictionAgent + reverse map, then deregisters', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createConvictionAccount(COMMITTED);
    const agent = ethers.Wallet.createRandom().address;

    expect(await mock.isConvictionAgent(accountId, agent)).toBe(false);

    const reg = await mock.registerConvictionAgent(accountId, agent);
    expect(reg.success).toBe(true);
    expect(await mock.isConvictionAgent(accountId, agent)).toBe(true);
    expect(await mock.getConvictionAgentAccountId(agent)).toBe(accountId);
    expect((await mock.getConvictionAccountInfo(accountId))!.agentCount).toBe(1);

    const dereg = await mock.deregisterConvictionAgent(accountId, agent);
    expect(dereg.success).toBe(true);
    expect(await mock.isConvictionAgent(accountId, agent)).toBe(false);
    expect(await mock.getConvictionAgentAccountId(agent)).toBe(0n);
    expect((await mock.getConvictionAccountInfo(accountId))!.agentCount).toBe(0);
  });

  it('rejects re-registering an already-registered agent (N28 parity)', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createConvictionAccount(COMMITTED);
    const agent = ethers.Wallet.createRandom().address;

    await mock.registerConvictionAgent(accountId, agent);
    await expect(mock.registerConvictionAgent(accountId, agent))
      .rejects.toThrow(/AgentAlreadyRegistered/);
  });
});

describe('MockChainAdapter — V10 conviction topUp/settle', () => {
  it('topUpConvictionAccount accumulates the buffer and settle succeeds', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createConvictionAccount(COMMITTED);

    const top = await mock.topUpConvictionAccount(accountId, COMMITTED);
    expect(top.success).toBe(true);
    expect((await mock.getConvictionAccountInfo(accountId))!.topUpBuffer).toBe(COMMITTED);

    await mock.topUpConvictionAccount(accountId, COMMITTED);
    expect((await mock.getConvictionAccountInfo(accountId))!.topUpBuffer).toBe(COMMITTED * 2n);

    const settled = await mock.settleConvictionAccount(accountId);
    expect(settled.success).toBe(true);
  });
});

describe('MockChainAdapter — V10 owner-gating parity', () => {
  const STRANGER = '0x2222222222222222222222222222222222222222';

  it('rejects non-owner topUp/register/deregister with NotAccountOwner (revert not swallowed)', async () => {
    // Account owned by STRANGER; this mock's signer is SIGNER → not owner.
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const accountId = mock.seedConvictionAccount(STRANGER);
    const agent = ethers.Wallet.createRandom().address;

    await expect(mock.topUpConvictionAccount(accountId, COMMITTED))
      .rejects.toThrow(/NotAccountOwner/);
    await expect(mock.registerConvictionAgent(accountId, agent))
      .rejects.toThrow(/NotAccountOwner/);
    await expect(mock.deregisterConvictionAgent(accountId, agent))
      .rejects.toThrow(/NotAccountOwner/);

    // Rejected writes must not have mutated state.
    const info = await mock.getConvictionAccountInfo(accountId);
    expect(info!.topUpBuffer).toBe(0n);
    expect(info!.agentCount).toBe(0);
  });

  it('settle is permissionless (no owner gate, parity with the contract)', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const accountId = mock.seedConvictionAccount(STRANGER);
    await expect(mock.settleConvictionAccount(accountId)).resolves.toMatchObject({ success: true });
  });

  it('deregistering an unregistered agent reverts AgentNotRegistered', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createConvictionAccount(COMMITTED);
    await expect(
      mock.deregisterConvictionAgent(accountId, ethers.Wallet.createRandom().address),
    ).rejects.toThrow(/AgentNotRegistered/);
  });
});

describe('MockChainAdapter — V10 invalid-input parity with the contract', () => {
  const MAX_UINT96 = (1n << 96n) - 1n;

  it('createConvictionAccount rejects zero / negative / uint96-overflow committedTRAC', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    await expect(mock.createConvictionAccount(0n)).rejects.toThrow(/InvalidAmount/);
    await expect(mock.createConvictionAccount(-1n)).rejects.toThrow(/InvalidAmount/);
    await expect(mock.createConvictionAccount(MAX_UINT96 + 1n)).rejects.toThrow(/InvalidAmount/);
  });

  it('topUpConvictionAccount rejects zero / negative / uint96-overflow amount', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createConvictionAccount(COMMITTED);
    await expect(mock.topUpConvictionAccount(accountId, 0n)).rejects.toThrow(/InvalidAmount/);
    await expect(mock.topUpConvictionAccount(accountId, -1n)).rejects.toThrow(/InvalidAmount/);
    await expect(mock.topUpConvictionAccount(accountId, MAX_UINT96 + 1n)).rejects.toThrow(/InvalidAmount/);
    expect((await mock.getConvictionAccountInfo(accountId))!.topUpBuffer).toBe(0n);
  });

  it('registerConvictionAgent rejects the zero address (ZeroAgentAddress)', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createConvictionAccount(COMMITTED);
    await expect(
      mock.registerConvictionAgent(accountId, ethers.ZeroAddress),
    ).rejects.toThrow(/ZeroAgentAddress/);
    expect((await mock.getConvictionAccountInfo(accountId))!.agentCount).toBe(0);
  });

  it('getConvictionAccountInfo.baseEpochAllowance is committedTRAC / lockDurationEpochs', async () => {
    const mock = new MockChainAdapter('mock:31337', SIGNER);
    const { accountId } = await mock.createConvictionAccount(COMMITTED);
    const info = (await mock.getConvictionAccountInfo(accountId))!;
    const lock = await mock.getConvictionAccountLockDurationEpochs(accountId);
    expect(lock).toBeGreaterThan(0);
    expect(info.baseEpochAllowance).toBe(COMMITTED / BigInt(lock));
    expect(info.baseEpochAllowance).toBeGreaterThan(0n);
  });
});
