/**
 * Async Promote Queue — utils.
 *
 * Mirrors `async-lift-publisher-utils.ts` / `async-lift-control-plane.ts`:
 * the predicate URIs, RDF (de)serialisation helpers, and small pure
 * functions that the queue impl shares with the tests. The impl writes
 * each `PromoteJob` as RDF in a dedicated control graph (`graphUri`
 * configurable; defaults to `urn:dkg:promote-queue:control-plane`).
 *
 * The shape is denormalised: the full job is JSON-serialised into a
 * `payload` literal, and a handful of fields are also written as bare
 * predicates so the queue can issue cheap SPARQL filter queries
 * (state, contextGraphId, lease expiry, uniqueness key) without parsing
 * payloads server-side.
 */

import type { Quad, QueryResult } from '@origintrail-official/dkg-storage';
import type {
  PromoteJob,
  PromoteJobState,
  PromoteRequest,
} from './async-promote-queue-types.js';

export const DEFAULT_PROMOTE_CONTROL_GRAPH_URI = 'urn:dkg:promote-queue:control-plane';

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
export const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';

export const PROMOTE_JOB_TYPE = 'urn:dkg:promote-queue:Job';

export const PROMOTE_STATE = 'urn:dkg:promote-queue:state';
export const PROMOTE_PAYLOAD = 'urn:dkg:promote-queue:payload';
export const PROMOTE_CONTEXT_GRAPH_ID = 'urn:dkg:promote-queue:contextGraphId';
export const PROMOTE_SUB_GRAPH_NAME = 'urn:dkg:promote-queue:subGraphName';
export const PROMOTE_ASSERTION_NAME = 'urn:dkg:promote-queue:assertionName';
export const PROMOTE_ENQUEUED_AT = 'urn:dkg:promote-queue:enqueuedAt';
export const PROMOTE_UPDATED_AT = 'urn:dkg:promote-queue:updatedAt';
export const PROMOTE_NEXT_RETRY_AT = 'urn:dkg:promote-queue:nextRetryAt';
export const PROMOTE_LEASE_EXPIRES_AT = 'urn:dkg:promote-queue:leaseExpiresAt';
export const PROMOTE_CLAIM_TOKEN = 'urn:dkg:promote-queue:claimToken';
/**
 * Stable string that pins the per-assertion uniqueness key. Stored as a
 * literal so the queue can `FILTER ?key = "..."` cheaply. Format:
 * `<contextGraphId>\x1f<subGraphName>\x1f<assertionName>` (subGraphName
 * is `""` when absent). The separator is RFC 9457 unit separator —
 * unlikely to appear in any of the three components.
 */
export const PROMOTE_UNIQUENESS_KEY = 'urn:dkg:promote-queue:uniquenessKey';

/** Set of states that block a new enqueue for the same uniqueness key. */
export const ACTIVE_PROMOTE_STATES: readonly PromoteJobState[] = [
  'queued',
  'running',
  'failed_retrying',
];

export function jobSubject(jobId: string): string {
  return `urn:dkg:promote-queue:job:${jobId}`;
}

export function uniquenessKey(request: Pick<PromoteRequest, 'contextGraphId' | 'subGraphName' | 'assertionName'>): string {
  // Unit Separator U+001F — control char that's not legal in any of the
  // three identifier components. Keeps the key a single literal for
  // simple SPARQL equality filtering.
  return `${request.contextGraphId}\u001f${request.subGraphName ?? ''}\u001f${request.assertionName}`;
}

export function quad(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

export function iri(value: string): string {
  return `<${value}>`;
}

/**
 * Encode a JS string as a SPARQL/Turtle string literal — JSON.stringify
 * happens to produce exactly the format the daemon's SPARQL surface expects
 * for strings ("foo\nbar"). Mirrors `async-lift-control-plane.literal`.
 */
export function literal(value: string): string {
  return JSON.stringify(value);
}

export function integer(value: number): string {
  return `"${value}"^^<${XSD_INTEGER}>`;
}

export function boolean(value: boolean): string {
  return `"${value}"^^<${XSD_BOOLEAN}>`;
}

export function parseLiteral(value: string): unknown {
  return JSON.parse(value);
}

export function parseIntegerLiteral(value: string): number {
  const match = value.match(/^"(-?\d+)"(?:\^\^<[^>]+>)?$/);
  if (!match) throw new Error(`Invalid integer literal: ${value}`);
  return Number.parseInt(match[1] as string, 10);
}

export function expectBindings(result: QueryResult): Array<Record<string, string>> {
  if (result.type !== 'bindings') {
    throw new Error(`Expected SPARQL bindings result, got ${result.type}`);
  }
  return result.bindings;
}

/**
 * Serialise the job as RDF quads for the control graph. The full job is
 * stored as a JSON payload literal — the rest of the triples are
 * filter-and-sort helpers so SPARQL queries don't have to JSON.parse
 * every job to find e.g. the oldest queued one with `nextRetryAt <= now`.
 */
export function serializeJob(job: PromoteJob, graphUri: string): Quad[] {
  const subject = jobSubject(job.jobId);
  const quads: Quad[] = [
    quad(subject, RDF_TYPE, iri(PROMOTE_JOB_TYPE), graphUri),
    quad(subject, PROMOTE_STATE, literal(job.state), graphUri),
    quad(subject, PROMOTE_PAYLOAD, literal(JSON.stringify(job)), graphUri),
    quad(subject, PROMOTE_CONTEXT_GRAPH_ID, literal(job.request.contextGraphId), graphUri),
    quad(subject, PROMOTE_ASSERTION_NAME, literal(job.request.assertionName), graphUri),
    quad(subject, PROMOTE_UNIQUENESS_KEY, literal(uniquenessKey(job.request)), graphUri),
    quad(subject, PROMOTE_ENQUEUED_AT, integer(job.enqueuedAt), graphUri),
    quad(subject, PROMOTE_UPDATED_AT, integer(job.updatedAt), graphUri),
  ];
  if (job.request.subGraphName !== undefined) {
    quads.push(quad(subject, PROMOTE_SUB_GRAPH_NAME, literal(job.request.subGraphName), graphUri));
  }
  if (job.attempt.nextRetryAt !== undefined) {
    quads.push(quad(subject, PROMOTE_NEXT_RETRY_AT, integer(job.attempt.nextRetryAt), graphUri));
  }
  if (job.lease) {
    quads.push(quad(subject, PROMOTE_LEASE_EXPIRES_AT, integer(job.lease.expiresAt), graphUri));
    quads.push(quad(subject, PROMOTE_CLAIM_TOKEN, literal(job.lease.claimToken), graphUri));
  }
  return quads;
}

/**
 * Parse a `payload` binding back into a full `PromoteJob`. Returns null
 * if the literal is malformed (corrupted payload) — the queue logs and
 * skips such rows rather than crashing.
 */
export function parseJobPayload(binding: string | undefined): PromoteJob | null {
  if (!binding) return null;
  try {
    const payload = parseLiteral(binding);
    if (typeof payload !== 'string') return null;
    const parsed = JSON.parse(payload) as PromoteJob;
    if (!parsed.jobId || !parsed.state) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Default exponential backoff: 1m, 2m, 4m, 8m, 15m (cap). Caller passes
 * 1-indexed attempt count.
 */
export function defaultBackoffMs(attemptCount: number): number {
  const base = 60_000 * 2 ** Math.max(0, attemptCount - 1);
  return Math.min(base, 15 * 60_000);
}

/**
 * Stable sort key for queued/failed_retrying jobs: oldest `nextRetryAt`
 * (or `enqueuedAt` when no retry has been scheduled), then `jobId` as a
 * deterministic tie-breaker for same-millisecond enqueues.
 */
export function comparePromoteJobs(a: PromoteJob, b: PromoteJob): number {
  const aReady = a.attempt.nextRetryAt ?? a.enqueuedAt;
  const bReady = b.attempt.nextRetryAt ?? b.enqueuedAt;
  if (aReady !== bReady) return aReady - bReady;
  return a.jobId.localeCompare(b.jobId);
}
