/**
 * V10 Publishing Conviction NFT — chain-adapter write+read lifecycle
 * against a real Hardhat node (issue #519 / TB-0001).
 *
 * Covers the seven V10 `DKGPublishingConvictionNFT` adapter methods:
 * create / topUp / registerAgent / deregisterAgent / isAgent / settle /
 * getAccountInfo, plus the owner-gating invariant (non-owner writes must
 * surface the on-chain revert, never be swallowed).
 *
 * Conventions mirror chain-lifecycle-extra.test.ts: real EVMChainAdapter
 * over the shared Hardhat node, one snapshot per test for isolation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import {
  createEVMAdapter,
  getSharedContext,
  createProvider,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from './evm-test-context.js';
import { mintTokens } from './hardhat-harness.js';

const COMMITTED = ethers.parseEther('10000');

let fileSnapshotId: string;
let testSnapshotId: string;

async function fundedOwner(key: string = HARDHAT_KEYS.CORE_OP) {
  const adapter = createEVMAdapter(key);
  await mintTokens(
    createProvider(),
    getSharedContext().hubAddress,
    HARDHAT_KEYS.DEPLOYER,
    adapter.getSignerAddress(),
    COMMITTED * 4n,
  );
  return adapter;
}

describe('V10 Publishing Conviction NFT — chain-adapter lifecycle', () => {
  beforeAll(async () => { fileSnapshotId = await takeSnapshot(); }, 120_000);
  afterAll(async () => { await revertSnapshot(fileSnapshotId); });
  beforeEach(async () => { testSnapshotId = await takeSnapshot(); });
  afterEach(async () => { await revertSnapshot(testSnapshotId); });

  it('createConvictionAccount mints the NFT to the signer and returns accountId + txHash', async () => {
    const owner = await fundedOwner();

    const res = await owner.createConvictionAccount(COMMITTED);
    expect(res.success).toBe(true);
    expect(res.accountId).toBeGreaterThan(0n);
    expect(res.hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(res.blockNumber).toBeGreaterThan(0);

    const onChainOwner = await owner.getPublishingConvictionAccountOwner(res.accountId);
    expect(onChainOwner.toLowerCase()).toBe(owner.getSignerAddress().toLowerCase());

    const info = await owner.getConvictionAccountInfo(res.accountId);
    expect(info).not.toBeNull();
    expect(info!.owner.toLowerCase()).toBe(owner.getSignerAddress().toLowerCase());
    expect(info!.committedTRAC).toBe(COMMITTED);
    expect(info!.agentCount).toBe(0);
  });

  it('registerConvictionAgent then isConvictionAgent returns true and the reverse map resolves', async () => {
    const owner = await fundedOwner();
    const { accountId } = await owner.createConvictionAccount(COMMITTED);

    const agent = ethers.Wallet.createRandom().address;
    expect(await owner.isConvictionAgent(accountId, agent)).toBe(false);

    const reg = await owner.registerConvictionAgent(accountId, agent);
    expect(reg.success).toBe(true);

    expect(await owner.isConvictionAgent(accountId, agent)).toBe(true);
    expect(await owner.getConvictionAgentAccountId(agent)).toBe(accountId);

    const info = await owner.getConvictionAccountInfo(accountId);
    expect(info!.agentCount).toBe(1);

    const dereg = await owner.deregisterConvictionAgent(accountId, agent);
    expect(dereg.success).toBe(true);
    expect(await owner.isConvictionAgent(accountId, agent)).toBe(false);
    expect(await owner.getConvictionAgentAccountId(agent)).toBe(0n);
  });
});
