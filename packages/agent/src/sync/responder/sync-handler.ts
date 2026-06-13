import { createOperationContext, DKG_ONTOLOGY, MemoryLayer, type OperationContext } from '@origintrail-official/dkg-core';
import { contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { serializeWorkspacePublicSnapshotQuads, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import type { SyncRequestEnvelope } from '../auth/request-build.js';

interface RegisterSyncHandlerParams {
  /**
   * `register` callable. In production this is bound to the RAW
   * ProtocolRouter (via an adapter that re-exposes the string `peerId`),
   * NOT `Messenger.register`: sync runs outside the Universal Messenger
   * substrate as raw `/dkg/10.0.2/sync` so its large, never-reused page
   * responses are not cached in message_idempotency (the node-ui.db
   * bloat fix). The handler receives the bare payload — exactly the
   * auth envelope `parseSyncRequest` expects — and returns the response
   * bytes for the router to send.
   *
   * In tests this can be any callable matching the signature; the
   * caller doesn't need to provide a real ProtocolRouter or full
   * Messenger.
   */
  register: (
    protocolId: string,
    handler: (data: Uint8Array, peerId: string) => Promise<Uint8Array>,
  ) => void;
  protocolSync: string;
  syncDeniedResponse: string;
  syncPageSize: number;
  sharedMemoryTtlMs: number;
  store: TripleStore;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  peerId: string;
  parseSyncRequest: (data: Uint8Array) => SyncRequestEnvelope;
  authorizeSyncRequest: (request: SyncRequestEnvelope, remotePeerId: string) => Promise<boolean>;
  logWarn: (ctx: OperationContext, message: string) => void;
  logDebug: (ctx: OperationContext, message: string) => void;
}

export function registerSyncHandler(params: RegisterSyncHandlerParams): void {
  const {
    register,
    protocolSync,
    syncDeniedResponse,
    syncPageSize,
    sharedMemoryTtlMs,
    store,
    publicSnapshotStore,
    parseSyncRequest,
    authorizeSyncRequest,
    logWarn,
    logDebug,
  } = params;

  register(protocolSync, async (data, peerId) => {
    const handlerStartedAt = Date.now();
    const request = parseSyncRequest(data);
    const offset = Math.max(0, Math.min(Number.isSafeInteger(Number(request.offset)) ? Number(request.offset) : 0, 1_000_000));
    const limit = Math.max(1, Math.min(Number.isSafeInteger(Number(request.limit)) ? Number(request.limit) : syncPageSize, syncPageSize));
    const phase = request.phase ?? 'data';
    const isWorkspace = request.includeSharedMemory;
    const contextGraphId = request.contextGraphId;
    if (!contextGraphId || typeof contextGraphId !== 'string') {
      return new TextEncoder().encode('');
    }
    // Phase C — validate the optional delta hint into a non-negative bigint.
    // Anything malformed is ignored (full scan), never an error: the field is
    // an unsigned, best-effort optimization.
    let sinceBatchId: bigint | null = null;
    if (request.sinceBatchId != null && /^\d+$/.test(String(request.sinceBatchId))) {
      try { sinceBatchId = BigInt(String(request.sinceBatchId)); } catch { sinceBatchId = null; }
    }
    const nquads: string[] = [];

    const authStartedAt = Date.now();
    const authorized = await authorizeSyncRequest(request, peerId);
    const authDurationMs = Date.now() - authStartedAt;
    if (!authorized) {
      logWarn(createOperationContext('sync'), `Denied sync request for "${contextGraphId}" from peer ${peerId} (phase=${phase})`);
      return new TextEncoder().encode(syncDeniedResponse);
    }

    if (isWorkspace) {
      const cutoff = sharedMemoryTtlMs > 0 ? new Date(Date.now() - sharedMemoryTtlMs).toISOString() : null;
      // SWM lives at two URI shapes per CG (see `contextGraphSharedMemoryUri`
      // / `contextGraphSharedMemoryMetaUri` in dkg-core/constants.ts):
      //   <cgPrefix>/_shared_memory                  (root SWM)
      //   <cgPrefix>/<sub>/_shared_memory            (sub-graph SWM)
      //   <cgPrefix>/_shared_memory_meta             (root SWM meta)
      //   <cgPrefix>/<sub>/_shared_memory_meta       (sub-graph SWM meta)
      //
      // Pre-PR-X this branch only queried the root graphs (via
      // `contextGraphWorkspaceGraphUri`/`...MetaGraphUri`, which are
      // hardcoded aliases for the root). A sync requester therefore
      // received zero bytes of any sub-graph SWM the responder had
      // locally, so a late joiner who joined AFTER the curator had
      // published into a sub-graph could not backfill that history
      // through `PROTOCOL_SYNC` — see the SWM late-joiner backfill
      // gap (urn:dkg:finding:swm-gap-2-subgraph-blind-spot). Filter
      // by URI shape under the CG prefix and emit `?g` per binding so
      // the requester reconstructs the correct graph at write time.
      // Sub-graph names cannot contain `/` and cannot start with `_`
      // (`validateSubGraphName` in dkg-core/constants.ts), so the
      // segment between `<cgPrefix>/` and `/_shared_memory[_meta]` is
      // always a single path component when it represents a sub-graph.
      //
      // Codex review on #885 — URI shape alone is NOT a sufficient CG
      // boundary because `contextGraphId` itself permits `/` (wallet-
      // scoped IDs do, e.g. `0xabc/project`, and `validateContextGraphId`
      // accepts `/`). For a request on CG `cg-A`, the URI
      // `<cgPrefix>/child/_shared_memory` is structurally
      // indistinguishable from a sub-graph "child" of cg-A AND from the
      // root SWM of a different CG `cg-A/child` — even with a tightened
      // STRBEFORE/STRAFTER segment check that allows exactly one path
      // segment.
      //
      // Disambiguate by registration: the `<cgPrefix>/_meta` graph
      // carries the SubGraph registration triples (see
      // `DKGPublisher.isSubGraphRegistered` in dkg-publisher.ts:3828
      // and the auto-register in
      // `FinalizationHandler.ensureContextGraphAndSubGraph`,
      // finalization-handler.ts:540). Admit only the root SWM and the
      // SWM of registered sub-graphs of THIS CG.
      //
      // Codex review round 5: a parent sub-graph and a known child CG can
      // still collide on the exact same graph URI:
      //   parent sub-graph "code" => <parent>/code/_shared_memory
      //   child CG "parent/code"  => <parent>/code/_shared_memory
      // Match dkg-query-engine's scoped allowlist and reject registered
      // sub-graph candidates whose `<cgPrefix>/<name>` is also known as a
      // child context graph via its own `_meta` graph.
      const cgPrefix = `did:dkg:context-graph:${contextGraphId}`;
      const cgMetaGraph = `${cgPrefix}/_meta`;
      const rootSwm = `${cgPrefix}/_shared_memory`;
      const rootSwmMeta = `${cgPrefix}/_shared_memory_meta`;
      // Registered sub-graphs are identified by their schema:name
      // literal in `<cgPrefix>/_meta`. Reconstruct the canonical
      // SWM/SWM_meta URI from that name (matching
      // `contextGraphSharedMemoryUri` in dkg-core/constants.ts) so
      // sub-graph entities slated under arbitrary `<cgPrefix>/<name>/...`
      // shapes (e.g. assertion graphs) are not accidentally admitted.
      const registeredSubGraphSwmFilter = (forMeta: boolean) => {
        const suffix = forMeta ? '/_shared_memory_meta' : '/_shared_memory';
        return `EXISTS {
          GRAPH <${cgMetaGraph}> {
            ?sg <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/SubGraph> .
            ?sg <http://schema.org/name> ?subGraphName .
            FILTER(${forMeta ? `STR(?g) = CONCAT("${cgPrefix}/", STR(?subGraphName), "${suffix}")` : `(STRSTARTS(STR(?g), CONCAT("${cgPrefix}/", STR(?subGraphName), "${suffix}", "/")) || STR(?g) = CONCAT("${cgPrefix}/", STR(?subGraphName), "${suffix}"))`})
          }
          FILTER NOT EXISTS {
            GRAPH ?childMetaGraph {
              {
                ?childContextGraph <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://dkg.network/ontology#ContextGraph> .
              } UNION {
                ?childContextGraph <https://dkg.network/ontology#registrationStatus> ?childStatus .
              }
            }
            FILTER(STR(?childContextGraph) = CONCAT("${cgPrefix}/", STR(?subGraphName)))
            FILTER(STR(?childMetaGraph) = CONCAT(STR(?childContextGraph), "/_meta"))
          }
        }`;
      };

      if (phase === 'snapshot') {
        const snapshotRef = request.snapshotRef?.trim();
        if (!snapshotRef || !publicSnapshotStore) {
          return new TextEncoder().encode('');
        }
        const snapshot = await publicSnapshotStore.getSnapshot(snapshotRef);
        if (!snapshot) {
          return new TextEncoder().encode('');
        }
        const page = snapshot.slice(offset, offset + limit);
        if (page.length === 0) {
          return new TextEncoder().encode('');
        }
        nquads.push(serializeWorkspacePublicSnapshotQuads(page).trimEnd());
        logDebug(createOperationContext('sync'), `Sync responder SWM snapshot for "${contextGraphId}" ref=${snapshotRef}: auth=${authDurationMs}ms quads=${page.length}`);
      } else if (phase === 'meta') {
        // Codex review on #885 — admit only the root SWM_meta + the
        // SWM_meta of REGISTERED sub-graphs of this CG. Nested CGs
        // sharing the prefix have their registration in their own
        // `_meta`, not this CG's, so they are excluded.
        const metaBoundaryFilter = `STR(?g) = "${rootSwmMeta}" || ${registeredSubGraphSwmFilter(true)}`;
        const metaQuery = cutoff != null
          ? `SELECT ?s ?p ?o ?g WHERE {
              GRAPH ?g { ?s ?p ?o }
              FILTER(${metaBoundaryFilter})
              FILTER EXISTS {
                GRAPH ?g {
                  ?s <http://dkg.io/ontology/publishedAt> ?ts .
                  FILTER(?ts >= "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
                }
              }
            } ORDER BY ?g ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`
          : `SELECT ?s ?p ?o ?g WHERE {
              GRAPH ?g { ?s ?p ?o }
              FILTER(${metaBoundaryFilter})
            } ORDER BY ?g ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`;

        const queryStartedAt = Date.now();
        const metaResult = await store.query(metaQuery);
        const queryDurationMs = Date.now() - queryStartedAt;
        const serializeStartedAt = Date.now();
        if (metaResult.type === 'bindings') {
          for (const b of metaResult.bindings) {
            const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
            nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${b['g']}> .`);
          }
        }
        const serializeDurationMs = Date.now() - serializeStartedAt;
        logDebug(createOperationContext('sync'), `Sync responder SWM meta for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
      } else {
        // The TTL branch joins a WorkspaceOperation entry (in the
        // matching `_shared_memory_meta` graph) to its root entity
        // and skolemized children (in the same-prefix `_shared_memory`
        // graph). Bind the two graphs together by URI structure:
        //   STR(?gMeta) = CONCAT(STR(?g), "_meta")
        // so a publish into sub-graph "foo" pairs ops in
        // `<cgPrefix>/foo/_shared_memory_meta` with entities in
        // `<cgPrefix>/foo/_shared_memory` only — without bleeding into
        // a different sub-graph's ops or into root ops.
        // Codex review on #885 — admit only the root SWM + the SWM of
        // REGISTERED sub-graphs of this CG. The TTL branch still
        // pairs `?gMeta = ?g + "_meta"` to scope op→entity matching to
        // a single sub-graph; the registration check is what rejects
        // nested-CG SWM that shares the URI prefix.
        const dataBoundaryFilter = `(STRSTARTS(STR(?g), "${rootSwm}/") || STR(?g) = "${rootSwm}") || ${registeredSubGraphSwmFilter(false)}`;
        const wsQuery = cutoff != null
          ? `SELECT DISTINCT ?s ?p ?o ?g WHERE {
  GRAPH ?gMeta {
    ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> .
    ?op <http://dkg.io/ontology/publishedAt> ?ts .
    ?op <http://dkg.io/ontology/rootEntity> ?re .
    FILTER(?ts >= "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
  }
  GRAPH ?g { ?s ?p ?o }
  FILTER(
    (${dataBoundaryFilter}) &&
    STR(?gMeta) = CONCAT(STR(?g), "_meta")
  )
  FILTER(?s = ?re || STRSTARTS(STR(?s), CONCAT(STR(?re), "/.well-known/genid/")))
} ORDER BY ?g ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`
          : `SELECT ?s ?p ?o ?g WHERE {
              GRAPH ?g { ?s ?p ?o }
              FILTER(${dataBoundaryFilter})
            } ORDER BY ?g ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`;

        const queryStartedAt = Date.now();
        const wsResult = await store.query(wsQuery);
        const queryDurationMs = Date.now() - queryStartedAt;
        if (wsResult.type !== 'bindings' || wsResult.bindings.length === 0) {
          return new TextEncoder().encode('');
        }
        const serializeStartedAt = Date.now();
        for (const b of wsResult.bindings) {
          const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
          nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${b['g']}> .`);
        }
        const serializeDurationMs = Date.now() - serializeStartedAt;
        logDebug(createOperationContext('sync'), `Sync responder SWM data for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
      }

      if (nquads.length === 0) return new TextEncoder().encode('');
    } else {
      const dataGraph = contextGraphDataGraphUri(contextGraphId);
      const metaGraph = contextGraphMetaGraphUri(contextGraphId);

      if (phase === 'meta') {
        const DKG_NS = 'http://dkg.io/ontology/';
        const cgEntity = `did:dkg:context-graph:${contextGraphId}`;
        const queryStartedAt = Date.now();
        const metaResult = await store.query(
          `SELECT ?s ?p ?o WHERE {
            GRAPH <${metaGraph}> { ?s ?p ?o }
            FILTER(
              STR(?s) = "${cgEntity}" ||
              STRSTARTS(STR(?s), "did:dkg:activity:") ||
              STRSTARTS(STR(?s), "did:dkg:join-request:") ||
              EXISTS {
                GRAPH <${metaGraph}> {
                  ?lc <${DKG_NS}memoryLayer> ?layer .
                  FILTER(?layer != "${MemoryLayer.WorkingMemory}")
                  {
                    FILTER(?lc = ?s)
                  } UNION {
                    ?lc <${DKG_NS}assertionGraph> ?s .
                  } UNION {
                    ?lc <${DKG_NS}assertionName> ?aname .
                    FILTER(
                      CONTAINS(STR(?s), "/assertion/") &&
                      STRENDS(STR(?s), CONCAT("/", STR(?aname)))
                    )
                  }
                }
              } ||
              EXISTS {
                GRAPH <${metaGraph}> {
                  { ?evt_src <http://www.w3.org/ns/prov#generated> ?parent }
                  UNION
                  { ?evt_src <http://www.w3.org/ns/prov#used> ?parent }
                  FILTER(?evt_src = ?s)
                  ?parent <${DKG_NS}memoryLayer> ?elayer .
                  FILTER(?elayer != "${MemoryLayer.WorkingMemory}")
                }
              }
            )
          } ORDER BY ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`,
        );
        const queryDurationMs = Date.now() - queryStartedAt;
        const serializeStartedAt = Date.now();
        if (metaResult.type === 'bindings') {
          for (const b of metaResult.bindings) {
            const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
            nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${metaGraph}> .`);
          }
        }
        const serializeDurationMs = Date.now() - serializeStartedAt;
        logDebug(createOperationContext('sync'), `Sync responder durable meta for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
      } else {
        const cgUriPrefix = `did:dkg:context-graph:${contextGraphId}`;
        const innerMetaGraph = `${cgUriPrefix}/_meta`;
        const DKG_NS = 'http://dkg.io/ontology/';
        // Exclude only the TOP-LEVEL `${cgUriPrefix}/_meta` graph (handled by the
        // 'meta' phase above). Per-cgId meta graphs like
        // `${cgUriPrefix}/context/<cgId>/_meta` MUST be sent by the data phase —
        // they carry KC metadata (merkleRoot, batchId, tokenId, partOf,
        // publication, ...) that the RS prover's kc-extractor.ts queries to
        // resolve a challenge into a concrete chunk. The previous
        // `!STRENDS(?g, "/_meta")` filter dropped them on the floor, so
        // non-publisher peers received the per-cgId data but no per-cgId meta
        // and emitted `kc-not-synced` for every challenge they were assigned
        // against KCs they hadn't published themselves.
        // Phase C delta filter (narrowing-only). When the requester sends a
        // `sinceBatchId` high-water mark, drop DATA triples whose owning KC has
        // `dkg:batchId <= sinceBatchId`. Subjects with NO KA→KC→batchId mapping
        // (KC/KA meta rows, lifecycle, activity) are NEVER hidden — a delta can
        // only ever return a subset, so re-sending un-keyed rows is correct (and
        // keeps every responder's behavior a safe superset). Old responders that
        // predate this field simply ignore it and return the full scan.
        // Perf note: the EXISTS/NOT-EXISTS join only runs for delta requests,
        // which are by definition small; full scans skip it entirely.
        // Scope the KA→KC→batchId join to THIS context graph's meta graphs
        // only. Without it, any other CG on the node that happens to reuse the
        // same `rootEntity` IRI could satisfy the EXISTS/NOT-EXISTS checks and
        // wrongly include/exclude triples. CG meta graphs are `${cgUriPrefix}/…
        // /_meta` (top-level, per-cgId, and sub-graph); the trailing slash in
        // the prefix prevents `mfacts` from matching `mfacts-2`.
        const metaGraphScope = (g: string): string =>
          `FILTER(STRSTARTS(STR(${g}), "${cgUriPrefix}/") && STRENDS(STR(${g}), "/_meta"))`;
        // Bind ?bid<sfx> to the batchId of the KC owning subject ?s, tolerant of
        // the legacy shapes the rest of the agent also falls back on (see
        // `getBatchMerkleRoot` in dkg-agent.ts): the canonical placement on the
        // KC (`?kc dkg:batchId`) AND a legacy placement directly on the KA
        // (`?ka dkg:batchId`). Either typed (`"5"^^xsd:integer`) or untyped
        // (`"5"`) literals are accepted — the comparison below coerces via
        // xsd:integer(STR(...)) so an untyped literal isn't silently skipped by
        // a typed `>` comparison (which would resend stale rows or, in the
        // NOT-EXISTS arm, hide eligible ones).
        // Read-both (RFC ka-metadata-trim P3.1): the collapsed KA shape has
        // `dkg:rootEntity` + `dkg:batchId` directly on the UAL subject (no
        // `<ual>/<n>` + `dkg:partOf` token rows); legacy-shape rows still use
        // the token-row form. The third branch resolves collapsed rows; on
        // old-shape stores it ALSO matches (the aggregate UAL row carried
        // both predicates) — harmless inside EXISTS/NOT-EXISTS semantics.
        const batchIdOfSubject = (sfx: string): string => `
                GRAPH ?mg${sfx} {
                  ${metaGraphScope('?mg' + sfx)}
                  {
                    ?ka${sfx} <${DKG_NS}partOf> ?ual${sfx} ; <${DKG_NS}rootEntity> ?re${sfx} .
                    { ?ual${sfx} <${DKG_NS}batchId> ?bid${sfx} }
                    UNION
                    { ?ka${sfx} <${DKG_NS}batchId> ?bid${sfx} }
                  }
                  UNION
                  {
                    ?ualc${sfx} <${DKG_NS}rootEntity> ?re${sfx} ; <${DKG_NS}batchId> ?bid${sfx} .
                  }
                  FILTER(?re${sfx} = ?s || STRSTARTS(STR(?s), CONCAT(STR(?re${sfx}), "/.well-known/genid/")))
                }`;
        const deltaFilter = sinceBatchId != null
          ? `
            FILTER(
              NOT EXISTS {${batchIdOfSubject('Any')}
              }
              ||
              EXISTS {${batchIdOfSubject('New')}
                FILTER(<http://www.w3.org/2001/XMLSchema#integer>(STR(?bidNew)) > ${sinceBatchId.toString()})
              }
            )`
          : '';
        const queryStartedAt = Date.now();
        const dataResult = await store.query(
          `SELECT ?s ?p ?o ?g WHERE {
            GRAPH ?g { ?s ?p ?o }
            FILTER(
              (STR(?g) = "${cgUriPrefix}" || STRSTARTS(STR(?g), "${cgUriPrefix}/")) &&
              STR(?g) != "${innerMetaGraph}" &&
              !CONTAINS(STR(?g), "/_private")
            )
            FILTER(
              !CONTAINS(STR(?g), "/assertion/") ||
              EXISTS {
                GRAPH <${innerMetaGraph}> {
                  ?lifecycle <${DKG_NS}assertionGraph> ?g .
                  ?lifecycle <${DKG_NS}memoryLayer> ?layer .
                  FILTER(?layer != "${MemoryLayer.WorkingMemory}")
                }
              }
            )${deltaFilter}
          } ORDER BY ?g ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`,
        );
        const queryDurationMs = Date.now() - queryStartedAt;
        if (dataResult.type !== 'bindings' || dataResult.bindings.length === 0) {
          return new TextEncoder().encode('');
        }
        const serializeStartedAt = Date.now();
        for (const b of dataResult.bindings) {
          const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
          const graph = b['g'] ?? dataGraph;
          nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${graph}> .`);
        }
        const serializeDurationMs = Date.now() - serializeStartedAt;
        logDebug(createOperationContext('sync'), `Sync responder durable data for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
      }
    }

    const totalDurationMs = Date.now() - handlerStartedAt;
    if (totalDurationMs > 100) {
      logDebug(createOperationContext('sync'), `Sync responder total for "${contextGraphId}" (phase=${phase}, workspace=${isWorkspace}): ${totalDurationMs}ms`);
    }
    return new TextEncoder().encode(nquads.join('\n'));
  });
}
