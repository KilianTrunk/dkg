# SPEC — Async promote queue

**Status**: RFC (proposed). Not implemented.
**Date**: 2026-05-25
**Scope**: A durable, retryable, fire-and-forget queue for `WM → SWM` promotions, modelled on the existing `AsyncLiftPublisher` (SWM → VM).
**Related**:
- [ADR 0002 — Importer chunking contract](../adr/0002-importer-chunking-contract.md)
- [`packages/publisher/src/async-lift-publisher.ts`](../../packages/publisher/src/async-lift-publisher.ts) — the existing SWM → VM async machinery this proposal mimics
- [#596](https://github.com/OriginTrail/dkg/issues/596), [#602](https://github.com/OriginTrail/dkg/pull/602), [#642](https://github.com/OriginTrail/dkg/pull/642) — the Graphify-import experience that surfaced the need

---

## 0. TL;DR

The synchronous `POST /api/assertion/<name>/promote` call blocks the importer
for every promote — both on network IO (the daemon has to subtract finalized
quads, validate root URIs against the assertion's WM contents, and write to
SWM) and on contention with other writers. For a 10,000-partition import that's
10,000 promote calls in series, each adding 50-500 ms of round-trip latency on
top of the work the importer is doing.

The existing `AsyncLiftPublisher` already solves the analogous problem for the
**next** memory tier (`SWM → VM`): an importer enqueues a lift job, gets back
a job id, and queries the queue at its own cadence to check progress. The daemon
durably retries failed jobs across restarts, applies wallet-locking + claim
ordering, and exposes structured success/failure metadata.

This spec proposes a **direct analogue for `WM → SWM`** — `AsyncPromoteQueue` —
that lets importers fire-and-forget the promote step the same way they
fire-and-forget the publish step today. The expected wins are:

- **Throughput**: importers stop blocking on promotes; the daemon batches
  promote work in the background.
- **Resumability**: a promote that failed because the daemon restarted mid-call
  isn't lost — the queue persists across restarts (same durability story as
  `AsyncLiftPublisher`).
- **Symmetry**: the daemon's two outbound tier transitions follow the same
  shape (enqueue, status, recover), which simplifies importer code.

## 1. Motivation

### 1.1 The Graphify experience (PR #602)

The importer in PR #602 had a write loop roughly shaped like:

```
for each source file:
  create assertion
  write triples (5000-quad batches)
  promote (root URIs, sometimes thousands per assertion)
```

The promote step was the slowest per-iteration step (the daemon does
quad-subtraction + WM → SWM transfer + GraphManager bookkeeping inside the
synchronous request). On the throwaway 30k-file repository it tested against,
the cumulative promote latency dominated the import wall-clock.

The importer can't parallelize promotes across assertions safely (the daemon
serialises intra-assertion writes, and promote on one assertion can contend
with write on another). The importer can't skip the promote either —
unpromoted assertions never reach SWM and stay invisible to teammates.

The current escape hatch is "promote at the very end, as a single batch"
(passing every root URI to one promote). But that doesn't scale either:
the promote payload itself hits `MAX_BODY_BYTES`, and a single failed
promote at the end loses ALL of the import's intermediate progress (because
the WM assertions are still there but no peer has seen them).

### 1.2 The mirror with `AsyncLiftPublisher`

`AsyncLiftPublisher` already solved this for the next tier. Importers that
want to publish to VM don't block on a multi-minute on-chain transaction —
they enqueue a lift job, get a job id, and continue. The same shape applied
one tier earlier would let importers do the same for the WM → SWM step
without touching the existing sync promote API (sync stays available for
small / interactive use).

## 2. Non-goals

- **Replace `POST /api/assertion/<name>/promote`.** The sync route stays.
  Small / interactive importers prefer the synchronous answer-or-error
  shape; this spec adds an alternative, not a replacement.
- **Cross-CG batching.** Each enqueued promote targets one
  `(contextGraphId, assertionName)`. Multi-CG bulk promotes are out of
  scope (importers that want them can enqueue many jobs).
- **Promote-side validation changes.** The async path applies the same
  validation as the sync path; no relaxation of "root URI must exist in
  the assertion's WM body".

## 3. Proposal — surface

### 3.1 Enqueue

```http
POST /api/assertion/<name>/promote-async
{
  "contextGraphId": "<cg>",
  "subGraphName": "<sg>",
  "entities": [ "<root-uri>", ... ]
}
```

Response: `200 OK`

```json
{
  "jobId": "promote-job:01HXXXXXXXXXXXXXXXXX",
  "state": "queued",
  "enqueuedAt": "2026-05-25T13:00:00.000Z"
}
```

`entities` is bounded by the same `ROOT_CHUNK = 1000` budget as the sync
route (see ADR 0002). Larger root sets must be split client-side, the same
way they are today.

### 3.2 Status

```http
GET /api/assertion/promote-async/<jobId>
```

Response: `200 OK`

```json
{
  "jobId": "promote-job:01HXXXXXXXXXXXXXXXXX",
  "state": "queued | running | succeeded | failed",
  "contextGraphId": "<cg>",
  "assertionName": "<name>",
  "subGraphName": "<sg>",
  "enqueuedAt": "...",
  "startedAt": "...",
  "finishedAt": "...",
  "entitiesPromoted": 873,
  "lastError": { "code": "...", "message": "...", "retryable": true }
}
```

`state` transitions: `queued → running → (succeeded | failed)`. A failed
job carries `lastError.retryable: true` if the daemon will retry it
automatically; the operator can manually requeue any failed job via the
recovery route.

### 3.3 List + filter

```http
GET /api/assertion/promote-async?contextGraphId=<cg>&state=running,queued&limit=50
```

Response shape mirrors `/api/publisher/jobs` (the `AsyncLiftPublisher`
analogue).

### 3.4 Cancel / requeue

```http
DELETE /api/assertion/promote-async/<jobId>             # cancel queued
POST   /api/assertion/promote-async/<jobId>/recover     # requeue failed
```

`DELETE` only succeeds on `queued` state. `recover` is the explicit-retry
hook for failed jobs whose retry budget was exhausted.

## 4. Proposal — internals

### 4.1 Job model (sketch)

```ts
interface PromoteJob {
  jobId: string;                       // ULID-shaped
  contextGraphId: string;
  assertionName: string;
  subGraphName: string;
  entities: string[];
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  entitiesPromoted?: number;
  attempts: number;
  lastError?: { code: string; message: string; retryable: boolean };
}
```

Persisted in the daemon's `meta` sub-graph as RDF triples under a
`urn:dkg:promote-job:<id>` subject, same shape as `LiftJob` lives today.
The choice to persist via the assertion API (rather than a side-table)
gives us durability across restarts for free — the same atomic-write
guarantees that protect WM (#640) protect the queue.

### 4.2 Worker loop

A single `AsyncPromoteWorker` runs in-process inside the daemon (no
separate worker thread — promote is not CPU-bound). It:

1. Polls the queue for jobs in `queued` state, ordered by `enqueuedAt`.
2. For each job, transitions to `running`, calls the existing
   `assertion.promote(...)` logic internally (the SAME code path the sync
   route uses — we share implementation, not just shape), and writes
   `succeeded` or `failed` based on the result.
3. On `failed`, applies exponential backoff (matches
   `AsyncLiftPublisher`'s policy) and requeues until
   `attempts >= maxAttempts` (default 5). Then marks `failed` permanently,
   requiring an explicit `recover` to retry.
4. Concurrency: at most N (default 4) running jobs per daemon, matching
   the ADR 0002 "max concurrent assertions" guidance. The worker doesn't
   intra-assertion parallelise (still 1 promote per assertion at a time).

### 4.3 Failure modes + recovery

- **Daemon crash mid-job**: the job is still `running` in the persisted
  store. On startup, the worker scans for `running` jobs older than
  `runningTimeoutMs` (default 60s) and transitions them back to `queued`
  for a fresh attempt. The same recovery pattern `AsyncLiftPublisher`
  already implements.
- **Permanent failure** (e.g. an assertion that was discarded between
  enqueue and run): mark `failed` with `retryable: false`. Surface
  through `GET /api/assertion/promote-async/<jobId>` with a structured
  `code: 'assertion_not_found'` etc.
- **Queue saturation**: if the queue grows beyond a configured limit
  (default 10k jobs), `POST /api/assertion/<name>/promote-async` returns
  `503 Service Unavailable` with a `Retry-After` header. Importers handle
  this the same way they handle 413 (see ADR 0002): back off and retry.

## 5. Importer pattern

```ts
import { DkgClient } from './scripts/lib/dkg-daemon.mjs';
import { createImportManifest, markPartitionStatus } from './scripts/lib/manifest.mjs';

const client = new DkgClient({ ... });
const jobs = new Map(); // partitionKey → jobId

for (const part of partitions) {
  const assertionName = `import-${part.slug}`;
  await client.request('POST', '/api/assertion/create', { contextGraphId, name: assertionName, subGraphName });
  await client.writeAssertion({ contextGraphId, assertionName, subGraphName, triples: triplesFor(part) });
  const { jobId } = await client.request('POST', `/api/assertion/${assertionName}/promote-async`, {
    contextGraphId,
    subGraphName,
    entities: rootUrisFor(part),
  });
  jobs.set(part.key, jobId);
  await markPartitionStatus({ client, importId, partitionKey: part.key, status: 'promote_enqueued', subGraphName: 'meta' });
}

// Poll outstanding jobs once per minute until they all settle.
while (jobs.size > 0) {
  await sleep(60_000);
  for (const [key, jobId] of jobs) {
    const status = await client.request('GET', `/api/assertion/promote-async/${jobId}`);
    if (status.state === 'succeeded') {
      await markPartitionStatus({ client, importId, partitionKey: key, status: 'done', subGraphName: 'meta' });
      jobs.delete(key);
    } else if (status.state === 'failed') {
      await markPartitionStatus({ client, importId, partitionKey: key, status: 'failed', subGraphName: 'meta' });
      jobs.delete(key);
    }
  }
}
```

The importer never blocks on a single slow promote. If the daemon
restarts mid-import, both the manifest (PR #642) and the promote queue
survive — the importer just keeps polling.

## 6. Open questions

1. **Cross-importer fairness.** If importer A enqueues 50k jobs and
   importer B enqueues 100 jobs, importer B can starve behind A.
   Options: FIFO (simple, the proposal above), per-importer round-robin
   (needs an importer identity, which we don't have today), or priority
   classes (operator-set). FIFO is the right v1; the others wait for a
   problem report.

2. **Drain semantics on shutdown.** Two options:
   - **Wait for running jobs to finish.** Cleanest, but a 5-min running
     job blocks `dkg stop` for 5 min. Bad for ops.
   - **Mark running → queued + exit.** Some jobs run twice. The promote
     operation is idempotent (writing the same triples to SWM twice is a
     no-op), so this should be safe. Pick this.

3. **Worker count tuning via `/api/status`.** The same `importLimits`
   hint added in ADR 0002 should grow a `promoteWorkerConcurrency` field
   so importers know the daemon's capacity. Non-binding hint, like the
   chunk values.

4. **Sync `/promote` keeps working unchanged.** Confirm with reviewers
   that we're not deprecating the sync route — small importers still
   prefer the inline answer-or-error shape.

## 7. Rejected alternatives

- **"Just parallelise sync `/promote` from the client side."** Doesn't
  help — the daemon serialises the work anyway, and client-side
  concurrency just inflates retry-on-collision noise.

- **"Add a `batched` flag to sync `/promote` that internally chunks."**
  Hides the chunking from the importer but doesn't solve the blocking
  problem (the request still doesn't return until everything is done).
  Also conflicts with the ADR 0002 "clients chunk" decision.

- **"Daemon-side promote-after-write hook."** The idea: when a write to
  an assertion completes, the daemon auto-promotes the roots it can
  infer. Two problems: (a) the daemon can't always infer the roots (the
  importer chose them), (b) failure surfaces become invisible to the
  importer. Rejected.

## 8. Out of scope (for the implementation PR)

- A UI for the queue. The `/api/assertion/promote-async` routes are the
  v1 surface; if a UI is wanted, that's a separate PR.
- Cross-daemon queue sharing. Each daemon owns its own queue.

## 9. Sequencing

This RFC is independent of #640 (WM persistence fix), #641 (ADRs), and
#642 (importer helpers). It does, however, **depend on #640 having
landed**: the queue's durability rests on WM-store persistence, and that
must be solid before we start persisting structured job state alongside
WM data.

Implementation work is intentionally NOT part of this PR. Sign-off on
the spec first; implementation follows in a subsequent PR sized to fit
under [`packages/publisher/src/async-lift-publisher-impl.ts`](../../packages/publisher/src/async-lift-publisher-impl.ts) (~1000 lines) — likely
a sibling `async-promote-queue-impl.ts` of similar size.
