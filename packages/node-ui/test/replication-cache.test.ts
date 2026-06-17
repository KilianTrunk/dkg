import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB, type ReplicationTimelineBucket } from '../src/db.js';

const ENV_KEY = 'DKG_DASHBOARD_CACHE_TTL_MS';

let dir: string;
let db: DashboardDB | undefined;
let prevEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-repl-cache-'));
  prevEnv = process.env[ENV_KEY];
});

afterEach(() => {
  vi.useRealTimers();
  db?.close();
  db = undefined;
  if (prevEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

// TTL is injected via the constructor option (no global env mutation needed).
function open(ttlMs: number): DashboardDB {
  return new DashboardDB({ dataDir: dir, cacheTtlMs: ttlMs });
}

function promote(d: DashboardDB, ts: number, cg: string, ord: number): void {
  d.insertReplicationEvent({ ts, context_graph_id: cg, action: 'promote', ual: `urn:ka:${ord}`, ordinal: ord });
}

const timelineTotal = (buckets: ReplicationTimelineBucket[]): number =>
  buckets.reduce((s, b) => s + (b.total ?? 0), 0);

describe('DashboardDB — replication rollup memo', () => {
  it('serves a cached summary within the TTL (does not re-scan on every poll)', () => {
    db = open(60_000);
    const now = Date.now();
    promote(db, now - 1000, 'cg', 1);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1);

    promote(db, now - 500, 'cg', 2); // new event, but within TTL the poll stays cached
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1);
  });

  it('expires the cache after the TTL — a permanent cache would FAIL this', () => {
    // Deterministic via faked Date only (leaves real timers/native sqlite alone).
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);
    db = open(1000); // 1s TTL, 1h window (> TTL) so caching is active
    promote(db, t0 - 1000, 'cg', 1);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1); // computed + cached at t0

    promote(db, t0 - 500, 'cg', 2);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1); // still within TTL → cached

    vi.setSystemTime(t0 + 1500); // advance past the 1s TTL
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(2); // expired → recomputed
  });

  it('reflects fresh data immediately when caching is disabled (TTL <= 0)', () => {
    db = open(0);
    const now = Date.now();
    promote(db, now - 1000, 'cg', 1);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1);
    promote(db, now - 500, 'cg', 2);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(2); // no cache
  });

  it('keys the cache by window (a different periodMs is not served a stale value)', () => {
    db = open(60_000);
    const now = Date.now();
    promote(db, now - 30 * 60_000, 'cg', 1); // inside 1h
    promote(db, now - 90 * 60_000, 'cg', 2); // only inside 2h
    expect(db.getReplicationSummary(60 * 60_000).totalEvents).toBe(1);
    expect(db.getReplicationSummary(2 * 60 * 60_000).totalEvents).toBe(2); // distinct key
  });

  it('bypasses the cache when the requested window is <= the TTL (avoids stale-by-window)', () => {
    db = open(60_000); // TTL 60s, window 10s (<= TTL) → must not cache
    const now = Date.now();
    promote(db, now - 1000, 'cg', 1);
    expect(db.getReplicationSummary(10_000).totalEvents).toBe(1);
    promote(db, now - 500, 'cg', 2);
    expect(db.getReplicationSummary(10_000).totalEvents).toBe(2); // not cached → fresh
  });

  it('memoizes getReplicationPerCg independently and keys it by window', () => {
    db = open(60_000);
    const now = Date.now();
    promote(db, now - 1000, 'cgA', 1);
    expect(db.getReplicationPerCg(3_600_000).length).toBe(1);

    promote(db, now - 500, 'cgB', 2); // a second CG appears
    expect(db.getReplicationPerCg(3_600_000).length).toBe(1); // cached within TTL — cgB not yet visible
    expect(db.getReplicationPerCg(2 * 3_600_000).length).toBe(2); // different window key → recomputed
  });

  it('timeline cache bypass is driven by periodMs, not bucketMs', () => {
    db = open(60_000); // 60s TTL
    const now = Date.now();
    promote(db, now - 1000, 'cg', 1);
    // periodMs 1h (> TTL) but bucketMs 10s (<= TTL): with the periodMs-only rule
    // this CACHES (bucketMs no longer forces a bypass).
    const big = { periodMs: 3_600_000, bucketMs: 10_000 };
    expect(timelineTotal(db.getReplicationTimeline(big))).toBe(1);
    promote(db, now - 500, 'cg', 2);
    expect(timelineTotal(db.getReplicationTimeline(big))).toBe(1); // cached (periodMs > TTL)

    // A small periodMs (<= TTL) is bypassed → fresh.
    expect(timelineTotal(db.getReplicationTimeline({ periodMs: 10_000, bucketMs: 1000 }))).toBe(2);
  });
});

describe('DashboardDB — cache TTL resolution', () => {
  it('empty DKG_DASHBOARD_CACHE_TTL_MS falls back to the default (does NOT disable) — the reported bug', () => {
    process.env[ENV_KEY] = '';
    db = new DashboardDB({ dataDir: dir }); // no option → resolves via env
    const now = Date.now();
    promote(db, now - 1000, 'cg', 1);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1);
    promote(db, now - 500, 'cg', 2);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1); // still cached → default TTL active, not disabled
  });

  it('malformed DKG_DASHBOARD_CACHE_TTL_MS falls back to the default', () => {
    process.env[ENV_KEY] = '64x';
    db = new DashboardDB({ dataDir: dir });
    const now = Date.now();
    promote(db, now - 1000, 'cg', 1);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1);
    promote(db, now - 500, 'cg', 2);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1); // cached at default → not disabled
  });

  it('the cacheTtlMs option overrides the env var', () => {
    process.env[ENV_KEY] = '60000';
    db = new DashboardDB({ dataDir: dir, cacheTtlMs: 0 }); // option disables, beating env
    const now = Date.now();
    promote(db, now - 1000, 'cg', 1);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1);
    promote(db, now - 500, 'cg', 2);
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(2); // option won → no cache
  });
});
