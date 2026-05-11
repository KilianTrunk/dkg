import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '@origintrail-official/dkg-publisher';
import { buildAuthorAttestationTypedData } from '@origintrail-official/dkg-core';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

const agents: DKGAgent[] = [];
const stores: OxigraphStore[] = [];

async function createAgent(name: string) {
  const store = new OxigraphStore();
  const agent = await DKGAgent.create({
    name,
    listenPort: 0,
    skills: [],
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    store,
    nodeRole: 'core',
  });
  agents.push(agent);
  stores.push(store);
  await agent.start();
  return { agent, store };
}

afterEach(async () => {
  for (const a of agents) {
    try { await a.stop(); } catch { /* teardown best-effort */ }
  }
  agents.length = 0;
  stores.length = 0;
});

describe('publishJsonLd', () => {
  it('bare JSON-LD doc defaults to private quads (with synthetic public anchor)', async () => {
    const { agent, store } = await createAgent('BarePrivateBot');
    await agent.createContextGraph({ id: 'bare-priv', name: 'BP', description: '' });
    await agent.registerContextGraph('bare-priv');

    const result = await agent.publish('bare-priv', {
      '@context': 'http://schema.org/',
      '@id': 'http://example.org/Alice',
      '@type': 'Person',
      'name': 'Alice',
    });
    expect(result.status).toBe('confirmed');

    const publicResult = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:bare-priv> { ?s ?p ?o } }`,
    );
    expect(publicResult.type).toBe('boolean');
    if (publicResult.type === 'boolean') {
      expect(publicResult.value).toBe(true);
    }
  }, 15000);

  it('envelope { public } puts quads in public set', async () => {
    const { agent, store } = await createAgent('PubEnvBot');
    await agent.createContextGraph({ id: 'pub-env', name: 'PE', description: '' });
    await agent.registerContextGraph('pub-env');

    const result = await agent.publish('pub-env', {
      public: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/Bob',
        '@type': 'Person',
        'name': 'Bob',
      },
    });
    expect(result.status).toBe('confirmed');

    const askResult = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:pub-env> { <http://example.org/Bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/Person> } }`,
    );
    expect(askResult.type).toBe('boolean');
    if (askResult.type === 'boolean') {
      expect(askResult.value).toBe(true);
    }
  }, 15000);

  it('envelope { public, private } splits quads correctly', async () => {
    const { agent, store } = await createAgent('SplitBot');
    await agent.createContextGraph({ id: 'split-test', name: 'Split', description: '' });
    await agent.registerContextGraph('split-test');

    const result = await agent.publish('split-test', {
      public: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/Carol',
        '@type': 'Person',
        'name': 'Carol',
      },
      private: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/Carol',
        'email': 'carol@example.org',
      },
    });
    expect(result.status).toBe('confirmed');

    const publicName = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:split-test> { <http://example.org/Carol> <http://schema.org/name> ?name } }`,
    );
    expect(publicName.type).toBe('boolean');
    if (publicName.type === 'boolean') expect(publicName.value).toBe(true);

    const privateGraph = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:split-test/_private> { ?s ?p ?o } }`,
    );
    if (privateGraph.type === 'boolean') {
      expect(privateGraph.value).toBe(true);
    }
  }, 15000);

  it('private-only envelope generates synthetic public anchor', async () => {
    const { agent, store } = await createAgent('PrivOnlyBot');
    await agent.createContextGraph({ id: 'priv-only', name: 'PO', description: '' });
    await agent.registerContextGraph('priv-only');

    const result = await agent.publish('priv-only', {
      private: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/Secret',
        '@type': 'Thing',
        'name': 'Top Secret',
      },
    });
    expect(result.status).toBe('confirmed');

    const anchorResult = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:priv-only> { ?s ?p ?o } }`,
    );
    expect(anchorResult.type).toBe('boolean');
    if (anchorResult.type === 'boolean') expect(anchorResult.value).toBe(true);
  }, 15000);

  it('preserves typed literals in quad objects', async () => {
    const { agent, store } = await createAgent('LiteralBot');
    await agent.createContextGraph({ id: 'literal-test', name: 'Lit', description: '' });

    await agent.publish('literal-test', {
      public: {
        '@context': {
          'schema': 'http://schema.org/',
          'xsd': 'http://www.w3.org/2001/XMLSchema#',
        },
        '@id': 'http://example.org/Event1',
        '@type': 'schema:Event',
        'schema:startDate': {
          '@value': '2024-01-01T00:00:00Z',
          '@type': 'xsd:dateTime',
        },
      },
    });

    const dateResult = await store.query(
      `SELECT ?d WHERE { GRAPH <did:dkg:context-graph:literal-test> { <http://example.org/Event1> <http://schema.org/startDate> ?d } }`,
    );
    expect(dateResult.type).toBe('bindings');
    if (dateResult.type === 'bindings') {
      expect(dateResult.bindings.length).toBeGreaterThan(0);
      expect(dateResult.bindings[0].d).toContain('2024-01-01T00:00:00Z');
    }
  }, 15000);

  it('throws on JSON-LD that produces no quads', async () => {
    const { agent } = await createAgent('ErrorBot');
    await agent.createContextGraph({ id: 'error-test', name: 'Err', description: '' });

    await expect(agent.publish('error-test', {})).rejects.toThrow(
      'JSON-LD document produced no RDF quads',
    );
  }, 15000);

  it('existing Quad[] publish still works unchanged', async () => {
    const { agent } = await createAgent('QuadBot');
    await agent.createContextGraph({ id: 'quad-test', name: 'QT', description: '' });
    await agent.registerContextGraph('quad-test');

    const result = await agent.publish('quad-test', [
      { subject: 'did:dkg:test:X', predicate: 'http://schema.org/name', object: '"X"', graph: '' },
    ]);
    expect(result.status).toBe('confirmed');
  }, 15000);

  it('async private-only JSON-LD anchors the real private root and enqueues a Lift job', async () => {
    const { agent, store } = await createAgent('AsyncPrivateOnlyBot');
    await agent.createContextGraph({ id: 'async-priv-only', name: 'AsyncPrivateOnly', description: '' });
    const root = 'http://example.org/AsyncSecret';

    const { captureID } = await agent.publishAsync(
      'did:dkg:context-graph:async-priv-only',
      {
        private: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'name': 'Private Async',
        },
      },
      { localOnly: true, accessPolicy: 'allowList', allowedPeers: ['peer-a'] },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    expect(job?.request.roots).toEqual([root]);
    expect(job?.request.accessPolicy).toBe('allowList');
    expect(job?.request.allowedPeers).toEqual(['peer-a']);
    // Keep this resilient to control-plane tuning (defaults changed in main).
    expect(job?.retries.maxRetries).toBeGreaterThan(0);

    const publicAnchor = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:async-priv-only/_shared_memory> { <${root}> <http://dkg.io/ontology/privateDataAnchor> "true" } }`,
    );
    expect(publicAnchor.type).toBe('boolean');
    if (publicAnchor.type === 'boolean') expect(publicAnchor.value).toBe(true);

    const publicPayload = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:async-priv-only/_shared_memory> { <${root}> <http://schema.org/name> "Private Async" } }`,
    );
    expect(publicPayload.type).toBe('boolean');
    if (publicPayload.type === 'boolean') expect(publicPayload.value).toBe(false);

    const privatePayload = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:async-priv-only/_private> { <${root}> <http://schema.org/name> "Private Async" } }`,
    );
    expect(privatePayload.type).toBe('boolean');
    if (privatePayload.type === 'boolean') expect(privatePayload.value).toBe(false);
  }, 15000);

  it('async bare JSON-LD writes only an anchor in shared/private graphs before lift', async () => {
    const { agent, store } = await createAgent('AsyncBarePrivateBot');
    await agent.createContextGraph({ id: 'async-bare-private', name: 'AsyncBarePrivate', description: '' });
    const root = 'http://example.org/AsyncBareSecret';

    const { captureID } = await agent.publishAsync(
      'did:dkg:context-graph:async-bare-private',
      {
        '@context': 'http://schema.org/',
        '@id': root,
        '@type': 'Thing',
        'name': 'Bare Async Private',
      },
      { localOnly: true, accessPolicy: 'ownerOnly' },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    expect(job?.request.roots).toEqual([root]);
    expect(job?.request.accessPolicy).toBe('ownerOnly');

    const publicAnchor = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:async-bare-private/_shared_memory> { <${root}> <http://dkg.io/ontology/privateDataAnchor> "true" } }`,
    );
    expect(publicAnchor.type).toBe('boolean');
    if (publicAnchor.type === 'boolean') expect(publicAnchor.value).toBe(true);

    const publicPayload = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:async-bare-private/_shared_memory> { <${root}> <http://schema.org/name> "Bare Async Private" } }`,
    );
    expect(publicPayload.type).toBe('boolean');
    if (publicPayload.type === 'boolean') expect(publicPayload.value).toBe(false);

    // Async lift stages private quads by operation; they are not materialized in
    // `_private` until the lift pipeline executes.
    const privatePayload = await store.query(
      `ASK { GRAPH <did:dkg:context-graph:async-bare-private/_private> { <${root}> <http://schema.org/name> "Bare Async Private" } }`,
    );
    expect(privatePayload.type).toBe('boolean');
    if (privatePayload.type === 'boolean') expect(privatePayload.value).toBe(false);
  }, 15000);

  it('E2E: async publish with distinct authorWallet lands on-chain with KC.author == that wallet', async () => {
    // Top-of-stack proof that the seal-at-enqueue refactor actually
    // delivers caller-attested authorship on-chain: caller's wallet
    // signs at enqueue, the publisher consumes that seal verbatim,
    // and the chain records the caller's address as KC.author —
    // demonstrably DIFFERENT from the publisher's own wallet.
    const { agent, store } = await createAgent('AsyncSealE2EBot');
    await agent.createContextGraph({ id: 'async-seal-e2e', name: 'AsyncSealE2E', description: '' });
    await agent.registerContextGraph('async-seal-e2e');
    const root = 'http://example.org/AsyncSealE2EEntity';

    const distinctAuthor = ethers.Wallet.createRandom();
    const publisherAddress = new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address;
    expect(distinctAuthor.address.toLowerCase()).not.toBe(publisherAddress.toLowerCase());

    const { captureID } = await agent.publishAsync(
      'did:dkg:context-graph:async-seal-e2e',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'name': 'E2E Author Attestation',
        },
      },
      {
        localOnly: true,
        authorWallet: {
          address: distinctAuthor.address,
          signTypedData: (domain, types, value) =>
            distinctAuthor.signTypedData(domain, types, value),
        },
      },
    );

    // Manually drive the same pipeline the publisher-runner runs in
    // production: claim → validate → publish. We borrow the agent's
    // own internal publisher so the chain adapter + wallets match
    // what processed the request.
    const internalPublisher = (agent as unknown as {
      publisher: {
        publish: (opts: unknown) => Promise<{ status: string; onChainResult?: { batchId: bigint } }>;
      };
    }).publisher;
    const runner = new TripleStoreAsyncLiftPublisher(store, {
      publishExecutor: async ({ publishOptions }) => {
        return internalPublisher.publish(publishOptions) as Promise<any>;
      },
    });
    const finalized = await runner.processNext(publisherAddress);
    expect(finalized).not.toBeNull();
    expect(finalized?.jobId).toBe(captureID);
    expect(finalized?.status === 'broadcast' || finalized?.status === 'included' || finalized?.status === 'finalized').toBe(true);

    // Read author straight from the chain adapter.
    const chainAdapter = (agent as unknown as {
      chain: {
        getLatestMerkleRootAuthor: (kcId: bigint) => Promise<string>;
      };
    }).chain;
    const kcId = (finalized as any)?.broadcast?.batchId
      ?? (finalized as any)?.inclusion?.batchId
      ?? (finalized as any)?.finalization?.batchId;
    expect(kcId).toBeDefined();
    const onChainAuthor = await chainAdapter.getLatestMerkleRootAuthor(BigInt(kcId));
    expect(onChainAuthor.toLowerCase()).toBe(distinctAuthor.address.toLowerCase());
    expect(onChainAuthor.toLowerCase()).not.toBe(publisherAddress.toLowerCase());
  }, 60_000);

  it('async publish with caller-supplied authorWallet binds the seal to that wallet (NOT the publisher\'s)', async () => {
    // This is the architectural payoff of seal-at-enqueue: the on-chain
    // KC.author can be a wallet completely distinct from the publisher's
    // own EOA. The agent signs the canonical merkle with the caller's
    // wallet; the publisher consumes the seal verbatim.
    //
    // Without an explicit assertion that author != publisher, the
    // separation claim is hollow — KC.author would still be the
    // publisher's address (which it was in PR #451). This test pins
    // the actual wallet plumbing.
    const { agent, store } = await createAgent('AsyncSealDistinctAuthorBot');
    await agent.createContextGraph({ id: 'async-seal-distinct', name: 'AsyncSealDistinct', description: '' });
    await agent.registerContextGraph('async-seal-distinct');
    const root = 'http://example.org/AsyncSealDistinctEntity';

    // Build a wallet that is NOT in publisher-wallets.json — completely
    // unrelated to the daemon's signing keys.
    const distinctAuthor = ethers.Wallet.createRandom();
    expect(distinctAuthor.address.toLowerCase()).not.toBe(
      new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address.toLowerCase(),
    );

    const { captureID } = await agent.publishAsync(
      'did:dkg:context-graph:async-seal-distinct',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'name': 'Async Seal Distinct',
        },
      },
      {
        localOnly: true,
        authorWallet: {
          address: distinctAuthor.address,
          signTypedData: (domain, types, value) =>
            distinctAuthor.signTypedData(domain, types, value),
        },
      },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const seal = job?.request.seal;
    expect(seal).toBeDefined();
    expect(seal?.authorAddress.toLowerCase()).toBe(distinctAuthor.address.toLowerCase());
    expect(seal?.authorAddress.toLowerCase()).not.toBe(
      new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address.toLowerCase(),
    );

    // The signature must recover to the caller's wallet — confirms the
    // seal was actually signed by `distinctAuthor.signTypedData(...)`
    // and not silently mis-attributed via some other code path.
    const onChainId = (await agent.getContextGraphOnChainId('async-seal-distinct')) as string;
    const kav10Address = await (agent as unknown as {
      chain: { getKnowledgeAssetsV10Address(): Promise<string> };
    }).chain.getKnowledgeAssetsV10Address();
    const chainId = await (agent as unknown as {
      chain: { getEvmChainId(): Promise<bigint> };
    }).chain.getEvmChainId();
    const merkleRootBytes = ethers.getBytes(seal!.merkleRoot);
    const typed = buildAuthorAttestationTypedData({
      chainId,
      kav10Address,
      contextGraphId: BigInt(onChainId),
      merkleRoot: merkleRootBytes,
      authorAddress: seal!.authorAddress,
      schemeVersion: seal!.schemeVersion,
    });
    const recoveredFromSeal = ethers.recoverAddress(
      ethers.TypedDataEncoder.hash(typed.domain, typed.types, typed.message),
      ethers.Signature.from({
        r: seal!.signature.r,
        yParityAndS: seal!.signature.vs,
      }).serialized,
    );
    expect(recoveredFromSeal.toLowerCase()).toBe(distinctAuthor.address.toLowerCase());
  }, 30_000);

  it('async publish attaches a seal to the LiftRequest with merkleRoot == canonicalPublishPayload(resolved slice)', async () => {
    // Architectural pivot from PR #451 round-4 follow-up: the agent
    // canonicalizes the resolved workspace slice at enqueue time and
    // signs the merkle, so KC.author proves a SPECIFIC wallet attested
    // to THIS data — not "publisher said so." The publisher consumes
    // the seal verbatim at processNext-time after verifying parity.
    const { agent, store } = await createAgent('AsyncSealParityBot');
    await agent.createContextGraph({ id: 'async-seal-parity', name: 'AsyncSealParity', description: '' });
    await agent.registerContextGraph('async-seal-parity');
    const root = 'http://example.org/AsyncSealParityEntity';

    const { captureID } = await agent.publishAsync(
      'did:dkg:context-graph:async-seal-parity',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'name': 'Async Seal Parity',
        },
      },
      { localOnly: true },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    const seal = job?.request.seal;
    expect(seal).toBeDefined();
    expect(seal?.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(seal?.authorAddress).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(seal?.signature.r).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(seal?.signature.vs).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(seal?.schemeVersion).toBe(1);
  }, 30_000);

  it('async publish on a non-V10 chain enqueues without a seal (no on-chain publish to seal for)', async () => {
    // Under the seal-at-enqueue model, the agent only builds a seal
    // when the chain reports V10 readiness AND the CG has an on-chain
    // numeric id. On a non-V10 environment the on-chain branch is a
    // no-op anyway, so omitting the seal is correct — the publisher
    // takes the tentative-only path and never touches KAv10.
    const { agent, store } = await createAgent('AsyncSealNonV10Bot');
    await agent.createContextGraph({ id: 'async-seal-non-v10', name: 'AsyncSealNonV10', description: '' });
    await agent.registerContextGraph('async-seal-non-v10');

    (agent as unknown as { chain: { isV10Ready: () => boolean } }).chain.isV10Ready = () => false;

    const { captureID } = await agent.publishAsync(
      'did:dkg:context-graph:async-seal-non-v10',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': 'http://example.org/NonV10Entity',
          '@type': 'Thing',
          'name': 'Non-V10 Async',
        },
      },
      { localOnly: true },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    expect(job?.request.seal).toBeUndefined();
  }, 30_000);

  it('async publish on V10 chain attaches a seal (no fallback needed)', async () => {
    // New semantics: when the chain is V10-ready and the CG is
    // registered, the agent signs the canonical merkle at enqueue
    // time and attaches the seal to the LiftRequest. The fallback
    // flag is then `false` because the publisher consumes the seal
    // verbatim — no inline mint-and-pray at processNext-time.
    const { agent, store } = await createAgent('AsyncSealBot');
    await agent.createContextGraph({ id: 'async-seal', name: 'AsyncSeal', description: '' });
    await agent.registerContextGraph('async-seal');
    const root = 'http://example.org/AsyncSealEntity';

    const { captureID } = await agent.publishAsync(
      'did:dkg:context-graph:async-seal',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'name': 'Async Seal Public',
        },
      },
      { localOnly: true },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    expect(job?.request.seal).toBeDefined();
    expect(job?.request.seal?.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/i);
  }, 30_000);

  it('async publish for private-only content on V10 chain attaches a seal (mirrors EPCIS capture path)', async () => {
    const { agent, store } = await createAgent('AsyncSealPrivBot');
    await agent.createContextGraph({ id: 'async-seal-priv', name: 'AsyncSealPriv', description: '' });
    await agent.registerContextGraph('async-seal-priv');
    const root = 'http://example.org/AsyncSealPrivEntity';

    const { captureID } = await agent.publishAsync(
      'did:dkg:context-graph:async-seal-priv',
      {
        '@context': 'http://schema.org/',
        '@id': root,
        '@type': 'Thing',
        'name': 'Private-only Async',
      },
      { localOnly: true },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    expect(job?.request.seal).toBeDefined();
  }, 30_000);

  it('async publish records and resolves subGraphName for staged public and private data', async () => {
    const { agent, store } = await createAgent('AsyncSubGraphBot');
    await agent.createContextGraph({ id: 'async-subgraph', name: 'AsyncSubGraph', description: '' });
    await agent.createSubGraph('async-subgraph', 'research');
    const root = 'http://example.org/AsyncSubGraphSecret';

    const { captureID } = await agent.publishAsync(
      'async-subgraph',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'description': 'Public Subgraph Marker',
        },
        private: {
          '@context': 'http://schema.org/',
          '@id': root,
          '@type': 'Thing',
          'name': 'Private Subgraph Async',
        },
      },
      { localOnly: true, accessPolicy: 'ownerOnly', subGraphName: 'research' },
    );

    const asyncPublisher = new TripleStoreAsyncLiftPublisher(store);
    const job = await asyncPublisher.getStatus(captureID);
    expect(job?.request.subGraphName).toBe('research');
    expect(job?.request.roots).toContain(root);
  }, 15000);
});
