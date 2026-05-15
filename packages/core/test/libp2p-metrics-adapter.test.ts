// libp2p-metrics-adapter.test.ts
//
// Unit tests for the byte-counting libp2p Metrics adapter shipped in
// the relay-observability PR (PR2 of the libp2p reachability hardening
// series). Three contracts under test:
//
//   1. `isCircuitRelayConnection` — the predicate that decides whether
//      a libp2p MultiaddrConnection should be byte-counted. Production
//      passes only `/p2p-circuit` connections through the adapter; we
//      verify both the positive and negative paths.
//
//   2. The no-op surface — registerMetric/Group/Counter/Histogram/Summary
//      return objects whose methods don't throw. libp2p calls these at
//      startup for its built-in metrics modules; if any returned object
//      is missing a method, libp2p will TypeError in production. We
//      therefore exercise every method on every returned shape.
//
//   3. `trackMultiaddrConnection` — the only "real" code path. Subscribes
//      to the connection's `'message'` event for inbound bytes and
//      wraps `.send()` for outbound bytes. We simulate traffic via
//      both surfaces and assert the running totals.

import { describe, it, expect } from 'vitest';
import {
  RelayMetricsAdapter,
  isCircuitRelayConnection,
  type RelayBytesSnapshot,
} from '../src/libp2p-metrics-adapter.js';

/**
 * Fake MultiaddrConnection minimal enough to flow through the adapter.
 * Inherits EventTarget so `addEventListener('message'|'close')` works
 * just like the real libp2p MessageStream contract.
 */
class FakeMaConn extends EventTarget {
  remoteAddr: { toString: () => string };
  // Captures everything passed to send() so tests can inspect the
  // outbound stream.
  sentChunks: any[] = [];
  // Track whether we've recorded a close. Real libp2p .close() returns
  // a Promise<void>; we just emit the event synchronously.
  closed = false;

  constructor(remoteAddr: string) {
    super();
    this.remoteAddr = { toString: () => remoteAddr };
  }

  send(data: any): boolean {
    this.sentChunks.push(data);
    // Mirror libp2p's send() return type: false signals backpressure.
    // We always return true here to keep tests deterministic.
    return true;
  }

  // Fire a fake inbound 'message' event with arbitrary chunk data.
  emitInbound(data: any): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  // Fire a fake 'close' event.
  emitClose(): void {
    this.closed = true;
    this.dispatchEvent(new Event('close'));
  }
}

describe('isCircuitRelayConnection', () => {
  it('returns true for /p2p-circuit relayed multiaddrs', () => {
    expect(
      isCircuitRelayConnection({
        remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/4001/p2p/12D3.../p2p-circuit/p2p/12D3...edge' },
      } as any),
    ).toBe(true);
  });

  it('returns false for direct (non-circuit) multiaddrs', () => {
    expect(
      isCircuitRelayConnection({
        remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/4001/p2p/12D3...peer' },
      } as any),
    ).toBe(false);
  });

  it('returns false defensively when remoteAddr is missing or throws', () => {
    expect(isCircuitRelayConnection({} as any)).toBe(false);
    expect(
      isCircuitRelayConnection({
        remoteAddr: {
          toString: () => {
            throw new Error('boom');
          },
        },
      } as any),
    ).toBe(false);
  });
});

describe('RelayMetricsAdapter — no-op surface', () => {
  it('returns Metric/Counter/Histogram/Summary objects whose methods do not throw', () => {
    const m = new RelayMetricsAdapter();

    // registerMetric — Metric has update/increment/decrement/reset/timer
    const metric = m.registerMetric('foo');
    expect(() => metric.update(1)).not.toThrow();
    expect(() => metric.increment()).not.toThrow();
    expect(() => metric.decrement()).not.toThrow();
    expect(() => metric.reset()).not.toThrow();
    const stop = metric.timer();
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();

    // registerMetricGroup — same shape but with `update(values)` etc.
    const group = m.registerMetricGroup('bar');
    expect(() => group.update({ key: 1 })).not.toThrow();
    expect(() => group.increment({ key: 1 })).not.toThrow();
    expect(() => group.decrement({ key: 1 })).not.toThrow();
    expect(() => group.reset()).not.toThrow();
    expect(() => group.timer('key')()).not.toThrow();

    // Counters — increment + reset only
    const counter = m.registerCounter('c1');
    expect(() => counter.increment()).not.toThrow();
    expect(() => counter.reset()).not.toThrow();

    const counterGroup = m.registerCounterGroup('cg');
    expect(() => counterGroup.increment({ a: 1 })).not.toThrow();
    expect(() => counterGroup.reset()).not.toThrow();

    // Histograms
    const hist = m.registerHistogram('h');
    expect(() => hist.observe(0.5)).not.toThrow();
    expect(() => hist.reset()).not.toThrow();
    expect(() => hist.timer()()).not.toThrow();

    const histGroup = m.registerHistogramGroup('hg');
    expect(() => histGroup.observe({ a: 0.5 })).not.toThrow();
    expect(() => histGroup.reset()).not.toThrow();

    // Summaries
    const sum = m.registerSummary('s');
    expect(() => sum.observe(0.5)).not.toThrow();
    expect(() => sum.reset()).not.toThrow();
    expect(() => sum.timer()()).not.toThrow();

    const sumGroup = m.registerSummaryGroup('sg');
    expect(() => sumGroup.observe({ a: 0.5 })).not.toThrow();
    expect(() => sumGroup.reset()).not.toThrow();

    // Tracing — passthrough, must return the same function reference.
    const fn = (x: number) => x * 2;
    expect(m.traceFunction('f', fn)).toBe(fn);
    expect(m.createTrace()).toBeUndefined();
  });

  it('trackProtocolStream is a no-op (bytes are counted at the connection level)', () => {
    const m = new RelayMetricsAdapter();
    expect(() => m.trackProtocolStream({} as any)).not.toThrow();
    // Stream tracking must NOT inflate the byte counters — we count at
    // the multiaddr-conn level only, so streams must contribute zero.
    expect(m.snapshot().bytesIn).toBe(0n);
    expect(m.snapshot().bytesOut).toBe(0n);
  });
});

describe('RelayMetricsAdapter — trackMultiaddrConnection (the real path)', () => {
  it('does not count bytes on direct (non-/p2p-circuit) connections', () => {
    const m = new RelayMetricsAdapter();
    const conn = new FakeMaConn('/ip4/1.2.3.4/tcp/4001/p2p/12D3...direct');
    m.trackMultiaddrConnection(conn as any);

    conn.emitInbound(new Uint8Array(100));
    conn.send(new Uint8Array(200));

    expect(m.snapshot().bytesIn).toBe(0n);
    expect(m.snapshot().bytesOut).toBe(0n);
    expect(m.snapshot().activeTracked).toBe(0);
    expect(m.snapshot().totalTracked).toBe(0);
  });

  it('counts inbound bytes (message events) on /p2p-circuit connections', () => {
    const m = new RelayMetricsAdapter();
    const conn = new FakeMaConn('/ip4/1.2.3.4/tcp/4001/p2p/relay/p2p-circuit/p2p/edge');
    m.trackMultiaddrConnection(conn as any);

    expect(m.snapshot().activeTracked).toBe(1);
    expect(m.snapshot().totalTracked).toBe(1);

    conn.emitInbound(new Uint8Array(100));
    conn.emitInbound(new Uint8Array(200));
    conn.emitInbound(new Uint8Array(50));

    expect(m.snapshot().bytesIn).toBe(350n);
    expect(m.snapshot().bytesOut).toBe(0n);
  });

  it('counts outbound bytes (.send() wrapper) on /p2p-circuit connections', () => {
    const m = new RelayMetricsAdapter();
    const conn = new FakeMaConn('/ip4/1.2.3.4/tcp/4001/p2p/relay/p2p-circuit/p2p/edge');
    m.trackMultiaddrConnection(conn as any);

    const ok1 = conn.send(new Uint8Array(64));
    const ok2 = conn.send(new Uint8Array(128));

    // The wrapper preserves the original send's return value.
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
    // Outbound chunks reach the underlying send() unchanged.
    expect(conn.sentChunks).toHaveLength(2);
    expect(m.snapshot().bytesOut).toBe(192n);
    expect(m.snapshot().bytesIn).toBe(0n);
  });

  it('decrements activeTracked on close (but keeps totalTracked = lifetime count)', () => {
    const m = new RelayMetricsAdapter();
    const conn = new FakeMaConn('/ip4/1.2.3.4/tcp/4001/p2p/relay/p2p-circuit/p2p/edge');
    m.trackMultiaddrConnection(conn as any);
    expect(m.snapshot().activeTracked).toBe(1);

    conn.emitClose();
    expect(m.snapshot().activeTracked).toBe(0);
    // totalTracked is a lifetime counter, never decremented.
    expect(m.snapshot().totalTracked).toBe(1);

    // Idempotent — a second close event must not double-decrement
    // activeTracked into negatives, otherwise repeated teardowns
    // would cause underflow.
    conn.emitClose();
    expect(m.snapshot().activeTracked).toBe(0);
  });

  it('stops counting inbound bytes after close (listener was removed)', () => {
    const m = new RelayMetricsAdapter();
    const conn = new FakeMaConn('/p2p-circuit/p2p/edge');
    m.trackMultiaddrConnection(conn as any);

    conn.emitInbound(new Uint8Array(10));
    expect(m.snapshot().bytesIn).toBe(10n);

    conn.emitClose();
    // Post-close inbound events must NOT inflate the counter — the
    // listener has been removed by the close handler.
    conn.emitInbound(new Uint8Array(100));
    expect(m.snapshot().bytesIn).toBe(10n);
  });

  it('aggregates bytes across multiple concurrent connections', () => {
    const m = new RelayMetricsAdapter();
    const a = new FakeMaConn('/p2p-circuit/p2p/edge-a');
    const b = new FakeMaConn('/p2p-circuit/p2p/edge-b');
    m.trackMultiaddrConnection(a as any);
    m.trackMultiaddrConnection(b as any);

    expect(m.snapshot().activeTracked).toBe(2);

    a.emitInbound(new Uint8Array(10));
    b.emitInbound(new Uint8Array(20));
    b.emitInbound(new Uint8Array(30));

    expect(m.snapshot().bytesIn).toBe(60n);
    expect(m.snapshot().totalTracked).toBe(2);

    a.emitClose();
    expect(m.snapshot().activeTracked).toBe(1);
    expect(m.snapshot().totalTracked).toBe(2);
  });

  it('handles Uint8ArrayList-style chunks via byteLength fallback', () => {
    const m = new RelayMetricsAdapter();
    const conn = new FakeMaConn('/p2p-circuit/p2p/edge');
    m.trackMultiaddrConnection(conn as any);

    // Sneak a Uint8ArrayList-shaped chunk through both surfaces.
    conn.emitInbound({ byteLength: 17 } as any);
    conn.send({ byteLength: 42 } as any);

    expect(m.snapshot().bytesIn).toBe(17n);
    expect(m.snapshot().bytesOut).toBe(42n);
  });

  it('snapshot() is independently readable as a plain object (not a live binding)', () => {
    const m = new RelayMetricsAdapter();
    const conn = new FakeMaConn('/p2p-circuit/p2p/edge');
    m.trackMultiaddrConnection(conn as any);
    const before: RelayBytesSnapshot = m.snapshot();
    conn.emitInbound(new Uint8Array(7));
    const after: RelayBytesSnapshot = m.snapshot();
    // Each snapshot is a fresh capture; before's bytesIn must NOT
    // mutate when the adapter increments its internal counter.
    expect(before.bytesIn).toBe(0n);
    expect(after.bytesIn).toBe(7n);
  });
});

describe('RelayMetricsAdapter — custom shouldTrack predicate (test override)', () => {
  it('counts bytes on direct connections when shouldTrack returns true', () => {
    const m = new RelayMetricsAdapter(() => true);
    const conn = new FakeMaConn('/ip4/1.2.3.4/tcp/4001/direct');
    m.trackMultiaddrConnection(conn as any);
    conn.emitInbound(new Uint8Array(99));
    expect(m.snapshot().bytesIn).toBe(99n);
  });

  it('skips all connections when shouldTrack returns false', () => {
    const m = new RelayMetricsAdapter(() => false);
    const conn = new FakeMaConn('/p2p-circuit/p2p/edge');
    m.trackMultiaddrConnection(conn as any);
    conn.emitInbound(new Uint8Array(99));
    expect(m.snapshot().bytesIn).toBe(0n);
    expect(m.snapshot().activeTracked).toBe(0);
  });
});
