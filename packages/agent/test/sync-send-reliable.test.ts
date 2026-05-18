import { describe, it, expect, vi } from 'vitest';
import { sendSyncReliable } from '../src/p2p/sync-send-reliable.js';
import { RESPONSE_GONE_MARKER } from '@origintrail-official/dkg-core';
import type { Messenger } from '../src/p2p/messenger.js';

/**
 * Regression tests for the third codex review on #569.
 *
 * Bug: after moving sync onto `messenger.sendReliable`, the substrate's
 * `RESPONSE_GONE_MARKER` sentinel — returned when a duplicate-receive
 * lands on a response that was too large (>256 KiB) to inline-cache —
 * was being handed up to `fetchSyncPages` as if it were N-Quads bytes.
 * The page-fetch loop would decode it to the literal string
 * `"RESPONSE_GONE"`, parse it as N-Quads (yielding 0 quads), trip the
 * empty-page terminator, and silently drop the rest of the sync.
 *
 * The fix wraps `messenger.sendReliable` in `sendSyncReliable`, which
 * mirrors the pattern already established for `/query-remote`:
 *   - first attempt uses the caller-supplied stable messageId so the
 *     common-case dedup keeps working
 *   - on `RESPONSE_GONE`, re-issue once with a fresh messageId so the
 *     responder re-runs the SPARQL query from scratch (sync queries
 *     are app-layer idempotent)
 *   - cap at 2 attempts so a peer that always blows the cache
 *     surfaces as a hard error
 *
 * Tests stub `Messenger.sendReliable` directly so the helper is
 * exercised end-to-end without standing up a full agent / libp2p
 * stack.
 */

const PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const PROTOCOL_ID = '/dkg/10.0.1/sync';
const STABLE_MSG_ID = 'sync:peer:cg:durable:data:0:-';
const TIMEOUT_MS = 5_000;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

interface SendReliableCall {
  peerId: string;
  protocolId: string;
  payload: Uint8Array;
  opts?: { timeoutMs?: number; messageId?: string };
}

function makeMessenger(
  handler: (
    call: SendReliableCall,
    attemptIndex: number,
  ) => Awaited<ReturnType<Messenger['sendReliable']>>,
): { messenger: Pick<Messenger, 'sendReliable'>; calls: SendReliableCall[] } {
  const calls: SendReliableCall[] = [];
  const messenger = {
    sendReliable: vi.fn(async (peerId: string, protocolId: string, payload: Uint8Array, opts?: { timeoutMs?: number; messageId?: string }) => {
      const call: SendReliableCall = { peerId, protocolId, payload, opts };
      calls.push(call);
      return handler(call, calls.length - 1);
    }) as Pick<Messenger, 'sendReliable'>['sendReliable'],
  };
  return { messenger, calls };
}

describe('sendSyncReliable', () => {
  it('returns response bytes on first-attempt success and passes the stable messageId', async () => {
    const expected = bytes('<s> <p> <o> <g> .\n');
    const { messenger, calls } = makeMessenger(() => ({
      delivered: true,
      response: expected,
      attempts: 1,
      messageId: STABLE_MSG_ID,
    }));

    const out = await sendSyncReliable(messenger, PEER_ID, PROTOCOL_ID, bytes('req'), TIMEOUT_MS, STABLE_MSG_ID);

    expect(out).toBe(expected);
    expect(calls.length).toBe(1);
    expect(calls[0].peerId).toBe(PEER_ID);
    expect(calls[0].protocolId).toBe(PROTOCOL_ID);
    expect(calls[0].opts?.timeoutMs).toBe(TIMEOUT_MS);
    expect(calls[0].opts?.messageId).toBe(STABLE_MSG_ID);
  });

  it('re-issues with a FRESH messageId on RESPONSE_GONE and returns the second response', async () => {
    const expected = bytes('<s2> <p2> <o2> <g> .\n');
    const { messenger, calls } = makeMessenger((_call, attemptIndex) => {
      if (attemptIndex === 0) {
        return {
          delivered: true,
          response: bytes(RESPONSE_GONE_MARKER),
          attempts: 1,
          messageId: STABLE_MSG_ID,
        };
      }
      return {
        delivered: true,
        response: expected,
        attempts: 1,
        messageId: 'fresh-uuid-from-messenger',
      };
    });

    const out = await sendSyncReliable(messenger, PEER_ID, PROTOCOL_ID, bytes('req'), TIMEOUT_MS, STABLE_MSG_ID);

    expect(out).toBe(expected);
    expect(calls.length).toBe(2);

    // Attempt 1: stable id passed through.
    expect(calls[0].opts?.messageId).toBe(STABLE_MSG_ID);

    // Attempt 2: messageId option OMITTED so the Messenger mints a
    // fresh UUID v4 — this is the whole point of "fresh messageId",
    // and the way to prove it from the test side is to assert the
    // option literally isn't there (so the messenger's default kicks
    // in). Passing the stable id again would re-hit the same
    // duplicate-receive RESPONSE_GONE path and loop forever (until
    // MAX_ATTEMPTS); the explicit omission is what breaks the cycle.
    expect(calls[1].opts).toBeDefined();
    expect(calls[1].opts).not.toHaveProperty('messageId');
  });

  it('throws after 2 RESPONSE_GONE responses (does not loop forever)', async () => {
    const { messenger, calls } = makeMessenger(() => ({
      delivered: true,
      response: bytes(RESPONSE_GONE_MARKER),
      attempts: 1,
      messageId: STABLE_MSG_ID,
    }));

    await expect(
      sendSyncReliable(messenger, PEER_ID, PROTOCOL_ID, bytes('req'), TIMEOUT_MS, STABLE_MSG_ID),
    ).rejects.toThrow(/RESPONSE_GONE/);
    expect(calls.length).toBe(2);
  });

  it('throws when the messenger reports queued (not synchronously deliverable)', async () => {
    const { messenger } = makeMessenger(() => ({
      delivered: false,
      queued: true,
      attempts: 1,
      messageId: STABLE_MSG_ID,
      error: 'no path',
      nextAttemptAtMs: Date.now() + 1000,
    }));

    await expect(
      sendSyncReliable(messenger, PEER_ID, PROTOCOL_ID, bytes('req'), TIMEOUT_MS, STABLE_MSG_ID),
    ).rejects.toThrow(/queued \(not synchronously deliverable\)/);
  });

  it('throws when the messenger reports an in-flight collision', async () => {
    const { messenger } = makeMessenger(() => ({
      delivered: false,
      queued: false,
      inFlight: true,
      attempts: 0,
      messageId: STABLE_MSG_ID,
      error: 'send already in flight for this messageId',
    }));

    await expect(
      sendSyncReliable(messenger, PEER_ID, PROTOCOL_ID, bytes('req'), TIMEOUT_MS, STABLE_MSG_ID),
    ).rejects.toThrow(/failed.*send already in flight/);
  });

  it('does NOT treat a response that merely CONTAINS the marker as RESPONSE_GONE', async () => {
    // Edge case: a real N-Quads page that happens to embed the
    // string "RESPONSE_GONE" in a literal must NOT be misinterpreted
    // as the sentinel. The check is exact-equality on the full
    // response body, not substring.
    const responseWithMarkerSubstring = bytes(
      `<s> <p> "RESPONSE_GONE happened here" <g> .\n`,
    );
    const { messenger, calls } = makeMessenger(() => ({
      delivered: true,
      response: responseWithMarkerSubstring,
      attempts: 1,
      messageId: STABLE_MSG_ID,
    }));

    const out = await sendSyncReliable(messenger, PEER_ID, PROTOCOL_ID, bytes('req'), TIMEOUT_MS, STABLE_MSG_ID);

    expect(out).toBe(responseWithMarkerSubstring);
    expect(calls.length).toBe(1);
  });
});
