import { describe, it, expect } from 'vitest';
import { isRecoverableSendError, DEFAULT_SEND_TIMEOUT_MS, ProtocolRouter } from '../src/protocol-router.js';
import type { DKGNode } from '../src/node.js';
import type { PeerResolver } from '../src/network/peer-resolver.js';

describe('ProtocolRouter', () => {
  describe('isRecoverableSendError', () => {
    it('returns true for protocol selection / negotiation errors (relay sync)', () => {
      expect(isRecoverableSendError(new Error('Protocol selection failed - could not negotiate /dkg/sync/1.0.0'))).toBe(true);
      expect(isRecoverableSendError(new Error('could not negotiate /dkg/sync/1.0.0'))).toBe(true);
    });

    it('returns true for connection/stream errors', () => {
      expect(isRecoverableSendError(new Error('stream returned in closed state'))).toBe(true);
      expect(isRecoverableSendError(new Error('ECONNRESET'))).toBe(true);
      expect(isRecoverableSendError(new Error('ETIMEDOUT'))).toBe(true);
      expect(isRecoverableSendError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isRecoverableSendError(new Error('EPIPE'))).toBe(true);
      expect(isRecoverableSendError(new Error('The operation was aborted'))).toBe(true);
      expect(isRecoverableSendError(new Error('no valid addresses'))).toBe(true);
    });

    it('returns false for non-recoverable errors', () => {
      expect(isRecoverableSendError(new Error('Read limit exceeded'))).toBe(false);
      expect(isRecoverableSendError(new Error('handler error'))).toBe(false);
      expect(isRecoverableSendError(new Error('Invalid payload'))).toBe(false);
    });

    it('handles non-Error values', () => {
      expect(isRecoverableSendError('protocol selection failed')).toBe(true);
      expect(isRecoverableSendError(null)).toBe(false);
    });
  });

  describe('DEFAULT_SEND_TIMEOUT_MS', () => {
    it('is 20 seconds for relay/sync tolerance', () => {
      expect(DEFAULT_SEND_TIMEOUT_MS).toBe(20_000);
    });
  });

  // Per-attempt resolver re-run was added in the MessageOutbox PR after
  // the two-laptop debug session that produced PR #517. Original shape
  // (PR #497) called `peerResolver.resolve()` once before the dial loop;
  // a transient routing-table miss on that single call left all 3
  // dialProtocol attempts hitting an empty peerStore in the next ~1.5s,
  // producing a hard `'no valid addresses for peer'` failure that the
  // recoverable-error retry budget couldn't actually recover from.
  describe('send() resolver re-priming', () => {
    // Minimal valid Ed25519 peerId from the libp2p test fixtures.
    // `peerIdFromString` validates this is a parseable peerId; the
    // value never reaches the wire because dialProtocol is stubbed.
    const FAKE_PEER_ID = '12D3KooWBzj7Hg2cKCdsKL6QcjC5UbLztKTvzCZQHaT4P4ZyJEAA';

    function makeStubStream(response: Uint8Array) {
      const closed = false;
      let returned = false;
      return {
        writeStatus: 'open' as const,
        send: () => undefined,
        close: async () => undefined,
        abort: () => undefined,
        async *[Symbol.asyncIterator]() {
          if (!returned) {
            returned = true;
            yield response;
          }
        },
      };
    }

    function makeRouter(opts: {
      dialBehavior: () => Promise<unknown>;
      onResolve: () => void;
    }): ProtocolRouter {
      const node = {
        libp2p: {
          dialProtocol: opts.dialBehavior,
          handle: () => undefined,
          unhandle: () => undefined,
        },
      } as unknown as DKGNode;
      const peerResolver = {
        resolve: async () => {
          opts.onResolve();
          return [];
        },
      } as unknown as PeerResolver;
      return new ProtocolRouter(node, { peerResolver });
    }

    it('re-runs peerResolver.resolve() on every retry attempt (was once-pre-loop)', async () => {
      let resolveCalls = 0;
      let dialCalls = 0;
      const router = makeRouter({
        onResolve: () => { resolveCalls += 1; },
        dialBehavior: async () => {
          dialCalls += 1;
          throw new Error('The dial request has no valid addresses for peer');
        },
      });

      await expect(
        router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1, 2, 3])),
      ).rejects.toThrow(/no valid addresses/);

      // Primary regression assertion: 3 dial attempts → 3 resolver
      // calls. Pre-fix this would have been 1 resolver call + 3 dial
      // attempts, all hitting the same empty peerStore.
      expect(dialCalls).toBe(3);
      expect(resolveCalls).toBe(3);
    });

    it('stops retrying once a resolver-re-prime followed by dial succeeds', async () => {
      let resolveCalls = 0;
      let dialCalls = 0;
      const router = makeRouter({
        onResolve: () => { resolveCalls += 1; },
        dialBehavior: async () => {
          dialCalls += 1;
          if (dialCalls < 3) {
            throw new Error('no valid addresses for peer');
          }
          return makeStubStream(new Uint8Array([0xAA, 0xBB])) as any;
        },
      });

      const result = await router.send(
        FAKE_PEER_ID,
        '/dkg/test/1.0.0',
        new Uint8Array([1]),
      );

      expect(dialCalls).toBe(3);
      // Resolver re-primes before each of the 3 dial attempts —
      // including the third one that succeeds.
      expect(resolveCalls).toBe(3);
      expect(result).toEqual(new Uint8Array([0xAA, 0xBB]));
    });

    it('stops at attempt 1 for non-recoverable errors and only re-primes once', async () => {
      let resolveCalls = 0;
      let dialCalls = 0;
      const router = makeRouter({
        onResolve: () => { resolveCalls += 1; },
        dialBehavior: async () => {
          dialCalls += 1;
          throw new Error('Read limit exceeded');
        },
      });

      await expect(
        router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1])),
      ).rejects.toThrow(/Read limit exceeded/);

      // Non-recoverable errors should NOT trigger the retry loop's
      // backoff + re-prime path. Dial fires once, resolver primes once.
      expect(dialCalls).toBe(1);
      expect(resolveCalls).toBe(1);
    });
  });

  // PR 5 — "Window D" fast path. Before dialProtocol, send() checks
  // `libp2p.getConnections(peerId)` for an existing open connection
  // and opens the stream on it directly via `connection.newStream`,
  // skipping the address-resolution + dialProtocol path entirely.
  // The May 2026 Miles↔Lex 6h soak postmortem traced multi-minute
  // outbound failures to the case where an inbound circuit was open
  // but peerStore was empty for the peer; dialProtocol returned
  // "no valid addresses for peer" each time. This fast path
  // succeeds in that scenario without ever touching peerStore.
  describe('send() existing-connection fast path (PR 5 — Window D)', () => {
    const FAKE_PEER_ID = '12D3KooWBzj7Hg2cKCdsKL6QcjC5UbLztKTvzCZQHaT4P4ZyJEAA';

    function makeStubStream(response: Uint8Array) {
      let returned = false;
      return {
        writeStatus: 'open' as const,
        send: () => undefined,
        close: async () => undefined,
        abort: () => undefined,
        async *[Symbol.asyncIterator]() {
          if (!returned) {
            returned = true;
            yield response;
          }
        },
      };
    }

    function makeRouterWithFastPath(opts: {
      connections: Array<{
        status?: string;
        newStream: (
          protocols: string,
          options?: { runOnLimitedConnection?: boolean; signal?: AbortSignal },
        ) => Promise<ReturnType<typeof makeStubStream>>;
      }>;
      dialBehavior: () => Promise<unknown>;
      onResolve?: () => void;
      onGetConnections?: () => void;
    }): ProtocolRouter {
      const node = {
        libp2p: {
          getConnections: () => {
            opts.onGetConnections?.();
            return opts.connections;
          },
          dialProtocol: opts.dialBehavior,
          handle: () => undefined,
          unhandle: () => undefined,
        },
      } as unknown as DKGNode;
      const peerResolver = {
        resolve: async () => {
          opts.onResolve?.();
          return [];
        },
      } as unknown as PeerResolver;
      return new ProtocolRouter(node, { peerResolver });
    }

    it('reuses an existing open connection and skips dialProtocol + resolver entirely', async () => {
      let newStreamCalls = 0;
      let dialCalls = 0;
      let resolveCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [
          {
            status: 'open',
            newStream: async (protocols, options) => {
              newStreamCalls += 1;
              // Must opt-in to limited connections so circuit-relay
              // (limited) connections are usable as stream-carriers.
              // Same flag the dialProtocol call uses below; the fast
              // path MUST mirror it or it would silently downgrade
              // relayed reachability vs the old path.
              expect(options?.runOnLimitedConnection).toBe(true);
              expect(protocols).toBe('/dkg/test/1.0.0');
              return makeStubStream(new Uint8Array([0xAA])) as any;
            },
          },
        ],
        dialBehavior: async () => {
          dialCalls += 1;
          throw new Error('dialProtocol must not be called when fast path hits');
        },
        onResolve: () => { resolveCalls += 1; },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0xAA]));
      expect(newStreamCalls).toBe(1);
      expect(dialCalls).toBe(0);
      // Resolver is bypassed on warm path — its only job (priming
      // peerStore for the dialer) is unnecessary when we don't dial.
      expect(resolveCalls).toBe(0);
    });

    it('falls through to dialProtocol when no connections exist (cold peer)', async () => {
      let dialCalls = 0;
      let resolveCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [],
        dialBehavior: async () => {
          dialCalls += 1;
          return makeStubStream(new Uint8Array([0xBB])) as any;
        },
        onResolve: () => { resolveCalls += 1; },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0xBB]));
      expect(dialCalls).toBe(1);
      expect(resolveCalls).toBe(1);
    });

    it('falls through to dialProtocol when newStream throws (race / dead conn)', async () => {
      let newStreamCalls = 0;
      let dialCalls = 0;
      let resolveCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [
          {
            status: 'open',
            newStream: async () => {
              newStreamCalls += 1;
              throw new Error('connection went away mid-newStream');
            },
          },
        ],
        dialBehavior: async () => {
          dialCalls += 1;
          return makeStubStream(new Uint8Array([0xCC])) as any;
        },
        onResolve: () => { resolveCalls += 1; },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0xCC]));
      expect(newStreamCalls).toBe(1);
      // Fallback within the SAME attempt — we don't waste a retry
      // slot on a fast-path miss. Resolver runs once for the
      // dialProtocol fallback.
      expect(dialCalls).toBe(1);
      expect(resolveCalls).toBe(1);
    });

    it('aborts dead reused streams (writeStatus=closed) and falls back to dialProtocol', async () => {
      let abortCalls = 0;
      let dialCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [
          {
            status: 'open',
            newStream: async () => ({
              // The known mid-stream-negotiation race documented at
              // docs/archive/UPSTREAM_ISSUE_DRAFT.md — `newStream`
              // returns a stream that's already in a closed state
              // because the CM tore down the connection between
              // negotiation and return. We must NOT send on it.
              writeStatus: 'closed' as const,
              send: () => undefined,
              close: async () => undefined,
              abort: () => { abortCalls += 1; },
              async *[Symbol.asyncIterator]() {
                /* never yields */
              },
            }),
          },
        ],
        dialBehavior: async () => {
          dialCalls += 1;
          return makeStubStream(new Uint8Array([0xDD])) as any;
        },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0xDD]));
      // Dead reused stream MUST be aborted so the underlying yamux
      // muxer cleans it up — otherwise leak.
      expect(abortCalls).toBe(1);
      expect(dialCalls).toBe(1);
    });

    it('skips connections whose status is not "open"', async () => {
      let openCalls = 0;
      let closedCalls = 0;
      let dialCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [
          {
            status: 'closing',
            newStream: async () => {
              closedCalls += 1;
              return makeStubStream(new Uint8Array([0x00])) as any;
            },
          },
          {
            status: 'open',
            newStream: async () => {
              openCalls += 1;
              return makeStubStream(new Uint8Array([0xEE])) as any;
            },
          },
        ],
        dialBehavior: async () => {
          dialCalls += 1;
          throw new Error('should not dial — open conn was second in list');
        },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0xEE]));
      // Closing connections are not viable carriers — skip without
      // calling newStream on them (would either throw or hand back
      // a dead stream that we'd then have to abort).
      expect(closedCalls).toBe(0);
      expect(openCalls).toBe(1);
      expect(dialCalls).toBe(0);
    });

    it('treats a getConnections() throw as a fast-path miss (defensive)', async () => {
      let dialCalls = 0;
      const router = makeRouterWithFastPath({
        connections: [],
        dialBehavior: async () => {
          dialCalls += 1;
          return makeStubStream(new Uint8Array([0xFF])) as any;
        },
        onGetConnections: () => {
          throw new Error('libp2p internal state mismatch');
        },
      });

      const out = await router.send(FAKE_PEER_ID, '/dkg/test/1.0.0', new Uint8Array([1]));
      expect(out).toEqual(new Uint8Array([0xFF]));
      // A throwing getConnections must NOT propagate — the fast
      // path silently misses and we go through dialProtocol as
      // if no connection existed. Anything else risks turning a
      // diagnostic-only assist into a real availability regression.
      expect(dialCalls).toBe(1);
    });
  });
});
