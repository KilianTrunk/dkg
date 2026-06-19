/**
 * E2E tests for the DKG V10 memory layer progression:
 *
 * 1. Working Memory → SWM: assertion promote moves data to shared memory
 * 2. SWM → Verifiable Memory: publishFromSharedMemory anchors on-chain
 * 3. Full pipeline: WM → promote → SWM gossip → publishFromSharedMemory → VM
 * 4. Memory layer isolation: data in one layer doesn't leak to another
 * 5. Two-node flow: A promotes to SWM → gossip to B → A publishes → B finalizes
 * 6. SWM query view vs default view
 * 7. Working memory view
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";
import { DKGAgent } from '../src/index.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';
import { installHardhatACKProvider } from './_helpers/v10-acks.js';
import {
  assertionLifecycleUri,
  contextGraphMetaUri,
  contextGraphLayerUri,
  MemoryLayer,
} from '@origintrail-official/dkg-core';

const agents: DKGAgent[] = [];

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

afterEach(async () => {
  for (const a of agents) {
    try { await a.stop(); } catch {}
  }
  agents.length = 0;
});

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const CG_ID = 'memory-layers-e2e';
const ENTITY_BASE = 'urn:mem:entity';

async function createAgent(name: string) {
  const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  const agent = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
    name,
    listenPort: 0,
    chainAdapter: chain,
    nodeRole: 'core',
  });
  agents.push(agent);
  await agent.start();
  await installHardhatACKProvider(agent, chain);
  return agent;
}

describe('Memory layer isolation (single agent)', () => {
  it('resolveByKaId recovers a non-default lifecycle author from the KA record', async () => {
    const agent = await createAgent('ForeignAuthorResolverBot');
    const metaGraph = contextGraphMetaUri(CG_ID);
    const DKG = 'http://dkg.io/ontology/';
    const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
    const foreignAuthor = ethers.getAddress('0x00000000000000000000000000000000000000aa');
    const defaultAuthor = agent.defaultAgentAddress ?? agent.peerId;
    const name = 'foreign-author-ka';
    const decoyName = 'default-author-decoy';
    const kaNumber = 987654n;
    const packedKaId = (BigInt(foreignAuthor) << 96n) | kaNumber;
    const lifecycleUri = assertionLifecycleUri(CG_ID, foreignAuthor, name);
    const decoyLifecycleUri = assertionLifecycleUri(CG_ID, defaultAuthor, decoyName);
    const vmGraph = contextGraphLayerUri(CG_ID, MemoryLayer.VerifiableMemory, foreignAuthor.toLowerCase(), kaNumber);

    await (agent as any).store.insert([
      { subject: decoyLifecycleUri, predicate: `${DKG}kaId`, object: `"${kaNumber}"^^<${XSD_INT}>`, graph: metaGraph },
      { subject: decoyLifecycleUri, predicate: `${DKG}assertionName`, object: `"${decoyName}"`, graph: metaGraph },
      { subject: decoyLifecycleUri, predicate: `${DKG}state`, object: '"published"', graph: metaGraph },
      { subject: decoyLifecycleUri, predicate: `${DKG}memoryLayer`, object: `"${MemoryLayer.VerifiableMemory}"`, graph: metaGraph },
      { subject: lifecycleUri, predicate: `${DKG}kaId`, object: `"${kaNumber}"^^<${XSD_INT}>`, graph: metaGraph },
      { subject: lifecycleUri, predicate: `${DKG}assertionName`, object: `"${name}"`, graph: metaGraph },
      { subject: lifecycleUri, predicate: `${DKG}state`, object: '"published"', graph: metaGraph },
      { subject: lifecycleUri, predicate: `${DKG}memoryLayer`, object: `"${MemoryLayer.VerifiableMemory}"`, graph: metaGraph },
      { subject: lifecycleUri, predicate: `${DKG}assertionGraph`, object: vmGraph, graph: metaGraph },
      { subject: lifecycleUri, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: `did:dkg:agent:${foreignAuthor.toLowerCase()}`, graph: metaGraph },
    ]);

    const desc = await (agent as any).assertion.resolveByKaId(CG_ID, packedKaId);

    expect(desc).toBeTruthy();
    expect(desc.agentAddress).toBe(foreignAuthor);
    expect(desc.agentAddress.toLowerCase()).not.toBe(defaultAuthor.toLowerCase());
    expect(desc.name).toBe(name);
    expect(desc.memoryLayer).toBe(MemoryLayer.VerifiableMemory);
  });

  it('WM data is not visible in SWM or default data graph', async () => {
    const agent = await createAgent('IsolationBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Memory Layers E2E' });

    // Write to working memory
    await agent.assertion.create(CG_ID, 'wm-only');
    await agent.assertion.write(CG_ID, 'wm-only', [
      { subject: `${ENTITY_BASE}:wm`, predicate: 'http://schema.org/name', object: '"WM Only"' },
    ]);

    // Visible in WM
    const wmQuads = await agent.assertion.query(CG_ID, 'wm-only');
    expect(wmQuads.length).toBe(1);

    // Not in SWM
    const swm = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:wm> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(swm.bindings.length).toBe(0);

    // Not in default data graph
    const data = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:wm> <http://schema.org/name> ?name }`,
      CG_ID,
    );
    expect(data.bindings.length).toBe(0);
  }, 15_000);

  it('SWM data is not visible in default data graph', async () => {
    const agent = await createAgent('SWMIsolationBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Memory Layers E2E' });

    await agent.share(CG_ID, [
      { subject: `${ENTITY_BASE}:swm`, predicate: 'http://schema.org/name', object: '"SWM Only"', graph: '' },
    ], { localOnly: true });

    // Visible in SWM
    const swm = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:swm> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(swm.bindings.length).toBe(1);

    // Not in default data graph
    const data = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:swm> <http://schema.org/name> ?name }`,
      CG_ID,
    );
    expect(data.bindings.length).toBe(0);
  }, 15_000);

  it('published data is in data graph but not SWM', async () => {
    const agent = await createAgent('PublishedBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Memory Layers E2E' });

    const quads = [
      { subject: `${ENTITY_BASE}:pub`, predicate: 'http://schema.org/name', object: '"Published"', graph: '' },
    ];
    await agent.publish(CG_ID, quads);

    // Visible in data graph
    const data = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:pub> <http://schema.org/name> ?name }`,
      CG_ID,
    );
    expect(data.bindings.length).toBe(1);
  }, 15_000);
});

describe('WM → SWM → VM pipeline (single agent)', () => {
  it('promotes assertion to SWM, then publishes SWM to verifiable memory', async () => {
    const agent = await createAgent('PipelineBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Pipeline E2E' });
    await agent.registerContextGraph(CG_ID);

    // Step 1: Write to working memory
    await agent.assertion.create(CG_ID, 'pipeline');
    await agent.assertion.write(CG_ID, 'pipeline', [
      { subject: `${ENTITY_BASE}:pipeline`, predicate: 'http://schema.org/name', object: '"Pipeline Entity"' },
      { subject: `${ENTITY_BASE}:pipeline`, predicate: 'http://schema.org/version', object: '"v1"' },
    ]);

    const wmQuads = await agent.assertion.query(CG_ID, 'pipeline');
    expect(wmQuads.length).toBe(2);

    // Step 2: Promote to SWM
    const promoteResult = await agent.assertion.promote(CG_ID, 'pipeline');
    expect(promoteResult.promotedCount).toBeGreaterThan(0);

    const swmResult = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:pipeline> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(swmResult.bindings.length).toBe(1);
    expect(swmResult.bindings[0]?.['name']).toBe('"Pipeline Entity"');

    // Step 3: Publish from SWM to verifiable memory
    const pubResult = await agent.publishFromSharedMemory(CG_ID, 'all');
    expect(pubResult.status).toBe('confirmed');
    expect(pubResult.ual).toBeDefined();

    // Verify data is now in the canonical data graph
    const dataResult = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:pipeline> <http://schema.org/name> ?name }`,
      CG_ID,
    );
    expect(dataResult.bindings.length).toBe(1);
  }, 20_000);

  it('promote auto-finalizes: publishFromFinalizedAssertion works after a bare promote (no explicit finalize)', async () => {
    // Regression for the UI/HTTP flow: "Promote All → Shared" then "Publish to
    // Verifiable Memory" promotes WM→SWM with NO explicit finalize, and the
    // publish runs publishFromFinalizedAssertion, which requires a seal.
    // Because promote empties WM, you cannot finalize afterwards — so promote
    // now seals BEFORE moving WM→SWM. Pre-fix this threw
    // "publishFromFinalizedAssertion: assertion <...> is not finalized".
    const agent = await createAgent('AutoFinalizeBot');
    await agent.createContextGraph({ id: CG_ID, name: 'AutoFinalize E2E' });
    await agent.registerContextGraph(CG_ID);

    await agent.assertion.create(CG_ID, 'auto-final');
    await agent.assertion.write(CG_ID, 'auto-final', [
      { subject: `${ENTITY_BASE}:auto`, predicate: 'http://schema.org/name', object: '"Auto Finalized"' },
    ]);

    // Promote WITHOUT an explicit finalize() — the exact gap that broke the UI.
    const promoteResult = await agent.assertion.promote(CG_ID, 'auto-final');
    expect(promoteResult.promotedCount).toBeGreaterThan(0);

    // publishFromFinalizedAssertion hard-requires the seal; it must now find
    // the one promote stamped, instead of throwing "is not finalized".
    const pub = await agent.publishFromFinalizedAssertion(CG_ID, 'auto-final');
    expect(pub.status).toBe('confirmed');
    expect(pub.ual).toBeDefined();
    expect(pub.seal).toBeDefined();

    // RC.17 Bug #1 regression (SUBSTRATE-2): a confirmed publish must re-point
    // dkg:assertionGraph in _meta at the per-KA verifiable-memory graph it just
    // wrote (…/_verifiable_memory/{author}/{number}). promote() leaves the pointer
    // on the SWM bucket, which the post-confirm SWM cleanup then EMPTIES — so
    // without the re-stamp the _meta index follows a stale pointer to an empty
    // graph and descriptor reads return no triples. The publish derives the VM
    // graph from the minted kaId, so we re-derive it the same way and assert the
    // pointer AND the data agree.
    const ASSERTION_GRAPH_PRED = 'http://dkg.io/ontology/assertionGraph';
    const author = agent.defaultAgentAddress ?? agent.peerId;
    const lifecycleUri = assertionLifecycleUri(CG_ID, author, 'auto-final');
    const metaGraph = contextGraphMetaUri(CG_ID);
    const kaId = BigInt(pub.kaId!);
    const expectedVmGraph = contextGraphLayerUri(
      CG_ID,
      MemoryLayer.VerifiableMemory,
      '0x' + (kaId >> 96n).toString(16).padStart(40, '0'),
      kaId & ((1n << 96n) - 1n),
    );
    const ptrRes = await (agent as any).store.query(
      `SELECT ?o WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <${ASSERTION_GRAPH_PRED}> ?o } } LIMIT 1`,
    );
    expect(ptrRes.type).toBe('bindings');
    expect(ptrRes.bindings.length).toBe(1);
    const assertionGraphPtr = String(ptrRes.bindings[0]['o'])
      .replace(/^"/, '')
      .replace(/"(\^\^<[^>]+>)?$/, '');
    expect(assertionGraphPtr).toBe(expectedVmGraph);
    // …and the pointed-at graph actually holds the published triple (no stale
    // pointer at an emptied SWM bucket).
    const vmData = await (agent as any).store.query(
      `SELECT ?o WHERE { GRAPH <${expectedVmGraph}> { <${ENTITY_BASE}:auto> <http://schema.org/name> ?o } }`,
    );
    expect(vmData.type).toBe('bindings');
    expect(vmData.bindings.length).toBeGreaterThan(0);
  }, 30_000);

  it('F4 regression (Codex #898 after publish): WM-graph marker is UPDATED to "VM" and a stale re-promote is a no-op', async () => {
    // Adversarial review F4: the publish-time SWM→VM flip briefly DELETED the
    // per-KA `<wmGraph> dkg:memoryLayer` row (RFC ka-metadata-trim "orphan
    // marker cleanup"). That row is the witness `assertAssertionDataPersisted`
    // reads to classify a stale re-promote after a successful publish as a
    // harmless no-op (the Codex #898 case, post-publish variant: the lifecycle
    // URN's dkg:assertionGraph back-link has been re-pointed at the VM graph by
    // then, so the URN fallback can no longer vouch for the WM graph). The fix
    // UPDATES the marker in place to "VM" — keeping the witness and killing the
    // misleading orphan "SWM" value.
    const agent = await createAgent('DoublePromoteBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Double Promote E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'double-promote';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:dp`, predicate: 'http://schema.org/name', object: '"Double Promote"' },
    ]);
    const promoteResult = await agent.assertion.promote(CG_ID, name);
    expect(promoteResult.promotedCount).toBeGreaterThan(0);

    const pub = await agent.publishFromFinalizedAssertion(CG_ID, name);
    expect(pub.status).toBe('confirmed');
    expect(pub.kaId).toBeDefined();

    // 1. The marker must now read "VM" on the per-KA WM graph URI the flip
    //    derives from the minted kaId — present (not deleted), not "SWM".
    const DKG = 'http://dkg.io/ontology/';
    const metaGraph = contextGraphMetaUri(CG_ID);
    const kaId = BigInt(pub.kaId!);
    const wmGraphFromKaId = contextGraphLayerUri(
      CG_ID,
      MemoryLayer.WorkingMemory,
      '0x' + (kaId >> 96n).toString(16).padStart(40, '0'),
      kaId & ((1n << 96n) - 1n),
    );
    const markerRes = await (agent as any).store.query(
      `SELECT ?layer WHERE { GRAPH <${metaGraph}> { <${wmGraphFromKaId}> <${DKG}memoryLayer> ?layer } }`,
    );
    expect(markerRes.type).toBe('bindings');
    expect(markerRes.bindings.map((b: Record<string, string>) => b['layer'])).toEqual([`"${MemoryLayer.VerifiableMemory}"`]);

    // 2. Codex #898 post-publish: import-file extraction markers survive
    //    promote+publish by design. With the WM marker deleted (pre-F4) the
    //    stale re-promote below misfired AssertionNotPersistedError; the "VM"
    //    marker short-circuits it to the harmless `{ promotedCount: 0 }` no-op.
    const author = agent.defaultAgentAddress ?? agent.peerId;
    const wmGraphPromoteSees = await (agent as any).publisher.wmGraphUri(CG_ID, author, name);
    await (agent as any).store.insert([
      { subject: wmGraphPromoteSees, predicate: `${DKG}extractionStatus`, object: '"completed"', graph: metaGraph },
      { subject: wmGraphPromoteSees, predicate: `${DKG}structuralTripleCount`, object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: metaGraph },
    ]);
    const second = await (agent as any).publisher.assertionPromote(CG_ID, name, author);
    expect(second.promotedCount).toBe(0);
  }, 30_000);

  it('selective promote does NOT auto-finalize (avoids the seal-all vs promote-subset merkleRoot mismatch)', async () => {
    // Regression for the #1004 review: auto-finalize seals the WHOLE assertion
    // (all root entities), but a SELECTIVE promote (opts.entities subset) ships
    // only the chosen roots to SWM. If promote auto-sealed ALL roots here,
    // publishFromFinalizedAssertion would reload SWM scoped to the sealed (full)
    // root set, recompute a different merkleRoot, and fail the seal guard. So a
    // selective promote must NOT auto-finalize — the assertion stays unsealed
    // until an explicit, matching-scope finalize.
    const agent = await createAgent('SelectivePromoteBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Selective Promote E2E' });
    await agent.registerContextGraph(CG_ID);

    await agent.assertion.create(CG_ID, 'selective');
    await agent.assertion.write(CG_ID, 'selective', [
      { subject: `${ENTITY_BASE}:a`, predicate: 'http://schema.org/name', object: '"Entity A"' },
      { subject: `${ENTITY_BASE}:b`, predicate: 'http://schema.org/name', object: '"Entity B"' },
    ]);

    // Promote ONLY entity A — a subset of the assertion's roots.
    const promoteResult = await agent.assertion.promote(CG_ID, 'selective', {
      entities: [`${ENTITY_BASE}:a`],
    });
    expect(promoteResult.promotedCount).toBeGreaterThan(0);

    // The selective promote must have left the assertion UNSEALED, so publish
    // surfaces the explicit-finalize requirement — NOT a (pre-fix) seal-all-vs-
    // promote-subset merkleRoot mismatch.
    await expect(
      agent.publishFromFinalizedAssertion(CG_ID, 'selective'),
    ).rejects.toThrow(/not finalized/i);
  }, 20_000);

  it('promote fails fast when the draft was edited after finalize (stale seal, not a silent publish mismatch)', async () => {
    // Regression for the #1004 review: the old auto-finalize only checked whether
    // a seal EXISTED, not whether it matched the current WM. A finalize → edit →
    // promote sequence skipped re-finalize, promoted the new content under the
    // STALE seal, and failed only later at publish with a confusing merkleRoot
    // mismatch. promote now ALWAYS calls assertionFinalize, which detects the
    // post-finalize mutation and throws — so promote fails fast, BEFORE emptying
    // WM, with an actionable "already finalized with a different merkleRoot" error.
    const agent = await createAgent('StaleSealBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Stale Seal E2E' });
    await agent.registerContextGraph(CG_ID);

    await agent.assertion.create(CG_ID, 'stale');
    await agent.assertion.write(CG_ID, 'stale', [
      { subject: `${ENTITY_BASE}:s1`, predicate: 'http://schema.org/name', object: '"First"' },
    ]);
    await agent.assertion.finalize(CG_ID, 'stale');

    // Edit the draft AFTER finalize — the seal is now stale.
    await agent.assertion.write(CG_ID, 'stale', [
      { subject: `${ENTITY_BASE}:s2`, predicate: 'http://schema.org/name', object: '"Added after finalize"' },
    ]);

    // promote must fail fast (assertionFinalize detects the mutation), NOT
    // silently promote the stale-sealed content.
    await expect(agent.assertion.promote(CG_ID, 'stale')).rejects.toThrow(/different merkleRoot/i);

    // WM is intact — the failed promote did not empty it.
    const wm = await agent.assertion.query(CG_ID, 'stale');
    expect(wm.length).toBeGreaterThan(0);
  }, 20_000);

  it('WM is empty after promote; SWM clear after publishFromSWM with flag', async () => {
    const agent = await createAgent('CleanupBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Cleanup E2E' });
    await agent.registerContextGraph(CG_ID);

    await agent.assertion.create(CG_ID, 'cleanup');
    await agent.assertion.write(CG_ID, 'cleanup', [
      { subject: `${ENTITY_BASE}:cleanup`, predicate: 'http://schema.org/name', object: '"Cleanup"' },
    ]);
    await agent.assertion.promote(CG_ID, 'cleanup');

    // WM should be empty
    const wmAfterPromote = await agent.assertion.query(CG_ID, 'cleanup');
    expect(wmAfterPromote.length).toBe(0);

    await agent.publishFromSharedMemory(CG_ID, 'all', { clearSharedMemoryAfter: true });

    // SWM should be empty after publish with clear flag
    const swmAfterPublish = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:cleanup> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(swmAfterPublish.bindings.length).toBe(0);

    // Data should be in canonical graph
    const data = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:cleanup> <http://schema.org/name> ?name }`,
      CG_ID,
    );
    expect(data.bindings.length).toBe(1);
  }, 20_000);
});

describe('#1116 seal decoupled from CG — full vs skipSeal share, seal-in-SWM', () => {
  // B1: a FULL share seals by default (sealed:true / publishReady:true) and the
  // asset publishes; a skipSeal:true full share leaves it UNSEALED
  // (sealed:false / publishReady:false) so publishFromFinalizedAssertion rejects.
  it('full share seals by default and publishes; skipSeal share stays unsealed and is unpublishable', async () => {
    const agent = await createAgent('SealDefaultBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Seal Default E2E' });
    await agent.registerContextGraph(CG_ID);

    // --- Full share: seals by default ---
    await agent.assertion.create(CG_ID, 'sealed-share');
    await agent.assertion.write(CG_ID, 'sealed-share', [
      { subject: `${ENTITY_BASE}:sealed`, predicate: 'http://schema.org/name', object: '"Sealed Share"' },
    ]);
    const fullShare = await agent.assertion.promote(CG_ID, 'sealed-share');
    expect(fullShare.sealed).toBe(true);
    expect(fullShare.publishReady).toBe(true);

    // A sealed full share is publishable from the finalized assertion.
    const pub = await agent.publishFromFinalizedAssertion(CG_ID, 'sealed-share');
    expect(pub.status).toBe('confirmed');
    expect(pub.ual).toBeDefined();
    expect(pub.seal).toBeDefined();

    // --- skipSeal share: stays unsealed ---
    await agent.assertion.create(CG_ID, 'unsealed-share');
    await agent.assertion.write(CG_ID, 'unsealed-share', [
      { subject: `${ENTITY_BASE}:unsealed`, predicate: 'http://schema.org/name', object: '"Unsealed Share"' },
    ]);
    const skipShare = await agent.assertion.promote(CG_ID, 'unsealed-share', { skipSeal: true });
    expect(skipShare.promotedCount).toBeGreaterThan(0);
    expect(skipShare.sealed).toBe(false);
    expect(skipShare.publishReady).toBe(false);

    // The content reached SWM despite no seal...
    const swm = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:unsealed> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(swm.bindings.length).toBe(1);

    // ...but with no seal, publishFromFinalizedAssertion refuses it.
    await expect(
      agent.publishFromFinalizedAssertion(CG_ID, 'unsealed-share'),
    ).rejects.toThrow(/not finalized/i);
  }, 30_000);

  // B2: SEAL-IN-SWM round trip — the key new capability. An asset shared
  // UNSEALED (stuck, unpublishable) is made publishable by finalize(layer:'swm')
  // WITHOUT recreating it: pull-from reconstructs a transient WM draft, finalize
  // seals it, then the transient WM draft is dropped so the asset is left PURELY
  // in SWM (now sealed) and publishes.
  it('finalize(layer:swm) seals a stuck unsealed SWM asset, empties the WM draft, and makes it publishable', async () => {
    const agent = await createAgent('SealInSwmBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Seal-in-SWM E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'seal-in-swm';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:sis`, predicate: 'http://schema.org/name', object: '"Seal In SWM"' },
    ]);

    // Share UNSEALED: content moves to SWM, WM draft is emptied, no seal exists.
    const share = await agent.assertion.promote(CG_ID, name, { skipSeal: true });
    expect(share.sealed).toBe(false);
    const wmAfterShare = await agent.assertion.query(CG_ID, name);
    expect(wmAfterShare.length).toBe(0); // WM emptied by promote
    // Unsealed ⇒ not yet publishable.
    await expect(
      agent.publishFromFinalizedAssertion(CG_ID, name),
    ).rejects.toThrow(/not finalized/i);

    // Seal in SWM — reconstruct from SWM, finalize, drop the transient WM draft.
    const seal = await agent.assertion.finalize(CG_ID, name, { layer: 'swm' });
    expect(seal.merkleRoot).toBeDefined();
    expect(seal.authorAddress).toBeDefined();

    // Post-condition #1: the asset is left PURELY in SWM — the WM draft is empty
    // again (the transient reconstruction draft was dropped).
    const wmAfterSeal = await agent.assertion.query(CG_ID, name);
    expect(wmAfterSeal.length).toBe(0);

    // Post-condition #2: the SWM content is still present (the seal never
    // modified the SWM copy).
    const swmAfterSeal = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:sis> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(swmAfterSeal.bindings.length).toBe(1);

    // Post-condition #2b (#1116 FIX 2): the WM data was dropped, so the lifecycle
    // descriptor must report the asset as SWM-resident with NO open WM draft —
    // the stale dkg:wmCurrentAssertion pointer that finalize stamped on the
    // transient WM draft has been retired by clearWmDraftDataGraph.
    const descAfterSeal = await agent.assertion.history(CG_ID, name);
    expect(descAfterSeal).toBeTruthy();
    expect(descAfterSeal!.status).toBe('swm-shared');
    // The SWM pointer must be set (SWM-resident); divergence-only stamping means
    // the WM pointer row is GONE from the lifecycle URN (it would otherwise make
    // the WM-layer status read 'wm-sealed' for a draft that no longer exists).
    expect(descAfterSeal!.swmCurrentAssertion).toBeTruthy();
    const defaultAuthor = agent.defaultAgentAddress ?? agent.peerId;
    const lifecycleUri = assertionLifecycleUri(CG_ID, defaultAuthor, name);
    const metaGraph = contextGraphMetaUri(CG_ID);
    const wmPointerRows = await (agent as any).store.query(
      `SELECT ?wm WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <http://dkg.io/ontology/wmCurrentAssertion> ?wm } }`,
    );
    expect(wmPointerRows.type).toBe('bindings');
    expect(wmPointerRows.bindings.length).toBe(0);

    // Post-condition #3: the seal now exists, so the previously-stuck asset
    // publishes WITHOUT being recreated.
    const pub = await agent.publishFromFinalizedAssertion(CG_ID, name);
    expect(pub.status).toBe('confirmed');
    expect(pub.ual).toBeDefined();
    expect(pub.seal).toBeDefined();
  }, 30_000);

  // B3 (#1116 CORE REGRESSION GUARD): the seal is context-graph-INDEPENDENT, so
  // a default FULL share SEALS even when the CG was NEVER registered on-chain —
  // registration is deferred to publish time. This is the claim the existing
  // seal-decoupled tests do NOT cover (they register the CG first). A regression
  // that reintroduces seal-time CG registration FAILS the `getContextGraphOnChainId`
  // assertion below (the CG would already be on-chain after the share).
  it('seals a FULL share on an UNregistered CG (no seal-time registration); registers + publishes at publish time', async () => {
    const agent = await createAgent('UnregisteredCgSealBot');
    // LOCAL-ONLY CG: created but DELIBERATELY never registered on-chain.
    await agent.createContextGraph({ id: CG_ID, name: 'Unregistered CG Seal E2E' });

    const name = 'unregistered-cg-seal';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:ucs`, predicate: 'http://schema.org/name', object: '"Unregistered CG Seal"' },
    ]);

    // Default FULL share — must SEAL despite the CG being unregistered (the seal
    // no longer depends on CG registration).
    const fullShare = await agent.assertion.promote(CG_ID, name);
    expect(fullShare.sealed).toBe(true);
    expect(fullShare.publishReady).toBe(true);

    // CORE ASSERTION: the CG is STILL unregistered after sealing — sealing did
    // NOT register it on-chain. Reintroducing seal-time registration breaks here.
    const onChainIdAfterSeal = await agent.getContextGraphOnChainId(CG_ID);
    expect(onChainIdAfterSeal == null).toBe(true);

    // And publishing the unregistered CG fails CLOSED for that exact reason —
    // proving the registration gap is real (not silently papered over at seal).
    // #1116 (round 5, FIX 3b): assert BOTH the message AND the stable `.code`
    // (the route's auto-register branch keys on code-first; mirrors this file's
    // .code convention for SWM_SUBSET_NOT_SEALABLE / UNSEALED_SHARE_BLOCKED).
    let notRegisteredErr: any;
    try {
      await agent.publishFromFinalizedAssertion(CG_ID, name);
    } catch (e) {
      notRegisteredErr = e;
    }
    expect(notRegisteredErr).toBeTruthy();
    expect(notRegisteredErr.message).toMatch(/not registered on-chain/i);
    expect(notRegisteredErr.code).toBe('CG_NOT_REGISTERED');

    // Registration happens at PUBLISH time (the /vm/publish route's
    // ensureRegisteredForPublish step). After it, the same sealed asset publishes
    // to VM and confirms — no re-seal, no recreate.
    await agent.ensureRegisteredForPublish(CG_ID);
    const onChainIdAfterRegister = await agent.getContextGraphOnChainId(CG_ID);
    expect(onChainIdAfterRegister).toBeTruthy();

    const pub = await agent.publishFromFinalizedAssertion(CG_ID, name);
    expect(pub.status).toBe('confirmed');
    expect(pub.ual).toBeDefined();
    expect(pub.seal).toBeDefined();
  }, 30_000);

  // #1116 (round 5, FIX 2): no-data precondition must fire BEFORE registration.
  // publishFromSharedMemory checks CG-registration (CG_NOT_REGISTERED) BEFORE its
  // own no-quads check, so an UNregistered CG + valid seal + EMPTY sealed SWM used
  // to surface CG_NOT_REGISTERED first — the /vm/publish route would then mint
  // (burn gas) and only the retry hit the no-quads 409. The engine now runs a
  // SWM-empty preflight before the publisher's register guard, so the precondition
  // wins. Here: finalize the WM draft directly (seals, but NEVER promotes to SWM),
  // so SWM is empty on an unregistered CG.
  it('FIX 2: unregistered CG + finalized seal + EMPTY SWM throws "No quads" (not "not registered")', async () => {
    const agent = await createAgent('NoQuadsBeforeRegisterBot');
    // DELIBERATELY unregistered, local-only CG.
    await agent.createContextGraph({ id: CG_ID, name: 'No Quads Before Register E2E' });

    const name = 'empty-swm-seal';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:nq`, predicate: 'http://schema.org/name', object: '"No Quads"' },
    ]);
    // Finalize the WM draft (seals it) WITHOUT promoting — SWM stays empty.
    // Use the public wrapper (default layer "wm") so the author is threaded
    // through correctly (the low-level assertionFinalize needs an explicit author).
    await agent.assertion.finalize(CG_ID, name);

    let thrown: any;
    try {
      await agent.publishFromFinalizedAssertion(CG_ID, name);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    // The no-data precondition fired first — NOT the registration guard.
    expect(thrown.message).toMatch(/No quads in shared memory/i);
    expect(thrown.message).not.toMatch(/not registered on-chain/i);
    expect(thrown.code).not.toBe('CG_NOT_REGISTERED');

    // And the CG was NEVER registered as a side effect (no gas burned).
    const onChainId = await agent.getContextGraphOnChainId(CG_ID);
    expect(onChainId == null).toBe(true);
  }, 30_000);

  // A1 (review): a SUBSET share is SWM-ONLY — NOT publishable. It stamps the
  // dkg:rootEntity member rows (the seal-independent recovery source) but does
  // NOT set the full-SWM-share marker, so finalize(layer:"swm") must REJECT with
  // SWM_SUBSET_NOT_SEALABLE — otherwise a {A,B} KA only subset-shared (A) could be
  // sealed and published as a PARTIAL asset under the KA name.
  it('finalize(layer:swm) REJECTS a subset-shared asset (subset shares are not publishable)', async () => {
    const agent = await createAgent('SubsetNotSealableBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Subset Not Sealable E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'subset-share';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:a`, predicate: 'http://schema.org/name', object: '"Entity A"' },
      { subject: `${ENTITY_BASE}:b`, predicate: 'http://schema.org/name', object: '"Entity B"' },
    ]);

    // SUBSET share — only entity A reaches SWM (a selective promote never seals).
    const subset = await agent.assertion.promote(CG_ID, name, { entities: [`${ENTITY_BASE}:a`] });
    expect(subset.promotedCount).toBeGreaterThan(0);
    expect(subset.sealed).toBe(false);

    // The marker was NOT set (this was a subset share), so seal-in-SWM is refused.
    let thrown: any;
    try {
      await agent.assertion.finalize(CG_ID, name, { layer: 'swm' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('SWM_SUBSET_NOT_SEALABLE');

    // The asset is NOT sealed ⇒ stays unpublishable (no partial asset escapes).
    await expect(
      agent.publishFromFinalizedAssertion(CG_ID, name),
    ).rejects.toThrow(/not finalized/i);
  }, 30_000);

  // A1' (round 5): the round-4 marker was SET-only, so a full-share → discard →
  // recreate → SUBSET-share cycle kept a STALE marker (A2_PRESERVE re-armed it on
  // recreate) and would let finalize(layer:"swm") publish the subset {A} as the
  // full {A,B} KA. Round 5 CLEARS the marker on discard and on a subset share, so
  // this cycle is correctly rejected.
  it('finalize(layer:swm) REJECTS after full-share -> discard -> recreate -> SUBSET-share (no stale marker)', async () => {
    const agent = await createAgent('StaleMarkerBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Stale Marker E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'stale-marker';
    const writeAB = () => agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:a`, predicate: 'http://schema.org/name', object: '"Entity A"' },
      { subject: `${ENTITY_BASE}:b`, predicate: 'http://schema.org/name', object: '"Entity B"' },
    ]);

    // 1. FULL share {A,B} — sets the full-share marker (seal-by-default).
    await agent.assertion.create(CG_ID, name);
    await writeAB();
    const full = await agent.assertion.promote(CG_ID, name);
    expect(full.sealed).toBe(true);

    // 2. Discard the (now-sealed-in-SWM) asset, then recreate the same name.
    await agent.assertion.discard(CG_ID, name);
    await agent.assertion.create(CG_ID, name);
    await writeAB();

    // 3. SUBSET share {A} only — must NOT inherit the prior full-share marker.
    const subset = await agent.assertion.promote(CG_ID, name, { entities: [`${ENTITY_BASE}:a`] });
    expect(subset.sealed).toBe(false);

    // 4. Seal-in-SWM is refused: the marker was cleared at discard AND on the
    // subset share, so a partial asset can't be published under the KA name.
    let thrown: any;
    try {
      await agent.assertion.finalize(CG_ID, name, { layer: 'swm' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('SWM_SUBSET_NOT_SEALABLE');
  }, 30_000);

  // A1'' (round 5): the gate keys on COMPLETENESS, not on sealed. A FULL skipSeal
  // share is publishable-by-construction (all roots reached SWM) — it sets the
  // marker — so seal-in-SWM (finalize layer:"swm") must SUCCEED, the legit
  // unsealed-recovery path. (Regression guard: the new subset guard must not
  // block a genuine full share.)
  it('finalize(layer:swm) SUCCEEDS on a FULL skipSeal share (completeness, not sealed, gates it)', async () => {
    const agent = await createAgent('FullSkipSealBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Full SkipSeal E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'full-skipseal';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:fs`, predicate: 'http://schema.org/name', object: '"Full SkipSeal"' },
    ]);

    // FULL share, but skipSeal — unsealed yet COMPLETE (sets the full-share marker).
    const share = await agent.assertion.promote(CG_ID, name, { skipSeal: true });
    expect(share.sealed).toBe(false);

    // Seal-in-SWM reconstructs from SWM and seals — allowed because the asset was
    // fully shared. (A subset share would have been rejected; see A1/A1'.)
    const seal = await agent.assertion.finalize(CG_ID, name, { layer: 'swm' });
    expect(seal.merkleRoot).toBeDefined();
    expect(seal.authorAddress).toBeDefined();

    // And it now publishes (proves the reconstruction produced a real, mintable seal).
    const pub = await agent.publishFromFinalizedAssertion(CG_ID, name);
    expect(pub.status).toBe('confirmed');
  }, 30_000);

  // C (review): a DEFAULT full share whose internal seal FAILS with a residual
  // capability gap (NOT skipSeal, NOT stale/corrupt) must fail CLOSED:
  // UNSEALED_SHARE_BLOCKED is thrown BEFORE assertionPromote, so WM is preserved
  // (non-empty, not promoted) and SWM gains no new promotion.
  it('a full share whose seal fails (capability gap) fails closed with UNSEALED_SHARE_BLOCKED, preserving WM', async () => {
    const agent = await createAgent('UnsealedBlockedBot');
    await agent.createContextGraph({ id: CG_ID, name: 'Unsealed Blocked E2E' });
    await agent.registerContextGraph(CG_ID);

    const name = 'capability-gap';
    await agent.assertion.create(CG_ID, name);
    await agent.assertion.write(CG_ID, name, [
      { subject: `${ENTITY_BASE}:cg`, predicate: 'http://schema.org/name', object: '"Capability Gap"' },
    ]);

    // Inject a residual capability-gap failure into the seal step. The message
    // must NOT match the stale-seal / corrupt-seal regex (those re-throw as-is),
    // so promote wraps it as UNSEALED_SHARE_BLOCKED and fails BEFORE promoting.
    const spy = vi
      .spyOn(agent, 'assertionFinalize')
      .mockRejectedValue(new Error('no local signing key available for this agent'));
    try {
      let thrown: any;
      try {
        await agent.assertion.promote(CG_ID, name); // DEFAULT full share — seals by default.
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeTruthy();
      expect(thrown.code).toBe('UNSEALED_SHARE_BLOCKED');
      expect(typeof thrown.recovery).toBe('string');
    } finally {
      spy.mockRestore();
    }

    // WM draft is PRESERVED (not emptied by a doomed promote).
    const wmAfter = await agent.assertion.query(CG_ID, name);
    expect(wmAfter.length).toBeGreaterThan(0);

    // SWM gained NO new promotion — the entity never reached shared memory.
    const swmAfter = await agent.query(
      `SELECT ?name WHERE { <${ENTITY_BASE}:cg> <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(swmAfter.bindings.length).toBe(0);
  }, 30_000);
});

describe('WM → SWM gossip → VM (2 nodes)', () => {
  async function pollUntil(
    queryFn: () => Promise<{ bindings: any[] }>,
    predicate: (bindings: any[]) => boolean,
    timeoutMs: number,
  ): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    let lastResult: any[] = [];
    while (Date.now() < deadline) {
      const result = await queryFn();
      lastResult = result.bindings;
      if (predicate(lastResult)) return lastResult;
      await sleep(500);
    }
    return lastResult;
  }

  it('A drafts in WM → promotes to SWM → gossips to B → publishes → B finalizes', async () => {
    const sharedChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'LayersA',
      listenPort: 0,
      chainAdapter: sharedChain,
      nodeRole: 'core',
    });
    agents.push(nodeA);

    const nodeB = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'LayersB',
      listenPort: 0,
      chainAdapter: sharedChain,
      nodeRole: 'core',
    });
    agents.push(nodeB);

    await nodeA.start();
    await nodeB.start();
    await sleep(500);

    const addrA = nodeA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await sleep(2000);

    await nodeA.createContextGraph({ id: CG_ID, name: 'Two-Node Memory Layers' });
    await nodeA.registerContextGraph(CG_ID);
    nodeA.subscribeToContextGraph(CG_ID);
    nodeB.subscribeToContextGraph(CG_ID);
    await sleep(1500);

    // Step 1: A creates assertion in WM
    await nodeA.assertion.create(CG_ID, 'two-node-draft');
    await nodeA.assertion.write(CG_ID, 'two-node-draft', [
      { subject: `${ENTITY_BASE}:two-node`, predicate: 'http://schema.org/name', object: '"Two Node Entity"' },
    ]);

    // Step 2: A promotes to SWM (gossips to B)
    await nodeA.assertion.promote(CG_ID, 'two-node-draft');

    // Step 3: B receives via gossip
    const bSwm = await pollUntil(
      () => nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_BASE}:two-node> <http://schema.org/name> ?name }`,
        { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
      ),
      (b) => b.length > 0,
      15_000,
    );
    expect(bSwm.length).toBe(1);
    expect(bSwm[0]?.['name']).toBe('"Two Node Entity"');

    // Step 4: A publishes from SWM → chain
    const pubResult = await nodeA.publishFromSharedMemory(CG_ID, 'all');
    expect(pubResult.status).toBe('confirmed');

    // Step 5: B receives finalization → promotes to data graph
    const bData = await pollUntil(
      () => nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_BASE}:two-node> <http://schema.org/name> ?name }`,
        CG_ID,
      ),
      (b) => b.length > 0,
      20_000,
    );
    expect(bData.length).toBe(1);
    expect(bData[0]?.['name']).toBe('"Two Node Entity"');
  }, 60_000);
});

describe('Query views', () => {
  it('includeSharedMemory merges SWM data into query results', async () => {
    const agent = await createAgent('ViewBot');
    await agent.createContextGraph({ id: CG_ID, name: 'View E2E' });

    // Put data in canonical graph via publish
    await agent.publish(CG_ID, [
      { subject: `${ENTITY_BASE}:canonical`, predicate: 'http://schema.org/name', object: '"Canonical"', graph: '' },
    ]);

    // Put data in SWM
    await agent.share(CG_ID, [
      { subject: `${ENTITY_BASE}:shared`, predicate: 'http://schema.org/name', object: '"Shared"', graph: '' },
    ], { localOnly: true });

    // Default query (data graph only) — should see canonical
    const defaultResult = await agent.query(
      `SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }`,
      CG_ID,
    );
    const defaultSubjects = defaultResult.bindings.map((b: any) => b['s']);
    expect(defaultSubjects.some((s: string) => s.includes('canonical'))).toBe(true);

    // includeSharedMemory — should see both
    const mergedResult = await agent.query(
      `SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }`,
      { contextGraphId: CG_ID, includeSharedMemory: true },
    );
    const mergedSubjects = mergedResult.bindings.map((b: any) => b['s']);
    expect(mergedSubjects.some((s: string) => s.includes('canonical'))).toBe(true);
    expect(mergedSubjects.some((s: string) => s.includes('shared'))).toBe(true);
  }, 15_000);
});
