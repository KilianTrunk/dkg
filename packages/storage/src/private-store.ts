import { assertSafeIri, escapeSparqlLiteral } from '@origintrail-official/dkg-core';
import type { TripleStore, Quad } from './triple-store.js';
import type { ContextGraphManager } from './graph-manager.js';

/**
 * Manages private (publisher-only) triples. These live in the same context
 * graph data graph as public triples, but are only stored on the publisher's
 * node. The meta graph records which KAs have private triples (via
 * privateMerkleRoot and privateTripleCount).
 */
export class PrivateContentStore {
  private readonly store: TripleStore;
  private readonly graphManager: ContextGraphManager;
  /** Tracks which rootEntities have private triples on this node. */
  private readonly privateEntities = new Map<string, Set<string>>();

  constructor(store: TripleStore, graphManager: ContextGraphManager) {
    this.store = store;
    this.graphManager = graphManager;
  }

  clearCache(key: string): void {
    this.privateEntities.delete(key);
  }

  private privateGraph(contextGraphId: string, subGraphName?: string): string {
    return subGraphName
      ? this.graphManager.subGraphPrivateUri(contextGraphId, subGraphName)
      : this.graphManager.privateGraphUri(contextGraphId);
  }

  private privateKey(contextGraphId: string, subGraphName?: string): string {
    return subGraphName ? `${contextGraphId}\0${subGraphName}` : contextGraphId;
  }

  async storePrivateTriples(
    contextGraphId: string,
    rootEntity: string,
    quads: Quad[],
    subGraphName?: string,
  ): Promise<void> {
    if (quads.length === 0) return;

    // Defence-in-depth (ST-7): reject unsafe IRIs at the entry point. The
    // other private-store operations (`getPrivateTriples`,
    // `hasPrivateTriplesInStore`, `deletePrivateTriples`) all route
    // `rootEntity` through `assertSafeIri` as they build SPARQL, so a
    // string like `did:dkg:agent:evil> <http://attacker/` that slipped in
    // here would land fine in the in-memory tracker and blow up only on
    // the first downstream query. Asserting at write time gives callers
    // an immediate, consistent error shape and keeps the tracker clean.
    assertSafeIri(rootEntity);

    const graphUri = this.privateGraph(contextGraphId, subGraphName);
    const normalized = quads.map((q) => ({ ...q, graph: graphUri }));
    await this.store.insert(normalized);

    const key = this.privateKey(contextGraphId, subGraphName);
    let entities = this.privateEntities.get(key);
    if (!entities) {
      entities = new Set();
      this.privateEntities.set(key, entities);
    }
    entities.add(rootEntity);
  }

  async storePrivateTriplesForOperation(
    contextGraphId: string,
    shareOperationId: string,
    rootEntity: string,
    quads: Quad[],
    subGraphName?: string,
  ): Promise<void> {
    await this.storePrivateTriples(contextGraphId, rootEntity, quads, subGraphName);

    const graphUri = this.privateGraph(contextGraphId, subGraphName);
    const subject = privateStageSubject(contextGraphId, shareOperationId, rootEntity, subGraphName);
    await this.store.deleteByPattern({ graph: graphUri, subject });
    await this.store.insert([{
      subject,
      predicate: 'http://dkg.io/ontology/privateStagedQuads',
      object: JSON.stringify(JSON.stringify(quads.map((q) => ({ ...q, graph: '' })))),
      graph: graphUri,
    }]);
  }

  async getPrivateTriplesForOperation(
    contextGraphId: string,
    shareOperationId: string,
    rootEntity: string,
    subGraphName?: string,
  ): Promise<Quad[]> {
    const graphUri = this.privateGraph(contextGraphId, subGraphName);
    const subject = privateStageSubject(contextGraphId, shareOperationId, rootEntity, subGraphName);
    const result = await this.store.query(
      `SELECT ?payload WHERE {
        GRAPH <${assertSafeIri(graphUri)}> {
          <${assertSafeIri(subject)}> <http://dkg.io/ontology/privateStagedQuads> ?payload .
        }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return [];
    const payload = parseLiteral(result.bindings[0]?.['payload']);
    if (typeof payload !== 'string') return [];
    const parsed = JSON.parse(payload) as Quad[];
    return parsed.map((q) => ({ ...q, graph: '' }));
  }

  async getPrivateTriples(
    contextGraphId: string,
    rootEntity: string,
    subGraphName?: string,
  ): Promise<Quad[]> {
    const graphUri = this.privateGraph(contextGraphId, subGraphName);
    const sparql = `
      SELECT ?s ?p ?o WHERE {
        GRAPH <${assertSafeIri(graphUri)}> {
          ?s ?p ?o .
          FILTER(
            ?s = <${assertSafeIri(rootEntity)}>
            || STRSTARTS(STR(?s), "${escapeSparqlLiteral(rootEntity)}/.well-known/genid/")
          )
        }
      }
    `;
    const result = await this.store.query(sparql);
    if (result.type !== 'bindings') return [];

    return result.bindings.map((row) => ({
      subject: row['s'],
      predicate: row['p'],
      object: row['o'],
      graph: graphUri,
    }));
  }

  hasPrivateTriples(contextGraphId: string, rootEntity: string, subGraphName?: string): boolean {
    const key = this.privateKey(contextGraphId, subGraphName);
    const entities = this.privateEntities.get(key);
    return entities?.has(rootEntity) ?? false;
  }

  /**
   * Checks the store directly for whether private triples exist.
   * Useful when the in-memory tracker hasn't been populated (e.g., on a
   * different instance than the one that originally stored the triples).
   */
  async hasPrivateTriplesInStore(
    contextGraphId: string,
    rootEntity: string,
    subGraphName?: string,
  ): Promise<boolean> {
    const quads = await this.getPrivateTriples(contextGraphId, rootEntity, subGraphName);
    return quads.length > 0;
  }

  async deletePrivateTriples(
    contextGraphId: string,
    rootEntity: string,
    subGraphName?: string,
  ): Promise<void> {
    const graphUri = this.privateGraph(contextGraphId, subGraphName);
    await this.store.deleteBySubjectPrefix(graphUri, rootEntity);
    const key = this.privateKey(contextGraphId, subGraphName);
    const entities = this.privateEntities.get(key);
    if (entities) entities.delete(rootEntity);
  }
}

function privateStageSubject(
  contextGraphId: string,
  shareOperationId: string,
  rootEntity: string,
  subGraphName?: string,
): string {
  const parts = [contextGraphId, subGraphName ?? '_', shareOperationId, rootEntity]
    .map((part) => encodeURIComponent(part));
  const subject = `urn:dkg:private-stage:${parts.join(':')}`;
  assertSafeIri(subject);
  return subject;
}

function parseLiteral(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
