/**
 * SWM Reliable Fan-out — substrate fan-out policy + execution
 * (rc.9 PR-C, Step 3 of the plan).
 *
 * Sits between `publishWorkspaceGossip` (the SWM share egress
 * point) and the GossipSub mesh / Universal Messenger substrate.
 * Owns three concerns:
 *
 *   1. **Tier decision** — given a `CGMemberEnumeration`, decide
 *      which transports to use:
 *        - `{ useSubstrate: true,  useGossip: false }` — curated
 *          CG (`source: 'allowlist'`); the on-chain roster is
 *          authoritative, gossip would just duplicate the wire
 *          load with no reliability gain.
 *        - `{ useSubstrate: true,  useGossip: true  }` — public CG
 *          (`source: 'topic-subscribers'`) at or below
 *          `maxSubstrateMembers`. Gossip remains the canonical
 *          transport (catches latecomer subscribers we don't yet
 *          see in the subscriber view); substrate is a top-up that
 *          raises per-known-peer reliability into the same window
 *          chat enjoys.
 *        - `{ useSubstrate: false, useGossip: true  }` — public CG
 *          above the threshold (substrate fan-out scales
 *          poorly above ~100 peers — N round-trips per share), or
 *          `source: 'none'` (bootstrap state or agent-gated
 *          private CG without an enumerable peer roster — see
 *          `enumerate-cg-members.ts` for why the latter fails
 *          closed).
 *
 *      NB: this module is intentionally PURE — it does not consult
 *      `process.env`. The caller (`DKGAgent`) reads
 *      `DKG_SWM_SUBSTRATE_MAX_MEMBERS` at construction time and
 *      passes the result in via `maxSubstrateMembers`.
 *
 *   2. **Fan-out execution** — for the chosen substrate set, fire
 *      `messenger.sendReliable` in PARALLEL via `Promise.allSettled`
 *      so one slow peer doesn't tail-latency the whole share. Each
 *      per-peer outcome is classified as `delivered` /
 *      `inFlight` / `queued` / `failed` and tallied into the
 *      bookkeeping callback the caller provides.
 *
 *      Why parallel and not sequential? A curated CG with 50
 *      members would otherwise pay 50 × p99 latency in the worst
 *      case. Parallel fan-out caps the wall-clock at p99 of the
 *      slowest single send.
 *
 *      Why `allSettled` and not `all`? `all` short-circuits on
 *      first reject — but `messenger.sendReliable` doesn't reject
 *      on transient failures (it returns `delivered: false,
 *      queued: true` and persists into the outbox). A synchronous
 *      throw here is the unrecoverable case (e.g. invalid peerId
 *      shape) where the failure is local-side, not network-side,
 *      and we want to record it but keep fanning out to the rest.
 *
 *   3. **Receiver-side coupling** — none, by design. The substrate
 *      handler registered on `PROTOCOL_SWM_UPDATE` hands the wire
 *      bytes straight to `SharedMemoryHandler.handle()`, the exact
 *      same in-process apply path the gossip subscription drives.
 *      That means PR-A's `seenShareOps`/`redundantApplies` accounting
 *      automatically covers double-delivery (gossip + substrate of
 *      the same share to the same peer) — the second arrival just
 *      bumps `swm.redundantApplies` for that cgId. No new dedup
 *      machinery needed at this layer.
 *
 * Watchdog / ACK / outstanding-table is PR-D, NOT here. PR-C is
 * "send it and tally what happened"; PR-D adds "and if nobody
 * acked, top up after N seconds".
 */

import type { ReliableSendResult } from '../p2p/messenger.js';
import type { CGMemberEnumeration } from './enumerate-cg-members.js';

/**
 * Per-call decision: which transports to use for ONE share.
 *
 * `useSubstrate` and `useGossip` are independent booleans so the
 * caller can write a single `if`/`if` block instead of a switch on
 * three named tiers; the four meaningful combinations are
 * captured exactly by the 2-bit product.
 */
export interface FanOutPlan {
  useSubstrate: boolean;
  useGossip: boolean;
  /**
   * Recipient set for the substrate leg. Empty array iff
   * `useSubstrate === false`. Already de-duplicated and
   * self-excluded by `CGMemberEnumerator`; this module does NOT
   * filter further.
   */
  substrateMembers: readonly string[];
  /**
   * The {@link CGMemberEnumeration.source} that drove the
   * decision. Surfaced for observability (log lines / per-tier
   * metric breakdown / soak postmortem).
   */
  enumerationSource: CGMemberEnumeration['source'];
  /**
   * Pre-truncation member count (before `maxSubstrateMembers`
   * gate kicked in). Equals `substrateMembers.length` when
   * `useSubstrate === true`. When `useSubstrate === false` for a
   * public CG that exceeded the threshold, this is the count
   * that tripped the gate. Used by the caller's WARN log so
   * operators can see "gossip-only because 137 > 100".
   */
  enumeratedCount: number;
}

/** Decision input — kept narrow so the policy is easy to test. */
export interface ChooseFanOutTierInput {
  enumeration: CGMemberEnumeration;
  /**
   * Maximum number of members we'll substrate-fan-out to. Above
   * this, public CGs fall back to gossip-only (substrate cost
   * grows linearly in members; gossip cost is independent of N).
   * Curated CGs are NOT truncated by this — see {@link chooseFanOutTier}
   * jsdoc for why.
   */
  maxSubstrateMembers: number;
}

/**
 * Pure tier-decision function. No I/O, no clock, no globals — safe
 * to call N times per share if the caller wants (only enumeration
 * cost dominates, and the enumerator has its own 60s cache).
 *
 * Decision matrix (see RFC-003 §6 for the full rationale):
 *
 *   | source              | members vs cap       | substrate | gossip |
 *   |---------------------|----------------------|-----------|--------|
 *   | allowlist           | (any size)           | YES       | NO     |
 *   | topic-subscribers   | <= maxSubstrateMembers | YES     | YES    |
 *   | topic-subscribers   | >  maxSubstrateMembers | NO      | YES    |
 *   | none                | (always empty)       | NO        | YES    |
 *
 * Why not truncate large curated CGs to the first
 * `maxSubstrateMembers`? A curated CG above the threshold is rare
 * (testnet curated CGs we've seen are <20 members), but the
 * delivery semantics matter more than the threshold cost: dropping
 * a substrate target because we're over budget would silently
 * regress reliability for the dropped peers. If a curated CG ever
 * does grow that large, PR-D's ACK + watchdog will catch missed
 * peers on the next tick (and the soak postmortem will surface
 * the throughput cost so we can decide whether to add batching
 * or sharding for rc.10).
 */
export function chooseFanOutTier(input: ChooseFanOutTierInput): FanOutPlan {
  const { enumeration, maxSubstrateMembers } = input;
  const enumeratedCount = enumeration.members.length;

  switch (enumeration.source) {
    case 'allowlist':
      return {
        useSubstrate: true,
        useGossip: false,
        substrateMembers: enumeration.members,
        enumerationSource: 'allowlist',
        enumeratedCount,
      };
    case 'topic-subscribers':
      if (enumeratedCount <= maxSubstrateMembers) {
        return {
          useSubstrate: true,
          useGossip: true,
          substrateMembers: enumeration.members,
          enumerationSource: 'topic-subscribers',
          enumeratedCount,
        };
      }
      return {
        useSubstrate: false,
        useGossip: true,
        substrateMembers: [],
        enumerationSource: 'topic-subscribers',
        enumeratedCount,
      };
    case 'none':
      return {
        useSubstrate: false,
        useGossip: true,
        substrateMembers: [],
        enumerationSource: 'none',
        enumeratedCount,
      };
  }
}

/** Per-peer substrate fan-out outcome, the bookkeeping vocabulary. */
export type FanOutOutcome =
  // `messenger.sendReliable` returned `delivered: true`. Wire ack
  // received within the timeout; payload is in the receiver's
  // SharedMemoryHandler. No follow-up needed.
  | 'delivered'
  // `messenger.sendReliable` returned `delivered: false, queued:
  // true`. Persisted into the durable substrate outbox; will be
  // retried by `Messenger.processOutboxTick` and on the next
  // reconnect. From this layer's POV, treat as a soft failure
  // (it's NOT a delivery confirmation) but DON'T re-fan out —
  // would just enqueue another row for the same logical share.
  | 'queued'
  // `messenger.sendReliable` returned the rare `inFlight: true`
  // (another sender already owns the in-process attempt for this
  // peer × protocol × messageId). Effectively a no-op for THIS
  // call; the other sender's outcome is what counts. Surfaced as
  // its own bucket because it shouldn't be lumped with "failed"
  // (no actual failure) or "delivered" (no actual delivery from
  // OUR call).
  | 'inFlight'
  // Synchronous throw OR `delivered: false, queued: false`.
  // Unrecoverable from this layer — usually a programming bug
  // (invalid peerId shape) or a substrate misconfiguration. The
  // share won't reach this peer via substrate. Gossip may still
  // cover it if `useGossip: true`; otherwise the next sync-on-
  // reconnect is the safety net.
  | 'failed';

/**
 * Per-peer record handed to {@link FanOutBookkeeper.recordOutcome}.
 * Includes the substrate-returned `attempts` and `messageId` so
 * the caller can correlate against the substrate outbox /
 * `/api/slo`'s `protocols['/dkg/10.0.1/swm-update']` histogram if
 * needed (debug-only; the per-cgId aggregate counters are the
 * production observability surface).
 */
export interface FanOutPeerRecord {
  peerId: string;
  outcome: FanOutOutcome;
  attempts: number;
  /** Substrate-assigned messageId; empty string for synchronous-throw failures. */
  messageId: string;
  /** Failure / queued reason string from the substrate; empty for delivered/inFlight. */
  error: string;
}

/**
 * Caller-side observability hook. The agent's implementation
 * increments per-(cgId, outcome) counters with the same overflow
 * cap pattern PR-A established for `swmGossipPublishFailures`.
 * Kept as an interface so the policy module stays unit-testable
 * with a tiny in-memory stub.
 */
export interface FanOutBookkeeper {
  recordOutcome(cgId: string, record: FanOutPeerRecord): void;
}

/**
 * Substrate dependency narrowed to the single method this module
 * needs. Lets the test suite supply a mock without dragging in
 * the full Messenger surface.
 */
export interface FanOutSubstrate {
  sendReliable(
    peerId: string,
    protocolId: string,
    payload: Uint8Array,
    opts?: { timeoutMs?: number },
  ): Promise<ReliableSendResult>;
}

export interface ExecuteSubstrateFanOutInput {
  contextGraphId: string;
  protocolId: string;
  /** Wire bytes — same encoded workspace gossip message the gossip path publishes. */
  payload: Uint8Array;
  members: readonly string[];
  /** Per-send timeout passed to `messenger.sendReliable`. */
  sendTimeoutMs: number;
  substrate: FanOutSubstrate;
  bookkeeper: FanOutBookkeeper;
}

export interface ExecuteSubstrateFanOutResult {
  /** Total number of substrate sends attempted (== members.length, kept for the WARN log). */
  attempted: number;
  /** Per-outcome counts, summed across all peers. */
  delivered: number;
  queued: number;
  inFlight: number;
  failed: number;
}

/**
 * Fire `members.length` parallel substrate sends, classify each
 * outcome, hand it to the bookkeeper, and return aggregate
 * counts. Never throws — synchronous throws from `sendReliable`
 * are caught and counted as `failed`.
 *
 * Parallel execution is intentional (see module-level jsdoc); the
 * receiver's `SharedMemoryHandler.handle()` uses
 * `withWriteLocks([sharedMemoryGraphUri])` so concurrent arrivals
 * for the same CG are serialised at the apply layer — no risk of
 * interleaved partial writes from fan-out parallelism on the
 * sender side.
 */
export async function executeSubstrateFanOut(
  input: ExecuteSubstrateFanOutInput,
): Promise<ExecuteSubstrateFanOutResult> {
  const { contextGraphId, protocolId, payload, members, sendTimeoutMs, substrate, bookkeeper } = input;
  const result: ExecuteSubstrateFanOutResult = {
    attempted: members.length,
    delivered: 0,
    queued: 0,
    inFlight: 0,
    failed: 0,
  };

  if (members.length === 0) return result;

  await Promise.allSettled(members.map(async (peerId) => {
    let record: FanOutPeerRecord;
    try {
      const sendResult = await substrate.sendReliable(peerId, protocolId, payload, { timeoutMs: sendTimeoutMs });
      record = classifySendResult(peerId, sendResult);
    } catch (err) {
      record = {
        peerId,
        outcome: 'failed',
        attempts: 0,
        messageId: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    switch (record.outcome) {
      case 'delivered':
        result.delivered += 1;
        break;
      case 'queued':
        result.queued += 1;
        break;
      case 'inFlight':
        result.inFlight += 1;
        break;
      case 'failed':
        result.failed += 1;
        break;
    }
    bookkeeper.recordOutcome(contextGraphId, record);
  }));

  return result;
}

function classifySendResult(peerId: string, sendResult: ReliableSendResult): FanOutPeerRecord {
  if (sendResult.delivered) {
    return {
      peerId,
      outcome: 'delivered',
      attempts: sendResult.attempts,
      messageId: sendResult.messageId,
      error: '',
    };
  }
  // delivered: false. Three sub-cases via the discriminator.
  if ('inFlight' in sendResult && sendResult.inFlight === true) {
    return {
      peerId,
      outcome: 'inFlight',
      attempts: sendResult.attempts,
      messageId: sendResult.messageId,
      error: sendResult.error,
    };
  }
  if ('queued' in sendResult && sendResult.queued === true) {
    return {
      peerId,
      outcome: 'queued',
      attempts: sendResult.attempts,
      messageId: sendResult.messageId,
      error: sendResult.error,
    };
  }
  // Defensive — the ReliableSendResult union currently only has
  // three variants (delivered / queued / inFlight). If a fourth
  // variant is ever added without updating this site, classify
  // it as `failed` so the substrate fan-out doesn't silently
  // double-count or lose track.
  return {
    peerId,
    outcome: 'failed',
    attempts: 0,
    messageId: '',
    error: 'unrecognised ReliableSendResult variant',
  };
}
