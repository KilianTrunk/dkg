import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphPrivateUri,
  contextGraphSubGraphPrivateUri,
  contextGraphSubGraphUri,
} from '@origintrail-official/dkg-core';
import { DKGQueryEngine, ScopedQueryViolationError } from '../src/dkg-query-engine.js';

// ───────────────────────────────────────────────────────────────────────────
// Regression: EPCIS events API "Scoped query violation" on every node.
//
// Two recent rc.12 changes collided:
//   * the EPCIS query-builder always references the context graph's
//     `<cg>/_private` partition (to surface private-anchored events), and
//   * the query engine's scope guard (`assertExplicitGraphIrisAllowed`) never
//     listed `/_private` in the allow-set for a `contextGraphId`-scoped query.
//
// Result: GET /api/epcis/events failed with
//   "Scoped query violation: GRAPH <…/_private> is outside the allowed graph set"
// on BOTH Oxigraph and Blazegraph nodes (it lives in the engine, not the
// store), and CI never caught it because the EPCIS e2e test skips without a
// live node and the handler unit test mocks the engine.
//
// The fix adds an opt-in `includePrivate` query option: only callers that set
// it (the EPCIS events handler) get the queried CG's own `_private` partition
// added to the allow-set. These tests exercise the REAL engine over an
// in-process store — no mocks, no live node — so they run in the normal CI
// `query` lane and lock the behaviour in permanently.
// ───────────────────────────────────────────────────────────────────────────

const CG = 'epcis-private-regression';
const OTHER_CG = 'some-other-cg';
const SUB = 'shipments';

const DATA_GRAPH = contextGraphDataUri(CG);
const META_GRAPH = contextGraphMetaUri(CG);
const PRIVATE_GRAPH = contextGraphPrivateUri(CG);
const OTHER_PRIVATE_GRAPH = contextGraphPrivateUri(OTHER_CG);
const SUB_DATA_GRAPH = contextGraphSubGraphUri(CG, SUB);
const SUB_PRIVATE_GRAPH = contextGraphSubGraphPrivateUri(CG, SUB);

const EVENT_TYPE = 'https://gs1.github.io/EPCIS/ObjectEvent';
const PUBLIC_EVENT = 'urn:uuid:public-event-1';
const PRIVATE_EVENT = 'urn:uuid:private-event-1';

function q(s: string, p: string, o: string, g: string): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('DKGQueryEngine — `_private` graph scope guard (#789 follow-up: EPCIS events)', () => {
  let store: OxigraphStore;
  let engine: DKGQueryEngine;

  beforeEach(async () => {
    store = new OxigraphStore();
    engine = new DKGQueryEngine(store);

    await store.insert([
      // Fully public event — body lives in the CG data graph.
      q(PUBLIC_EVENT, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `<${EVENT_TYPE}>`, DATA_GRAPH),
      // Private event — the data graph holds only the public anchor; the event
      // body lives in the CG's `_private` partition under the SAME subject URI
      // (this is how the publisher splits a private-anchored event).
      q(PRIVATE_EVENT, 'http://dkg.io/ontology/privateDataAnchor', '"true"', DATA_GRAPH),
      q(PRIVATE_EVENT, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `<${EVENT_TYPE}>`, PRIVATE_GRAPH),
      q(PRIVATE_EVENT, 'http://example.org/secret', '"classified"', PRIVATE_GRAPH),
      // Sub-graph private partition (sub-graph scoped variant).
      q(`${PRIVATE_EVENT}/sub`, 'http://example.org/secret', '"sub-classified"', SUB_PRIVATE_GRAPH),
      q(`${PUBLIC_EVENT}/sub`, 'http://example.org/k', '"v"', SUB_DATA_GRAPH),
      // Another CG's private partition — must NEVER be reachable from CG.
      q('urn:uuid:foreign', 'http://example.org/secret', '"leak"', OTHER_PRIVATE_GRAPH),
    ]);
  });

  const privateOnlyQuery = `SELECT ?s ?p ?o WHERE {
    GRAPH <${PRIVATE_GRAPH}> { ?s ?p ?o }
  }`;

  it('THE BUG: a CG-scoped query that names <cg>/_private is rejected by default', async () => {
    await expect(
      engine.query(privateOnlyQuery, { contextGraphId: CG }),
    ).rejects.toThrowError(ScopedQueryViolationError);

    await expect(
      engine.query(privateOnlyQuery, { contextGraphId: CG }),
    ).rejects.toThrow(/_private.*outside the allowed graph set/);
  });

  it('THE FIX: `includePrivate: true` admits <cg>/_private and returns the private rows', async () => {
    const result = await engine.query(privateOnlyQuery, {
      contextGraphId: CG,
      includePrivate: true,
    });
    const subjects = result.bindings.map((b) => b['s']);
    expect(subjects).toContain(PRIVATE_EVENT);
    expect(result.bindings.some((b) => b['o'] === '"classified"')).toBe(true);
  });

  it('reproduces the full EPCIS-shaped query (public UNION private + meta OPTIONAL)', async () => {
    // Mirrors the structure emitted by packages/epcis/src/query-builder.ts:
    // a public branch, a private branch gated on the public anchor, and an
    // OPTIONAL meta join — all as explicit GRAPH IRIs.
    const epcisShaped = `SELECT ?event ?eventType WHERE {
      {
        GRAPH <${DATA_GRAPH}> { ?event a ?eventType }
      }
      union
      {
        GRAPH <${DATA_GRAPH}> { ?event <http://dkg.io/ontology/privateDataAnchor> "true" }
        GRAPH <${PRIVATE_GRAPH}> { ?event a ?eventType }
      }
      OPTIONAL {
        GRAPH <${META_GRAPH}> { ?ka <http://dkg.io/ontology/rootEntity> ?event }
      }
    }`;

    // Default scope rejects it (this is exactly what broke the events API).
    await expect(
      engine.query(epcisShaped, { contextGraphId: CG }),
    ).rejects.toThrowError(ScopedQueryViolationError);

    // With includePrivate it runs and sees both the public and private events.
    const result = await engine.query(epcisShaped, {
      contextGraphId: CG,
      includePrivate: true,
    });
    const events = new Set(result.bindings.map((b) => b['event']));
    expect(events.has(PUBLIC_EVENT)).toBe(true);
    expect(events.has(PRIVATE_EVENT)).toBe(true);
  });

  it('does NOT leak: includePrivate only opens the QUERIED CG, never another CG', async () => {
    const crossCgPrivate = `SELECT ?s ?p ?o WHERE {
      GRAPH <${OTHER_PRIVATE_GRAPH}> { ?s ?p ?o }
    }`;
    // Even with the opt-in flag set, a foreign CG's `_private` stays out of
    // the allow-set — the flag only admits the scoped CG's own partition.
    await expect(
      engine.query(crossCgPrivate, { contextGraphId: CG, includePrivate: true }),
    ).rejects.toThrowError(ScopedQueryViolationError);
  });

  it('still allows the CG data + meta graphs alongside the private opt-in', async () => {
    const dataAndMeta = `SELECT ?s WHERE {
      { GRAPH <${DATA_GRAPH}> { ?s a <${EVENT_TYPE}> } }
      UNION
      { GRAPH <${META_GRAPH}> { ?s ?p ?o } }
    }`;
    const result = await engine.query(dataAndMeta, {
      contextGraphId: CG,
      includePrivate: true,
    });
    expect(result.bindings.some((b) => b['s'] === PUBLIC_EVENT)).toBe(true);
  });

  it('sub-graph scope: includePrivate admits <cg>/<sub>/_private', async () => {
    const subPrivateQuery = `SELECT ?s ?p ?o WHERE {
      GRAPH <${SUB_PRIVATE_GRAPH}> { ?s ?p ?o }
    }`;

    await expect(
      engine.query(subPrivateQuery, { contextGraphId: CG, subGraphName: SUB }),
    ).rejects.toThrowError(ScopedQueryViolationError);

    const result = await engine.query(subPrivateQuery, {
      contextGraphId: CG,
      subGraphName: SUB,
      includePrivate: true,
    });
    expect(result.bindings.some((b) => b['o'] === '"sub-classified"')).toBe(true);
  });
});
