/**
 * Core-peers features — devnet validation of the chain-driven VM
 * reconciliation effort (Phases B / C / D / E / F).
 *
 * Confirms, against a live 6-node devnet (4 core + 2 edge), that the
 * "full Telegram on top of chain" stack is functional end-to-end:
 *
 *   Phase F — every node serves the `/api/replication/*` surface
 *             (summary / per-cg / timeline / cursors / events) backed by the
 *             V19 `replication_events` table. (Pure API/DB wiring check.)
 *
 *   Phase B + E — publishing a KA to a public CG drives the chain-driven VM
 *             reconciler: cores accumulate replication telemetry, the per-CG
 *             contiguous watermark advances past 0, and the daemon log carries
 *             the structured `chain-promote` grep surface.
 *
 *   Phase D (recording) — when a core signs a StorageACK for a PUBLIC CG it
 *             marks the CG `coreHosted` (cursor inspector Role = host),
 *             persisted across restart.
 *
 *   Phase D (fill-the-gap, headline) — a core taken OFFLINE during a publish
 *             learns the missed KA from chain on restart and fills its own gap
 *             (observable as a `core-fill` replication event and/or the missed
 *             triple landing in that core's verified-memory).
 *
 *   Phase C — the `sinceBatchId` delta-sync hint is an additive, unsigned,
 *             backward-compatible protocol field with no active production
 *             caller yet (the contiguous-watermark resolver is intentionally
 *             unwired). We assert only that normal catch-up sync is unaffected
 *             — its responder/envelope behaviour is pinned by the agent unit
 *             tests (`sync-responder-cursor`, `sync-envelope-cursor`).
 *
 * Preconditions:
 *   pnpm run build
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *
 * Run:
 *   pnpm test:devnet:core-peers-features
 *
 * Runtime: ~3-6 minutes (the fill-the-gap test stops + restarts a core and
 * waits a couple of reconcile sweeps).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as http from 'node:http';
import { ethers } from 'ethers';

// ───────────────────────────── constants ─────────────────────────────────
const REPO_ROOT = resolve(__dirname, '../..');
const DEVNET_DIR = join(REPO_ROOT, '.devnet');
/** RPC is read from node1's config (devnet.sh wires it from HARDHAT_PORT), so a
 *  non-default Hardhat port works without editing the test. */
function detectRpc(): string {
  if (process.env.DEVNET_RPC) return process.env.DEVNET_RPC;
  try {
    const cfg = JSON.parse(readFileSync(join(DEVNET_DIR, 'node1', 'config.json'), 'utf8'));
    if (cfg?.chain?.rpcUrl) return cfg.chain.rpcUrl;
  } catch { /* fall through */ }
  return 'http://127.0.0.1:8545';
}
const RPC = detectRpc();
const DEVNET_SH = join(REPO_ROOT, 'scripts/devnet.sh');
const CONTEXT_GRAPH = 'devnet-test';
const CORE_NODES = [1, 2, 3, 4];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── node harness ──────────────────────────────
interface DevnetNode {
  num: number;
  apiPort: number;
  home: string;
  authToken: string;
}

function readNodeConfig(num: number): DevnetNode {
  const home = join(DEVNET_DIR, `node${num}`);
  if (!existsSync(home)) {
    throw new Error(`Devnet node${num} home missing — run ./scripts/devnet.sh start 6 first`);
  }
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  let authToken = '';
  if (existsSync(join(home, 'auth.token'))) {
    authToken =
      readFileSync(join(home, 'auth.token'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith('#')) ?? '';
  }
  return { num, apiPort: config.apiPort, home, authToken };
}

function api(node: DevnetNode): string {
  return `http://127.0.0.1:${node.apiPort}`;
}

/** Port env for `devnet.sh restart-node`, derived from node1's config so the
 *  restart matches whatever (possibly non-default) ports this devnet uses. */
function devnetPortEnv(): Record<string, string> {
  const cfg = JSON.parse(readFileSync(join(DEVNET_DIR, 'node1', 'config.json'), 'utf8'));
  const rpcPort = new URL(RPC).port || '8545';
  return {
    HARDHAT_PORT: rpcPort,
    API_PORT_BASE: String(cfg.apiPort ?? 9201),
    LIBP2P_PORT_BASE: String(cfg.listenPort ?? 10001),
  };
}

function readNodePid(num: number): number | null {
  const pidf = join(DEVNET_DIR, `node${num}`, 'devnet.pid');
  if (!existsSync(pidf)) return null;
  const pid = parseInt(readFileSync(pidf, 'utf8').trim(), 10);
  return Number.isFinite(pid) ? pid : null;
}

// ───────────────────────────── HTTP helpers ──────────────────────────────
function request(
  method: 'GET' | 'POST',
  url: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolveP, rejectP) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        method,
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolveP({ status: res.statusCode ?? 0, body: JSON.parse(buf) });
          } catch {
            resolveP({ status: res.statusCode ?? 0, body: buf });
          }
        });
      },
    );
    req.on('error', rejectP);
    if (data) req.write(data);
    req.end();
  });
}

const getJson = (node: DevnetNode, path: string) => request('GET', api(node) + path, node.authToken);
const postJson = (node: DevnetNode, path: string, body: unknown) =>
  request('POST', api(node) + path, node.authToken, body);

async function nodeReachable(node: DevnetNode): Promise<boolean> {
  try {
    const r = await request('GET', api(node) + '/api/status', node.authToken);
    return r.status === 200;
  } catch {
    return false;
  }
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  intervalMs: number,
  probe: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

// ───────────────────────────── publish helpers ───────────────────────────
function runDkgCli(node: DevnetNode, args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'packages/cli/dist/cli.js'), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, DKG_NO_BLUE_GREEN: '1', DKG_HOME: node.home, DKG_API_PORT: String(node.apiPort) },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectResult(new Error(`dkg CLI timeout after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({ code: code ?? -1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectResult(err);
    });
  });
}

/** Write a unique nquads file and return its path + the subject we can later look for in VM. */
function makeWitnessFile(name: string): { path: string; subject: string; literal: string } {
  const dir = join(__dirname, 'turns');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ts = Date.now().toString(36);
  const subject = `urn:test:core-peers:${name}:${ts}`;
  const literal = `core-peers ${name} ${ts}`;
  const path = join(dir, `${name}-${ts}.nq`);
  const g = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
  writeFileSync(
    path,
    `<${subject}> <https://schema.org/name> "${literal}" <${g}> .\n` +
      `<${subject}> <https://schema.org/description> "core-peers feature devnet" <${g}> .\n`,
  );
  return { path, subject, literal };
}

async function publishFromCore(node: DevnetNode, name: string): Promise<{ subject: string; literal: string; kaId?: string; status: string }> {
  const witness = makeWitnessFile(name);
  const result = await runDkgCli(node, ['publish', CONTEXT_GRAPH, '--file', witness.path]);
  if (result.code !== 0) {
    throw new Error(`publish failed (exit ${result.code}) stdout=${result.stdout} stderr=${result.stderr}`);
  }
  const status = /Status:\s*(\w+)/i.exec(result.stdout)?.[1]?.toLowerCase() ?? 'unknown';
  const kaId = /KC ID:\s*(\d+)/i.exec(result.stdout)?.[1];
  return { subject: witness.subject, literal: witness.literal, kaId, status };
}

async function ensureIdentity(node: DevnetNode): Promise<void> {
  const st = await getJson(node, '/api/status');
  if (st.status === 200 && BigInt(st.body?.identityId ?? '0') > 0n) return;
  await postJson(node, '/api/identity/ensure', {});
  await waitFor(`node${node.num} identity`, 30_000, 1_000, async () => {
    const s = await getJson(node, '/api/status');
    return s.status === 200 && BigInt(s.body?.identityId ?? '0') > 0n ? true : null;
  });
}

function daemonLogTail(num: number, maxBytes = 2_000_000): string {
  const logf = join(DEVNET_DIR, `node${num}`, 'daemon.log');
  if (!existsSync(logf)) return '';
  const buf = readFileSync(logf);
  return buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8');
}

// ───────────────────────────── fixtures ──────────────────────────────────
let nodes: Record<number, DevnetNode>;

beforeAll(async () => {
  if (!existsSync(DEVNET_DIR)) {
    throw new Error(`${DEVNET_DIR} missing — run \`./scripts/devnet.sh clean && ./scripts/devnet.sh start 6\` first.`);
  }
  // Hardhat must be reachable.
  const provider = new ethers.JsonRpcProvider(RPC, { chainId: 31337, name: 'localhost' });
  const chainId = await provider.send('eth_chainId', []);
  expect(chainId, 'devnet hardhat not reachable on :8545').toBeTruthy();

  nodes = {};
  for (let i = 1; i <= 6; i++) nodes[i] = readNodeConfig(i);

  // Cores need an on-chain identity to publish + sign ACKs.
  for (const n of CORE_NODES) await ensureIdentity(nodes[n]!);
}, 180_000);

// ─────────────────── 1. Phase F — replication API surface ─────────────────
describe('Phase F — /api/replication surface is served by every node', () => {
  it('summary / per-cg / timeline / cursors respond well-formed on all cores + an edge', async () => {
    for (const n of [...CORE_NODES, 5]) {
      const node = nodes[n]!;

      const summary = await getJson(node, '/api/replication/summary?periodMs=86400000');
      expect(summary.status, `node${n} summary: ${JSON.stringify(summary.body)}`).toBe(200);
      expect(summary.body).toHaveProperty('counts');
      expect(summary.body).toHaveProperty('promotes');
      expect(summary.body).toHaveProperty('successRate'); // null or number
      expect(typeof summary.body.totalEvents).toBe('number');

      const perCg = await getJson(node, '/api/replication/per-cg?periodMs=86400000');
      expect(perCg.status).toBe(200);
      expect(Array.isArray(perCg.body.rows)).toBe(true);

      const timeline = await getJson(node, '/api/replication/timeline?periodMs=86400000&bucketMs=3600000');
      expect(timeline.status).toBe(200);
      expect(Array.isArray(timeline.body.buckets)).toBe(true);

      const cursors = await getJson(node, '/api/replication/cursors');
      expect(cursors.status).toBe(200);
      expect(Array.isArray(cursors.body.cursors)).toBe(true);
    }
  }, 60_000);

  it('events endpoint requires a cg param (400) and returns an array when given one', async () => {
    const node = nodes[1]!;
    const missing = await getJson(node, '/api/replication/events');
    expect(missing.status).toBe(400);
    const ok = await getJson(node, `/api/replication/events?cg=${encodeURIComponent(CONTEXT_GRAPH)}&limit=10`);
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.events)).toBe(true);
  }, 30_000);
});

// ────────── 2. Phase B + E — reconciler runs, watermark + telemetry ─────────
describe('Phase B + E — chain-driven VM reconciliation + structured telemetry', () => {
  it('a public publish advances a per-CG watermark and emits chain-promote telemetry on a core', async () => {
    // Publish from a core so the KA is registered on-chain under CONTEXT_GRAPH.
    const pub = await publishFromCore(nodes[1]!, 'reconcile');
    expect(pub.status, `publish status=${pub.status}`).toBe('confirmed');

    // The reconcile sweep (periodic, plus the live KACG nudge) should run on
    // the cores and advance the contiguous watermark for this CG past 0, with
    // telemetry persisted. Poll all cores; succeed on the first that shows it.
    const hit = await waitFor(
      'a core cursor watermark > 0 for CONTEXT_GRAPH with telemetry',
      120_000,
      4_000,
      async () => {
        for (const n of CORE_NODES) {
          const node = nodes[n]!;
          const cursors = await getJson(node, '/api/replication/cursors');
          if (cursors.status !== 200) continue;
          const row = (cursors.body.cursors as any[]).find((c) => c.context_graph_id === CONTEXT_GRAPH);
          const summary = await getJson(node, '/api/replication/summary?periodMs=86400000');
          const totalEvents = summary.body?.totalEvents ?? 0;
          if (row && (row.last_reconciled_ordinal ?? 0) > 0 && totalEvents > 0) {
            return { node: n, ordinal: row.last_reconciled_ordinal, totalEvents };
          }
        }
        return null;
      },
    );
    expect(hit.ordinal).toBeGreaterThan(0);

    // Phase E grep surface: the daemon log carries structured chain-promote lines.
    const log = daemonLogTail(hit.node);
    expect(log, `node${hit.node} daemon.log missing 'chain-promote' lines`).toMatch(/chain-promote action=/);
  }, 200_000);
});

// ────────────────── 3. Phase D — core-hosted recording + fill ──────────────
describe('Phase D — Cores host public CGs and fill their own gaps', () => {
  it('a core marks the public CG core-hosted (cursor Role = host), persisted', async () => {
    // The publish in suite 2 made every core sign a StorageACK for the public
    // CONTEXT_GRAPH, which marks it coreHosted. Poll cores for core_hosted=1.
    const host = await waitFor(
      'a core cursor with core_hosted=1 for CONTEXT_GRAPH',
      90_000,
      4_000,
      async () => {
        for (const n of CORE_NODES) {
          const cursors = await getJson(nodes[n]!, '/api/replication/cursors');
          if (cursors.status !== 200) continue;
          const row = (cursors.body.cursors as any[]).find(
            (c) => c.context_graph_id === CONTEXT_GRAPH && c.core_hosted === 1,
          );
          if (row) return { node: n, onChainId: row.on_chain_id };
        }
        return null;
      },
    );
    expect(host.node).toBeGreaterThan(0);
    // core_hosted is only ever set for PUBLIC CGs (curated stay on the
    // ciphertext host-mode path), so this is also the public-detection proof.
  }, 120_000);

  it('a core offline during a publish fills its gap from chain on restart (core-fill)', async () => {
    const victim = 2; // a core node
    const victimNode = nodes[victim]!;

    // Pre-req: the victim must already host the public CG (it ACKed earlier).
    await waitFor(
      `node${victim} hosts CONTEXT_GRAPH before the gap`,
      90_000,
      4_000,
      async () => {
        const cursors = await getJson(victimNode, '/api/replication/cursors');
        if (cursors.status !== 200) return null;
        const row = (cursors.body.cursors as any[]).find(
          (c) => c.context_graph_id === CONTEXT_GRAPH && c.core_hosted === 1,
        );
        return row ? true : null;
      },
    );

    // 1. Take the victim core OFFLINE (kill its daemon process).
    const pid = readNodePid(victim);
    expect(pid, `node${victim} pid not found`).toBeTruthy();
    try { process.kill(pid!, 'SIGKILL'); } catch { /* may already be gone */ }
    await waitFor(`node${victim} offline`, 30_000, 1_000, async () =>
      (await nodeReachable(victimNode)) ? null : true,
    );

    // 2. Publish a fresh KA to the CG from node1 while the victim is down.
    const pub = await publishFromCore(nodes[1]!, 'gap');
    expect(pub.status).toBe('confirmed');

    // 3. Bring the victim back online.
    execFileSync('bash', [DEVNET_SH, 'restart-node', String(victim)], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...devnetPortEnv() },
    });
    await waitFor(`node${victim} back online`, 90_000, 2_000, async () =>
      (await nodeReachable(victimNode)) ? true : null,
    );

    // 4. The victim should fill its gap from chain: either a `core-fill`
    //    replication event for the CG, or the missed triple landing in its
    //    verified-memory. Poll both signals.
    const filled = await waitFor(
      `node${victim} fills the gap (core-fill event or VM witness)`,
      240_000,
      5_000,
      async () => {
        const events = await getJson(victimNode, `/api/replication/events?cg=${encodeURIComponent(CONTEXT_GRAPH)}&limit=200`);
        if (events.status === 200) {
          const coreFill = (events.body.events as any[]).find((e) => e.action === 'core-fill');
          if (coreFill) return { via: 'core-fill', detail: coreFill };
        }
        const vm = await postJson(victimNode, '/api/query', {
          sparql: `ASK { <${pub.subject}> <https://schema.org/name> ?o }`,
          contextGraphId: CONTEXT_GRAPH,
          view: 'verified-memory',
        });
        const ask = vm.body?.boolean ?? vm.body?.value ?? false;
        if (vm.status === 200 && ask === true) return { via: 'vm-witness' };
        return null;
      },
    );
    expect(filled).toBeTruthy();
    console.log(`Phase D fill-the-gap PASS via ${(filled as any).via}`);
  }, 600_000);
});

// ───────────────────── 4. Phase C — no catch-up regression ─────────────────
describe('Phase C — sinceBatchId is additive; normal sync is unaffected', () => {
  it('a fresh core publish still reaches confirmed (full-scan sync path intact)', async () => {
    // Phase C adds an OPTIONAL unsigned hint with no active production caller
    // yet; its responder/envelope behaviour is unit-pinned. Here we only
    // confirm the publish + catch-up path (which exercises PROTOCOL_SYNC) is
    // not regressed by the additive field.
    const pub = await publishFromCore(nodes[1]!, 'phasec');
    expect(pub.status).toBe('confirmed');
  }, 200_000);
});
