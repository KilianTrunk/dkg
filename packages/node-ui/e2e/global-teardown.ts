/**
 * Playwright global teardown -- counterpart to the bootstrap chained
 * into `webServer.command` (see e2e/bootstrap-devnet.ts).
 *
 * Only stops the devnet if WE were the ones who started it (marker
 * file present). If the operator had a devnet running before the test
 * run, we leave it running so the next iteration is fast.
 *
 * Idempotent: safe to invoke even when no marker exists (e.g. a
 * setup-skipped reuse run, or a previous run that already cleaned up).
 */
import { existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const MARKER_FILE = resolve(REPO_ROOT, '.devnet', '.playwright-managed');

const TEARDOWN_TIMEOUT_MS = parseInt(
  process.env.PLAYWRIGHT_DEVNET_STOP_TIMEOUT_MS || '60000',
  10,
);

function stopDevnet(): Promise<void> {
  return new Promise<void>((resolveStop) => {
    const child = spawn(
      'bash',
      [resolve(REPO_ROOT, 'scripts/devnet.sh'), 'stop'],
      {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env },
      },
    );
    const killer = setTimeout(() => {
      console.warn(
        `[playwright] devnet stop did not finish within ${TEARDOWN_TIMEOUT_MS}ms -- sending SIGKILL`,
      );
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }, TEARDOWN_TIMEOUT_MS);
    child.on('error', () => { clearTimeout(killer); resolveStop(); });
    child.on('exit', () => { clearTimeout(killer); resolveStop(); });
  });
}

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(MARKER_FILE)) {
    console.log('[playwright] no managed-devnet marker -- leaving any running devnet alone');
    return;
  }
  console.log('[playwright] stopping devnet (we started it during bootstrap)...');
  try {
    await stopDevnet();
  } finally {
    try { rmSync(MARKER_FILE, { force: true }); } catch { /* best-effort */ }
  }
  console.log('[playwright] devnet stopped');
}
