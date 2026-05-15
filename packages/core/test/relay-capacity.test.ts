// relay-capacity.test.ts
//
// Unit tests for the Core Node relay-server capacity tuning helpers
// landed in `feat/libp2p-relay-capacity-and-ttl` (PR1 of the libp2p
// reachability hardening series). Two surfaces under test:
//
//   1. `deriveRelayCaps(capacity)` — the pure 1:2 ratio derivation
//      that turns the operator-facing `relayServerCapacity` knob into
//      the full set of HOP/STOP stream caps + connectionManager limit.
//
//   2. `checkFdLimit(maxConnections, log)` — the startup helper that
//      reads the host's RLIMIT_NOFILE via process.report.userLimits
//      and emits an actionable warning when the soft limit is below
//      the recommended `max(4096, maxConnections × 2)`. Critical for
//      operators on systemd / Docker hosts whose default limits are
//      typically 1024 — silently below what a 1024-reservation Core
//      Node needs.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_RELAY_SERVER_CAPACITY,
  RELAY_CAPACITY_MULTIPLIER,
  RELAY_DEFAULT_DURATION_LIMIT_MS,
  RELAY_RESERVATION_TTL_MS,
  EDGE_NODE_MAX_CONNECTIONS,
  deriveRelayCaps,
  checkFdLimit,
} from '../src/node.js';

describe('deriveRelayCaps', () => {
  it('returns the default capacity-derived caps at the documented 1:2 ratio', () => {
    const caps = deriveRelayCaps(DEFAULT_RELAY_SERVER_CAPACITY);
    expect(caps).toEqual({
      maxReservations: 1024,
      maxConnections: 2048,
      maxInboundHopStreams: 2048,
      maxOutboundHopStreams: 2048,
      maxOutboundStopStreams: 2048,
      maxInboundStopStreams: 2048,
    });
  });

  it('scales linearly — capacity=2048 doubles every derived cap', () => {
    const caps = deriveRelayCaps(2048);
    expect(caps.maxReservations).toBe(2048);
    expect(caps.maxConnections).toBe(2048 * RELAY_CAPACITY_MULTIPLIER);
    expect(caps.maxInboundHopStreams).toBe(caps.maxConnections);
    expect(caps.maxOutboundHopStreams).toBe(caps.maxConnections);
    expect(caps.maxOutboundStopStreams).toBe(caps.maxConnections);
    expect(caps.maxInboundStopStreams).toBe(caps.maxConnections);
  });

  it('scales down for resource-constrained operators (Pi-class hosts)', () => {
    const caps = deriveRelayCaps(256);
    expect(caps.maxReservations).toBe(256);
    expect(caps.maxConnections).toBe(512);
  });

  it('the per-circuit duration limit is documented at 30 minutes (bumped from libp2p default 5min)', () => {
    expect(RELAY_DEFAULT_DURATION_LIMIT_MS).toBe(30 * 60 * 1000);
  });

  it('the reservation TTL is set explicitly at 2 hours (matches libp2p default but pinned for visibility)', () => {
    expect(RELAY_RESERVATION_TTL_MS).toBe(2 * 60 * 60 * 1000);
  });

  it('edge-node default maxConnections stays at the legacy 500 (no blast radius for non-relay nodes)', () => {
    // Sanity guard: this PR intentionally only touches Core Node
    // capacity. If a future change starts scaling edge nodes too,
    // this constant should be reconsidered carefully — every edge
    // bump multiplies across the network's broad install base.
    expect(EDGE_NODE_MAX_CONNECTIONS).toBe(500);
  });
});

describe('checkFdLimit', () => {
  // process.report.getReport() is the only cross-platform Node API
  // that surfaces RLIMIT_NOFILE without a syscall dep. The
  // `process.report` property itself is a read-only getter, so we
  // spy on the `getReport` method (which is writable on the
  // returned report object) per-test rather than reassigning the
  // parent property.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function spyOnReport(report: any) {
    return vi.spyOn(process.report, 'getReport').mockReturnValue(report);
  }

  it('emits WARN when soft limit is below recommended (= max(4096, maxConnections × 2))', () => {
    spyOnReport({ userLimits: { open_files: { soft: 1024, hard: 'unlimited' } } });
    const log = vi.fn();
    // maxConnections=2048 → recommended = max(4096, 4096) = 4096; soft=1024 is below.
    checkFdLimit(2048, log);
    expect(log).toHaveBeenCalledTimes(1);
    const msg = log.mock.calls[0][0] as string;
    expect(msg).toMatch(/^WARN: relay server enabled/);
    expect(msg).toContain('soft=1024');
    expect(msg).toContain('recommended 4096');
    // Operator-facing remediation hint must surface all three deployment
    // shapes so people on the wrong one find their fix immediately.
    expect(msg).toMatch(/ulimit -n 4096/);
    expect(msg).toMatch(/LimitNOFILE=4096/);
    expect(msg).toMatch(/--ulimit nofile=4096:4096/);
  });

  it('emits the ok line when soft limit meets or exceeds the recommended value', () => {
    spyOnReport({ userLimits: { open_files: { soft: 8192, hard: 'unlimited' } } });
    const log = vi.fn();
    checkFdLimit(2048, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/soft=8192 >= recommended 4096, ok/);
  });

  it('uses the 4096 floor when 2 × maxConnections would be smaller', () => {
    // For a small Core Node (capacity=256 → maxConnections=512),
    // 2 × maxConnections = 1024. The floor at 4096 ensures we still
    // recommend a sensible minimum — fd usage isn't dominated by
    // libp2p alone on a real host (SQLite, log files, the daemon
    // HTTP server, etc. all chip in).
    spyOnReport({ userLimits: { open_files: { soft: 1500, hard: 'unlimited' } } });
    const log = vi.fn();
    checkFdLimit(512, log);
    const msg = log.mock.calls[0][0] as string;
    expect(msg).toContain('recommended 4096');
    expect(msg).not.toContain('recommended 1024');
  });

  it('logs the can-not-read fallback when userLimits is missing (e.g. exotic Node build)', () => {
    spyOnReport({ userLimits: {} });
    const log = vi.fn();
    checkFdLimit(2048, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/could not read host ulimit/);
    expect(log.mock.calls[0][0]).toContain('>= 4096');
  });

  it('logs the can-not-read fallback when soft is non-numeric (e.g. "unlimited")', () => {
    // POSIX returns either a number or the string "unlimited" for the
    // hard limit; soft is usually numeric but the API contract
    // doesn't strictly require it. Defence in depth.
    spyOnReport({ userLimits: { open_files: { soft: 'unlimited', hard: 'unlimited' } } });
    const log = vi.fn();
    checkFdLimit(2048, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/could not read host ulimit/);
  });

  it('logs the error fallback when process.report.getReport() throws', () => {
    vi.spyOn(process.report, 'getReport').mockImplementation(() => {
      throw new Error('exotic test environment');
    });
    const log = vi.fn();
    checkFdLimit(2048, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/error reading ulimit/);
    expect(log.mock.calls[0][0]).toContain('exotic test environment');
    expect(log.mock.calls[0][0]).toContain('>= 4096');
  });
});
