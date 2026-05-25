/**
 * Hard-timeout fallback for the daemon graceful-shutdown path.
 *
 * Why this exists: shutdown can deadlock when in-flight sync work is holding
 * libp2p reads/writes open while `agent.stop()` waits to drain (observed on
 * beacon-01 during a mid-deploy upgrade). Without a deadline, the worker
 * process becomes a zombie — the supervisor doesn't notice because the worker
 * is technically still alive, just unresponsive — and operator intervention
 * (`kill -9`) is the only recovery. This module provides:
 *
 *   1. A wall-clock deadline ({@link raceShutdownWithTimeout}) so a stuck
 *      graceful path always yields to a forced exit within {@link SHUTDOWN_HARD_TIMEOUT_MS}.
 *   2. An exit-code convention ({@link SHUTDOWN_FORCED_OFFSET}) so the supervisor
 *      and external monitoring can distinguish "shutdown deadlocked" from
 *      "shutdown OK", without losing the restart-vs-final-exit signal embedded
 *      in the original exit code passed to `shutdown()`.
 *
 * This is a safety net, not a root-cause fix. The proper fix (PR-6 in the
 * core-stability workstream) is to plumb an `AbortSignal` through `DKGNode.stop()`
 * to the long-await sites so they unwind cleanly. PR-1 lands first so the
 * failure mode stops bleeding network-wide while PR-6 is in flight.
 */

/** Default deadline for graceful shutdown before we hard-exit. */
export const SHUTDOWN_HARD_TIMEOUT_MS = 15_000;

/**
 * Forced-shutdown exit codes are the original `exitCode + SHUTDOWN_FORCED_OFFSET`.
 *
 *   exitCode 0  -> 100  (operator wanted final exit; cleanup deadlocked)
 *   exitCode 75 -> 175  (operator wanted restart;    cleanup deadlocked, restart still respected)
 *
 * The supervisor in `cli.ts` calls {@link decodeForcedExitCode} to recover the
 * original intent (so a forced "restart" still triggers respawn, and a forced
 * "final exit" still terminates the supervisor).
 *
 * Offset of 100 chosen because:
 *   - Stays comfortably under the 8-bit exit-code limit of 255 for our current
 *     callsites (0 and `DAEMON_EXIT_CODE_RESTART = 75`).
 *   - Doesn't collide with any exit code we currently emit (we have nothing
 *     in [100, 199]).
 *   - Visibly distinct in log output and on Datadog/Prometheus exit-code
 *     dashboards; alerts can target `exitCode >= 100 && exitCode < 200` as
 *     the "shutdown deadlocked" signal.
 */
export const SHUTDOWN_FORCED_OFFSET = 100;

/**
 * Returns true if `exitCode` is one our shutdown handler emitted because the
 * graceful path missed the {@link SHUTDOWN_HARD_TIMEOUT_MS} deadline.
 */
export function isForcedShutdownExitCode(exitCode: number | null): boolean {
  if (exitCode === null) return false;
  return exitCode >= SHUTDOWN_FORCED_OFFSET && exitCode < SHUTDOWN_FORCED_OFFSET * 2;
}

/**
 * Recovers the original `exitCode` the shutdown handler was called with, even
 * when the offset was applied. For non-forced exits returns the input unchanged.
 *
 * Used by the supervisor: if it receives 175 (`DAEMON_EXIT_CODE_RESTART + offset`)
 * it should still respawn, because the operator (or auto-update path) asked for
 * a restart and the offset is orthogonal to that intent.
 */
export function decodeForcedExitCode(exitCode: number | null): {
  forced: boolean;
  originalExitCode: number | null;
} {
  if (exitCode === null) return { forced: false, originalExitCode: null };
  if (isForcedShutdownExitCode(exitCode)) {
    return { forced: true, originalExitCode: exitCode - SHUTDOWN_FORCED_OFFSET };
  }
  return { forced: false, originalExitCode: exitCode };
}

/**
 * Resolves with `{ forced: true }` after `hardTimeoutMs`, or with
 * `{ forced: false }` the moment `cleanup` settles — whichever happens first.
 *
 * The single-shot timer is always cleared on race resolution (including if
 * `cleanup` rejects), so callers don't need a `finally` block. Callers SHOULD
 * pre-wrap `cleanup` with `.catch()` if they don't want shutdown errors to
 * surface as unhandled-rejections — `Promise.race` will otherwise propagate
 * the rejection here.
 */
export async function raceShutdownWithTimeout(
  cleanup: Promise<void>,
  hardTimeoutMs: number,
  log: (msg: string) => void,
): Promise<{ forced: boolean }> {
  let forced = false;
  let timer: NodeJS.Timeout | null = null;
  const hardKill = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      forced = true;
      log(
        `[shutdown-timeout] cleanup exceeded ${hardTimeoutMs}ms; forcing exit. ` +
          `Likely a sync-deadlock in agent.stop(); preserve the preceding 20 log lines for a bug report.`,
      );
      resolve();
    }, hardTimeoutMs);
  });
  try {
    await Promise.race([cleanup, hardKill]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { forced };
}
