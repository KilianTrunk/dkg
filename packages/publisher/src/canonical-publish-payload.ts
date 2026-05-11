// Shared canonicalization pipeline for the publish flow.
//
// Both `agent.publishAsync` (at lift-enqueue time) and
// `DKGPublisher.publish` (at processNext-time) MUST compute the same
// `kcMerkleRoot` over the same input, otherwise the agent-signed
// AuthorAttestation seal won't validate against what the publisher
// finally submits on-chain. Putting this composition in one place
// guarantees parity by construction — there is no second
// implementation to drift.
//
// Inputs:
//   - `quads`         — the public quads for this publish
//   - `privateQuads`  — optional private quads, partitioned per-root
//                       via the same `subject` / skolemized-genid
//                       rule that `DKGPublisher.publish` applies
//                       inline.
//
// Output:
//   - `skolemizedPublicQuads` — flat-ordered post-partition quads
//     (input to `publishDirect`'s public-data argument).
//   - `privateRoots` — per-root private merkle roots, in the same
//     order as `autoPartition` returns roots.
//   - `kcMerkleRoot` — the flat KC merkle root, V10 keccak256 variant.
//     This is what the EIP-712 `AuthorAttestation` seal binds to.
//   - `manifestEntries` — per-root metadata used by the publisher
//     to construct `publishDirect` manifest args. Agents only need
//     `kcMerkleRoot`; they can ignore the rest.

import type { Quad } from '@origintrail-official/dkg-storage';
import { autoPartition } from './auto-partition.js';
import { computeFlatKCRootV10, computePrivateRootV10 } from './merkle.js';

export interface CanonicalManifestEntry {
  readonly rootEntity: string;
  readonly publicTripleCount: number;
  readonly privateMerkleRoot: Uint8Array | undefined;
  readonly privateTripleCount: number;
}

export interface CanonicalPublishPayload {
  readonly skolemizedPublicQuads: Quad[];
  readonly privateRoots: Uint8Array[];
  readonly kcMerkleRoot: Uint8Array;
  readonly manifestEntries: ReadonlyArray<CanonicalManifestEntry>;
}

export function canonicalPublishPayload(
  quads: Quad[],
  privateQuads: Quad[] = [],
): CanonicalPublishPayload {
  const kaMap = autoPartition(quads);

  const manifestEntries: CanonicalManifestEntry[] = [];
  for (const [rootEntity, publicForRoot] of kaMap) {
    const entityPrivateQuads = privateQuads.filter(
      (qq) =>
        qq.subject === rootEntity ||
        qq.subject.startsWith(rootEntity + '/.well-known/genid/'),
    );
    manifestEntries.push({
      rootEntity,
      publicTripleCount: publicForRoot.length,
      privateMerkleRoot: entityPrivateQuads.length > 0
        ? computePrivateRootV10(entityPrivateQuads)
        : undefined,
      privateTripleCount: entityPrivateQuads.length,
    });
  }

  const skolemizedPublicQuads = [...kaMap.values()].flat();
  const privateRoots = manifestEntries
    .map((m) => m.privateMerkleRoot)
    .filter((r): r is Uint8Array => r != null);
  const kcMerkleRoot = computeFlatKCRootV10(skolemizedPublicQuads, privateRoots);

  return {
    skolemizedPublicQuads,
    privateRoots,
    kcMerkleRoot,
    manifestEntries,
  };
}
