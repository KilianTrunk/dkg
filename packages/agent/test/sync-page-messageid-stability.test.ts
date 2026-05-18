import { describe, it, expect } from 'vitest';
import {
  fetchSyncPages,
  computeSyncPageMessageId,
} from '../src/sync/requester/page-fetch.js';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { SyncPhase } from '../src/sync/auth/request-build.js';

/**
 * Regression test for the rc.9 PR-E codex review finding (#569).
 *
 * The bug: `dkg-agent.ts`'s `send` adapter routed sync page fetches
 * through `messenger.sendReliable(...)` WITHOUT supplying a stable
 * `messageId`. `sendReliable` falls back to `randomUUID()` when no
 * id is given, so every retry inside `sendSyncRequest`'s `withRetry`
 * loop became a fresh reliable message — defeating sender-side
 * dedup, the receiver's response cache, and leaving multiple queued
 * outbox entries for the same logical page request.
 *
 * The fix routes `computeSyncPageMessageId(...)` through
 * `fetchSyncPages` → `sendSyncRequest` → `send` so the same id is
 * passed to `sendReliable` on every retry. These tests assert:
 *
 *  1. `computeSyncPageMessageId` is a pure function of the request
 *     identity tuple (same inputs → same id, different inputs →
 *     different ids).
 *  2. `fetchSyncPages` propagates that id to every attempt of the
 *     `send` callback, including retries triggered by `withRetry`
 *     when earlier attempts throw.
 *  3. Distinct logical pages within the same fetch get distinct
 *     messageIds (so the receiver doesn't collapse different
 *     offsets into a single cached response).
 */

const noopLog = (_ctx: OperationContext, _msg: string) => {};

const REMOTE_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const CG_ID = 'msgid-test-cg';
const GRAPH_URI = `did:dkg:context-graph:${CG_ID}`;
const PROTOCOL_ID = '/dkg/10.0.1/sync';

function makeCtx(): OperationContext {
  return { opId: 'test-op', startedAt: Date.now() } as unknown as OperationContext;
}

/**
 * Minimal `parseAndFilter` that turns a 1-line N-quads payload into a
 * single fake quad so the page loop advances, then short-circuits
 * (because the second page returns empty).
 */
async function singleQuadParser(nquadsText: string) {
  if (!nquadsText) return { quads: [], totalQuads: 0 };
  // Total < syncPageSize triggers the break in the page loop, so we
  // only need the responder to ever return a single page for the fetch
  // to complete.
  return { quads: [{ subject: 'x' }] as never[], totalQuads: 1 };
}

const FIXED_NONCE = '00000000-0000-0000-0000-000000000000';

describe('computeSyncPageMessageId', () => {
  it('is deterministic for the same identity tuple + runNonce', () => {
    const a = computeSyncPageMessageId({
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      runNonce: FIXED_NONCE,
    });
    const b = computeSyncPageMessageId({
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      includeSharedMemory: false,
      phase: 'data',
      offset: 0,
      runNonce: FIXED_NONCE,
    });
    expect(a).toBe(b);
  });

  it('differs across phase / offset / cgId / peer / snapshotRef', () => {
    const base = {
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      includeSharedMemory: false,
      phase: 'data' as SyncPhase,
      offset: 0,
      runNonce: FIXED_NONCE,
    };
    const baseId = computeSyncPageMessageId(base);

    expect(computeSyncPageMessageId({ ...base, phase: 'meta' })).not.toBe(baseId);
    expect(computeSyncPageMessageId({ ...base, offset: 100 })).not.toBe(baseId);
    expect(computeSyncPageMessageId({ ...base, contextGraphId: 'other-cg' })).not.toBe(baseId);
    expect(
      computeSyncPageMessageId({ ...base, remotePeerId: '12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw' }),
    ).not.toBe(baseId);
    expect(computeSyncPageMessageId({ ...base, snapshotRef: 'snap-1' })).not.toBe(baseId);
  });

  /**
   * Regression for codex review #2 on #569: the key MUST encode
   * `includeSharedMemory`. Without it, durable + SWM page fetches
   * with the same `(peer, cgId, phase, offset, snapshotRef)`
   * collapse to the same messageId, and the messenger's dedup on
   * `(peer, protocol, messageId)` would happily serve a later SWM
   * fetch from a cached durable response (or vice versa) without
   * ever contacting the remote peer.
   */
  it('differs between durable and SWM scopes for an otherwise identical tuple', () => {
    const base = {
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      phase: 'data' as SyncPhase,
      offset: 0,
      runNonce: FIXED_NONCE,
    };
    const durableId = computeSyncPageMessageId({ ...base, includeSharedMemory: false });
    const swmId = computeSyncPageMessageId({ ...base, includeSharedMemory: true });
    expect(durableId).not.toBe(swmId);
    // Sanity-check the literal-prefix tokens so a future refactor
    // that collapses both into a single token can't silently
    // re-introduce the collision.
    expect(durableId).toContain(':durable:');
    expect(swmId).toContain(':swm:');
  });

  /**
   * Regression for codex review #4 on #569: the key MUST differ
   * across `fetchSyncPages` runs (different `runNonce`s) even for
   * the same identity tuple. Without it, the substrate's sender-side
   * dedup cache would replay a stale response from a previous full
   * sync — completed syncs delete their checkpoints, so the next
   * full sync of the same graph would reuse the deterministic key
   * and get the OLD page bytes back, hiding any quads added between
   * the two runs until the idempotency store's TTL pruned the entry.
   */
  it('differs across runNonces (per-fetchSyncPages scoping)', () => {
    const base = {
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      includeSharedMemory: false,
      phase: 'data' as SyncPhase,
      offset: 0,
    };
    const run1Id = computeSyncPageMessageId({ ...base, runNonce: 'run-1-nonce' });
    const run2Id = computeSyncPageMessageId({ ...base, runNonce: 'run-2-nonce' });
    expect(run1Id).not.toBe(run2Id);
    expect(run1Id).toContain('run-1-nonce');
    expect(run2Id).toContain('run-2-nonce');
  });

  it('treats undefined snapshotRef and the literal "-" as different', () => {
    // Sanity: the placeholder is intentionally outside the valid
    // snapshotRef alphabet so it can't collide with a real ref.
    const noRef = computeSyncPageMessageId({
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      includeSharedMemory: false,
      phase: 'snapshot',
      offset: 0,
      runNonce: FIXED_NONCE,
    });
    const explicitRef = computeSyncPageMessageId({
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      includeSharedMemory: false,
      phase: 'snapshot',
      offset: 0,
      snapshotRef: 'real-snap',
      runNonce: FIXED_NONCE,
    });
    expect(noRef).not.toBe(explicitRef);
  });
});

describe('fetchSyncPages messageId propagation', () => {
  it('passes the SAME messageId to send on every retry for the same page', async () => {
    let attemptForThisPage = 0;
    const observedMessageIds: string[] = [];

    await fetchSyncPages({
      ctx: makeCtx(),
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      includeSharedMemory: false,
      phase: 'data',
      graphUri: GRAPH_URI,
      deadline: Date.now() + 60_000,
      syncPageTimeoutMs: 5_000,
      syncRouterAttempts: 1,
      // Force at least 3 attempts so withRetry exercises the retry loop.
      syncPageRetryAttempts: 5,
      syncPageSize: 100,
      syncDeniedResponse: '#DENIED',
      debugSyncProgress: false,
      protocolSync: PROTOCOL_ID,
      checkpointStore: {
        get: () => 0,
        set: () => {},
        delete: () => {},
      },
      buildSyncRequest: async () => new TextEncoder().encode('request'),
      parseAndFilter: singleQuadParser,
      send: async (_peerId, _protocolId, _data, _timeoutMs, messageId) => {
        observedMessageIds.push(messageId);
        attemptForThisPage++;
        // First two attempts throw → withRetry retries; third succeeds.
        if (attemptForThisPage < 3) {
          throw new Error(`transient failure ${attemptForThisPage}`);
        }
        // Single-quad response → loop exits after 1 page (parsed.totalQuads < syncPageSize).
        return new TextEncoder().encode('one-quad-line');
      },
      logWarn: noopLog,
      logInfo: noopLog,
      logDebug: noopLog,
    });

    expect(observedMessageIds.length).toBe(3);
    // All 3 attempts MUST share the same id — that's the whole point of
    // the fix. Pre-fix: each attempt's `sendReliable` minted a fresh
    // randomUUID() and dedup never fired.
    expect(observedMessageIds[0]).toBe(observedMessageIds[1]);
    expect(observedMessageIds[1]).toBe(observedMessageIds[2]);

    // And the id MUST follow the documented shape:
    //   sync:<peer>:<cg>:<scope>:<phase>:<offset>:<snap-or-'-'>:<runNonce>
    // The runNonce is generated internally per fetchSyncPages call so
    // we can't recompute it externally — assert the prefix instead,
    // so a refactor that changed the shape (or dropped the nonce)
    // would still trip this test.
    expect(observedMessageIds[0]).toMatch(
      new RegExp(`^sync:${REMOTE_PEER_ID}:${CG_ID}:durable:data:0:-:[^:]+$`),
    );
  });

  /**
   * Regression for codex review #4 on #569: two separate
   * `fetchSyncPages` invocations for the same `(peer, cg, phase,
   * offset)` MUST emit different messageIds at the `send` boundary,
   * because the per-fetch `runNonce` is mixed in. Without that, the
   * substrate's sender-side dedup cache would replay a stale
   * response from the first fetch on the second fetch, hiding any
   * quads added between the two runs.
   */
  it('emits DIFFERENT messageIds across separate fetchSyncPages runs (per-run nonce scoping)', async () => {
    const captured: string[] = [];

    async function runOneFetch(): Promise<void> {
      await fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 1,
        syncPageSize: 100,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 0,
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async () => new TextEncoder().encode('request'),
        parseAndFilter: singleQuadParser,
        send: async (_peerId, _protocolId, _data, _timeoutMs, messageId) => {
          captured.push(messageId);
          return new TextEncoder().encode('one-quad-line');
        },
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      });
    }

    await runOneFetch();
    await runOneFetch();

    expect(captured.length).toBe(2);
    expect(captured[0]).not.toBe(captured[1]);
    // Both should still follow the documented shape (only the
    // trailing nonce differs).
    const prefix = `sync:${REMOTE_PEER_ID}:${CG_ID}:durable:data:0:-:`;
    expect(captured[0]).toMatch(new RegExp(`^${prefix}[^:]+$`));
    expect(captured[1]).toMatch(new RegExp(`^${prefix}[^:]+$`));
  });

  /**
   * End-to-end regression for the codex review on #569: when a
   * durable fetch and an SWM fetch race for the same `(peer, cgId,
   * phase, offset, snapshotRef)`, the messageIds observed at the
   * `send` boundary MUST differ. Otherwise the messenger's dedup
   * would silently serve one from the other's cached response.
   *
   * Drives two `fetchSyncPages` calls with `includeSharedMemory`
   * toggled and asserts the captured messageIds are distinct.
   */
  it('emits distinct messageIds for durable vs SWM fetches with the same phase/offset', async () => {
    const captured: Array<{ scope: 'durable' | 'swm'; messageId: string }> = [];

    async function runOneFetch(includeSharedMemory: boolean): Promise<void> {
      await fetchSyncPages({
        ctx: makeCtx(),
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: CG_ID,
        includeSharedMemory,
        phase: 'data',
        graphUri: GRAPH_URI,
        deadline: Date.now() + 60_000,
        syncPageTimeoutMs: 5_000,
        syncRouterAttempts: 1,
        syncPageRetryAttempts: 1,
        syncPageSize: 100,
        syncDeniedResponse: '#DENIED',
        debugSyncProgress: false,
        protocolSync: PROTOCOL_ID,
        checkpointStore: {
          get: () => 0,
          set: () => {},
          delete: () => {},
        },
        buildSyncRequest: async () => new TextEncoder().encode('request'),
        parseAndFilter: singleQuadParser,
        send: async (_peerId, _protocolId, _data, _timeoutMs, messageId) => {
          captured.push({ scope: includeSharedMemory ? 'swm' : 'durable', messageId });
          return new TextEncoder().encode('one-quad-line');
        },
        logWarn: noopLog,
        logInfo: noopLog,
        logDebug: noopLog,
      });
    }

    await runOneFetch(false);
    await runOneFetch(true);

    expect(captured.length).toBe(2);
    const durable = captured.find((c) => c.scope === 'durable');
    const swm = captured.find((c) => c.scope === 'swm');
    expect(durable).toBeDefined();
    expect(swm).toBeDefined();
    expect(durable!.messageId).not.toBe(swm!.messageId);
  });

  /**
   * Regression for codex review #5 on #569: `buildSyncRequest` MUST
   * run ONCE per page, not once per withRetry attempt. Otherwise
   * private syncs would mint a fresh `requestId`/`issuedAtMs` per
   * attempt while the receiver's dedup keys on `(peer, protocol,
   * messageId)` BEFORE the auth handler — meaning a cached denial
   * (or aged-out signature) from attempt 1 would replay on the
   * fresh-envelope attempt 2 without ever being validated.
   *
   * Forces 3 retries for one page and asserts `buildSyncRequest`
   * was invoked exactly once.
   */
  it('builds the request envelope ONCE per page, not per withRetry attempt', async () => {
    let buildCalls = 0;
    let sendAttempts = 0;

    await fetchSyncPages({
      ctx: makeCtx(),
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      includeSharedMemory: false,
      phase: 'data',
      graphUri: GRAPH_URI,
      deadline: Date.now() + 60_000,
      syncPageTimeoutMs: 5_000,
      syncRouterAttempts: 1,
      syncPageRetryAttempts: 5,
      syncPageSize: 100,
      syncDeniedResponse: '#DENIED',
      debugSyncProgress: false,
      protocolSync: PROTOCOL_ID,
      checkpointStore: {
        get: () => 0,
        set: () => {},
        delete: () => {},
      },
      buildSyncRequest: async () => {
        buildCalls++;
        return new TextEncoder().encode('request');
      },
      parseAndFilter: singleQuadParser,
      send: async (_peerId, _protocolId, _data, _timeoutMs, _messageId) => {
        sendAttempts++;
        if (sendAttempts < 3) {
          throw new Error(`transient failure ${sendAttempts}`);
        }
        return new TextEncoder().encode('one-quad-line');
      },
      logWarn: noopLog,
      logInfo: noopLog,
      logDebug: noopLog,
    });

    expect(sendAttempts).toBe(3);
    // Pre-fix: each of the 3 attempts would call buildSyncRequest
    // → 3 fresh envelopes with 3 different requestId/issuedAtMs.
    // Post-fix: build once, send the same bytes on every retry.
    expect(buildCalls).toBe(1);
  });

  it('uses DIFFERENT messageIds for different page offsets in the same fetch', async () => {
    // Drive 3 pages by returning a "full" page (totalQuads ===
    // syncPageSize) for the first two and an empty page for the
    // third, so the loop iterates 3 times.
    const observedMessageIdsByOffset = new Map<number, string>();
    let currentOffset = 0;

    await fetchSyncPages({
      ctx: makeCtx(),
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      includeSharedMemory: false,
      phase: 'data',
      graphUri: GRAPH_URI,
      deadline: Date.now() + 60_000,
      syncPageTimeoutMs: 5_000,
      syncRouterAttempts: 1,
      syncPageRetryAttempts: 1,
      // syncPageSize=1 + each parser call returns 1 quad → keeps
      // looping forever in principle; we break it by returning empty
      // after the second page.
      syncPageSize: 1,
      syncDeniedResponse: '#DENIED',
      debugSyncProgress: false,
      protocolSync: PROTOCOL_ID,
      checkpointStore: {
        get: () => 0,
        set: () => {},
        delete: () => {},
      },
      buildSyncRequest: async () => new TextEncoder().encode('request'),
      parseAndFilter: async (nquadsText) => {
        if (!nquadsText) return { quads: [], totalQuads: 0 };
        return { quads: [{ subject: 'x' }] as never[], totalQuads: 1 };
      },
      send: async (_peerId, _protocolId, _data, _timeoutMs, messageId) => {
        observedMessageIdsByOffset.set(currentOffset, messageId);
        const reply = currentOffset >= 2 ? '' : 'one-quad-line';
        currentOffset++;
        return new TextEncoder().encode(reply);
      },
      logWarn: noopLog,
      logInfo: noopLog,
      logDebug: noopLog,
    });

    // Should have observed at least 2 distinct offsets (offset=0 and
    // offset=1 yielding data; offset=2 returning empty terminates
    // the loop before its messageId is captured here only if the
    // empty arm hits — it does, see send body — so we expect 3).
    expect(observedMessageIdsByOffset.size).toBe(3);
    const ids = [...observedMessageIdsByOffset.values()];
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
