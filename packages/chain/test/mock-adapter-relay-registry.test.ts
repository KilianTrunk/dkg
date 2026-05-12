/**
 * MockChainAdapter — Network Relay Registry surface (RFC 04 / Issue #461).
 *
 * Covers the four chain-adapter methods edges and core nodes exercise
 * for the on-chain side of the relay registry:
 *  - getRelayCapable(identityId)
 *  - getMultiaddrs(identityId)
 *  - setRelayCapable(relayCapable)
 *  - setMultiaddrs(multiaddrs)
 *
 * Plus the new event surface:
 *  - RelayCapabilityUpdated
 *  - MultiaddrsUpdated
 *
 * Bound checks (length / per-entry size) mirror the on-chain
 * Profile.sol guard so adapter-parity tests catch a drift on either
 * side. Same constants in evm-adapter.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MockChainAdapter } from '../src/mock-adapter.js';

const VALID_MULTIADDR =
  '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

describe('MockChainAdapter — relay registry reads', () => {
  it('returns false / empty for an identity that never opted in', async () => {
    const adapter = new MockChainAdapter();
    expect(await adapter.getRelayCapable(42n)).toBe(false);
    expect(await adapter.getMultiaddrs(42n)).toEqual([]);
  });
});

describe('MockChainAdapter — setRelayCapable / setMultiaddrs', () => {
  let adapter: MockChainAdapter;

  beforeEach(async () => {
    adapter = new MockChainAdapter();
    await adapter.ensureProfile();
  });

  it('flips relayCapable and surfaces it via getRelayCapable', async () => {
    expect(await adapter.getRelayCapable(1n)).toBe(false);
    const tx = await adapter.setRelayCapable!(true);
    expect(tx.success).toBe(true);
    expect(await adapter.getRelayCapable(1n)).toBe(true);
  });

  it('publishes multiaddrs and surfaces them via getMultiaddrs', async () => {
    const addrs = [VALID_MULTIADDR, '/dns/relay.example.com/tcp/443/wss/p2p/12D3KooWAbcDef'];
    const tx = await adapter.setMultiaddrs!(addrs);
    expect(tx.success).toBe(true);
    expect(await adapter.getMultiaddrs(1n)).toEqual(addrs);
  });

  it('setMultiaddrs is wholesale-replacement, not append', async () => {
    await adapter.setMultiaddrs!([VALID_MULTIADDR, '/ip4/10.0.0.1/tcp/9090']);
    await adapter.setMultiaddrs!([VALID_MULTIADDR]);
    expect(await adapter.getMultiaddrs(1n)).toEqual([VALID_MULTIADDR]);
  });

  it('throws when no profile is registered', async () => {
    const fresh = new MockChainAdapter();
    await expect(fresh.setRelayCapable!(true)).rejects.toThrow(/no profile/);
    await expect(fresh.setMultiaddrs!([VALID_MULTIADDR])).rejects.toThrow(/no profile/);
  });

  it('rejects more than 8 multiaddrs (matches on-chain MAX_MULTIADDRS)', async () => {
    const tooMany = Array.from({ length: 9 }, (_, i) => `/ip4/10.0.0.${i}/tcp/9090`);
    await expect(adapter.setMultiaddrs!(tooMany)).rejects.toThrow(/too many/i);
  });

  it('rejects empty entries', async () => {
    await expect(
      adapter.setMultiaddrs!([VALID_MULTIADDR, '']),
    ).rejects.toThrow(/empty/i);
  });

  it('rejects entries longer than 256 bytes (matches on-chain MAX_MULTIADDR_LENGTH)', async () => {
    const tooLong = '/dns/' + 'x'.repeat(260);
    await expect(adapter.setMultiaddrs!([tooLong])).rejects.toThrow(/256/);
  });
});

describe('MockChainAdapter — relay registry events surface', () => {
  it('emits RelayCapabilityUpdated and MultiaddrsUpdated through listenForEvents', async () => {
    const adapter = new MockChainAdapter();
    await adapter.ensureProfile();

    await adapter.setRelayCapable!(true);
    await adapter.setMultiaddrs!([VALID_MULTIADDR]);

    const events: { type: string; data: Record<string, unknown> }[] = [];
    for await (const e of adapter.listenForEvents({
      eventTypes: ['RelayCapabilityUpdated', 'MultiaddrsUpdated'],
      fromBlock: 0,
    })) {
      events.push({ type: e.type, data: e.data });
    }

    expect(events).toEqual([
      {
        type: 'RelayCapabilityUpdated',
        data: { identityId: '1', oldValue: false, newValue: true },
      },
      {
        type: 'MultiaddrsUpdated',
        data: { identityId: '1', multiaddrs: [VALID_MULTIADDR] },
      },
    ]);
  });
});
