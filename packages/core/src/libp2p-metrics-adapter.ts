// libp2p-metrics-adapter.ts
//
// Minimal in-process implementation of @libp2p/interface's `Metrics`
// surface, scoped to ONE thing: counting bytes that flow through
// circuit-relay v2 forwarded connections on a Core Node. We don't ship
// a full prom-client-style metrics stack here because the entire
// observability story for the dashboard already runs through
// MetricsCollector + DashboardDB; libp2p's Metrics interface just
// happens to be the only seam where forwarded byte counts are
// observable without forking the relay-server module.
//
// The other ~50 methods on the interface (registerMetric*,
// registerCounter*, registerHistogram*, registerSummary*,
// trackProtocolStream, traceFunction, createTrace) are returned as
// no-op stubs so the libp2p runtime stays happy. The only "real"
// behaviour is in `trackMultiaddrConnection` — when libp2p hands us a
// new connection whose remote address contains `/p2p-circuit`, we
// subscribe to the connection's `'message'` event for inbound bytes
// and wrap its `.send()` method for outbound bytes.
//
// Event-based design rationale: the libp2p 3.x MultiaddrConnection
// is a MessageStream — it dispatches `'message'` events for inbound
// data and exposes `.send(Uint8Array | Uint8ArrayList)` for outbound.
// (Older libp2p versions used duplex iterators with `source`/`sink`
// — that surface no longer exists in the version we ship.)

import type {
  Counter,
  CounterGroup,
  Histogram,
  HistogramGroup,
  Metric,
  MetricGroup,
  Metrics,
  MultiaddrConnection,
  Stream,
  StreamMessageEvent,
  Summary,
  SummaryGroup,
} from '@libp2p/interface';

/** Live view of relay byte traffic this node has forwarded since startup. */
export interface RelayBytesSnapshot {
  /** Total bytes received via 'message' events on relayed connections. */
  bytesIn: bigint;
  /** Total bytes sent via .send() on relayed connections. */
  bytesOut: bigint;
  /** Connections currently being byte-counted (open + tracked). */
  activeTracked: number;
  /** Connections we have ever started tracking since startup. */
  totalTracked: number;
}

/**
 * Predicate for "is this connection a circuit-relay forwarded connection
 * we should count bytes for". Exposed for tests; in production the only
 * thing that matters is whether the multiaddr contains `/p2p-circuit`.
 */
export function isCircuitRelayConnection(maConn: MultiaddrConnection): boolean {
  try {
    const addr = maConn.remoteAddr?.toString?.() ?? '';
    return addr.includes('/p2p-circuit');
  } catch {
    return false;
  }
}

/**
 * Read the byte length of a chunk. libp2p chunks are
 * `Uint8Array | Uint8ArrayList` — both expose `byteLength`. The
 * `length` fallback is for defence-in-depth; production chunks
 * always have byteLength.
 */
function chunkByteLength(chunk: unknown): number {
  if (chunk == null) return 0;
  const c = chunk as { byteLength?: unknown; length?: unknown };
  if (typeof c.byteLength === 'number') return c.byteLength;
  if (typeof c.length === 'number') return c.length;
  return 0;
}

/** No-op metric — every register* method on the adapter returns one of these. */
const NOOP_METRIC: Metric = {
  update: () => {},
  increment: () => {},
  decrement: () => {},
  reset: () => {},
  timer: () => () => {},
};

const NOOP_METRIC_GROUP: MetricGroup = {
  update: () => {},
  increment: () => {},
  decrement: () => {},
  reset: () => {},
  timer: () => () => {},
};

const NOOP_COUNTER: Counter = {
  increment: () => {},
  reset: () => {},
};

const NOOP_COUNTER_GROUP: CounterGroup = {
  increment: () => {},
  reset: () => {},
};

const NOOP_HISTOGRAM: Histogram = {
  observe: () => {},
  reset: () => {},
  timer: () => () => {},
};

const NOOP_HISTOGRAM_GROUP: HistogramGroup = {
  observe: () => {},
  reset: () => {},
  timer: () => () => {},
};

const NOOP_SUMMARY: Summary = {
  observe: () => {},
  reset: () => {},
  timer: () => () => {},
};

const NOOP_SUMMARY_GROUP: SummaryGroup = {
  observe: () => {},
  reset: () => {},
  timer: () => () => {},
};

/**
 * Adapter implementing libp2p's `Metrics` interface with byte-counting
 * for circuit-relay forwarded connections only. All other Metrics
 * surface methods return no-op objects so libp2p starts cleanly
 * without us shipping a full prometheus-style stack.
 */
export class RelayMetricsAdapter implements Metrics {
  private bytesIn = 0n;
  private bytesOut = 0n;
  private activeTracked = 0;
  private totalTracked = 0;

  /**
   * Override predicate for tests. Production always uses
   * `isCircuitRelayConnection`; tests can pass `() => true` to count
   * bytes on every connection without setting up a full circuit-
   * relay test rig.
   */
  constructor(
    private readonly shouldTrack: (maConn: MultiaddrConnection) => boolean = isCircuitRelayConnection,
  ) {}

  /** Snapshot of the byte counters; safe to call concurrently with traffic. */
  snapshot(): RelayBytesSnapshot {
    return {
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      activeTracked: this.activeTracked,
      totalTracked: this.totalTracked,
    };
  }

  // ─── Metrics interface — the one method we actually instrument ─────

  trackMultiaddrConnection(maConn: MultiaddrConnection): void {
    if (!this.shouldTrack(maConn)) return;
    this.activeTracked += 1;
    this.totalTracked += 1;

    // INBOUND: subscribe to the 'message' event. Each event's `.data`
    // is the chunk that just arrived from the remote peer.
    const onMessage = (evt: StreamMessageEvent) => {
      const n = chunkByteLength(evt.data);
      if (n > 0) this.bytesIn += BigInt(n);
    };
    maConn.addEventListener('message', onMessage);

    // OUTBOUND: wrap .send() so every chunk passed in gets its
    // byteLength added to the counter before delegating to the
    // original send. Preserves the original return value (false ==
    // backpressure signal).
    const originalSend = maConn.send.bind(maConn);
    maConn.send = (data: any) => {
      const n = chunkByteLength(data);
      if (n > 0) this.bytesOut += BigInt(n);
      return originalSend(data);
    };

    // CLOSE: on close, remove the message listener and decrement the
    // active counter. Libp2p emits a 'close' event when the
    // underlying transport tears down (either side).
    let alreadyDecremented = false;
    const onClose = () => {
      if (alreadyDecremented) return;
      alreadyDecremented = true;
      this.activeTracked = Math.max(0, this.activeTracked - 1);
      maConn.removeEventListener('message', onMessage);
      maConn.removeEventListener('close', onClose as any);
    };
    maConn.addEventListener('close', onClose as any);
  }

  // ─── Metrics interface — no-op stubs (we don't ship a full stack) ──

  trackProtocolStream(_stream: Stream): void {
    // Bytes inside individual protocol streams are already counted at
    // the parent connection level via trackMultiaddrConnection, so
    // double-counting here would inflate the relay byte total.
  }

  registerMetric(..._args: any[]): any { return NOOP_METRIC; }
  registerMetricGroup(..._args: any[]): any { return NOOP_METRIC_GROUP; }
  registerCounter(..._args: any[]): any { return NOOP_COUNTER; }
  registerCounterGroup(..._args: any[]): any { return NOOP_COUNTER_GROUP; }
  registerHistogram(..._args: any[]): any { return NOOP_HISTOGRAM; }
  registerHistogramGroup(..._args: any[]): any { return NOOP_HISTOGRAM_GROUP; }
  registerSummary(..._args: any[]): any { return NOOP_SUMMARY; }
  registerSummaryGroup(..._args: any[]): any { return NOOP_SUMMARY_GROUP; }

  traceFunction<F extends (...args: any[]) => any>(_name: string, fn: F): F {
    // Tracing is a no-op — return the function unwrapped. libp2p's
    // built-in metrics module wraps functions for OTEL spans; since
    // we don't ship OTEL plumbing, the unwrapped passthrough is the
    // correct semantic.
    return fn;
  }

  createTrace(): any {
    return undefined;
  }
}
