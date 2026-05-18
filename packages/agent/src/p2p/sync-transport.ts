import { withRetry } from '@origintrail-official/dkg-core';

interface SyncSendParams {
  remotePeerId: string;
  timeoutMs: number;
  retryAttempts: number;
  contextGraphId: string;
  offset: number;
  /**
   * Pre-built envelope bytes for this page request.
   *
   * rc.9 PR-E follow-up #4 (codex review on #569): we now build the
   * envelope ONCE per page, outside this retry loop, and pass the
   * bytes in. Pre-rc.9 follow-up #4 the request was rebuilt on every
   * attempt — for private CGs that meant a fresh
   * `requestId`/`issuedAtMs` per attempt while
   * {@link Messenger.register}'s dedup keys only on `(peer, protocol,
   * messageId)` BEFORE the auth handler runs. If attempt 1 produced a
   * cached denial (e.g. signature aged out at the receiver, transient
   * authorization failure), subsequent attempts would replay that
   * denial without re-validating the new envelope — even though the
   * new envelope might be acceptable. Building the envelope once
   * keeps "what the sender sent" identical to "what the receiver
   * cached", so dedup is correct by construction. Sync auth has a
   * 90s freshness TTL (`SYNC_AUTH_MAX_AGE_MS`); withRetry's max
   * total budget is ~7s, so this is safely under the TTL.
   */
  payload: Uint8Array;
  /**
   * rc.9 PR-E follow-up #1 (codex review on #569): `send` receives a
   * stable `messageId` so that on substrate transports it can pass it
   * through to `messenger.sendReliable` — keeping the SAME id across
   * every {@link withRetry} attempt. Without that, each retry would
   * mint a fresh randomUUID() and defeat both sender-side dedup and
   * receiver-side response cache, leaving multiple queued outbox
   * entries for the same logical page request.
   */
  send: (
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    timeoutMs: number,
    messageId: string,
  ) => Promise<Uint8Array>;
  /**
   * Stable idempotency key for this logical page request. Same value
   * is passed to {@link send} on every retry. Construction left to
   * the caller (see {@link computeSyncPageMessageId} in page-fetch).
   */
  messageId: string;
  protocolId: string;
  onRetry: (attempt: number, delay: number, err: unknown) => void;
}

export async function sendSyncRequest(params: SyncSendParams): Promise<Uint8Array> {
  return withRetry(
    async () => params.send(params.remotePeerId, params.protocolId, params.payload, params.timeoutMs, params.messageId),
    {
      maxAttempts: params.retryAttempts,
      baseDelayMs: 1000,
      onRetry: params.onRetry,
    },
  );
}
