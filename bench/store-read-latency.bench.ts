import { defineSuite } from 'esbench';
import {
  OxigraphStore,
  OxigraphWorkerStore,
  type Quad,
} from '../packages/storage/src/index.ts';
import { benchAsyncWithHooks } from './support/esbench-case-hooks.ts';

/**
 * Store read-latency benchmark — the signal that the rc.13 → rc.14 perf
 * regression (issue #939) was about and that the existing publish-async-get
 * suite cannot see (it runs against an in-memory mock client).
 *
 * It exercises the REAL Oxigraph triple store and measures the two read
 * shapes that hung on the live node when the daemon was saturated:
 *   - a trivial `LIMIT 1` scan (the UI's "is the store responsive?" probe), and
 *   - the production `getTotalTriples` `COUNT(*)` aggregate the 30s metrics
 *     collector runs (`packages/cli/src/daemon/lifecycle.ts`).
 *
 * Each is measured both on an idle store and while a sustained background
 * writer churns inserts/deletes — modelling the single-writer contention that
 * starved reads under sync/publish load (the exact thing the opt-in
 * out-of-process MVCC server in #938 is meant to relieve). A regression that
 * pushes read latency from milliseconds toward seconds shows up immediately in
 * the `(under write load)` cases relative to the `(idle)` baseline.
 *
 * Backends (env `DKG_BENCH_STORE_BACKENDS`, comma-separated):
 *   - `inprocess` (default) — `OxigraphStore`, no build step required.
 *   - `worker` — `OxigraphWorkerStore`, the production backend; requires
 *     `pnpm --filter @origintrail-official/dkg-storage build` first (it spawns
 *     a compiled worker artefact). Opt in with
 *     `DKG_BENCH_STORE_BACKENDS=inprocess,worker`.
 *
 * Store sizes via env `DKG_BENCH_STORE_SIZES` (default `1k,50k`).
 */

type Backend = 'inprocess' | 'worker';

interface ReadStore {
  insert(quads: Quad[]): Promise<void>;
  delete(quads: Quad[]): Promise<void>;
  query(sparql: string): Promise<unknown>;
  close(): Promise<void>;
}

const GRAPH = 'http://bench.dkg/g/store-read';
const READ_LIMIT1 = `SELECT ?s WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } } LIMIT 1`;
// Mirror the production `getTotalTriples` aggregate the 30s metrics collector
// runs (`packages/cli/src/daemon/lifecycle.ts`) VERBATIM — default graph UNION
// all named graphs — so the benchmark measures the real read shape rather than
// a graph-scoped approximation. The synthetic data lives in a named graph, so
// the `GRAPH ?g` branch carries the scan.
const READ_TOTAL_TRIPLES = 'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }';

// Bounded write churn: the background writer repeatedly inserts then deletes a
// fixed batch in a region disjoint from the pre-populated base, so it generates
// sustained write work WITHOUT drifting the store size (which would otherwise
// confound the COUNT-under-load measurement).
const CHURN_BATCH = 50;
const CHURN_OFFSET = 1_000_000_000;

const STORE_SIZES: Record<string, number> = { '1k': 1_000, '10k': 10_000, '50k': 50_000, '200k': 200_000 };
const INSERT_CHUNK = 1_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function makeQuads(count: number, offset: number): Quad[] {
  const quads: Quad[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const n = offset + i;
    quads[i] = {
      subject: `http://bench.dkg/s/${n}`,
      predicate: `http://bench.dkg/p/${n % 16}`,
      object: `"value-${n}"`,
      graph: GRAPH,
    };
  }
  return quads;
}

function resolveBackends(): Backend[] {
  const raw = process.env.DKG_BENCH_STORE_BACKENDS?.trim();
  if (!raw) return ['inprocess'];
  const known = new Set<Backend>(['inprocess', 'worker']);
  const requested = raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  for (const b of requested) {
    if (!known.has(b as Backend)) {
      throw new Error(`Unknown DKG_BENCH_STORE_BACKENDS entry "${b}". Expected: inprocess, worker`);
    }
  }
  return requested.length > 0 ? (requested as Backend[]) : ['inprocess'];
}

function resolveStoreSizeLabels(): string[] {
  const raw = process.env.DKG_BENCH_STORE_SIZES?.trim();
  const labels = raw ? raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean) : ['1k', '50k'];
  for (const label of labels) {
    if (!(label in STORE_SIZES)) {
      throw new Error(`Unknown DKG_BENCH_STORE_SIZES entry "${label}". Expected one of: ${Object.keys(STORE_SIZES).join(', ')}`);
    }
  }
  return labels;
}

function createStore(backend: Backend): ReadStore {
  // `worker` deliberately constructs without a try/catch: if the compiled
  // worker artefact is missing the adapter throws an actionable "run pnpm
  // build" error, which esbench surfaces as a clear scene failure rather than
  // silently benchmarking nothing.
  return backend === 'worker' ? new OxigraphWorkerStore() : new OxigraphStore();
}

export default defineSuite({
  params: {
    backend: resolveBackends(),
    storeSize: resolveStoreSizeLabels(),
  },
  baseline: {
    type: 'Name',
    value: 'read LIMIT 1 (idle)',
  },
  timing: {
    evaluateOverhead: false,
    iterations: 50,
    samples: 5,
    unrollFactor: 1,
    warmup: 1,
  },
  async setup(scene) {
    const backend = scene.params.backend as Backend;
    const sizeLabel = scene.params.storeSize as string;
    const quadCount = STORE_SIZES[sizeLabel];

    const store = createStore(backend);

    const churn = makeQuads(CHURN_BATCH, CHURN_OFFSET);
    let writerActive = false;
    let writerDone: Promise<void> | undefined;
    let writerError: unknown;

    const stopWriter = async (): Promise<void> => {
      if (!writerDone) return;
      writerActive = false;
      const done = writerDone;
      writerDone = undefined;
      // The loop captures its own failures into `writerError` (surfaced by the
      // workload / `startWriter`), so awaiting here never rejects.
      await done;
    };

    // ONE ordered teardown for the scene: stop the writer and await its loop
    // BEFORE closing the store, so an in-flight insert/delete can never race a
    // closed store/worker. esbench may run scene teardown hooks concurrently,
    // so all ordering lives inside this single callback. Registered up-front so
    // the store is still closed (and any worker thread terminated) even if the
    // population below throws.
    scene.teardown(async () => {
      try {
        await stopWriter();
      } finally {
        try {
          await store.close();
        } catch {
          /* best-effort close */
        }
      }
    });

    // Pre-populate the base graph the reads scan.
    for (let inserted = 0; inserted < quadCount; inserted += INSERT_CHUNK) {
      await store.insert(makeQuads(Math.min(INSERT_CHUNK, quadCount - inserted), inserted));
    }

    // Background writer for the `(under write load)` cases, scoped to each
    // loaded iteration (not to case-execution order) so a reordered or
    // newly-inserted case can never start it during an `(idle)` measurement:
    //   - `beforeIteration` (startWriter) AWAITS one full insert/delete cycle,
    //     so writes are provably in flight before the measured read begins
    //     (critical for the `worker` backend, where an insert is only queued to
    //     another thread).
    //   - a writer that dies is recorded in `writerError` and surfaced as a
    //     FAILED case — startWriter throws if it died before the first cycle,
    //     and the workload throws if it died mid-measurement — so a broken
    //     writer can never silently degrade an `(under write load)` case into a
    //     misleading idle read.
    //   - `afterIteration` (stopWriter) stops it.
    // The `(idle)` cases register no writer at all.
    const startWriter = async (): Promise<void> => {
      if (writerActive) return;
      writerActive = true;
      writerError = undefined;
      let signalFirstCycle!: () => void;
      const firstCycle = new Promise<void>((resolve) => { signalFirstCycle = resolve; });
      writerDone = (async () => {
        try {
          let signalled = false;
          while (writerActive) {
            await store.insert(churn);
            await store.delete(churn);
            if (!signalled) { signalled = true; signalFirstCycle(); }
          }
        } catch (err) {
          writerError = err;
        } finally {
          // Unblock the barrier even if the first cycle threw, so a writer
          // failure surfaces (below) instead of hanging the benchmark.
          signalFirstCycle();
        }
      })();
      await firstCycle;
      if (writerError !== undefined) {
        throw new Error(`background writer failed before its first write cycle: ${errorText(writerError)}`);
      }
    };

    benchAsyncWithHooks(scene, 'read LIMIT 1 (idle)', async () => {
      await store.query(READ_LIMIT1);
    }, {});

    benchAsyncWithHooks(scene, 'read getTotalTriples (idle)', async () => {
      await store.query(READ_TOTAL_TRIPLES);
    }, {});

    benchAsyncWithHooks(scene, 'read LIMIT 1 (under write load)', async () => {
      await store.query(READ_LIMIT1);
      if (writerError !== undefined) {
        throw new Error(`background writer died during the measurement: ${errorText(writerError)}`);
      }
    }, { beforeIteration: startWriter, afterIteration: stopWriter });

    benchAsyncWithHooks(scene, 'read getTotalTriples (under write load)', async () => {
      await store.query(READ_TOTAL_TRIPLES);
      if (writerError !== undefined) {
        throw new Error(`background writer died during the measurement: ${errorText(writerError)}`);
      }
    }, { beforeIteration: startWriter, afterIteration: stopWriter });
  },
});
