import type { DkgConfig } from './config.js';

/**
 * Pure resolution of the daemon's telemetry routing — extracted from
 * `lifecycle.ts` so it is unit-testable (endpoint precedence, no-TBD-default,
 * per-signal gating, log-exporter selection).
 */

export type LogExporterMode = 'none' | 'otlp' | 'syslog';

/**
 * Which log exporter the daemon should start. Only consulted when
 * `telemetry.enabled`. Defaults to 'syslog' (preserves prior behaviour).
 */
export function resolveLogExporterMode(telemetry: DkgConfig['telemetry']): LogExporterMode {
  return telemetry?.logs?.exporter ?? 'syslog';
}

export interface ResolvedOtelSignals {
  tracesEndpoint?: string;
  metricsEndpoint?: string;
  /** Register traces only when an endpoint resolves AND not explicitly disabled. */
  tracesOn: boolean;
  metricsOn: boolean;
}

/**
 * Resolve OTLP traces/metrics endpoints env-first (standard `OTEL_EXPORTER_OTLP_*`
 * names) then config. A signal is "on" only when an endpoint resolves and it is
 * not explicitly disabled — there is NO guessed/TBD production default.
 */
export function resolveOtelSignals(
  telemetry: DkgConfig['telemetry'],
  env: Record<string, string | undefined> = process.env,
): ResolvedOtelSignals {
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, '');
  const tracesEndpoint =
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    (base ? `${base}/v1/traces` : undefined) ||
    telemetry?.traces?.endpoint;
  const metricsEndpoint =
    env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
    (base ? `${base}/v1/metrics` : undefined) ||
    telemetry?.metrics?.endpoint;
  return {
    tracesEndpoint,
    metricsEndpoint,
    tracesOn: !!tracesEndpoint && telemetry?.traces?.enabled !== false,
    metricsOn: !!metricsEndpoint && telemetry?.metrics?.enabled !== false,
  };
}
