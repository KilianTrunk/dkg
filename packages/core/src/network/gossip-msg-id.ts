/**
 * Gossipsub message-id function — RFC 07 §5.4.
 *
 * RFC 07 commits to a single content-deterministic msgId convention:
 *
 *     msgId(topic, payload, fromIdentityId) := sha256(topic ‖ payload ‖ fromIdentityId)
 *
 * The point is **cross-backend dedup**. js-libp2p-gossipsub and
 * iroh-gossip don't talk to each other on the wire, but the application
 * sees their union (`GossipBus` in RFC 07 §5.3 sums them into one
 * mesh). For dedup to work across that union, every backend has to
 * derive the same msgId from the same content; no protocol-level
 * cooperation between gossip systems is required.
 *
 * v1 ships only `LibP2PGossipBackend`, so today this function changes
 * nothing observable — it replaces the upstream
 * `msgIdFnStrictSign` / `msgIdFnStrictNoSign` defaults with a constant
 * the network commits to. The wire-format change has to land **before**
 * a second gossip backend is added; otherwise existing nodes would
 * have to coordinate a synchronised msgIdFn upgrade mid-flight, which
 * is operationally painful at scale. Locking it in now is cheap (no
 * behaviour change) and removes that coordination cost forever.
 *
 * Encoding choices:
 * - `topic` is UTF-8-encoded. All V10 topics are ASCII today (see
 *   `contextGraph*Topic` in `genesis.ts`), but UTF-8 is the only
 *   reasonable string encoding to commit to.
 * - `fromIdentityId` is the multihash bytes of the `from` PeerId for
 *   signed messages (libp2p's canonical identity-as-bytes), and empty
 *   for unsigned messages. Empty `fromIdentityId` makes unsigned
 *   messages dedup purely by `topic ‖ payload`, equivalent to the
 *   upstream `msgIdFnStrictNoSign`. V10 publishes signed messages
 *   today, so the unsigned branch is effectively dead code; it exists
 *   so the function is total over the `Message` union and so
 *   stress-test fixtures that publish unsigned can still be deduped.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import type { Message } from '@libp2p/gossipsub';

const EMPTY = new Uint8Array(0);

export function dkgGossipMsgId(msg: Message): Uint8Array {
  const topicBytes = new TextEncoder().encode(msg.topic);
  const data = msg.data;
  const fromBytes = msg.type === 'signed' ? msg.from.toMultihash().bytes : EMPTY;
  const total = topicBytes.length + data.length + fromBytes.length;
  const buf = new Uint8Array(total);
  let off = 0;
  buf.set(topicBytes, off);
  off += topicBytes.length;
  buf.set(data, off);
  off += data.length;
  buf.set(fromBytes, off);
  return sha256(buf);
}
