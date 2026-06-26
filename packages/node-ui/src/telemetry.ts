/**
 * OpenTelemetry SDK bootstrap for a DKG node (boot side, daemon-only consumer).
 *
 * Registers the global Tracer + Meter providers ONCE at daemon startup so that
 * the call-site facade in `@origintrail-official/dkg-core` (getTracer/withSpan/
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
 * This file is server-only (it pulls the Node OTel SDK). It must never be
 * imported into the browser UI bundle.
 */

import { metrics as otelMetrics, trace as otelTrace } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  NodeTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { rebuildMetrics } from '@origintrail-official/dkg-core';

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
}

export interface TelemetryInitConfig {
  /** Master gate. When false, nothing is registered. */
  enabled?: boolean;
  resource?: TelemetryResource;
  traces?: OtlpSignalConfig & { sampleRatio?: number };
  metrics?: OtlpSignalConfig & { exportIntervalMs?: number };
}

let tracerProvider: NodeTracerProvider | null = null;
let meterProvider: MeterProvider | null = null;
let configured = false;

function buildResource(r: TelemetryResource = {}) {
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
  return resourceFromAttributes(attrs);
}

function authHeaders(sig: OtlpSignalConfig): Record<string, string> | undefined {
  const headers = { ...(sig.headers ?? {}) };
  if (sig.token) headers['Authorization'] = `Bearer ${sig.token}`;
  return Object.keys(headers).length ? headers : undefined;
}

/**
 * Initialize traces + metrics. No-op when disabled or when a signal has no
 * endpoint. Safe to call once at daemon boot. Idempotent (subsequent calls are
 * ignored once configured).
 */
export function initTelemetry(cfg: TelemetryInitConfig): void {
  if (configured) return;
  if (!cfg.enabled) return;

  const resource = buildResource(cfg.resource);

  // ── Traces ──
  if (cfg.traces?.endpoint) {
    const exporter = new OTLPTraceExporter({
      url: cfg.traces.endpoint,
      headers: authHeaders(cfg.traces),
    });
    const ratio = cfg.traces.sampleRatio ?? 1;
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
  if (cfg.metrics?.endpoint) {
    const exporter = new OTLPMetricExporter({
      url: cfg.metrics.endpoint,
      headers: authHeaders(cfg.metrics),
    });
    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: cfg.metrics.exportIntervalMs ?? 30_000,
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
  if (tracerProvider) otelTrace.disable();
  if (meterProvider) {
    otelMetrics.disable();
    // Rebind the core facade's instrument cache back to the no-op meter so
    // getMetrics() after disable is inert rather than holding dead instruments.
    rebuildMetrics();
  }
  tracerProvider = null;
  meterProvider = null;
  configured = false;
}
