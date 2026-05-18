import { withRetry } from '@origintrail-official/dkg-core';

interface SyncSendParams {
  remotePeerId: string;
  timeoutMs: number;
  retryAttempts: number;
  contextGraphId: string;
  offset: number;
  requestFactory: () => Promise<Uint8Array>;
  /**
   * rc.9 PR-E follow-up (codex review on #569): `send` now receives a
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
    async () => {
      const requestBytes = await params.requestFactory();
      return params.send(params.remotePeerId, params.protocolId, requestBytes, params.timeoutMs, params.messageId);
    },
    {
      maxAttempts: params.retryAttempts,
      baseDelayMs: 1000,
      onRetry: params.onRetry,
    },
  );
}
