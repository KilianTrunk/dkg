import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TypedEventBus,
  generateEd25519Keypair,
  buildAssertionSealQuads,
  contextGraphMetaUri,
  contextGraphAssertionUri,
  assertionLifecycleUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/index.js';

// OT-RFC-43 §10.5.3 — `wm/pull-from` seeds a fresh WM draft from the file's
// current SWM/VM state. These are store-backed (real OxigraphStore) so the
// entity-scoped gather + onConflict behavior is exercised end to end.

const CG = 'pull-from-test';
const AGENT = '0x00000000000000000000000000000000000000a1';
const NAME = 'meeting-notes';
const SWM_GRAPH = `did:dkg:context-graph:${CG}/_shared_memory`;
const SCHEMA = 'http://schema.org/name';
const DKG = 'http://dkg.io/ontology/';

const ENTITY_1 = 'urn:e:alice';
const ENTITY_2 = 'urn:e:bob';
const SKOLEM_1 = `${ENTITY_1}/.well-known/genid/n1`;
const OTHER_FILE_ENTITY = 'urn:e:carol-other-file';

async function makePublisher() {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  return { publisher, store };
}

function q(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

/**
 * Seal: build a REAL assertion seal under the assertion-graph URI
 * (`contextGraphAssertionUri`) in `_meta`, exactly as `finalize` does — this is
 * where `assertionPullFrom` reads it via `parseAssertionSealQuads`
 * (PR #972/335e8d8). The previous helper wrote a bare `assertionRootEntity` on
 * the lifecycle URN, which only matched the old (buggy) read.
 */
function sealEntities(entities: string[]): Quad[] {
  return buildAssertionSealQuads({
    assertionUri: contextGraphAssertionUri(CG, AGENT, NAME),
    metaGraph: contextGraphMetaUri(CG),
    merkleRoot: new Uint8Array(32).fill(7),
    authorAddress: AGENT,
    authorAttestationR: new Uint8Array(32).fill(1),
    authorAttestationVS: new Uint8Array(32).fill(2),
    authorSchemeVersion: 1,
    chainId: 31337n,
    kav10Address: AGENT,
    // §F2 — the seal now carries the packed reservedKaId
    // (uint160(author) << 96 | number). This test only consumes the seal's
    // rootEntities for scoping, so number=1 is sufficient. AGENT is already a
    // 20-byte hex literal, so BigInt() packs it without ethers.
    reservedKaId: (BigInt(AGENT) << 96n) | 1n,
    finalizedAtIso: '2026-01-01T00:00:00.000Z',
    rootEntities: entities,
  }) as Quad[];
}

async function wmQuads(store: OxigraphStore): Promise<Quad[]> {
  const wm = contextGraphAssertionUri(CG, AGENT, NAME);
  const r = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${wm}> { ?s ?p ?o } }`);
  return r.type === 'quads' ? r.quads : [];
}

describe('assertionPullFrom (OT-RFC-43 §10.5.3 wm/pull-from)', () => {
  it('seeds a WM draft from SWM, scoped to the file\'s sealed entities (+ skolem children)', async () => {
    const { publisher, store } = await makePublisher();
    await store.insert([
      // this file's entities in SWM
      q(ENTITY_1, SCHEMA, '"Alice"', SWM_GRAPH),
      q(SKOLEM_1, SCHEMA, '"Alice detail"', SWM_GRAPH),
      q(ENTITY_2, SCHEMA, '"Bob"', SWM_GRAPH),
      // trust/ownership bookkeeping that must NOT land in the draft
      q(ENTITY_1, `${DKG}workspaceOwner`, '"peer-a"', SWM_GRAPH),
      // a DIFFERENT file's entity co-resident in the same SWM graph
      q(OTHER_FILE_ENTITY, SCHEMA, '"Carol"', SWM_GRAPH),
      ...sealEntities([ENTITY_1, ENTITY_2]),
    ]);

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
    expect(result.fromLayer).toBe('swm');
    expect(result.entities).toBe(2);

    const draft = await wmQuads(store);
    const subjects = new Set(draft.map((d) => d.subject));
    // the file's entities + skolem child are present...
    expect(subjects.has(ENTITY_1)).toBe(true);
    expect(subjects.has(SKOLEM_1)).toBe(true);
    expect(subjects.has(ENTITY_2)).toBe(true);
    // ...the co-resident other-file entity is NOT pulled in...
    expect(subjects.has(OTHER_FILE_ENTITY)).toBe(false);
    // ...and the workspaceOwner bookkeeping is filtered out.
    expect(draft.some((d) => d.predicate === `${DKG}workspaceOwner`)).toBe(false);
  });

  it('rejects with WM_DRAFT_CONFLICT when a draft already exists (default onConflict)', async () => {
    const { publisher, store } = await makePublisher();
    await store.insert([q(ENTITY_1, SCHEMA, '"Alice"', SWM_GRAPH), ...sealEntities([ENTITY_1])]);
    // open + dirty a WM draft
    await publisher.assertionWrite(CG, NAME, AGENT, [{ subject: ENTITY_1, predicate: SCHEMA, object: '"local edit"' }]);

    const err = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe('WM_DRAFT_CONFLICT');
  });

  it('onConflict:"replace" overwrites a dirty draft with the source layer', async () => {
    const { publisher, store } = await makePublisher();
    await store.insert([q(ENTITY_2, SCHEMA, '"Bob from SWM"', SWM_GRAPH), ...sealEntities([ENTITY_2])]);
    await publisher.assertionWrite(CG, NAME, AGENT, [{ subject: ENTITY_1, predicate: SCHEMA, object: '"stale local"' }]);

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' });
    expect(result.fromLayer).toBe('swm');

    const draft = await wmQuads(store);
    const subjects = new Set(draft.map((d) => d.subject));
    expect(subjects.has(ENTITY_2)).toBe(true);   // the SWM content
    expect(subjects.has(ENTITY_1)).toBe(false);  // the stale local edit is gone
  });

  it('validates the source BEFORE dropping — an empty-source replace pull preserves the dirty draft (PR #972/335e8d8)', async () => {
    const { publisher, store } = await makePublisher();
    // Finalized file whose sealed entity has NO quads in SWM (e.g. never shared
    // there), plus a dirty WM draft holding a precious local edit.
    await store.insert([...sealEntities([ENTITY_1])]); // note: no ENTITY_1 quads in SWM_GRAPH
    await publisher.assertionWrite(CG, NAME, AGENT, [{ subject: ENTITY_1, predicate: SCHEMA, object: '"precious local edit"' }]);

    const err = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe('PULL_FROM_EMPTY_SOURCE');

    // The draft must be UNTOUCHED — the empty pull validated the source before
    // any drop, so the precious local edit survives.
    const draft = await wmQuads(store);
    expect(draft.some((d) => d.subject === ENTITY_1 && d.object === '"precious local edit"')).toBe(true);
  });

  it('throws when the file has neither a seal nor a prior promote (no member entities)', async () => {
    const { publisher, store } = await makePublisher();
    await store.insert([q(ENTITY_1, SCHEMA, '"Alice"', SWM_GRAPH)]); // no seal, no promoted rows
    const err = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/requires either a finalized assertion.*or a prior promote/i);
  });

  // #1116: seal-INDEPENDENT pull-from. An asset shared UNSEALED (a skipSeal
  // share, or stuck unsealed under the old behavior) records its member
  // entities on the lifecycle URN (dkg:rootEntity) even with no seal —
  // pull-from falls back to those so seal-in-SWM / recovery can reconstruct the
  // WM draft without first finalizing.
  it('seeds a WM draft from SWM via the promoted member entities when there is NO seal', async () => {
    const { publisher, store } = await makePublisher();
    await store.insert([
      q(ENTITY_1, SCHEMA, '"Alice"', SWM_GRAPH),
      q(SKOLEM_1, SCHEMA, '"Alice detail"', SWM_GRAPH),
      // NO seal — instead the promote-stamped member row on the lifecycle URN:
      q(assertionLifecycleUri(CG, AGENT, NAME), `${DKG}rootEntity`, ENTITY_1, contextGraphMetaUri(CG)),
    ]);
    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
    expect(result.fromLayer).toBe('swm');
    expect(result.entities).toBe(1);
    const subjects = new Set((await wmQuads(store)).map((d) => d.subject));
    expect(subjects.has(ENTITY_1)).toBe(true);
    expect(subjects.has(SKOLEM_1)).toBe(true);
  });

  // #1116 atomicity: a pull-from re-opens the WM draft via `assertionCreate`,
  // whose clean-slate WIPES every row under the lifecycle URN before re-seeding.
  // The promote-stamped member rows (dkg:rootEntity) are the SEAL-INDEPENDENT
  // recovery source pull-from falls back to — so they MUST survive that wipe, or
  // a SECOND pull-from (and seal-in-SWM recovery in general) would lose the
  // members and fail. #1116 added dkg:rootEntity to assertionCreate's
  // A2_PRESERVE_PREDS carry-over; this guards that.
  it('#1116: dkg:rootEntity rows on the lifecycle URN SURVIVE a replace pull-from (a second pull still finds the members)', async () => {
    const { publisher, store } = await makePublisher();
    const lifecycleUri = assertionLifecycleUri(CG, AGENT, NAME);
    const metaGraph = contextGraphMetaUri(CG);

    // Unsealed, promote-stamped asset: SWM content + the dkg:rootEntity member
    // row on the lifecycle URN, NO seal — exactly what seal-in-SWM consumes.
    await store.insert([
      q(ENTITY_1, SCHEMA, '"Alice"', SWM_GRAPH),
      q(SKOLEM_1, SCHEMA, '"Alice detail"', SWM_GRAPH),
      q(lifecycleUri, `${DKG}rootEntity`, ENTITY_1, metaGraph),
    ]);

    // Mirror readPromotedRootEntities: the seal-independent member lookup.
    const readRoots = async (): Promise<string[]> => {
      const r = await store.query(
        `SELECT ?root WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <${DKG}rootEntity> ?root } }`,
      );
      return r.type === 'bindings' ? r.bindings.map((b) => String(b['root'])) : [];
    };

    // First pull-from succeeds via the rootEntity fallback...
    const first = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' });
    expect(first.entities).toBe(1);
    // ...and the row survived assertionCreate's clean-slate (it routes through
    // the A2_PRESERVE_PREDS carry-over).
    expect(await readRoots()).toContain(ENTITY_1);

    // The crux: a SECOND replace pull-from still resolves the member — only
    // possible if the dkg:rootEntity row was preserved across the first pull's
    // clean-slate. Pre-#1116 (row wiped) this threw "No member entities".
    const second = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' });
    expect(second.entities).toBe(1);
    expect(await readRoots()).toContain(ENTITY_1);

    // And the reconstructed draft still holds the member + its skolem child.
    const subjects = new Set((await wmQuads(store)).map((d) => d.subject));
    expect(subjects.has(ENTITY_1)).toBe(true);
    expect(subjects.has(SKOLEM_1)).toBe(true);
  });
});
