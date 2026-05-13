import { describe, it, expect, afterEach, vi } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { DKGNode } from '../src/node.js';
import {
  ProtocolRouter,
  PeerResolver,
  StubNetworkStateRegistry,
  LibP2PNetwork,
} from '../src/index.js';

/**
 * RFC 07 PR-3 — `ProtocolRouter.send` consults the resolver before
 * `dialProtocol`. The test verifies the structural property (resolver
 * is called once per send, with the correct peerId) using two real
 * libp2p nodes; resolution-order semantics are covered in
 * `peer-resolver.test.ts`.
 */
describe('ProtocolRouter.send + PeerResolver', () => {
  const nodes: DKGNode[] = [];

  afterEach(async () => {
    for (const n of nodes) await n.stop();
    nodes.length = 0;
  });

  function spawn(): DKGNode {
    const n = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    nodes.push(n);
    return n;
  }

  it('calls resolver.resolve(peerId) before dialing', async () => {
    const a = spawn();
    const b = spawn();
    await a.start();
    await b.start();
    await a.libp2p.dial(multiaddr(b.multiaddrs[0]));
    await new Promise((r) => setTimeout(r, 300));

    const resolveSpy = vi.fn(async () => []);
    const networkA = new LibP2PNetwork(a);
    const resolver = new PeerResolver({
      network: networkA,
      registry: new StubNetworkStateRegistry(),
      agentDirectory: { findRelayForPeer: async () => null },
    });
    // Replace resolve with the spy so we can observe call order.
    resolver.resolve = resolveSpy as unknown as typeof resolver.resolve;

    const routerA = new ProtocolRouter(a, { peerResolver: resolver });
    const routerB = new ProtocolRouter(b);

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    routerB.register('/test/resolver-integration/1.0.0', async (data) => {
      return enc.encode(`echo:${dec.decode(data)}`);
    });

    const response = await routerA.send(
      b.peerId,
      '/test/resolver-integration/1.0.0',
      enc.encode('hi'),
    );
    expect(dec.decode(response)).toBe('echo:hi');
    expect(resolveSpy).toHaveBeenCalledOnce();
    expect(resolveSpy).toHaveBeenCalledWith(b.peerId);
  }, 15000);

  it('resolver throwing does not block send (best-effort)', async () => {
    const a = spawn();
    const b = spawn();
    await a.start();
    await b.start();
    await a.libp2p.dial(multiaddr(b.multiaddrs[0]));
    await new Promise((r) => setTimeout(r, 300));

    const resolveSpy = vi.fn(async () => {
      throw new Error('resolver boom');
    });
    const resolver = new PeerResolver({
      network: new LibP2PNetwork(a),
      registry: new StubNetworkStateRegistry(),
      agentDirectory: { findRelayForPeer: async () => null },
    });
    resolver.resolve = resolveSpy as unknown as typeof resolver.resolve;

    const routerA = new ProtocolRouter(a, { peerResolver: resolver });
    const routerB = new ProtocolRouter(b);

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    routerB.register('/test/resolver-tolerant/1.0.0', async (data) => {
      return enc.encode(`ok:${dec.decode(data)}`);
    });

    const response = await routerA.send(
      b.peerId,
      '/test/resolver-tolerant/1.0.0',
      enc.encode('hi'),
    );
    expect(dec.decode(response)).toBe('ok:hi');
    expect(resolveSpy).toHaveBeenCalledOnce();
  }, 15000);

  it('omitting peerResolver preserves legacy behaviour (no consult, direct dial)', async () => {
    const a = spawn();
    const b = spawn();
    await a.start();
    await b.start();
    await a.libp2p.dial(multiaddr(b.multiaddrs[0]));
    await new Promise((r) => setTimeout(r, 300));

    const routerA = new ProtocolRouter(a);
    const routerB = new ProtocolRouter(b);

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    routerB.register('/test/no-resolver/1.0.0', async (data) => {
      return enc.encode(`echo:${dec.decode(data)}`);
    });

    const response = await routerA.send(
      b.peerId,
      '/test/no-resolver/1.0.0',
      enc.encode('hi'),
    );
    expect(dec.decode(response)).toBe('echo:hi');
  }, 15000);
});
