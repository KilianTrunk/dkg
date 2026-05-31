/**
 * GH #842 — gossip receiver (`UpdateHandler`) must materialise updated KAs into
 * the per-cgId partition the RS prover reads, EVEN when the `dkg:batchId`
 * resolution edge isn't present yet.
 *
 * Before the fix the receiver resolved the KA's UAL only from the meta store;
 * when that lookup missed (a receiver that hadn't yet materialised the batchId
 * edge) it logged "skipped per-cgId promotion (UAL unresolved)" and the KA
 * stayed permanently `kc-not-synced` for Random Sampling. The fix adds a
 * deterministic canonical-UAL fallback so the promotion always runs.
 *
 * This uses a minimal mock ChainAdapter (no Hardhat) — we only exercise the
 * apply + per-cgId promotion path, not on-chain submission.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  TypedEventBus,
  encodeKAUpdateRequest,
  contextGraphDataUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { UpdateHandler, autoPartition, computeFlatKCRootV10 as computeFlatKCRoot } from '../src/index.js';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const CG_NAME = 'gossip-cg';
const CG_ON_CHAIN_ID = '5';
const KAS_ADDRESS = '0xKnowledgeAssets';
const CHAIN_ID = 'hardhat';
const BATCH_ID = 77n;
const BLOCK = 250;
const TX_INDEX = 1;

function q(s: string, p: string, o: string, g = ''): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function quadsToNQuads(quads: Quad[], graph: string): Uint8Array {
  const str = quads
    .map((qd) => `<${qd.subject}> <${qd.predicate}> ${qd.object.startsWith('"') ? qd.object : `<${qd.object}>`} <${graph}> .`)
    .join('\n');
  return new TextEncoder().encode(str);
}

function makeMockChain(onChainMerkleRoot: Uint8Array): ChainAdapter {
  return {
    chainId: CHAIN_ID,
    async verifyKAUpdate() {
      return { verified: true, onChainMerkleRoot, blockNumber: BLOCK, txIndex: TX_INDEX };
    },
    async getDKGKnowledgeAssetsAddress() {
      return KAS_ADDRESS;
    },
  } as unknown as ChainAdapter;
}

describe('UpdateHandler — GH #842 deterministic-UAL fallback (gossip receiver)', () => {
  let store: OxigraphStore;
  beforeEach(() => {
    store = new OxigraphStore();
  });

  it('promotes an update into the per-cgId partition even when no batchId edge exists yet', async () => {
    const updateTriples = [
      q('urn:upd:r', 'urn:p:type', 'urn:UpdateAction'),
      q('urn:upd:r', 'urn:p:name', '"received"'),
    ];
    const labelGraph = contextGraphDataUri(CG_NAME);
    const computedRoot = computeFlatKCRoot(
      updateTriples.map((t) => ({ ...t, graph: labelGraph })),
      [],
    );

    const chain = makeMockChain(computedRoot);
    const handler = new UpdateHandler(store, chain, new TypedEventBus(), {
      resolveOnChainCgId: async () => CG_ON_CHAIN_ID,
    });

    const msg = encodeKAUpdateRequest({
      contextGraphId: CG_NAME,
      batchId: BATCH_ID,
      nquads: quadsToNQuads(updateTriples, labelGraph),
      manifest: [{ rootEntity: 'urn:upd:r', privateTripleCount: 0 }],
      publisherPeerId: '12D3KooWReceiverTest',
      publisherAddress: '0xPublisher',
      txHash: '0xabc',
      blockNumber: BigInt(BLOCK),
      newMerkleRoot: computedRoot,
      timestampMs: BigInt(Date.now()),
    });

    await handler.handle(msg, '12D3KooWPeer');

    // The deterministic UAL the fallback should have minted.
    const expectedUal = `did:dkg:${CHAIN_ID}/${KAS_ADDRESS.toLowerCase()}/${BATCH_ID}`;
    const perCgIdMeta = contextGraphMetaUri(CG_NAME, CG_ON_CHAIN_ID);
    const perCgIdData = contextGraphDataUri(CG_NAME, CG_ON_CHAIN_ID);

    // 1. The per-cgId meta resolves the KA by batchId under the deterministic UAL.
    const metaRes = await store.query(
      `SELECT ?ual WHERE { GRAPH <${perCgIdMeta}> { ?ual <${DKG}batchId> "${BATCH_ID}"^^<${XSD}integer> } }`,
    );
    expect(metaRes.type).toBe('bindings');
    expect(metaRes.type === 'bindings' && metaRes.bindings.map((b) => b['ual'])).toContain(expectedUal);

    // 2. The per-cgId data graph holds the payload (RS read partition).
    const dataRes = await store.query(
      `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${perCgIdData}> { <urn:upd:r> ?p ?o } }`,
    );
    const count = dataRes.type === 'bindings' ? Number(String(dataRes.bindings[0]['c']).match(/\d+/)?.[0] ?? 0) : 0;
    expect(count).toBe(updateTriples.length);

    // 3. The version guard recorded the update's chain version.
    const verRes = await store.query(
      `SELECT ?v WHERE { GRAPH <${perCgIdMeta}> { <${expectedUal}> <${DKG}materializedVersion> ?v } }`,
    );
    expect(verRes.type === 'bindings' && String(verRes.bindings[0]?.['v'])).toContain(`${BLOCK}:${TX_INDEX}`);
  });
});
