// KC→KA rename guard — on-chain publish receipt quads.
//
// After a successful VM publish, `/api/shared-memory/publish` writes a
// small receipt block into the context graph `_meta` graph keyed by
// the assertion URI. The KC→KA rename (rc.12) renamed the id predicate
// `publishedAtKcId` → `publishedAtKaId`. Across the whole worktree NO
// test asserted the literal predicate URI — every reference goes
// through the `ASSERTION_PUBLISH_RECEIPT_PREDICATES` constant, so a
// regression that left the constant's *value* as `...publishedAtKcId`
// (or a typo like `publishedAtKaID`) would never be caught: producer
// and consumer would simply agree on the wrong string.
//
// This file pins the wire-level predicate URIs and the typed-literal
// object forms against hard-coded golden strings (NOT the constant) so
// drift on either side turns the suite red.
import { describe, it, expect } from 'vitest';
import {
  buildAssertionPublishReceiptQuads,
  ASSERTION_PUBLISH_RECEIPT_PREDICATES,
} from '../src/assertion-seal.js';

const ASSERTION_URI = 'urn:dkg:assertion:foo';
const META_GRAPH = 'did:dkg:context-graph:cg-1/_meta';
const XSD_INTEGER = '<http://www.w3.org/2001/XMLSchema#integer>';

function build(kaId: bigint) {
  return buildAssertionPublishReceiptQuads({
    assertionUri: ASSERTION_URI,
    metaGraph: META_GRAPH,
    txHash: '0xabc123',
    blockNumber: 4242n,
    kaId,
  });
}

describe('assertion publish receipt quads (KC→KA predicate pinning)', () => {
  it('pins the literal predicate URIs (constant values, not just symbol identity)', () => {
    // Golden literals — these are the bytes that land in the graph and
    // that any downstream SPARQL must match. Asserting the constant
    // against itself would be tautological, so compare to raw strings.
    expect(ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_TX).toBe(
      'http://dkg.io/ontology/publishedAtTx',
    );
    expect(ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_BLOCK).toBe(
      'http://dkg.io/ontology/publishedAtBlock',
    );
    expect(ASSERTION_PUBLISH_RECEIPT_PREDICATES.PUBLISHED_AT_KA_ID).toBe(
      'http://dkg.io/ontology/publishedAtKaId',
    );
  });

  it('emits the KA-id receipt under publishedAtKaId — never the retired publishedAtKcId', () => {
    const quads = build(7n);
    const predicates = quads.map((q) => q.predicate);
    expect(predicates).toContain('http://dkg.io/ontology/publishedAtKaId');
    // Hard guard against a partial rename leaking the old predicate.
    for (const p of predicates) {
      expect(p).not.toBe('http://dkg.io/ontology/publishedAtKcId');
      expect(p.toLowerCase()).not.toContain('kcid');
    }
  });

  it('builds exactly the three receipt quads, all on the assertion subject + meta graph', () => {
    const quads = build(7n);
    expect(quads).toHaveLength(3);
    for (const q of quads) {
      expect(q.subject).toBe(ASSERTION_URI);
      expect(q.graph).toBe(META_GRAPH);
    }
    // No duplicate predicates.
    expect(new Set(quads.map((q) => q.predicate)).size).toBe(3);
  });

  it('renders the kaId as a typed xsd:integer literal carrying the exact id', () => {
    const kaQuad = build(123n).find(
      (q) => q.predicate === 'http://dkg.io/ontology/publishedAtKaId',
    );
    expect(kaQuad).toBeDefined();
    expect(kaQuad!.object).toBe(`"123"^^${XSD_INTEGER}`);
  });

  it('renders the block number as a typed xsd:integer and the tx hash as a quoted string literal', () => {
    const quads = build(7n);
    const blockQuad = quads.find(
      (q) => q.predicate === 'http://dkg.io/ontology/publishedAtBlock',
    )!;
    const txQuad = quads.find(
      (q) => q.predicate === 'http://dkg.io/ontology/publishedAtTx',
    )!;
    expect(blockQuad.object).toBe(`"4242"^^${XSD_INTEGER}`);
    // txHash is JSON.stringify'd → wrapped in double quotes, no datatype.
    expect(txQuad.object).toBe('"0xabc123"');
  });

  it('faithfully encodes kaId === 0n (does not silently drop the receipt)', () => {
    // A confirmed VM publish should never have kaId 0, but the builder
    // must encode whatever it is told verbatim so a downstream check can
    // catch a 0 — it must not coerce/omit it.
    const kaQuad = build(0n).find(
      (q) => q.predicate === 'http://dkg.io/ontology/publishedAtKaId',
    )!;
    expect(kaQuad.object).toBe(`"0"^^${XSD_INTEGER}`);
  });
});
