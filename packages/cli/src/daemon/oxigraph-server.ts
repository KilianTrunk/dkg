/**
 * Supervised local Oxigraph server (Release 2, phase 2b lifecycle; used
 * opt-in in 2a via `store.backend: 'oxigraph-server'`).
 *
 * # What this is
 *
 * The DKG daemon spawns a single `oxigraph serve` child bound to
 * loopback, health-checks it before the agent boots, and restarts it
 * (with backoff) if it dies unexpectedly. The agent then talks to it over
 * the existing `sparql-http` adapter — this module owns only the child
 * process lifecycle, not the SPARQL traffic.
 *
 * Moving the triple store out of the in-process Oxigraph worker into this
 * external server is what buys MVCC concurrent reads (reads stop blocking
 * on the single writer) and incremental RocksDB persistence (no
 * O(total-triples) full-dump flush).
 *
 * # Security
 *
 * `oxigraph serve` has no native authentication (upstream documents auth
 * as an nginx-proxy concern). For a daemon-managed *local* server the
 * security boundary is therefore the loopback bind (`127.0.0.1`): the
 * endpoint is never exposed off-host. We do NOT send an Authorization
 * header to the managed server because it would be meaningless — the
 * `sparql-http` adapter's `auth` option remains for operators pointing at
 * their own externally-secured SPARQL endpoint.
 *
 * # Shutdown ordering
 *
 * The handle's `stop()` sets a `stopping` flag (so the exit handler does
 * NOT restart), sends SIGTERM, and escalates to SIGKILL after a grace
 * period. Callers must stop the server AFTER the agent has stopped
 * issuing store queries, so an in-flight SPARQL request never races a
 * killed child.
 *
 * `spawn`/`fetch` are injectable so unit tests exercise ready-polling,
 * crash-restart, and shutdown without launching a real binary.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface OxigraphServerIo {
  spawn: typeof spawn;
  fetch: typeof globalThis.fetch;
}

export interface StartOxigraphServerOptions {
  /** Absolute path to the verified `oxigraph` binary. */
  binaryPath: string;
  /** RocksDB storage directory (`--location`). */
  location: string;
  /** Bind host. Always loopback in production; overridable for tests. */
  host?: string;
  /** Bind port. */
  port: number;
  log?: (msg: string) => void;
  /** Total time to wait for the server to answer before failing start. */
  readyTimeoutMs?: number;
  /** Poll interval while waiting for readiness. */
  readyIntervalMs?: number;
  /** Grace period between SIGTERM and SIGKILL on stop. */
  stopGraceMs?: number;
  /** Base delay for restart backoff after an unexpected crash. */
  restartBackoffBaseMs?: number;
  /** Cap for restart backoff. */
  restartBackoffMaxMs?: number;
  io?: Partial<OxigraphServerIo>;
}

export interface OxigraphServerHandle {
  readonly host: string;
  readonly port: number;
  readonly queryEndpoint: string;
  readonly updateEndpoint: string;
  /** Stop the server and prevent further restarts. Idempotent. */
  stop(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_INTERVAL_MS = 500;
const DEFAULT_STOP_GRACE_MS = 5_000;
const DEFAULT_RESTART_BASE_MS = 1_000;
const DEFAULT_RESTART_MAX_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Spawn and health-check a local Oxigraph server. Resolves once the
 * server answers an `ASK` probe; rejects if it never becomes ready within
 * `readyTimeoutMs` (the child is killed first so we don't leak it).
 */
export async function startOxigraphServer(
  opts: StartOxigraphServerOptions,
): Promise<OxigraphServerHandle> {
  const io: OxigraphServerIo = { spawn, fetch: globalThis.fetch, ...opts.io };
  const log = opts.log ?? (() => {});
  const host = opts.host ?? DEFAULT_HOST;
  const { port } = opts;
  const bind = `${host}:${port}`;
  const base = `http://${host}:${port}`;
  const queryEndpoint = `${base}/query`;
  const updateEndpoint = `${base}/update`;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const readyIntervalMs = opts.readyIntervalMs ?? DEFAULT_READY_INTERVAL_MS;
  const stopGraceMs = opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const restartBase = opts.restartBackoffBaseMs ?? DEFAULT_RESTART_BASE_MS;
  const restartMax = opts.restartBackoffMaxMs ?? DEFAULT_RESTART_MAX_MS;

  let stopping = false;
  let child: ChildProcess | null = null;
  let restarts = 0;

  const spawnChild = (): ChildProcess => {
    const c = io.spawn(
      opts.binaryPath,
      ['serve', '--location', opts.location, '--bind', bind],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    c.stderr?.on('data', (b) => {
      const line = b.toString('utf-8').trim();
      if (line) log(`[oxigraph] ${line}`);
    });
    c.once('exit', (code, signal) => {
      if (stopping) return;
      // Unexpected exit — restart with capped exponential backoff so a
      // crash-looping binary doesn't peg the CPU. The store will surface
      // transient errors to callers during the gap; the agent's own
      // retries cover the window.
      restarts += 1;
      const delay = Math.min(restartMax, restartBase * 2 ** (restarts - 1));
      log(
        `[oxigraph] server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}); ` +
          `restart #${restarts} in ${delay}ms`,
      );
      setTimeout(() => {
        if (stopping) return;
        child = spawnChild();
      }, delay).unref?.();
    });
    return c;
  };

  const probeReady = async (): Promise<boolean> => {
    try {
      const res = await io.fetch(queryEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query',
          Accept: 'application/sparql-results+json',
        },
        body: 'ASK { ?s ?p ?o }',
        signal: AbortSignal.timeout(readyIntervalMs + 1_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const c = child;
    child = null;
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      c.once('exit', done);
      c.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (c.exitCode === null && c.signalCode === null) {
          log('[oxigraph] did not exit on SIGTERM; sending SIGKILL');
          c.kill('SIGKILL');
        }
      }, stopGraceMs);
      killTimer.unref?.();
    });
    log('[oxigraph] server stopped');
  };

  log(`Starting Oxigraph server on ${bind} (location: ${opts.location})…`);
  child = spawnChild();

  const deadline = Date.now() + readyTimeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    if (await probeReady()) {
      log(`Oxigraph server ready on ${bind} after ${attempt} probe(s).`);
      return { host, port, queryEndpoint, updateEndpoint, stop };
    }
    // If the child already died and we're not mid-restart, bail early
    // rather than waiting out the whole timeout on a dead process.
    if (child && child.exitCode !== null && restarts === 0) {
      break;
    }
    await sleep(readyIntervalMs);
  }

  // Never became ready — stop the child so we don't leak it, then throw.
  await stop();
  throw new Error(
    `Oxigraph server did not become ready on ${bind} within ${readyTimeoutMs}ms ` +
      `(binary: ${opts.binaryPath}, location: ${opts.location}).`,
  );
}
