/**
 * OpenTelemetry SDK bootstrap for a DKG node (boot side, daemon-only consumer).
 *
 * Registers the global Tracer + Meter providers at daemon startup so that the
 * call-site facade in `@origintrail-official/dkg-core` (getTracer/withSpan/
 * getMetrics) — used across agent/publisher/chain/sync — produces real spans and
 * metrics. When telemetry is disabled, or a signal has no endpoint, this
 * registers NOTHING: the core facade then talks to the API's built-in no-op
 * providers (zero cost, no outbound calls).
 *
 * Logs are NOT handled here — they stay on the hand-rolled `OtlpLogWorker`
 * (bounded buffer + retry + at-source redaction); the OTel Logs SDK is still
 * "Development". This module only wires traces + metrics, and shares ONE
 * Resource with the log worker so all three signals describe the same node.
 *
 * BROWSER SAFETY: the heavy Node-only OTel SDK packages (sdk-trace-node,
 * sdk-metrics, exporter-*-otlp-proto, resources) and `@origintrail-official/dkg-core`
 * are loaded via DYNAMIC import inside `initTelemetry`/`shutdownTelemetry`, never
 * statically. Only `@opentelemetry/api` (browser-safe, no Node built-ins) is a
 * static import. That keeps this module — and the package root that re-exports
 * it — free of server-only code in any static bundle graph: a browser bundler
 * never pulls the Node SDK because it sits behind a runtime `import()` that the
 * UI never triggers.
 */

import { metrics as otelMetrics, trace as otelTrace } from '@opentelemetry/api';
// Type-only imports are erased at compile time → no runtime/bundle dependency.
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { MeterProvider } from '@opentelemetry/sdk-metrics';

/** Stable resource identity, shared by logs + traces + metrics. */
export interface TelemetryResource {
  serviceName?: string; // default 'dkg-node'
  serviceVersion?: string;
  /** Per-node id → service.instance.id (the Grafana node selector). */
  serviceInstanceId?: string;
  /** testnet | mainnet | devnet → deployment.environment + dkg.network */
  network?: string;
  peerId?: string;
  nodeName?: string;
  nodeRole?: string;
  commit?: string;
  /** e.g. 'base:8453' → dkg.chain */
  chainId?: string;
}

export interface OtlpSignalConfig {
  endpoint?: string; // full signal URL, e.g. http://localhost:4318/v1/traces
  /** Bearer token → Authorization header. */
  token?: string;
  headers?: Record<string, string>;
  /** Per-signal opt-out. A signal is on only when it has an endpoint AND this is not false. */
  enabled?: boolean;
}

export interface TelemetryInitConfig {
  /** Master gate. When false, nothing is registered. */
  enabled?: boolean;
  resource?: TelemetryResource;
  traces?: OtlpSignalConfig & { sampleRatio?: number };
  metrics?: OtlpSignalConfig & { exportIntervalMs?: number };
}

/**
 * LEGACY config shape (pre-PR #1317 stub). Kept so old JS callers that pass
 * `{ enabled, metricsEndpoint, serviceName }` keep working — `initTelemetry`
 * normalizes it into `TelemetryInitConfig` (metricsEndpoint → metrics.endpoint).
 * @deprecated Use `TelemetryInitConfig` (traces/metrics signal blocks).
 */
export interface TelemetryConfig {
  enabled?: boolean;
  /** OTLP HTTP endpoint for metrics (e.g. http://localhost:4318/v1/metrics) */
  metricsEndpoint?: string;
  /** Service name for resource attributes */
  serviceName?: string;
}

let tracerProvider: NodeTracerProvider | null = null;
let meterProvider: MeterProvider | null = null;
let configured = false;

function buildAttrs(r: TelemetryResource = {}): Record<string, string> {
  const attrs: Record<string, string> = {
    'service.name': r.serviceName ?? 'dkg-node',
  };
  if (r.serviceVersion) attrs['service.version'] = r.serviceVersion;
  if (r.serviceInstanceId) attrs['service.instance.id'] = r.serviceInstanceId;
  if (r.network) {
    attrs['deployment.environment'] = r.network;
    attrs['dkg.network'] = r.network;
  }
  if (r.peerId) attrs['dkg.peer_id'] = r.peerId;
  if (r.nodeName) attrs['dkg.node.name'] = r.nodeName;
  if (r.nodeRole) attrs['dkg.node.role'] = r.nodeRole;
  if (r.commit) attrs['dkg.commit'] = r.commit;
  if (r.chainId) attrs['dkg.chain'] = r.chainId;
  return attrs;
}

function authHeaders(sig: OtlpSignalConfig): Record<string, string> | undefined {
  const headers = { ...(sig.headers ?? {}) };
  if (sig.token) headers['Authorization'] = `Bearer ${sig.token}`;
  return Object.keys(headers).length ? headers : undefined;
}

/** Map the legacy flat `{ metricsEndpoint, serviceName }` shape onto the new one. */
function normalizeInitConfig(input: TelemetryInitConfig | TelemetryConfig): TelemetryInitConfig {
  const legacy = input as TelemetryConfig;
  const next = input as TelemetryInitConfig;
  if (legacy.metricsEndpoint && !next.metrics && !next.traces) {
    return {
      enabled: legacy.enabled,
      resource: { serviceName: legacy.serviceName },
      metrics: { endpoint: legacy.metricsEndpoint },
    };
  }
  return next;
}

/**
 * Initialize traces + metrics. No-op when disabled or when a signal has no
 * endpoint. Safe to call once at daemon boot. Idempotent (subsequent calls are
 * ignored once configured). Async because the Node OTel SDK is dynamically
 * imported (see the BROWSER SAFETY note above).
 */
export async function initTelemetry(input: TelemetryInitConfig | TelemetryConfig): Promise<void> {
  if (configured) return;
  const cfg = normalizeInitConfig(input);
  if (!cfg.enabled) return;

  const tracesOn = !!cfg.traces?.endpoint && cfg.traces.enabled !== false;
  const metricsOn = !!cfg.metrics?.endpoint && cfg.metrics.enabled !== false;
  if (!tracesOn && !metricsOn) return;

  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const resource = resourceFromAttributes(buildAttrs(cfg.resource));

  // ── Traces ──
  if (tracesOn) {
    const { NodeTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } =
      await import('@opentelemetry/sdk-trace-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto');
    const exporter = new OTLPTraceExporter({
      url: cfg.traces!.endpoint,
      headers: authHeaders(cfg.traces!),
    });
    const ratio = cfg.traces!.sampleRatio ?? 1;
    tracerProvider = new NodeTracerProvider({
      resource,
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    // register() installs the global tracer provider + an AsyncLocalStorage
    // context manager (so spans flow across awaits) + W3C trace-context propagator.
    tracerProvider.register();
    configured = true;
  }

  // ── Metrics ──
  if (metricsOn) {
    const { MeterProvider, PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-proto');
    const { rebuildMetrics } = await import('@origintrail-official/dkg-core');
    const exporter = new OTLPMetricExporter({
      url: cfg.metrics!.endpoint,
      headers: authHeaders(cfg.metrics!),
    });
    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: cfg.metrics!.exportIntervalMs ?? 30_000,
        }),
      ],
    });
    otelMetrics.setGlobalMeterProvider(meterProvider);
    // Re-bind the core facade's instrument cache to the real meter.
    rebuildMetrics();
    configured = true;
  }
}

export function isTelemetryConfigured(): boolean {
  return configured;
}

/**
 * Flush + shut down providers. Used both at daemon teardown AND when telemetry
 * is turned off via the runtime master gate, so it must FULLY reverse
 * `initTelemetry`: stop the exporters, then clear the OTel API globals so a
 * later `initTelemetry` (live re-enable) can register fresh providers — without
 * the `disable()` calls, the API keeps the first (now shut-down) provider and a
 * re-enable would silently no-op. Safe if never initialized; idempotent.
 */
export async function shutdownTelemetry(): Promise<void> {
  const hadTracer = !!tracerProvider;
  const hadMeter = !!meterProvider;
  const tasks: Promise<void>[] = [];
  if (tracerProvider) {
    tasks.push(tracerProvider.forceFlush().catch(() => {}));
    tasks.push(tracerProvider.shutdown().catch(() => {}));
  }
  if (meterProvider) {
    tasks.push(meterProvider.forceFlush().catch(() => {}));
    tasks.push(meterProvider.shutdown().catch(() => {}));
  }
  await Promise.all(tasks);
  // Reset the global API so a subsequent initTelemetry() can re-register
  // (setGlobal*Provider only takes effect once until the slot is disabled).
  if (hadTracer) otelTrace.disable();
  if (hadMeter) {
    otelMetrics.disable();
    // Rebind the core facade's instrument cache back to the no-op meter so
    // getMetrics() after disable is inert rather than holding dead instruments.
    const { rebuildMetrics } = await import('@origintrail-official/dkg-core');
    rebuildMetrics();
  }
  tracerProvider = null;
  meterProvider = null;
  configured = false;
}

/**
 * @deprecated No-op compatibility shim for the pre-PR #1317 telemetry API. Node
 * metrics flow through the `@origintrail-official/dkg-core` facade
 * (`getMetrics()`), not this call. Kept so old callers don't break at import.
 */
export function recordGauge(_name: string, _value: number): void {
  /* no-op (browser-safe): real metrics go through getMetrics() */
}

/**
 * @deprecated No-op compatibility shim for the pre-PR #1317 telemetry API. Spans
 * are created via the core facade `withSpan()`/`getTracer()`. Kept so old
 * callers don't break at import.
 */
export function setOperationSpan(_operationId: string, _operationName: string): void {
  /* no-op (browser-safe): real spans go through withSpan() */
}
