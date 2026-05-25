# WM persistence regression — bug report

**Status**: reproducible; cause identified by code review; fix scope sketched.
**Owner**: TBD. This report is a hand-off, not a fix.
**Filed in response to**: [issue #596](https://github.com/OriginTrail/dkg/issues/596),
[PR #602](https://github.com/OriginTrail/dkg/pull/602).
**Worktree**: `fix/graphify-import-issues` at `/Users/aleatoric/dev/dkg-graphify`.

## TL;DR

The V10 daemon's persistent triple store (`oxigraph-persistent` / `oxigraph-worker`
adapters in [`packages/storage/src/adapters/oxigraph.ts`](../../packages/storage/src/adapters/oxigraph.ts))
persists WM via a single best-effort 50 ms debounced full-file rewrite of
`<DKG_HOME>/store.nq`. Three problems compound:

1. **No flush on graceful shutdown.** `agent.stop()` (around
   [`packages/agent/src/dkg-agent.ts:13895`](../../packages/agent/src/dkg-agent.ts))
   never calls `store.close()` or `store.flush()`. On `dkg stop` / `POST
   /api/shutdown` / SIGTERM, writes from the last 50 ms before exit are NOT
   guaranteed to reach disk.
2. **No atomic write, no fsync.** `flushNow()` does a `writeFile(path, dump)`
   — full rewrite. With ~1M triples that's ~150 MB; a kill mid-write leaves
   `store.nq` torn. `writeFile` is also page-cache-only — no `fsync`.
3. **Silent corruption swallow.** `hydrateSync()` catches *any* parse error
   on startup and starts empty. A partially-written `store.nq` becomes "data
   gone" with no operator-facing signal.

The catastrophic failure mode in PR #602 (large WM import lost across a
restart) is the union of (1) and (2). The repro script can drive both.

## Reproduce

The repro lives at
[`scripts/repro/wm-persistence-regression.mjs`](../../scripts/repro/wm-persistence-regression.mjs)
and is gated behind the worktree's isolation contract
([`REPRO.md`](../../REPRO.md)) — it refuses to talk to port 9200, refuses to
touch a daemon whose PID file it does not own, and runs against an isolated
`$DKG_HOME` only.

```sh
# One-time, against the repro DKG_HOME:
DKG_HOME=/Users/aleatoric/dev/dkg-graphify/.dkg-repro \
DKG_API_PORT=54293 \
dkg init

# Single-cell run (defaults: N=5, M=1000, restart=clean, pause=0ms):
DKG_HOME=/Users/aleatoric/dev/dkg-graphify/.dkg-repro \
DKG_API_PORT=54293 \
node scripts/repro/wm-persistence-regression.mjs \
  --num-assertions=50 --quads-per-assertion=20000 --restart-mode=kill

# Full matrix (clean × kill × small/medium/large × pause-0/pause-30s):
DKG_HOME=/Users/aleatoric/dev/dkg-graphify/.dkg-repro \
DKG_API_PORT=54293 \
node scripts/repro/wm-persistence-regression.mjs --matrix
```

The script writes a structured JSON report under `.dkg-repro-reports/`.

## Observed thresholds

The 12-cell matrix run (`--matrix` flag of the repro script) writes a fresh
context graph per cell against the same single shared `store.nq` and
restarts the daemon between cells, mirroring the load pattern of a typical
day's importer churn. Results are written to
`.dkg-repro-reports/matrix-<ts>.json`. The matrix snapshot that drove this
report (`matrix-20260525-092823.json`) is not committed — it's a 545-line
forensic dump and the actionable result is the table below. Re-run
`node scripts/repro/wm-persistence-regression.mjs --matrix` to regenerate.

| Triples written | Restart        | Pause | Pre-stop | Post-restart | Lost      | Mode                                         |
|-----------------|----------------|-------|----------|--------------|-----------|----------------------------------------------|
| 5 000 (5 × 1k)  | clean shutdown | 0 ms  | 5 000    | 5 000        | 0         | survives                                     |
| 125 000 (25×5k) | clean shutdown | 0 ms  | 125 000  | 125 000      | 0         | survives                                     |
| 1 000 000 (50×20k) | clean shutdown | 0 ms | 1 000 000 | **0**        | **1 000 000** | **TORN-FILE CORRUPTION — whole store gone**   |
| 5 000           | clean shutdown | 30 s  | 5 000    | 5 000        | 0         | survives                                     |
| 125 000         | clean shutdown | 30 s  | 125 000  | **110 000**  | **15 000** | **WINDOW LOSS — 3 trailing assertions lost** |
| 1 000 000       | clean shutdown | 30 s  | 1 000 000 | **0**       | **1 000 000** | **TORN-FILE CORRUPTION**                     |
| 5 000           | SIGKILL        | 0 ms  | 5 000    | 5 000        | 0         | survives                                     |
| 125 000         | SIGKILL        | 0 ms  | 125 000  | **115 000**  | **10 000** | **WINDOW LOSS — 2 trailing assertions lost** |
| 1 000 000       | SIGKILL        | 0 ms  | 1 000 000 | **0**       | **1 000 000** | **TORN-FILE CORRUPTION**                     |
| 5 000           | SIGKILL        | 30 s  | 5 000    | 5 000        | 0         | survives                                     |
| 125 000         | SIGKILL        | 30 s  | 125 000  | 125 000      | 0         | survives (cumulative store already churned)  |
| 1 000 000       | SIGKILL        | 30 s  | n/a      | n/a          | n/a       | **harness error — daemon never came back up; consistent with corrupted store on next hydrate** |

**Summary**:

- **5 k triples, all configurations: 0 loss.** The 50 ms debounce + the
  daemon's 100 ms /api/shutdown grace are both larger than the write
  workload's settle time, so the last flush always lands.
- **125 k triples: loss is non-deterministic** — the same workload survives
  pause-0 on clean stop but loses 15 k on pause-30. The reproducibility
  depends on cumulative store size (each cell inherits the prior cell's
  on-disk state) because the dump-and-rewrite cycle scales with that total,
  widening the race window for later cells.
- **1 M triples: catastrophic.** Three of four cells reload as a completely
  empty store. The fourth (kill + pause-30) errored out trying to spawn the
  next daemon — consistent with a corrupted `store.nq` causing the daemon
  to fail to come up cleanly. Either way the failure is total.
- **`/api/sub-graph/list` returns `null` in every catastrophic case** —
  the route fails (HTTP error swallowed by the repro script's `try/catch`),
  meaning the daemon hydrated empty AND the sub-graph metadata is missing,
  exactly the silent-empty-store path from
  [`oxigraph.ts:44`](../../packages/storage/src/adapters/oxigraph.ts).

The repro is reliable. Threshold for partial loss starts around **125 k
triples** depending on cumulative store size; threshold for **total loss**
is around **1 M triples** (~150 MB on-disk `store.nq`).

### Confound: `dkg start --foreground` supervisor auto-restart

While cleaning up after the matrix, six leftover `daemon-foreground-worker`
processes were still alive (all on the same `DKG_HOME=.dkg-repro` and all
holding `store.nq` open) — one per `--restart-mode=kill` cell, plus a
straggler from the matrix's spawn cycle. They had to be `kill -9`'d by hand.

Root cause of the zombies: `dkg start --foreground` runs
`runForegroundSupervisor()`, which **respawns** the underlying
`daemon-foreground-worker` whenever it exits. When the repro script
SIGKILL's the worker PID it read from `daemon.pid`, the supervisor sees the
exit and immediately re-launches the worker against the same `store.nq`
slot. The script then does its post-restart snapshot against the
auto-restarted worker rather than against its own freshly-spawned daemon.

For the catastrophic-loss cells (large at 1 M triples) this means the
failure mode is the union of (a) the dump-and-rewrite race documented
above AND (b) **two daemons holding `store.nq` open at the same time** —
the supervisor's restarted worker hydrates from `store.nq` while the
script's `spawnDaemon()` may also be coming up against the same file. The
1 M-triple "torn-file corruption" finding likely overstates how easily
the bug fires in a single-daemon setup; conversely, an operator who is
*supposed to be* running only one daemon should never see two workers
fighting over the same file in the first place.

**Recommendation for the fix author**: re-run the repro with either
`dkg start` (detached mode + clean `dkg stop`) instead of `--foreground`,
OR adjust the repro script to terminate the supervisor parent *before*
the worker so the restart loop can't kick in. The current matrix proves
the bug exists at all; a clean rerun against a single-daemon setup is
needed to characterise the threshold without the supervisor amplifying
the race.

This caveat does NOT undermine the four primary causes identified below.
Causes (A)–(D) (no flush on shutdown, non-atomic write, swallowed
corruption, no worker close) are visible from code inspection alone and
would still fire in the absence of any supervisor confound.

## Failure-mode taxonomy

Four distinct ways the on-disk state can disagree with what was last
written, ordered by severity:

1. **Window loss** (most common, both clean stop and SIGKILL).
   Last writes before exit never made it to disk because the 50 ms debounce
   timer hadn't fired *and* nothing in the shutdown path forces a flush.
   Symptom: post-restart triple count is some prefix of the pre-stop count;
   `store.nq` is a clean, valid file just missing the tail.
2. **Race loss** (concurrent inserts during an in-flight flush).
   `flushNow()` early-returns if `flushing === true`. While a previous flush
   is dumping (which can take seconds for ~1M triples), the timer for the
   next batch fires, hits the `flushing` guard, and never reschedules
   itself. Those writes are persisted only if a *later* insert kicks
   `scheduleFlush()` again — if none does, they sit in memory until the
   next process death takes them out.
   Symptom: gaps in the middle of the assertion list, not a clean tail
   truncation.
3. **Torn-file corruption** (SIGKILL during write, or OOM kill during a
   large `writeFile`).
   The dump is rewriting the entire `store.nq` in place. A kill mid-write
   leaves a file truncated to the new length but with bytes from both the
   old and the new dump interleaved (the kernel `write(2)` lands page by
   page). On restart, `oxigraph.Store.load()` throws on the malformed
   N-Quads line.
   Symptom: the catch at
   [`oxigraph.ts:44`](../../packages/storage/src/adapters/oxigraph.ts)
   swallows the parse error and the store comes up empty. **Whole-store
   loss with no log line.**
4. **Worker-thread orphaning** (default backend `oxigraph-worker`).
   The default daemon backend ([`dkg-agent.ts:1414`](../../packages/agent/src/dkg-agent.ts))
   runs `OxigraphStore` in a separate worker thread. The parent
   `agent.stop()` does `await this.node.stop()` but never sends a
   `close`/`flush` RPC to the worker. The worker dies when the parent
   exits, taking its 50 ms debounce timer with it.
   Symptom: identical to (1) but worse — even the writes that COULD have
   been captured by the debounce timer in the in-process variant are lost
   because the worker never gets a chance to run the timer callback.

## Hypothesised root cause

Three concrete primary-cause sites in
[`packages/storage/src/adapters/oxigraph.ts`](../../packages/storage/src/adapters/oxigraph.ts):

**(A) — `flushNow()` uses non-atomic, non-durable `writeFile`** (lines 60–72):

```ts
private async flushNow(): Promise<void> {
  if (!this.persistPath || this.flushing) return;
  this.flushing = true;
  try {
    await mkdir(dirname(this.persistPath), { recursive: true });
    const nquads = this.store.dump({ format: 'application/n-quads' });
    await writeFile(this.persistPath, nquads, 'utf-8');
  } catch {
    // Best-effort persistence.
  } finally {
    this.flushing = false;
  }
}
```

Non-atomic (in-place overwrite), no `fsync`, and the `catch` block silently
swallows write failures.

**(B) — `scheduleFlush()` + `flushNow()` can drop concurrent writes** (lines 49–72):

```ts
private scheduleFlush(): void {
  if (!this.persistPath || this.flushTimer) return;
  this.flushTimer = setTimeout(() => {
    this.flushTimer = null;
    this.flushNow();         // ← no retry if this early-returns
  }, 50);
}
```

When the timer's `flushNow()` early-returns (because the previous flush is
still in progress), there's no re-arm. The next `scheduleFlush()` call from
an insert that lands during the window WILL set a new timer, but that
timer's `flushNow()` runs against `this.store`'s *current* snapshot — which
already includes the writes — so coverage depends on the precise interleave.
In the worst case (no further inserts arrive between flush completion and
process death), the pending writes never reach disk.

**(C) — `hydrateSync()` swallows torn-file corruption** (lines 37–47):

```ts
private hydrateSync(filePath: string): void {
  try {
    if (!existsSync(filePath)) return;
    const data = readFileSync(filePath, 'utf-8') as string;
    if (data.trim()) {
      this.store.load(data, { format: 'application/n-quads' });
    }
  } catch {
    // File missing or corrupt — start empty.
  }
}
```

A corrupt `store.nq` becomes silent empty-store with no log line, no
sidecar `.corrupt` rename, no operator alarm.

**(D) — Daemon shutdown path never flushes** (in
[`packages/agent/src/dkg-agent.ts`](../../packages/agent/src/dkg-agent.ts)
around line 13895 and
[`packages/cli/src/daemon/lifecycle.ts`](../../packages/cli/src/daemon/lifecycle.ts)
around line 1920):

```ts
// lifecycle.ts
async function shutdown(exitCode = 0) {
  // ... clear timers, stop publisher, server.close() ...
  await agent.stop();                  // ← stops libp2p; no store touched
  dashDb.close();
  await removePid();
  await removeApiPort();
  process.exit(exitCode);              // ← exits before any 50ms flush settles
}

// dkg-agent.ts
async stop(): Promise<void> {
  if (!this.started) return;
  // ... stop pollers, timers, libp2p node ...
  await this.node.stop();
  // (no store.close(), no store.flush())
  this.started = false;
}
```

And the API-driven graceful-stop hits the same problem from one layer up
([`packages/cli/src/daemon/routes/status.ts:828`](../../packages/cli/src/daemon/routes/status.ts)):

```ts
if (req.method === "POST" && path === "/api/shutdown") {
  jsonResponse(res, 200, { ok: true });
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
  return;
}
```

The 100 ms gap before SIGTERM is not enough to:
- Wait for an in-flight 1M-triple dump (hundreds of ms to seconds).
- Trigger a fresh 50 ms debounce + finish that dump + finish the SIGTERM
  handler chain.

So the failure shape coalesces to: **the daemon does not consider WM
persistence a synchronous step of graceful shutdown.**

## Suggested fix shape

In rough priority order:

1. **Wire `store.close()` into the shutdown path.** Two-line change in
   `dkg-agent.ts:stop()` plus making sure the `TripleStore` reference is
   reachable on the agent instance. `OxigraphStore.close()` already does
   the right thing (cancels the timer, runs a final `flushNow()`) — it just
   isn't called.

2. **Make `flushNow()` atomic + durable.** Replace `writeFile(persistPath,
   dump)` with:
   - `writeFile(persistPath + '.tmp', dump, { flag: 'w' })`
   - Open `persistPath + '.tmp'` with `fs.open`, call `fsync()`, close.
   - `rename(persistPath + '.tmp', persistPath)` (atomic on POSIX).
   - `fsync` the containing directory inode so the rename is durable.

   With this in place, even a SIGKILL during a flush leaves `store.nq`
   intact at its last good state (the partial `store.nq.tmp` is ignored on
   load).

3. **Stop swallowing hydrate failures silently.** On load error: log
   loudly, rename `store.nq` to `store.nq.corrupt-<ts>` for forensics, and
   surface the failure through a `/api/status` health field so the operator
   isn't reasoning blind.

4. **Re-arm the flush on the post-flush trailing edge.** Inside
   `flushNow()`'s `finally` block, check whether new writes have arrived
   since the dump's snapshot (e.g. `this.store.size !== snapshotSize`) and
   immediately call `scheduleFlush()` to capture them.

5. **Plumb `flush()` into the assertion-write API.** Optional, but the
   right hook for importers that need durability: extend
   `POST /api/assertion/:name/write` (and `POST /api/assertion/:name/finalize`)
   with a `{ "durable": true }` flag that awaits `tripleStore.flush()`
   before returning. The bulk write path stays cheap; durability is
   opt-in. Both Graphify-style importers and the new
   `packages/dkg-importer-helpers` package (Phase 3) would use it.

6. **Long-term: replace the dump-to-flat-file scheme.** A single-file
   in-memory store hydrated from N-Quads is at the heart of the brittleness
   here. A append-only journal (write each `insert()` batch to a log,
   compact periodically) or moving to `oxigraph.Store` with native RocksDB
   persistence would eliminate (A) and (B) entirely. Out of scope for the
   minimal-cost fix but worth flagging in the follow-up.

## Why this report includes a repro but not a fix

Per the worktree's plan (`/Users/aleatoric/.cursor/plans/graphify_import_fixes_76f245c5.plan.md`,
Phase 1 scope guardrail): _"do NOT edit anything in `packages/storage/` or
`packages/agent/` this round."_ Those are the heavily-co-edited zones for
the parallel SWM-promotion agent on `feat/cg-memory-model`. The fix surface
(items 1, 2, 4 above) lives squarely in those zones. The fix belongs in a
follow-up branched off `main` after both this branch and the SWM-promotion
branch have landed, to minimise merge-time pain.
