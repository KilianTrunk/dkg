/**
 * SWM share ack (RFC-003 §4.2, rc.9 PR-D).
 *
 * Single-message protobuf carried by `PROTOCOL_SWM_SHARE_ACK`. The
 * receiver emits one of these to the share author after a
 * gossip-delivered share applies successfully (SharedMemoryHandler
 * returns `applied: true`). The sender's `SwmAckQuorum` accumulates
 * these per `shareOperationId` to compute delivery quorum and decide
 * whether to fire the substrate top-up watchdog.
 *
 * Substrate-delivered shares (`PROTOCOL_SWM_UPDATE`) DO NOT emit a
 * separate SwmShareAck — the substrate response (empty Uint8Array
 * for applied / FANOUT_RESPONSE_REJECTED sentinel for permanent
 * rejection) is itself the ack signal at the substrate layer. This
 * keeps the receiver out of the business of figuring out whether the
 * ack would be redundant with what the substrate already carried.
 *
 * Wire shape kept deliberately minimal — no signature, no
 * timestamp, no nonce. The author peerId is the receiver of the
 * ack message (transport identifies the sender, the sender identifies
 * itself in the body for restart-survival), and the
 * `shareOperationId` is opaque random bytes minted by the original
 * publisher (so it's already unguessable by random peers). Future
 * extensions (PR-G or beyond) MAY add fields without bumping the
 * protocol version as long as the wire bytes stay protobuf-decodable
 * by older senders — that's how protobuf field-number compatibility
 * works.
 *
 * Field semantics:
 *
 *   - `shareOperationId` — the publisher-minted unique ID for the
 *     original share, exactly as it appears in
 *     `WorkspacePublishRequest.shareOperationId` on the gossip path.
 *     The sender's `SwmAckQuorum` keys its pending-share map on this
 *     value; arrival of an ack for an unknown ID is dropped (likely a
 *     stale ack arriving after the share's deadlineHardMs expired and
 *     the record was reaped).
 *   - `ackPeerId` — the libp2p peerId of the receiver as a string
 *     (matches `node.peerId.toString()`). Carried in the body rather
 *     than relying on the transport-level `fromPeerId` because the
 *     latter is the immediate connection's peer, which after future
 *     relay/forwarder work may NOT equal the actual applier. We always
 *     trust the body value here; a forged ackPeerId would let a
 *     malicious peer claim delivery on someone else's behalf, but the
 *     blast radius is limited to "watchdog top-up doesn't fire for
 *     that peer" — the share itself is still subject to the per-CG
 *     auth checks on the receiver side, and the long-tail top-up
 *     would retry via substrate anyway if the actual delivery did
 *     fail. Better authentication (signing the ack with the receiver's
 *     agent key) is a PR-G-or-later addition.
 *
 * @internal
 */

import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

export const SwmShareAckSchema = new Type('SwmShareAck')
  .add(new Field('shareOperationId', 1, 'string'))
  .add(new Field('ackPeerId', 2, 'string'));

export interface SwmShareAckMsg {
  shareOperationId: string;
  ackPeerId: string;
}

export function encodeSwmShareAck(msg: SwmShareAckMsg): Uint8Array {
  return SwmShareAckSchema.encode(
    SwmShareAckSchema.create(msg),
  ).finish();
}

export function decodeSwmShareAck(buf: Uint8Array): SwmShareAckMsg {
  return SwmShareAckSchema.decode(buf) as unknown as SwmShareAckMsg;
}
