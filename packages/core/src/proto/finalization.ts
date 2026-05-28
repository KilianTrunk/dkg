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

export const FinalizationMessageSchema = new Type('FinalizationMessage')
  .add(new Field('ual', 1, 'string'))
  .add(new Field('contextGraphId', 2, 'string'))
  .add(new Field('kcMerkleRoot', 3, 'bytes'))
  .add(new Field('txHash', 4, 'string'))
  .add(new Field('blockNumber', 5, 'uint64'))
  .add(new Field('batchId', 6, 'uint64'))
  .add(new Field('startKAId', 7, 'uint64'))
  .add(new Field('endKAId', 8, 'uint64'))
  .add(new Field('publisherAddress', 9, 'string'))
  .add(new Field('rootEntities', 10, 'string', 'repeated'))
  .add(new Field('timestampMs', 11, 'uint64'))
  .add(new Field('operationId', 12, 'string'))
  .add(new Field('targetContextGraphId', 13, 'string'))
  .add(new Field('subGraphName', 14, 'string'))
  // Codex review (PR #779) — distinguishes a same-graph publish (where
  // the publisher kept a root-graph copy of the canonical quads so
  // label-scoped queries find them) from an explicit-`subContextGraphId`
  // / remap publish (where the publisher deletes the root copy on
  // purpose). Receivers MUST honor this to avoid re-exposing remap-style
  // KCs under the source CG label.
  //
  // Wire encoding caveat (Codex review r3 on PR #779): proto3 `bool`
  // omits the field on the wire when the value is the default `false`,
  // and protobufjs decodes the omitted field as `false` through the
  // Message prototype. To distinguish "legacy publisher (no bit on the
  // wire)" from "new publisher that explicitly set `false`" we strip
  // prototype defaults inside `decodeFinalizationMessage` (see below)
  // and expose presence via own-properties — receivers then read
  // `msg.keepRootCopyOnLabel === undefined` for legacy publishers and
  // fall back to inferring same-graph intent from
  // `targetContextGraphId === local-on-chain-id-for(contextGraphId)`.
  // The fallback lives in `finalization-handler.ts`
  // `handleFinalizationMessage`, gated on this presence check, so a
  // mixed-version mesh stays correct: legacy same-graph publishes still
  // trigger the recipient root dual-write, and legacy remap publishes
  // still skip it.
  .add(new Field('keepRootCopyOnLabel', 15, 'bool'));

type Long = { low: number; high: number; unsigned: boolean };

export interface FinalizationMessageMsg {
  ual: string;
  contextGraphId: string;
  kcMerkleRoot: Uint8Array;
  txHash: string;
  blockNumber: number | bigint | Long;
  batchId: number | bigint | Long;
  startKAId: number | bigint | Long;
  endKAId: number | bigint | Long;
  publisherAddress: string;
  rootEntities: string[];
  timestampMs: number | bigint | Long;
  /** Originator's operation ID for cross-node log correlation. */
  operationId?: string;
  /** When set, the finalization targeted a distinct on-chain context graph. */
  targetContextGraphId?: string;
  /** Sub-graph within the context graph. Receivers promote SWM into sub-graph data graph if set. */
  subGraphName?: string;
  /**
   * Same-graph publish indicator (PR #779 / #774 followup). When `true`,
   * the publisher kept a root-graph copy of the canonical quads alongside
   * the per-on-chain-id partition so label-scoped queries
   * (`contextGraphId=<label>` with no `/context/<num>` suffix) resolve
   * the data — receivers mirror that dual-write. When `false`/absent,
   * the publisher deleted its root copy (explicit `subContextGraphId` /
   * remap-style publish) and receivers MUST NOT dual-write into the
   * source CG's root graph.
   *
   * Backward compat (Codex r3): older publishers omit the bit on the
   * wire. `decodeFinalizationMessage` strips proto3 prototype defaults
   * so receivers see `keepRootCopyOnLabel === undefined` for legacy
   * publishers and `=== false` only for new publishers that explicitly
   * cleared the bit. Receivers treat `undefined` by inferring
   * same-graph intent from `targetContextGraphId === local-on-chain-id`
   * (`finalization-handler.ts handleFinalizationMessage`), preserving
   * label-scoped query convergence on mixed-version meshes.
   */
  keepRootCopyOnLabel?: boolean;
}

const MAX_UINT64 = (1n << 64n) - 1n;

function bigIntToProtoSafe(val: number | bigint | Long): number | Long {
  if (typeof val === 'bigint') {
    if (val < 0n || val > MAX_UINT64) {
      throw new RangeError(`Value ${val} exceeds uint64 range [0, 2^64-1]`);
    }
    const low = Number(val & 0xFFFFFFFFn);
    const high = Number((val >> 32n) & 0xFFFFFFFFn);
    return { low, high, unsigned: true };
  }
  return val as number | Long;
}

export function encodeFinalizationMessage(msg: FinalizationMessageMsg): Uint8Array {
  return FinalizationMessageSchema.encode(
    FinalizationMessageSchema.create({
      ...msg,
      blockNumber: bigIntToProtoSafe(msg.blockNumber),
      batchId: bigIntToProtoSafe(msg.batchId),
      startKAId: bigIntToProtoSafe(msg.startKAId),
      endKAId: bigIntToProtoSafe(msg.endKAId),
      timestampMs: bigIntToProtoSafe(msg.timestampMs),
    }),
  ).finish();
}

export function decodeFinalizationMessage(buf: Uint8Array): FinalizationMessageMsg {
  const decoded = FinalizationMessageSchema.decode(buf);
  // Codex review (PR #779) — protobufjs decodes scalar fields with proto3
  // default semantics: a field that is omitted on the wire reads as its
  // type-default (`false` for bool, `0` for numerics, `''` for strings)
  // through the runtime instance's prototype chain. Receivers that need
  // to distinguish "publisher did not set this field" from "publisher
  // explicitly set this field to its zero value" cannot use
  // `typeof x === 'boolean'` against the raw Message instance, because a
  // legacy publisher's omitted `keepRootCopyOnLabel` reads as the bool
  // default `false` and looks indistinguishable from an explicit
  // `false`. That's exactly the rolling-upgrade hazard the
  // `keepRootCopyOnLabel` wire bit is meant to handle:
  //   - new publisher, same-graph publish    → keepRootCopyOnLabel = true
  //   - new publisher, remap publish         → keepRootCopyOnLabel = false
  //   - legacy publisher (any kind)          → field NOT on the wire,
  //                                            receiver must fall back
  //                                            to inferring same-graph
  //                                            from `targetContextGraphId`
  //                                            (see `finalization-handler.ts`
  //                                            handleFinalizationMessage).
  // To preserve presence we surface only own properties of the decoded
  // Message — `Object.keys`/`getOwnPropertyNames` skip the prototype
  // defaults, so downstream `hasOwnProperty` and
  // `msg.keepRootCopyOnLabel === undefined` checks correctly identify
  // legacy publishers vs. explicit-false publishers vs. explicit-true
  // publishers.
  const result: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(decoded)) {
    result[key] = (decoded as unknown as Record<string, unknown>)[key];
  }
  return result as unknown as FinalizationMessageMsg;
}
