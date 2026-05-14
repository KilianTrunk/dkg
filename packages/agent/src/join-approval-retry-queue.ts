/**
 * In-memory retry queue for `join-approved` P2P notifications.
 *
 * Background
 * ----------
 * When a curator approves a join request via `DKGAgent.approveJoinRequest`,
 * three things happen, in order:
 *
 *   1. The pending join-request row is flipped from `pending` → `approved`
 *      in the curator's local store.
 *   2. The agent + its delegatee identifiers are written into the context
 *      graph's allowlist (`inviteAgentToContextGraph`). All local.
 *   3. A `join-approved` notification is fired over libp2p to the
 *      invitee's peer (`notifyJoinApproval` → `deliverPrivateJoinNotification`).
 *      This is the ONLY step that crosses the wire to the invitee.
 *
 * Until very recently, step 3 was a best-effort one-shot send: any transient
 * transport failure (relay reset, NAT mapping flap, the invitee's daemon
 * restarting in the brief window between request acceptance and approval
 * delivery) silently dropped the notification. The invitee then has no way
 * to recover on their own — without the `join-approved` message they don't
 * know the curator has acted, and the curator-side delegation alone is not
 * enough: the invitee's own sync attempts can't succeed until they know to
 * pull from the curator using the delegation peer/key the curator just
 * recorded.
 *
 * This queue is the durable retry layer that turns step 3 from "fire once
 * and pray" into "fire, and if the wire drops, keep trying for up to
 * `maxAgeMs` with exponential backoff, opportunistically retrying on every
 * direct re-connect from the invitee's peer". It is intentionally
 * self-contained and pure (no I/O, no clocks, no libp2p dependencies) so
 * its semantics are easy to test in isolation and the call sites in
 * `DKGAgent` stay small.
 *
 * Design notes
 * ------------
 *
 *   * Keying. Entries are keyed by `${contextGraphId}::${agentAddress.toLowerCase()}`.
 *     This is the exact same shape as the curator's existing
 *     `joinRequestOriginPeers` map, so the two are easy to reason about
 *     side-by-side. Re-enqueueing for the same `(cg, agent)` pair is
 *     idempotent: it bumps `attempts` and pushes `nextAttemptAt` further
 *     into the future according to the backoff ladder.
 *
 *   * Backoff. Configurable backoff array, used as `backoffs[min(attempts-1,
 *     last)]`. Default ladder is 10s → 30s → 90s → 5m → 15m → 1h → 4h →
 *     12h, capped at the last entry. Roughly 24h of total retry budget,
 *     which is plenty for the operator to either bring the invitee back
 *     online or notice the warning logs and re-poke manually.
 *
 *   * Expiry. Entries older than `maxAgeMs` (default 24h since the FIRST
 *     failure) are dropped on the next `dropExpired()` tick. The dropped
 *     entries are returned so the caller can log them — useful diagnostic
 *     when an invitee's peer never comes back and the operator wants to
 *     know "did we ever give up on this approval?".
 *
 *   * Clock injection. All `nextAttemptAt` / `firstFailureAt` values are
 *     supplied by the caller as plain numbers, so tests can drive the
 *     queue with deterministic timestamps. The queue itself never calls
 *     `Date.now()`.
 *
 *   * In-memory. By design — this is the simplest thing that fixes the
 *     bug. A daemon restart will lose pending retries, but the operator
 *     can either (a) re-trigger via `POST /api/context-graph/{id}/redeliver-approval`,
 *     or (b) the invitee can re-submit the join request which the curator
 *     handles idempotently. Persistence is a follow-up if the in-memory
 *     queue proves insufficient in practice.
 */

/** A single (contextGraphId, agentAddress) approval delivery pending retry. */
export interface JoinApprovalRetryEntry {
  /** Context graph the approval is for. */
  contextGraphId: string;
  /** Agent address being notified. Preserves caller's case for log readability. */
  agentAddress: string;
  /** Number of delivery attempts made so far (every attempt that failed). */
  attempts: number;
  /** Timestamp (ms since epoch) of the first failed attempt. Used for `maxAgeMs` expiry. */
  firstFailureAt: number;
  /** Timestamp (ms since epoch) of the most recent failed attempt. */
  lastAttemptAt: number;
  /** Timestamp (ms since epoch) at which the next attempt is due. */
  nextAttemptAt: number;
  /** Short string describing the last failure (for logs + diagnostics). */
  lastError: string;
}

export interface JoinApprovalRetryQueueOptions {
  /**
   * Backoff ladder in milliseconds. `attempts=1` (first failure) uses
   * `backoffs[0]`, `attempts=N` uses `backoffs[min(N-1, backoffs.length-1)]`.
   * Must be non-empty.
   */
  backoffs?: readonly number[];
  /**
   * Max age (ms) from `firstFailureAt` before an entry is dropped. Default
   * 24h. `dropExpired(now)` is what actually evicts.
   */
  maxAgeMs?: number;
}

/** Default backoff ladder: 10s, 30s, 90s, 5m, 15m, 1h, 4h, 12h. */
export const DEFAULT_JOIN_APPROVAL_RETRY_BACKOFFS_MS: readonly number[] = [
  10_000,
  30_000,
  90_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  4 * 60 * 60_000,
  12 * 60 * 60_000,
];

/** Default max retry age: 24h since first failure. */
export const DEFAULT_JOIN_APPROVAL_RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function joinApprovalRetryKey(contextGraphId: string, agentAddress: string): string {
  return `${contextGraphId}::${agentAddress.toLowerCase()}`;
}

export class JoinApprovalRetryQueue {
  private readonly entries = new Map<string, JoinApprovalRetryEntry>();
  private readonly backoffs: readonly number[];
  private readonly maxAgeMs: number;

  constructor(options: JoinApprovalRetryQueueOptions = {}) {
    const backoffs = options.backoffs ?? DEFAULT_JOIN_APPROVAL_RETRY_BACKOFFS_MS;
    if (backoffs.length === 0) {
      throw new Error('JoinApprovalRetryQueue: backoffs must be non-empty');
    }
    this.backoffs = backoffs;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_JOIN_APPROVAL_RETRY_MAX_AGE_MS;
  }

  /**
   * Mark a `(cg, agent)` delivery as failed. Creates a new entry on first
   * failure, bumps `attempts` and reschedules `nextAttemptAt` on subsequent
   * failures. Returns the resulting entry so the caller can log it.
   */
  enqueueFailure(
    contextGraphId: string,
    agentAddress: string,
    error: string,
    now: number,
  ): JoinApprovalRetryEntry {
    const key = joinApprovalRetryKey(contextGraphId, agentAddress);
    const existing = this.entries.get(key);
    if (existing) {
      existing.attempts += 1;
      existing.lastAttemptAt = now;
      existing.nextAttemptAt = now + this.backoffFor(existing.attempts);
      existing.lastError = error;
      return existing;
    }
    const entry: JoinApprovalRetryEntry = {
      contextGraphId,
      agentAddress,
      attempts: 1,
      firstFailureAt: now,
      lastAttemptAt: now,
      nextAttemptAt: now + this.backoffFor(1),
      lastError: error,
    };
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Mark a `(cg, agent)` delivery as successful and drop any pending retry
   * for it. Returns `true` when an entry was actually removed.
   */
  markDelivered(contextGraphId: string, agentAddress: string): boolean {
    return this.entries.delete(joinApprovalRetryKey(contextGraphId, agentAddress));
  }

  /** Return all entries whose `nextAttemptAt` is at or before `now`. */
  due(now: number): JoinApprovalRetryEntry[] {
    const out: JoinApprovalRetryEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.nextAttemptAt <= now) out.push(entry);
    }
    return out;
  }

  /**
   * Drop every entry whose `firstFailureAt` is older than `maxAgeMs` from
   * `now`. Returns the dropped entries so the caller can log them.
   */
  dropExpired(now: number): JoinApprovalRetryEntry[] {
    const dropped: JoinApprovalRetryEntry[] = [];
    for (const [key, entry] of this.entries) {
      if (now - entry.firstFailureAt > this.maxAgeMs) {
        dropped.push(entry);
        this.entries.delete(key);
      }
    }
    return dropped;
  }

  /** Get the entry for a `(cg, agent)` pair if any. */
  getEntry(contextGraphId: string, agentAddress: string): JoinApprovalRetryEntry | undefined {
    return this.entries.get(joinApprovalRetryKey(contextGraphId, agentAddress));
  }

  /** Snapshot of all entries for diagnostics. */
  list(): JoinApprovalRetryEntry[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e }));
  }

  /** Number of entries currently queued. */
  size(): number {
    return this.entries.size;
  }

  /** Drop everything (for shutdown / tests). */
  clear(): void {
    this.entries.clear();
  }

  private backoffFor(attempts: number): number {
    const idx = Math.min(Math.max(attempts - 1, 0), this.backoffs.length - 1);
    return this.backoffs[idx];
  }
}
