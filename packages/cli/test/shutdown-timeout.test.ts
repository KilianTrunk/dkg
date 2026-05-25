import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SHUTDOWN_FORCED_OFFSET,
  SHUTDOWN_HARD_TIMEOUT_MS,
  decodeForcedExitCode,
  isForcedShutdownExitCode,
  raceShutdownWithTimeout,
} from '../src/daemon/shutdown.js';

describe('shutdown constants', () => {
  it('declares SHUTDOWN_FORCED_OFFSET = 100 so 0+offset and 75+offset both fit in an 8-bit exit code', () => {
    // Both currently-emitted exit codes (0 from SIGINT/SIGTERM, 75 from auto-update)
    // must remain valid 8-bit values after the offset is applied. Documented for
    // the next contributor who might be tempted to bump the offset above 180.
    expect(SHUTDOWN_FORCED_OFFSET).toBe(100);
    expect(0 + SHUTDOWN_FORCED_OFFSET).toBeLessThan(256);
    expect(75 + SHUTDOWN_FORCED_OFFSET).toBeLessThan(256);
  });

  it('uses a 15s default hard-timeout — generous enough to let normal shutdowns finish, tight enough to recover from a stuck Core in one update cycle', () => {
    expect(SHUTDOWN_HARD_TIMEOUT_MS).toBe(15_000);
  });
});

describe('isForcedShutdownExitCode', () => {
  it.each([
    { input: null, expected: false, label: 'null (no exit reported)' },
    { input: 0, expected: false, label: 'clean exit' },
    { input: 75, expected: false, label: 'DAEMON_EXIT_CODE_RESTART (clean restart)' },
    { input: 1, expected: false, label: 'arbitrary crash' },
    { input: 99, expected: false, label: 'just below the offset range' },
    { input: 100, expected: true, label: 'forced clean exit (0 + 100)' },
    { input: 175, expected: true, label: 'forced restart (75 + 100)' },
    { input: 101, expected: false, label: 'unrelated process exit in the offset range' },
    { input: 199, expected: false, label: 'top of the offset range' },
    { input: 200, expected: false, label: 'just above the offset range' },
    { input: 255, expected: false, label: 'arbitrary high exit code' },
  ])('returns $expected for $label ($input)', ({ input, expected }) => {
    expect(isForcedShutdownExitCode(input)).toBe(expected);
  });
});

describe('decodeForcedExitCode', () => {
  it.each([
    { input: null, forced: false, original: null, label: 'null' },
    { input: 0, forced: false, original: 0, label: 'clean exit' },
    { input: 75, forced: false, original: 75, label: 'clean restart' },
    { input: 1, forced: false, original: 1, label: 'arbitrary crash unchanged' },
    { input: 100, forced: true, original: 0, label: 'forced clean exit -> original 0' },
    { input: 175, forced: true, original: 75, label: 'forced restart -> original 75' },
    { input: 101, forced: false, original: 101, label: 'unrelated offset-range code unchanged' },
    { input: 199, forced: false, original: 199, label: 'top of offset range unchanged' },
    { input: 200, forced: false, original: 200, label: 'above offset range, treated as crash' },
  ])('decodes $input as forced=$forced, originalExitCode=$original ($label)', ({ input, forced, original }) => {
    expect(decodeForcedExitCode(input)).toEqual({
      forced,
      originalExitCode: original,
    });
  });
});

describe('raceShutdownWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with forced=false the moment cleanup settles (happy path)', async () => {
    const log = vi.fn<(msg: string) => void>();
    const cleanup = Promise.resolve();

    const result = await raceShutdownWithTimeout(cleanup, 15_000, log);

    expect(result).toEqual({ forced: false });
    // No `[shutdown-timeout]` line on the happy path — operators grep for it
    // as the unambiguous deadlock signal; emitting it on clean shutdowns would
    // poison that signal.
    expect(log).not.toHaveBeenCalled();
  });

  it('resolves with forced=true and logs once after the deadline when cleanup never settles', async () => {
    const log = vi.fn<(msg: string) => void>();
    // A promise that never settles models the observed beacon-01 deadlock —
    // `agent.stop()` awaiting an in-flight libp2p read that holds forever.
    const cleanup = new Promise<void>(() => {});

    const racePromise = raceShutdownWithTimeout(cleanup, 15_000, log);

    // Just under the deadline: still racing, no log yet.
    await vi.advanceTimersByTimeAsync(14_999);
    expect(log).not.toHaveBeenCalled();

    // Tick the last millisecond: timeout fires, log emitted exactly once,
    // race resolves with forced=true.
    await vi.advanceTimersByTimeAsync(1);
    const result = await racePromise;

    expect(result).toEqual({ forced: true });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[shutdown-timeout]'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('15000ms'),
    );
  });

  it('clears the timeout when cleanup settles first (no leaked timer)', async () => {
    const log = vi.fn<(msg: string) => void>();
    let resolveCleanup: () => void;
    const cleanup = new Promise<void>((resolve) => { resolveCleanup = resolve; });

    const racePromise = raceShutdownWithTimeout(cleanup, 15_000, log);

    // Cleanup completes well before the deadline.
    await vi.advanceTimersByTimeAsync(5_000);
    resolveCleanup!();
    const result = await racePromise;

    expect(result).toEqual({ forced: false });

    // Advance past the original deadline: the timer must have been cleared,
    // so no log entry materialises after the race resolved. (If the timer
    // leaked, the log would fire here and confuse operators investigating
    // historic shutdowns.)
    await vi.advanceTimersByTimeAsync(20_000);
    expect(log).not.toHaveBeenCalled();
  });

  it('clears the timeout even when cleanup rejects (no leaked timer)', async () => {
    const log = vi.fn<(msg: string) => void>();
    // Caller is responsible for catching cleanup errors before passing the
    // promise in (see lifecycle.ts), but the helper must still clean its
    // own timer even if a misuse lets the rejection through.
    const cleanup = Promise.reject(new Error('cleanup blew up'));

    await expect(
      raceShutdownWithTimeout(cleanup, 15_000, log),
    ).rejects.toThrow('cleanup blew up');

    // Past the deadline: timer was cleared in the finally block, so still no log.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(log).not.toHaveBeenCalled();
  });
});
