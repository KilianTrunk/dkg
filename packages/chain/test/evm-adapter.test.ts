import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import {
  spawnHardhatEnv,
  killHardhat,
  makeAdapterConfig,
  HARDHAT_KEYS,
  type HardhatContext,
} from './hardhat-harness.js';

let ctx: HardhatContext;

describe('EVMChainAdapter integration', () => {
  beforeAll(async () => {
    ctx = await spawnHardhatEnv(8545);
  }, 60_000);

  afterAll(() => {
    killHardhat(ctx);
  });

  it('should connect and resolve V10 contracts from Hub', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));

    expect(adapter.chainType).toBe('evm');
    expect(adapter.chainId).toBe('evm:31337');

    // V8 `KnowledgeCollection` + `Staking` were archived in TB-1 (PRD §4.1)
    // — their Hub bindings no longer exist. Hub-resolve the V10 successors
    // instead to assert the adapter still talks to a fresh V10 deploy.
    const kav10 = await adapter.getContract('KnowledgeAssetsV10');
    expect(await kav10.name()).toBe('KnowledgeAssetsV10');

    const stakingV10 = await adapter.getContract('StakingV10');
    expect(await stakingV10.name()).toBe('StakingV10');
  }, 30_000);

  it('should have correct signer address', () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const address = adapter.getSignerAddress();
    expect(address.toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  });

  it('getBlockNumber reads from the live Hardhat node (no contract init required)', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const bn = await adapter.getBlockNumber();
    expect(typeof bn).toBe('number');
    expect(bn).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it('verifyPublisherOwnsRange resolves KnowledgeAssetsStorage after init', async () => {
    const adapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER));
    const deployer = adapter.getSignerAddress();
    const owns = await adapter.verifyPublisherOwnsRange(deployer, 1n, 1n);
    expect(owns).toBe(false);
  }, 30_000);
});
