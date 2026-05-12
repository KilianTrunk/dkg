/**
 * EVMChainAdapter — Network Relay Registry surface (RFC 04 / Issue #461).
 *
 * Drives the four chain-adapter methods (getRelayCapable / getMultiaddrs /
 * setRelayCapable / setMultiaddrs) plus the two new event emissions
 * (RelayCapabilityUpdated / MultiaddrsUpdated) against a real Hardhat
 * node so we catch a contract <-> ABI <-> adapter drift in CI rather
 * than at devnet bring-up time.
 *
 * Each test takes a fresh snapshot so we can flip flags and rewrite
 * multiaddrs without leaking state across tests.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import {
  createEVMAdapter,
  getSharedContext,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from './evm-test-context.js';

const VALID_MULTIADDR =
  '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

let fileSnapshotId: string;
let testSnapshotId: string;

describe('EVMChainAdapter — relay registry surface', () => {
  beforeAll(async () => {
    fileSnapshotId = await takeSnapshot();
  });

  afterAll(async () => {
    await revertSnapshot(fileSnapshotId);
  });

  beforeEach(async () => {
    testSnapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertSnapshot(testSnapshotId);
  });

  it('reads default false / empty for the seeded core profile', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { coreProfileId } = getSharedContext();
    expect(await adapter.getRelayCapable!(BigInt(coreProfileId))).toBe(false);
    expect(await adapter.getMultiaddrs!(BigInt(coreProfileId))).toEqual([]);
  });

  it('round-trips relayCapable through setRelayCapable + getRelayCapable', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { coreProfileId } = getSharedContext();
    const tx = await adapter.setRelayCapable!(true);
    expect(tx.success).toBe(true);
    expect(await adapter.getRelayCapable!(BigInt(coreProfileId))).toBe(true);
  });

  it('round-trips multiaddrs through setMultiaddrs + getMultiaddrs', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { coreProfileId } = getSharedContext();
    const addrs = [VALID_MULTIADDR, '/dns/relay.example.com/tcp/443/wss/p2p/12D3KooWAbcDef'];
    const tx = await adapter.setMultiaddrs!(addrs);
    expect(tx.success).toBe(true);
    expect(await adapter.getMultiaddrs!(BigInt(coreProfileId))).toEqual(addrs);
  });

  it('setMultiaddrs is wholesale replacement (clears stale entries)', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { coreProfileId } = getSharedContext();
    await adapter.setMultiaddrs!([VALID_MULTIADDR, '/ip4/10.0.0.1/tcp/9090']);
    await adapter.setMultiaddrs!([VALID_MULTIADDR]);
    expect(await adapter.getMultiaddrs!(BigInt(coreProfileId))).toEqual([VALID_MULTIADDR]);
  });

  it('fast-fails too many entries before broadcast', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const tooMany = Array.from({ length: 9 }, (_, i) => `/ip4/10.0.0.${i}/tcp/9090`);
    await expect(adapter.setMultiaddrs!(tooMany)).rejects.toThrow(/too many/i);
  });

  it('fast-fails empty entries before broadcast', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    await expect(
      adapter.setMultiaddrs!([VALID_MULTIADDR, '']),
    ).rejects.toThrow(/empty/i);
  });

  it('fast-fails entries longer than 256 bytes before broadcast', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const tooLong = '/dns/' + 'x'.repeat(260);
    await expect(adapter.setMultiaddrs!([tooLong])).rejects.toThrow(/256/);
  });

  it('emits RelayCapabilityUpdated and MultiaddrsUpdated through listenForEvents', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { coreProfileId } = getSharedContext();
    const fromBlock = (await adapter.getBlockNumber!()) + 1;

    await adapter.setRelayCapable!(true);
    await adapter.setMultiaddrs!([VALID_MULTIADDR]);

    const seen: Array<{ type: string; identityId: string }> = [];
    for await (const e of adapter.listenForEvents({
      eventTypes: ['RelayCapabilityUpdated', 'MultiaddrsUpdated'],
      fromBlock,
    })) {
      seen.push({ type: e.type, identityId: String(e.data.identityId) });
    }

    expect(seen).toEqual([
      { type: 'RelayCapabilityUpdated', identityId: String(coreProfileId) },
      { type: 'MultiaddrsUpdated', identityId: String(coreProfileId) },
    ]);
  });
});
