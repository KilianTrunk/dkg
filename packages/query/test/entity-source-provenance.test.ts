/**
 * Addressed-read provenance contract (the `dkg_get_entity_sources` MCP tool
 * depends on this engine behaviour): a context-graph-scoped `GRAPH ?g` query
 * over a single entity binds each fact's source named graph, stays scoped to
 * the CG's content graphs, and excludes `_meta`/`_private` and other context
 * graphs. This is the property that makes addressed-read provenance sound
 * without rewriting arbitrary user SELECTs.
 *
 * Hermetic: in-memory OxigraphStore, zero mocks, zero chain.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const NAME = 'http://schema.org/name';
const COLOR = 'http://schema.org/color';
const E = 'https://example.org/entity/X';
function q(s: string, p: string, o: string, g: string) {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('addressed-read provenance — scoped GRAPH ?g over one entity', () => {
  it('binds each fact to its own KA partition; excludes _meta and other context graphs', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      // Entity X described by TWO different KAs in cg-one (multi-publisher).
      q(E, NAME, '"X-name"', 'did:dkg:context-graph:cg-one/_verifiable_memory/0xaa/1'),
      q(E, COLOR, '"X-color"', 'did:dkg:context-graph:cg-one/_verifiable_memory/0xbb/2'),
      // A seal row about X in cg-one `_meta` — must NOT surface as a fact.
      q(E, 'http://dkg.io/ontology/authorAddress', '"0xAUTH"', 'did:dkg:context-graph:cg-one/_meta'),
      // The same entity in a DIFFERENT context graph — must NOT bleed in.
      q(E, NAME, '"X-OTHER-CG"', 'did:dkg:context-graph:cg-two/_verifiable_memory/0xcc/9'),
    ]);

    const r = await engine.query(
      `SELECT ?p ?o ?g WHERE { GRAPH ?g { <${E}> ?p ?o } }`,
      { contextGraphId: 'cg-one', view: 'verifiable-memory' },
    );

    const objects = r.bindings.map((b) => b['o']);
    const graphs = r.bindings.map((b) => b['g']);

    // Both content facts present, each tagged with its own KA partition.
    expect(objects).toEqual(expect.arrayContaining(['"X-name"', '"X-color"']));
    const nameRow = r.bindings.find((b) => b['o'] === '"X-name"')!;
    const colorRow = r.bindings.find((b) => b['o'] === '"X-color"')!;
    expect(nameRow['g']).toBe('did:dkg:context-graph:cg-one/_verifiable_memory/0xaa/1');
    expect(colorRow['g']).toBe('did:dkg:context-graph:cg-one/_verifiable_memory/0xbb/2');

    // The `_meta` seal value is not a fact; no cross-context bleed.
    expect(objects).not.toContain('"0xAUTH"');
    expect(objects).not.toContain('"X-OTHER-CG"');
    expect(graphs.every((g) => g.startsWith('did:dkg:context-graph:cg-one/'))).toBe(true);
    expect(graphs.some((g) => g.includes('_meta'))).toBe(false);
  });
});
