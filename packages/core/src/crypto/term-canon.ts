// Protocol-defined, BACKEND-INDEPENDENT canonicalization of an RDF object term,
// applied at the V10 merkle leaf (tripleContentV10) so EVERY node computes the
// identical leaf for the same triple regardless of which triple store it runs
// (oxigraph, blazegraph, a SPARQL endpoint, future backends) and which version.
// Without this the leaf delegated literal canonicalization to whatever string the
// backend emitted, so a publisher sealing pre-store and a peer recomputing
// post-store could hash different serializations of the SAME triple →
// MERKLE_MISMATCH_IN_SWM (okf-dkg-vm-validation-report.md), and two nodes on
// different backends could fork RandomSampling (the contract hashes this exact
// content: leaf = keccak256(content)).
//
// The canonical form is DEFINED to equal the value-space canonicalization the
// network already deploys (oxigraph 0.5.5), verified byte-for-byte by the
// oxigraph-oracle test (packages/publisher/test/term-canon-oracle.test.ts), so it
// is the IDENTITY on already-canonical (store-loaded) terms ⇒ no migration; a
// coordinated release suffices.
//
// Covered: literal-content ESCAPING (decode N-Triples escapes, re-emit oxigraph's
// minimal \ " \n \r escaping); language-tag lowercasing; xsd:string elision; the
// xsd:integer family (collapse→xsd:integer iff value∈i64; xsd:integer arbitrary
// precision); xsd:decimal; xsd:boolean; xsd:double / xsd:float; the date/time
// family (xsd:dateTime/time fractional-seconds, +00:00→Z timezone across
// dateTime/time/date/gYear/gYearMonth/gMonthDay/gMonth/gDay, and the T24:00:00
// roll-over); xsd:duration / dayTimeDuration / yearMonthDuration (drop zero
// components, all-zero → PT0S). Other datatypes are returned with normalized
// escaping but otherwise verbatim — matching oxigraph.

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_STRING = XSD + 'string';
const XSD_INTEGER = XSD + 'integer';

const INTEGER_TYPES = new Set(
  [
    'integer', 'int', 'long', 'short', 'byte',
    'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger',
    'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
  ].map((t) => XSD + t),
);
// date/time-family datatypes whose only normalization is +00:00/-00:00 → Z.
const TZ_ONLY_TYPES = new Set(
  ['date', 'gYear', 'gYearMonth', 'gMonthDay', 'gMonth', 'gDay'].map((t) => XSD + t),
);
const DURATION_TYPES = new Set(
  ['duration', 'dayTimeDuration', 'yearMonthDuration'].map((t) => XSD + t),
);

// oxigraph collapses a DERIVED integer type to xsd:integer iff the value fits a
// signed 64-bit integer (no per-type sign/bound enforcement); out-of-i64 derived
// values stay verbatim. xsd:integer itself is arbitrary precision.
const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

const RE_LITERAL = /^"((?:[^"\\]|\\.)*)"(?:@([A-Za-z0-9-]+)|\^\^<([^>]+)>)?$/;

export function canonicalizeObjectTermForHash(object: string): string {
  if (object.length === 0 || object.charCodeAt(0) !== 34 /* " */) return object; // IRI / blank / genid
  const m = RE_LITERAL.exec(object);
  if (!m) return object;
  const rawLex = m[1];
  const lang = m[2];
  const dt = m[3];
  // Literal CONTENT escaping is normalized for every literal (a store decodes
  // \uXXXX / \t / \U… to raw UTF-8 and re-emits only \ " \n \r escaped).
  const lex = normalizeEscaping(rawLex);

  if (lang !== undefined) return `"${lex}"@${lang.toLowerCase()}`;
  if (dt === undefined || dt === XSD_STRING) return `"${lex}"`; // plain / xsd:string

  try {
    if (INTEGER_TYPES.has(dt)) return canonIntegerTerm(lex, dt) ?? verbatim(lex, dt);
    if (dt === XSD + 'decimal') return `"${canonDecimal(lex)}"^^<${dt}>`;
    if (dt === XSD + 'boolean') return `"${canonBoolean(lex)}"^^<${dt}>`;
    if (dt === XSD + 'double') return `"${canonDouble(lex, false)}"^^<${dt}>`;
    if (dt === XSD + 'float') return `"${canonDouble(lex, true)}"^^<${dt}>`;
    if (dt === XSD + 'dateTime') return `"${canonDateTime(lex)}"^^<${dt}>`;
    if (dt === XSD + 'time') return `"${canonTime(lex)}"^^<${dt}>`;
    if (TZ_ONLY_TYPES.has(dt)) return `"${normalizeTz(lex)}"^^<${dt}>`;
    if (DURATION_TYPES.has(dt)) return `"${canonDuration(lex, dt)}"^^<${dt}>`;
  } catch {
    return verbatim(lex, dt); // invalid lexical → escaping-normalized, otherwise verbatim
  }
  return verbatim(lex, dt); // datatype the deployed store leaves verbatim
}

const verbatim = (lex: string, dt: string) => `"${lex}"^^<${dt}>`;

// ── literal content escaping ───────────────────────────────────────────────────
const ESCAPE_DECODE = /\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[tbnrf"'\\])/g;
function normalizeEscaping(lex: string): string {
  const decoded = lex.replace(ESCAPE_DECODE, (whole, e: string) => {
    const c = e[0];
    if (c === 'u' || c === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16));
    switch (e) {
      case 't': return '\t';
      case 'b': return '\b';
      case 'n': return '\n';
      case 'r': return '\r';
      case 'f': return '\f';
      case '"': return '"';
      case "'": return "'";
      case '\\': return '\\';
      default: return whole;
    }
  });
  // re-emit oxigraph's minimal escaping (escapeNQuadsLiteral): \ " \n \r only.
  return decoded.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

// ── xsd:integer family ─────────────────────────────────────────────────────────
function canonIntegerTerm(lex: string, dt: string): string | null {
  const raw = lex.startsWith('+') ? lex.slice(1) : lex;
  if (!/^-?\d+$/.test(raw)) return null;
  const v = BigInt(raw);
  if (dt !== XSD_INTEGER && (v < I64_MIN || v > I64_MAX)) return null;
  return `"${v.toString()}"^^<${XSD_INTEGER}>`;
}

// ── xsd:boolean ────────────────────────────────────────────────────────────────
function canonBoolean(lex: string): string {
  if (lex === 'true' || lex === '1') return 'true';
  if (lex === 'false' || lex === '0') return 'false';
  throw new Error(`invalid xsd:boolean: ${lex}`);
}

// ── xsd:decimal ────────────────────────────────────────────────────────────────
function canonDecimal(lex: string): string {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(lex);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) throw new Error(`invalid xsd:decimal: ${lex}`);
  let int = m[2].replace(/^0+/, '');
  const frac = (m[3] ?? '').replace(/0+$/, '');
  if (int === '') int = '0';
  const sign = m[1] === '-' && !(int === '0' && frac === '') ? '-' : '';
  return frac === '' ? `${sign}${int}` : `${sign}${int}.${frac}`;
}

// ── xsd:double / xsd:float ─────────────────────────────────────────────────────
function canonDouble(lex: string, isFloat: boolean): string {
  let n = parseXsdDouble(lex);
  if (isFloat) n = Math.fround(n);
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'INF';
  if (n === -Infinity) return '-INF';
  if (n === 0) return Object.is(n, -0) ? '-0' : '0';
  const neg = n < 0;
  const a = Math.abs(n);
  const shortest = isFloat ? shortestFloat32String(a) : a.toString();
  const plain = expandToPlainDecimal(shortest);
  return neg ? `-${plain}` : plain;
}

function parseXsdDouble(lex: string): number {
  if (lex === 'NaN') return NaN;
  if (lex === 'INF' || lex === '+INF') return Infinity;
  if (lex === '-INF') return -Infinity;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(lex)) throw new Error(`invalid xsd:double: ${lex}`);
  return Number(lex);
}

function shortestFloat32String(a: number): string {
  for (let p = 1; p <= 9; p++) {
    const s = a.toPrecision(p);
    if (Math.fround(Number(s)) === a) return Number(s).toString();
  }
  return a.toString();
}

function expandToPlainDecimal(s: string): string {
  const m = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return s;
  const intPart = m[1];
  const frac = m[2] ?? '';
  const exp = parseInt(m[3], 10);
  const digits = intPart + frac;
  const pointPos = intPart.length + exp;
  if (pointPos <= 0) return stripTrailingZeros(`0.${'0'.repeat(-pointPos)}${digits}`);
  if (pointPos >= digits.length) return digits + '0'.repeat(pointPos - digits.length);
  return stripTrailingZeros(`${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`);
}

function stripTrailingZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

// ── date/time family ───────────────────────────────────────────────────────────
function normalizeTz(s: string): string {
  return s.replace(/[+-]00:00$/, 'Z');
}

// strip trailing zeros from a fractional-seconds group, drop a lone "."
function stripFractionalSeconds(s: string): string {
  return s.replace(/(\.\d*[1-9])0+(?=$|[Z+-])/, '$1').replace(/\.0*(?=$|[Z+-])/, '');
}

function canonTime(lex: string): string {
  let s = stripFractionalSeconds(lex);
  s = s.replace(/^24:00:00(?=$|[.Z+-])/, '00:00:00'); // 24:00:00 → 00:00:00
  return normalizeTz(s);
}

function canonDateTime(lex: string): string {
  let s = stripFractionalSeconds(lex);
  // T24:00:00 rolls to 00:00:00 of the next day (the only value-space arithmetic
  // oxigraph performs here). Negative years are left to the verbatim path.
  const m = /^(\d{4,})-(\d{2})-(\d{2})T24:00:00(?=$|[Z+-])(.*)$/.exec(s);
  if (m) {
    const next = nextDay(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
    if (next) s = `${next}T00:00:00${m[4]}`;
  }
  return normalizeTz(s);
}

function nextDay(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (d > dim[mo - 1]) return null;
  let ny = y, nmo = mo, nd = d + 1;
  if (nd > dim[mo - 1]) { nd = 1; nmo++; if (nmo > 12) { nmo = 1; ny++; } }
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(ny, 4)}-${pad(nmo, 2)}-${pad(nd, 2)}`;
}

// ── xsd:duration / dayTimeDuration / yearMonthDuration ─────────────────────────
const RE_DURATION = /^(-?)P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
function canonDuration(lex: string, dt: string): string {
  const m = RE_DURATION.exec(lex);
  if (!m) throw new Error(`invalid duration: ${lex}`);
  const [, sign, y, mo, d, h, mi, sRaw] = m;
  const nz = (x: string | undefined) => x !== undefined && !/^0*(\.0*)?$/.test(x);
  const s = sRaw !== undefined ? sRaw.replace(/(\.\d*[1-9])0+$/, '$1').replace(/\.0*$/, '') : undefined;
  let date = '';
  if (nz(y)) date += `${y}Y`;
  if (nz(mo)) date += `${mo}M`;
  if (nz(d)) date += `${d}D`;
  let time = '';
  if (nz(h)) time += `${h}H`;
  if (nz(mi)) time += `${mi}M`;
  if (nz(sRaw)) time += `${s}S`;
  const body = time ? `${date}T${time}` : date;
  // All-zero canonical form is subtype-dependent: yearMonthDuration has no time
  // component so it canonicalizes to "P0M"; duration / dayTimeDuration → "PT0S".
  if (body === '') return dt === XSD + 'yearMonthDuration' ? 'P0M' : 'PT0S';
  return `${sign}P${body}`;
}
