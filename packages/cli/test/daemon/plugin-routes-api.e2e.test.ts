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
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
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
  const apiPort = uniquePort(19900);
  const listenPort = uniquePort(20000);
  await writeDaemonConfig(home, apiPort, listenPort);

  const child = spawn('node', [CLI_ENTRY, 'daemon-worker'], {
    env: {
      ...process.env,
      DKG_HOME: home,
      DKG_API_PORT: String(apiPort),
      DKG_NO_BLUE_GREEN: '1',
      DKG_DISABLE_TELEMETRY: '1',
    },
    stdio: 'ignore',
  });

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

  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) {
      throw new Error(`Daemon exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/status`);
      if (res.ok) break;
    } catch {
      /* not ready yet */
    }
    await sleep(500);
    if (i === 89) throw new Error('Daemon did not become ready within 45s');
  }

  const raw = await readFile(join(home, 'auth.token'), 'utf-8');
  const token = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));
  if (!token) throw new Error('No auth token found in auth.token');
  daemon.token = token;

  return daemon;
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
