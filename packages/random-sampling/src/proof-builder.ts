/**
 * Proof builder seam.
 *
 * The orchestrator hands a `(leaves, chunkId, expectedCommitment)`
 * triple to a `ProofBuilder` and gets back V10 proof material. Two
 * implementations live behind the same interface:
 *
 * - {@link InProcessProofBuilder} — runs `buildV10ProofMaterial`
 *   directly on the calling thread. Default for tests + small KCs.
 * - `WorkerThreadProofBuilder` (in `proof-worker.ts`) — offloads the
 *   tree build to a dedicated `worker_threads` worker so a 100k-leaf
 *   KC does not block the agent's event loop.
 *
 * The seam matters even if the "default" path is in-process: it lets
 * the orchestrator and its tests stay agnostic to where the CPU work
 * happens, which keeps the test surface small and lets the worker
 * evolve independently.
 */

import {
  buildV10ProofMaterial,
  buildV10CiphertextChunksProofMaterial,
  type V10MerkleCommitment,
  type V10ProofMaterial,
} from '@origintrail-official/dkg-core';

export interface ProofBuilderRequest {
  /**
   * Extracted V10 leaves (publictriple-hashes + private sub-roots).
   * Order does not matter — `V10MerkleTree` sorts + dedupes.
   *
   * For curated KCs (LU-11 / RFC-39) when `kind: 'ciphertext-chunks'`,
   * pass the **raw ciphertext chunk bytes** in chunkId order instead;
   * the builder hashes each chunk and uses the index-preserving
   * `V10CiphertextChunksMerkleTree`.
   */
  leaves: Uint8Array[];
  /** On-chain `chunkId` from the challenge. */
  chunkId: number;
  /** Commitment we're trying to satisfy (chain-sourced root + leafCount). */
  expected: V10MerkleCommitment;
  /**
   * OT-RFC-39 — picks the V10 tree shape:
   *   - `'flat-kc'` (default): sort+dedupe leaves, public KC path.
   *   - `'ciphertext-chunks'`: index-preserving curated KC path.
   */
  kind?: 'flat-kc' | 'ciphertext-chunks';
}

export interface ProofBuilder {
  /**
   * Build proof material for the given challenge. Throws the same
   * named errors as `buildV10ProofMaterial`
   * (`V10ProofRootMismatchError`, `V10ProofLeafCountMismatchError`,
   * `V10ProofChunkOutOfRangeError`) so the orchestrator can branch
   * on each.
   */
  build(req: ProofBuilderRequest): Promise<V10ProofMaterial>;
  /** Release any underlying resources (worker thread, etc.). */
  close(): Promise<void>;
}

/**
 * Synchronous in-process implementation. Cheap for KCs up to ~10k
 * leaves; above that, prefer `WorkerThreadProofBuilder` so the agent
 * event loop stays responsive.
 */
export class InProcessProofBuilder implements ProofBuilder {
  async build(req: ProofBuilderRequest): Promise<V10ProofMaterial> {
    if (req.kind === 'ciphertext-chunks') {
      return buildV10CiphertextChunksProofMaterial(req.leaves, req.chunkId, req.expected);
    }
    return buildV10ProofMaterial(req.leaves, req.chunkId, req.expected);
  }

  async close(): Promise<void> {
    // no-op
  }
}
