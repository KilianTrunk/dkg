import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import type { OperationContext } from '@origintrail-official/dkg-core';

/**
 * Regression test for the SWM sub-graph blind spot in the sync responder.
 *
 * Pre-PR-X the workspace branch hardcoded the response to query
 * `contextGraphWorkspaceGraphUri(cgId)` / `...MetaGraphUri(cgId)`, both of
 * which alias the CG-root SWM URI:
 *   <cgPrefix>/_shared_memory
 *   <cgPrefix>/_shared_memory_meta
 *
 * Any publish that supplied a `subGraphName` lands in the per-sub-graph
 * variants instead:
 *   <cgPrefix>/<sub>/_shared_memory
 *   <cgPrefix>/<sub>/_shared_memory_meta
 *
 * The responder's static graph filter never saw those, so a sync requester
 * (e.g. a freshly approved late joiner running `runImmediatePostApprovalSync`
 * or any later `fetchSyncPages` round) received zero bytes of any sub-graph
 * SWM history. After PR-X the responder filters by URI shape under
 * `<cgPrefix>/`, so both root and sub-graph SWM flow through.
 *
 * See urn:dkg:finding:swm-gap-2-subgraph-blind-spot in the staking-ui-v10
 * decisions sub-graph for the full analysis.
 */

const CG_ID = 'devnet-test';
const CG_PREFIX = `did:dkg:context-graph:${CG_ID}`;
const ROOT_SWM = `${CG_PREFIX}/_shared_memory`;
const ROOT_SWM_META = `${CG_PREFIX}/_shared_memory_meta`;
const SUB_NAME = 'ai-tools';
const SUB_SWM = `${CG_PREFIX}/${SUB_NAME}/_shared_memory`;
const SUB_SWM_META = `${CG_PREFIX}/${SUB_NAME}/_shared_memory_meta`;
const OTHER_SUB = 'decisions';
const OTHER_SUB_SWM = `${CG_PREFIX}/${OTHER_SUB}/_shared_memory`;
const OTHER_SUB_SWM_META = `${CG_PREFIX}/${OTHER_SUB}/_shared_memory_meta`;

// A graph that lives at <cgPrefix>/<...>/_shared_memory_meta MUST NOT match
// the data-phase filter (STRENDS test on `_shared_memory` vs `_shared_memory_meta`
// is the structural guard). Conversely the meta-phase filter MUST match it.
// Per `validateSubGraphName` (dkg-core/constants.ts), sub-graph names cannot
// contain "/" and cannot start with "_", so there is no other URI shape that
// could land under `<cgPrefix>/.../_shared_memory[_meta]`.
const UNRELATED_DATA_GRAPH = `${CG_PREFIX}`;
const UNRELATED_DURABLE_META = `${CG_PREFIX}/_meta`;

const ROOT_ENTITY = 'urn:swm:root:r0';
const SUB_ROOT = 'urn:swm:root:s1';
const OTHER_SUB_ROOT = 'urn:swm:root:s2';
const SHARE_OP_ROOT = 'op-root-1';
const SHARE_OP_SUB = 'op-sub-1';
const SHARE_OP_OTHER_SUB = 'op-other-1';

const DKG_NS = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const REMOTE_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

const noopLog = (_ctx: OperationContext, _msg: string) => {};

function captureHandler(): {
  register: (proto: string, h: (data: Uint8Array, peerId: string) => Promise<Uint8Array>) => void;
  invoke: (envelope: SyncRequestEnvelope) => Promise<string>;
} {
  let captured: ((data: Uint8Array, peerId: string) => Promise<Uint8Array>) | null = null;
  return {
    register: (_proto, h) => {
      captured = h;
    },
    invoke: async (envelope) => {
      if (!captured) throw new Error('handler not registered');
      const bytes = new TextEncoder().encode(JSON.stringify(envelope));
      const out = await captured(bytes, REMOTE_PEER_ID);
      return new TextDecoder().decode(out);
    },
  };
}

function lineGraphsFromNquads(text: string): Set<string> {
  const graphs = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/<([^<>]+)>\s*\.\s*$/);
    if (m) graphs.add(m[1]);
  }
  return graphs;
}

function workspaceOpQuads(opId: string, rootEntity: string, metaGraph: string, publishedAt: string) {
  const subject = `urn:dkg:share:${CG_ID}:${opId}`;
  return [
    { graph: metaGraph, subject, predicate: RDF_TYPE, object: `${DKG_NS}WorkspaceOperation` },
    { graph: metaGraph, subject, predicate: `${DKG_NS}publishedAt`, object: `"${publishedAt}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` },
    { graph: metaGraph, subject, predicate: `${DKG_NS}rootEntity`, object: rootEntity },
    { graph: metaGraph, subject, predicate: `${DKG_NS}contextGraphId`, object: `"${CG_ID}"` },
    { graph: metaGraph, subject, predicate: `${DKG_NS}shareOperationId`, object: `"${opId}"` },
  ];
}

describe('sync responder workspace branch — sub-graph SWM coverage', () => {
  let store: OxigraphStore;
  let cap: ReturnType<typeof captureHandler>;

  beforeEach(async () => {
    store = new OxigraphStore();

    const NOW_ISO = '2026-06-01T00:00:00.000Z';

    await store.insert([
      // --- ROOT SWM ---
      // root-entity payload + a skolemized child (the FILTER in the TTL
      // branch widens past the root URI to genid descendants).
      { graph: ROOT_SWM, subject: ROOT_ENTITY, predicate: 'http://schema.org/name', object: '"root-payload"' },
      { graph: ROOT_SWM, subject: `${ROOT_ENTITY}/.well-known/genid/abc`, predicate: 'http://schema.org/value', object: '"root-child"' },
      ...workspaceOpQuads(SHARE_OP_ROOT, ROOT_ENTITY, ROOT_SWM_META, NOW_ISO),

      // --- SUB-GRAPH SWM (the gap target) ---
      { graph: SUB_SWM, subject: SUB_ROOT, predicate: 'http://schema.org/name', object: '"sub-ai-tools-payload"' },
      ...workspaceOpQuads(SHARE_OP_SUB, SUB_ROOT, SUB_SWM_META, NOW_ISO),

      // --- ANOTHER SUB-GRAPH (covers fan-out across multiple subs) ---
      { graph: OTHER_SUB_SWM, subject: OTHER_SUB_ROOT, predicate: 'http://schema.org/name', object: '"sub-decisions-payload"' },
      ...workspaceOpQuads(SHARE_OP_OTHER_SUB, OTHER_SUB_ROOT, OTHER_SUB_SWM_META, NOW_ISO),

      // --- NOISE: durable-tier graphs that share the CG prefix but are
      //     not SWM. The shape filter must exclude these from BOTH the
      //     workspace meta and data phases.
      { graph: UNRELATED_DATA_GRAPH, subject: 'urn:durable:1', predicate: `${DKG_NS}label`, object: '"durable"' },
      { graph: UNRELATED_DURABLE_META, subject: CG_PREFIX, predicate: `${DKG_NS}createdAt`, object: '"2026-05-10T00:00:00Z"' },
    ]);

    cap = captureHandler();
    registerSyncHandler({
      register: cap.register,
      protocolSync: '/origintrail/dkg/sync/1.0.0',
      syncDeniedResponse: 'sync-denied',
      syncPageSize: 5000,
      sharedMemoryTtlMs: 0,
      store,
      peerId: 'self-peer',
      parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
      authorizeSyncRequest: async () => true,
      logWarn: noopLog,
      logDebug: noopLog,
    });
  });

  describe('phase=data (no TTL)', () => {
    it('returns root SWM AND every sub-graph SWM in one response', async () => {
      const out = await cap.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'data',
      });

      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(ROOT_SWM)).toBe(true);
      expect(graphs.has(SUB_SWM)).toBe(true);
      expect(graphs.has(OTHER_SUB_SWM)).toBe(true);

      // Spot-check the actual payloads landed.
      expect(out).toContain('"root-payload"');
      expect(out).toContain('"sub-ai-tools-payload"');
      expect(out).toContain('"sub-decisions-payload"');
      expect(out).toContain('"root-child"');
    });

    it('does NOT return SWM meta graphs (those are the meta phase)', async () => {
      const out = await cap.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'data',
      });

      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(ROOT_SWM_META)).toBe(false);
      expect(graphs.has(SUB_SWM_META)).toBe(false);
      expect(graphs.has(OTHER_SUB_SWM_META)).toBe(false);
    });

    it('does NOT bleed durable-tier graphs into the workspace data response', async () => {
      const out = await cap.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'data',
      });

      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(UNRELATED_DATA_GRAPH)).toBe(false);
      expect(graphs.has(UNRELATED_DURABLE_META)).toBe(false);
      expect(out).not.toContain('"durable"');
    });
  });

  describe('phase=meta (no TTL)', () => {
    it('returns root SWM meta AND every sub-graph SWM meta', async () => {
      const out = await cap.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'meta',
      });

      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(ROOT_SWM_META)).toBe(true);
      expect(graphs.has(SUB_SWM_META)).toBe(true);
      expect(graphs.has(OTHER_SUB_SWM_META)).toBe(true);

      // Spot-check that each WorkspaceOperation rode along.
      expect(out).toContain(`urn:dkg:share:${CG_ID}:${SHARE_OP_ROOT}`);
      expect(out).toContain(`urn:dkg:share:${CG_ID}:${SHARE_OP_SUB}`);
      expect(out).toContain(`urn:dkg:share:${CG_ID}:${SHARE_OP_OTHER_SUB}`);
    });

    it('does NOT return SWM data graphs (those are the data phase)', async () => {
      const out = await cap.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'meta',
      });

      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(ROOT_SWM)).toBe(false);
      expect(graphs.has(SUB_SWM)).toBe(false);
      expect(graphs.has(OTHER_SUB_SWM)).toBe(false);
    });

    it('does NOT include the durable top-level _meta', async () => {
      const out = await cap.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'meta',
      });

      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(UNRELATED_DURABLE_META)).toBe(false);
    });
  });

  describe('phase=data (TTL on)', () => {
    let storeTtl: OxigraphStore;
    let capTtl: ReturnType<typeof captureHandler>;

    beforeEach(async () => {
      // Two ops per graph: one fresh (within cutoff), one stale (older
      // than cutoff). The TTL branch must keep the fresh root/sub
      // entities and drop the stale ones — even though the stale ones
      // physically still live in the store. Verifies both:
      //   (a) the (?gMeta = ?g + "_meta") binding correctly pairs the
      //       per-sub-graph op graph with its data graph, and
      //   (b) the ?ts >= cutoff filter is applied per sub-graph.
      storeTtl = new OxigraphStore();
      const FRESH_ISO = new Date(Date.now() - 1_000).toISOString();
      const STALE_ISO = new Date(Date.now() - 10_000).toISOString();

      await storeTtl.insert([
        // root: fresh entity (kept), stale entity (dropped)
        { graph: ROOT_SWM, subject: 'urn:swm:fresh:root', predicate: 'http://schema.org/n', object: '"fresh-root"' },
        { graph: ROOT_SWM, subject: 'urn:swm:stale:root', predicate: 'http://schema.org/n', object: '"stale-root"' },
        ...workspaceOpQuads('op-fresh-root', 'urn:swm:fresh:root', ROOT_SWM_META, FRESH_ISO),
        ...workspaceOpQuads('op-stale-root', 'urn:swm:stale:root', ROOT_SWM_META, STALE_ISO),

        // sub: fresh entity (kept), stale entity (dropped)
        { graph: SUB_SWM, subject: 'urn:swm:fresh:sub', predicate: 'http://schema.org/n', object: '"fresh-sub"' },
        { graph: SUB_SWM, subject: 'urn:swm:stale:sub', predicate: 'http://schema.org/n', object: '"stale-sub"' },
        ...workspaceOpQuads('op-fresh-sub', 'urn:swm:fresh:sub', SUB_SWM_META, FRESH_ISO),
        ...workspaceOpQuads('op-stale-sub', 'urn:swm:stale:sub', SUB_SWM_META, STALE_ISO),
      ]);

      capTtl = captureHandler();
      registerSyncHandler({
        register: capTtl.register,
        protocolSync: '/origintrail/dkg/sync/1.0.0',
        syncDeniedResponse: 'sync-denied',
        syncPageSize: 5000,
        sharedMemoryTtlMs: 5_000,
        store: storeTtl,
        peerId: 'self-peer',
        parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
        authorizeSyncRequest: async () => true,
        logWarn: noopLog,
        logDebug: noopLog,
      });
    });

    it('keeps fresh root + sub entities and drops stale ones, scoped by sub-graph', async () => {
      const out = await capTtl.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'data',
      });

      expect(out).toContain('"fresh-root"');
      expect(out).toContain('"fresh-sub"');
      expect(out).not.toContain('"stale-root"');
      expect(out).not.toContain('"stale-sub"');

      // Both sub-graph variants of `_shared_memory` MUST appear in the
      // graph-id position of the emitted nquads — the regression target.
      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(ROOT_SWM)).toBe(true);
      expect(graphs.has(SUB_SWM)).toBe(true);
    });
  });

  describe('graph URI is emitted per binding (not the static wsGraph alias)', () => {
    it('serializes each n-quad with the source graph URI, so a sub-graph entity lands back in the sub-graph on the requester', async () => {
      const out = await cap.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'data',
      });

      // Every line ending in <SUB_SWM> . MUST carry a sub-graph subject,
      // never a root subject (and vice versa). This guards against the
      // pre-fix bug where the responder serialized everything as
      // `<root_swm> .` regardless of where it came from.
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        if (line.endsWith(`<${SUB_SWM}> .`)) {
          expect(line).toContain(SUB_ROOT);
        }
        if (line.endsWith(`<${OTHER_SUB_SWM}> .`)) {
          expect(line).toContain(OTHER_SUB_ROOT);
        }
        if (line.endsWith(`<${ROOT_SWM}> .`)) {
          expect(line).toContain(ROOT_ENTITY);
        }
      }
    });
  });
});
