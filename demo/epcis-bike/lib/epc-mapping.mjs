// Stable mapping rules: assembly cycle records → EPCIS 2.0 ObjectEvent fields.
//
// All rules are intentionally simple two-bucket / lookup-table style, so the
// design doc's mapping table matches what the code does, line for line.

import { createHash } from 'node:crypto';

// DNS namespace UUID — used as the v5 namespace for deriving deterministic event IDs.
// Pinned so regenerating the fixture from the same source yields identical eventIDs.
const UUID_DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export const BIKE_URN_PREFIX = 'urn:acme:bike';

export const CBV_BIZSTEP_BASE = 'https://ref.gs1.org/cbv/BizStep-';
export const CBV_DISP_BASE = 'https://ref.gs1.org/cbv/Disp-';

export const EPCIS_CONTEXT = {
  '@vocab': 'https://gs1.github.io/EPCIS/',
  epcis: 'https://gs1.github.io/EPCIS/',
  cbv: 'https://ref.gs1.org/cbv/',
  type: '@type',
  id: '@id',
  eventID: '@id',
};

// Replace any character that isn't safe in a URN local segment with `_`.
// Source data may have spaces, slashes, parentheses, or accented
// characters in `process_name` / `unit_id`; interpolating those raw into
// `urn:acme:bike:station:<name>` produces an invalid IRI that the
// EPCIS plugin and SPARQL stores then reject (or silently mis-parse).
// Allow ASCII alphanumerics, underscore, and hyphen — the same set
// `etl.mjs#safeName` accepts for filename construction, so the URN
// segment and the on-disk filename always agree.
function safeUrnSegment(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_');
}

export function itemEpc(itemId) {
  if (!itemId) throw new Error('itemEpc: itemId is required');
  return `${BIKE_URN_PREFIX}:item:${safeUrnSegment(itemId)}`;
}

export function stationUri(processName) {
  if (!processName) throw new Error('stationUri: processName is required');
  return `${BIKE_URN_PREFIX}:station:${safeUrnSegment(processName)}`;
}

// Two-bucket bizStep rule: anything that names an inspection/test → CBV `inspecting`,
// everything else → CBV `assembling`.
const INSPECTION_PATTERN = /inspection|test|inspecting/i;

export function bizStepFor(processName) {
  return INSPECTION_PATTERN.test(processName ?? '')
    ? `${CBV_BIZSTEP_BASE}inspecting`
    : `${CBV_BIZSTEP_BASE}assembling`;
}

const STATUS_TO_DISPOSITION = {
  Passed: `${CBV_DISP_BASE}in_progress`,
  Rejected: `${CBV_DISP_BASE}damaged`,
  Skipped: `${CBV_DISP_BASE}unknown`,
};

export function dispositionFor(status) {
  return STATUS_TO_DISPOSITION[status] ?? `${CBV_DISP_BASE}unknown`;
}

// Deterministic UUIDv5 from (trace_id, unit_id, ended[, groupKey]). Same inputs
// → same output. `groupKey` is included in the seed only when one source
// record is split into multiple sibling EPCIS docs (e.g. items with mixed
// statuses), so that the sibling docs get distinct eventIDs. When the source
// record produces a single doc, groupKey is omitted and the seed is identical
// to the original two-arg form — committed fixtures regenerate unchanged.
export function eventId(traceId, unitId, ended, groupKey) {
  if (!traceId || !unitId || !ended) {
    throw new Error('eventId: traceId, unitId, ended all required');
  }
  const seed = groupKey
    ? `acme-bike|${traceId}|${unitId}|${ended}|${groupKey}`
    : `acme-bike|${traceId}|${unitId}|${ended}`;
  return `urn:uuid:${uuidv5(seed, UUID_DNS_NAMESPACE)}`;
}

function uuidv5(name, namespace) {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(Buffer.concat([nsBytes, Buffer.from(name, 'utf8')]))
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Build one EPCIS 2.0 Document containing exactly one ObjectEvent.
// The plugin expects a JSON-LD-compatible shape; we keep the @context tight.
// `groupKey` is forwarded to eventId() so sibling docs from a single source
// record (mixed-status grouping) get distinct eventIDs; pass undefined when
// the source record yields a single doc (eventID stays back-compat).
export function buildEpcisDocument({
  traceId,
  unitId,
  unitName,
  processName,
  ended,
  itemIds,
  status,
  groupKey,
  isFirstInTrace,
  creationDate,
}) {
  const event = {
    eventID: eventId(traceId, unitId, ended, groupKey),
    type: 'ObjectEvent',
    eventTime: ended,
    eventTimeZoneOffset: '+00:00',
    epcList: itemIds.map(itemEpc),
    action: isFirstInTrace ? 'ADD' : 'OBSERVE',
    bizStep: bizStepFor(processName),
    disposition: dispositionFor(status),
    readPoint: { id: stationUri(processName) },
    bizLocation: { id: stationUri(processName) },
  };

  return {
    '@context': EPCIS_CONTEXT,
    type: 'EPCISDocument',
    schemaVersion: '2.0',
    creationDate: creationDate ?? new Date().toISOString(),
    epcisBody: {
      eventList: [event],
    },
  };
}
