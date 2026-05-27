/**
 * OT-RFC-39 — load the V10 LU-11 ciphertext chunks for a curated KC
 * from the local triple store, in chunkId order, ready to feed to
 * `buildV10CiphertextChunksProofMaterial` from `@origintrail-official/dkg-core`.
 *
 * Storage shape (mirrors what `dkg-agent.ingestSwmCiphertextChunkEnvelope`
 * persists on receipt of each chunked SWM envelope):
 *
 *   GRAPH <urn:dkg:swm:ciphertext-chunks/<cgIdEncoded>> {
 *     <urn:dkg:swm:v10-publish-ciphertext-chunk/<batchIdHexNoPrefix>/<i>>
 *       <urn:dkg:swm:v10-publish-ciphertext-chunk-bytes>
 *       "<base64(ct_i)>" .
 *   }
 *
 * `batchId` is the 32-byte V10 KC merkleRoot (the publisher uses it as
 * the deterministic AES-GCM nonce salt + as the per-chunk subject
 * suffix). The prover gets it from `chain.getLatestMerkleRoot(kcId)`.
 *
 * Failure modes:
 *  - {@link CiphertextChunksMissingError}: at least one
 *    `[0, expectedCount)` chunk is missing locally. Caller SHOULD
 *    backfill via `PROTOCOL_GET_CIPHERTEXT_CHUNK` (`agent.fetchCiphertextChunkFromPeer`)
 *    and retry on the next sampling tick — same skip-this-period
 *    semantics as `KCDataMissingError` on the public path.
 *  - {@link CiphertextChunksMalformedError}: a chunk entry exists but
 *    the stored value isn't a parseable base64 literal — meta-graph
 *    corruption, refuses to sign a bad proof.
 */

import {
  ciphertextChunkStoreSubject,
  CIPHERTEXT_CHUNK_PREDICATE,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

export interface CiphertextChunksExtractionResult {
  /** Loaded ciphertext chunks in chunkId order. Length === `expectedCount`. */
  chunks: Uint8Array[];
  /** Same `batchId` the caller passed in (echoed for callers that want to log). */
  batchId: Uint8Array;
}

export class CiphertextChunksMissingError extends Error {
  readonly name = 'CiphertextChunksMissingError';
  constructor(
    readonly contextGraphId: bigint,
    readonly kcId: bigint,
    readonly batchIdHex: string,
    readonly missingChunkIndexes: number[],
    readonly expectedCount: number,
  ) {
    super(
      `CG ${contextGraphId} KC ${kcId} (batchId ${batchIdHex.slice(0, 18)}...) ` +
      `missing ${missingChunkIndexes.length}/${expectedCount} ciphertext chunks ` +
      `locally; backfill via PROTOCOL_GET_CIPHERTEXT_CHUNK then retry`,
    );
  }
}

export class CiphertextChunksMalformedError extends Error {
  readonly name = 'CiphertextChunksMalformedError';
  constructor(
    readonly contextGraphId: bigint,
    readonly kcId: bigint,
    readonly chunkIndex: number,
    readonly reason: string,
  ) {
    super(
      `CG ${contextGraphId} KC ${kcId} chunk ${chunkIndex} malformed in store: ${reason}`,
    );
  }
}

export interface ExtractCiphertextChunksInput {
  store: TripleStore;
  contextGraphId: bigint;
  kcId: bigint;
  /** 32-byte V10 KC merkleRoot. Get from `chain.getLatestMerkleRoot(kcId)`. */
  batchId: Uint8Array;
  /** Chain-sourced `ciphertextChunkCount`. */
  expectedCount: number;
}

export async function extractCiphertextChunksFromStore(
  input: ExtractCiphertextChunksInput,
): Promise<CiphertextChunksExtractionResult> {
  if (input.batchId.length !== 32) {
    throw new RangeError(
      `extractCiphertextChunksFromStore: batchId must be 32 bytes (got ${input.batchId.length})`,
    );
  }
  if (!Number.isInteger(input.expectedCount) || input.expectedCount < 0) {
    throw new RangeError(
      `extractCiphertextChunksFromStore: expectedCount must be a non-negative integer (got ${input.expectedCount})`,
    );
  }

  // The persisted chunk Subject URI is
  //   urn:dkg:swm:v10-publish-ciphertext-chunk/<batchIdHex>/<i>
  // which is globally unique (batchId is a 32-byte V10 KC merkleRoot),
  // so we don't need to know the named-graph key to locate a chunk.
  // That matters here because the per-CG named graph is keyed off the
  // *cleartext SWM CG id* the cores see on the chunked gossip envelope
  // (`envelope.contextGraphId`), while the prover only has the
  // numeric on-chain CG id from `_pickWeightedChallenge`. Scanning
  // `GRAPH ?g` decouples lookup from the cleartext/numeric duality so
  // the prover doesn't need a numeric→cleartext reverse map (the
  // chain stores only `getContextGraphNameHash`, not the name itself).
  const chunks: Uint8Array[] = new Array(input.expectedCount);
  const missing: number[] = [];

  for (let i = 0; i < input.expectedCount; i++) {
    const subject = ciphertextChunkStoreSubject(input.batchId, i);
    const result = await input.store.query(
      `SELECT ?o WHERE { GRAPH ?g { <${subject}> <${CIPHERTEXT_CHUNK_PREDICATE}> ?o } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      missing.push(i);
      continue;
    }
    const literal = result.bindings[0]?.['o'];
    if (typeof literal !== 'string') {
      throw new CiphertextChunksMalformedError(
        input.contextGraphId,
        input.kcId,
        i,
        'bound value is not a string',
      );
    }
    const b64 = literal.startsWith('"') && literal.endsWith('"')
      ? literal.slice(1, -1)
      : literal;
    try {
      chunks[i] = Buffer.from(b64, 'base64');
    } catch (err) {
      throw new CiphertextChunksMalformedError(
        input.contextGraphId,
        input.kcId,
        i,
        `base64 decode failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (missing.length > 0) {
    throw new CiphertextChunksMissingError(
      input.contextGraphId,
      input.kcId,
      bytesToHex(input.batchId),
      missing,
      input.expectedCount,
    );
  }

  return { chunks, batchId: input.batchId };
}

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
