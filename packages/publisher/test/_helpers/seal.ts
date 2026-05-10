/**
 * Test helper: build a `precomputedAttestation` over a publish call.
 *
 * Phase C (commit `d353d6a5`) made the publisher a pure transport for
 * AuthorAttestation seals — it neither signs nor accepts signing
 * material. Every on-chain test that previously relied on the
 * publisher's internal EOA fallback now needs to hand-build the seal,
 * so this helper centralises that ceremony to keep tests focused on
 * what they actually assert (transport, lifecycle, ownership,
 * ACK quorum, etc.).
 *
 * The helper mirrors `DKGAgent._buildPrecomputedAttestationForSelection`
 * (`packages/agent/src/dkg-agent.ts`) so the merkle root the test signs
 * exactly matches what `DKGPublisher.publish` will recompute at
 * publish-time. Notably it handles `privateQuads` per the Round 4
 * review §11 fix: each public root entity's private bag becomes a
 * `computePrivateRootV10` leaf in the KC merkle, in the same insertion
 * order the publisher walks `autoPartition(quads).keys()`.
 */
import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { DKGPublisher } from '../../src/dkg-publisher.js';
import { autoPartition, computeFlatKCRootV10, computePrivateRootV10 } from '../../src/index.js';
import {
  buildAuthorAttestationTypedData,
  AUTHOR_SCHEME_VERSION_V1,
} from '@origintrail-official/dkg-core';

export interface SealCtx {
  provider: ethers.JsonRpcProvider;
  kav10Address: string;
}

export interface BuildSealParams {
  quads: Quad[];
  /** Optional private quads — included in the merkle as private roots
   * per `computeFlatKCRoot(public, privateRoots)`. */
  privateQuads?: Quad[];
  author: ethers.Wallet;
  contextGraphId: string | bigint;
  ctx: SealCtx;
}

export interface PrecomputedAttestation {
  expectedMerkleRoot: Uint8Array;
  authorAddress: string;
  signature: { r: Uint8Array; vs: Uint8Array };
  schemeVersion: number;
}

/**
 * Build a `precomputedAttestation` payload for `quads` (+ optional
 * `privateQuads`) signed by `author`. The returned object is shaped to
 * be passed verbatim as `PublishOptions.precomputedAttestation`.
 */
export async function buildSeal(
  params: BuildSealParams,
): Promise<PrecomputedAttestation> {
  const { quads, privateQuads = [], author, contextGraphId, ctx } = params;

  const kaMap = autoPartition(quads);
  const allPublic = [...kaMap.values()].flat();
  const privateRoots: Uint8Array[] = [];
  for (const rootEntity of kaMap.keys()) {
    if (privateQuads.length === 0) break;
    const entityPrivateQuads = privateQuads.filter(
      (q) =>
        q.subject === rootEntity ||
        q.subject.startsWith(rootEntity + '/.well-known/genid/'),
    );
    if (entityPrivateQuads.length === 0) continue;
    const root = computePrivateRootV10(entityPrivateQuads);
    if (root) privateRoots.push(root);
  }
  const merkleRoot = computeFlatKCRootV10(allPublic, privateRoots);

  const chainIdNum = await ctx.provider.getNetwork().then((n) => n.chainId);
  const td = buildAuthorAttestationTypedData({
    chainId: BigInt(chainIdNum),
    kav10Address: ctx.kav10Address,
    contextGraphId: BigInt(contextGraphId),
    merkleRoot,
    authorAddress: author.address,
  });
  const sigHex = await author.signTypedData(td.domain, td.types, td.message);
  const sig = ethers.Signature.from(sigHex);
  return {
    expectedMerkleRoot: merkleRoot,
    authorAddress: author.address,
    signature: {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    },
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
  };
}

export interface PublishSealedArgs {
  contextGraphId: string;
  quads: Quad[];
  privateQuads?: Quad[];
  /**
   * Anything else the caller wants to pass through to
   * `publisher.publish` / `publisher.update` (publisherPeerId,
   * accessPolicy, allowedPeers, isImmutable, epochs, byteSize, etc.).
   */
  [key: string]: unknown;
}

/**
 * Augment a `publisher.publish` / `publisher.update` argument bag with
 * a freshly-minted `precomputedAttestation` so existing tests can stay
 * structurally identical:
 *
 *   await publisher.publish(await withSeal(args, author, ctx))
 *
 * Note this is a TEST-ONLY helper; production callers are expected to
 * mint the seal at agent.assertion.finalize() time, not at publish
 * time, so they always pass a seal explicitly. See Phase C
 * (`d353d6a5`): the publisher is a pure transport for already-built
 * seals.
 */
export async function withSeal<T extends PublishSealedArgs>(
  args: T,
  author: ethers.Wallet,
  ctx: SealCtx,
): Promise<T & { precomputedAttestation: PrecomputedAttestation }> {
  const seal = await buildSeal({
    quads: args.quads,
    privateQuads: args.privateQuads,
    author,
    contextGraphId: args.contextGraphId,
    ctx,
  });
  return { ...args, precomputedAttestation: seal };
}

/**
 * Thin wrapper around `publisher.publish` that mints a CORE_OP-signed
 * seal automatically. Equivalent to `publisher.publish(await withSeal(args, author, ctx))`.
 */
export async function publishSealed(
  publisher: DKGPublisher,
  args: PublishSealedArgs,
  author: ethers.Wallet,
  ctx: SealCtx,
) {
  return publisher.publish(
    (await withSeal(args, author, ctx)) as unknown as Parameters<DKGPublisher['publish']>[0],
  );
}

/**
 * Thin wrapper around `publisher.update`. Mirror of `publishSealed`.
 */
export async function updateSealed(
  publisher: DKGPublisher,
  kcId: bigint,
  args: PublishSealedArgs,
  author: ethers.Wallet,
  ctx: SealCtx,
) {
  return publisher.update(
    kcId,
    (await withSeal(args, author, ctx)) as unknown as Parameters<DKGPublisher['update']>[1],
  );
}
