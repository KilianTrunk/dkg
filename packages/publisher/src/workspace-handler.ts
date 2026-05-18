import type { TripleStore, Quad } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import type { EventBus } from '@origintrail-official/dkg-core';
import { DKGEvent, Logger, createOperationContext, contextGraphDataUri, contextGraphMetaUri, DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import type { PhaseCallback } from './publisher.js';
import {
  decodeGossipEnvelope,
  decodeEncryptedWorkspacePayload,
  decodeSwmSenderKeyMessage as decodeSwmSenderKeyMessageWire,
  decryptWorkspacePayload,
  decodeWorkspacePublishRequest,
  computeGossipSigningPayload,
  assertSafeIri,
  assertSafeRdfTerm,
  validateSubGraphName,
  contextGraphSubGraphUri,
  GOSSIP_ENVELOPE_FRESHNESS_MS,
  GOSSIP_ENVELOPE_VERSION,
  ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  SWM_SENDER_KEY_MESSAGE_TYPE,
  assertNoUserAuthoredTrustLevelQuads,
} from '@origintrail-official/dkg-core';
import type { EncryptedWorkspacePayloadMsg, GossipEnvelopeMsg, OperationContext, SwmSenderKeyMessageMsg, WorkspaceCASConditionMsg, WorkspacePublishRequestMsg, WorkspaceRecipientEncryptionKey } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { validatePublishRequest } from './validation.js';
import { generateOwnershipQuads, generateSubGraphRegistration } from './metadata.js';
import { parseSimpleNQuads } from './publish-handler.js';
import { storeWorkspaceOperationPublicQuads } from './workspace-resolution.js';
import type { KAManifestEntry } from './publisher.js';
import type { WorkspacePublicSnapshotStore } from './workspace-snapshot-store.js';

interface WorkspaceGossipDecodeResult {
  request?: WorkspacePublishRequestMsg;
  envelope?: GossipEnvelopeMsg;
  signedPayload: Uint8Array;
  encryptedPayload?: EncryptedWorkspacePayloadMsg;
  senderKeyMessage?: SwmSenderKeyMessageMsg;
  encrypted: boolean;
}

export type WorkspaceSenderKeyDecryptor = (
  message: SwmSenderKeyMessageMsg,
  contextGraphId: string,
  ctx: OperationContext,
) => Promise<Uint8Array>;

/**
 * Unambiguous composite key for `seenShareOps`.
 *
 * **Why not `${cgId}|${shareOperationId}` (rc.9 PR-A codex follow-up
 * #11)**: both `cgId` and `shareOperationId` are wire-supplied by
 * the publishing peer, neither is structurally constrained to
 * exclude `|`. A peer can therefore craft two distinct logical
 * pairs that hash to the SAME composite-string key
 * (`cgId="a|b" + op="c"` and `cgId="a" + op="b|c"` both produce
 * `"a|b|c"`), letting them collide `redundantApplies` accounting:
 * a legitimate apply on one pair could appear to be a "redundant"
 * re-delivery of the other. The metric is operator-facing, so the
 * skew is bounded but it would still let a hostile peer poison the
 * counter for unrelated tenants.
 *
 * `JSON.stringify([cgId, shareOperationId])` is structurally
 * unambiguous: array delimiters + quote-escaping make every
 * (cgId, op) pair produce a unique key. The performance cost
 * (one `JSON.stringify` per apply) is negligible — this runs only
 * on legitimate deliveries that already passed validation.
 */
function seenShareOpKey(cgId: string, shareOperationId: string): string {
  return JSON.stringify([cgId, shareOperationId]);
}

/**
 * Handles incoming shared memory topic messages (GossipSub).
 * Validates the request, stores public triples into SWM graph
 * and metadata into SWM meta graph. No chain, no UAL.
 */
export class SharedMemoryHandler {
  private readonly store: TripleStore;
  private readonly graphManager: GraphManager;
  private readonly eventBus: EventBus;
  /** Per-context-graph map of rootEntity → creatorPeerId. Shared with publisher when used by agent. */
  private readonly sharedMemoryOwnedEntities: Map<string, Map<string, string>> = new Map();
  private readonly writeLocks: Map<string, Promise<void>>;
  private readonly localAgentAddresses?: () => readonly string[] | Promise<readonly string[]>;
  private readonly workspaceRecipientPrivateKeys?: (
    contextGraphId: string,
  ) => readonly WorkspaceRecipientEncryptionKey[] | Promise<readonly WorkspaceRecipientEncryptionKey[]>;
  private readonly workspaceSenderKeyDecryptor?: WorkspaceSenderKeyDecryptor;
  private readonly now: () => number;
  private readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
  private readonly log = new Logger('SharedMemoryHandler');

  /**
   * Per-(cgId, shareOperationId) timestamp of the most recent legitimate
   * delivery, keyed via {@link seenShareOpKey} so neither field can be
   * crafted to collide with another pair (rc.9 PR-A codex follow-up
   * #11). Used purely for measurement of the redundant-apply rate
   * surfaced via /api/slo `swm.redundantApplies`. Bumped (without
   * blocking the apply) whenever we see a `(cgId, shareOperationId)`
   * we already processed within the TTL window.
   *
   * Lives here rather than in DKGAgent because once Step 1a / 1b of the
   * SWM reliable fan-out plan land, the gossip and substrate delivery
   * paths both terminate at `SharedMemoryHandler.handle()` — this is
   * the natural place to count duplicates that result from the two-
   * path race (gossip arrives, then substrate top-up fires before
   * receiver ack catches up to author).
   *
   * Bounded LRU: when size exceeds SEEN_OPS_MAX_SIZE, the oldest entries
   * are evicted in batches. Insertion order is JS-Map-iteration order,
   * so eviction is O(batch_size).
   */
  private readonly seenShareOps = new Map<string, number>();
  private readonly redundantApplyCounts = new Map<string, number>();
  /**
   * Sum of redundant-apply counts evicted into the overflow bucket
   * when `redundantApplyCounts.size` exceeds `redundantAppliesMaxCgs`.
   * Always 0 in normal deployments; non-zero only when redundant
   * applies arrive against thousands of distinct cgIds (typically a
   * buggy or hostile peer). Surfaces via `getStats()` so /api/slo
   * stays bounded.
   *
   * Codex PR #570 R9 caught the unbounded growth.
   */
  private redundantApplyCountsOverflow = 0;
  /** Sticky truncated flag for `redundantApplyCounts` (R9). */
  private redundantApplyCountsTruncated = false;
  private readonly seenOpsTtlMs: number;
  private readonly seenOpsMaxSize: number;
  private readonly seenOpsEvictBatch: number;
  private readonly redundantAppliesMaxCgs: number;
  /**
   * Becomes true the first time the cap eviction had to trim a
   * non-expired entry (i.e., the TTL window stopped being accurate
   * because throughput outran the cap). Surfaced via `getStats()` so
   * `/api/slo` operators can see that `redundantApplies` is a lower
   * bound rather than an exact count. Codex review on PR #570
   * caught the silent undercount.
   */
  private seenOpsCapEvictedLiveEntries = false;
  private static readonly DEFAULT_SEEN_OPS_TTL_MS = 10 * 60 * 1000;
  private static readonly DEFAULT_SEEN_OPS_MAX_SIZE = 50_000;
  private static readonly DEFAULT_SEEN_OPS_EVICT_BATCH = 5_000;
  private static readonly DEFAULT_REDUNDANT_APPLIES_MAX_CGS = 1024;

  constructor(
    store: TripleStore,
    eventBus: EventBus,
    options?: {
      sharedMemoryOwnedEntities?: Map<string, Map<string, string>>;
      writeLocks?: Map<string, Promise<void>>;
      localAgentAddresses?: () => readonly string[] | Promise<readonly string[]>;
      workspaceRecipientPrivateKeys?: (
        contextGraphId: string,
      ) => readonly WorkspaceRecipientEncryptionKey[] | Promise<readonly WorkspaceRecipientEncryptionKey[]>;
      workspaceSenderKeyDecryptor?: WorkspaceSenderKeyDecryptor;
      now?: () => number;
      publicSnapshotStore?: WorkspacePublicSnapshotStore;
      /**
       * Override the seen-share-op TTL (default 10 min). Lower values
       * are useful in tests / very-low-RAM deployments. Codex review
       * #570 R3 surfaced that the cap-based eviction was potentially
       * silently trimming live entries above ~83 unique ops/sec; the
       * configurable knobs let operators tune for their throughput.
       */
      seenOpsTtlMs?: number;
      /** Override the seen-share-op map capacity (default 50_000). */
      seenOpsMaxSize?: number;
      /** Override the seen-share-op eviction batch size (default 5_000). */
      seenOpsEvictBatch?: number;
      /**
       * Override the per-cgId `redundantApplyCounts` map capacity
       * (default 1024). Codex PR #570 R9: the per-cgId redundant-apply
       * counter map was unbounded — a buggy/hostile peer could grow
       * memory + /api/slo payload by forcing one duplicate on many
       * fresh cgIds. Beyond this cap, the smallest counter is evicted
       * into an overflow bucket so the grand total stays accurate.
       */
      redundantAppliesMaxCgs?: number;
    },
  ) {
    this.store = store;
    this.graphManager = new GraphManager(store);
    this.eventBus = eventBus;
    if (options?.sharedMemoryOwnedEntities) {
      this.sharedMemoryOwnedEntities = options.sharedMemoryOwnedEntities;
    }
    this.writeLocks = options?.writeLocks ?? new Map();
    this.localAgentAddresses = options?.localAgentAddresses;
    this.workspaceRecipientPrivateKeys = options?.workspaceRecipientPrivateKeys;
    this.workspaceSenderKeyDecryptor = options?.workspaceSenderKeyDecryptor;
    this.now = options?.now ?? (() => Date.now());
    this.publicSnapshotStore = options?.publicSnapshotStore;
    this.seenOpsTtlMs = options?.seenOpsTtlMs ?? SharedMemoryHandler.DEFAULT_SEEN_OPS_TTL_MS;
    this.seenOpsMaxSize = options?.seenOpsMaxSize ?? SharedMemoryHandler.DEFAULT_SEEN_OPS_MAX_SIZE;
    this.seenOpsEvictBatch = options?.seenOpsEvictBatch ?? SharedMemoryHandler.DEFAULT_SEEN_OPS_EVICT_BATCH;
    this.redundantAppliesMaxCgs =
      options?.redundantAppliesMaxCgs ?? SharedMemoryHandler.DEFAULT_REDUNDANT_APPLIES_MAX_CGS;
  }

  /**
   * Bump the redundant-apply counter when a (cgId, shareOpId) pair
   * is observed a second time within the TTL window. Idempotent on
   * repeat observations within TTL (counter increments each repeat).
   *
   * Codex review on PR #570 surfaced four correctness issues that
   * this fixed shape addresses:
   *
   *   R1: callers must only invoke this AFTER the delivery has
   *       passed allowlist + sub-graph validation + CAS + actual
   *       write — counting rejected deliveries would skew the
   *       /api/slo `swm.redundantApplies` gauge that informs the
   *       rc10 dedup decision. Call site is now inside the
   *       `if (applied)` block in `handle()`.
   *
   *   R2: eviction is true LRU, not just least-recently-inserted.
   *       `Map#set(existingKey, …)` updates the value but leaves
   *       iteration order untouched, so a hot key inserted long
   *       ago could still be evicted when the map crosses
   *       seenOpsMaxSize. We now `delete(key)` before
   *       re-inserting on a hit, which moves the key to the end of
   *       iteration order so eviction takes the genuinely oldest
   *       entries.
   *
   *   R3: eviction prunes TTL-expired entries first, then falls
   *       back to cap-based batch eviction only if everything is
   *       still live. Pre-fix, at ~83 unique ops/sec the cap was
   *       hit before TTL expiry, so live entries got dropped and
   *       `redundantApplies` undercounted exactly when the metric
   *       was meant to inform the rc10 dedup decision. When the
   *       fallback path DOES have to trim live entries (e.g.,
   *       configured cap too small for the throughput), we set a
   *       sticky flag so operators see `redundantAppliesLowerBound`
   *       on the `/api/slo` snapshot.
   *
   *   R4: see workspace.test.ts — the regression test now drives
   *       the map past the configured cap so the LRU refresh +
   *       prune-expired-first paths are exercised, not just the
   *       insertion-order assertion.
   */
  private recordSeenShareOp(
    cgId: string,
    shareOperationId: string,
    ctx: import('@origintrail-official/dkg-core').OperationContext,
  ): void {
    const key = seenShareOpKey(cgId, shareOperationId);
    const nowMs = this.now();
    const previousAt = this.seenShareOps.get(key);
    if (previousAt !== undefined) {
      if (nowMs - previousAt < this.seenOpsTtlMs) {
        const next = (this.redundantApplyCounts.get(cgId) ?? 0) + 1;
        this.redundantApplyCounts.set(cgId, next);
        this.enforceRedundantApplyCountsCap();
        this.log.debug(ctx, `SWM redundant apply (cgId=${cgId} op=${shareOperationId} count=${next})`);
      }
      // PR-A R2: refresh the LRU position. `Map#set(existingKey, v)`
      // alone does NOT move the key to the end of iteration order;
      // we must delete first so the subsequent set re-inserts at the
      // tail. Without this, a hot key inserted at t=0 keeps the same
      // position even after a t=now access and eventually gets
      // evicted as if it were cold.
      this.seenShareOps.delete(key);
    }
    this.seenShareOps.set(key, nowMs);
    if (this.seenShareOps.size > this.seenOpsMaxSize) {
      // PR-A R3 Phase 1: prune TTL-expired entries first. Iteration
      // order is LRU (oldest first thanks to the delete+set in R2),
      // so we can sweep from the front and bail at the first live
      // entry — O(actually-expired), not O(n).
      for (const [k, ts] of this.seenShareOps) {
        if (nowMs - ts < this.seenOpsTtlMs) break;
        this.seenShareOps.delete(k);
      }
      // PR-A R3 Phase 2: if the map is STILL over the cap after
      // pruning expired, it means throughput has outrun the
      // configured cap and we must trim still-live entries to stay
      // bounded. This makes redundantApplies a lower bound rather
      // than exact — surface that to operators via the sticky
      // `seenOpsCapEvictedLiveEntries` flag (exposed through
      // getStats()) so `/api/slo` can flag it.
      if (this.seenShareOps.size > this.seenOpsMaxSize) {
        let evicted = 0;
        for (const k of this.seenShareOps.keys()) {
          if (evicted >= this.seenOpsEvictBatch) break;
          this.seenShareOps.delete(k);
          evicted += 1;
        }
        if (!this.seenOpsCapEvictedLiveEntries) {
          this.seenOpsCapEvictedLiveEntries = true;
          this.log.warn(
            ctx,
            `SWM seenShareOps cap eviction trimmed ${evicted} live (non-TTL-expired) entries — redundantApplies is now a lower bound. Consider raising seenOpsMaxSize (current=${this.seenOpsMaxSize}).`,
          );
        }
      }
    }
  }

  /**
   * PR-A R9: bound the per-cgId redundant-apply counter map. The
   * receiver-side `redundantApplyCounts` would otherwise grow O(distinct
   * cgIds ever observed) — a buggy or hostile peer could force one
   * duplicate apply on many fresh cgIds and inflate both process
   * memory and the /api/slo response payload indefinitely. Mirrors
   * the swmGossipPublishFailures cap on the sender side.
   *
   * Eviction picks the GLOBAL smallest counter (including the
   * just-incremented one) — so when the new entry IS the smallest,
   * it gets evicted into the overflow bucket and the existing hot
   * cgIds stay intact (Codex PR #570 R8 lifted here too).
   */
  private enforceRedundantApplyCountsCap(): void {
    if (this.redundantApplyCounts.size <= this.redundantAppliesMaxCgs) return;
    let smallestCg: string | null = null;
    let smallestCount = Infinity;
    for (const [cg, count] of this.redundantApplyCounts) {
      if (count < smallestCount) {
        smallestCount = count;
        smallestCg = cg;
      }
    }
    if (smallestCg !== null) {
      this.redundantApplyCounts.delete(smallestCg);
      this.redundantApplyCountsOverflow += smallestCount;
      if (!this.redundantApplyCountsTruncated) {
        this.redundantApplyCountsTruncated = true;
      }
    }
  }

  /**
   * Snapshot of receiver-side SWM metrics for /api/slo. rc.9 PR-A.
   *
   * - `redundantApplies`: per-cgId counts of redundant applies (same
   *   `shareOpId` delivered twice within the TTL window AND both
   *   deliveries actually applied to the store). Counter increments
   *   each additional delivery beyond the first.
   * - `redundantAppliesLowerBound`: sticky boolean set to true the
   *   moment cap-based eviction had to trim a still-live (non-TTL-
   *   expired) entry from `seenShareOps`. Once true, the
   *   `redundantApplies` figures are a lower bound for the operating
   *   window — surfaces via Codex PR #570 R3 so operators can spot
   *   the configured `seenOpsMaxSize` no longer fits their throughput.
   * - `redundantAppliesOverflow`: sum of counters evicted into
   *   overflow when `redundantApplyCounts.size` crossed
   *   `redundantAppliesMaxCgs`. Surfaces via Codex PR #570 R9 so the
   *   grand total stays accurate even when the per-cgId breakdown
   *   gets truncated.
   * - `redundantAppliesTruncated`: sticky boolean, true once R9
   *   eviction has fired. Means the per-cgId breakdown is partial;
   *   total is still `sum(redundantApplies) + redundantAppliesOverflow`.
   */
  getStats(): {
    redundantApplies: Record<string, number>;
    redundantAppliesLowerBound: boolean;
    redundantAppliesOverflow: number;
    redundantAppliesTruncated: boolean;
  } {
    return {
      redundantApplies: Object.fromEntries(this.redundantApplyCounts),
      redundantAppliesLowerBound: this.seenOpsCapEvictedLiveEntries,
      redundantAppliesOverflow: this.redundantApplyCountsOverflow,
      redundantAppliesTruncated: this.redundantApplyCountsTruncated,
    };
  }

  private async withWriteLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const uniqueKeys = [...new Set(keys)].sort();
    const predecessor = Promise.all(uniqueKeys.map(k => this.writeLocks.get(k) ?? Promise.resolve()));
    let resolve!: () => void;
    const gate = new Promise<void>(r => { resolve = r; });
    for (const k of uniqueKeys) {
      this.writeLocks.set(k, gate);
    }
    await predecessor;
    try {
      return await fn();
    } finally {
      resolve();
      for (const k of uniqueKeys) {
        if (this.writeLocks.get(k) === gate) this.writeLocks.delete(k);
      }
    }
  }

  /**
   * Enforce CAS conditions carried in a gossip message.
   * Must be called inside a write lock so no concurrent mutation can
   * interleave between the check and the subsequent write.
   * Returns false if any condition fails (write should be skipped).
   */
  private async enforceCASConditions(
    conditions: WorkspaceCASConditionMsg[],
    swmGraph: string,
    ctx: import('@origintrail-official/dkg-core').OperationContext,
  ): Promise<boolean> {
    for (const cond of conditions) {
      try {
        assertSafeIri(cond.subject);
        assertSafeIri(cond.predicate);
        if (!cond.expectAbsent) {
          if (!cond.expectedValue) {
            this.log.warn(ctx, `CAS rejected: empty expectedValue for non-absent condition`);
            return false;
          }
          assertSafeRdfTerm(cond.expectedValue);
        }
      } catch {
        this.log.warn(ctx, `CAS rejected: invalid IRI/term in condition — possible injection attempt`);
        return false;
      }

      try {
        if (cond.expectAbsent) {
          const ask = `ASK { GRAPH <${swmGraph}> { <${cond.subject}> <${cond.predicate}> ?o } }`;
          const result = await this.store.query(ask);
          if (result.type !== 'boolean' || result.value) {
            this.log.warn(ctx, `CAS rejected: <${cond.subject}> <${cond.predicate}> expected absent`);
            return false;
          }
        } else {
          const ask = `ASK { GRAPH <${swmGraph}> { <${cond.subject}> <${cond.predicate}> ${cond.expectedValue} } }`;
          const result = await this.store.query(ask);
          if (result.type !== 'boolean' || !result.value) {
            this.log.warn(ctx, `CAS rejected: <${cond.subject}> <${cond.predicate}> expected ${cond.expectedValue}`);
            return false;
          }
        }
      } catch (err) {
        this.log.warn(ctx, `CAS rejected: query failed — ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    }
    this.log.info(ctx, `Remote CAS conditions passed (${conditions.length})`);
    return true;
  }

  /**
   * Handler for GossipSub shared memory topic: (data, fromPeerId) => void.
   * Validates, stores to SWM + SWM meta, updates sharedMemoryOwnedEntities.
   */
  async handle(data: Uint8Array, fromPeerId: string, onPhase?: PhaseCallback): Promise<void> {
    let ctx = createOperationContext('share');
    try {
      onPhase?.('decode', 'start');
      const decoded = this.decodeWorkspaceGossipMessage(data);
      const { envelope, signedPayload } = decoded;
      let request = decoded.request;
      let contextGraphId = request?.contextGraphId ?? decoded.senderKeyMessage?.contextGraphId ?? envelope?.contextGraphId;
      if (!contextGraphId) {
        this.log.warn(ctx, 'SWM write rejected: missing context graph id');
        return;
      }

      const agentGateAddresses = await this.getContextGraphAgentGateAddresses(contextGraphId);
      const allowedPeers = await this.getContextGraphAllowedPeers(contextGraphId);
      const hasPrivateAccessPolicy = await this.contextGraphHasPrivateAccessPolicy(contextGraphId);

      if (hasPrivateAccessPolicy && agentGateAddresses === null && allowedPeers === null) {
        this.log.warn(ctx, `SWM write rejected: private context graph "${contextGraphId}" has no gossip allowlist`);
        return;
      }

      if (hasPrivateAccessPolicy && agentGateAddresses === null) {
        this.log.warn(ctx, `SWM write rejected: private context graph "${contextGraphId}" requires DKG agent encryption recipients`);
        return;
      }

      if (agentGateAddresses !== null) {
        const verified = await this.verifyAgentEnvelope(envelope, signedPayload, contextGraphId, agentGateAddresses, ctx);
        if (!verified) return;
      }

      const requiresEncryptedPayload = hasPrivateAccessPolicy || agentGateAddresses !== null;
      if (requiresEncryptedPayload && !decoded.encryptedPayload && !decoded.senderKeyMessage) {
        this.log.warn(ctx, `SWM write rejected: Sender Key encrypted workspace payload required for private or agent-gated context graph "${contextGraphId}"`);
        return;
      }

      if (decoded.senderKeyMessage) {
        if (!requiresEncryptedPayload) {
          this.log.warn(ctx, `SWM write rejected: Sender Key payload is only supported for private or agent-gated context graph "${contextGraphId}"`);
          return;
        }
        if (!this.workspaceSenderKeyDecryptor) {
          this.log.warn(ctx, `SWM write rejected: no local Sender Key state decryptor for context graph "${contextGraphId}"`);
          return;
        }
        if (decoded.senderKeyMessage.contextGraphId !== contextGraphId) {
          this.log.warn(ctx, `SWM write rejected: Sender Key contextGraphId "${decoded.senderKeyMessage.contextGraphId}" does not match envelope "${contextGraphId}"`);
          return;
        }
        const plaintext = await this.workspaceSenderKeyDecryptor(decoded.senderKeyMessage, contextGraphId, ctx);
        request = decodeWorkspacePublishRequest(plaintext);
        if (request.contextGraphId !== contextGraphId) {
          this.log.warn(ctx, `SWM write rejected: Sender Key decrypted payload contextGraphId "${request.contextGraphId}" does not match envelope "${contextGraphId}"`);
          return;
        }
      } else if (decoded.encryptedPayload) {
        if (!requiresEncryptedPayload) {
          this.log.warn(ctx, `SWM write rejected: encrypted workspace payload is only supported for private or agent-gated context graph "${contextGraphId}"`);
          return;
        }
        if (this.workspaceSenderKeyDecryptor) {
          this.log.warn(ctx, `SWM write rejected: legacy encrypted workspace payload is not accepted for Sender Key protected context graph "${contextGraphId}"`);
          return;
        }
        if (decoded.encryptedPayload.contextGraphId !== contextGraphId) {
          this.log.warn(ctx, `SWM write rejected: encrypted contextGraphId "${decoded.encryptedPayload.contextGraphId}" does not match envelope "${contextGraphId}"`);
          return;
        }
        const plaintext = await this.decryptEncryptedWorkspacePayload(decoded.encryptedPayload, contextGraphId);
        request = decodeWorkspacePublishRequest(plaintext);
        if (request.contextGraphId !== contextGraphId) {
          this.log.warn(ctx, `SWM write rejected: decrypted payload contextGraphId "${request.contextGraphId}" does not match envelope "${contextGraphId}"`);
          return;
        }
      }

      if (!request) {
        this.log.warn(ctx, `SWM write rejected: no workspace publish request for context graph "${contextGraphId}"`);
        return;
      }

      if (request.operationId) {
        ctx = createOperationContext('share', request.operationId);
      }
      const { nquads, manifest, publisherPeerId, timestampMs, casConditions, subGraphName } = request;
      const shareOperationId = request.shareOperationId?.trim();
      const sgLabel = subGraphName ? `/${subGraphName}` : '';
      this.log.info(ctx, `SWM write from ${fromPeerId} for context graph ${contextGraphId}${sgLabel} op=${shareOperationId}`);

      if (!shareOperationId) {
        this.log.warn(ctx, `SWM write rejected: missing shareOperationId for context graph "${contextGraphId}"`);
        return;
      }

      if (publisherPeerId !== fromPeerId) {
        this.log.warn(ctx, `SWM write rejected: payload publisherPeerId "${publisherPeerId}" does not match sender "${fromPeerId}"`);
        return;
      }

      // PR-A R1 NOTE: the redundant-apply counter is bumped AFTER the
      // write succeeds (inside `if (applied)` below), not here. Counting
      // pre-validation deliveries would let bogus / replay-rejected /
      // CAS-rejected messages skew the `/api/slo` `redundantApplies`
      // gauge that the rc10 dedup decision relies on. Codex review on
      // PR #570 caught the earlier shape.

      // Enforce peer allowlist for curated CGs
      if (allowedPeers !== null && !allowedPeers.includes(fromPeerId)) {
        this.log.warn(ctx, `SWM write rejected: peer "${fromPeerId}" not in allowlist for context graph "${contextGraphId}"`);
        return;
      }

      if (subGraphName) {
        const v = validateSubGraphName(subGraphName);
        if (!v.valid) {
          this.log.warn(ctx, `SWM write rejected: invalid subGraphName "${subGraphName}": ${v.reason}`);
          return;
        }
      }

      await this.graphManager.ensureContextGraph(contextGraphId);

      if (subGraphName) {
        await this.graphManager.ensureSubGraph(contextGraphId, subGraphName);

        const sgUri = contextGraphSubGraphUri(contextGraphId, subGraphName);
        const metaGraph = `did:dkg:context-graph:${assertSafeIri(contextGraphId)}/_meta`;
        const alreadyRegistered = await this.store.query(
          `ASK { GRAPH <${metaGraph}> {
            <${assertSafeIri(sgUri)}> a <http://dkg.io/ontology/SubGraph> ;
              <http://schema.org/name> ${JSON.stringify(subGraphName)} ;
              <http://dkg.io/ontology/createdBy> ?createdBy .
          } }`,
        );
        if (alreadyRegistered.type !== 'boolean' || !alreadyRegistered.value) {
          const regQuads = generateSubGraphRegistration({
            contextGraphId,
            subGraphName,
            createdBy: publisherPeerId || 'swm-discovery',
            timestamp: new Date(),
          });
          await this.store.insert(regQuads);
          this.log.info(ctx, `Auto-registered sub-graph "${subGraphName}" in context graph "${contextGraphId}" from SWM`);
        }
      }

      const nquadsStr = new TextDecoder().decode(nquads);
      const quads = parseSimpleNQuads(nquadsStr);
      assertNoUserAuthoredTrustLevelQuads(quads);
      onPhase?.('decode', 'end');

      const manifestForValidation: KAManifestEntry[] = (manifest ?? []).map((m) => ({
        tokenId: 0n,
        rootEntity: m.rootEntity,
        privateMerkleRoot: m.privateMerkleRoot,
        privateTripleCount: m.privateTripleCount ?? 0,
      }));

      const swmGraph = this.graphManager.sharedMemoryUri(contextGraphId, subGraphName);
      const swmMetaGraph = this.graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName);

      const swmOwnershipKey = subGraphName ? `${contextGraphId}\0${subGraphName}` : contextGraphId;
      const condSubjects = (casConditions ?? []).map(c => c.subject);
      const subjects = [...new Set([...quads.map(q => q.subject), ...condSubjects])];
      const lockKeys = subjects.map(s => `${swmOwnershipKey}\0${s}`);

      onPhase?.('store', 'start');
      const applied = await this.withWriteLocks(lockKeys, async (): Promise<boolean> => {
        const swmOwned = this.sharedMemoryOwnedEntities.get(swmOwnershipKey) ?? new Map<string, string>();
        const existing = new Set<string>([...swmOwned.keys()]);

        const upsertable = new Set<string>();
        for (const [entity, creator] of swmOwned) {
          if (creator === publisherPeerId) {
            upsertable.add(entity);
          }
        }

        onPhase?.('validate', 'start');
        const validation = validatePublishRequest(
          quads, manifestForValidation, contextGraphId, existing,
          { allowUpsert: true, upsertableEntities: upsertable },
        );
        if (!validation.valid) {
          this.log.warn(ctx, `SWM validation rejected: ${validation.errors.join('; ')}`);
          return false;
        }
        onPhase?.('validate', 'end');

        if (casConditions && casConditions.length > 0) {
          const passed = await this.enforceCASConditions(casConditions, swmGraph, ctx);
          if (!passed) {
            // Intentional: we reject writes whose CAS pre-conditions don't hold
            // locally. This can cause temporary divergence if gossip delivers
            // writes out-of-order, but the originator's SWM-sync protocol
            // replays missed writes on reconnect, converging replicas eventually.
            // Accepting stale-CAS writes would silently corrupt local state.
            this.log.info(ctx, `Skipping SWM write ${shareOperationId} — remote CAS conditions not met`);
            return false;
          }
        }

        for (const m of manifestForValidation) {
          if (swmOwned.has(m.rootEntity)) {
            await this.store.deleteByPattern({ graph: swmGraph, subject: m.rootEntity });
            await this.store.deleteBySubjectPrefix(swmGraph, m.rootEntity + '/.well-known/genid/');
            await this.deleteMetaForRoot(swmMetaGraph, m.rootEntity);
          }
        }

        const normalized = quads.map((q) => ({ ...q, graph: swmGraph }));
        await this.store.insert(normalized);

        const rootEntities = manifestForValidation.map((m) => m.rootEntity);
        const operationTimestamp = new Date(Number(timestampMs));
        const metaQuads: Quad[] = [];

        for (const m of manifestForValidation) {
          if (m.privateMerkleRoot && m.privateMerkleRoot.length > 0) {
            const hex = '0x' + Array.from(m.privateMerkleRoot).map(b => b.toString(16).padStart(2, '0')).join('');
            metaQuads.push({
              subject: m.rootEntity,
              predicate: 'http://dkg.io/ontology/privateMerkleRoot',
              object: `"${hex}"`,
              graph: swmMetaGraph,
            });
          }
        }

        if (metaQuads.length > 0) {
          await this.store.insert(metaQuads);
        }
        await storeWorkspaceOperationPublicQuads({
          store: this.store,
          graphManager: this.graphManager,
          contextGraphId,
          shareOperationId,
          rootEntities,
          quads: normalized,
          publisherPeerId,
          subGraphName,
          timestamp: operationTimestamp,
          publicSnapshotStore: this.publicSnapshotStore,
        });

        if (!this.sharedMemoryOwnedEntities.has(swmOwnershipKey)) {
          this.sharedMemoryOwnedEntities.set(swmOwnershipKey, new Map());
        }
        const liveOwned = this.sharedMemoryOwnedEntities.get(swmOwnershipKey)!;
        const newOwnershipEntries: Array<{ rootEntity: string; creatorPeerId: string }> = [];
        for (const r of rootEntities) {
          if (!liveOwned.has(r)) {
            newOwnershipEntries.push({ rootEntity: r, creatorPeerId: publisherPeerId });
          }
        }
        if (newOwnershipEntries.length > 0) {
          for (const entry of newOwnershipEntries) {
            await this.store.deleteByPattern({
              graph: swmMetaGraph,
              subject: entry.rootEntity,
              predicate: 'http://dkg.io/ontology/workspaceOwner',
            });
          }
          await this.store.insert(generateOwnershipQuads(newOwnershipEntries, swmMetaGraph));
          for (const entry of newOwnershipEntries) {
            liveOwned.set(entry.rootEntity, entry.creatorPeerId);
          }
        }

        return true;
      });

      onPhase?.('store', 'end');
      if (applied) {
        // PR-A R1: only record the observation after the apply actually
        // succeeded — passing allowlist + sub-graph validation + CAS +
        // the durable store insert. Recording earlier would let
        // rejected duplicate deliveries count as "redundant applies"
        // and skew the `/api/slo` metric.
        this.recordSeenShareOp(contextGraphId, shareOperationId, ctx);
        this.log.info(ctx, `Stored SWM write ${shareOperationId} (${quads.length} quads)`);
        this.eventBus.emit(DKGEvent.MEMORY_GRAPH_CHANGED, {
          contextGraphId,
          layers: ['swm'],
          subGraphName,
          operation: 'shared_memory_gossiped',
          source: 'gossip',
          counts: { triples: quads.length },
        });
      }
    } catch (err) {
      this.log.error(ctx, `SWM handle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private decodeWorkspaceGossipMessage(data: Uint8Array): WorkspaceGossipDecodeResult {
    let envelope: GossipEnvelopeMsg | undefined;
    try {
      envelope = decodeGossipEnvelope(data);
    } catch {
      // Legacy raw workspace messages are still valid for non-agent-gated CGs.
    }
    if (
      envelope?.version === GOSSIP_ENVELOPE_VERSION &&
      envelope.type === GOSSIP_TYPE_WORKSPACE_PUBLISH &&
      envelope.payload &&
      envelope.payload.length > 0
    ) {
      const signedPayload = new Uint8Array(envelope.payload);
      const encryptedPayload = this.decodeEncryptedWorkspacePayload(signedPayload);
      const senderKeyMessage = encryptedPayload ? undefined : this.decodeSwmSenderKeyMessage(signedPayload);
      return {
        request: encryptedPayload || senderKeyMessage ? undefined : decodeWorkspacePublishRequest(signedPayload),
        envelope,
        signedPayload,
        encryptedPayload,
        senderKeyMessage,
        encrypted: encryptedPayload !== undefined || senderKeyMessage !== undefined,
      };
    }
    return {
      request: decodeWorkspacePublishRequest(data),
      signedPayload: data,
      encrypted: false,
    };
  }

  private decodeEncryptedWorkspacePayload(payload: Uint8Array): EncryptedWorkspacePayloadMsg | undefined {
    try {
      const encrypted = decodeEncryptedWorkspacePayload(payload);
      return encrypted.type === ENCRYPTED_WORKSPACE_ENVELOPE_TYPE ? encrypted : undefined;
    } catch {
      return undefined;
    }
  }

  private decodeSwmSenderKeyMessage(payload: Uint8Array): SwmSenderKeyMessageMsg | undefined {
    try {
      const message = decodeSwmSenderKeyMessageWire(payload);
      return message.type === SWM_SENDER_KEY_MESSAGE_TYPE ? message : undefined;
    } catch {
      return undefined;
    }
  }

  private async decryptEncryptedWorkspacePayload(
    encrypted: EncryptedWorkspacePayloadMsg,
    contextGraphId: string,
  ): Promise<Uint8Array> {
    if (!this.workspaceRecipientPrivateKeys) {
      throw new Error(`No local workspace recipient encryption keys available for context graph "${contextGraphId}"`);
    }
    const recipientKeys = await this.workspaceRecipientPrivateKeys(contextGraphId);
    const decrypted = await decryptWorkspacePayload(encrypted, recipientKeys);
    return decrypted.plaintext;
  }

  private async verifyAgentEnvelope(
    envelope: GossipEnvelopeMsg | undefined,
    payload: Uint8Array,
    contextGraphId: string,
    agentGateAddresses: string[],
    ctx: import('@origintrail-official/dkg-core').OperationContext,
  ): Promise<boolean> {
    if (!envelope) {
      this.log.warn(ctx, `SWM write rejected: unsigned workspace gossip for agent-gated context graph "${contextGraphId}"`);
      return false;
    }

    if (envelope.version !== GOSSIP_ENVELOPE_VERSION || envelope.type !== GOSSIP_TYPE_WORKSPACE_PUBLISH) {
      this.log.warn(ctx, `SWM write rejected: invalid gossip envelope type/version for context graph "${contextGraphId}"`);
      return false;
    }
    if (envelope.contextGraphId !== contextGraphId) {
      this.log.warn(ctx, `SWM write rejected: envelope contextGraphId "${envelope.contextGraphId}" does not match payload "${contextGraphId}"`);
      return false;
    }
    if (!envelope.signature || envelope.signature.length === 0) {
      this.log.warn(ctx, `SWM write rejected: missing agent signature for context graph "${contextGraphId}"`);
      return false;
    }

    const timestampMs = Date.parse(envelope.timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(this.now() - timestampMs) > GOSSIP_ENVELOPE_FRESHNESS_MS) {
      this.log.warn(ctx, `SWM write rejected: stale or invalid gossip timestamp "${envelope.timestamp}"`);
      return false;
    }

    let claimedAgent: string;
    let recovered: string;
    try {
      claimedAgent = ethers.getAddress(envelope.agentAddress);
      const signingPayload = computeGossipSigningPayload(
        envelope.type,
        envelope.contextGraphId,
        envelope.timestamp,
        payload,
      );
      recovered = ethers.verifyMessage(signingPayload, ethers.hexlify(envelope.signature));
    } catch (err) {
      this.log.warn(ctx, `SWM write rejected: invalid agent signature (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }

    if (recovered.toLowerCase() !== claimedAgent.toLowerCase()) {
      this.log.warn(ctx, `SWM write rejected: recovered signer ${recovered} does not match envelope agent ${claimedAgent}`);
      return false;
    }

    const agentGateSet = new Set(agentGateAddresses.map((agent) => agent.toLowerCase()));
    if (!agentGateSet.has(recovered.toLowerCase())) {
      this.log.warn(ctx, `SWM write rejected: agent ${recovered} is not allowed for context graph "${contextGraphId}"`);
      return false;
    }

    if (this.localAgentAddresses) {
      const localAgents = await this.localAgentAddresses();
      const localAllowed = localAgents.some((agent) => agentGateSet.has(agent.toLowerCase()));
      if (!localAllowed) {
        this.log.warn(ctx, `SWM write rejected: local node has no allowed agent for context graph "${contextGraphId}"`);
        return false;
      }
    }

    return true;
  }

  /**
   * Returns the peer allowlist for a context graph, or null if no allowlist
   * is set (open CG — all peers allowed).
   */
  private async getContextGraphAllowedPeers(contextGraphId: string): Promise<string[] | null> {
    const cgMeta = contextGraphMetaUri(contextGraphId);
    const cgData = contextGraphDataUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?peer WHERE { GRAPH <${cgMeta}> { <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}> ?peer } }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      return null;
    }
    return result.bindings
      .map(row => row['peer'])
      .filter((v): v is string => typeof v === 'string')
      .map(stripRdfLiteral);
  }

  /**
   * Returns the accepted SWM writer agent addresses for a context graph, or
   * null if the graph is not agent-gated. Includes DKG_ALLOWED_AGENT and
   * DKG_PARTICIPANT_AGENT metadata.
   */
  private async getContextGraphAgentGateAddresses(contextGraphId: string): Promise<string[] | null> {
    const cgMeta = contextGraphMetaUri(contextGraphId);
    const cgData = contextGraphDataUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?agent WHERE { GRAPH <${cgMeta}> {
        { <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent }
        UNION
        { <${cgData}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?agent }
      } }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      return null;
    }
    const agents = result.bindings
      .map(row => row['agent'])
      .filter((v): v is string => typeof v === 'string')
      .map(stripRdfLiteral)
      .filter((v) => ethers.isAddress(v))
      .map((v) => ethers.getAddress(v));
    return [...new Set(agents)];
  }

  private async contextGraphHasPrivateAccessPolicy(contextGraphId: string): Promise<boolean> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return false;
    }

    const ontologyGraph = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMeta = contextGraphMetaUri(contextGraphId);
    const cgData = contextGraphDataUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?policy WHERE {
        {
          GRAPH <${ontologyGraph}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        } UNION {
          GRAPH <${cgMeta}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        }
      }`,
    );
    if (result.type !== 'bindings') {
      return false;
    }
    return result.bindings.some((row) => {
      const policy = row['policy'];
      return typeof policy === 'string' && stripRdfLiteral(policy) === 'private';
    });
  }

  /**
   * Remove the SWM meta link for a specific rootEntity.
   * Only deletes the entire operation subject when no rootEntity links remain,
   * preserving metadata for other roots written in the same operation.
   */
  private async deleteMetaForRoot(metaGraph: string, rootEntity: string): Promise<void> {
    const DKG = 'http://dkg.io/ontology/';
    const result = await this.store.query(
      `SELECT ?op WHERE { GRAPH <${metaGraph}> { ?op <${DKG}rootEntity> <${rootEntity}> } }`,
    );
    if (result.type !== 'bindings') return;
    for (const row of result.bindings) {
      const op = row['op'];
      if (!op) continue;

      await this.store.delete([{
        subject: op, predicate: `${DKG}rootEntity`, object: rootEntity, graph: metaGraph,
      }]);

      const remaining = await this.store.query(
        `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${metaGraph}> { <${op}> <${DKG}rootEntity> ?r } }`,
      );
      const rawCount = remaining.type === 'bindings' && remaining.bindings[0]?.['c'];
      const countVal = parseCountLiteral(rawCount);
      if (countVal === 0) {
        await this.store.deleteByPattern({ graph: metaGraph, subject: op });
      }
    }
  }
}

/** @deprecated Use SharedMemoryHandler */
export const WorkspaceHandler = SharedMemoryHandler;

function parseCountLiteral(val: string | false | undefined): number {
  if (!val) return NaN;
  const stripped = val.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');
  const n = Number(stripped);
  return Number.isFinite(n) ? n : NaN;
}

function stripRdfLiteral(value: string): string {
  return value
    .replace(/^"/, '')
    .replace(/"(@[a-zA-Z-]+|\^\^<[^>]+>)?$/, '');
}
