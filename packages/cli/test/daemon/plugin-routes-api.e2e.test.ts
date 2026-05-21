/**
 * Route-plugins live-daemon E2E.
 *
 * Spins one daemon with a temporary DKG_HOME whose `config.json` lists the
 * pre-built sample-route-plugin fixture (built once at `packages/cli/test-fixtures/sample-route-plugin/dist/index.js`)
 * in its `routePlugins` array, then asserts that the configured plugins
 * answer real HTTP requests on the live daemon without breaking the
 * built-in `/api/status` route.
 *
 * Patterned after `packages/cli/test/daemon-http-behavior-extra.test.ts`
 * for daemon spawning + Hardhat-shared-chain config (edge-role node so we
 * never touch profile registration).
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';
import { getSharedContext, HARDHAT_KEYS } from '../../../chain/test/evm-test-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', '..', 'dist', 'cli.js');
const FIXTURE_DIR = resolvePath(
  __dirname,
  '..',
  '..',
  'test-fixtures',
  'sample-route-plugin',
  'dist',
);
const ECHO_FIXTURE = join(FIXTURE_DIR, 'index.js');
const THROW_FIXTURE = join(FIXTURE_DIR, 'throwing.js');

interface Daemon {
  home: string;
  apiPort: number;
  listenPort: number;
  child: ChildProcess;
  token: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

function uniquePort(base: number): number {
  return base + Math.floor(Math.random() * 1000);
}

// API and libp2p port bases must be at least 1000 apart so the two
// `uniquePort` rolls (each picking a port in `[base, base+1000)`) never
// overlap. Codex PR #593 review round 8: prior bases 19900 + 20000
// overlapped on [20000, 20899], so ~9% of e2e runs could pick the same
// port for both and fail with EADDRINUSE.
const API_PORT_BASE = 19900; // -> [19900, 20899]
const LISTEN_PORT_BASE = 21000; // -> [21000, 21999]

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function writeDaemonConfig(
  home: string,
  apiPort: number,
  listenPort: number,
): Promise<void> {
  const { rpcUrl, hubAddress } = getSharedContext();
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      name: 'plugin-routes-e2e',
      apiPort,
      listenPort,
      apiHost: '127.0.0.1',
      nodeRole: 'edge',
      relay: 'none',
      auth: { enabled: true },
      store: {
        backend: 'oxigraph-worker',
        options: { path: join(home, 'store.nq') },
      },
      chain: {
        type: 'evm',
        rpcUrl,
        hubAddress,
        chainId: 'evm:31337',
      },
      contextGraphs: [],
      routePlugins: [ECHO_FIXTURE, THROW_FIXTURE],
    }),
  );
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await writeFile(
    join(home, 'wallets.json'),
    JSON.stringify({
      wallets: [{ address: coreOp.address, privateKey: coreOp.privateKey }],
    }, null, 2) + '\n',
    { mode: 0o600 },
  );
}

async function startDaemon(): Promise<Daemon> {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `CLI not built at ${CLI_ENTRY}. Run "pnpm --filter @origintrail-official/dkg build" first.`,
    );
  }
  if (!existsSync(ECHO_FIXTURE) || !existsSync(THROW_FIXTURE)) {
    throw new Error(`Sample route-plugin fixtures missing under ${FIXTURE_DIR}`);
  }
  const home = await mkdtemp(join(tmpdir(), 'dkg-plugin-routes-e2e-'));
  const apiPort = uniquePort(API_PORT_BASE);
  const listenPort = uniquePort(LISTEN_PORT_BASE);
  await writeDaemonConfig(home, apiPort, listenPort);

  // Capture daemon stdio so startup failures (port bind, plugin load,
  // chain init, auth-token write) are visible in test failure messages.
  // `stdio: 'ignore'` discards these and leaves the harness reporting
  // only an early exit or a readiness timeout with no context — first
  // CI flake is then unrecoverable without re-running locally with
  // tracing. Use a buffered tail so a chatty daemon doesn't balloon
  // memory.
  const stdioLog = join(home, 'daemon-stdio.log');
  const logHandle = await open(stdioLog, 'a');
  const child = spawn('node', [CLI_ENTRY, 'daemon-worker'], {
    env: {
      ...process.env,
      DKG_HOME: home,
      DKG_API_PORT: String(apiPort),
      DKG_NO_BLUE_GREEN: '1',
      DKG_DISABLE_TELEMETRY: '1',
    },
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });

  const readDaemonStdioTail = async (n = 80): Promise<string> => {
    try {
      const buf = await readFile(stdioLog, 'utf-8');
      const lines = buf.split('\n');
      return lines.slice(-n).join('\n').trim();
    } catch {
      return '<could not read daemon stdio log>';
    }
  };

  const daemon: Daemon = {
    home,
    apiPort,
    listenPort,
    child,
    token: '',
  };
  child.once('exit', (code, signal) => {
    daemon.exitCode = code;
    daemon.signal = signal;
  });

  // If startup fails after this point, we own a spawned daemon process,
  // an open log handle, and a temp DKG_HOME — none of which the outer
  // `afterAll(stopDaemon(daemon))` can reach, because `daemon` is still
  // null in the test scope until we return. Codex PR #593 review round
  // 11: cleanup-on-error so a flaky/timeout startup doesn't leak a live
  // daemon (and its bound port) into the next CI retry.
  try {
    for (let i = 0; i < 90; i++) {
      if (child.exitCode !== null) {
        const tail = await readDaemonStdioTail();
        throw new Error(
          `Daemon exited early with code ${child.exitCode}.\n--- daemon stdio tail ---\n${tail}`,
        );
      }
      try {
        const res = await fetch(`http://127.0.0.1:${apiPort}/api/status`);
        if (res.ok) break;
      } catch {
        /* not ready yet */
      }
      await sleep(500);
      if (i === 89) {
        const tail = await readDaemonStdioTail();
        throw new Error(
          `Daemon did not become ready within 45s.\n--- daemon stdio tail ---\n${tail}`,
        );
      }
    }
    // Once ready, the daemon stdio handle stays open for diagnostics until
    // stopDaemon. The OS will reclaim it on process exit if we crash here.
    await logHandle.close();

    const raw = await readFile(join(home, 'auth.token'), 'utf-8');
    const token = raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('#'));
    if (!token) throw new Error('No auth token found in auth.token');
    daemon.token = token;

    return daemon;
  } catch (err) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        sleep(5_000),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await logHandle.close().catch(() => {});
    await rm(home, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function stopDaemon(d: Daemon | null): Promise<void> {
  if (!d) return;
  if (d.child.exitCode === null) {
    const exited = new Promise<void>((resolve) => {
      d.child.once('exit', () => resolve());
    });
    d.child.kill('SIGTERM');
    await Promise.race([exited, sleep(10_000)]);
    if (d.child.exitCode === null) d.child.kill('SIGKILL');
  }
  await rm(d.home, { recursive: true, force: true }).catch(() => {});
}

let daemon: Daemon | null = null;

beforeAll(async () => {
  daemon = await startDaemon();
}, 90_000);

afterAll(async () => {
  await stopDaemon(daemon);
  daemon = null;
}, 20_000);

function urlFor(path: string): string {
  return `http://127.0.0.1:${daemon!.apiPort}${path}`;
}

describe('Route plugins — live daemon E2E', () => {
  it('echo plugin handles POST /api/sample-fixture/echo with the request body', async () => {
    const res = await fetch(urlFor('/api/sample-fixture/echo'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${daemon!.token}`,
      },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ echoed: { hello: 'world' } });
  });

  it('built-in /api/status still answers 200 in the same daemon (regression)', async () => {
    const res = await fetch(urlFor('/api/status'));
    expect(res.status).toBe(200);
  });

  it('throwing plugin yields a 500 PluginError with the plugin name', async () => {
    const res = await fetch(urlFor('/api/sample-fixture/throw'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${daemon!.token}`,
      },
      body: '{}',
    });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('PluginError');
    expect(data.plugin).toBe('sample-fixture-throw');
    expect(typeof data.message).toBe('string');
  });

  it('daemon survives a plugin throw — /api/status still answers 200 after the 500', async () => {
    const res = await fetch(urlFor('/api/status'));
    expect(res.status).toBe(200);
  });
});
