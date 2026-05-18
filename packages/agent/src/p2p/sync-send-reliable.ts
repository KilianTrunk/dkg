import { RESPONSE_GONE_MARKER } from '@origintrail-official/dkg-core';
import type { Messenger } from './messenger.js';

/**
 * Wraps {@link Messenger.sendReliable} for sync page requests, adding
 * RESPONSE_GONE re-issue handling on top of the substrate.
 *
 * The substrate's receiver-side idempotency cache stores responses
 * inline only up to {@link RESPONSE_CACHE_BYTES} (256 KiB at time
 * of writing). Larger responses are stored mark-only — a duplicate
 * receive then yields the literal `RESPONSE_GONE_MARKER` instead of
 * the original bytes. Sync responses (N-Quads pages) routinely
 * exceed that limit, so this case fires in normal operation any
 * time a withRetry attempt for the same `(peer, protocol,
 * messageId)` reaches the receiver after the original response was
 * already computed and dropped.
 *
 * Naive callers that returned the sentinel upstream would have
 * `fetchSyncPages` parse `'RESPONSE_GONE'` as N-Quads (yielding
 * zero quads), trip the page-loop's empty-page terminator, and
 * silently drop the rest of the sync. This helper handles that by
 * mirroring the pattern already established for `/query-remote`
 * (see `sendQueryReliable` in dkg-agent.ts):
 *
 *   - Attempt 1 uses the caller-supplied stable `messageId` so
 *     sender-side dedup + receiver-side response cache still work
 *     for the common case (no large response, no duplicate receive).
 *   - If attempt 1 returns `RESPONSE_GONE`, attempt 2 re-issues
 *     with a fresh messageId (by passing none → the messenger
 *     generates a UUID v4) so the responder re-runs the SPARQL
 *     query and returns a fresh response. Semantically safe
 *     because sync queries are app-layer idempotent: querying the
 *     same `(cgId, scope, phase, offset, snapshotRef)` twice yields
 *     equivalent results modulo concurrent writes (and concurrent
 *     writes are reconciled by the next sync pass anyway).
 *   - Capped at 2 attempts so a peer that always blows the cache
 *     surfaces as a hard error to the caller (and thus to
 *     `sendSyncRequest`'s `withRetry`) instead of looping forever.
 *
 * rc.9 PR-E follow-up #3 (codex review on #569).
 */
export async function sendSyncReliable(
  messenger: Pick<Messenger, 'sendReliable'>,
  peerId: string,
  protocolId: string,
  payload: Uint8Array,
  timeoutMs: number,
  messageId: string,
): Promise<Uint8Array> {
  const MAX_ATTEMPTS = 2;
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const useStableId = attempt === 1;
    const result = await messenger.sendReliable(peerId, protocolId, payload, {
      timeoutMs,
      ...(useStableId ? { messageId } : {}),
    });
    if (!result.delivered) {
      // Surface queued / in-flight as a hard failure for THIS
      // attempt — sync is synchronous-by-contract and the caller
      // (page-fetch) needs bytes back NOW to advance pagination.
      // The surrounding `withRetry` in sync-transport.ts handles
      // backoff. We do NOT recurse on queued because the outbox
      // will eventually deliver and populate the receiver dedup
      // cache; the retry there will then hit either a real
      // response or this RESPONSE_GONE path.
      const queuedSuffix = 'queued' in result && result.queued
        ? 'queued (not synchronously deliverable)'
        : 'failed';
      throw new Error(`Sync send to ${peerId} ${queuedSuffix}: ${result.error ?? 'unknown'}`);
    }
    const respText = new TextDecoder().decode(result.response);
    if (respText === RESPONSE_GONE_MARKER) {
      lastErr = new Error(
        `RESPONSE_GONE: prior sync response too large to inline-cache; ` +
          `retrying with fresh messageId (peer=${peerId}, attempt=${attempt}/${MAX_ATTEMPTS})`,
      );
      continue;
    }
    return result.response;
  }
  // Both attempts returned RESPONSE_GONE — vanishingly unlikely
  // because attempt 2 forces a fresh responder execution, but we
  // surface it as a hard error rather than loop. Codex pattern.
  throw lastErr ?? new Error(`Sync send to ${peerId} exhausted RESPONSE_GONE retries`);
}
