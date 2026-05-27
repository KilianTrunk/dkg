import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OxigraphStore } from '@origintrail-official/dkg-storage';

/**
 * Endpoint test for `POST /api/random-sampling/backfill-percgid-meta`.
 *
 * The endpoint reads the canonical `<cgName>/_meta` graph, picks the
 * per-KC subset (subjects with `dkg:batchId`, the KA UALs they
 * reference via `dkg:partOf`, and the publication URIs referenced via
 * `dkg:authoredBy`), and copies that subset into the per-cgId
 * `<cgName>/context/<cgId>/_meta` graph that the RS prover
 * (`kc-extractor.ts`) reads from.
 *
 * Pre-cd68fa689 publishers gossiped finalization without a
 * `targetContextGraphId`, so receivers settled the per-KC meta at
 * the legacy URI; nothing in the post-fix code path puts it where it
 * belongs in retrospect. This endpoint is the one-shot operator
 * rescue for that historical state.
 */

const { handleStatusRoutes } = await import('../src/daemon/routes/status.js');

type CGEntry = {
  name: string;
  onChainId: string;
  /** Pre-seed canonical meta with N per-KC entries. */
  kcEntries?: Array<{ ual: string; batchId: number; rootEntity: string; tokenId: number }>;
  /** Pre-seed an extra non-KC subject in the canonical meta so the
   *  endpoint's filter can be verified — should NOT be copied. */
  cgLifecycleSubject?: { subject: string; predicate: string; object: string };
};

function seedCanonicalMeta(store: OxigraphStore, cg: CGEntry): void {
  if (!cg.kcEntries) return;
  const metaGraph = `did:dkg:context-graph:${cg.name}/_meta`;
  const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];
  for (const kc of cg.kcEntries) {
    quads.push(
      { subject: kc.ual, predicate: 'http://dkg.io/ontology/batchId', object: `"${kc.batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: metaGraph },
      { subject: kc.ual, predicate: 'http://dkg.io/ontology/kaCount', object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: metaGraph },
      { subject: kc.ual, predicate: 'http://dkg.io/ontology/status', object: '"confirmed"', graph: metaGraph },
      // KA-level subject (resolved via partOf → KC has batchId).
      { subject: `${kc.ual}/${kc.tokenId}`, predicate: 'http://dkg.io/ontology/partOf', object: kc.ual, graph: metaGraph },
      { subject: `${kc.ual}/${kc.tokenId}`, predicate: 'http://dkg.io/ontology/rootEntity', object: kc.rootEntity, graph: metaGraph },
      { subject: `${kc.ual}/${kc.tokenId}`, predicate: 'http://dkg.io/ontology/tokenId', object: `"${kc.tokenId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: metaGraph },
    );
  }
  if (cg.cgLifecycleSubject) {
    quads.push({ ...cg.cgLifecycleSubject, graph: metaGraph });
  }
  void store.insert(quads);
}

function makeAgentMock(opts: { store: OxigraphStore; cgs: Array<{ name: string; onChainId?: string }> }) {
  const subscribed = new Map<string, { subscribed: boolean; synced: boolean; onChainId?: string }>();
  for (const c of opts.cgs) {
    subscribed.set(c.name, { subscribed: true, synced: true, onChainId: c.onChainId });
  }
  return {
    peerId: '12D3KooBackfillTest',
    multiaddrs: [],
    node: { libp2p: { getConnections: () => [] } },
    publisher: { getIdentityId: () => 0n },
    store: opts.store,
    getSubscribedContextGraphs: () => subscribed,
    // The endpoint doesn't call these but the ctx shape includes them
    // through unrelated routes — keep them noop-safe in case any
    // sibling guard touches them.
    getRandomSamplingStatus: () => ({ enabled: false, role: 'edge' }),
  };
}

function makeCtx(path: string, agent: ReturnType<typeof makeAgentMock>) {
  const url = new URL(path, 'http://127.0.0.1');
  return {
    agent,
    publisherControl: {},
    publisherRuntime: null,
    config: {
      name: 'backfill-test',
      nodeRole: 'core',
      chain: { type: 'evm', rpcUrl: 'https://test.example/rpc', hubAddress: '0x0000000000000000000000000000000000000001', chainId: 'hardhat:31337' },
    },
    startedAt: Date.now() - 1000,
    dashDb: {},
    opWallets: { wallets: [] },
    network: null,
    tracker: {},
    memoryManager: {},
    bridgeAuthToken: undefined,
    nodeVersion: 'test',
    nodeCommit: 'abc123',
    catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
    extractionRegistry: {},
    fileStore: {},
    extractionStatus: new Map(),
    assertionImportLocks: new Map(),
    vectorStore: {},
    embeddingProvider: null,
    validTokens: new Set(),
    apiHost: '127.0.0.1',
    apiPortRef: { value: 0 },
    url,
    path: url.pathname,
    requestToken: undefined,
    requestAgentAddress: 'did:dkg:agent:test',
    emitMemoryGraphChanged: () => {},
  };
}

async function countTriples(store: OxigraphStore, graphUri: string): Promise<number> {
  const r = await store.query(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`);
  if (r.type !== 'bindings') return 0;
  const raw = r.bindings[0]?.['n'] as string | undefined;
  if (!raw) return 0;
  const match = /^"(\d+)"/.exec(raw);
  return match ? Number(match[1]) : 0;
}

describe('POST /api/random-sampling/backfill-percgid-meta', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let store: OxigraphStore;
  let agent: ReturnType<typeof makeAgentMock>;

  beforeEach(async () => {
    store = new OxigraphStore();
    agent = makeAgentMock({ store, cgs: [] });
    server = createServer(async (req, res) => {
      const ctx = { ...makeCtx(req.url ?? '/', agent), req, res };
      try {
        await handleStatusRoutes(ctx as any);
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      } catch (err) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
      server = undefined;
    }
  });

  it('copies per-KC meta from <cg>/_meta to <cg>/context/<cgId>/_meta for an on-chain CG', async () => {
    const cgName = 'rs-backfill-happy';
    const onChainId = '42';
    seedCanonicalMeta(store, {
      name: cgName,
      onChainId,
      kcEntries: [
        { ual: 'did:dkg:base:84532/0xAAA/1000001', batchId: 7, rootEntity: 'urn:test:e1', tokenId: 1 },
        { ual: 'did:dkg:base:84532/0xAAA/2000001', batchId: 8, rootEntity: 'urn:test:e2', tokenId: 1 },
      ],
    });
    agent.getSubscribedContextGraphs = () => new Map([[cgName, { subscribed: true, synced: true, onChainId }]]);

    const before = await countTriples(store, `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`);
    expect(before).toBe(0);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.summary).toMatchObject({ backfilled: 1, alreadyPopulated: 0, failed: 0 });

    const after = await countTriples(store, `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`);
    // 2 KCs × (3 KC-level + 3 KA-level) = 12 triples.
    expect(after).toBe(12);
    expect(body.reports[0]).toMatchObject({
      contextGraphId: cgName,
      onChainId,
      status: 'backfilled',
      copiedTriples: 12,
    });
  });

  it('skips already-populated per-cgId meta graphs (idempotent)', async () => {
    const cgName = 'rs-backfill-idempotent';
    const onChainId = '99';
    seedCanonicalMeta(store, {
      name: cgName,
      onChainId,
      kcEntries: [{ ual: 'did:dkg:base:84532/0xBBB/3000001', batchId: 11, rootEntity: 'urn:test:e3', tokenId: 1 }],
    });
    // Pre-seed the per-cgId graph so the endpoint sees it as already done.
    await store.insert([
      { subject: 'did:dkg:base:84532/0xBBB/3000001', predicate: 'http://dkg.io/ontology/status', object: '"confirmed"', graph: `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta` },
    ]);
    agent.getSubscribedContextGraphs = () => new Map([[cgName, { subscribed: true, synced: true, onChainId }]]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.summary).toMatchObject({ backfilled: 0, alreadyPopulated: 1 });
    expect(body.reports[0]).toMatchObject({
      contextGraphId: cgName,
      status: 'already-populated',
      preExistingTargetTripleCount: 1,
    });
  });

  it('reports not-on-chain for subscribed CGs lacking onChainId', async () => {
    const cgName = 'rs-backfill-local-only';
    agent.getSubscribedContextGraphs = () => new Map([[cgName, { subscribed: true, synced: true }]]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.summary).toMatchObject({ backfilled: 0, notOnChain: 1 });
    expect(body.reports[0]).toMatchObject({ contextGraphId: cgName, status: 'not-on-chain' });
  });

  it('dry-run reports copy count without writing', async () => {
    const cgName = 'rs-backfill-dryrun';
    const onChainId = '17';
    seedCanonicalMeta(store, {
      name: cgName,
      onChainId,
      kcEntries: [{ ual: 'did:dkg:base:84532/0xCCC/4000001', batchId: 19, rootEntity: 'urn:test:e4', tokenId: 1 }],
    });
    agent.getSubscribedContextGraphs = () => new Map([[cgName, { subscribed: true, synced: true, onChainId }]]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.dryRun).toBe(true);
    expect(body.summary).toMatchObject({ backfilled: 1 });

    // Dry-run MUST NOT have written anything to the per-cgId graph.
    const after = await countTriples(store, `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`);
    expect(after).toBe(0);
  });

  it('filters out CG-lifecycle subjects (only copies KC/KA/publication URIs)', async () => {
    // Subjects without `dkg:batchId` (and not reached via `dkg:partOf`
    // or `dkg:authoredBy`) belong to CG-level metadata — accessPolicy,
    // createdAt on the cgEntity, allowlist members, etc. The publisher
    // doesn't promote them into per-cgId; neither should the backfill.
    const cgName = 'rs-backfill-filter';
    const onChainId = '23';
    seedCanonicalMeta(store, {
      name: cgName,
      onChainId,
      kcEntries: [{ ual: 'did:dkg:base:84532/0xDDD/5000001', batchId: 31, rootEntity: 'urn:test:e5', tokenId: 1 }],
      cgLifecycleSubject: {
        subject: `did:dkg:context-graph:${cgName}`,
        predicate: 'http://schema.org/dateCreated',
        object: '"2026-05-26T18:18:00Z"',
      },
    });
    agent.getSubscribedContextGraphs = () => new Map([[cgName, { subscribed: true, synced: true, onChainId }]]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.summary.backfilled).toBe(1);

    // The lifecycle subject should NOT have been copied.
    const target = `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`;
    const lifecycleProbe = await store.query(
      `ASK { GRAPH <${target}> { <did:dkg:context-graph:${cgName}> <http://schema.org/dateCreated> ?o } }`,
    );
    expect(lifecycleProbe.type).toBe('boolean');
    if (lifecycleProbe.type === 'boolean') expect(lifecycleProbe.value).toBe(false);

    // The KC subject SHOULD have been copied.
    const kcProbe = await store.query(
      `ASK { GRAPH <${target}> { <did:dkg:base:84532/0xDDD/5000001> <http://dkg.io/ontology/batchId> ?o } }`,
    );
    expect(kcProbe.type).toBe('boolean');
    if (kcProbe.type === 'boolean') expect(kcProbe.value).toBe(true);
  });

  it('restricts to specific CG names when contextGraphIds is provided', async () => {
    const cgA = 'rs-backfill-restrict-a';
    const cgB = 'rs-backfill-restrict-b';
    seedCanonicalMeta(store, { name: cgA, onChainId: '1', kcEntries: [{ ual: 'did:dkg:base:84532/0xEEE/6000001', batchId: 41, rootEntity: 'urn:e:a', tokenId: 1 }] });
    seedCanonicalMeta(store, { name: cgB, onChainId: '2', kcEntries: [{ ual: 'did:dkg:base:84532/0xFFF/7000001', batchId: 43, rootEntity: 'urn:e:b', tokenId: 1 }] });
    agent.getSubscribedContextGraphs = () => new Map([
      [cgA, { subscribed: true, synced: true, onChainId: '1' }],
      [cgB, { subscribed: true, synced: true, onChainId: '2' }],
    ]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextGraphIds: [cgA] }),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.processed).toBe(1);
    expect(body.reports[0].contextGraphId).toBe(cgA);

    const aCount = await countTriples(store, `did:dkg:context-graph:${cgA}/context/1/_meta`);
    const bCount = await countTriples(store, `did:dkg:context-graph:${cgB}/context/2/_meta`);
    expect(aCount).toBeGreaterThan(0);
    expect(bCount).toBe(0);
  });
});
