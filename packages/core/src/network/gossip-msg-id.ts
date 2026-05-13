/**
 * Gossipsub message-id function — RFC 07 §5.4.
 *
 * RFC 07 commits to a single content-deterministic msgId convention
 * so any future gossip backend (iroh-gossip, etc.) can dedup against
 * libp2p-gossipsub without protocol-level cooperation. The exact
 * encoding (after Codex review feedback on PR #501):
 *
 *     msgId(topic, payload, fromIdentityId, seqno) :=
 *         sha256(
 *           u32_be(len(topic))           ‖ topic
 *           ‖ u32_be(len(payload))        ‖ payload
 *           ‖ u32_be(len(fromIdentityId)) ‖ fromIdentityId
 *           ‖ u64_be(seqno)
 *         )
 *
 * Why length framing
 * ------------------
 * Without length prefixes, raw concatenation collides:
 * `("ab", "c", from)` and `("a", "bc", from)` would hash the same
 * bytes and dedup as one message even though they're distinct
 * (topic, payload) tuples. The u32_be length prefix per field makes
 * the encoding injective — distinct tuples always hash to distinct
 * inputs.
 *
 * Why include seqno
 * -----------------
 * The whole point of gossipsub's msgId is dedup-with-retries: a peer
 * publishing the same payload twice (e.g. resending after a network
 * blip) must produce TWO distinct msgIds, otherwise the second
 * publish is dropped as a duplicate. The upstream `msgIdFnStrictSign`
 * uses `(key, seqno)` precisely for this reason. Including the
 * sequence number in the hash preserves that semantic without
 * forfeiting cross-backend determinism: every backend with a notion
 * of per-publisher monotonic ordering (gossipsub seqno, iroh-gossip
 * sequence, etc.) maps the same (topic, payload, from, seq) tuple
 * to the same hash.
 *
 * Unsigned messages don't carry a seqno; for them we use `0n`. The
 * upstream behaviour for unsigned was `sha256(data)` — pure dedup
 * by payload, which V10 doesn't rely on. We don't ship unsigned
 * publishes today; the branch exists so the function is total over
 * the `Message` union.
 *
 * v1 ships only `LibP2PGossipBackend`, so this function only changes
 * which sha256 inputs gossipsub feeds itself; nothing observable on
 * the wire. Locking the constant in NOW (rather than after a second
 * backend ships) avoids a future synchronised mid-flight upgrade.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import type { Message } from '@libp2p/gossipsub';

const EMPTY = new Uint8Array(0);

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

export function dkgGossipMsgId(msg: Message): Uint8Array {
  const topicBytes = new TextEncoder().encode(msg.topic);
  const data = msg.data;
  const fromBytes = msg.type === 'signed' ? msg.from.toMultihash().bytes : EMPTY;
  const seqno = msg.type === 'signed' ? msg.sequenceNumber : 0n;

  const total =
    4 + topicBytes.length +
    4 + data.length +
    4 + fromBytes.length +
    8;
  const buf = new Uint8Array(total);
  let off = 0;

  buf.set(u32be(topicBytes.length), off); off += 4;
  buf.set(topicBytes, off);                off += topicBytes.length;

  buf.set(u32be(data.length), off);        off += 4;
  buf.set(data, off);                      off += data.length;

  buf.set(u32be(fromBytes.length), off);   off += 4;
  buf.set(fromBytes, off);                 off += fromBytes.length;

  buf.set(u64be(seqno), off);

  return sha256(buf);
}
