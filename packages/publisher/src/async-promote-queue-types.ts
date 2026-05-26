/**
 * Async Promote Queue — public types.
 *
 * Companion to the merged RFC at
 * `docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md` and the implementation plan at
 * `docs/specs/SPEC_ASYNC_PROMOTE_QUEUE_IMPLEMENTATION_PLAN.md`. This file
 * contains only the public interface + types so callers can depend on it
 * without pulling in the impl (and SPARQL surface area) of the
 * `TripleStoreAsyncPromoteQueue`.
 *
 * The queue mirrors `AsyncLiftPublisher`'s claim/lease/retry model but
 * replaces its on-chain pipeline with a single in-process worker that
 * runs `agent.publisher.assertionPromote`. See the plan §1–2 for the
 * differences from `AsyncLiftPublisher`.
 */

export const PROMOTE_JOB_STATES = [
  'queued',
  'running',
  'failed_retrying',
  'succeeded',
  'failed',
] as const;
export type PromoteJobState = (typeof PROMOTE_JOB_STATES)[number];

/**
 * Classification of a promote failure, used by the queue's retry policy.
 * Set by the worker when calling `fail()` — the queue itself never inspects
 * the error message.
 *
 * - `transient`  — network blip, daemon overload, retry with backoff.
 * - `cap_exceeded` — 256 KB body cap or 10 MB gossip cap. The worker may
 *                   shrink the entity batch and retry, OR mark the whole
 *                   job failed if it can't subdivide further.
 * - `fatal`      — validation failure, unknown assertion, etc.; no retry.
 */
export type PromoteFailureClassification = 'transient' | 'cap_exceeded' | 'fatal';

/**
 * A promote request — the payload the queue persists for the worker to
 * replay. Validated at the HTTP layer; the queue stores it verbatim.
 */
export interface PromoteRequest {
  contextGraphId: string;
  subGraphName?: string;
  assertionName: string;
  entities: readonly string[] | 'all';
}

/**
 * Per-attempt lease metadata. Present only when state is `running`.
 * The lease prevents two workers from claiming the same job; the
 * `claimToken` is included in heartbeat / succeed / fail calls so the
 * queue can reject operations from a worker whose lease already expired
 * and was reassigned elsewhere.
 */
export interface PromoteLease {
  workerId: string;
  acquiredAt: number;
  expiresAt: number;
  lastHeartbeatAt: number;
  claimToken: string;
}

export interface PromoteAttemptError {
  message: string;
  retryable: boolean;
  classification: PromoteFailureClassification;
  recordedAt: number;
}

export interface PromoteAttemptState {
  count: number;
  maxRetries: number;
  nextRetryAt?: number;
  lastError?: PromoteAttemptError;
}

export interface PromoteResult {
  promotedCount: number;
  succeededAt: number;
  /** Informational only — populated when the worker observed the gossip payload size. */
  gossipMessageSize?: number;
}

/**
 * Per-job commit marker — written by the worker as it observes
 * `assertionPromote` advancing through its internal phases. These flags are
 * operator-facing evidence for partial-promote diagnosis. They are not enough
 * to prove an expired running job is safe to rerun, because the first marker is
 * recorded after `assertionPromote()` returns.
 */
export interface PromoteCommitMarker {
  swmInserted: boolean;
  wmCleaned: boolean;
  lifecycleStamped: boolean;
  gossiped: boolean;
}

export const PROMOTE_COMMIT_MARKER_STEPS = [
  'swmInserted',
  'wmCleaned',
  'lifecycleStamped',
  'gossiped',
] as const;
export type PromoteCommitMarkerStep = (typeof PROMOTE_COMMIT_MARKER_STEPS)[number];

export interface PromoteJob {
  jobId: string;
  request: PromoteRequest;
  state: PromoteJobState;
  enqueuedAt: number;
  updatedAt: number;
  lease?: PromoteLease;
  attempt: PromoteAttemptState;
  result?: PromoteResult;
  commitMarker?: PromoteCommitMarker;
  /**
   * Stable string describing why a job is currently in its state when
   * that explanation isn't captured by other fields. Populated for
   * cancel/recover transitions and partial-promote ambiguity. Cleared
   * on successful re-queue.
   */
  reason?: string;
}

export interface PromoteListFilter {
  state?: readonly PromoteJobState[];
  contextGraphId?: string;
  limit?: number;
}

/**
 * Result of a startup recovery sweep. See RFC §4.4.
 *
 * - `reclaimed`  — reserved for a future reconciler that can prove an expired
 *                  running attempt did not touch SWM. The v1 implementation
 *                  leaves this at zero.
 * - `abandoned`  — expired `running` jobs parked in `failed` with
 *                  `reason="partial promote ambiguity"` because re-running
 *                  risks duplicate gossip and partial WM state. An operator
 *                  inspects and manually `recover()`s after verifying SWM.
 */
export interface PromoteRecoverySummary {
  reclaimed: number;
  abandoned: number;
}

export type PromoteStats = Record<PromoteJobState, number>;

export interface AsyncPromoteQueue {
  // RFC §3.1
  enqueue(request: PromoteRequest): Promise<string>;
  // RFC §3.2
  getStatus(jobId: string): Promise<PromoteJob | null>;
  // RFC §3.3
  list(filter?: PromoteListFilter): Promise<PromoteJob[]>;
  // RFC §3.4
  cancel(jobId: string): Promise<void>;
  recover(jobId: string): Promise<void>;
  // Worker-side surface — used by the in-process worker loop (PR #3); never
  // exposed via HTTP. Each worker passes its own opaque `workerId` (typically
  // the daemon process id + a slot index).
  claimNext(workerId: string): Promise<PromoteJob | null>;
  heartbeat(jobId: string, claimToken: string): Promise<void>;
  recordCommitMarker(jobId: string, claimToken: string, step: PromoteCommitMarkerStep): Promise<void>;
  succeed(jobId: string, claimToken: string, result: PromoteResult): Promise<void>;
  fail(jobId: string, claimToken: string, error: PromoteAttemptError): Promise<void>;
  // Startup / lifecycle.
  recoverOnStartup(): Promise<PromoteRecoverySummary>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  getStats(): Promise<PromoteStats>;
}

export interface AsyncPromoteQueueConfig {
  /** Defaults to `urn:dkg:promote-queue:control-plane` per RFC §4.1. */
  graphUri?: string;
  /** Defaults to 5 — promote retries are cheap. RFC §4.2. */
  maxRetries?: number;
  /** Defaults to 5 minutes — matches `AsyncLiftPublisher.lockLeaseMs`. */
  leaseMs?: number;
  /** Defaults to `Date.now()`. Tests inject deterministic time. */
  now?: () => number;
  /** Defaults to `crypto.randomUUID()`. Tests inject deterministic ids. */
  idGenerator?: () => string;
  /** Defaults to `crypto.randomUUID()`. Must be fresh for every lease claim. */
  claimTokenGenerator?: () => string;
  /**
   * Backoff curve for `failed_retrying` jobs. Receives the next attempt
   * count (1-indexed — first retry is attempt 1) and returns ms-from-now.
   * Default: `min(60_000 * 2^(attempt-1), 15 * 60_000)`.
   */
  backoff?: (attemptCount: number) => number;
}

/**
 * Thrown when an operation fails because the queue's per-assertion
 * uniqueness key `(contextGraphId, subGraphName, assertionName)` is
 * already held by another active job. Carries the existing jobId so the
 * HTTP layer can return a 409 with the duplicate id.
 */
export class PromoteJobConflictError extends Error {
  override readonly name = 'PromoteJobConflictError';
  constructor(
    readonly existingJobId: string,
    readonly key: { contextGraphId: string; subGraphName?: string; assertionName: string },
  ) {
    super(
      `Promote job already active for (${key.contextGraphId}, ${key.subGraphName ?? '<no-sub>'}, ${key.assertionName}): ${existingJobId}`,
    );
  }
}

/**
 * Thrown when a worker calls heartbeat / succeed / fail / recordCommitMarker
 * with a `claimToken` that no longer matches the job's current lease.
 * Workers should drop the in-flight job and let the next `claimNext` pick
 * up wherever recovery left it.
 */
export class PromoteJobLeaseError extends Error {
  override readonly name = 'PromoteJobLeaseError';
  constructor(
    readonly jobId: string,
    reason: string,
  ) {
    super(`Stale promote lease for ${jobId}: ${reason}`);
  }
}
