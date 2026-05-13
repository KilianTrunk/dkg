import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  dkgGossipMsgId,
  DkgGossipUnsignedMessageError,
} from '../src/network/gossip-msg-id.js';

/**
 * RFC 07 §5.4 — `dkgGossipMsgId` is the content-deterministic msgId
 * locked in for cross-backend gossip dedup. These tests pin the exact
 * encoding so any change is caught at code-review time.
 *
 * Codex review feedback on PR #501 made two semantic changes:
 *   1. length-framing each field to avoid ("ab","c")=("a","bc") collisions
 *   2. including sequenceNumber for signed messages so retries get
 *      distinct msgIds (otherwise the same peer republishing the same
 *      payload would be dropped as a dup by gossipsub itself).
 * Both are pinned by tests below.
 */
describe('dkgGossipMsgId (RFC 07 §5.4)', () => {
  const TOPIC = 'dkg/cg/topic-a/1.0.0';
  const PAYLOAD = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
  // Minimal PeerId stand-in: the function only reads `.toMultihash().bytes`.
  const FROM_BYTES = new Uint8Array([0xAA, 0xBB, 0xCC]);
  const fakePeerId = {
    toMultihash: () => ({ bytes: FROM_BYTES }),
  } as unknown as Parameters<typeof dkgGossipMsgId>[0] extends infer M
    ? M extends { from: infer P }
      ? P
      : never
    : never;

  function u32be(n: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, false);
    return b;
  }
  function u64be(n: bigint): Uint8Array {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, n, false);
    return b;
  }
  function expected(topic: string, data: Uint8Array, from: Uint8Array, seqno: bigint): Uint8Array {
    const topicBytes = new TextEncoder().encode(topic);
    const total = 4 + topicBytes.length + 4 + data.length + 4 + from.length + 8;
    const buf = new Uint8Array(total);
    let off = 0;
    buf.set(u32be(topicBytes.length), off); off += 4;
    buf.set(topicBytes, off);                off += topicBytes.length;
    buf.set(u32be(data.length), off);        off += 4;
    buf.set(data, off);                      off += data.length;
    buf.set(u32be(from.length), off);        off += 4;
    buf.set(from, off);                      off += from.length;
    buf.set(u64be(seqno), off);
    return sha256(buf);
  }

  it('signed: length-framed sha256 with seqno', () => {
    const id = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 42n, signature: new Uint8Array(), key: {} as never,
    });
    expect(id).toEqual(expected(TOPIC, PAYLOAD, FROM_BYTES, 42n));
    expect(id.length).toBe(32);
  });

  // Codex review feedback on PR #501 round 4: unsigned messages have
  // no publisher identity and no seqno, which would let two different
  // publishers' identical payloads collapse to the same msgId. The
  // function rejects them so the false-dedup case is impossible.
  it('unsigned: throws DkgGossipUnsignedMessageError', () => {
    expect(() =>
      dkgGossipMsgId({ type: 'unsigned', topic: TOPIC, data: PAYLOAD }),
    ).toThrow(DkgGossipUnsignedMessageError);
  });

  it('different topics → different msgIds (same payload + from + seqno)', () => {
    const a = dkgGossipMsgId({
      type: 'signed', topic: 'topic-a', data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array(), key: {} as never,
    });
    const b = dkgGossipMsgId({
      type: 'signed', topic: 'topic-b', data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array(), key: {} as never,
    });
    expect(a).not.toEqual(b);
  });

  it('different payloads → different msgIds (same topic + from + seqno)', () => {
    const a = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: new Uint8Array([1]), from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array(), key: {} as never,
    });
    const b = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: new Uint8Array([2]), from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array(), key: {} as never,
    });
    expect(a).not.toEqual(b);
  });

  it('different from-identities → different msgIds', () => {
    const altFrom = {
      toMultihash: () => ({ bytes: new Uint8Array([0x11, 0x22, 0x33]) }),
    } as unknown as Parameters<typeof dkgGossipMsgId>[0] extends infer M
      ? M extends { from: infer P } ? P : never : never;
    const a = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array(), key: {} as never,
    });
    const b = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: altFrom,
      sequenceNumber: 1n, signature: new Uint8Array(), key: {} as never,
    });
    expect(a).not.toEqual(b);
  });

  it('UTF-8 topics work', () => {
    const utf8Topic = 'cg/тема/1.0.0';
    const id = dkgGossipMsgId({
      type: 'signed', topic: utf8Topic, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 7n, signature: new Uint8Array(), key: {} as never,
    });
    expect(id).toEqual(expected(utf8Topic, PAYLOAD, FROM_BYTES, 7n));
  });

  // Codex review feedback on PR #501 — these are the regressions the
  // earlier draft would have shipped. Pin them.

  it('Codex bug #1: length-framing prevents ("ab","c") = ("a","bc") collision', () => {
    const id1 = dkgGossipMsgId({
      type: 'signed', topic: 'ab', data: new TextEncoder().encode('c'), from: fakePeerId,
      sequenceNumber: 0n, signature: new Uint8Array(), key: {} as never,
    });
    const id2 = dkgGossipMsgId({
      type: 'signed', topic: 'a', data: new TextEncoder().encode('bc'), from: fakePeerId,
      sequenceNumber: 0n, signature: new Uint8Array(), key: {} as never,
    });
    expect(id1).not.toEqual(id2);
  });

  it('Codex bug #2: same peer republishing same payload gets distinct msgIds via seqno', () => {
    const first = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array(), key: {} as never,
    });
    const retry = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 2n, signature: new Uint8Array(), key: {} as never,
    });
    expect(first).not.toEqual(retry);
  });

  it('seqno of the same value reproduces the same msgId (deterministic)', () => {
    const a = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 99n, signature: new Uint8Array(), key: {} as never,
    });
    const b = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 99n, signature: new Uint8Array(), key: {} as never,
    });
    expect(a).toEqual(b);
  });

  it('signature and key do NOT enter the msgId (content+seqno-deterministic)', () => {
    const a = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array([0x01]), key: { kind: 'a' } as never,
    });
    const b = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array([0xFF, 0xFF]), key: { kind: 'b' } as never,
    });
    expect(a).toEqual(b);
  });
});
