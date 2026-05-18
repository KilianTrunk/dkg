import { randomUUID } from 'node:crypto';
import { RESPONSE_GONE_MARKER, withRetry, type OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { sendSyncRequest } from '../../p2p/sync-transport.js';
import type { SyncPhase } from '../auth/request-build.js';
import { getSyncCheckpointKey, type SyncCheckpointStore } from '../checkpoint/state.js';

export interface SyncPageResult {
  quads: Quad[];
  bytesReceived: number;
  resumedFromOffset: number;
  nextOffset: number;
  checkpointKey: string;
  completed: boolean;
}

interface FetchSyncPagesParams {
  ctx: OperationContext;
  remotePeerId: string;
  contextGraphId: string;
  includeSharedMemory: boolean;
  phase: SyncPhase;
  graphUri: string;
  snapshotRef?: string;
  deadline: number;
  syncPageTimeoutMs: number;
  syncRouterAttempts: number;
  syncPageRetryAttempts: number;
  syncPageSize: number;
  syncDeniedResponse: string;
  /**
   * Additional response-body sentinels that also mean "ACL denied". Exists so
   * this requester keeps recognising the legacy `#DKG-SYNC-ACCESS-DENIED`
   * marker emitted by older (pre-sync-refactor) responders while they are
   * still around during a rolling upgrade. Without this, a legacy denial
   * would be parsed as N-quads, yield 0 triples, and silently get classified
   * as "peer had nothing to send" instead of flipping `deniedPhases`. Empty
   * / unset means only `syncDeniedResponse` is treated as a denial. Callers
   * that don't care about legacy compatibility can omit this. (tier-4 G1)
   */
  extraDeniedResponses?: readonly string[];
  debugSyncProgress: boolean;
  protocolSync: string;
  checkpointStore: SyncCheckpointStore;
  buildSyncRequest: (contextGraphId: string, offset: number, limit: number, includeSharedMemory: boolean, remotePeerId: string, phase?: SyncPhase, snapshotRef?: string) => Promise<Uint8Array>;
  parseAndFilter: (nquadsText: string, graphUri: string, contextGraphId: string) => Promise<{ quads: Quad[]; totalQuads: number }>;
  /**
   * rc.9 PR-E follow-up (codex review on #569): `send` receives a
   * stable per-page `messageId` so a substrate-backed implementation
   * (e.g. {@link DKGAgent}'s adapter that routes through
   * `messenger.sendReliable`) keeps the SAME idempotency key across
   * every {@link withRetry} attempt. Without that, each retry would
   * mint a fresh randomUUID() and defeat both sender-side dedup and
   * the receiver's response cache, leaving multiple queued outbox
   * entries for the same logical page request.
   */
  send: (
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    timeoutMs: number,
    messageId: string,
  ) => Promise<Uint8Array>;
  logWarn: (ctx: OperationContext, message: string) => void;
  logInfo: (ctx: OperationContext, message: string) => void;
  logDebug: (ctx: OperationContext, message: string) => void;
}

/**
 * Stable, per-retry-chain idempotency key for a single sync page request.
 *
 * Composed from the inputs that uniquely identify "which page from
 * which responder for which slice of state" — `(remotePeerId, cgId,
 * includeSharedMemory, phase, offset, snapshotRef)` — PLUS a
 * per-{@link fetchSyncPages}-call `runNonce`. The static parts let
 * the key be reconstructed externally for assertions; the nonce
 * scopes the key to a single fetch run.
 *
 * ## Why the nonce
 *
 * rc.9 PR-E follow-up #4 (codex review on #569): without the nonce,
 * the key was deterministic forever for the same identity tuple.
 * `Messenger.sendReliable` caches `(peer, protocol, messageId)`
 * responses, and a completed sync deletes its checkpoints, so the
 * next full sync of the same graph would reuse this id and get the
 * OLD page bytes from the sender-side dedup cache — replaying stale
 * data and hiding newly-added quads until the cache TTL expired.
 *
 * The nonce is minted once per `fetchSyncPages` call and reused
 * across every page + every withRetry attempt within that call, so:
 *
 *   - Within one fetch run, retries for the same `(offset, phase,
 *     scope)` collapse onto the same id — the original purpose of
 *     the messageId (sender-side dedup of retry storms +
 *     receiver-side response cache for the SAME logical request).
 *   - Across fetch runs, the nonce differs — fresh sync passes
 *     never get poisoned by a stale cached response from a previous
 *     run.
 *
 * ## Why includeSharedMemory is in the key
 *
 * Follow-up #2 — `runDurableSync` and `runSharedMemorySync` both
 * call `fetchSyncPages` with the same phase (`'data'` / `'meta'`)
 * for overlapping offsets, distinguished only by this flag. The
 * checkpoint key (`getSyncCheckpointKey`) already encodes it for
 * the same reason. Without it the receiver might serve a later SWM
 * fetch from a cached durable response.
 *
 * ## What's NOT in the key
 *
 * Requester peerId is intentionally omitted — the messenger already
 * namespaces by `(senderPeerId, protocolId, messageId)`, so "our
 * identity" is implicit. Including it would only matter if a single
 * messenger instance ran with multiple identities, which we never
 * do.
 *
 * Plain string (not hashed) — it's an idempotency key, not a
 * secret; exact-match lookups in the messenger's Maps so length is
 * fine.
 */
export function computeSyncPageMessageId(parts: {
  remotePeerId: string;
  contextGraphId: string;
  includeSharedMemory: boolean;
  phase: SyncPhase;
  offset: number;
  snapshotRef?: string;
  /**
   * Per-fetchSyncPages-call nonce that scopes the messageId to a
   * single retry chain. See "Why the nonce" in the function jsdoc.
   * `fetchSyncPages` generates this once and passes it to every
   * call; tests construct one freely.
   */
  runNonce: string;
}): string {
  const scope = parts.includeSharedMemory ? 'swm' : 'durable';
  return `sync:${parts.remotePeerId}:${parts.contextGraphId}:${scope}:${parts.phase}:${parts.offset}:${parts.snapshotRef ?? '-'}:${parts.runNonce}`;
}

export async function fetchSyncPages(params: FetchSyncPagesParams): Promise<SyncPageResult> {
  const {
    ctx,
    remotePeerId,
    contextGraphId,
    includeSharedMemory,
    phase,
    graphUri,
    snapshotRef,
    deadline,
    syncPageTimeoutMs,
    syncRouterAttempts,
    syncPageRetryAttempts,
    syncPageSize,
    syncDeniedResponse,
    extraDeniedResponses,
    debugSyncProgress,
    protocolSync,
    checkpointStore,
    buildSyncRequest,
    parseAndFilter,
    send,
    logWarn,
    logInfo,
    logDebug,
  } = params;

  const allQuads: Quad[] = [];
  const checkpointKey = getSyncCheckpointKey(remotePeerId, contextGraphId, includeSharedMemory, phase, snapshotRef);
  let offset = checkpointStore.get(checkpointKey) ?? 0;
  const resumedFromOffset = offset;
  let bytesReceived = 0;
  let timedOut = false;
  // rc.9 PR-E follow-up #4 (codex review on #569): per-run nonce
  // mixed into every page's messageId. Scopes the substrate's
  // (peer, protocol, messageId) dedup to a single fetchSyncPages
  // invocation so a later full-sync pass (after the checkpoint was
  // deleted) doesn't get poisoned by a cached response from a
  // previous pass.
  const runNonce = randomUUID();

  while (true) {
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }

    const remainingMs = Math.max(0, deadline - Date.now());
    const timeoutMs = Math.min(
      syncPageTimeoutMs,
      Math.max(2000, Math.floor(remainingMs / syncRouterAttempts)),
    );

    const curOffset = offset;
    const transportStartedAt = Date.now();
    // Compute stable messageId ONCE per page (includes runNonce) and
    // build the envelope payload ONCE per page, both OUTSIDE the
    // withRetry wrapper inside sendSyncRequest. Three reasons (codex
    // review #569 follow-up):
    //   #1: every retry attempt for this page reuses the SAME id,
    //       so sender-side dedup + receiver-side response cache
    //       actually work across the retry chain (defeated when
    //       sendReliable falls back to randomUUID() per attempt).
    //   #5: every retry attempt sends the SAME envelope bytes,
    //       so "what the receiver cached" matches "what the
    //       sender sent" — no risk of a cached denial replaying
    //       past a fresh-envelope retry. The signature freshness
    //       TTL (SYNC_AUTH_MAX_AGE_MS = 90s) comfortably exceeds
    //       withRetry's max budget (~7s with default backoff).
    //   #7: building the envelope can fail transiently
    //       (`isPrivateContextGraph`, `getIdentityId()`, signing).
    //       Pre-fix, `requestFactory` ran inside `withRetry`, so
    //       transient build errors were retried implicitly. Now
    //       that the build is hoisted out for #5, we wrap it in
    //       its own withRetry to preserve that resilience.
    const pageMessageId = computeSyncPageMessageId({
      remotePeerId,
      contextGraphId,
      includeSharedMemory,
      phase,
      offset: curOffset,
      snapshotRef,
      runNonce,
    });
    const buildPayload = () =>
      withRetry(
        () => buildSyncRequest(contextGraphId, curOffset, syncPageSize, includeSharedMemory, remotePeerId, phase, snapshotRef),
        {
          maxAttempts: syncPageRetryAttempts,
          baseDelayMs: 1000,
          onRetry: (attempt, delay, err) => {
            logWarn(
              ctx,
              `Sync envelope build retry ${attempt}/${syncPageRetryAttempts} for offset ${curOffset} (delay ${Math.round(delay)}ms): ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        },
      );
    const pagePayload = await buildPayload();
    let responseBytes = await sendSyncRequest({
      remotePeerId,
      timeoutMs,
      retryAttempts: syncPageRetryAttempts,
      contextGraphId,
      offset,
      protocolId: protocolSync,
      payload: pagePayload,
      send,
      messageId: pageMessageId,
      onRetry: (attempt, delay, err) => {
        logWarn(ctx, `Sync page retry ${attempt}/${syncPageRetryAttempts} for offset ${offset} (delay ${Math.round(delay)}ms): ${err instanceof Error ? err.message : String(err)}`);
      },
    });

    // rc.9 PR-E follow-up #3 + #6 (codex review on #569): handle the
    // substrate's RESPONSE_GONE sentinel HERE rather than one layer
    // down — recovery requires a freshly-built envelope (new
    // requestId/issuedAtMs/signature) so `authorizePrivateSyncRequest`
    // doesn't reject the re-issue as a replay (it caches seen
    // `requestId`s for `syncAuthMaxAgeMs`). Only page-fetch has
    // access to `buildSyncRequest`, so the recovery lives here.
    //
    // The sentinel fires when a duplicate-receive lands on a
    // response that was too large for the substrate's 256 KiB inline
    // cache (common for sync N-Quads pages). Re-issue with:
    //   - fresh envelope bytes (different requestId → not a replay
    //     on the responder's auth gate)
    //   - fresh substrate messageId (different from the one whose
    //     mark-only cache entry just told us RESPONSE_GONE)
    // Cap at one RESPONSE_GONE retry per page — if both attempts
    // get RESPONSE_GONE, surface a hard error rather than loop.
    if (new TextDecoder().decode(responseBytes) === RESPONSE_GONE_MARKER) {
      logWarn(
        ctx,
        `RESPONSE_GONE for offset ${curOffset} (cgId="${contextGraphId}" scope=${includeSharedMemory ? 'swm' : 'durable'} phase=${phase}); re-issuing with fresh envelope + messageId`,
      );
      const refreshedPayload = await buildPayload();
      const refreshedMessageId = `${pageMessageId}:gone-retry`;
      responseBytes = await sendSyncRequest({
        remotePeerId,
        timeoutMs,
        retryAttempts: syncPageRetryAttempts,
        contextGraphId,
        offset,
        protocolId: protocolSync,
        payload: refreshedPayload,
        send,
        messageId: refreshedMessageId,
        onRetry: (attempt, delay, err) => {
          logWarn(ctx, `Sync page retry ${attempt}/${syncPageRetryAttempts} for offset ${offset} after RESPONSE_GONE (delay ${Math.round(delay)}ms): ${err instanceof Error ? err.message : String(err)}`);
        },
      });
      if (new TextDecoder().decode(responseBytes) === RESPONSE_GONE_MARKER) {
        throw new Error(
          `Sync page for "${contextGraphId}" offset=${curOffset} phase=${phase} exhausted RESPONSE_GONE retries — responder cache repeatedly mark-only`,
        );
      }
    }
    const transportDurationMs = Date.now() - transportStartedAt;

    const decodeStartedAt = Date.now();
    const nquadsText = new TextDecoder().decode(responseBytes).trim();
    const decodeDurationMs = Date.now() - decodeStartedAt;
    bytesReceived += responseBytes.byteLength;
    if (
      nquadsText === syncDeniedResponse ||
      (extraDeniedResponses && extraDeniedResponses.includes(nquadsText))
    ) {
      const error = new Error(`Sync denied by ${remotePeerId} for "${contextGraphId}" (${phase})`);
      (error as Error & { syncDenied?: boolean }).syncDenied = true;
      throw error;
    }
    if (!nquadsText) break;

    const parseStartedAt = Date.now();
    const parsed = await parseAndFilter(nquadsText, graphUri, contextGraphId);
    const parseDurationMs = Date.now() - parseStartedAt;
    if (parsed.totalQuads === 0) break;

    const stepDurationMs = transportDurationMs + decodeDurationMs + parseDurationMs;
    if (stepDurationMs > 100) {
      logDebug(
        ctx,
        `Sync page timing for "${contextGraphId}" offset=${curOffset} phase=${phase}: transport=${transportDurationMs}ms decode=${decodeDurationMs}ms parse=${parseDurationMs}ms`,
      );
    }

    allQuads.push(...parsed.quads);
    offset += parsed.totalQuads;

    if (debugSyncProgress) {
      logInfo(
        ctx,
        `Sync progress for "${contextGraphId}" ${includeSharedMemory ? 'shared-memory' : 'durable'} ${phase}: transferred=${allQuads.length} bytes=${bytesReceived} offset=${offset}`,
      );
    }
    if (parsed.totalQuads < syncPageSize) break;
  }

  if (timedOut) {
    const scope = includeSharedMemory ? 'shared-memory' : 'durable';
    logWarn(
      ctx,
      `Sync timeout for ${scope} ${phase} phase of "${contextGraphId}" (${allQuads.length} triples received so far for ${graphUri})`,
    );
  }

  return {
    quads: allQuads,
    bytesReceived,
    resumedFromOffset,
    nextOffset: offset,
    checkpointKey,
    completed: !timedOut,
  };
}
