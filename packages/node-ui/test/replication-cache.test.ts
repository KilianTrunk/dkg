import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB } from '../src/db.js';

// The memo TTL is read from the env at construction time, so each test sets it
// before opening its own DashboardDB.
const ENV_KEY = 'DKG_DASHBOARD_CACHE_TTL_MS';

let dir: string;
let db: DashboardDB | undefined;
let prevEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-repl-cache-'));
  prevEnv = process.env[ENV_KEY];
});

afterEach(() => {
  db?.close();
  db = undefined;
  if (prevEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

function open(ttlMs: number): DashboardDB {
  process.env[ENV_KEY] = String(ttlMs);
  return new DashboardDB({ dataDir: dir });
}

describe('DashboardDB — replication rollup memo', () => {
  it('serves a cached summary within the TTL (does not re-scan on every poll)', () => {
    db = open(60_000); // long TTL so the second call is a guaranteed cache hit
    const now = Date.now();
    db.insertReplicationEvent({ ts: now - 1000, context_graph_id: 'cg', action: 'promote', ual: 'urn:ka:1', ordinal: 1 });

    const first = db.getReplicationSummary(3_600_000);
    expect(first.totalEvents).toBe(1);

    // A new event arrives, but within the TTL the polled value stays cached.
    db.insertReplicationEvent({ ts: now - 500, context_graph_id: 'cg', action: 'promote', ual: 'urn:ka:2', ordinal: 2 });
    const second = db.getReplicationSummary(3_600_000);
    expect(second.totalEvents).toBe(1); // cache hit — not yet 2
  });

  it('reflects fresh data immediately when caching is disabled (TTL <= 0)', () => {
    db = open(0);
    const now = Date.now();
    db.insertReplicationEvent({ ts: now - 1000, context_graph_id: 'cg', action: 'promote', ual: 'urn:ka:1', ordinal: 1 });
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(1);
    db.insertReplicationEvent({ ts: now - 500, context_graph_id: 'cg', action: 'promote', ual: 'urn:ka:2', ordinal: 2 });
    expect(db.getReplicationSummary(3_600_000).totalEvents).toBe(2); // no cache
  });

  it('keys the cache by arguments (a different window is not served a stale value)', () => {
    db = open(60_000);
    const now = Date.now();
    // one event inside the 1h window, one only inside the 2h window
    db.insertReplicationEvent({ ts: now - 30 * 60_000, context_graph_id: 'cg', action: 'promote', ual: 'urn:ka:1', ordinal: 1 });
    db.insertReplicationEvent({ ts: now - 90 * 60_000, context_graph_id: 'cg', action: 'promote', ual: 'urn:ka:2', ordinal: 2 });

    expect(db.getReplicationSummary(60 * 60_000).totalEvents).toBe(1); // 1h window
    expect(db.getReplicationSummary(2 * 60 * 60_000).totalEvents).toBe(2); // 2h window — distinct key
  });
});
