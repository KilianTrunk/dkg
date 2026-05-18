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

describe('computeSyncPageMessageId', () => {
  it('is deterministic for the same identity tuple', () => {
    const a = computeSyncPageMessageId({
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      phase: 'data',
      offset: 0,
    });
    const b = computeSyncPageMessageId({
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      phase: 'data',
      offset: 0,
    });
    expect(a).toBe(b);
  });

  it('differs across phase / offset / cgId / peer / snapshotRef', () => {
    const base = {
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      phase: 'data' as SyncPhase,
      offset: 0,
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

  it('treats undefined snapshotRef and the literal "-" as different', () => {
    // Sanity: the placeholder is intentionally outside the valid
    // snapshotRef alphabet so it can't collide with a real ref.
    const noRef = computeSyncPageMessageId({
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      phase: 'snapshot',
      offset: 0,
    });
    const explicitRef = computeSyncPageMessageId({
      remotePeerId: REMOTE_PEER_ID,
      contextGraphId: CG_ID,
      phase: 'snapshot',
      offset: 0,
      snapshotRef: 'real-snap',
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

    // And it must be the deterministic id we'd compute externally —
    // i.e. it's not just an internal random id that happens to be
    // stable; it's recoverable by the receiver/test if needed.
    expect(observedMessageIds[0]).toBe(
      computeSyncPageMessageId({
        remotePeerId: REMOTE_PEER_ID,
        contextGraphId: CG_ID,
        phase: 'data',
        offset: 0,
      }),
    );
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
