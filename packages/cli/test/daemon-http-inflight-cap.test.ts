import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, authHeaders, type LiveDaemon } from './helpers/live-daemon.js';

/**
 * Real-node admission-control test. Boots an actual daemon with the in-flight
 * cap pinned to 1 (via config) and verifies, against the LIVE HTTP request
 * path, that it sheds concurrent over-capacity load with 503 + Retry-After,
 * keeps the exempt liveness path answerable, and recovers once slots free.
 *
 * This is the end-to-end counterpart to the unit tests in
 * http-admission-control.test.ts: it would fail if the limiter were never wired
 * into createServer, wired after an early return, or never released.
 */
describe('daemon admission control (real node, maxInFlightRequests=1)', () => {
  let daemon: LiveDaemon | undefined;

  beforeAll(async () => {
    daemon = await startLiveDaemon({ authEnabled: true, extraConfig: { maxInFlightRequests: 1 } });
  }, 90_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
  }, 30_000);

  // Non-exempt endpoint that awaits the store, so concurrent calls overlap and
  // contend for the single in-flight slot.
  function selectQuery(d: LiveDaemon): Promise<Response> {
    return fetch(`${d.base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(d) },
      body: JSON.stringify({ sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1' }),
    });
  }

  it('sheds concurrent over-capacity requests with 503 + Retry-After, then recovers', async () => {
    const d = daemon!;
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        selectQuery(d)
          .then((r) => ({ status: r.status, retryAfter: r.headers.get('retry-after') }))
          .catch(() => ({ status: 0, retryAfter: null as string | null })),
      ),
    );
    const shed = results.filter((r) => r.status === 503);
    const ok = results.filter((r) => r.status === 200);

    expect(ok.length).toBeGreaterThan(0); // at least one admitted
    expect(shed.length).toBeGreaterThan(0); // cap enforced under concurrent load
    expect(shed.every((r) => r.retryAfter === '1')).toBe(true); // Retry-After present on every 503

    // Slots are released after each handler completes → a fresh request succeeds.
    const recovered = await selectQuery(d);
    expect(recovered.status).toBe(200);
  }, 60_000);

  it('never sheds the exempt liveness path (/api/status) under saturation', async () => {
    const d = daemon!;
    // Saturate with non-exempt query work (not awaited yet)...
    const burst = Promise.all(Array.from({ length: 40 }, () => selectQuery(d).catch(() => null)));
    // ...while hammering the exempt status endpoint, which must always answer 200.
    const statuses = await Promise.all(
      Array.from({ length: 12 }, () =>
        fetch(`${d.base}/api/status`, { headers: authHeaders(d) })
          .then((r) => r.status)
          .catch(() => 0),
      ),
    );
    await burst;
    expect(statuses.every((s) => s === 200)).toBe(true);
  }, 60_000);
});
