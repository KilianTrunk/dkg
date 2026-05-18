import type { OperationContext } from '@origintrail-official/dkg-core';
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
 * Stable, deterministic idempotency key for a single sync page request.
 *
 * Composed from the inputs that uniquely identify "which page from
 * which responder for which slice of state" — `(remotePeerId, cgId,
 * phase, offset, snapshotRef)`. This is unique per logical page from
 * this requester's point of view, which is what the messenger needs
 * to dedup sender-side retries and to serve the receiver's response
 * cache on the second arrival.
 *
 * Note: requester peerId is intentionally NOT in the key — the
 * messenger already namespaces idempotency by `(senderPeerId,
 * protocolId, messageId)` internally, so "our identity" is implicit.
 * Including it would only matter if a single messenger instance ran
 * with multiple identities, which we never do.
 *
 * Plain string (not hashed) — it's an idempotency key, not a secret;
 * exact-match lookups in the messenger's Maps so length is fine.
 *
 * rc.9 PR-E follow-up (codex review on #569).
 */
export function computeSyncPageMessageId(parts: {
  remotePeerId: string;
  contextGraphId: string;
  phase: SyncPhase;
  offset: number;
  snapshotRef?: string;
}): string {
  return `sync:${parts.remotePeerId}:${parts.contextGraphId}:${parts.phase}:${parts.offset}:${parts.snapshotRef ?? '-'}`;
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
    // Compute stable messageId ONCE per page, OUTSIDE the withRetry
    // wrapper inside sendSyncRequest, so every retry attempt for this
    // page reuses the same id. See `computeSyncPageMessageId` jsdoc
    // for rationale; without this, substrate-backed `send`
    // implementations would defeat dedup.
    const pageMessageId = computeSyncPageMessageId({
      remotePeerId,
      contextGraphId,
      phase,
      offset: curOffset,
      snapshotRef,
    });
    const responseBytes = await sendSyncRequest({
      remotePeerId,
      timeoutMs,
      retryAttempts: syncPageRetryAttempts,
      contextGraphId,
      offset,
      protocolId: protocolSync,
      requestFactory: () => buildSyncRequest(contextGraphId, curOffset, syncPageSize, includeSharedMemory, remotePeerId, phase, snapshotRef),
      send,
      messageId: pageMessageId,
      onRetry: (attempt, delay, err) => {
        logWarn(ctx, `Sync page retry ${attempt}/${syncPageRetryAttempts} for offset ${offset} (delay ${Math.round(delay)}ms): ${err instanceof Error ? err.message : String(err)}`);
      },
    });
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
