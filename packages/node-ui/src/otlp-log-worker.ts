/**
 * OTLP/HTTP log exporter — ships structured log records to an OpenTelemetry
 * collector (or any OTLP/HTTP logs endpoint) as a second, opt-in sink
 * alongside the always-on local SQLite store.
 *
 * Why hand-rolled rather than @opentelemetry/sdk-logs: as of 2026 the OTel JS
 * Logs SDK is still "Development" (Traces/Metrics are Stable). We emit the
 * stable OTLP/HTTP JSON wire format (ExportLogsServiceRequest) directly and
 * reuse the buffer/flush/backoff shape proven by the syslog LogPushWorker.
 *
 * Reliability contract (this must NEVER slow down or crash the node):
 *  - push() only appends to a bounded in-memory buffer (drop-oldest on
 *    overflow) and returns immediately; it never awaits the network.
 *  - flush() runs on a timer, is guarded against overlap, and swallows every
 *    error. On a retryable failure the batch is requeued and an exponential
 *    backoff (with jitter, honoring Retry-After) is applied. On a
 *    non-retryable failure the batch is dropped (logged once).
 *  - The flush timer is unref'd so it never keeps the process alive.
 *  - Transport is outbound HTTPS push only — no inbound scrape endpoint.
 */

import type { LogRecord } from '@origintrail-official/dkg-core';

// OpenTelemetry severity numbers (logs data model).
const OTEL_SEVERITY: Record<string, { num: number; text: string }> = {
  debug: { num: 5, text: 'DEBUG' },
  info: { num: 9, text: 'INFO' },
  warn: { num: 13, text: 'WARN' },
  error: { num: 17, text: 'ERROR' },
};

const LEVEL_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const DEFAULTS = {
  flushIntervalMs: 2_000,
  maxBuffer: 500,
  maxBatch: 256,
  requestTimeoutMs: 10_000,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  serviceName: 'dkg-node',
  minLevel: 'info',
};

export interface OtlpLogWorkerOptions {
  /** Full OTLP/HTTP logs URL, e.g. http://localhost:4318/v1/logs */
  endpoint: string;
  /** Bearer credential for the collector (sent as Authorization: Bearer …). */
  token?: string;
  /** Extra static headers to attach to every request. */
  headers?: Record<string, string>;
  /** Network identifier: 'testnet' | 'mainnet' | 'devnet'. */
  network: string;
  /** Node's libp2p peer ID. */
  peerId: string;
  nodeName?: string;
  version?: string;
  commit?: string;
  /** 'core' | 'edge' */
  role?: string;
  /** OTel resource service.name. Default 'dkg-node'. */
  serviceName?: string;
  /** Minimum level forwarded remotely. Default 'info' (debug stays local). */
  minLevel?: string;
  /** Bounded in-memory buffer; drop-oldest on overflow. Default 500. */
  bufferMaxEntries?: number;
  flushIntervalMs?: number;
  requestTimeoutMs?: number;
  /** Initial retry backoff in ms (doubles up to maxBackoffMs). Default 1000. */
  baseBackoffMs?: number;
  /** Ceiling for retry backoff in ms. Default 60000. */
  maxBackoffMs?: number;
  /** Optional diagnostic sink (e.g. the daemon log). Never throws. */
  onError?: (message: string) => void;
}

interface OtlpAttribute {
  key: string;
  value: { stringValue: string };
}

function attr(key: string, value: string | undefined): OtlpAttribute | null {
  if (value == null || value === '') return null;
  return { key, value: { stringValue: String(value) } };
}

export class OtlpLogWorker {
  private buffer: Array<{ r: LogRecord; tsMs: number }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private flushing = false;
  private nextAttemptAt = 0;
  private backoffMs = 0;
  private droppedNonRetryable = 0;
  private loggedNonRetryable = false;

  private readonly endpoint: string;
  private readonly minRank: number;
  private readonly maxBuffer: number;
  private readonly flushIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly authHeaders: Record<string, string>;
  private readonly resourceAttrs: OtlpAttribute[];
  private readonly scopeVersion: string | undefined;
  private readonly onError: (message: string) => void;

  constructor(opts: OtlpLogWorkerOptions) {
    this.endpoint = opts.endpoint;
    this.minRank = LEVEL_RANK[opts.minLevel ?? DEFAULTS.minLevel] ?? LEVEL_RANK.info;
    this.maxBuffer = Math.max(1, opts.bufferMaxEntries ?? DEFAULTS.maxBuffer);
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULTS.flushIntervalMs;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    this.baseBackoffMs = opts.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.scopeVersion = opts.version || undefined;
    this.onError = opts.onError ?? (() => {});

    this.authHeaders = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    if (opts.token) this.authHeaders['authorization'] = `Bearer ${opts.token}`;

    this.resourceAttrs = [
      attr('service.name', opts.serviceName ?? DEFAULTS.serviceName),
      attr('service.version', opts.version),
      attr('dkg.network', opts.network),
      attr('dkg.peer_id', opts.peerId),
      attr('dkg.node_name', opts.nodeName),
      attr('dkg.node_role', opts.role),
      attr('dkg.commit', opts.commit),
    ].filter((a): a is OtlpAttribute => a !== null);
  }

  /** Append a record. Filters below minLevel; never awaits the network. */
  push(record: LogRecord): void {
    if ((LEVEL_RANK[record.level] ?? LEVEL_RANK.info) < this.minRank) return;
    if (this.buffer.length >= this.maxBuffer) this.buffer.shift();
    this.buffer.push({ r: record, tsMs: Date.now() });
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Best-effort final flush; failures are swallowed.
    void this.flush(true);
  }

  /** Test/diagnostic hook. */
  pending(): number {
    return this.buffer.length;
  }

  private async flush(force = false): Promise<void> {
    if (this.flushing) return;
    if (this.stopped && !force) return;
    if (this.buffer.length === 0) return;
    if (!force && Date.now() < this.nextAttemptAt) return;

    this.flushing = true;
    const batch = this.buffer.splice(0, DEFAULTS.maxBatch);
    try {
      const body = this.buildPayload(batch);
      const res = await this.post(body);
      if (res.ok) {
        this.backoffMs = 0;
        this.nextAttemptAt = 0;
      } else if (RETRYABLE_STATUS.has(res.status)) {
        this.requeue(batch);
        this.scheduleBackoff(res.retryAfterMs);
      } else {
        // Non-retryable (e.g. 400/401/403): dropping is correct — retrying
        // a malformed/unauthorized request forever would just grow the buffer.
        this.droppedNonRetryable += batch.length;
        if (!this.loggedNonRetryable) {
          this.loggedNonRetryable = true;
          this.onError(`dropping logs — collector returned ${res.status} (non-retryable); check endpoint/token`);
        }
      }
    } catch (err) {
      // Network/timeout error → treat as retryable.
      this.requeue(batch);
      this.scheduleBackoff();
      void err;
    } finally {
      this.flushing = false;
    }
  }

  private requeue(batch: Array<{ r: LogRecord; tsMs: number }>): void {
    this.buffer.unshift(...batch);
    while (this.buffer.length > this.maxBuffer) this.buffer.shift();
  }

  private scheduleBackoff(retryAfterMs?: number): void {
    const next = this.backoffMs === 0 ? this.baseBackoffMs : Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.backoffMs = next;
    const jitter = next * 0.2 * Math.random();
    const delay = retryAfterMs != null ? Math.max(retryAfterMs, next) : next + jitter;
    this.nextAttemptAt = Date.now() + delay;
  }

  private async post(body: string): Promise<{ ok: boolean; status: number; retryAfterMs?: number }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.requestTimeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.authHeaders,
        body,
        signal: ac.signal,
      });
      // Drain the body so the socket can be reused / freed.
      await res.arrayBuffer().catch(() => {});
      let retryAfterMs: number | undefined;
      const ra = res.headers.get('retry-after');
      if (ra) {
        const secs = Number(ra);
        if (!Number.isNaN(secs)) retryAfterMs = secs * 1000;
      }
      return { ok: res.ok, status: res.status, retryAfterMs };
    } finally {
      clearTimeout(timer);
    }
  }

  private buildPayload(batch: Array<{ r: LogRecord; tsMs: number }>): string {
    const logRecords = batch.map(({ r, tsMs }) => {
      const sev = OTEL_SEVERITY[r.level] ?? OTEL_SEVERITY.info;
      const nano = String(tsMs * 1_000_000);
      return {
        timeUnixNano: nano,
        observedTimeUnixNano: nano,
        severityNumber: sev.num,
        severityText: sev.text,
        body: { stringValue: r.message },
        attributes: [
          attr('dkg.operation_id', r.operationId),
          attr('dkg.operation_name', r.operationName),
          attr('dkg.source_operation_id', r.sourceOperationId),
          attr('dkg.module', r.module),
        ].filter((a): a is OtlpAttribute => a !== null),
      };
    });

    return JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: this.resourceAttrs },
          scopeLogs: [
            {
              scope: { name: 'dkg-node', version: this.scopeVersion },
              logRecords,
            },
          ],
        },
      ],
    });
  }
}
