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

// The holder REFRESHES its timestamp on this cadence for the whole critical
// section, so a LIVE holder's stamp is never older than ~HEARTBEAT_MS.
const HEARTBEAT_MS = 5_000;
// A held lock is only "stale" (owner presumed crashed) once its stamp hasn't
// advanced in > STALE_MS. Because a live holder heartbeats every HEARTBEAT_MS,
// STALE_MS only needs to exceed that with margin — crucially it does NOT need to
// exceed the worst-case critical section. This is the fix for the old single-
// timestamp scheme, where a `publishToVm` legitimately running longer than the
// (fixed) stale window had its still-live lock stolen, reintroducing the exact
// SWM interleaving the mutex exists to prevent.
const STALE_MS = 20_000;

function holderStamp(): string {
  return `${process.pid}:${Date.now()}`;
}

/**
 * Run `fn` while holding the global SWM mutation lock. Acquires via atomic
 * mkdir, spins (with jitter) until free, and reclaims a crashed holder's lock so
 * the suite can't deadlock. While held, the lock's timestamp is HEARTBEATED so a
 * long-but-healthy publish is never mistaken for a dead holder and stolen.
 */
export async function withSwmLock<T>(fn: () => Promise<T>, opts: { acquireTimeoutMs?: number } = {}): Promise<T> {
  // Generous overall give-up window. With heartbeat-based staleness a dead
  // holder is reclaimed within STALE_MS regardless, so this only bounds the wait
  // behind a genuinely long-running live holder.
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 120_000;
  const start = Date.now();
  // When the holder dir exists but its stamp is missing/garbage (e.g. a writer
  // crashed between mkdir and the first writeFile), reclaim it only after we've
  // observed the missing stamp for STALE_MS — never race a holder mid-acquire.
  let missingHolderSince = 0;

  for (;;) {
    try {
      await mkdir(LOCK_DIR);
      await writeFile(HOLDER_FILE, holderStamp()).catch(() => {});
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      // Lock held by someone else. Reclaim ONLY a demonstrably-dead holder.
      const stamp = await readFile(HOLDER_FILE, 'utf8').catch(() => '');
      const heldAt = Number(stamp.split(':')[1] ?? '0');
      if (heldAt) {
        missingHolderSince = 0;
        // A live holder heartbeats, so a fresh stamp means "still working" — wait.
        // Only a stamp older than STALE_MS signals a crashed owner.
        if (Date.now() - heldAt > STALE_MS) {
          await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
          continue;
        }
      } else {
        if (!missingHolderSince) missingHolderSince = Date.now();
        else if (Date.now() - missingHolderSince > STALE_MS) {
          await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
          continue;
        }
      }
      if (Date.now() - start > acquireTimeoutMs) {
        // Last resort: break a presumably-dead lock rather than fail the test on
        // acquisition (itself a false negative). Reached only if a live holder
        // genuinely ran past the whole window — far rarer than the old 30s steal.
        await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await sleep(40 + Math.random() * 120);
    }
  }

  // Keep the holder timestamp fresh for the entire critical section, so a slow
  // (but alive) promote→publish→clear is never reclaimed out from under us.
  const heartbeat = setInterval(() => {
    void writeFile(HOLDER_FILE, holderStamp()).catch(() => {});
  }, HEARTBEAT_MS);
  // Don't let the heartbeat timer keep the process alive on its own.
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
  }
}
