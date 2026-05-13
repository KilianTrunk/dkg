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
 * Why throw on unsigned
 * ---------------------
 * Codex review feedback on PR #501 round 4: with `type: 'unsigned'`
 * the message has no publisher identity (no `from`) and no seqno.
 * The earlier draft fell back to `fromBytes = []` and `seqno = 0n`,
 * which means two different publishers sending the same payload on
 * the same topic produce the SAME msgId — one publish gets falsely
 * deduplicated. (The upstream default for unsigned —
 * `sha256(data)` — has the same property, but a public function
 * shouldn't replicate that pitfall in a freshly-shipped contract.)
 *
 * V10 configures gossipsub with the StrictSign default, so unsigned
 * messages don't appear in the wild today. Throwing here makes the
 * "unsigned not supported in this msgId scheme" stance explicit:
 *
 *   - any code path that tries to publish an unsigned message
 *     fails loudly (easy to debug),
 *   - external consumers of the exported function can't accidentally
 *     hit the false-dedup case,
 *   - a future PR that wants to support unsigned has to deliberately
 *     extend the scheme with a per-message identity (nonce / hash
 *     prefix / etc.), pinned by tests.
 *
 * v1 ships only `LibP2PGossipBackend`, so this function only changes
 * which sha256 inputs gossipsub feeds itself; nothing observable on
 * the wire. Locking the constant in NOW (rather than after a second
 * backend ships) avoids a future synchronised mid-flight upgrade.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import type { Message } from '@libp2p/gossipsub';

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

export class DkgGossipUnsignedMessageError extends Error {
  constructor() {
    super(
      'dkgGossipMsgId: unsigned messages are not supported. The DKG msgId ' +
        'scheme requires a publisher identity (`from`) and `sequenceNumber` ' +
        'to avoid false dedup of payload-identical publishes from different ' +
        'publishers. Use StrictSign (the gossipsub default) or extend the ' +
        'scheme with a per-message nonce.',
    );
    this.name = 'DkgGossipUnsignedMessageError';
  }
}

export function dkgGossipMsgId(msg: Message): Uint8Array {
  if (msg.type !== 'signed') {
    throw new DkgGossipUnsignedMessageError();
  }

  const topicBytes = new TextEncoder().encode(msg.topic);
  const data = msg.data;
  const fromBytes = msg.from.toMultihash().bytes;
  const seqno = msg.sequenceNumber;

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
