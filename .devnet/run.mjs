#!/usr/bin/env node
// .devnet/run.mjs — runtime smoke entrypoint for issue 0003.
//
// The issue's test_command is:
//   pnpm -r build && cd .devnet && \
//   DKG_HOME=.devnet/node1 NODE2_DKG_HOME=.devnet/node2 \
//   node run.mjs --no-pause
//
// `.devnet/run.mjs` (this file) is the only checked-in path under
// `.devnet/` — everything else under `.devnet/` is gitignored runtime
// state created by `scripts/devnet.sh start`. The shim:
//
//   1. Chdir back to the repo root so the env-var paths
//      (`DKG_HOME=.devnet/node1`, `NODE2_DKG_HOME=.devnet/node2`) resolve
//      against the repo root, not the cwd that `cd .devnet` produced.
//   2. Actively probe Hardhat RPC + node1 `/api/status` + node2
//      `/api/status` to determine devnet liveness — filesystem markers
//      alone (`.devnet/hardhat/deployed`, per-node directories) lie
//      after the daemons exit, so a marker check would happily run the
//      EPCIS demo against dead daemons. The probes use the auth bearer
//      from `.devnet/nodeN/auth.token` when present, matching the
//      probe path that `scripts/devnet.sh` itself uses.
//   3. If any probe fails, stop any stale devnet processes and run
//      `scripts/devnet.sh start 2`. After boot, re-probe; abort with
//      non-zero exit if still not live.
//   4. Hand off to `demo/epcis-bike/run.mjs` with the same argv. Exit
//      code propagates from the demo.
//
// Modes (`DEVNET_SMOKE_MODE`, default `full`):
//
//   full      Boot devnet if needed, then run the EPCIS demo. No
//             fallback. Exit propagates from the demo / boot.
//   offline   Skip devnet entirely. Verify the post-archive structural
//             invariants statically. Exit 0 iff every invariant holds.
//             For local manual inspection only — NOT a runtime smoke;
//             the reviewer's gate expects mode=full.
//
// Per project memory `feedback_devnet_runtime_verify.md` ("static checks
// alone are insufficient") and the issue 0003 reviewer feedback ("the
// shim still returned exit 0 via auto-fallback, contradicting the issue
// spec's static-checks-insufficient requirement"), there is intentionally
// NO mode that silently falls back from a failed runtime smoke to a
// static check. A failed runtime smoke MUST fail the test_command.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SELF_DIR, '..');

// Chdir back to repo root BEFORE anything resolves cwd-relative paths.
// All env-var paths (`.devnet/node1`, `.devnet/node2`) and child-process
// cwds downstream of this assume repo root, not `.devnet/`.
process.chdir(REPO_ROOT);

const MODE = (process.env.DEVNET_SMOKE_MODE ?? 'full').toLowerCase();
// Port assignment is mutable: when 9201 / 9202 are occupied by a
// non-DKG listener (e.g. another developer tool on a shared box), the
// shim shifts the entire devnet base by +10000 so a fresh `scripts/devnet.sh
// start` doesn't immediately fail on EADDRINUSE. Hardhat's port is
// likewise mutable.
let HARDHAT_PORT = Number(process.env.HARDHAT_PORT ?? 8545);
let NODE1_PORT = Number(process.env.NODE1_API_PORT ?? 9201);
let NODE2_PORT = Number(process.env.NODE2_API_PORT ?? 9202);
let API_PORT_BASE = NODE1_PORT;
let LIBP2P_PORT_BASE = Number(process.env.LIBP2P_PORT_BASE ?? 10001);
const NUM_NODES = 2;
const PROBE_TIMEOUT_MS = 3000;
const log = (...parts) => console.log('[.devnet/run.mjs]', ...parts);

// Probe whether a TCP port on 127.0.0.1 is FREE to bind (not already
// occupied by some other listener). Used before invoking
// `scripts/devnet.sh start` so that a non-DKG listener on 9201 (a
// stale openclaw gateway, another worktree's daemon, …) doesn't get
// the devnet wedged at "Node 1 not ready after 120s".
function isPortFree(port) {
  return new Promise((resolveResult) => {
    const srv = createServer();
    srv.once('error', () => resolveResult(false));
    srv.once('listening', () => {
      srv.close(() => resolveResult(true));
    });
    srv.listen(port, '127.0.0.1');
  });
}

async function pickFreePortBase() {
  for (const offset of [0, 10000, 20000, 30000]) {
    const apiBase = 9201 + offset;
    const libp2pBase = 10001 + offset;
    const hardhatPort = 8545 + offset;
    const triesSet = new Set([hardhatPort]);
    for (let n = 0; n < NUM_NODES; n++) {
      triesSet.add(apiBase + n);
      triesSet.add(libp2pBase + n);
    }
    // Sequential probe: concurrent bind attempts on the same port can
    // collide with each other (probe N+1 starts before probe N has
    // released its test listener), producing false `port-in-use`
    // negatives. Sequential is slow only when many offsets are
    // exhausted, which is rare.
    let allFree = true;
    for (const port of triesSet) {
      if (!(await isPortFree(port))) {
        allFree = false;
        break;
      }
    }
    if (allFree) {
      return { hardhatPort, apiBase, libp2pBase, offset };
    }
  }
  return null;
}

function readAuthToken(nodeNum) {
  const path = join(REPO_ROOT, '.devnet', `node${nodeNum}`, 'auth.token');
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8').trim().split(/\n+/).pop() || null;
  } catch {
    return null;
  }
}

async function probeHardhatRpc() {
  try {
    const r = await fetch(`http://127.0.0.1:${HARDHAT_PORT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_chainId',
        params: [],
        id: 1,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return Boolean(j?.result);
  } catch {
    return false;
  }
}

async function probeNodeApi(nodeNum, port) {
  const token = readAuthToken(nodeNum);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function probeDevnetLive() {
  const [hardhat, node1, node2] = await Promise.all([
    probeHardhatRpc(),
    probeNodeApi(1, NODE1_PORT),
    probeNodeApi(2, NODE2_PORT),
  ]);
  return {
    allUp: hardhat && node1 && node2,
    hardhat,
    node1,
    node2,
  };
}

function runDevnetScript(arg) {
  log(`exec scripts/devnet.sh ${arg} (HARDHAT_PORT=${HARDHAT_PORT} API_PORT_BASE=${API_PORT_BASE} LIBP2P_PORT_BASE=${LIBP2P_PORT_BASE})`);
  const proc = spawnSync(
    './scripts/devnet.sh',
    [arg, ...(arg === 'start' ? [String(NUM_NODES)] : [])],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        HARDHAT_PORT: String(HARDHAT_PORT),
        API_PORT_BASE: String(API_PORT_BASE),
        LIBP2P_PORT_BASE: String(LIBP2P_PORT_BASE),
        // The EPCIS demo's Phase 1 capture path goes through the async
        // publisher (per-node /api/epcis/capture handler), which is OFF
        // by default in `scripts/devnet.sh`. Without this env var the
        // demo fails at the first capture with `PublisherUnavailable`.
        DEVNET_ENABLE_PUBLISHER: process.env.DEVNET_ENABLE_PUBLISHER ?? '1',
      },
    },
  );
  return proc.status ?? 1;
}

async function ensureDevnetLive() {
  // Probe first — never trust filesystem markers. A previous boot may
  // have left .devnet/hardhat/deployed + per-node directories present
  // while the daemons themselves are gone, so a marker-only check
  // would happily run the demo against corpses and the reviewer's
  // gate fails with "DKG daemon is not responding".
  let live = await probeDevnetLive();
  if (live.allUp) {
    log('devnet probes green (hardhat RPC + node1 /api/status + node2 /api/status)');
    return 0;
  }

  log(
    `devnet probes red — hardhat=${live.hardhat} node1=${live.node1} node2=${live.node2}; (re)booting`,
  );

  // Stop anything that's running but partial (e.g. Hardhat up but nodes
  // dead), then wipe state so the fresh start doesn't trip on stale PID
  // files / `deployed` marker / per-node DKG_HOME state.
  runDevnetScript('stop');
  const devnetDir = join(REPO_ROOT, '.devnet');
  for (const sub of ['hardhat', 'node1', 'node2', 'node3', 'node4', 'node5', 'node6']) {
    const p = join(devnetDir, sub);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
    }
  }

  // Now that we've stopped our own daemons and wiped state, check that
  // the standard ports are free to bind. If something else on the host
  // (another devnet from a different worktree, an unrelated dev tool,
  // a stale process from a previous interrupted run) still holds 9201
  // / 10001 / 8545, shift the entire devnet to a +10000 offset so the
  // boot doesn't immediately fail on EADDRINUSE.
  const picked = await pickFreePortBase();
  if (!picked) {
    log('no free port base found (tried offsets 0, 10000, 20000, 30000)');
    return 1;
  }
  HARDHAT_PORT = picked.hardhatPort;
  API_PORT_BASE = picked.apiBase;
  NODE1_PORT = picked.apiBase;
  NODE2_PORT = picked.apiBase + 1;
  LIBP2P_PORT_BASE = picked.libp2pBase;
  log(
    `port assignment offset=+${picked.offset} (hardhat=${HARDHAT_PORT}, api=${API_PORT_BASE}.., libp2p=${LIBP2P_PORT_BASE}..)`,
  );

  const startStatus = runDevnetScript('start');
  if (startStatus !== 0) {
    log(`scripts/devnet.sh start failed with exit ${startStatus}`);
    return startStatus;
  }

  // Re-probe with a short grace window — daemons sometimes finish
  // ramping a beat after the script returns.
  for (let attempt = 1; attempt <= 20; attempt++) {
    live = await probeDevnetLive();
    if (live.allUp) {
      log(`devnet probes green after boot (attempt ${attempt})`);
      return 0;
    }
    await sleep(1500);
  }
  log(
    `devnet still not live after boot — hardhat=${live.hardhat} node1=${live.node1} node2=${live.node2}`,
  );
  return 1;
}

function runOfflineSmoke() {
  log('mode=offline — structural invariants only (NOT a runtime smoke)');
  const checks = [];

  const chainArchive = join(
    REPO_ROOT,
    'packages',
    'chain',
    'src',
    'archive',
    'evm-adapter-v8-v9-methods.ts',
  );
  checks.push({
    name: 'chain archive snapshot exists',
    ok: existsSync(chainArchive),
    detail: chainArchive,
  });

  const evmAdapter = join(REPO_ROOT, 'packages', 'chain', 'src', 'evm-adapter.ts');
  if (existsSync(evmAdapter)) {
    const body = readFileSync(evmAdapter, 'utf-8');
    const bannedMethods = [
      /\bstakeWithLock\s*\(/,
      /\bstakeWithLockTier\s*\(/,
      /\bpublishKnowledgeAssets\s*\(/,
      /\bpermanentPublish\s*\(/,
      /\bextendStoringPeriod\s*\(/,
      /\btransferNamespace\s*\(/,
      /\bcreateAccount\s*\(/,
      /\baddFunds\s*\(/,
      /\bextendLock\s*\(/,
      /\bcoverPublishingCost\s*\(/,
      /\bisPCAAuthorizedKey\s*\(/,
      /\baddPCAAuthorizedKey\s*\(/,
    ];
    const survivors = bannedMethods.filter((re) => re.test(body));
    checks.push({
      name: 'evm-adapter.ts has no V8/V9 method definitions',
      ok: survivors.length === 0,
      detail:
        survivors.length === 0
          ? `${bannedMethods.length} method patterns absent`
          : `survivors: ${survivors.map((re) => re.source).join(', ')}`,
    });
  } else {
    checks.push({
      name: 'evm-adapter.ts present',
      ok: false,
      detail: `missing: ${evmAdapter}`,
    });
  }

  const poller = join(REPO_ROOT, 'packages', 'publisher', 'src', 'chain-event-poller.ts');
  if (existsSync(poller)) {
    const body = readFileSync(poller, 'utf-8');
    checks.push({
      name: 'publisher chain-event-poller has no V9 KnowledgeBatchCreated subscription',
      ok: !/KnowledgeBatchCreated/.test(body),
      detail: poller,
    });
  }

  const dkgPublisher = join(REPO_ROOT, 'packages', 'publisher', 'src', 'dkg-publisher.ts');
  if (existsSync(dkgPublisher)) {
    const body = readFileSync(dkgPublisher, 'utf-8');
    checks.push({
      name: 'dkg-publisher has no V9 updateKnowledgeAssets call',
      ok: !/\.updateKnowledgeAssets\s*\(/.test(body),
      detail: dkgPublisher,
    });
  }

  let allOk = true;
  for (const check of checks) {
    const tag = check.ok ? 'PASS' : 'FAIL';
    log(`  ${tag}  ${check.name}  (${check.detail})`);
    if (!check.ok) allOk = false;
  }

  if (allOk) {
    log('offline smoke OK');
    return 0;
  }
  log('offline smoke FAILED');
  return 1;
}

async function runFullSmoke() {
  const ensureStatus = await ensureDevnetLive();
  if (ensureStatus !== 0) return ensureStatus;

  const demo = join(REPO_ROOT, 'demo', 'epcis-bike', 'run.mjs');
  if (!existsSync(demo)) {
    log(`EPCIS demo runner missing at ${demo}`);
    return 1;
  }
  log(`handing off to ${demo}`);
  const proc = spawnSync('node', [demo, ...process.argv.slice(2)], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  return proc.status ?? 1;
}

// Entry point routing.
let exitCode = 1;
if (MODE === 'offline') {
  exitCode = runOfflineSmoke();
} else if (MODE === 'full') {
  exitCode = await runFullSmoke();
} else {
  log(`unknown DEVNET_SMOKE_MODE="${MODE}" — must be one of: full, offline`);
  exitCode = 2;
}
process.exit(exitCode);
