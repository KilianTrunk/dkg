/**
 * GH #1185 — sub-graph data must be readable when `view` is combined with
 * `subGraphName`.
 *
 * Pre-fix, a `view=shared-working-memory` + `subGraphName` read returned 0 rows
 * (or was rejected with "subGraphName cannot be combined with view-based
 * routing"). The fix (`packages/query/src/dkg-query-engine.ts` —
 * `resolveViewGraphs` / the view-routing path) threads `subGraphName` into the
 * view-scoped SWM graph so the read targets `<cg>/<sub>/_shared_memory`
 * (landed under #184 / #675; covers #1185's exact symptom).
 *
 * Reverting the subGraphName threading routes the read back to the ROOT
 * `<cg>/_shared_memory` and this test goes red.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { contextGraphSharedMemoryUri, type GetView } from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const CG_ID = 'dkg-v10-dev';
const SUB = 'code';
const ROOT_SWM = contextGraphSharedMemoryUri(CG_ID); // did:dkg:context-graph:<cg>/_shared_memory
const SUB_SWM = contextGraphSharedMemoryUri(CG_ID, SUB); // did:dkg:context-graph:<cg>/code/_shared_memory

function q(s: string, p: string, o: string, g: string): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('GH #1185 — shared-working-memory view + subGraphName read', () => {
  let store: OxigraphStore;
  let engine: DKGQueryEngine;

  beforeEach(async () => {
    store = new OxigraphStore();
    engine = new DKGQueryEngine(store);
    // Distinct rows in the ROOT SWM and the sub-graph SWM so we can prove the
    // read targets the sub-graph graph, not the root bucket.
    await store.insert([
      q('urn:swm:root', 'http://ex.org/name', '"RootShare"', ROOT_SWM),
      q('urn:swm:code', 'http://ex.org/name', '"CodeShare"', SUB_SWM),
    ]);
  });

  it('reads the sub-graph SWM (not the root SWM) when view=shared-working-memory + subGraphName are combined', async () => {
    const result = await engine.query(
      'SELECT ?s ?name WHERE { ?s <http://ex.org/name> ?name }',
      { contextGraphId: CG_ID, view: 'shared-working-memory' as GetView, subGraphName: SUB },
    );

    // Pre-fix: 0 rows / rejected / the root bucket. Fix routes to <cg>/code/_shared_memory.
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['name']).toBe('"CodeShare"');
    const subjects = result.bindings.map((b) => b['s']);
    expect(subjects).toContain('urn:swm:code');
    expect(subjects).not.toContain('urn:swm:root'); // isolation from the root SWM bucket
  });
});
