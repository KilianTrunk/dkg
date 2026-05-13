import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PeerResolver,
  StubNetworkStateRegistry,
  type Network,
  type NetworkStateRegistry,
  type AgentDirectoryLookup,
  type Address,
  type NodeIdentity,
} from '../src/network/index.js';

const PEER_A = '12D3KooWA' + 'a'.repeat(43);
const PEER_B = '12D3KooWB' + 'b'.repeat(43);
const RELAY_ADDR =
  '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const BOOTSTRAP =
  '/dns4/seed.example.com/tcp/9090/p2p/12D3KooWSeedSeedSeedSeedSeedSeedSeedSeedSeedSeed';

interface MockNetwork extends Network {
  __conns: Map<NodeIdentity, Array<{ remoteAddr: { toString(): string } }>>;
  __addedAddresses: Array<{ peerId: NodeIdentity; addrs: Address[] }>;
  __findPeerImpl: ((peerId: NodeIdentity) => Promise<Address[]>) | null;
}

function makeNetwork(): MockNetwork {
  const conns = new Map<NodeIdentity, Array<{ remoteAddr: { toString(): string } }>>();
  const added: Array<{ peerId: NodeIdentity; addrs: Address[] }> = [];
  let findPeerImpl: ((peerId: NodeIdentity) => Promise<Address[]>) | null = null;
  const net: Partial<MockNetwork> = {
    localId: PEER_A,
    localAddresses: [],
    isStarted: true,
    async start() {},
    async stop() {},
    async dialProtocol() {
      throw new Error('not used in resolver tests');
    },
    async handle() {},
    async unhandle() {},
    getConnections(peerId: NodeIdentity) {
      return (conns.get(peerId) ?? []) as never;
    },
    async addKnownAddresses(peerId: NodeIdentity, addrs: Address[]) {
      added.push({ peerId, addrs });
    },
    async findPeer(peerId: NodeIdentity) {
      if (!findPeerImpl) throw new Error('findPeer not configured');
      return findPeerImpl(peerId);
    },
  };
  Object.defineProperty(net, '__conns', { value: conns, enumerable: false });
  Object.defineProperty(net, '__addedAddresses', { value: added, enumerable: false });
  Object.defineProperty(net, '__findPeerImpl', {
    get: () => findPeerImpl,
    set: (v) => {
      findPeerImpl = v;
    },
    enumerable: false,
  });
  return net as MockNetwork;
}

function makeAgentDir(
  fn?: (peerId: NodeIdentity) => Promise<Address | null>,
): AgentDirectoryLookup {
  return { findRelayForPeer: fn ?? (async () => null) };
}

describe('PeerResolver', () => {
  let net: MockNetwork;
  let registry: NetworkStateRegistry;

  beforeEach(() => {
    net = makeNetwork();
    registry = new StubNetworkStateRegistry();
  });

  it('step 1: returns live-conn remoteAddr and stops', async () => {
    net.__conns.set(PEER_B, [{ remoteAddr: { toString: () => '/ip4/10.0.0.1/tcp/9090' } }]);
    const findPeerSpy = vi.fn();
    net.__findPeerImpl = findPeerSpy;
    const dirSpy = vi.fn(async () => RELAY_ADDR);

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(dirSpy),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual(['/ip4/10.0.0.1/tcp/9090']);
    expect(findPeerSpy).not.toHaveBeenCalled();
    expect(dirSpy).not.toHaveBeenCalled();
    expect(net.__addedAddresses).toEqual([]);
  });

  it('step 2: walks DHT when no live conn, merges into peerStore', async () => {
    net.__findPeerImpl = async () => ['/ip4/1.2.3.4/tcp/9090'];

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toContain('/ip4/1.2.3.4/tcp/9090');
    expect(net.__addedAddresses).toContainEqual({
      peerId: PEER_B,
      addrs: ['/ip4/1.2.3.4/tcp/9090'],
    });
  });

  it('step 2: opts.skipDht bypasses findPeer entirely', async () => {
    const findPeerSpy = vi.fn();
    net.__findPeerImpl = findPeerSpy;

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(),
    });
    await resolver.resolve(PEER_B, { skipDht: true });

    expect(findPeerSpy).not.toHaveBeenCalled();
  });

  it('step 2: DHT failures are swallowed and resolution proceeds', async () => {
    net.__findPeerImpl = async () => {
      throw new Error('dht boom');
    };
    const dirSpy = vi.fn(async () => RELAY_ADDR);

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(dirSpy),
    });
    const out = await resolver.resolve(PEER_B);

    expect(dirSpy).toHaveBeenCalledWith(PEER_B);
    expect(out).toContain(`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`);
  });

  it('step 3: registry hits are appended after DHT', async () => {
    net.__findPeerImpl = async () => ['/ip4/1.2.3.4/tcp/9090'];
    const customRegistry: NetworkStateRegistry = {
      lookup: () => ['/ip4/5.6.7.8/tcp/9090'],
    };

    const resolver = new PeerResolver({
      network: net,
      registry: customRegistry,
      agentDirectory: makeAgentDir(),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual(['/ip4/1.2.3.4/tcp/9090', '/ip4/5.6.7.8/tcp/9090']);
  });

  it('step 4: agents-CG relay is wrapped as /p2p-circuit/p2p/<peerId>', async () => {
    net.__findPeerImpl = async () => [];
    const dirSpy = vi.fn(async () => RELAY_ADDR);

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(dirSpy),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual([`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`]);
    expect(net.__addedAddresses).toContainEqual({
      peerId: PEER_B,
      addrs: [`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`],
    });
  });

  it('step 4: agents-CG returning null is fine, falls through to bootstrap', async () => {
    net.__findPeerImpl = async () => [];
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(async () => null),
      bootstrapSeeds: [BOOTSTRAP],
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual([BOOTSTRAP]);
  });

  it('step 4: agents-CG throwing does not abort resolution', async () => {
    net.__findPeerImpl = async () => [];
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: {
        findRelayForPeer: async () => {
          throw new Error('sparql boom');
        },
      },
      bootstrapSeeds: [BOOTSTRAP],
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual([BOOTSTRAP]);
  });

  it('step 5: bootstrap seeds only used when previous steps produced nothing', async () => {
    net.__findPeerImpl = async () => ['/ip4/1.2.3.4/tcp/9090'];
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(),
      bootstrapSeeds: [BOOTSTRAP],
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual(['/ip4/1.2.3.4/tcp/9090']);
    expect(out).not.toContain(BOOTSTRAP);
  });

  it('returns empty array when nothing resolves and no seeds configured', async () => {
    net.__findPeerImpl = async () => [];
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual([]);
  });

  it('deduplicates addresses across steps', async () => {
    const dup = '/ip4/1.2.3.4/tcp/9090';
    net.__findPeerImpl = async () => [dup];
    const customRegistry: NetworkStateRegistry = {
      lookup: () => [dup, '/ip4/9.9.9.9/tcp/9090'],
    };

    const resolver = new PeerResolver({
      network: net,
      registry: customRegistry,
      agentDirectory: makeAgentDir(),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual([dup, '/ip4/9.9.9.9/tcp/9090']);
  });

  it('skips DHT step when network does not implement findPeer', async () => {
    const noRoutingNet = { ...net, findPeer: undefined } as Network;
    const resolver = new PeerResolver({
      network: noRoutingNet,
      registry,
      agentDirectory: makeAgentDir(async () => RELAY_ADDR),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual([`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`]);
  });

  it('recordDialFailure / isHealthy / recordDialSuccess are stubs that do not throw', () => {
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(),
    });
    expect(() => resolver.recordDialSuccess('/ip4/1.2.3.4/tcp/9090')).not.toThrow();
    expect(() => resolver.recordDialFailure('/ip4/1.2.3.4/tcp/9090', 'ETIMEDOUT')).not.toThrow();
    expect(resolver.isHealthy('/ip4/1.2.3.4/tcp/9090')).toBe(true);
  });
});
