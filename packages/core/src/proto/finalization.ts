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
  // Tristate sentinel encoding (Codex review r4 on PR #779): we cannot
  // use proto3 scalar `bool` here because proto3 omits scalar default
  // values on the wire — `keepRootCopyOnLabel = false` from a new
  // publisher would round-trip indistinguishably from a legacy
  // publisher that never sent the field. That ambiguity bites the
  // explicit-remap case Codex flagged: a publisher that passes
  // `subContextGraphId = current-CG's own on-chain-id` would set
  // `keepRootCopyOnLabel = false`, the bit would be omitted on the
  // wire (proto3 default), the receiver's legacy fallback would fire
  // (`targetContextGraphId === local-on-chain-id-for(contextGraphId)`)
  // and dual-write the root copy the publisher had intentionally
  // deleted. So we widen tag 15 to a `uint32` sentinel that carries
  // explicit presence:
  //   0 = UNSET (legacy publisher OR forward-compat default).
  //       Receivers fall back to inferring same-graph intent.
  //   1 = KEEP_ROOT (publisher kept the root copy; same-graph publish).
  //       Receivers MUST mirror the dual-write into the root data /
  //       _meta graphs.
  //   2 = DROP_ROOT (publisher deleted the root copy; remap publish or
  //       explicit-`subContextGraphId` flow).
  //       Receivers MUST NOT dual-write into the source CG's root.
  // The wire byte is identical to a proto3 `enum`/sentinel, so any
  // protobuf library (protobufjs, protoc-go, prost, …) round-trips
  // it correctly. `encodeFinalizationMessage` /
  // `decodeFinalizationMessage` translate to / from the public
  // `keepRootCopyOnLabel?: boolean` shape for ergonomic call sites
  // (the top-level field name preserves the post-r3 API). PR #779 has
  // not shipped to any production peer yet, so widening tag 15 from
  // `bool` to `uint32` here has no rolling-upgrade impact within this
  // patch series.
  .add(new Field('keepRootCopyOnLabelTri', 15, 'uint32'));

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
   * Backward compat (Codex r3/r4): the wire field is a `uint32`
   * tristate sentinel (0=UNSET, 1=KEEP, 2=DROP — see the schema
   * comment above). `encodeFinalizationMessage` /
   * `decodeFinalizationMessage` translate between the wire sentinel
   * and this public `boolean | undefined` API. Older publishers omit
   * the bit on the wire (decoded as `0` → `undefined` here); receivers
   * treat `undefined` by inferring same-graph intent from
   * `targetContextGraphId === local-on-chain-id`
   * (`finalization-handler.ts handleFinalizationMessage`). This
   * preserves label-scoped query convergence on mixed-version meshes
   * AND on cross-language meshes where the sender uses a non-`protobufjs`
   * encoder.
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

/**
 * Translate the public `boolean | undefined` flag to the on-the-wire
 * tristate sentinel (0=UNSET, 1=KEEP, 2=DROP). See the schema comment
 * on `keepRootCopyOnLabelTri` (Codex r4) for the rationale.
 *
 * `undefined` → 0 (omitted on the wire by proto3 default-value rules,
 * which is exactly what receivers expect for legacy publishers).
 * `true`      → 1 (KEEP root copy on label).
 * `false`     → 2 (DROP root copy on label).
 *
 * @internal
 */
function tristateFromBool(v: boolean | undefined): number {
  if (v === undefined) return 0;
  return v ? 1 : 2;
}

/**
 * Translate the on-the-wire tristate sentinel back to the public
 * `boolean | undefined` flag.
 *
 * 0 / undefined / unknown → `undefined` (legacy publisher OR a
 * forward-compat sentinel value we don't yet understand — both should
 * trigger the rolling-upgrade fallback in
 * `finalization-handler.ts handleFinalizationMessage`).
 * 1                       → `true`.
 * 2                       → `false`.
 *
 * @internal
 */
function boolFromTristate(v: number | undefined | null): boolean | undefined {
  if (v === 1) return true;
  if (v === 2) return false;
  return undefined;
}

export function encodeFinalizationMessage(msg: FinalizationMessageMsg): Uint8Array {
  // Map the public `keepRootCopyOnLabel?: boolean` field to the
  // wire-level `keepRootCopyOnLabelTri: uint32` sentinel. Drop the
  // public field name from `create()` so protobufjs doesn't try to
  // coerce a `boolean` into the `uint32` slot.
  const { keepRootCopyOnLabel, ...rest } = msg;
  return FinalizationMessageSchema.encode(
    FinalizationMessageSchema.create({
      ...rest,
      blockNumber: bigIntToProtoSafe(msg.blockNumber),
      batchId: bigIntToProtoSafe(msg.batchId),
      startKAId: bigIntToProtoSafe(msg.startKAId),
      endKAId: bigIntToProtoSafe(msg.endKAId),
      timestampMs: bigIntToProtoSafe(msg.timestampMs),
      keepRootCopyOnLabelTri: tristateFromBool(keepRootCopyOnLabel),
    }),
  ).finish();
}

export function decodeFinalizationMessage(buf: Uint8Array): FinalizationMessageMsg {
  const decoded = FinalizationMessageSchema.decode(buf) as unknown as FinalizationMessageMsg & {
    keepRootCopyOnLabelTri?: number;
  };
  // Translate the wire sentinel back to the public boolean | undefined
  // shape. We deliberately do NOT clone the decoded object or strip
  // prototype defaults from the other fields — Codex r4 flagged that
  // doing so changes the public decode contract for `operationId`,
  // `targetContextGraphId`, `subGraphName`, empty repeated fields,
  // and zero-valued uint64s, breaking existing callers. The tristate
  // encoding makes the explicit own-property scrub unnecessary because
  // presence is already carried in the wire value: 0 means unset,
  // 1/2 mean explicit set. Mutate-in-place keeps the rest of the
  // decoded shape (`Buffer` for bytes, `Long` for uint64, prototype
  // defaults for absent strings, …) bit-identical to the pre-r3
  // contract.
  decoded.keepRootCopyOnLabel = boolFromTristate(
    (decoded as { keepRootCopyOnLabelTri?: number }).keepRootCopyOnLabelTri,
  );
  delete (decoded as { keepRootCopyOnLabelTri?: number }).keepRootCopyOnLabelTri;
  return decoded;
}
