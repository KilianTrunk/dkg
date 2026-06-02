/**
 * Cross-worker mutex for SHARED-MEMORY-mutating publish pipelines.
 *
 * The WM → SWM → VM publish specs (wm-swm-vm-lifecycle, conviction-publishing,
 * messaging-ownership-extended) and every `seedVmEntity` beforeAll all promote
 * assertions into — and publish out of — the SAME shared memory of `cgs[0]`.
 * Playwright's `test.describe.configure({ mode: 'serial' })` only serialises
 * tests WITHIN one file; these mutators live in separate files and run on
 * parallel workers. One of them (the conviction baseline) publishes with
 * `clearAfter: true`, a CG-wide SWM wipe. When that clear lands between another
 * pipeline's promote and publish, the publish fails with a real, correct
 * `500 No quads in shared memory for context graph <cg> matching selection`.
 * That's not a product bug — it's two tests stomping a shared mutable resource.
 *
 * Every local Playwright worker is a process on the SAME host, so an atomic
 * `mkdir` (which fails with EEXIST if the directory already exists) is a sound
 * cross-process lock. Wrapping each promote→publish(→clear) critical section in
 * `withSwmLock` guarantees a clear can never interleave with another pipeline's
 * promote/publish, without weakening any assertion (the real promote, publish
 * and clear all still run against the live node).
 */
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const LOCK_DIR = path.join(os.tmpdir(), 'dkg-e2e-swm-lock');
const HOLDER_FILE = path.join(LOCK_DIR, 'holder');

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding the global SWM mutation lock. Acquires via atomic
 * mkdir, spins (with jitter) until free, and includes a stale-lock breaker so a
 * crashed holder can't deadlock the suite. Critical sections here take ~1s, so
 * the default 60s acquire window is comfortably generous.
 */
export async function withSwmLock<T>(fn: () => Promise<T>, opts: { acquireTimeoutMs?: number } = {}): Promise<T> {
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 60_000;
  // If a holder dir has existed unchanged for longer than this, assume the
  // owning worker crashed mid-section and steal the lock.
  const staleMs = 30_000;
  const start = Date.now();

  for (;;) {
    try {
      await mkdir(LOCK_DIR);
      await writeFile(HOLDER_FILE, `${process.pid}:${Date.now()}`).catch(() => {});
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      // Lock held by someone else. Check for a stale holder before waiting.
      const stamp = await readFile(HOLDER_FILE, 'utf8').catch(() => '');
      const heldAt = Number(stamp.split(':')[1] ?? '0');
      if (heldAt && Date.now() - heldAt > staleMs) {
        await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - start > acquireTimeoutMs) {
        // Last resort: break a presumably-dead lock rather than fail the test
        // on lock acquisition (which would itself be a false negative).
        await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await sleep(40 + Math.random() * 120);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
  }
}
