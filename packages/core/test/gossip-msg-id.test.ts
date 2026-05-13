import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { dkgGossipMsgId } from '../src/network/gossip-msg-id.js';

/**
 * RFC 07 §5.4 — `dkgGossipMsgId` is the content-deterministic msgId
 * locked in for cross-backend gossip dedup. These tests pin the exact
 * encoding so any change is caught at code-review time.
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

  function expected(topic: string, data: Uint8Array, from: Uint8Array): Uint8Array {
    const topicBytes = new TextEncoder().encode(topic);
    const buf = new Uint8Array(topicBytes.length + data.length + from.length);
    let off = 0;
    buf.set(topicBytes, off); off += topicBytes.length;
    buf.set(data, off); off += data.length;
    buf.set(from, off);
    return sha256(buf);
  }

  it('signed: sha256(topic ‖ payload ‖ fromIdentityId)', () => {
    const id = dkgGossipMsgId({
      type: 'signed',
      topic: TOPIC,
      data: PAYLOAD,
      from: fakePeerId,
      sequenceNumber: 0n,
      signature: new Uint8Array(),
      key: {} as never,
    });
    expect(id).toEqual(expected(TOPIC, PAYLOAD, FROM_BYTES));
    expect(id.length).toBe(32);
  });

  it('unsigned: sha256(topic ‖ payload ‖ ∅)', () => {
    const id = dkgGossipMsgId({ type: 'unsigned', topic: TOPIC, data: PAYLOAD });
    expect(id).toEqual(expected(TOPIC, PAYLOAD, new Uint8Array(0)));
    expect(id.length).toBe(32);
  });

  it('different topics → different msgIds (same payload + from)', () => {
    const a = dkgGossipMsgId({
      type: 'signed', topic: 'topic-a', data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 0n, signature: new Uint8Array(), key: {} as never,
    });
    const b = dkgGossipMsgId({
      type: 'signed', topic: 'topic-b', data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 0n, signature: new Uint8Array(), key: {} as never,
    });
    expect(a).not.toEqual(b);
  });

  it('different payloads → different msgIds (same topic + from)', () => {
    const a = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: new Uint8Array([1]), from: fakePeerId,
      sequenceNumber: 0n, signature: new Uint8Array(), key: {} as never,
    });
    const b = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: new Uint8Array([2]), from: fakePeerId,
      sequenceNumber: 0n, signature: new Uint8Array(), key: {} as never,
    });
    expect(a).not.toEqual(b);
  });

  it('different from-identities → different msgIds (same topic + payload)', () => {
    const altFrom = {
      toMultihash: () => ({ bytes: new Uint8Array([0x11, 0x22, 0x33]) }),
    } as unknown as Parameters<typeof dkgGossipMsgId>[0] extends infer M
      ? M extends { from: infer P }
        ? P
        : never
      : never;
    const a = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 0n, signature: new Uint8Array(), key: {} as never,
    });
    const b = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: altFrom,
      sequenceNumber: 0n, signature: new Uint8Array(), key: {} as never,
    });
    expect(a).not.toEqual(b);
  });

  it('signed and unsigned with same topic/payload differ (from bytes are present vs absent)', () => {
    const signed = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 0n, signature: new Uint8Array(), key: {} as never,
    });
    const unsigned = dkgGossipMsgId({ type: 'unsigned', topic: TOPIC, data: PAYLOAD });
    expect(signed).not.toEqual(unsigned);
  });

  it('seqNo / signature / key do NOT enter the msgId (content-deterministic)', () => {
    const a = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 1n, signature: new Uint8Array([0x01]), key: { kind: 'a' } as never,
    });
    const b = dkgGossipMsgId({
      type: 'signed', topic: TOPIC, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 999n, signature: new Uint8Array([0xFF, 0xFF]), key: { kind: 'b' } as never,
    });
    expect(a).toEqual(b);
  });

  it('UTF-8 topics work', () => {
    const utf8Topic = 'cg/тема/1.0.0';
    const id = dkgGossipMsgId({
      type: 'signed', topic: utf8Topic, data: PAYLOAD, from: fakePeerId,
      sequenceNumber: 0n, signature: new Uint8Array(), key: {} as never,
    });
    expect(id).toEqual(expected(utf8Topic, PAYLOAD, FROM_BYTES));
  });
});
