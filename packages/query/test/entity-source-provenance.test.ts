/**
 * Addressed-read provenance contract (the `dkg_get_entity_sources` MCP tool
 * depends on this engine behaviour): a context-graph-scoped `GRAPH ?g` query
 * over a single entity binds each fact's source named graph and stays scoped
 * to the CG (no `_meta`/`_private`, no cross-context bleed).
 *
 * Crucially, a verifiable-memory read binds MORE than per-KA partitions — the
 * root content graph and per-collection `/context/{id}` graphs appear too, and
 * a fact can be materialised in both a per-KA partition AND the root. Only the
 * per-KA partition encodes a citable KA identity, so the TOOL (tested in
 * mcp-dkg) attributes facts to a KA only from those graphs; this test pins the
 * raw engine reality the tool must handle.
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
  it('binds per-KA, root and per-collection graphs; stays scoped; excludes _meta and other CGs', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const perKaA = 'did:dkg:context-graph:cg-one/_verifiable_memory/0xaa/1';
    const perKaB = 'did:dkg:context-graph:cg-one/_verifiable_memory/0xbb/2';
    await store.insert([
      // Entity X described by TWO different KAs in cg-one (multi-publisher).
      q(E, NAME, '"X-name"', perKaA),
      q(E, COLOR, '"X-color"', perKaB),
      // The SAME fact also materialised in the root content graph (read-both).
      q(E, NAME, '"X-name"', 'did:dkg:context-graph:cg-one'),
      // A fact only in the per-collection (chain-reconcile) graph.
      q(E, 'http://schema.org/shape', '"square"', 'did:dkg:context-graph:cg-one/context/7'),
      // A seal row about X in cg-one `_meta` — must NOT surface as a fact.
      q(E, 'http://dkg.io/ontology/authorAddress', '"0xAUTH"', 'did:dkg:context-graph:cg-one/_meta'),
      // The same entity in a DIFFERENT context graph — must NOT bleed in.
      q(E, NAME, '"X-OTHER-CG"', 'did:dkg:context-graph:cg-two/_verifiable_memory/0xcc/9'),
    ]);

    const r = await engine.query(
      `SELECT ?p ?o ?g WHERE { GRAPH ?g { <${E}> ?p ?o } }`,
      { contextGraphId: 'cg-one', view: 'verifiable-memory' },
    );
    const graphs = r.bindings.map((b) => b['g']);
    const objects = r.bindings.map((b) => b['o']);

    // Per-KA sources present, each on its own partition.
    expect(r.bindings.find((b) => b['o'] === '"X-color"')!['g']).toBe(perKaB);
    expect(graphs).toContain(perKaA);
    // Root + per-collection graphs ALSO bind (the reality the tool de-dups /
    // discloses): the root copy of X-name, and the per-collection-only fact.
    expect(graphs).toContain('did:dkg:context-graph:cg-one');
    expect(graphs).toContain('did:dkg:context-graph:cg-one/context/7');

    // Scoping invariants: no `_meta` seal value, no cross-context bleed.
    expect(objects).not.toContain('"0xAUTH"');
    expect(objects).not.toContain('"X-OTHER-CG"');
    expect(graphs.every((g) => g.startsWith('did:dkg:context-graph:cg-one'))).toBe(true);
    expect(graphs.some((g) => g.includes('_meta'))).toBe(false);
  });
});
