import type { Stream } from '@libp2p/interface';
import type { StreamHandler as DKGStreamHandler } from './types.js';
import type { DKGNode } from './node.js';
import type { PeerResolver } from './network/peer-resolver.js';

/** Default max bytes readAll will buffer before aborting (10 MB). */
export const DEFAULT_MAX_READ_BYTES = 10 * 1024 * 1024;

/** Default timeout for send() (ms). Sync over relay may need longer; callers can pass a higher value. */
export const DEFAULT_SEND_TIMEOUT_MS = 20_000;

/**
 * Returns true if the error is recoverable (retry with backoff).
 * Exported for tests.
 */
export function isRecoverableSendError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('closed') ||
    msg.includes('reset') ||
    msg.includes('stream returned in closed state') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('epipe') ||
    msg.includes('aborted') ||
    msg.includes('no valid addresses') ||
    msg.includes('protocol selection failed') ||
    msg.includes('could not negotiate')
  );
}

export interface ProtocolRouterOptions {
  maxReadBytes?: number;
  /**
   * RFC 07 §3.2 — when present, `send()` consults the resolver before
   * dialing so the libp2p peerStore is primed with whatever multiaddrs
   * the resolution order finds (live-conn → DHT → RFC 04 registry →
   * agents-CG). Required for any router that handles agent P2P
   * traffic in production; optional only for local/in-process tests
   * that exclusively talk over already-warmed connections.
   *
   * Codex review feedback on PR #497 round 5: keeping this optional
   * makes the cold-peer priming guarantee implicit. Two mitigations
   * are in place:
   *   1. CI grep gate (`scripts/audit-dial-protocol.mjs`, PR-4 of the
   *      RFC 07 rollout) bans raw `dialProtocol(peerId)` calls
   *      outside an allowlist, so any new outbound path is forced
   *      through `ProtocolRouter`.
   *   2. `send()` emits a one-time `console.warn` the first time it
   *      runs without a `peerResolver` configured (see implementation
   *      below), so a misconfiguration is loud at the first cold dial
   *      rather than silently regressing PR-448's class of failures.
   * Together these turn the "any future caller that omits the
   * resolver silently skips priming" risk into a build-time + first-
   * call-time surface.
   */
  peerResolver?: PeerResolver;
}

export class ProtocolRouter {
  private readonly node: DKGNode;
  private readonly peerResolver?: PeerResolver;
  private handlers = new Map<string, DKGStreamHandler>();
  /**
   * One-shot guard: we warn the first time `send()` runs without a
   * `peerResolver` so a misconfigured outbound router is loud, but
   * we don't spam the logs on every subsequent call. Codex PR #497
   * round 5 — see `ProtocolRouterOptions.peerResolver`.
   */
  private warnedMissingResolver = false;
  readonly maxReadBytes: number;

  constructor(node: DKGNode, options?: ProtocolRouterOptions) {
    this.node = node;
    this.peerResolver = options?.peerResolver;
    this.maxReadBytes = options?.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  }

  register(protocolId: string, handler: DKGStreamHandler): void {
    this.handlers.set(protocolId, handler);
    const libp2p = this.node.libp2p;

    const limit = this.maxReadBytes;
    libp2p.handle(protocolId, async (stream: Stream, connection) => {
      try {
        const requestData = await readAll(stream, limit);
        const peerId = {
          toString: () => connection.remotePeer.toString(),
          toBytes: () => connection.remotePeer.toMultihash().bytes,
        };
        const responseData = await handler(requestData, peerId);
        stream.send(responseData);
        await stream.close();
      } catch (err) {
        console.error(`[ProtocolRouter] handler error on ${protocolId} from ${connection.remotePeer.toString().slice(-8)}:`, err instanceof Error ? err.message : err);
        try {
          stream.abort(new Error('handler error'));
        } catch {
          // stream already closed
        }
      }
    }, { runOnLimitedConnection: true });
  }

  unregister(protocolId: string): void {
    this.handlers.delete(protocolId);
    this.node.libp2p.unhandle(protocolId);
  }

  async send(
    peerIdStr: string,
    protocolId: string,
    data: Uint8Array,
    timeoutMs = DEFAULT_SEND_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    const libp2p = this.node.libp2p;
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const peerId = peerIdFromString(peerIdStr);
    const signal = AbortSignal.timeout(timeoutMs);
    const startedAt = Date.now();

    if (!this.peerResolver && !this.warnedMissingResolver) {
      // Codex PR #497 round 5: structural enforcement (CI grep gate)
      // already prevents raw `dialProtocol(peerId)` calls outside an
      // allowlist, but a router constructed without a resolver still
      // silently skips priming. Surface it loudly the first time so a
      // misconfigured outbound path is caught at first cold dial
      // rather than reintroducing PR-448's relay-route failures.
      this.warnedMissingResolver = true;
      console.warn(
        '[ProtocolRouter] send() called without a peerResolver configured. ' +
          'Cold-peer dials will fall back to libp2p\'s identify-cached addresses ' +
          'and may fail to find relay routes (see RFC 07 §3.2 / PR #448). ' +
          'Pass `{ peerResolver }` to the ProtocolRouter constructor for any ' +
          'router that handles agent P2P traffic.',
      );
    }

    // libp2p internally upgrades relay connections to direct during
    // dialProtocol/newStream (peerStore.merge triggers the connection manager
    // to dial the peer directly, closing the relay and any in-flight streams).
    // We retry up to 3 times with back-off so the direct connection can
    // stabilise before the next attempt.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // RFC 07 §3.2: re-prime the libp2p peerStore on EVERY attempt.
        //
        // Was originally a single pre-loop call (PR #497) but that left
        // a real cold-dial gap surfaced during the two-laptop debug
        // session that produced PR #517 + the MessageOutbox PR: if the
        // first resolver call landed during a transient routing-table
        // miss (peer's K-bucket entry expired, no live gossip source,
        // DHT walk happened to time out), all 3 dialProtocol attempts
        // hit the same empty peerStore in the next ~1.5s and the loop
        // gave up with `'no valid addresses for peer'` before any DHT
        // advertisement / `connection:open` event from the recipient
        // could populate addresses for a later attempt.
        //
        // Re-running per-attempt is cheap on the warm path (the
        // resolver's step 1 is a sub-millisecond live-connection check
        // that short-circuits when we already have the peer connected
        // or its addresses cached in the peerStore) and only pays the
        // DHT-walk / registry-lookup cost on the cold path — which is
        // exactly the case we want to keep paying for, because that's
        // where address staleness actually hurts. The resolver itself
        // never throws (returns empty array on miss); the dial below
        // surfaces a real transport error if the peer is genuinely
        // unreachable.
        //
        // Codex review feedback on PR #497: pass the same AbortSignal +
        // remaining time budget to the resolver so a caller's
        // `timeoutMs` bounds the entire send (resolver + dial + read).
        // First try the existing-connection fast path: if we already
        // have at least one open connection to this peer (of ANY
        // direction, direct OR circuit-relay-limited), open the new
        // stream on that connection directly via `newStream` instead
        // of going through `dialProtocol`. This sidesteps the entire
        // address-resolution + peerStore lookup path that returns
        // "no valid addresses for peer" when libp2p's peerStore is
        // empty or stale for the peer — the "Window D" failure class
        // identified in the May 2026 Miles↔Lex 6h soak postmortem,
        // where 31 inbound circuit `connection:open` events from peer
        // P over 4 minutes failed to heal any of 20 opportunistic
        // outbound flushes because each one went through dialProtocol
        // and lost the peerStore race.
        //
        // Crucially: when peerStore is empty for P (the Window D
        // shape), the connection-manager-auto-dial side effect of
        // `peerStore.merge` documented at
        // docs/archive/UPSTREAM_ISSUE_DRAFT.md does NOT fire — there
        // are no direct addresses to upgrade to. So this fast path
        // does not introduce the mid-stream-negotiation race the doc
        // warns about; it benefits exactly the case where the doc's
        // race cannot apply.
        //
        // Failure here (connection died between `getConnections` and
        // `newStream`, peer dropped protocol support, etc.) falls
        // through to the dialProtocol path below WITHIN THE SAME
        // ATTEMPT, so we don't waste a retry slot on the fast-path
        // miss.
        const fastStream = await tryReuseExistingConnection(
          () => libp2p.getConnections(peerId) as ReadonlyArray<ReusableConnection>,
          protocolId,
          signal,
        );

        if (this.peerResolver && !fastStream) {
          const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
          await this.peerResolver
            .resolve(peerIdStr, { signal, perStepTimeoutMs: remaining })
            .catch(() => undefined);
        }

        const dialStartedAt = Date.now();
        const stream =
          fastStream ??
          (await libp2p.dialProtocol(peerId, protocolId, {
            runOnLimitedConnection: true,
            signal,
          }));
        const dialDurationMs = Date.now() - dialStartedAt;

        if (stream.writeStatus === 'closed' || stream.writeStatus === 'closing') {
          stream.abort(new Error('stream closed before send'));
          throw new Error('stream returned in closed state');
        }

        const sendStartedAt = Date.now();
        stream.send(data);
        await stream.close({ signal });
        const sendDurationMs = Date.now() - sendStartedAt;

        const readStartedAt = Date.now();
        const response = await readAll(stream, this.maxReadBytes);
        const readDurationMs = Date.now() - readStartedAt;
        const totalDurationMs = Date.now() - startedAt;
        if (totalDurationMs > 100) {
          console.warn(`[ProtocolRouter] send ${protocolId} to ${peerIdStr}: dial=${dialDurationMs}ms send=${sendDurationMs}ms read=${readDurationMs}ms total=${totalDurationMs}ms`);
        }
        return response;
      } catch (err: unknown) {
        lastErr = err;
        if (!isRecoverableSendError(err) || attempt >= 2) throw err;
        const backoff = (attempt + 1) * 500;
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }
}

/**
 * "Window D" workaround — attempts to open `protocolId` on an EXISTING
 * open connection to `peerId` before paying the address-resolution +
 * `dialProtocol` cost. Returns the stream on success, `null` on any
 * failure (no live connection, `newStream` rejects, stream comes back
 * dead) so the caller can fall through to the dialProtocol path
 * within the same retry attempt.
 *
 * Why a free function and not a method on `ProtocolRouter`:
 *  - Stateless: every input comes from the call site.
 *  - Easier to unit-test in isolation (no `ProtocolRouter` mock setup).
 *  - Keeps the dial-reuse logic adjacent to the hot path in `send()`
 *    so a reader scrolling the file sees the bypass and the fallback
 *    in the same screen.
 *
 * Connection selection: we DELIBERATELY accept the first open
 * connection regardless of direction or transport (`direct` /
 * `relayed` / `limited`). Reasoning:
 *  - Direct connections are always the best choice.
 *  - Limited (circuit-relay-v2) connections are explicitly allowed
 *    via `runOnLimitedConnection: true` here — same flag the
 *    existing `dialProtocol` call uses below — so a limited
 *    connection is a valid stream-carrier for our protocols.
 *  - Filtering "best-first" would add bookkeeping for ~no benefit:
 *    libp2p's `getConnections(peerId)` already orders the returned
 *    list with the most-recently-opened connections first, which
 *    in practice IS the freshest path.
 */
interface ReusableConnection {
  status?: string;
  newStream: (
    protocols: string,
    options?: { runOnLimitedConnection?: boolean; signal?: AbortSignal },
  ) => Promise<Stream>;
}

// Minimal shape we depend on from libp2p — the real `Libp2p` type
// is much richer but using a structural subset lets the unit test
// pass a fake without re-exporting full libp2p internals. Connection
// retrieval is wrapped behind a thunk so the structural type doesn't
// have to mirror libp2p's `getConnections(PeerId)` signature exactly
// (PeerId itself has dozens of methods we don't need).
export async function tryReuseExistingConnection(
  getConnections: () => ReadonlyArray<ReusableConnection>,
  protocolId: string,
  signal: AbortSignal,
): Promise<Stream | null> {
  let candidates: ReadonlyArray<ReusableConnection> = [];
  try {
    candidates = getConnections();
  } catch {
    return null;
  }

  for (const conn of candidates) {
    if (conn.status && conn.status !== 'open') continue;
    try {
      const s = await conn.newStream(protocolId, {
        runOnLimitedConnection: true,
        signal,
      });
      if (s.writeStatus === 'closed' || s.writeStatus === 'closing') {
        // The known mid-stream-negotiation race
        // (docs/archive/UPSTREAM_ISSUE_DRAFT.md): newStream came
        // back already-dead because peerStore.merge triggered the
        // connection manager to prune our connection. Abort the
        // dead stream and fall through to dialProtocol — the
        // outer retry loop will then re-resolve and try again.
        s.abort(new Error('reused stream returned in closed state'));
        return null;
      }
      return s;
    } catch {
      // Try the next candidate connection (if any), then fall
      // through to dialProtocol on overall miss. Swallowing here is
      // safe — every error class that's actually fatal to the send
      // (transport down, peer gone) will surface again on
      // dialProtocol, which has the full address-resolution +
      // backoff path to handle it correctly.
      continue;
    }
  }
  return null;
}

async function readAll(
  stream: Stream | AsyncIterable<Uint8Array>,
  maxBytes = DEFAULT_MAX_READ_BYTES,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.subarray());
    total += buf.length;
    if (total > maxBytes) {
      if ('abort' in stream && typeof (stream as Stream).abort === 'function') {
        (stream as Stream).abort(new Error('read limit exceeded'));
      }
      throw new Error(`Read limit exceeded (${maxBytes} bytes)`);
    }
    chunks.push(buf);
  }
  return concat(chunks);
}

function concat(arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 0) return new Uint8Array(0);
  if (arrays.length === 1) return arrays[0];
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}
