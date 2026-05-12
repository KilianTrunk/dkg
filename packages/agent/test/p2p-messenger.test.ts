import { describe, it, expect, vi } from 'vitest';
import { Messenger } from '../src/p2p/messenger.js';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import type { DiscoveryClient } from '../src/discovery.js';

// 12D3Koo... peer ids must be valid base58 to satisfy peerIdFromString. Two
// arbitrary valid ed25519 peer IDs taken from existing tests.
const PEER_A = '12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PEER_B = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const RELAY_ADDR = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

interface MockSetup {
  libp2pConnections: Array<unknown>;
  routerSendMock: ReturnType<typeof vi.fn>;
  peerStoreMergeMock: ReturnType<typeof vi.fn>;
  findAgentMock: ReturnType<typeof vi.fn>;
}

function makeMessenger(overrides: Partial<MockSetup> = {}): { messenger: Messenger; mocks: MockSetup; callOrder: string[] } {
  const callOrder: string[] = [];

  const mocks: MockSetup = {
    libp2pConnections: overrides.libp2pConnections ?? [],
    routerSendMock: overrides.routerSendMock ?? vi.fn(async () => {
      callOrder.push('router.send');
      return new Uint8Array([0x01, 0x02]);
    }),
    peerStoreMergeMock: overrides.peerStoreMergeMock ?? vi.fn(async () => {
      callOrder.push('peerStore.merge');
    }),
    findAgentMock: overrides.findAgentMock ?? vi.fn(async () => {
      callOrder.push('discovery.findAgentByPeerId');
      return { peerId: PEER_B, name: 'remote', agentUri: 'urn:agent:remote', relayAddress: RELAY_ADDR };
    }),
  };

  const messenger = new Messenger({
    libp2p: {
      getConnections: () => mocks.libp2pConnections,
      peerStore: { merge: mocks.peerStoreMergeMock },
    },
    router: { send: mocks.routerSendMock } as unknown as ProtocolRouter,
    discovery: { findAgentByPeerId: mocks.findAgentMock } as unknown as DiscoveryClient,
  });

  return { messenger, mocks, callOrder };
}

describe('Messenger.sendToPeer', () => {
  it('skips relay prime when peer is already connected', async () => {
    const { messenger, mocks } = makeMessenger({
      libp2pConnections: [{ remotePeer: { toString: () => PEER_B } }],
    });

    await messenger.sendToPeer(PEER_B, '/dkg/test/1.0.0', new Uint8Array([0xff]));

    expect(mocks.findAgentMock).not.toHaveBeenCalled();
    expect(mocks.peerStoreMergeMock).not.toHaveBeenCalled();
    expect(mocks.routerSendMock).toHaveBeenCalledOnce();
  });

  it('primes /p2p-circuit multiaddr when peer not connected and profile advertises a relay', async () => {
    const { messenger, mocks } = makeMessenger();

    await messenger.sendToPeer(PEER_B, '/dkg/test/1.0.0', new Uint8Array([0xff]));

    expect(mocks.findAgentMock).toHaveBeenCalledWith(PEER_B);
    expect(mocks.peerStoreMergeMock).toHaveBeenCalledOnce();
    const mergeCall = mocks.peerStoreMergeMock.mock.calls[0];
    const multiaddrs = (mergeCall[1] as { multiaddrs: Array<{ toString(): string }> }).multiaddrs;
    expect(multiaddrs[0].toString()).toContain('/p2p-circuit/p2p/' + PEER_B);
    expect(mocks.routerSendMock).toHaveBeenCalledOnce();
  });

  it('skips relay prime when discovery returns no relayAddress', async () => {
    const { messenger, mocks } = makeMessenger({
      findAgentMock: vi.fn(async () => ({ peerId: PEER_B, name: 'remote', agentUri: 'urn:agent:remote' })),
    });

    await messenger.sendToPeer(PEER_B, '/dkg/test/1.0.0', new Uint8Array([0xff]));

    expect(mocks.findAgentMock).toHaveBeenCalled();
    expect(mocks.peerStoreMergeMock).not.toHaveBeenCalled();
    expect(mocks.routerSendMock).toHaveBeenCalledOnce();
  });

  it('tolerates discovery throwing — proceeds to router.send anyway', async () => {
    const { messenger, mocks } = makeMessenger({
      findAgentMock: vi.fn(async () => { throw new Error('discovery boom'); }),
    });

    await messenger.sendToPeer(PEER_B, '/dkg/test/1.0.0', new Uint8Array([0xff]));

    expect(mocks.peerStoreMergeMock).not.toHaveBeenCalled();
    expect(mocks.routerSendMock).toHaveBeenCalledOnce();
  });

  it('regression: ensureCircuitRelayAddress fires BEFORE router.send (the Laptop B bug)', async () => {
    const { messenger, callOrder } = makeMessenger();

    await messenger.sendToPeer(PEER_B, '/dkg/test/1.0.0', new Uint8Array([0xff]));

    // The bug fixed by this primitive: forwardJoinRequest used to call
    // router.send directly without first priming the relay route, causing
    // "no reachable curator" failures for NAT'd peers. The fix is structural
    // — every send through Messenger primes first.
    const mergeIdx = callOrder.indexOf('peerStore.merge');
    const sendIdx = callOrder.indexOf('router.send');
    expect(mergeIdx).toBeGreaterThanOrEqual(0);
    expect(sendIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeLessThan(sendIdx);
  });

  it('forwards timeoutMs to router.send', async () => {
    const { messenger, mocks } = makeMessenger({
      libp2pConnections: [{ remotePeer: { toString: () => PEER_B } }],
    });

    await messenger.sendToPeer(PEER_A, '/dkg/test/1.0.0', new Uint8Array([0xff]), { timeoutMs: 5000 });

    expect(mocks.routerSendMock).toHaveBeenCalledWith(PEER_A, '/dkg/test/1.0.0', expect.any(Uint8Array), 5000);
  });
});
