// CONSENSUS SAFETY NET for the backend-independent V10 leaf canonicalization
// (dkg-core canonicalizeObjectTermForHash, applied at tripleContentV10).
//
// The protocol canonical form is DEFINED to equal the value-space canonicalization
// the network already deploys (oxigraph 0.5.5). This test is the oracle that
// proves it byte-for-byte: for a broad battery of literals (incl. a randomized
// double sweep), the pure core canonicalizer must produce EXACTLY what a real
// oxigraph store emits on round-trip. If they ever diverge, this fails CI — which
// is the difference between "fixed a publish bug" and "forked RandomSampling".
//
// Matching the deployed form also means the canonicalizer is the IDENTITY on
// already-canonical (store-loaded) terms ⇒ existing on-chain roots are unchanged
// (no migration); a coordinated release suffices.

import { describe, it, expect } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { canonicalizeObjectTermForHash } from '@origintrail-official/dkg-core';

const xsd = (t: string) => `http://www.w3.org/2001/XMLSchema#${t}`;
const G = 'urn:g';
const S = 'urn:s';

/** Round-trip every literal through a real oxigraph store and return, per input,
 *  the canonical object string the store emits — the deployed canonical form. */
async function oxigraphForms(objects: string[]): Promise<string[]> {
  const store = new OxigraphStore();
  const quads: Quad[] = objects.map((object, i) => ({ subject: S, predicate: `urn:p#${i}`, object, graph: G }));
  await store.insert(quads);
  const res = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${G}> { ?s ?p ?o } }`);
  const byPred = new Map<string, string>();
  if (res.type === 'quads') for (const q of res.quads) byPred.set(q.predicate, q.object);
  return objects.map((_, i) => byPred.get(`urn:p#${i}`) ?? '(DROPPED)');
}

/** Assert the pure core canonicalizer reproduces oxigraph's form for every input. */
async function expectMatchesOxigraph(objects: string[]): Promise<void> {
  const oxi = await oxigraphForms(objects);
  const mismatches: string[] = [];
  objects.forEach((obj, i) => {
    const got = canonicalizeObjectTermForHash(obj);
    if (got !== oxi[i]) mismatches.push(`  in:  ${obj}\n  core:${got}\n  oxi: ${oxi[i]}`);
  });
  if (mismatches.length) {
    throw new Error(`core canon diverged from oxigraph (${mismatches.length}/${objects.length}):\n${mismatches.join('\n')}`);
  }
  expect(mismatches.length).toBe(0);
}

const lit = (v: string, dt: string) => `"${v}"^^<${xsd(dt)}>`;

describe('term-canon oracle: core == oxigraph 0.5.5', () => {
  it('xsd:string is elided', async () => {
    await expectMatchesOxigraph([lit('Bitcoin', 'string'), lit('a b c', 'string'), lit('', 'string')]);
  });

  it('language tags are lowercased', async () => {
    await expectMatchesOxigraph(['"x"@EN', '"x"@en', '"x"@en-US', '"x"@EN-us', '"x"@En-Gb', '"x"@DE']);
  });

  it('plain literals and non-literals are unchanged', async () => {
    // plain literal (no datatype) round-trips as-is; oracle handles literals only,
    // so check non-literals (IRI/blank/genid) directly against identity.
    await expectMatchesOxigraph(['"plain"', '"with space"']);
    expect(canonicalizeObjectTermForHash('http://example.org/x')).toBe('http://example.org/x');
    expect(canonicalizeObjectTermForHash('urn:okf:datasets/x/.well-known/genid/b0')).toBe('urn:okf:datasets/x/.well-known/genid/b0');
    expect(canonicalizeObjectTermForHash('_:b0')).toBe('_:b0');
  });

  it('the xsd:integer family collapses to xsd:integer with canonical value', async () => {
    const cases = ['007', '+5', '-0', '00', '-42', '0', '999999999999999999999999'];
    const types = ['integer', 'int', 'long', 'short', 'byte', 'unsignedInt', 'nonNegativeInteger', 'positiveInteger', 'negativeInteger'];
    const objects: string[] = [];
    for (const ty of types) for (const v of cases) {
      // only feed values valid for the type (avoid oxigraph rejecting e.g. negative unsigned)
      if (ty.includes('nonNegative') || ty.includes('unsigned') || ty === 'positiveInteger') { if (v.startsWith('-')) continue; }
      if (ty === 'negativeInteger') { if (!v.startsWith('-') || v === '-0') continue; }
      if (ty === 'positiveInteger' && (v === '0' || v === '00' || v === '-0')) continue;
      if (ty === 'byte' && (v === '999999999999999999999999')) continue;
      objects.push(lit(v, ty));
    }
    await expectMatchesOxigraph(objects);
  });

  it('xsd:decimal value-space canonicalization', async () => {
    const vals = ['1.0', '1.50', '100.0', '0.500', '.5', '-0.0', '+1.5', '010.0', '0', '0.0', '-3.14', '123.456000', '000.000'];
    await expectMatchesOxigraph(vals.map((v) => lit(v, 'decimal')));
  });

  it('xsd:boolean lexical forms', async () => {
    await expectMatchesOxigraph(['1', '0', 'true', 'false'].map((v) => lit(v, 'boolean')));
  });

  it('xsd:dateTime fractional-seconds + timezone normalization', async () => {
    const vals = [
      '2026-06-29T12:00:00', '2026-06-29T12:00:00.0', '2026-06-29T12:00:00.500', '2026-06-29T12:00:00.000',
      '2026-06-29T12:00:00Z', '2026-06-29T12:00:00+00:00', '2026-06-29T12:00:00-00:00', '2026-06-29T12:00:00+02:00',
      '2026-06-29T12:00:00.120Z', '2026-06-29T12:00:00.123456',
    ];
    await expectMatchesOxigraph(vals.map((v) => lit(v, 'dateTime')));
  });

  it('xsd:dateTime T24:00:00 rolls over to next day (incl. month/year/leap boundaries)', async () => {
    const vals = [
      '2026-06-29T24:00:00', '2026-06-30T24:00:00', '2026-12-31T24:00:00', '2024-02-28T24:00:00',
      '2026-02-28T24:00:00', '2026-06-29T24:00:00Z', '2026-06-29T24:00:00+02:00', '2000-02-29T24:00:00',
    ];
    await expectMatchesOxigraph(vals.map((v) => lit(v, 'dateTime')));
  });

  it('xsd:time fractional-seconds + timezone + 24:00:00', async () => {
    const vals = ['12:00:00', '12:00:00.0', '12:00:00.500', '12:00:00Z', '12:00:00+00:00', '12:00:00-00:00', '12:00:00+02:00', '24:00:00', '24:00:00Z'];
    await expectMatchesOxigraph(vals.map((v) => lit(v, 'time')));
  });

  it('date / gYear / gYearMonth / gMonthDay / gMonth / gDay timezone normalization', async () => {
    await expectMatchesOxigraph([
      lit('2026-06-29', 'date'), lit('2026-06-29Z', 'date'), lit('2026-06-29+00:00', 'date'),
      lit('2026-06-29-00:00', 'date'), lit('2026-06-29+02:00', 'date'),
      lit('2026', 'gYear'), lit('2026+00:00', 'gYear'), lit('2026+02:00', 'gYear'), lit('02026', 'gYear'),
      lit('2026-06', 'gYearMonth'), lit('2026-06+00:00', 'gYearMonth'),
      lit('--06-29', 'gMonthDay'), lit('--06-29+00:00', 'gMonthDay'),
      lit('--06', 'gMonth'), lit('--06+00:00', 'gMonth'), lit('---29', 'gDay'),
    ]);
  });

  it('xsd:duration / dayTimeDuration / yearMonthDuration drop zero components', async () => {
    const dur = ['P1Y0M', 'P1Y', 'PT0S', 'P0Y', 'P1Y2M3DT4H5M6S', '-P1Y', 'P1DT0H', 'PT1H0M0S', 'P0Y0M0DT0H0M0S', 'PT1.500S', 'P0M0D'];
    await expectMatchesOxigraph(dur.map((v) => lit(v, 'duration')));
    await expectMatchesOxigraph(['PT1H0M', 'PT0H0M0S'].map((v) => lit(v, 'dayTimeDuration')));
    await expectMatchesOxigraph(['P1Y0M', 'P0Y0M'].map((v) => lit(v, 'yearMonthDuration')));
  });

  it('literal-content escaping is normalized (decode + minimal re-escape)', async () => {
    // NOTE: double-backslash in source = a single literal backslash in the term.
    await expectMatchesOxigraph([
      lit('caf\\u00e9', 'string'),       // é -> é
      lit('smile\\U0001F600', 'string'), // \U… -> 😀
      lit('tab\\there', 'string'),       // \t -> raw tab
      lit('q\\"uote', 'string'),         // \" stays escaped
      lit('back\\\\slash', 'string'),    // \\ stays escaped
      lit('new\\nline', 'string'),       // \n stays escaped
      lit('ret\\rX', 'string'),          // \r stays escaped
      lit('caf\\u00e9', 'http://example.org/custom'), // escaping normalized for verbatim datatypes too
      '"smile\\U0001F600"@EN',           // and for language-tagged literals
      '"plain ascii"',
    ]);
  });

  it('datatypes oxigraph leaves verbatim are returned unchanged', async () => {
    const verbatim = [
      lit('2026-06-29', 'date'), lit('2026-06-29Z', 'date'), lit('12:00:00', 'time'),
      lit('2026', 'gYear'), lit('02026', 'gYear'), lit('4A6f', 'hexBinary'), lit('SGk=', 'base64Binary'),
      lit('http://x', 'anyURI'), '"RawValue"^^<http://example.org/custom>',
    ];
    await expectMatchesOxigraph(verbatim);
  });

  describe('xsd:double / xsd:float', () => {
    it('representative + edge lexical forms', async () => {
      const vals = ['1.0E2', '1e10', '-0.0', '3.14', '1E-7', '1.5E300', 'NaN', 'INF', '-INF', '0.1', '0.5', '100', '0', '0.0', '-2.5E-3', '6.022E23'];
      await expectMatchesOxigraph(vals.map((v) => lit(v, 'double')));
      await expectMatchesOxigraph(['1.0', '0.1', '3.14', '1E2', '1.5', '100', '0'].map((v) => lit(v, 'float')));
    });

    it('randomized double sweep across magnitudes', async () => {
      // Deterministic spread (no Math.random — avoid flakiness): mantissas × 10^exp,
      // both signs, across the full exponent range.
      const mantissas = [1, 1.5, 3.14159, 2, 7, 9.999, 1.234567890123, 5.5, 8.0];
      const exps = [-300, -100, -20, -7, -3, -1, 0, 1, 3, 7, 15, 21, 100, 300];
      const objects: string[] = [];
      for (const m of mantissas) for (const e of exps) for (const sign of [1, -1]) {
        const v = sign * m * Math.pow(10, e);
        if (!Number.isFinite(v) || v === 0) continue;
        objects.push(lit(v.toExponential(), 'double')); // feed E-notation; oxigraph + core both expand to plain
      }
      await expectMatchesOxigraph(objects);
    });

    it('float32 rounding (Math.fround) matches oxigraph', async () => {
      const vals = ['0.1', '1.1', '3.14159265358979', '0.2', '1.0E20', '123456.789'];
      await expectMatchesOxigraph(vals.map((v) => lit(v, 'float')));
    });
  });

  it('is idempotent (fixed point) on its own output', async () => {
    const inputs = [lit('007', 'integer'), lit('1.0', 'decimal'), lit('1', 'boolean'), lit('1.0E2', 'double'), '"x"@EN', lit('Bitcoin', 'string')];
    for (const x of inputs) {
      const once = canonicalizeObjectTermForHash(x);
      expect(canonicalizeObjectTermForHash(once)).toBe(once);
    }
  });
});
