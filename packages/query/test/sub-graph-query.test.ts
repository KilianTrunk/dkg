import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const CG_ID = 'dkg-v10-dev';
const ROOT_GRAPH = `did:dkg:context-graph:${CG_ID}`;
const CODE_GRAPH = `did:dkg:context-graph:${CG_ID}/code`;
const DECISIONS_GRAPH = `did:dkg:context-graph:${CG_ID}/decisions`;

function q(s: string, p: string, o: string, g: string): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('sub-graph query scoping', () => {
  let store: OxigraphStore;
  let engine: DKGQueryEngine;

  beforeEach(async () => {
    store = new OxigraphStore();
    engine = new DKGQueryEngine(store);

    await store.insert([
      q('urn:fn:main', 'http://ex.org/type', '"Function"', ROOT_GRAPH),
      q('urn:fn:main', 'http://ex.org/name', '"main"', ROOT_GRAPH),

      q('urn:fn:parse', 'http://ex.org/type', '"Function"', CODE_GRAPH),
      q('urn:fn:parse', 'http://ex.org/signature', '"parse(input: string)"', CODE_GRAPH),

      q('urn:decision:1', 'http://ex.org/type', '"Decision"', DECISIONS_GRAPH),
      q('urn:decision:1', 'http://ex.org/title', '"Use TypeScript"', DECISIONS_GRAPH),
    ]);
  });

  it('queries root data graph without subGraphName', async () => {
    const result = await engine.query(
      'SELECT ?s ?name WHERE { ?s <http://ex.org/name> ?name }',
      { contextGraphId: CG_ID },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['name']).toBe('"main"');
  });

  it('queries code sub-graph with subGraphName', async () => {
    const result = await engine.query(
      'SELECT ?s ?sig WHERE { ?s <http://ex.org/signature> ?sig }',
      { contextGraphId: CG_ID, subGraphName: 'code' },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['sig']).toBe('"parse(input: string)"');
  });

  it('queries decisions sub-graph with subGraphName', async () => {
    const result = await engine.query(
      'SELECT ?s ?title WHERE { ?s <http://ex.org/title> ?title }',
      { contextGraphId: CG_ID, subGraphName: 'decisions' },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['title']).toBe('"Use TypeScript"');
  });

  it('sub-graph isolation: code query does not see decisions', async () => {
    const result = await engine.query(
      'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
      { contextGraphId: CG_ID, subGraphName: 'code' },
    );
    const subjects = result.bindings.map(b => b['s']);
    expect(subjects).toContain('urn:fn:parse');
    expect(subjects).not.toContain('urn:decision:1');
  });

  it('sub-graph isolation: decisions query does not see code', async () => {
    const result = await engine.query(
      'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
      { contextGraphId: CG_ID, subGraphName: 'decisions' },
    );
    const subjects = result.bindings.map(b => b['s']);
    expect(subjects).toContain('urn:decision:1');
    expect(subjects).not.toContain('urn:fn:parse');
  });

  it('empty sub-graph returns no results', async () => {
    const result = await engine.query(
      'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
      { contextGraphId: CG_ID, subGraphName: 'nonexistent' },
    );
    expect(result.bindings).toHaveLength(0);
  });

  // GH #184 / #675 — view-based routing now scopes to / includes sub-graphs.
  describe('GH #184 / #675 — sub-graph scoping under view-based routing', () => {
    const ADDR = '0x1111111111111111111111111111111111111111';
    const NAME = 'http://schema.org/name';
    const ROOT_ENTITY = 'https://example.org/root-entity';
    const SUB_ENTITY = 'https://example.org/subgraph-entity';
    const ROOT_WM = contextGraphLayerUri(CG_ID, MemoryLayer.WorkingMemory, ADDR, 1);
    const SUB_WM = contextGraphLayerUri(CG_ID, MemoryLayer.WorkingMemory, ADDR, 2, 'code');
    const META = `did:dkg:context-graph:${CG_ID}/_meta`;
    const SUBGRAPH_URN = `urn:dkg:subgraph:${CG_ID}:code`;

    beforeEach(async () => {
      await store.insert([
        { subject: ROOT_ENTITY, predicate: NAME, object: '"RootEntity"', graph: ROOT_WM },
        { subject: SUB_ENTITY, predicate: NAME, object: '"SubGraphEntity"', graph: SUB_WM },
        // Register the `code` sub-graph in `_meta` (the authoritative registry
        // the engine fans out over for #675).
        { subject: SUBGRAPH_URN, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: META },
        { subject: SUBGRAPH_URN, predicate: 'http://schema.org/name', object: '"code"', graph: META },
      ]);
    });

    it('#675: WM view (no subGraphName) includes BOTH root and sub-graph data', async () => {
      const result = await engine.query(
        `SELECT ?s ?o WHERE { ?s <${NAME}> ?o }`,
        { contextGraphId: CG_ID, view: 'working-memory', agentAddress: ADDR },
      );
      const subjects = result.bindings.map((b) => b['s']);
      expect(subjects).toContain(ROOT_ENTITY);
      expect(subjects).toContain(SUB_ENTITY);
    });

    it('#184: WM view + subGraphName scopes to the sub-graph (no throw)', async () => {
      const result = await engine.query(
        `SELECT ?s ?o WHERE { ?s <${NAME}> ?o }`,
        { contextGraphId: CG_ID, view: 'working-memory', agentAddress: ADDR, subGraphName: 'code' },
      );
      const subjects = result.bindings.map((b) => b['s']);
      expect(subjects).toContain(SUB_ENTITY);
      expect(subjects).not.toContain(ROOT_ENTITY);
    });
  });
});
