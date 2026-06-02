/**
 * Real-Blazegraph end-to-end integration test (RFC 120, plan PR 3
 * §"Real-Blazegraph integration test (opt-in)").
 *
 * What this proves that the mocked tests can't
 * ------------------------------------------------
 * The unit tests for `BlazegraphStore`, `provisionBlazegraphDocker`,
 * `chainResetWipe`, and `checkOrSetStoreIdentity` all use a fake fetch
 * to verify *what we send*. They can't catch:
 *
 *   - Blazegraph protocol divergences (response shapes, status codes,
 *     content negotiation quirks, namespace creation race conditions).
 *   - SPARQL semantics for `DROP ALL` vs scoped DELETE (does Blazegraph
 *     actually leave non-V10 named graphs alone? does `DROP ALL`
 *     clean up the namespace metadata or just the data?).
 *   - Docker run/inspect contract drift (lyrasis/blazegraph:2.1.5 has
 *     been frozen for years, but Docker behavioural changes —
 *     log-driver defaults, port-binding shape — can still bite).
 *   - The identity tag round-trip against real SPARQL UPDATE parsing.
 *
 * This test wires the full Docker → BlazegraphStore → chainResetWipe →
 * identity-tag pipeline against a real container.
 *
 * Why it's opt-in
 * ----------------
 * Spinning up a Blazegraph container takes 30-60 s on a cold machine
 * (image pull + JVM warmup) which is too slow for CI per-PR. Gate via
 * `BLAZEGRAPH_INTEGRATION_TEST=1`. Run locally with:
 *
 *   BLAZEGRAPH_INTEGRATION_TEST=1 npx vitest run \
 *     --config vitest.unit.config.ts test/blazegraph-integration.test.ts
 *
 * The test self-cleans the container on teardown even when individual
 * cases fail, so re-running the suite is idempotent.
 *
 * Apple Silicon (arm64) caveat
 * -----------------------------
 * `lyrasis/blazegraph:2.1.5` is published as `linux/amd64` only — the
 * upstream Blazegraph project at github.com/blazegraph was archived in
 * March 2026 and no longer publishes new images. We pin this tag for
 * mainnet + devnet.sh parity.
 *
 * On Apple Silicon Macs the image runs under QEMU emulation (or
 * Rosetta on macOS 14.1+ with Docker Desktop ≥ 4.25). The JVM startup
 * under emulation can take much longer than the 30-second default,
 * and the QEMU path is known to crash Docker Desktop entirely under
 * sustained JVM warmup on some machines. To improve odds:
 *
 *   - Docker Desktop → Settings → General → "Use Rosetta for x86_64
 *     emulation" (enabled by default on macOS 14.1+).
 *   - Bumped `pollTimeoutMs` in `beforeAll` below from 30 s to 120 s.
 *
 * If your `beforeAll` fails with "Blazegraph did not become ready
 * within 120000ms" on an arm64 host, the test is correctly designed
 * but the JVM emulation is overloading your Docker Desktop. Re-run on
 * an amd64 box (CI / Linux server). The mocked unit-tests still cover
 * the contract.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { BlazegraphStore } from '@origintrail-official/dkg-storage';
import {
  provisionBlazegraphDocker,
  isDockerAvailable,
  type ProvisionBlazegraphDockerResult,
} from '../src/daemon/blazegraph-docker.js';
import { chainResetWipe } from '../src/daemon/chain-reset-wipe.js';
import {
  checkOrSetStoreIdentity,
} from '../src/daemon/store-health-check.js';

const ENABLED = process.env.BLAZEGRAPH_INTEGRATION_TEST === '1';

const V10_GRAPH = 'did:dkg:context-graph:integration-test';
const OTHER_GRAPH = 'urn:other-app:integration-cotenant';

function execDocker(args: readonly string[], timeoutMs = 30_000): Promise<void> {
  return new Promise<void>((resolve) => {
    const child = spawn('docker', [...args], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.once('error', () => { clearTimeout(timer); resolve(); });
  });
}

describe.skipIf(!ENABLED)('Blazegraph end-to-end integration', () => {
  let provisioned: ProvisionBlazegraphDockerResult | null = null;
  let store: BlazegraphStore | null = null;
  let dataDir: string;
  // Each test suite run uses a fresh namespace so a re-run doesn't see
  // stale identity tags or stale quads from the previous run. The
  // container is reused (idempotent provisioner), only the namespace
  // is new.
  const namespace = `integ-${process.pid}-${Date.now().toString(36)}`;

  beforeAll(async () => {
    if (!(await isDockerAvailable())) {
      throw new Error(
        'BLAZEGRAPH_INTEGRATION_TEST=1 but `docker --version` failed. ' +
        'Install Docker or unset the env var to skip the test.',
      );
    }

    dataDir = await mkdtemp(join(tmpdir(), 'dkg-blaze-integ-'));

    provisioned = await provisionBlazegraphDocker({
      namespace,
      // Use a low port-range cap so multiple parallel runs on the same
      // host don't collide indefinitely; integration runs sequentially
      // in practice.
      portRange: 12,
      // 120 s instead of the 30 s provisioner default — JVM warmup
      // under amd64-via-QEMU/Rosetta on Apple Silicon can take 60 s+.
      // On native amd64 this is still essentially "as fast as the
      // container becomes ready", since we poll every second.
      pollTimeoutMs: 120_000,
      log: () => {},
    });

    store = new BlazegraphStore(provisioned.url);
  }, /* timeoutMs */ 180_000);

  afterAll(async () => {
    try { await store?.close(); } catch { /* ignore */ }
    // Best-effort container cleanup. We only destroy the container if
    // it was freshly created; reusing a pre-existing container is a
    // hint the operator wants to keep it around.
    if (provisioned && !provisioned.reused) {
      await execDocker(['rm', '-f', provisioned.containerName]);
    }
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, /* timeoutMs */ 60_000);

  // -----------------------------------------------------------------
  // Adapter round-trip — insert / query / count / delete patterns.
  // -----------------------------------------------------------------

  it('insert + SELECT count → real Blazegraph returns the right total', async () => {
    expect(store).not.toBeNull();
    await store!.insert([
      { subject: 'urn:integ:s1', predicate: 'urn:integ:p', object: 'urn:integ:o1', graph: V10_GRAPH },
      { subject: 'urn:integ:s2', predicate: 'urn:integ:p', object: 'urn:integ:o2', graph: V10_GRAPH },
      { subject: 'urn:integ:s3', predicate: 'urn:integ:p', object: 'urn:integ:o3', graph: V10_GRAPH },
    ]);
    const count = await store!.countQuads(V10_GRAPH);
    expect(count).toBe(3);
  });

  it('ASK over real Blazegraph returns the right boolean', async () => {
    const result = await store!.query(
      `ASK { GRAPH <${V10_GRAPH}> { <urn:integ:s1> ?p ?o } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') {
      expect(result.value).toBe(true);
    }
  });

  it('deleteByPattern reduces the count', async () => {
    const before = await store!.countQuads(V10_GRAPH);
    const removed = await store!.deleteByPattern({
      subject: 'urn:integ:s2',
      graph: V10_GRAPH,
    });
    expect(removed).toBeGreaterThanOrEqual(1);
    const after = await store!.countQuads(V10_GRAPH);
    expect(after).toBe(before - removed);
  });

  // -----------------------------------------------------------------
  // Scoped DELETE — the safety guarantee for shared instances.
  // -----------------------------------------------------------------

  it('chainResetWipe scoped DELETE leaves non-V10 named graphs alone', async () => {
    // Seed: V10 data in did:dkg:context-graph:* + co-tenant data in a
    // non-V10 graph. The scoped wipe must remove the V10 quads and
    // preserve the co-tenant ones.
    await store!.insert([
      { subject: 'urn:integ:scoped-v10', predicate: 'urn:p', object: 'urn:o', graph: V10_GRAPH },
      { subject: 'urn:integ:cotenant', predicate: 'urn:p', object: 'urn:o', graph: OTHER_GRAPH },
    ]);
    expect(await store!.countQuads(V10_GRAPH)).toBeGreaterThan(0);
    expect(await store!.countQuads(OTHER_GRAPH)).toBeGreaterThan(0);

    // First call seeds the marker so the second is recognised as a
    // chain-reset event.
    await chainResetWipe({
      dataDir,
      currentMarker: 'seed-marker',
      storeConfig: {
        backend: 'blazegraph',
        options: { url: provisioned!.url, managedByDkg: false },
      },
    });

    // Now bump the marker → scoped DELETE on the remote.
    const wipe = await chainResetWipe({
      dataDir,
      currentMarker: 'bumped-marker',
      storeConfig: {
        backend: 'blazegraph',
        options: { url: provisioned!.url, managedByDkg: false },
      },
    });
    expect(wipe.wiped).toBe(true);
    expect(wipe.failedFiles).toEqual([]);

    expect(await store!.countQuads(V10_GRAPH)).toBe(0);
    // Critical assertion: co-tenant data survived.
    expect(await store!.countQuads(OTHER_GRAPH)).toBeGreaterThan(0);

    // Cleanup so subsequent tests don't see the co-tenant quad.
    await store!.deleteByPattern({ graph: OTHER_GRAPH });
  });

  // -----------------------------------------------------------------
  // DROP ALL — fast path for DKG-managed namespaces.
  // -----------------------------------------------------------------

  it('chainResetWipe managedByDkg=true issues DROP ALL — wipes every graph', async () => {
    await store!.insert([
      { subject: 'urn:integ:drop-v10', predicate: 'urn:p', object: 'urn:o', graph: V10_GRAPH },
      { subject: 'urn:integ:drop-other', predicate: 'urn:p', object: 'urn:o', graph: OTHER_GRAPH },
    ]);

    // Marker has to differ from the persisted one to trigger the wipe.
    const wipe = await chainResetWipe({
      dataDir,
      currentMarker: 'drop-all-marker',
      storeConfig: {
        backend: 'blazegraph',
        options: { url: provisioned!.url, managedByDkg: true },
      },
    });
    expect(wipe.wiped).toBe(true);
    expect(wipe.failedFiles).toEqual([]);

    // Both graphs gone — DROP ALL is unconditional.
    expect(await store!.countQuads(V10_GRAPH)).toBe(0);
    expect(await store!.countQuads(OTHER_GRAPH)).toBe(0);
  });

  // -----------------------------------------------------------------
  // Namespace identity tag round-trip.
  // -----------------------------------------------------------------

  it('checkOrSetStoreIdentity round-trips against a real namespace', async () => {
    // The provisioner-created namespace starts with no identity tag.
    // Use a fresh sub-namespace so the round-trip is deterministic
    // regardless of test order: clear any prior tag first.
    await store!.dropGraph('urn:dkg:store-meta');

    const first = await checkOrSetStoreIdentity({
      storeConfig: {
        backend: 'blazegraph',
        options: { url: provisioned!.url },
      },
      nodeName: 'alice-integ',
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.action).toBe('tagged');

    const second = await checkOrSetStoreIdentity({
      storeConfig: {
        backend: 'blazegraph',
        options: { url: provisioned!.url },
      },
      nodeName: 'alice-integ',
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.action).toBe('matched');

    const third = await checkOrSetStoreIdentity({
      storeConfig: {
        backend: 'blazegraph',
        options: { url: provisioned!.url },
      },
      nodeName: 'bob-integ',
    });
    expect(third.ok).toBe(false);
    if (!third.ok && third.action === 'mismatch') {
      expect(third.existingNodeName).toBe('alice-integ');
      expect(third.expectedNodeName).toBe('bob-integ');
    }
  });

  // -----------------------------------------------------------------
  // Provisioner idempotency — second call reuses the running container.
  // -----------------------------------------------------------------

  it('provisionBlazegraphDocker second call reuses the running container', async () => {
    const again = await provisionBlazegraphDocker({
      namespace,
      log: () => {},
    });
    expect(again.containerName).toBe(provisioned!.containerName);
    expect(again.port).toBe(provisioned!.port);
    expect(again.reused).toBe(true);
    // Namespace was created on first run; second run must NOT try to
    // re-create it (Blazegraph 409s on duplicates).
    expect(again.namespaceCreated).toBe(false);
  });
});

// When BLAZEGRAPH_INTEGRATION_TEST is unset, vitest still runs this
// file but `describe.skipIf(!ENABLED)` makes every case a no-op. Print
// a one-liner so contributors discover the env-var.
if (!ENABLED) {
  // eslint-disable-next-line no-console
  console.log(
    '[blazegraph-integration] SKIPPED — set BLAZEGRAPH_INTEGRATION_TEST=1 to enable.',
  );
}
