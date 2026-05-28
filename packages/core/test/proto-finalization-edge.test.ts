/**
 * Finalization proto encode/decode edge cases (uint64 bounds, garbage input).
 */
import { describe, it, expect } from 'vitest';
import { encodeFinalizationMessage, decodeFinalizationMessage } from '../src/proto/finalization.js';

const MAX_UINT64 = (1n << 64n) - 1n;

function minimalFinalization(overrides: Record<string, unknown> = {}) {
  return {
    ual: 'did:dkg:evm:31337/0x0/1',
    contextGraphId: 'p',
    kcMerkleRoot: new Uint8Array(32),
    txHash: '0xab',
    blockNumber: 1,
    batchId: 1,
    startKAId: 1,
    endKAId: 1,
    publisherAddress: '0x1111111111111111111111111111111111111111',
    rootEntities: [] as string[],
    timestampMs: 1,
    ...overrides,
  };
}

describe('encodeFinalizationMessage uint64 bounds', () => {
  it('accepts bigint at uint64 max', () => {
    const buf = encodeFinalizationMessage(
      minimalFinalization({
        blockNumber: MAX_UINT64,
        batchId: MAX_UINT64,
        startKAId: MAX_UINT64,
        endKAId: MAX_UINT64,
        timestampMs: MAX_UINT64,
      }) as any,
    );
    const dec = decodeFinalizationMessage(buf);
    expect(BigInt(dec.blockNumber as any)).toBe(MAX_UINT64);
  });

  it('throws RangeError when any uint64 field overflows', () => {
    expect(() =>
      encodeFinalizationMessage(minimalFinalization({ batchId: MAX_UINT64 + 1n }) as any),
    ).toThrow(RangeError);
    expect(() =>
      encodeFinalizationMessage(minimalFinalization({ timestampMs: -1n }) as any),
    ).toThrow(RangeError);
  });
});

describe('decodeFinalizationMessage robustness', () => {
  it('decodes truncated buffer without throwing (protobufjs default)', () => {
    const dec = decodeFinalizationMessage(new Uint8Array([0x0a, 0x01, 0x41]));
    expect(typeof dec.ual).toBe('string');
  });

  it('round-trip preserves contextGraphId when set', () => {
    const msg = minimalFinalization({ contextGraphId: 'cg-hex' }) as any;
    const dec = decodeFinalizationMessage(encodeFinalizationMessage(msg));
    expect(dec.contextGraphId).toBe('cg-hex');
  });
});

/**
 * keepRootCopyOnLabel is the gossip-side dual-write toggle introduced in
 * PR #779. Codex r5 flagged that the wire schema flipped from `bool` to a
 * `uint32` tristate sentinel without explicit round-trip coverage —
 * regression risk if a future refactor silently collapsed `false` back into
 * the proto3-default/legacy case (the exact ambiguity that motivated the
 * tristate). These tests pin the encoder ↔ decoder contract and the
 * mixed-mesh decode path for legacy tag-15 `bool` payloads.
 */
describe('keepRootCopyOnLabel tristate wire contract', () => {
  it('round-trips true → KEEP(1) → true', () => {
    const msg = minimalFinalization({ keepRootCopyOnLabel: true }) as any;
    const dec = decodeFinalizationMessage(encodeFinalizationMessage(msg));
    expect(dec.keepRootCopyOnLabel).toBe(true);
  });

  it('round-trips false → DROP(2) → false', () => {
    // The whole point of the tristate is that explicit `false` survives
    // the wire as a non-default sentinel value. proto3 `bool=false` would
    // be dropped by the encoder and decoded back as `undefined`, which
    // would defeat the "publisher explicitly opted out" signal Codex r4
    // flagged on the explicit-`subContextGraphId === own-CG` flow.
    const msg = minimalFinalization({ keepRootCopyOnLabel: false }) as any;
    const dec = decodeFinalizationMessage(encodeFinalizationMessage(msg));
    expect(dec.keepRootCopyOnLabel).toBe(false);
  });

  it('round-trips undefined → UNSET(0, omitted) → undefined', () => {
    const msg = minimalFinalization({}) as any;
    expect(msg.keepRootCopyOnLabel).toBeUndefined();
    const dec = decodeFinalizationMessage(encodeFinalizationMessage(msg));
    expect(dec.keepRootCopyOnLabel).toBeUndefined();
  });

  it('encodes undefined identically to a message that omits the field entirely', () => {
    // Round-trip is the public contract; the byte-level guarantee here
    // is that "field omitted" and "field explicitly undefined" produce
    // the SAME wire output. A future refactor that started encoding
    // `keepRootCopyOnLabel === undefined` as something other than the
    // tristate UNSET sentinel would split the legacy/forward-compat
    // path on mixed-version meshes (some receivers would see UNSET,
    // some KEEP, some DROP). protobufjs happens to serialise `uint32=0`
    // as 2 explicit wire bytes (proto2-style default emission), which
    // is *also* what a legacy publisher's `bool=false` looks like on
    // the wire — so this equivalence doubles as the rolling-upgrade
    // bridge. We assert byte-level equality, not length-only, so any
    // accidental shift in the encoder shows up.
    const baseBuf  = encodeFinalizationMessage(minimalFinalization({}) as any);
    const undefBuf = encodeFinalizationMessage(
      minimalFinalization({ keepRootCopyOnLabel: undefined }) as any,
    );
    const keepBuf  = encodeFinalizationMessage(
      minimalFinalization({ keepRootCopyOnLabel: true }) as any,
    );
    expect(Buffer.from(undefBuf).equals(Buffer.from(baseBuf))).toBe(true);
    expect(keepBuf.length).toBe(baseBuf.length);
    expect(Buffer.from(keepBuf).equals(Buffer.from(baseBuf))).toBe(false);
  });

  it('decodes a legacy tag-15 bool=true payload as true (wire-compatible varint)', () => {
    // A pre-#779 publisher that still treats tag-15 as `bool` will encode
    // `keepRootCopyOnLabel=true` as a varint value of 1 under the same
    // tag byte. proto3 wire types 0 (bool) and 0 (uint32) are identical,
    // so this byte sequence MUST decode cleanly as the new tristate's
    // KEEP sentinel and surface as `true` on the public API. This test
    // pins the rolling-upgrade compatibility Codex r4 demanded:
    //   tag = (15 << 3) | 0 (varint) = 0x78, value = 0x01.
    const legacyBuf = new Uint8Array([0x78, 0x01]);
    const dec = decodeFinalizationMessage(legacyBuf);
    expect(dec.keepRootCopyOnLabel).toBe(true);
  });

  it('decodes a legacy tag-15 bool=false payload (explicit 0) as undefined', () => {
    // protobufjs (and most proto3 encoders) drop default scalars, but a
    // non-strict encoder COULD ship `bool=false` as `0x78 0x00`. The
    // tristate decoder treats `0` as UNSET — the rolling-upgrade fallback
    // in `finalization-handler.ts handleFinalizationMessage` then infers
    // intent from `targetContextGraphId`. Crucially we must NOT collapse
    // wire-`0` back to `false` (that would re-introduce the exact
    // ambiguity the tristate was added to eliminate).
    const legacyBuf = new Uint8Array([0x78, 0x00]);
    const dec = decodeFinalizationMessage(legacyBuf);
    expect(dec.keepRootCopyOnLabel).toBeUndefined();
  });

  it('clamps unknown forward-compat sentinel values to undefined', () => {
    // Future protocol versions may extend the sentinel (e.g. 3 = a new
    // mode). Today's receivers MUST treat unknowns the same as UNSET so
    // they fall back to the safe inference path rather than guessing one
    // of KEEP/DROP and risking divergence from the publisher's intent.
    const forwardBuf = new Uint8Array([0x78, 0x07]);
    const dec = decodeFinalizationMessage(forwardBuf);
    expect(dec.keepRootCopyOnLabel).toBeUndefined();
  });
});
