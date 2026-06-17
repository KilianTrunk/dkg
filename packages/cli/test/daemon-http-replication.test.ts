import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, authHeaders, type LiveDaemon } from './helpers/live-daemon.js';

/**
 * Real-node test for the dashboard replication rollups. The companion PR wraps
 * DashboardDB.getReplicationSummary / getReplicationPerCg / getReplicationTimeline
 * in a short-TTL memo. These endpoints are served by the live daemon via
 * handleNodeUIRequest + a real DashboardDB, so this boots an actual daemon and
 * exercises the live /api/replication/* HTTP path to prove the memo refactor
 * didn't break the real endpoints and that rapid repeated polls return a stable,
 * well-formed payload (the memo path). Runs in the Bura: cli lane.
 */
describe('daemon /api/replication/* (real node, memoized rollups)', () => {
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

  it('serves well-formed summary, per-cg, and timeline on a live node', async () => {
    const d = daemon!;

    const summary = await getJson(d, '/api/replication/summary');
    expect(summary.status).toBe(200);
    expect(typeof summary.body.totalEvents).toBe('number');
    expect(typeof summary.body.counts).toBe('object');

    const perCg = await getJson(d, '/api/replication/per-cg');
    expect(perCg.status).toBe(200);
    expect(Array.isArray(perCg.body.rows)).toBe(true);

    const timeline = await getJson(d, '/api/replication/timeline');
    expect(timeline.status).toBe(200);
    expect(Array.isArray(timeline.body.buckets)).toBe(true);
  }, 30_000);

  it('returns stable results across rapid repeated polls (memo path)', async () => {
    const d = daemon!;
    const calls = await Promise.all(
      Array.from({ length: 10 }, () => getJson(d, '/api/replication/summary')),
    );
    expect(calls.every((c) => c.status === 200)).toBe(true);
    const totals = calls.map((c) => c.body.totalEvents);
    expect(new Set(totals).size).toBe(1); // consistent under the memo
  }, 30_000);
});
