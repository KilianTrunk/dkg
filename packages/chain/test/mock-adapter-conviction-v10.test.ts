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
