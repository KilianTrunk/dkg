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
    // #1116 (round 5): the seal-less SWM reconstruction now requires the
    // full-share marker (else it's a SUBSET share, not publishable). A real
    // skipSeal FULL share stamps it via promote(); set it here to represent
    // that legitimate full-share state.
    await publisher.markSwmShareComplete(CG, NAME, AGENT);
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
    // #1116 (round 5): a real FULL skipSeal share stamps the full-share marker
    // (it survives assertionCreate's clean-slate via A2_PRESERVE), so the
    // seal-less reconstruction is allowed; mark it to represent that state.
    await publisher.markSwmShareComplete(CG, NAME, AGENT);

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

  // #1116 (review A1): the swmShareComplete marker gates finalize(layer:"swm").
  // seal-in-SWM runs a replace pull-from (assertionCreate clean-slate) BEFORE
  // sealing — so the marker MUST survive that wipe (it was added to
  // A2_PRESERVE_PREDS), otherwise a finalize that fails after the re-seed would
  // strip the marker and make an already-fully-shared asset un-sealable.
  it('#1116: swmShareComplete marker SURVIVES a replace pull-from (A2 preserve)', async () => {
    const { publisher, store } = await makePublisher();
    const lifecycleUri = assertionLifecycleUri(CG, AGENT, NAME);
    const metaGraph = contextGraphMetaUri(CG);

    // Fully-shared (marker present) + the seal-independent member row, NO seal —
    // exactly the state seal-in-SWM reconstructs from.
    await publisher.markSwmShareComplete(CG, NAME, AGENT);
    await store.insert([
      q(ENTITY_1, SCHEMA, '"Alice"', SWM_GRAPH),
      q(lifecycleUri, `${DKG}rootEntity`, ENTITY_1, metaGraph),
    ]);
    expect(await publisher.hasSwmShareComplete(CG, NAME, AGENT)).toBe(true);

    // The replace pull-from re-opens the WM draft via assertionCreate's clean
    // slate; the marker must carry over.
    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' });
    expect(result.entities).toBe(1);
    expect(await publisher.hasSwmShareComplete(CG, NAME, AGENT)).toBe(true);

    // markSwmShareComplete is idempotent — re-marking leaves exactly one row.
    await publisher.markSwmShareComplete(CG, NAME, AGENT);
    const rows = await store.query(
      `SELECT ?o WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <${DKG}swmShareComplete> ?o } }`,
    );
    expect(rows.type === 'bindings' && rows.bindings.length).toBe(1);
  });

  // #1116 (round 5): the marker MUST be cleared on discard — otherwise the
  // A2_PRESERVE carry-over re-arms it on a recreate, and a full-share → discard
  // → recreate → subset-share cycle would keep a stale marker and let
  // finalize(layer:"swm") publish a partial asset under the KA name.
  it('#1116: hasSwmShareComplete is FALSE after assertionDiscard (marker cleared)', async () => {
    const { publisher } = await makePublisher();

    // Open a WM draft, then fully-share (mark complete) — the state a full share
    // leaves behind.
    await publisher.assertionWrite(CG, NAME, AGENT, [
      { subject: ENTITY_1, predicate: SCHEMA, object: '"Alice"' },
    ]);
    await publisher.markSwmShareComplete(CG, NAME, AGENT);
    expect(await publisher.hasSwmShareComplete(CG, NAME, AGENT)).toBe(true);

    // Discard MUST clear the marker.
    await publisher.assertionDiscard(CG, NAME, AGENT);
    expect(await publisher.hasSwmShareComplete(CG, NAME, AGENT)).toBe(false);
  });

  it('#1116: hasSwmShareComplete stays FALSE after discard + recreate (no stale re-arm)', async () => {
    const { publisher } = await makePublisher();

    await publisher.assertionWrite(CG, NAME, AGENT, [
      { subject: ENTITY_1, predicate: SCHEMA, object: '"Alice"' },
    ]);
    await publisher.markSwmShareComplete(CG, NAME, AGENT);
    await publisher.assertionDiscard(CG, NAME, AGENT);

    // Recreate on the same name — assertionCreate's A2_PRESERVE clean-slate must
    // NOT resurrect a marker that discard cleared (it was already gone, so there
    // is nothing to preserve). The recreated draft is un-marked: a later seal-in-
    // SWM must re-prove completeness.
    await publisher.assertionCreate(CG, NAME, AGENT);
    expect(await publisher.hasSwmShareComplete(CG, NAME, AGENT)).toBe(false);
  });

  // #1116 (round 5): the subset-publishability bypass is closed at the ROOT —
  // the seal-less SWM reconstruction. A SUBSET share stamps dkg:rootEntity rows
  // but NOT the full-share marker, so reconstructing/sealing it (reachable via
  // the wm/pull-from route + a plain finalize, which bypasses the finalize(
  // layer:"swm") wrapper guard) must be refused with SWM_SUBSET_NOT_SEALABLE.
  it('#1116: seal-less SWM pull-from REJECTS a subset-only asset (no full-share marker)', async () => {
    const { publisher, store } = await makePublisher();
    const lifecycleUri = assertionLifecycleUri(CG, AGENT, NAME);
    const metaGraph = contextGraphMetaUri(CG);

    // SUBSET-shared, unsealed: SWM content + the promoted member row, but NO
    // swmShareComplete marker (a subset share never sets it).
    await store.insert([
      q(ENTITY_1, SCHEMA, '"Alice"', SWM_GRAPH),
      q(lifecycleUri, `${DKG}rootEntity`, ENTITY_1, metaGraph),
    ]);
    expect(await publisher.hasSwmShareComplete(CG, NAME, AGENT)).toBe(false);

    const err = await publisher
      .assertionPullFrom(CG, NAME, AGENT, 'swm')
      .catch((e) => e);
    expect((err as any).code).toBe('SWM_SUBSET_NOT_SEALABLE');
  });

  // ── round 7: lifecycle-URN member-row staleness (append-only bug) ──
  // The member rows (dkg:rootEntity) are the seal-less reconstruction source.
  // generateAssertionPromotedMetadata only INSERTs them (never deletes prior),
  // and they survive discard+recreate via A2_PRESERVE — so without round-7 they
  // accumulate a stale UNION and the seal-less reconstruction seals a SUPERSET.

  // Read the lifecycle-URN member roots exactly as readPromotedRootEntities does.
  async function readMemberRoots(store: OxigraphStore): Promise<Set<string>> {
    const lifecycleUri = assertionLifecycleUri(CG, AGENT, NAME);
    const metaGraph = contextGraphMetaUri(CG);
    const r = await store.query(
      `SELECT DISTINCT ?root WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> (<${DKG}rootEntity>|<${DKG}entity>) ?root } }`,
    );
    const out = new Set<string>();
    if (r.type === 'bindings') for (const b of r.bindings) if (b['root']) out.add(String(b['root']));
    return out;
  }

  it('#1116 (round 7): member rows are CLEARED after assertionDiscard (no VM version)', async () => {
    const { publisher, store } = await makePublisher();
    const lifecycleUri = assertionLifecycleUri(CG, AGENT, NAME);
    const metaGraph = contextGraphMetaUri(CG);

    // A promoted (unsealed) asset: SWM content + the promote-stamped member rows.
    await publisher.assertionWrite(CG, NAME, AGENT, [
      { subject: ENTITY_1, predicate: SCHEMA, object: '"Alice"' },
    ]);
    await store.insert([
      q(lifecycleUri, `${DKG}rootEntity`, ENTITY_1, metaGraph),
      q(lifecycleUri, `${DKG}rootEntity`, ENTITY_2, metaGraph),
    ]);
    expect((await readMemberRoots(store)).size).toBe(2);

    // Discard a NON-published asset → membership is gone (nothing to reconstruct).
    await publisher.assertionDiscard(CG, NAME, AGENT);
    expect((await readMemberRoots(store)).size).toBe(0);
  });

  it('#1116 (round 7): a stale member row does NOT survive discard+recreate into a new draft', async () => {
    const { publisher, store } = await makePublisher();
    const lifecycleUri = assertionLifecycleUri(CG, AGENT, NAME);
    const metaGraph = contextGraphMetaUri(CG);

    await publisher.assertionWrite(CG, NAME, AGENT, [
      { subject: ENTITY_1, predicate: SCHEMA, object: '"Alice"' },
    ]);
    await store.insert([q(lifecycleUri, `${DKG}rootEntity`, ENTITY_1, metaGraph)]);
    await publisher.assertionDiscard(CG, NAME, AGENT);
    // Recreate the SAME name: A2_PRESERVE must NOT carry the member row that
    // discard cleared (the round-7 stale-superset bug starts here).
    await publisher.assertionCreate(CG, NAME, AGENT);
    expect((await readMemberRoots(store)).size).toBe(0);
  });

  it('#1116 (round 7): a FULL-COMPLETE promote REPLACES the member rows (drops a stale prior root)', async () => {
    const { publisher, store } = await makePublisher();
    const lifecycleUri = assertionLifecycleUri(CG, AGENT, NAME);
    const metaGraph = contextGraphMetaUri(CG);

    // Pre-seed a STALE member row for a root NOT in the current draft (e.g. left
    // over from a prior full share {A, OTHER} that A2_PRESERVE carried across a
    // recreate).
    await store.insert([q(lifecycleUri, `${DKG}rootEntity`, OTHER_FILE_ENTITY, metaGraph)]);

    // Current draft holds A and B; a FULL promote (entities:"all", no skip) is the
    // authoritative current set → member rows must become EXACTLY {A, B}, not the
    // union {A, B, OTHER}.
    await publisher.assertionWrite(CG, NAME, AGENT, [
      { subject: ENTITY_1, predicate: SCHEMA, object: '"Alice"' },
      { subject: ENTITY_2, predicate: SCHEMA, object: '"Bob"' },
    ]);
    const res = await publisher.assertionPromote(CG, NAME, AGENT, { publisherPeerId: 'peer-self' });
    expect(res.promotedAllRoots).toBe(true);

    const rows = await readMemberRoots(store);
    expect(rows.has(ENTITY_1)).toBe(true);
    expect(rows.has(ENTITY_2)).toBe(true);
    // The stale prior root is GONE — replaced, not appended.
    expect(rows.has(OTHER_FILE_ENTITY)).toBe(false);
    expect(rows.size).toBe(2);
  });
});
