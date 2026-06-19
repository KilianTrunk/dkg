/**
 * GH #306 / #787 — write routes must reject malformed (string-shaped) quads with
 * an actionable 4xx instead of crashing with a TypeError → HTTP 500.
 *
 *   #787 — POST /api/shared-memory/write with N-Quad *string* quads → was 500
 *          ("Cannot read properties of undefined (reading 'toLowerCase')").
 *          https://github.com/OriginTrail/dkg/issues/787
 *   #306 — POST /api/knowledge-assets/{name}/wm/write with string quads → was 500
 *          ("Cannot use 'in' operator to search for 'graph' in <s> <p> <o> .").
 *          https://github.com/OriginTrail/dkg/issues/306
 *
 * The fix validates quad shape at the route boundary (isWritableQuad) BEFORE the
 * agent write path. This test also asserts the POSITIVE path — well-formed
 * {subject,predicate,object} quads (graph optional) still succeed — so the
 * validation can't regress valid writes. One real auth-enabled daemon against
 * the cli suite's shared Hardhat node; no chain mocks.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';
import { getSharedContext, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Daemon { home: string; apiPort: number; child: ChildProcess; token: string; }
let daemon: Daemon | null = null;
const CG = 'wq-validation-cg';

async function startDaemon(): Promise<Daemon> {
  if (!existsSync(CLI_ENTRY)) throw new Error(`CLI not built at ${CLI_ENTRY}. Run the package build first.`);
  const home = await mkdtemp(join(tmpdir(), 'dkg-wq-validation-'));
  const apiPort = 19760 + Math.floor(Math.random() * 180);
  const listenPort = apiPort + 400;
  const { rpcUrl, hubAddress } = getSharedContext();
  await writeFile(join(home, 'config.json'), JSON.stringify({
    name: 'wq-validation-test', apiPort, listenPort, apiHost: '127.0.0.1', nodeRole: 'edge', relay: 'none',
    auth: { enabled: true },
    store: { backend: 'oxigraph-worker', options: { path: join(home, 'store.nq') } },
    chain: { type: 'evm', rpcUrl, hubAddress, chainId: 'evm:31337' }, contextGraphs: [],
  }));
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await writeFile(join(home, 'wallets.json'),
    JSON.stringify({ wallets: [{ address: coreOp.address, privateKey: coreOp.privateKey }] }, null, 2) + '\n', { mode: 0o600 });
  const child = spawn('node', [CLI_ENTRY, 'daemon-worker'], {
    env: { ...process.env, DKG_HOME: home, DKG_API_PORT: String(apiPort), DKG_NO_BLUE_GREEN: '1', DKG_DISABLE_TELEMETRY: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw new Error(`Daemon exited early (${child.exitCode})`);
    try { if ((await fetch(`http://127.0.0.1:${apiPort}/api/status`)).ok) break; } catch { /* not ready */ }
    await sleep(500);
    if (i === 89) throw new Error('Daemon did not become ready within 45s');
  }
  const raw = await readFile(join(home, 'auth.token'), 'utf-8');
  const token = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('#'));
  if (!token) throw new Error('No auth token');
  return { home, apiPort, child, token };
}

const url = (p: string) => `http://127.0.0.1:${daemon!.apiPort}${p}`;
const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${daemon!.token}` });

beforeAll(async () => {
  daemon = await startDaemon();
  const res = await fetch(url('/api/context-graph/create'), {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ id: CG, name: 'WQ Validation CG', accessPolicy: 0 }),
  });
  if (!res.ok) throw new Error(`CG create failed: ${res.status} ${await res.text()}`);
}, 120_000);

afterAll(async () => {
  if (daemon) {
    daemon.child.kill('SIGTERM');
    await sleep(1500);
    if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
    await rm(daemon.home, { recursive: true, force: true }).catch(() => {});
  }
});

describe('GH #787 — POST /api/shared-memory/write quad-shape validation', () => {
  it('returns 4xx (not 500) for N-Quad string-shaped quads', async () => {
    const res = await fetch(url('/api/shared-memory/write'), {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ contextGraphId: CG, quads: ['<http://example.org/s787> <http://example.org/p> "v" .'] }),
    });
    expect(res.status).not.toBe(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('accepts well-formed object quads (regression: valid SWM write still succeeds)', async () => {
    const res = await fetch(url('/api/shared-memory/write'), {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ contextGraphId: CG, quads: [
        { subject: 'urn:wq:s787', predicate: 'http://schema.org/name', object: '"ok787"' },
      ] }),
    });
    expect(res.status, await res.text().catch(() => '')).toBe(200);
  });
});

describe('GH #306 — POST /api/knowledge-assets/{name}/wm/write quad-shape validation', () => {
  it('returns 4xx (not 500) for N-Quad string-shaped quads', async () => {
    const created = await fetch(url('/api/knowledge-assets'), {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ contextGraphId: CG, name: 'ka-306' }),
    });
    expect(created.status, 'KA create precondition').toBeLessThan(300);
    const res = await fetch(url('/api/knowledge-assets/ka-306/wm/write'), {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ contextGraphId: CG, quads: ['<urn:s> <urn:p> <urn:o> .'] }),
    });
    expect(res.status).not.toBe(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('accepts well-formed object quads (regression: valid wm/write still succeeds)', async () => {
    const created = await fetch(url('/api/knowledge-assets'), {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ contextGraphId: CG, name: 'ka-306-ok' }),
    });
    expect(created.status).toBeLessThan(300);
    const res = await fetch(url('/api/knowledge-assets/ka-306-ok/wm/write'), {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ contextGraphId: CG, quads: [
        { subject: 'urn:wq:s306', predicate: 'http://schema.org/name', object: '"ok306"' },
      ] }),
    });
    expect(res.status, await res.text().catch(() => '')).toBe(200);
  });
});
