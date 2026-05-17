/**
 * Protobuf wire schemas used by this module for encode/decode helpers.
 *
 * The `*Schema` consts below are exported strictly for backwards
 * compatibility with external consumers that deep-imported them
 * before `@origintrail-official/dkg-core` had an `exports` map.
 * They are implementation detail — prefer the `*Msg` types and
 * `encode*` / `decode*` functions re-exported from
 * `packages/core/src/proto/index.ts`.
 *
 * @internal
 */
import protobuf from 'protobufjs';

const { Type, Field } = protobuf;

/**
 * Storage ACK message (spec §9.0.3).
 *
 * Sent by core nodes to attest that they have stored the data and
 * computed a matching merkle root. The ACK signature scheme is:
 *   ACK = EIP-191(computePublishACKDigest(chainId, kav10Address, cgId,
 *     merkleRoot, kaCount, byteSize, epochs, tokenAmount))
 * — the H5-prefixed 8-field digest. See `packages/core/src/crypto/ack.ts`
 * for the packed layout; matches `KnowledgeAssetsV10.sol:362-373`
 * byte-for-byte.
 */

/**
 * Declinable reasons a core node can return on `/dkg/10.0.0/storage-ack`
 * instead of a signed ACK. These are situations where the core
 * legitimately cannot produce an ACK (it doesn't host the CG, its SWM
 * is missing or stale relative to the publisher's payload, or its
 * operational signer was just rotated off-chain) — distinct from a
 * malformed-request error that should still close the libp2p stream.
 *
 * The publisher treats declines as **permanent for this request** (no
 * retry against the same peer), reports the per-peer decline reason in
 * the final error if quorum fails, and tries the remaining peers in
 * parallel.
 *
 * String values are part of the wire format: they are populated into
 * `StorageACK.declineCode` and surfaced in publisher logs / error
 * messages. Keep them stable across releases. Adding a new code is a
 * non-breaking change (older publishers will see it as the catch-all
 * "unknown decline" path); renaming or removing one IS breaking.
 */
export const STORAGE_ACK_DECLINE_CODES = {
  /** Core does not host the requested CG (no `<contextGraphsServed>`). */
  NOT_HOSTED: 'NOT_HOSTED',
  /** SWM CONSTRUCT returned no quads for the request. */
  NO_DATA_IN_SWM: 'NO_DATA_IN_SWM',
  /** SWM has data but its merkle root does not match the publisher's. */
  MERKLE_MISMATCH_IN_SWM: 'MERKLE_MISMATCH_IN_SWM',
  /** Operational signer was just removed / rotated off-chain. */
  SIGNER_NOT_REGISTERED: 'SIGNER_NOT_REGISTERED',
  /** CG id is non-numeric or non-positive (publisher remap mistake). */
  CG_ID_INVALID: 'CG_ID_INVALID',
} as const;

export type StorageACKDeclineCode =
  (typeof STORAGE_ACK_DECLINE_CODES)[keyof typeof STORAGE_ACK_DECLINE_CODES];

/**
 * Wire schema. Fields 1–5 are the original ACK shape; fields 6–7 carry
 * a decline payload. Two optional strings (rather than a `oneof`) keep
 * the change strictly additive: old encoders never set the new fields,
 * old decoders silently ignore them, so cross-version traffic is
 * unchanged. New decoders inspect `declineCode` first — when it is
 * non-empty the message is a decline and the ACK fields are unset.
 */
export const StorageACKSchema = new Type('StorageACK')
  .add(new Field('merkleRoot', 1, 'bytes'))
  .add(new Field('coreNodeSignatureR', 2, 'bytes'))
  .add(new Field('coreNodeSignatureVS', 3, 'bytes'))
  .add(new Field('contextGraphId', 4, 'string'))
  .add(new Field('nodeIdentityId', 5, 'uint64'))
  .add(new Field('declineCode', 6, 'string'))
  .add(new Field('declineMessage', 7, 'string'));

type Long = { low: number; high: number; unsigned: boolean };

export interface StorageACKMsg {
  merkleRoot: Uint8Array;
  coreNodeSignatureR: Uint8Array;
  coreNodeSignatureVS: Uint8Array;
  contextGraphId: string;
  nodeIdentityId: number | Long;
  /**
   * When non-empty, this message is a decline rather than a signed ACK
   * — see {@link STORAGE_ACK_DECLINE_CODES}. Old senders never set this
   * field; old receivers ignore it. New receivers MUST check this
   * before treating the message as an ACK (signature/merkleRoot are
   * unset on declines).
   */
  declineCode?: string;
  /**
   * Human-readable reason that accompanies `declineCode`. Surfaced into
   * publisher logs and the final `storage_ack_insufficient` error so
   * operators can diagnose hosting / replication issues without having
   * to ssh into individual cores.
   */
  declineMessage?: string;
}

/**
 * Convenience: returns true iff the message is a decline (i.e.
 * `declineCode` is set to a non-empty string). Keeps callers from
 * having to remember the empty-string-as-undefined idiom that
 * protobufjs uses for unset string fields.
 */
export function isStorageACKDecline(msg: StorageACKMsg): boolean {
  return typeof msg.declineCode === 'string' && msg.declineCode.length > 0;
}

export function encodeStorageACK(msg: StorageACKMsg): Uint8Array {
  return StorageACKSchema.encode(
    StorageACKSchema.create(msg),
  ).finish();
}

export function decodeStorageACK(buf: Uint8Array): StorageACKMsg {
  return StorageACKSchema.decode(buf) as unknown as StorageACKMsg;
}
