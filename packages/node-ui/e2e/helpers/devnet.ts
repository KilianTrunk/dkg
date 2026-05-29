import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

export interface DevnetNodeConfig {
  num: number;
  apiPort: number;
  authToken: string;
  home: string;
}

function readToken(path: string): string {
  try {
    return (
      readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith('#')) ?? ''
    );
  } catch {
    return '';
  }
}

/** Returns devnet node config when `.devnet/node{N}` exists, else null. */
export function readDevnetNode(num = 1): DevnetNodeConfig | null {
  const home = join(REPO_ROOT, '.devnet', `node${num}`);
  const portFile = join(home, 'api.port');
  if (!existsSync(portFile)) return null;
  const apiPort = parseInt(readFileSync(portFile, 'utf8').trim(), 10) || 9201;
  return {
    num,
    apiPort,
    authToken: readToken(join(home, 'auth.token')),
    home,
  };
}

export function isDevnetAvailable(num = 1): boolean {
  return readDevnetNode(num) !== null;
}

export async function devnetApiFetch(
  path: string,
  init: RequestInit & { nodeNum?: number } = {},
): Promise<Response> {
  const node = readDevnetNode(init.nodeNum ?? 1);
  if (!node) {
    throw new Error(`Devnet node${init.nodeNum ?? 1} not running`);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  };
  if (node.authToken) {
    headers.Authorization = `Bearer ${node.authToken}`;
  }
  const { nodeNum: _n, ...rest } = init;
  return fetch(`http://127.0.0.1:${node.apiPort}${path}`, { ...rest, headers });
}

export async function waitForDevnetStatus(
  nodeNum = 1,
  timeoutMs = 30_000,
): Promise<{ identityId: string; synced: boolean }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await devnetApiFetch('/api/status', { nodeNum });
      if (res.ok) {
        const json = (await res.json()) as { identityId?: string; synced?: boolean };
        if (json.identityId && BigInt(json.identityId) > 0n) {
          return { identityId: json.identityId, synced: !!json.synced };
        }
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Devnet node${nodeNum} did not become ready within ${timeoutMs}ms`);
}

/** Skip helper for devnet-only specs — call at start of test. */
export function skipUnlessDevnet(test: { skip: (condition: boolean, description: string) => void }, nodeNum = 1) {
  test.skip(!isDevnetAvailable(nodeNum), `Devnet node${nodeNum} not running — start with ./scripts/devnet.sh start 6`);
}
