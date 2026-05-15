import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';

async function makeAgent(chain: MockChainAdapter): Promise<DKGAgent> {
  return DKGAgent.create({
    name: 'PcaV10Facade',
    listenHost: '127.0.0.1',
    listenPort: 0,
    chainAdapter: chain,
    nodeRole: 'core',
  });
}

describe('DKGAgent V10 PCA facade', () => {
  it('createConvictionAccount delegates to the chain adapter and getConvictionAccountInfo reflects it', async () => {
    const owner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', owner.address);
    const agent = await makeAgent(chain);

    const created = await agent.createConvictionAccount(1_000n);
    expect(created).not.toBeNull();
    expect(created!.accountId).toBeGreaterThan(0n);
    expect(created!.hash).toMatch(/^0x/);

    const info = await agent.getConvictionAccountInfo(created!.accountId);
    expect(info).not.toBeNull();
    expect(info!.owner.toLowerCase()).toBe(owner.address.toLowerCase());
    expect(info!.committedTRAC).toBe(1_000n);
  });
});
