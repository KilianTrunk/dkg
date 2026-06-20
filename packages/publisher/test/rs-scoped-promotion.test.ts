/**
 * GH #1264 — RS prevention: a confirmed one-shot `publish()` MUST self-promote
 * the KC into the SCOPED context-graph graphs the Random Sampling prover reads
 * (`<NAME>/context/<cgId>/_meta` + `<NAME>/context/<cgId>`).
 *
 * Before the fix `publish()` wrote the KC only to the legacy label graphs and
 * relied on chain-reconcile to promote it to scoped — which never reliably
 * fired for the publisher's OWN KC, so every prover tick reported
 * `kc-not-synced` and no proof landed (#1259 covered only the gossip-receiver
 * strand). This is the deterministic gate the issue asked for: it asserts the
 * scoped graphs are populated in the EXACT shape `extractV10KCFromStore`
 * (`random-sampling/src/ka-extractor.ts`) queries, so the prover can build a
 * proof on its first tick.
 *
 * The publisher package does not depend on `random-sampling`, so this asserts
 * the scoped graphs directly rather than importing the extractor; each
 * assertion is cross-referenced to the extractor query it satisfies. The
 * end-to-end "a core prover actually submits a proof" proof is the devnet
 * `v10-e2e` phase-1 RS gate.
 */
import { describe, it, expect } from 'vitest';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  TypedEventBus,
  generateEd25519Keypair,
  contextGraphMetaUri,
  contextGraphDataUri,
} from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { wrapPublisherForTest, mockSealCtx } from './_helpers/seal.js';
import { mockChainStubACKProvider } from './_helpers/acks.js';

const TEST_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const DKG_ONT = 'http://dkg.io/ontology/';

/**
 * Mock chain that mints the seal signature the publisher's preflight requires
 * and counts `getKAContextGraphId` calls so the test can prove the fix resolves
 * the cgId from chain truth (the exact call the RS prover uses).
 */
class AdapterSigningChain extends MockChainAdapter {
  getKAContextGraphIdCalls = 0;
  constructor(private readonly wallet: ethers.Wallet) {
    super('mock:31337', wallet.address);
    this.seedIdentity(wallet.address, 1n);
    this.minimumRequiredSignatures = 1;
  }
  override async signMessage(
    messageHash: Uint8Array,
  ): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(await this.wallet.signMessage(messageHash));
    return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
  }
  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.wallet.signTypedData(domain, types, value);
  }
  override async getKAContextGraphId(kaId: bigint): Promise<bigint> {
    this.getKAContextGraphIdCalls++;
    return super.getKAContextGraphId(kaId);
  }
}

async function sealForWallet(
  publisher: DKGPublisher,
  wallet: ethers.Wallet,
  chain: AdapterSigningChain,
): Promise<DKGPublisher> {
  return wrapPublisherForTest(publisher, {
    author: wallet,
    ctx: mockSealCtx({
      chainId: await chain.getEvmChainId(),
      kav10Address: await chain.getKnowledgeAssetsLifecycleAddress(),
    }),
    v10ACKProvider: mockChainStubACKProvider(),
  });
}

async function quadsIn(store: OxigraphStore, graph: string): Promise<Quad[]> {
  const res = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
  );
  return res.type === 'quads' ? res.quads : [];
}

describe('GH #1264 — publish() self-promotes a confirmed KC to the scoped graphs (RS prevention)', () => {
  it('lands the KC in the scoped meta + data graphs the RS prover reads', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AdapterSigningChain(wallet);
    const store = new OxigraphStore();
    // Numeric label → the mock binds on-chain cgId == 5. The scoped graphs the
    // prover reads are `did:dkg:context-graph:5/context/5/{_meta,}`.
    const CG = '5';
    const publisher = await sealForWallet(
      new DKGPublisher({
        store,
        chain,
        eventBus: new TypedEventBus(),
        keypair: await generateEd25519Keypair(),
        publisherNodeIdentityId: 1n,
      }),
      wallet,
      chain,
    );

    const root = 'urn:test:rs-entity';
    const result = await publisher.publish({
      contextGraphId: CG,
      quads: [
        {
          subject: root,
          predicate: `${DKG_ONT}name`,
          object: '"RS Test Entity"',
          graph: `did:dkg:context-graph:${CG}`,
        },
        {
          subject: root,
          predicate: `${DKG_ONT}value`,
          object: '"42"',
          graph: `did:dkg:context-graph:${CG}`,
        },
      ],
    });

    expect(result.status).toBe('confirmed');
    expect(result.kaId).toBeGreaterThan(0n);

    // The fix resolves the scoped cgId from CHAIN TRUTH (`getKAContextGraphId`,
    // the same call the prover uses) rather than the laggy local resolver.
    expect(chain.getKAContextGraphIdCalls).toBeGreaterThan(0);

    const scopedMeta = contextGraphMetaUri(CG, '5'); // …/context/5/_meta
    const scopedData = contextGraphDataUri(CG, '5'); // …/context/5

    // ── Scoped META ────────────────────────────────────────────────────────
    // ka-extractor.ts:183-189 — UAL resolved via `?ual dkg:batchId "<kaId>"`.
    const metaQuads = await quadsIn(store, scopedMeta);
    const batchIdQuad = metaQuads.find(
      (q) => q.predicate === `${DKG_ONT}batchId`,
    );
    expect(batchIdQuad, 'scoped _meta missing dkg:batchId').toBeDefined();
    expect(batchIdQuad!.subject).toBe(result.ual);

    // ka-extractor.ts:204-220 — root entities via collapsed `dkg:rootEntity`.
    const rootQuad = metaQuads.find((q) => q.predicate.endsWith('rootEntity'));
    expect(rootQuad, 'scoped _meta missing dkg:rootEntity').toBeDefined();
    expect(rootQuad!.object).toBe(root);

    expect(
      metaQuads.some((q) => q.predicate === `${DKG_ONT}merkleRoot`),
      'scoped _meta missing dkg:merkleRoot',
    ).toBe(true);

    // ── Scoped DATA ────────────────────────────────────────────────────────
    // ka-extractor.ts:260-276 — public triples pulled per root entity.
    const dataQuads = await quadsIn(store, scopedData);
    expect(
      dataQuads.some(
        (q) => q.subject === root && q.predicate === `${DKG_ONT}name`,
      ),
      'scoped data missing the published name triple',
    ).toBe(true);
    expect(
      dataQuads.some(
        (q) => q.subject === root && q.predicate === `${DKG_ONT}value`,
      ),
      'scoped data missing the published value triple',
    ).toBe(true);
  });
});
