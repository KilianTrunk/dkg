/**
 * GH #306 / #787 — write routes must reject malformed (string-shaped) quads with
 * an actionable 4xx instead of crashing with a TypeError → HTTP 500.
 *
 *   #787 — POST /api/shared-memory/write with N-Quad *string* quads → was 500
 *          ("Cannot read properties of undefined (reading 'toLowerCase')").
 *          https://github.com/OriginTrail/dkg/issues/787
 *   #306 — POST /api/knowledge-assets/{name}/wm/write with string quads → was 500
 *          ("Cannot use 'in' operator to search for 'graph' in <s> <p> <o> .").
 *          https://github.com/OriginTrail/dkg/issues/306
 *
 * The fix validates quad shape at the route boundary (isWritableQuad) BEFORE the
 * agent write path. This test also asserts the POSITIVE path — well-formed
 * {subject,predicate,object} quads (graph optional) still succeed — so the
 * validation can't regress valid writes. One real auth-enabled daemon against
 * the cli suite's shared Hardhat node; no chain mocks. Daemon lifecycle reuses
 * the shared `live-daemon` helper (startup config, wallet seeding, readiness,
 * token loading, port allocation) so it can't drift from the other cli live
 * tests.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, postJson, type LiveDaemon } from './helpers/live-daemon.js';

let daemon: LiveDaemon | undefined;
const CG = 'wq-validation-cg';

beforeAll(async () => {
  daemon = await startLiveDaemon({ authEnabled: true });
  const { status, body } = await postJson(daemon, '/api/context-graph/create', {
    id: CG, name: 'WQ Validation CG', accessPolicy: 0,
  });
  if (status >= 300) throw new Error(`CG create failed: ${status} ${JSON.stringify(body)}`);
}, 120_000);

afterAll(async () => {
  await stopLiveDaemon(daemon);
});

describe('GH #787 — POST /api/shared-memory/write quad-shape validation', () => {
  it('returns 4xx (not 500) for N-Quad string-shaped quads', async () => {
    const { status } = await postJson(daemon!, '/api/shared-memory/write', {
      contextGraphId: CG, quads: ['<http://example.org/s787> <http://example.org/p> "v" .'],
    });
    expect(status).not.toBe(500);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  it('accepts well-formed object quads (regression: valid SWM write still succeeds)', async () => {
    const { status, body } = await postJson(daemon!, '/api/shared-memory/write', {
      contextGraphId: CG, quads: [{ subject: 'urn:wq:s787', predicate: 'http://schema.org/name', object: '"ok787"' }],
    });
    expect(status, JSON.stringify(body)).toBe(200);
  });
});

describe('GH #306 — POST /api/knowledge-assets/{name}/wm/write quad-shape validation', () => {
  it('returns 4xx (not 500) for N-Quad string-shaped quads', async () => {
    const created = await postJson(daemon!, '/api/knowledge-assets', { contextGraphId: CG, name: 'ka-306' });
    expect(created.status, 'KA create precondition').toBeLessThan(300);
    const { status } = await postJson(daemon!, '/api/knowledge-assets/ka-306/wm/write', {
      contextGraphId: CG, quads: ['<urn:s> <urn:p> <urn:o> .'],
    });
    expect(status).not.toBe(500);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  it('accepts well-formed object quads (regression: valid wm/write still succeeds)', async () => {
    const created = await postJson(daemon!, '/api/knowledge-assets', { contextGraphId: CG, name: 'ka-306-ok' });
    expect(created.status).toBeLessThan(300);
    const { status, body } = await postJson(daemon!, '/api/knowledge-assets/ka-306-ok/wm/write', {
      contextGraphId: CG, quads: [{ subject: 'urn:wq:s306', predicate: 'http://schema.org/name', object: '"ok306"' }],
    });
    expect(status, JSON.stringify(body)).toBe(200);
  });
});
