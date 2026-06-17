import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, authHeaders, type LiveDaemon } from './helpers/live-daemon.js';

/**
 * Real-node INTEGRATION test for the dashboard replication rollups
 * (`/api/replication/summary | per-cg | timeline`), served by the live daemon
 * via handleNodeUIRequest + a real DashboardDB.
 *
 * Scope is deliberately narrow: the companion PR wraps those rollups in a
 * short-TTL memo, and the memo's OBSERVABLE behaviour (cache hit, TTL expiry,
 * per-window keying, window<=TTL bypass, disable) is proven deterministically in
 * the unit suite `packages/node-ui/test/replication-cache.test.ts`. The memo is
 * an internal optimisation and is NOT observable over HTTP, so this test does
 * not try to assert it. What it DOES guarantee is that the refactor didn't break
 * the live HTTP surface: the endpoints return well-formed, internally-consistent
 * payloads and stay correct under the rapid concurrent polling the memo targets.
 * Runs in the Bura: cli lane.
 */
describe('daemon /api/replication/* (real node, endpoint correctness)', () => {
  let daemon: LiveDaemon | undefined;

  beforeAll(async () => {
    daemon = await startLiveDaemon({ authEnabled: true });
  }, 90_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  }, 30_000);

  async function getJson(d: LiveDaemon, path: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${d.base}${path}`, { headers: authHeaders(d) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }

  it('serves well-formed, internally-consistent summary / per-cg / timeline', async () => {
    const d = daemon!;

    const summary = await getJson(d, '/api/replication/summary');
    expect(summary.status).toBe(200);
    expect(typeof summary.body.totalEvents).toBe('number');
    expect(typeof summary.body.counts).toBe('object');
    // Internal consistency: totalEvents must equal the sum of the action counts.
    const countSum = Object.values(summary.body.counts as Record<string, number>)
      .reduce((s, n) => s + n, 0);
    expect(summary.body.totalEvents).toBe(countSum);

    const perCg = await getJson(d, '/api/replication/per-cg');
    expect(perCg.status).toBe(200);
    expect(Array.isArray(perCg.body.rows)).toBe(true);

    const timeline = await getJson(d, '/api/replication/timeline');
    expect(timeline.status).toBe(200);
    expect(Array.isArray(timeline.body.buckets)).toBe(true);
  }, 30_000);

  it('stays correct and consistent under rapid concurrent polling', async () => {
    // The polling pattern the memo optimises: many back-to-back identical reads.
    // We assert every poll is a well-formed 200 with an identical payload — i.e.
    // the refactor is concurrency-safe and didn't corrupt results. (The memo's
    // caching semantics themselves are unit-tested, not asserted here.)
    const d = daemon!;
    const calls = await Promise.all(
      Array.from({ length: 10 }, () => getJson(d, '/api/replication/summary')),
    );
    expect(calls.every((c) => c.status === 200)).toBe(true);
    expect(calls.every((c) => typeof c.body?.totalEvents === 'number')).toBe(true);
    const serialized = new Set(calls.map((c) => JSON.stringify(c.body)));
    expect(serialized.size).toBe(1); // identical payload across all concurrent polls
  }, 30_000);
});
