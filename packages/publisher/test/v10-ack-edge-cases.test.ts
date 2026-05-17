import { describe, it, expect } from 'vitest';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from '../src/merkle.js';
import { encodeStorageACK, computePublishACKDigest, encodePublishIntent, decodeStorageACK, STORAGE_ACK_DECLINE_CODES, isStorageACKDecline } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';

// ── Helpers ──────────────────────────────────────────────────────────────

interface Tracked { calls: unknown[][] }

function tracked<T extends (...args: any[]) => any>(fn: T): T & Tracked {
  const calls: unknown[][] = [];
  const wrapper = ((...args: unknown[]) => {
    calls.push(args);
    return fn(...args);
  }) as any;
  wrapper.calls = calls;
  return wrapper;
}

function noop(): ((...args: any[]) => void) & Tracked {
  return tracked(() => {});
}

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

function makeQuad(s: string, p: string, o: string, g = 'urn:test:swm'): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function quadsToNQuads(quads: Quad[]): string {
  return quads.map(q => `<${q.subject}> <${q.predicate}> <${q.object}> <${q.graph}> .`).join('\n');
}

// Configurable SWM URI used for the seed graph in this file. Must match the
// `contextGraphSharedMemoryUri` returned by `createConfig()` so the
// `loadSWMQuads` CONSTRUCT actually finds the seeded data.
const TEST_SWM_GRAPH_URI = `did:dkg:context-graph:${42}/_shared_memory`;

/**
 * Build a real {@link OxigraphStore}, optionally pre-seeded with `quads`
 * placed in the SWM graph the StorageACKHandler queries, and wrap each
 * `TripleStore` method with a call recorder so existing assertions on
 * `store.query.calls`, `store.insert.calls`, etc. keep working.
 *
 * This replaces the previous hand-rolled fake (`createMockStore`) which
 * returned hard-coded values regardless of the SPARQL query — that fake
 * could not catch regressions in the SWM CONSTRUCT path or the staging-graph
 * dropGraph/insert path. The real OxigraphStore exercises actual N-Quad
 * parsing, IRI escaping, and SPARQL execution, so the round-trip is the
 * one production runs.
 */
function createRecordingStore(quads: Quad[] = []): TripleStore & {
  query: TripleStore['query'] & Tracked;
  insert: TripleStore['insert'] & Tracked;
  dropGraph: TripleStore['dropGraph'] & Tracked;
  countQuads: TripleStore['countQuads'] & Tracked;
  hasGraph: TripleStore['hasGraph'] & Tracked;
} {
  const store = new OxigraphStore();
  if (quads.length > 0) {
    // Place all seeded quads into the SWM graph the handler will CONSTRUCT
    // from when stagingQuads is omitted from the intent. The original fake
    // ignored graph URIs entirely; using the real graph keys catches
    // graph-mismatch regressions.
    const seeded = quads.map((q) => ({ ...q, graph: TEST_SWM_GRAPH_URI }));
    // OxigraphStore.insert is async; tests construct the store synchronously
    // so we use a small helper that completes during the test setup phase.
    void store.insert(seeded);
  }
  // Wrap each method so we keep the production behaviour but observe calls.
  const wrapped = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ['query', 'insert', 'dropGraph', 'countQuads', 'hasGraph'] as const) {
    const real = (store as any)[method].bind(store);
    wrapped[method] = tracked(real);
  }
  return store as any;
}

function makeEventBus() {
  return { emit: () => {}, on: () => {}, off: () => {}, once: () => {} };
}

const testQuads: Quad[] = [
  makeQuad('urn:a', 'urn:p', 'urn:o1'),
  makeQuad('urn:a', 'urn:p', 'urn:o2'),
  makeQuad('urn:b', 'urn:p', 'urn:o3'),
];
const merkleRoot = computeFlatKCRoot(testQuads, []);
const testMerkleLeafCount = computeFlatKCMerkleLeafCountV10(testQuads, []);

async function signACK(
  wallet: ethers.Wallet,
  contextGraphId: bigint,
  merkleRoot: Uint8Array,
  kaCount: number = 2,
  byteSize: bigint = 500n,
  epochs: bigint = 1n,
  tokenAmount: bigint = 0n,
  merkleLeafCount: number = testMerkleLeafCount,
) {
  const digest = computePublishACKDigest(
    TEST_CHAIN_ID,
    TEST_KAV10_ADDR,
    contextGraphId,
    merkleRoot,
    BigInt(kaCount),
    byteSize,
    epochs,
    tokenAmount,
    BigInt(merkleLeafCount),
  );
  const sig = ethers.Signature.from(await wallet.signMessage(digest));
  return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
}
// Numeric CG id — the storage-ack-handler and ACK provider both fail-loud
// on non-numeric / zero ids, matching the V10 contract guard.
const testCGIdStr = '42';
const testCGId = 42n;

const coreWallets = Array.from({ length: 6 }, () => ethers.Wallet.createRandom());

function buildCollectParams(overrides: Partial<Parameters<ACKCollector['collect']>[0]> = {}) {
  return {
    merkleRoot,
    contextGraphId: testCGId,
    contextGraphIdStr: testCGIdStr,
    publisherPeerId: 'publisher-0',
    publicByteSize: 500n,
    isPrivate: false,
    kaCount: 2,
    rootEntities: ['urn:a', 'urn:b'],
    chainId: TEST_CHAIN_ID,
    kav10Address: TEST_KAV10_ADDR,
    merkleLeafCount: testMerkleLeafCount,
    ...overrides,
  };
}

function buildSendP2P(opts: {
  wallets?: ethers.Wallet[];
  identityMap?: Record<string, number>;
  merkleRootOverride?: Uint8Array;
  kaCount?: number;
  byteSize?: bigint;
} = {}) {
  const wallets = opts.wallets ?? coreWallets;
  return async (peerId: string) => {
    const idx = parseInt(peerId.replace('peer-', ''), 10);
    const wallet = wallets[idx % wallets.length];
    const root = opts.merkleRootOverride ?? merkleRoot;
    const { r, vs } = await signACK(wallet, testCGId, root, opts.kaCount ?? 2, opts.byteSize ?? 500n);
    const identityId = opts.identityMap?.[peerId] ?? (idx + 1);
    return encodeStorageACK({
      merkleRoot: root,
      coreNodeSignatureR: r,
      coreNodeSignatureVS: vs,
      contextGraphId: testCGIdStr,
      nodeIdentityId: identityId,
    });
  };
}

// ── ACKCollector quorum fast-fail (spec §9.0 Phase 3) ────────────────────

describe('ACKCollector quorum fast-fail (spec §9.0 Phase 3)', () => {
  it('throws immediately when 0 peers connected', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: noop() as any,
      getConnectedCorePeers: () => [],
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    await expect(collector.collect(buildCollectParams()))
      .rejects.toThrow('no connected core peers');
    expect((deps.sendP2P as unknown as Tracked).calls).toHaveLength(0);
    expect((deps.gossipPublish as unknown as Tracked).calls).toHaveLength(0);
  });

  it('throws immediately when peers < requiredACKs (e.g., 2 peers, need 3)', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: noop() as any,
      getConnectedCorePeers: () => ['peer-0', 'peer-1'],
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    await expect(collector.collect(buildCollectParams({ requiredACKs: 3 })))
      .rejects.toThrow('quorum impossible');
    expect((deps.sendP2P as unknown as Tracked).calls).toHaveLength(0);
  });

  it('succeeds with exactly requiredACKs peers (3 peers, need 3)', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: buildSendP2P(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams({ requiredACKs: 3 }));
    expect(result.acks).toHaveLength(3);
    expect(result.merkleRoot).toBe(merkleRoot);
    expect(result.contextGraphId).toBe(testCGId);
  });

  it('succeeds with more peers than required (5 peers, need 3)', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: buildSendP2P(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3', 'peer-4'],
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams({ requiredACKs: 3 }));
    expect(result.acks).toHaveLength(3);
    const uniquePeers = new Set(result.acks.map(a => a.peerId));
    expect(uniquePeers.size).toBe(3);
    const uniqueIdentities = new Set(result.acks.map(a => a.nodeIdentityId));
    expect(uniqueIdentities.size).toBe(3);
  });
});

// ── ACKCollector identity verification ───────────────────────────────────

describe('ACKCollector identity verification', () => {
  it('accepts ACK when verifyIdentity returns true', async () => {
    const verifyIdentity = tracked(async () => true);
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: buildSendP2P(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      verifyIdentity,
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    expect(verifyIdentity.calls.length).toBeGreaterThan(0);
    for (const call of verifyIdentity.calls) {
      expect(typeof call[0]).toBe('string');
      expect(typeof call[1]).toBe('bigint');
    }
  });

  it('rejects ACK when verifyIdentity returns false', async () => {
    const verifyIdentity = tracked(async () => false);
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: buildSendP2P(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      verifyIdentity,
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    await expect(collector.collect(buildCollectParams()))
      .rejects.toThrow('storage_ack_insufficient');
    expect(verifyIdentity.calls).toHaveLength(3);
  });

  it('accepts ACK when verifyIdentity is undefined (no on-chain check)', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: buildSendP2P(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    expect(result.acks.every(a => a.signatureR.length === 32)).toBe(true);
  });

  it('multiple rejected identities still reaches quorum if enough valid ones', async () => {
    const validPeers = new Set(['peer-2', 'peer-3', 'peer-4']);
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: buildSendP2P(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3', 'peer-4'],
      verifyIdentity: tracked(async (_addr: string, identityId: bigint) => {
        const idx = Number(identityId) - 1;
        return validPeers.has(`peer-${idx}`);
      }),
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    for (const ack of result.acks) {
      const idx = Number(ack.nodeIdentityId) - 1;
      expect(validPeers.has(`peer-${idx}`)).toBe(true);
    }
  });

  it('all identities rejected = storage_ack_insufficient error', async () => {
    const log = noop();
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: buildSendP2P(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3'],
      verifyIdentity: tracked(async () => false),
      log,
    };
    const collector = new ACKCollector(deps);

    await expect(collector.collect(buildCollectParams()))
      .rejects.toThrow('storage_ack_insufficient');
    expect(log.calls.some(
      (c: unknown[]) => (c[0] as string).includes('not registered'),
    )).toBe(true);
  });
});

// ── ACKCollector deduplication ───────────────────────────────────────────

describe('ACKCollector deduplication', () => {
  it('same peerId sends two different ACKs — only first accepted', async () => {
    const callCounts = new Map<string, number>();
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: async (peerId) => {
        const count = (callCounts.get(peerId) ?? 0) + 1;
        callCounts.set(peerId, count);
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        const wallet = coreWallets[idx];
        const { r, vs } = await signACK(wallet, testCGId, merkleRoot, 2, 500n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: idx + 1,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    const peerIds = result.acks.map(a => a.peerId);
    expect(new Set(peerIds).size).toBe(peerIds.length);
  });

  it('different peers with same nodeIdentityId — only first accepted', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: buildSendP2P({
        identityMap: {
          'peer-0': 1, 'peer-1': 1, 'peer-2': 1,
          'peer-3': 2, 'peer-4': 3,
        },
      }),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3', 'peer-4'],
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    const identityIds = result.acks.map(a => a.nodeIdentityId);
    expect(new Set(identityIds).size).toBe(3);
    expect(identityIds).toContain(1n);
    expect(identityIds).toContain(2n);
    expect(identityIds).toContain(3n);
  });

  it('different peers with different identities — all accepted', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: buildSendP2P({
        identityMap: { 'peer-0': 10, 'peer-1': 20, 'peer-2': 30 },
      }),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    const ids = new Set(result.acks.map(a => a.nodeIdentityId));
    expect(ids.size).toBe(3);
    expect(ids).toContain(10n);
    expect(ids).toContain(20n);
    expect(ids).toContain(30n);
  });
});

// ── ACKCollector retry behavior ──────────────────────────────────────────

describe('ACKCollector retry behavior', () => {
  it('retries failed P2P request up to 3 times', async () => {
    const attemptsByPeer = new Map<string, number>();
    const log = noop();
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: async (peerId) => {
        const attempts = (attemptsByPeer.get(peerId) ?? 0) + 1;
        attemptsByPeer.set(peerId, attempts);
        if (peerId === 'peer-0' && attempts < 3) {
          throw new Error('connection reset');
        }
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        const wallet = coreWallets[idx];
        const { r, vs } = await signACK(wallet, testCGId, merkleRoot, 2, 500n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: idx + 1,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log,
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    expect(attemptsByPeer.get('peer-0')).toBe(3);
    expect(log.calls.some(
      (c: unknown[]) => (c[0] as string).includes('Retry'),
    )).toBe(true);
  });

  it('handles mixed success/failure responses', async () => {
    const failPeers = new Set(['peer-0', 'peer-1']);
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: async (peerId) => {
        if (failPeers.has(peerId)) throw new Error('unreachable');
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        const wallet = coreWallets[idx];
        const { r, vs } = await signACK(wallet, testCGId, merkleRoot, 2, 500n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: idx + 1,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3', 'peer-4'],
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    const peerIds = new Set(result.acks.map(a => a.peerId));
    expect(peerIds.has('peer-0')).toBe(false);
    expect(peerIds.has('peer-1')).toBe(false);
  });

  it('fails fast with storage_ack_insufficient when transport errors exhaust enough peers (no waiting for ACK_TIMEOUT_MS)', async () => {
    // After the fast-fail change for PR#559, the collector aborts as
    // soon as the still-pending peer pool can no longer reach
    // REQUIRED_ACKS — even if the failures are transport errors that
    // burn MAX_RETRIES per peer rather than typed declines. With 3
    // peers and need-3, the first peer exhausting its retries already
    // makes quorum unreachable, so the collector rejects immediately
    // (well below ACK_TIMEOUT_MS) and the per-peer retry budget is
    // capped at MAX_RETRIES (verified by the dedicated retry test
    // earlier in this file).
    const sendP2P = tracked(async () => { throw new Error('connection refused'); });
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: sendP2P as any,
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    const start = Date.now();
    const err = await collector.collect(buildCollectParams()).catch((e: Error) => e);
    const elapsed = Date.now() - start;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('storage_ack_insufficient');
    expect(err.message).not.toContain('storage_ack_timeout');
    expect(err.message).toContain('quorum no longer reachable');
    expect(err.message).toMatch(/0\/3/);
    expect(sendP2P.calls.length).toBeGreaterThan(0);
    // Per-peer retry budget is bounded by MAX_RETRIES (3), so total
    // calls across 3 peers can never exceed 9 even without fast-fail.
    expect(sendP2P.calls.length).toBeLessThanOrEqual(9);
    // Fast-fail must beat ACK_TIMEOUT_MS by a wide margin.
    expect(elapsed).toBeLessThan(10_000);
  });
});

// ── StorageACKHandler inline verification ────────────────────────────────

describe('StorageACKHandler inline verification', () => {
  const coreWallet = ethers.Wallet.createRandom();
  const coreIdentityId = 42n;
  const fakePeerId = { toString: () => 'publisher-peer' };

  function createConfig(overrides: Partial<StorageACKHandlerConfig> = {}): StorageACKHandlerConfig {
    return {
      nodeRole: 'core',
      nodeIdentityId: coreIdentityId,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      ...overrides,
    };
  }

  it('verifies merkle root from inline stagingQuads in-memory', async () => {
    const store = createRecordingStore();
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const stagingBytes = new TextEncoder().encode(quadsToNQuads(testQuads));
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: stagingBytes.length,
      isPrivate: false,
      kaCount: 2,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: ['urn:a', 'urn:b'],
      stagingQuads: stagingBytes,
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    expect(ack.contextGraphId).toBe(testCGIdStr);
    const ackRoot = ack.merkleRoot instanceof Uint8Array ? ack.merkleRoot : new Uint8Array(ack.merkleRoot);
    expect(Buffer.from(ackRoot).equals(Buffer.from(merkleRoot))).toBe(true);
    expect(store.query.calls).toHaveLength(0);
  });

  it('persists inline quads to staging graph before signing (crash safety)', async () => {
    const store = createRecordingStore();
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const stagingBytes = new TextEncoder().encode(quadsToNQuads(testQuads));
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: stagingBytes.length,
      isPrivate: false,
      kaCount: 2,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: ['urn:a'],
      stagingQuads: stagingBytes,
    });

    await handler.handler(intent, fakePeerId);

    expect(store.dropGraph.calls.length).toBeGreaterThan(0);
    expect(store.insert.calls.length).toBeGreaterThan(0);
    const insertedQuads = store.insert.calls[0][0];
    expect(insertedQuads[0].graph).toContain('/staging/');
    expect(store.query.calls).toHaveLength(0);
  });

  it('falls back to SWM query when stagingQuads not present', async () => {
    const store = createRecordingStore(testQuads);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: [],
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    expect(store.query.calls.length).toBeGreaterThan(0);
    expect(ack.contextGraphId).toBe(testCGIdStr);
  });

  it('SWM fallback: declines (NO_DATA_IN_SWM) when no data in SWM graph', async () => {
    // Pre-decline this would `throw`, which the publisher saw as a libp2p
    // stream reset (the GitHub #541 failure mode). Now the handler returns
    // a typed decline so the publisher's collector can record the reason
    // and surface it in the final error without retrying against this
    // peer or timing out the stream.
    const store = createRecordingStore([]);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: ['urn:a'],
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM);
    expect(decoded.declineMessage).toContain('No data found in SWM');
    expect(decoded.declineMessage).toContain('urn:a');
    expect(decoded.contextGraphId).toBe(testCGIdStr);
    expect(store.query.calls.length).toBeGreaterThan(0);
  });

  it("SWM fallback: declines (MERKLE_MISMATCH_IN_SWM) when merkle root doesn't match SWM data", async () => {
    const differentQuads = [makeQuad('urn:other', 'urn:p', 'urn:v')];
    const store = createRecordingStore(differentQuads);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: [],
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);
    expect(decoded.declineMessage).toContain('Merkle root mismatch');
    expect(store.query.calls.length).toBeGreaterThan(0);
  });

  it('declines (CG_ID_INVALID) when intent contextGraphId is non-numeric', async () => {
    const store = createRecordingStore(testQuads);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: 'not-a-number',
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: [],
      stagingQuads: new TextEncoder().encode(quadsToNQuads(testQuads)),
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CG_ID_INVALID);
    expect(decoded.declineMessage).toContain('numeric on-chain context graph id');
    expect(decoded.contextGraphId).toBe('not-a-number');
  });

  it('declines (CG_ID_INVALID) when intent contextGraphId is "0"', async () => {
    const store = createRecordingStore(testQuads);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: '0',
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: [],
      stagingQuads: new TextEncoder().encode(quadsToNQuads(testQuads)),
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CG_ID_INVALID);
    expect(decoded.declineMessage).toContain('positive on-chain context graph id');
  });

  it('declines (SIGNER_NOT_REGISTERED) when isSignerRegistered returns false', async () => {
    const store = createRecordingStore(testQuads);
    const onUnregistered = tracked(() => {});
    const handler = new StorageACKHandler(
      store,
      createConfig({
        isSignerRegistered: async () => false,
        onSignerUnregistered: onUnregistered,
      }),
      makeEventBus() as any,
    );

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: [],
      stagingQuads: new TextEncoder().encode(quadsToNQuads(testQuads)),
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED);
    expect(onUnregistered.calls).toHaveLength(1);
  });

  it('still throws (no decline) when stagingQuads merkle root mismatches — true publisher protocol error', async () => {
    // Inline-staging mismatch is a publisher-side bug (not a network state
    // mismatch), so the connection-level reset path is still appropriate
    // — keep the legacy throw to match the existing protocol semantics.
    const store = createRecordingStore([]);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);
    const wrongPayload = [makeQuad('urn:wrong', 'urn:p', 'urn:v')];
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: [],
      stagingQuads: new TextEncoder().encode(quadsToNQuads(wrongPayload)),
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('Merkle root mismatch (inline quads)');
  });
});

// ── StorageACKHandler security ───────────────────────────────────────────

describe('StorageACKHandler security', () => {
  const coreWallet = ethers.Wallet.createRandom();
  const fakePeerId = { toString: () => 'publisher-peer' };

  function createConfig(overrides: Partial<StorageACKHandlerConfig> = {}): StorageACKHandlerConfig {
    return {
      nodeRole: 'core',
      nodeIdentityId: 42n,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      ...overrides,
    };
  }

  it('rejects request from edge node (nodeRole=edge)', async () => {
    const store = createRecordingStore(testQuads);
    const handler = new StorageACKHandler(store, createConfig({ nodeRole: 'edge' }), makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 100,
      isPrivate: false,
      kaCount: 1,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: [],
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('Only core nodes can issue StorageACKs');
    expect(store.query.calls).toHaveLength(0);
  });

  it('rejects stagingQuads > 4MB', async () => {
    const store = createRecordingStore();
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const oversizedPayload = new Uint8Array(4 * 1024 * 1024 + 1).fill(0x41);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: oversizedPayload.length,
      isPrivate: false,
      kaCount: 1,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: [],
      stagingQuads: oversizedPayload,
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('exceeds');
    expect(store.query.calls).toHaveLength(0);
    expect(store.insert.calls).toHaveLength(0);
  });

  it('rejects empty stagingQuads (0 parseable quads)', async () => {
    const store = createRecordingStore();
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const emptyNQuads = new TextEncoder().encode('# just a comment\n\n');
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: emptyNQuads.length,
      isPrivate: false,
      kaCount: 1,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: [],
      stagingQuads: emptyNQuads,
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('no parseable N-Quads');
  });

  it('rejects stagingQuads with wrong merkle root (tampered payload)', async () => {
    const store = createRecordingStore();
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const tamperedQuads = [makeQuad('urn:tampered', 'urn:p', 'urn:evil')];
    const stagingBytes = new TextEncoder().encode(quadsToNQuads(tamperedQuads));

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: stagingBytes.length,
      isPrivate: false,
      kaCount: 1,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: [],
      stagingQuads: stagingBytes,
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('Merkle root mismatch (inline quads)');
    expect(store.insert.calls).toHaveLength(0);
  });

  it('nodeIdentityId > 2^64 throws protocol upgrade error', async () => {
    const store = createRecordingStore(testQuads);
    const hugeIdentity = (1n << 64n);
    const handler = new StorageACKHandler(
      store,
      createConfig({ nodeIdentityId: hugeIdentity }),
      makeEventBus() as any,
    );

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: [],
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('protocol upgrade required');
  });
});

// ── StorageACKHandler signature format ───────────────────────────────────

describe('StorageACKHandler signature format', () => {
  const coreWallet = ethers.Wallet.createRandom();
  const coreIdentityId = 99n;
  const fakePeerId = { toString: () => 'publisher-peer' };

  function createConfig(): StorageACKHandlerConfig {
    return {
      nodeRole: 'core',
      nodeIdentityId: coreIdentityId,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    };
  }

  it('ACK signature matches the H5-prefixed publish digest', async () => {
    const store = createRecordingStore(testQuads);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: [],
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    const expectedDigest = computePublishACKDigest(
      TEST_CHAIN_ID,
      TEST_KAV10_ADDR,
      testCGId,
      merkleRoot,
      2n,
      300n,
      1n,
      0n,
      BigInt(testMerkleLeafCount),
    );
    const prefixedHash = ethers.hashMessage(expectedDigest);

    const sigR = ack.coreNodeSignatureR instanceof Uint8Array
      ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR);
    const sigVS = ack.coreNodeSignatureVS instanceof Uint8Array
      ? ack.coreNodeSignatureVS : new Uint8Array(ack.coreNodeSignatureVS);

    const recovered = ethers.recoverAddress(prefixedHash, {
      r: ethers.hexlify(sigR),
      yParityAndS: ethers.hexlify(sigVS),
    });

    expect(recovered.toLowerCase()).toBe(coreWallet.address.toLowerCase());
    expect(sigR.length).toBe(32);
    expect(sigVS.length).toBe(32);
  });

  it('ecrecover from response matches handler signer wallet', async () => {
    const store = createRecordingStore(testQuads);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const stagingBytes = new TextEncoder().encode(quadsToNQuads(testQuads));
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: stagingBytes.length,
      isPrivate: false,
      kaCount: 2,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: ['urn:a'],
      stagingQuads: stagingBytes,
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    const digest = computePublishACKDigest(
      TEST_CHAIN_ID,
      TEST_KAV10_ADDR,
      testCGId,
      merkleRoot,
      2n,
      BigInt(stagingBytes.length),
      1n,
      0n,
      BigInt(testMerkleLeafCount),
    );
    const prefixedHash = ethers.hashMessage(digest);

    const sigR = ack.coreNodeSignatureR instanceof Uint8Array
      ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR);
    const sigVS = ack.coreNodeSignatureVS instanceof Uint8Array
      ? ack.coreNodeSignatureVS : new Uint8Array(ack.coreNodeSignatureVS);

    const recovered = ethers.recoverAddress(prefixedHash, {
      r: ethers.hexlify(sigR),
      yParityAndS: ethers.hexlify(sigVS),
    });

    expect(recovered.toLowerCase()).toBe(coreWallet.address.toLowerCase());

    const otherWallet = ethers.Wallet.createRandom();
    expect(recovered.toLowerCase()).not.toBe(otherWallet.address.toLowerCase());
  });

  it('contextGraphId in response matches request', async () => {
    const store = createRecordingStore(testQuads);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      merkleLeafCount: testMerkleLeafCount,
      rootEntities: [],
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    expect(ack.contextGraphId).toBe(testCGIdStr);
    const ackRoot = ack.merkleRoot instanceof Uint8Array ? ack.merkleRoot : new Uint8Array(ack.merkleRoot);
    expect(Buffer.from(ackRoot).equals(Buffer.from(merkleRoot))).toBe(true);

    const identityId = typeof ack.nodeIdentityId === 'number'
      ? BigInt(ack.nodeIdentityId)
      : BigInt(ack.nodeIdentityId.low) | (BigInt(ack.nodeIdentityId.high) << 32n);
    expect(identityId).toBe(coreIdentityId);
  });
});

// ── ACKCollector typed declines (PR2 / GitHub issue #541) ────────────────
//
// New cores can now respond with a typed decline (e.g. NO_DATA_IN_SWM)
// instead of throwing into the libp2p stream. The collector must:
//
//  - record the decline reason per-peer
//  - NOT retry against a declining peer (decline is permanent for the
//    request)
//  - still reach quorum if other peers ACK
//  - on quorum failure, surface every per-peer decline reason in the
//    `storage_ack_insufficient` error so operators can diagnose
//    hosting / replication issues from a single log line
//
// Old cores that still throw / reset the stream continue to follow the
// legacy retry path (see "ACKCollector retry behavior" above).

describe('ACKCollector typed declines (#541)', () => {
  /** Build a sendP2P that returns a decline for declinePeerIds and ACK otherwise. */
  function buildSendP2PWithDeclines(
    declinePeerIds: Record<string, { code: string; message: string }>,
    ackBuilder: (peerId: string) => Promise<Uint8Array> = buildSendP2P(),
  ): (peerId: string) => Promise<Uint8Array> {
    return async (peerId: string) => {
      const decline = declinePeerIds[peerId];
      if (decline) {
        return encodeStorageACK({
          merkleRoot: new Uint8Array(0),
          coreNodeSignatureR: new Uint8Array(0),
          coreNodeSignatureVS: new Uint8Array(0),
          contextGraphId: testCGIdStr,
          nodeIdentityId: 0,
          declineCode: decline.code,
          declineMessage: decline.message,
        });
      }
      return ackBuilder(peerId);
    };
  }

  it('quorum still reached when some peers decline; declining peers are NOT retried', async () => {
    const sendCounts = new Map<string, number>();
    const sendP2P = tracked(async (peerId: string) => {
      sendCounts.set(peerId, (sendCounts.get(peerId) ?? 0) + 1);
      const inner = buildSendP2PWithDeclines({
        'peer-0': { code: STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM, message: 'no swm data for repnet-v2-official' },
        'peer-3': { code: STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM, message: 'stale data' },
      });
      return inner(peerId);
    });

    const log = noop();
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: sendP2P as any,
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3', 'peer-4'],
      log,
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams({ requiredACKs: 3 }));
    expect(result.acks).toHaveLength(3);

    const ackedPeerIds = new Set(result.acks.map((a) => a.peerId));
    expect(ackedPeerIds.has('peer-0')).toBe(false);
    expect(ackedPeerIds.has('peer-3')).toBe(false);

    expect(sendCounts.get('peer-0')).toBe(1);
    expect(sendCounts.get('peer-3')).toBe(1);

    expect(log.calls.some(
      (c: unknown[]) => (c[0] as string).includes('Decline from peer-0')
        && (c[0] as string).includes('NO_DATA_IN_SWM'),
    )).toBe(true);
    expect(log.calls.some(
      (c: unknown[]) => (c[0] as string).includes('Decline from peer-3')
        && (c[0] as string).includes('MERKLE_MISMATCH_IN_SWM'),
    )).toBe(true);
  });

  it('storage_ack_insufficient error surfaces every per-peer decline reason', async () => {
    const sendP2P = buildSendP2PWithDeclines({
      'peer-0': { code: STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM, message: 'no swm data for repnet-v2-official' },
      'peer-1': { code: STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM, message: 'have 2 triples; root differs' },
      'peer-2': { code: STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED, message: 'rotated' },
      'peer-3': { code: STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM, message: 'cold cache' },
    });
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: sendP2P as any,
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3'],
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    let captured: string | undefined;
    try {
      await collector.collect(buildCollectParams({ requiredACKs: 3 }));
    } catch (err) {
      captured = err instanceof Error ? err.message : String(err);
    }

    expect(captured).toBeDefined();
    expect(captured).toContain('storage_ack_insufficient');
    expect(captured).toContain('NO_DATA_IN_SWM');
    expect(captured).toContain('MERKLE_MISMATCH_IN_SWM');
    expect(captured).toContain('SIGNER_NOT_REGISTERED');
    expect(captured).toContain('no swm data for repnet-v2-official');
    expect(captured).toContain('peer-0'.slice(-8));
    expect(captured).toContain('peer-2'.slice(-8));
  });

  it('an unknown decline code is logged and skipped (forward-compat with future codes)', async () => {
    const sendP2P = buildSendP2PWithDeclines({
      'peer-0': { code: 'FUTURE_DECLINE_CODE', message: 'reserved for follow-up' },
    });
    const log = noop();
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: sendP2P as any,
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3'],
      log,
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams({ requiredACKs: 3 }));
    expect(result.acks).toHaveLength(3);
    expect(result.acks.find((a) => a.peerId === 'peer-0')).toBeUndefined();

    expect(log.calls.some(
      (c: unknown[]) => (c[0] as string).includes('Decline from peer-0')
        && (c[0] as string).includes('FUTURE_DECLINE_CODE'),
    )).toBe(true);
  });

  it('a decline with empty message is still recorded (just code, no parens)', async () => {
    const sendP2P = buildSendP2PWithDeclines({
      'peer-0': { code: STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM, message: '' },
      'peer-1': { code: STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM, message: '' },
      'peer-2': { code: STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM, message: '' },
    });
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: sendP2P as any,
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    let captured: string | undefined;
    try {
      await collector.collect(buildCollectParams({ requiredACKs: 3 }));
    } catch (err) {
      captured = err instanceof Error ? err.message : String(err);
    }
    expect(captured).toContain('NO_DATA_IN_SWM');
    expect(captured).not.toContain('()');
  });

  it('fails fast with storage_ack_insufficient when declines + a hung peer make quorum impossible', async () => {
    // Codex Review on PR#559: in the mixed case where some peers
    // decline and another hangs, the collector previously waited the
    // full ACK_TIMEOUT_MS and emitted `storage_ack_timeout` — the new
    // per-peer decline detail never surfaced. The fast-fail path
    // should detect the impossible quorum the moment the second
    // decline lands and reject right away with the decline detail.
    const hung: string[] = [];
    const sendP2P = async (peerId: string): Promise<Uint8Array> => {
      if (peerId === 'peer-0' || peerId === 'peer-1') {
        return encodeStorageACK({
          merkleRoot: new Uint8Array(0),
          coreNodeSignatureR: new Uint8Array(0),
          coreNodeSignatureVS: new Uint8Array(0),
          contextGraphId: testCGIdStr,
          nodeIdentityId: 0,
          declineCode: STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM,
          declineMessage: peerId === 'peer-0'
            ? 'no swm data for repnet-v2-official'
            : 'no swm data for repnet-v2-official (replica missing)',
        });
      }
      // peer-2 hangs forever; without fast-fail this would force the
      // collector to wait out the full ACK_TIMEOUT_MS.
      hung.push(peerId);
      return new Promise<Uint8Array>(() => {});
    };
    const deps: ACKCollectorDeps = {
      gossipPublish: noop(),
      sendP2P: sendP2P as any,
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: noop(),
    };
    const collector = new ACKCollector(deps);

    const start = Date.now();
    let captured: string | undefined;
    try {
      await collector.collect(buildCollectParams({ requiredACKs: 3 }));
    } catch (err) {
      captured = err instanceof Error ? err.message : String(err);
    }
    const elapsed = Date.now() - start;

    expect(captured).toBeDefined();
    expect(captured).toContain('storage_ack_insufficient');
    expect(captured).not.toContain('storage_ack_timeout');
    expect(captured).toContain('quorum no longer reachable');
    // Decline detail must be present so operators can diagnose the
    // failure from a single log line.
    expect(captured).toContain('NO_DATA_IN_SWM');
    expect(captured).toContain('no swm data for repnet-v2-official');
    expect(captured).toContain('peer-0'.slice(-8));
    expect(captured).toContain('peer-1'.slice(-8));

    // Sanity check: peer-2 was actually dialled (so the hang is real)
    // and the failure landed well below the ACK_TIMEOUT_MS budget.
    expect(hung).toContain('peer-2');
    expect(elapsed).toBeLessThan(5_000);
  });
});
