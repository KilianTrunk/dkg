#!/usr/bin/env node
// EPCIS-on-DKG demo orchestration: Acme Bikes Assembly Line W18, one trace, 7 events.
//
//   node run.mjs           Human-readable guided tour
//   node run.mjs --json    NDJSON, one line per phase step (agent-friendly)
//
// Assumes:
//   - DKG daemon is running (`dkg start`)
//   - Either `dkg` is on PATH with the epcis subcommand, or the local
//     packages/cli/dist/cli.js build is available (auto-detected).

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import * as fmt from './lib/format.mjs';
import { EPCIS_CONTEXT } from './lib/epc-mapping.mjs';
import { OPENING, PHASE_INTROS, CLOSING } from './lib/narrative.mjs';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(SELF_DIR, 'fixtures');
const REPO_ROOT = resolve(SELF_DIR, '..', '..');
const LOCAL_CLI = join(REPO_ROOT, 'packages/cli/dist/cli.js');

const JSON_MODE = process.argv.includes('--json');
const NO_PAUSE = process.argv.includes('--no-pause');
const SKIP_CG_CREATE = process.argv.includes('--skip-cg-create');

// Default CG name auto-suffixes a per-run base36 timestamp so naive
// `node run.mjs` invocations never collide with prior runs against the
// same daemon. The ETL produces deterministic UUIDv5 eventIDs seeded by
// (trace_id, unit_id, ended) — see lib/epc-mapping.mjs `eventId()` —
// which means re-capturing into a CG that already holds the demo data
// hits publisher duplicate-root rejection on every event from the
// second run onward and surfaces as a confusing mid-Phase-1 failure.
// Pin a stable name via `EPCIS_DEMO_CG=<name>` when iterating Phase 7
// verifications against the same data set across runs (and accept the
// duplicate-root rejection if the prior run's data is still there).
const DEFAULT_CG_INPUT = `dmaast-bike-demo-${Date.now().toString(36)}`;
const CG_INPUT = process.env.EPCIS_DEMO_CG ?? DEFAULT_CG_INPUT;
const CG_INPUT_AUTO_GENERATED = !process.env.EPCIS_DEMO_CG;
const SUB = 'bike-line';
// `ALLOWED_PEER` defaults to a synthetic value but is replaced at runtime
// with the second devnet node's real libp2p peerId when one is reachable
// (so the access-handler grant actually corresponds to a real peer and
// Phase 7's cross-node verification can distinguish grantee vs not).
const SYNTHETIC_PEER = 'urn:peerId:kit-researcher-demo';
let ALLOWED_PEER = SYNTHETIC_PEER;
const peerIsSynthetic = () => ALLOWED_PEER === SYNTHETIC_PEER;
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;
// Optional second devnet node — used in Phase 7 for cross-node read
// verification. When NODE2_DKG_HOME is unset or the daemon is unreachable,
// Phase 7 prints a "skipped" notice rather than failing.
const NODE2_DKG_HOME =
  process.env.NODE2_DKG_HOME ??
  resolve(REPO_ROOT, '.devnet', 'node2');

// `CG_ID` holds the canonical, fully-resolved context-graph identifier. When
// the user passes a bare name (no `/`), the daemon auto-prefixes it with the
// agent address (e.g. `0xabc.../dmaast-bike-demo`). Phase 0 parses the
// `context-graph create` output and updates these. Both CLI commands AND
// SPARQL graph URIs must use the resolved form — the EPCIS plugin's
// `ContextGraphNotFound` lookup is exact-match.
let CG_ID = CG_INPUT;
let CG_URI = `did:dkg:context-graph:${CG_ID}`;

// Verification flags threaded into the Phase 7 visibility table. Set to
// true only when the corresponding earlier phase actually returned data
// (events for owner reads; bindings for the meta-graph grant probe).
let phase3bOwnerOk = false;
let phase4bOwnerOk = false;
let phase6GrantOk = false;

// `--skip-cg-create` bypasses the canonical-ID resolution path in Phase 0.
// If `EPCIS_DEMO_CG` is a bare name (no `/`), `CG_ID` stays as-is and every
// downstream call (`create-sub-graph`, `epcis capture/query`) hits the
// daemon's exact-match lookup with the wrong shape and fails. Refuse skip
// mode unless the caller has already passed the fully-qualified ID.
if (SKIP_CG_CREATE && !CG_INPUT.includes('/')) {
  const skipBareNameMsg =
    '--skip-cg-create requires EPCIS_DEMO_CG to be the fully-qualified CG ID ' +
    '(e.g. "0xabc.../dmaast-bike-demo"), not a bare name. Skip mode bypasses ' +
    'the auto-resolution that turns bare names into canonical IDs.';
  if (JSON_MODE) {
    // Surface the error as a single NDJSON record so machine consumers
    // see a parseable line instead of plain stderr text. Without this,
    // `node run.mjs --json --skip-cg-create=…<bare>` would emit only
    // human-readable stderr and an exit code, breaking the advertised
    // NDJSON contract before the first phase even runs.
    process.stdout.write(
      `${JSON.stringify({ error: skipBareNameMsg, code: 'skip-cg-create-bare-name' })}\n`,
    );
  } else {
    process.stderr.write(`${skipBareNameMsg}\n`);
  }
  process.exit(2);
}

let CLI;

async function detectCli() {
  // Probe the local build the same way as the global CLI rather than
  // trusting `existsSync` alone. `dist/cli.js` can exist but be stale or
  // partially generated (incremental tsc fails mid-compile, leaving an
  // unrunnable bundle); without this probe the demo hard-fails even when
  // a working global `dkg` is installed. Falling back to the global CLI
  // when the local build can't even print `--help` keeps the demo
  // runnable in that scenario.
  if (existsSync(LOCAL_CLI)) {
    const localProbe = spawnSync('node', [LOCAL_CLI, 'epcis', '--help'], {
      stdio: 'pipe',
    });
    if (localProbe.status === 0) {
      return { cmd: 'node', baseArgs: [LOCAL_CLI], displayCmd: 'dkg' };
    }
  }
  const probe = spawnSync('dkg', ['epcis', '--help'], { stdio: 'pipe' });
  if (probe.status === 0) {
    return { cmd: 'dkg', baseArgs: [], displayCmd: 'dkg' };
  }
  throw new Error(
    'No CLI with `epcis` subcommand available.\n' +
      `Build the local CLI: \`pnpm -C ${REPO_ROOT}/packages/cli build\`.`,
  );
}

function runCli(args) {
  const fullArgs = [...CLI.baseArgs, ...args];
  const proc = spawnSync(CLI.cmd, fullArgs, { encoding: 'utf-8' });
  const out = (proc.stdout ?? '').trim();
  const err = (proc.stderr ?? '').trim();
  let parsed;
  if (out) {
    try {
      parsed = JSON.parse(out);
    } catch {
      // Non-JSON output is fine — keep stdout for display.
    }
  }
  const cmdString = `${CLI.displayCmd} ${args.join(' ')}`;
  return {
    exit: proc.status ?? -1,
    stdout: out,
    stderr: err,
    parsed,
    cmdString,
  };
}

// Resolve a daemon's bearer token from a DKG_HOME the same way
// `dkg auth show` does — config-pinned tokens (`config.auth.tokens[]`)
// AND file-backed tokens (`<DKG_HOME>/auth.token`) are both supported
// deployments. Reading auth.token as the only source breaks config-only
// setups (operators who disable file-backed auth and pin tokens via
// config) with a misleading "Cannot read daemon auth" even though the
// daemon is healthy and would accept a config-token request. Mirrors
// `packages/cli/src/auth.ts:loadTokens` precedence — config first, then
// file — so demo phases agree with `dkg auth show` on which tokens are
// valid.
async function resolveAuthToken(dkgHome) {
  const configPath = join(dkgHome, 'config.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(await readFile(configPath, 'utf-8'));
      const cfgTokens = cfg?.auth?.tokens;
      if (Array.isArray(cfgTokens)) {
        const t = cfgTokens.find((s) => typeof s === 'string' && s.length > 0);
        if (t) return t;
      }
    } catch {
      // Fall through to file-backed token below — a malformed config.json
      // is an operator problem, not a reason to give up on a daemon that
      // also has an auth.token file.
    }
  }
  try {
    return (await readFile(join(dkgHome, 'auth.token'), 'utf-8'))
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
  } catch {
    return undefined;
  }
}

// Read the daemon's port + bearer token from DKG_HOME (or ~/.dkg). Cached
// after first read because Phase 2 polls in tight loops and re-reading the
// auth file every poll round adds avoidable latency.
let _daemonAuth;
async function getDaemonAuth() {
  if (_daemonAuth) return _daemonAuth;
  const dkgHome = process.env.DKG_HOME ?? join(homedir(), '.dkg');
  const port = Number.parseInt(
    (await readFile(join(dkgHome, 'api.port'), 'utf-8')).trim(),
    10,
  );
  const token = await resolveAuthToken(dkgHome);
  if (!Number.isFinite(port) || !token) {
    throw new Error(`Cannot read daemon auth from ${dkgHome}`);
  }
  _daemonAuth = { baseUrl: `http://127.0.0.1:${port}`, token };
  return _daemonAuth;
}

// Direct GET against /api/epcis/capture/:id — avoids spawning a node
// process per status check. Phase 2 polls every capture every second; using
// `dkg epcis status` (spawnSync) costs ~300-500ms per call, so a single
// round was 5-8s of cold-starts. Switching to fetch+Promise.all drops a
// round to <100ms total.
async function fetchCaptureStatus(captureID) {
  const { baseUrl, token } = await getDaemonAuth();
  const res = await fetch(`${baseUrl}/api/epcis/capture/${encodeURIComponent(captureID)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  // Synthesize a terminal `http-error` state on non-2xx so polling callers
  // stop spinning until POLL_TIMEOUT_MS and instead surface the actual
  // cause (auth dropped, capture vanished, daemon 5xx). Without this, a
  // 401 / 404 / 500 makes `parsed?.state` undefined, the terminal check
  // fails, and the loop reports "didn't finalize within Ns" — attributing
  // an HTTP failure to a finalization timeout.
  if (!res.ok) {
    parsed = {
      ...(parsed ?? {}),
      state: 'http-error',
      error: parsed?.error
        ? `HTTP ${res.status}: ${parsed.error}`
        : `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
    };
  }
  return { status: res.status, body: text, parsed };
}

// Resolve the second devnet node's auth (port + token + baseUrl). Used by
// Phase 7 to verify cross-node visibility from a non-owner perspective.
// Returns null when node2 is not reachable so Phase 7 can degrade
// gracefully rather than fail the demo.
let _node2Auth;
async function getNode2Auth() {
  if (_node2Auth !== undefined) return _node2Auth;
  try {
    const port = Number.parseInt(
      (await readFile(join(NODE2_DKG_HOME, 'api.port'), 'utf-8')).trim(),
      10,
    );
    // Same config-aware token resolution as getDaemonAuth — node2 may
    // also be a config-tokens-only deployment. resolveAuthToken returns
    // undefined for "no token reachable", which we coerce to graceful
    // null below (Phase 7 degrades cleanly when node2 is unavailable).
    const token = await resolveAuthToken(NODE2_DKG_HOME);
    if (!Number.isFinite(port) || !token) {
      _node2Auth = null;
      return null;
    }
    _node2Auth = { baseUrl: `http://127.0.0.1:${port}`, token };
    return _node2Auth;
  } catch {
    _node2Auth = null;
    return null;
  }
}

// Probe node2's identity. Returns null if unreachable. Used both to verify
// Phase 7 has a second node available AND to thread node2's libp2p peerId
// into the Phase 6 allow-list grant so it corresponds to a real peer.
async function fetchNode2Identity() {
  const auth = await getNode2Auth();
  if (!auth) return null;
  try {
    const res = await fetch(`${auth.baseUrl}/api/status`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return { peerId: body.peerId, name: body.name };
  } catch {
    return null;
  }
}

// Subscribe node2 to a context graph. The gossip-publish-handler does
// auto-subscribe on ontology broadcasts (gossip-publish-handler.ts:177),
// but ONLY when node2 is connected to the gossip mesh at the moment
// node1 broadcasts the CG creation. On a fresh 2-node devnet that
// connection is not guaranteed, so node2 may never auto-subscribe and
// Phase 7's anchor probe stays empty even on an otherwise-healthy run.
// Calling subscribe explicitly is idempotent (existing subs return
// `{status: "done"}`) and ensures a deterministic baseline before any
// captures broadcast.
async function subscribeNode2ToCG(contextGraphId) {
  const auth = await getNode2Auth();
  if (!auth) return null;
  try {
    const res = await fetch(`${auth.baseUrl}/api/context-graph/subscribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contextGraphId, includeSharedMemory: true }),
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, body: text, parsed };
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
}

// Run a SPARQL query against node2 and return the bindings. Used by
// Phase 7 to inspect node2's local store.
//
// `contextGraphId` is set to the resolved demo CG, NOT the literal string
// `'all'`. The daemon's `/api/query` route forwards this value into
// `canReadContextGraph()` as an ACL probe and into the query engine as a
// scope/routing hint (packages/cli/src/daemon/routes/query.ts:553,
// packages/agent/src/dkg-agent.ts:3743). A literal `'all'` happens to
// pass today because no CG with that ID exists, but it makes the demo
// silently brittle: a future CG named `all` (or a routing change that
// wraps the SPARQL in `GRAPH <did:dkg:context-graph:all>`) would collapse
// every Phase 7 probe to zero rows. Pass the canonical CG_ID so the
// scope check and the SPARQL's explicit `GRAPH <…>` clauses agree.
async function node2Sparql(sparql) {
  const auth = await getNode2Auth();
  if (!auth) throw new Error('Node2 unreachable');
  const res = await fetch(`${auth.baseUrl}/api/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sparql, contextGraphId: CG_ID, includeSharedMemory: true }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  // Preserve `null` for unrecognized response shapes — defaulting to an
  // empty array would collapse "query failed / unexpected body" into
  // "zero results" and pass `Array.isArray()` checks in Phase 7's
  // querySucceeded() helper, defeating the verification.
  const bindings = Array.isArray(parsed?.result?.bindings)
    ? parsed.result.bindings
    : null;
  return {
    status: res.status,
    body: text,
    parsed,
    bindings,
    cmdString: `POST ${auth.baseUrl}/api/query  ${sparql.length > 80 ? sparql.slice(0, 77) + '...' : sparql}`,
  };
}

// emit a single step. opts: { preamble, kind, interpretation, quiet }.
//   preamble: 1-2 sentence prose shown BEFORE the command — what we're about
//             to do and why. The user sees this before output, not after.
//   kind: hint for how to format `result.parsed` — see lib/format.mjs's
//         summarizeJson(). When omitted, parsed JSON is dumped truncated.
//   interpretation: 1-line takeaway shown after the result.
//   quiet: when true, suppress preamble/output/interpretation in human mode
//          (for bulk progress lines like "captured event 5/17").
function emit(stepId, title, result, opts = {}) {
  if (typeof opts === 'string') opts = { interpretation: opts };
  const { preamble, kind, interpretation, quiet } = opts;

  if (JSON_MODE) {
    process.stdout.write(
      `${JSON.stringify({
        step: stepId,
        cmd: result.cmdString,
        exit: result.exit,
        stdout: result.parsed ?? result.stdout,
        stderr: result.stderr || undefined,
      })}\n`,
    );
    return;
  }
  if (quiet) return;
  fmt.step(stepId, title);
  if (preamble) fmt.preamble(preamble);
  fmt.command(result.cmdString);
  if (result.parsed !== undefined) {
    fmt.summarizeJson(result.parsed, kind);
  } else if (result.stdout) {
    fmt.output(result.stdout);
  }
  if (result.stderr) fmt.warn(result.stderr);
  if (interpretation) fmt.note(interpretation);
}

// Pause after a step finishes (human mode only). Use between commands within
// a phase so the user gets a beat to read each result before the next runs.
async function pauseAfter(label = 'Press Enter to continue…') {
  if (JSON_MODE || NO_PAUSE) return;
  await fmt.pauseFor(label);
}

// Surface a phase-level failure in BOTH modes without breaking the NDJSON
// contract. Without this, code paths that emit `fmt.fail`/`fmt.note`
// directly leak ANSI-colored prose into `--json` mode (machine consumers
// then fail to parse the line as JSON, dropping every step in the run).
// `details.note` is rendered as a `fmt.note` in human mode and folded into
// the JSON record as `note` in machine mode; arbitrary extra keys
// (e.g. `state`) are passed through to the JSON record verbatim.
function emitFail(stepId, message, details = {}) {
  const { note, ...rest } = details;
  if (JSON_MODE) {
    process.stdout.write(
      `${JSON.stringify({ step: stepId, fail: true, error: message, ...(note ? { note } : {}), ...rest })}\n`,
    );
    return;
  }
  fmt.fail(message);
  if (note) fmt.note(`  ${note}`);
}

// Soft-warning counterpart to emitFail. Use for non-terminal warnings
// (e.g. "lift didn't reach a terminal state in time, running verify
// anyway") that need the same JSON-mode safety: a bare fmt.warn in
// JSON mode prints human-readable text to stdout and breaks the
// NDJSON contract for the rest of the run.
function emitWarn(stepId, message, details = {}) {
  const { note, ...rest } = details;
  if (JSON_MODE) {
    process.stdout.write(
      `${JSON.stringify({ step: stepId, warn: true, message, ...(note ? { note } : {}), ...rest })}\n`,
    );
    return;
  }
  fmt.warn(message);
  if (note) fmt.note(`  ${note}`);
}

function header(text) {
  if (!JSON_MODE) fmt.header(text);
  else process.stdout.write(`${JSON.stringify({ phase: text })}\n`);
}

async function startPhase(intro) {
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify({ phase: intro.title })}\n`);
    return;
  }
  fmt.story(intro.title, intro.body);
  if (!NO_PAUSE) {
    const phaseLabel = intro.title.split(' — ')[0];
    await fmt.pauseFor(`Press Enter to start ${phaseLabel}…`);
  }
}

async function showOpening() {
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify({ opening: OPENING.title })}\n`);
    return;
  }
  fmt.story(OPENING.title, OPENING.body);
  if (!NO_PAUSE) await fmt.pauseFor('Press Enter to begin the demo…');
}

function showClosing() {
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify({ closing: CLOSING.title })}\n`);
    return;
  }
  fmt.story(CLOSING.title, CLOSING.body);
}

async function phase0() {
  await startPhase(PHASE_INTROS[0]);

  const status = runCli(['status']);
  if (status.exit !== 0) {
    // Throw rather than print + process.exit so `main().catch()` can
    // emit a structured JSON error in `--json` mode. A direct exit
    // here breaks NDJSON framing for machine consumers (the error
    // line is human-formatted and the catch block never runs).
    throw new Error(
      'DKG daemon is not responding. Start it with `dkg start`, then re-run this demo.',
    );
  }
  emit('phase-0-daemon', 'Daemon up', status, {
    preamble: 'First, sanity-check that the local DKG daemon is alive and accepting requests. Without it nothing else will work.',
    kind: 'fallback',
    interpretation: 'Daemon is responding.',
  });

  // Surface the resolved CG_INPUT once, here, so the user sees the
  // auto-suffixed default before Phase 0 starts creating it. Without
  // this, the auto-generated name (e.g. `dmaast-bike-demo-mz4hk7n0`)
  // would only appear in `context-graph create` output, several
  // emit() calls deeper — and a user re-running the demo to compare
  // outputs has no quick way to see what CG name they'd need to set
  // EPCIS_DEMO_CG to in order to reuse that CG. Skip in JSON mode
  // (the next emit already includes the CG name in its cmd record)
  // and skip when EPCIS_DEMO_CG is pinned (no surprise to surface).
  if (!JSON_MODE && CG_INPUT_AUTO_GENERATED) {
    fmt.note(
      `  Using auto-generated CG name "${CG_INPUT}" (per-run suffix). ` +
        `Pin via EPCIS_DEMO_CG=<name> to reuse the same CG across runs.`,
    );
  }

  // Probe node2 (second devnet node) early so the Phase 6 allow-list grant
  // can target a REAL peerId — without that, the grant is a literal
  // string that no real peer ever matches and Phase 7's enforcement
  // verification has nothing to enforce against. Best-effort: if node2
  // isn't reachable, we keep the synthetic peerId and Phase 7 prints a
  // "skipped" notice.
  const node2Ident = await fetchNode2Identity();
  if (node2Ident?.peerId) {
    ALLOWED_PEER = node2Ident.peerId;
    if (!JSON_MODE) {
      fmt.note(`  Detected second node "${node2Ident.name}" — peerId ${node2Ident.peerId.slice(0, 12)}…`);
      fmt.note('  Phase 6 grant will use this real peerId so Phase 7 can verify cross-node enforcement.');
    }
  } else if (!JSON_MODE) {
    fmt.note('  No second devnet node detected — Phase 7 (cross-node verification) will be skipped.');
  }
  await pauseAfter();

  if (!SKIP_CG_CREATE) {
    const cg = runCli(['context-graph', 'create', CG_INPUT]);
    const text = `${cg.stdout}\n${cg.stderr}`;
    const alreadyExists = /already exists|exists already/i.test(text);

    // Resolve the canonical CG ID (auto-prefixed with agent address if input
    // had no slash). Both code paths print it: new creation has a "URI:" line,
    // already-exists has the full ID in quotes. EPCIS_DEMO_CG (if set with a
    // slash) is honored as-is — only resolve if the daemon printed a form.
    const uriMatch = text.match(/did:dkg:context-graph:(\S+)/);
    const existsMatch = text.match(/Context graph\s+"([^"]+)"\s+already exists/);
    const resolved = uriMatch?.[1] ?? existsMatch?.[1];
    if (resolved) {
      CG_ID = resolved;
      CG_URI = `did:dkg:context-graph:${resolved}`;
    }

    emit('phase-0-cg', 'Ensure context graph exists', cg, {
      preamble: `Create (or reuse) the context graph "${CG_INPUT}" — this is the top-level namespace Acme owns. The daemon auto-prefixes bare names with the agent address; the canonical form is captured for the rest of the run.`,
      interpretation: alreadyExists
        ? `CG ${CG_ID} already exists — reusing.`
        : `Resolved canonical CG: ${CG_ID}`,
    });

    // Bail if `context-graph create` failed for a reason other than
    // "already exists". Without this gate a real failure (daemon
    // unreachable mid-call, validation error, malformed input) silently
    // drops through to `register` + `create-sub-graph`, which hit the
    // exact-match lookup with the wrong CG_ID and surface as misleading
    // "sub-graph not found" / "publisher cgId=0" errors several phases
    // later. Surface the actual root cause here.
    if (cg.exit !== 0 && !alreadyExists) {
      throw new Error(
        `Cannot proceed: \`context-graph create\` failed (exit ${cg.exit}). ` +
          (cg.stderr || '(no stderr)'),
      );
    }

    await pauseAfter();

    // The publish path (DKGPublisher.publish → V10 createKnowledgeAssetsV10)
    // requires a positive on-chain CG id from the ContextGraphs contract.
    // `context-graph create` only registers the CG over P2P; without
    // `context-graph register`, the publisher gets cgId=0 and every lift
    // fails with "V10 publishDirect requires a positive on-chain context
    // graph id; got 0". The 409 "already registered" path is treated as
    // success so the demo is idempotent across re-runs.
    const reg = runCli(['context-graph', 'register', CG_ID]);
    const regText = `${reg.stdout}\n${reg.stderr}`;
    const regAlready = /already registered/i.test(regText);
    const regOk = reg.exit === 0 || regAlready;
    emit('phase-0-cg-register', 'Register context graph on-chain', {
      ...reg,
      // Normalize exit so the summarizer/interpretation reflect the
      // idempotent-success semantics, not the raw CLI exit.
      exit: regOk ? 0 : reg.exit,
    }, {
      preamble:
        'On-chain registration is what unlocks Verified Memory: it asks the `ContextGraphs` contract to mint a numeric ID for this CG. The publisher needs that ID for V10 `publishDirect` — without it every lift fails with "got 0". This step costs a small amount of TRAC and produces a tx hash.',
      interpretation: regAlready
        ? `CG ${CG_ID} already registered on-chain — reusing.`
        : regOk
          ? 'CG is now registered on-chain. The publisher can now lift KCs onto the chain.'
          : 'On-chain registration failed — subsequent lifts will fail. See stderr.',
    });
    if (!regOk) {
      throw new Error(
        'Cannot proceed: context graph not registered on-chain. ' +
          'Common causes on devnet: no TRAC balance, contracts not deployed, ' +
          'or stale .devnet/hardhat/deployed marker.',
      );
    }
    await pauseAfter();
  }

  // Sub-graph must be registered before EPCIS captures targeting it can
  // enqueue. The CLI subcommand `context-graph create-sub-graph` lands the
  // call on the daemon and is idempotent: re-running prints
  // `Sub-graph "<name>" already exists ... — nothing to do.` and exits 0.
  const sg = runCli(['context-graph', 'create-sub-graph', CG_ID, SUB]);
  const sgAlready = /already exists/i.test(`${sg.stdout}\n${sg.stderr}`);
  emit('phase-0-sub-graph', 'Register sub-graph in context graph', sg, {
    preamble: `Now register the "${SUB}" sub-graph inside that CG. EPCIS captures must target an existing sub-graph or the publisher rejects them with \`EnqueueFailed\`.`,
    interpretation: sgAlready
      ? `Sub-graph ${SUB} already registered — reusing.`
      : `Sub-graph: ${SUB} (newly registered)`,
  });
  if (sg.exit !== 0) {
    throw new Error(`Cannot proceed without sub-graph ${SUB}: ${sg.stderr || '(no stderr)'}`);
  }
  await pauseAfter();

  // Explicitly subscribe node2 to the canonical CG_ID so Phase 7's
  // anchor-visibility probe is deterministic. Auto-subscribe via
  // gossip-publish-handler.ts:177 only fires when node2 happens to be
  // on the ONTOLOGY mesh at the instant node1 broadcasts the CG
  // creation — on a fresh 2-node devnet that's a race, and a missed
  // ontology gossip means node2 stays unsubscribed forever (capture-
  // path gossip targets the CG's own paranet, not ONTOLOGY, so it
  // doesn't trigger auto-subscribe). Idempotent: existing subs return
  // `status: "done"` immediately.
  if (node2Ident?.peerId) {
    const sub = await subscribeNode2ToCG(CG_ID);
    if (sub?.status === 200) {
      if (!JSON_MODE) {
        fmt.note(
          `  Node2 subscribed to ${CG_ID} (catchup: ${sub.parsed?.catchup?.status ?? 'n/a'}). ` +
            'Phase 7 anchor probe is now deterministic — gossip will reach node2 from Phase 1 onward.',
        );
      }
    } else if (!JSON_MODE) {
      fmt.warn(
        `  Failed to subscribe node2 to ${CG_ID} (status ${sub?.status ?? 'n/a'}: ${sub?.body ?? sub?.error ?? 'unknown'}). ` +
          'Phase 7 will fall back to the auto-subscribe path; results may be empty if gossip raced.',
      );
    }
    await pauseAfter();
  }

  const traceManifestPath = join(FIXTURES, 'trace-7c4f8d2a-bike-line.json');
  const trace = JSON.parse(await readFile(traceManifestPath, 'utf-8'));
  if (JSON_MODE) {
    process.stdout.write(
      `${JSON.stringify({ step: 'phase-0-fixture', fixture: { event_count: trace.event_count, stations: trace.stations.length, time_range: trace.time_range, trace_id: trace.trace_id } })}\n`,
    );
  } else {
    fmt.step('phase-0-fixture', 'Fixture summary');
    fmt.preamble('The fixture is one synthesized trace — every station event for one bicycle assembled on Acme Bikes Assembly Line W18.');
    fmt.note(
      `Events: ${trace.event_count} · Stations: ${trace.stations.length} · Item: ${trace.events[0].item_ids.join(',')}`,
    );
    fmt.note(`Time range: ${trace.time_range[0]} → ${trace.time_range[1]}`);
    await pauseAfter();
  }
  return trace;
}

async function phase1() {
  await startPhase(PHASE_INTROS[1]);

  const eventFiles = (await readdir(FIXTURES))
    .filter((f) => /^event-\d+-.*\.json$/.test(f))
    .sort();

  const captureIds = [];
  for (let i = 0; i < eventFiles.length; i += 1) {
    const file = eventFiles[i];
    const fullPath = join(FIXTURES, file);
    const r = runCli([
      'epcis', 'capture', fullPath,
      '--context-graph-id', CG_ID,
      '--sub-graph-name', SUB,
    ]);
    if (r.exit !== 0) {
      throw new Error(`Capture failed for ${file}: ${r.stderr || '(no stderr)'}`);
    }
    const captureID = r.parsed?.captureID;
    if (!captureID) {
      // Fail hard rather than silently skipping. A 0-exit response
      // without a captureID means the daemon returned an unexpected
      // shape (route changed, plugin downgraded, error body parsed as
      // success). Pushing nothing and continuing would make Phase 2's
      // poll loop see one fewer ID, the aggregate count would silently
      // miss this event, and the user would never learn the daemon
      // didn't actually accept the capture.
      throw new Error(
        `Capture for ${file} returned exit 0 but no captureID. ` +
          `Daemon response: ${JSON.stringify(r.parsed ?? r.stdout).slice(0, 300)}`,
      );
    }
    captureIds.push(captureID);

    // Show the FIRST capture in full detail so the user sees the 202+captureID
    // shape, then summarize the rest as one-liners — pausing per-capture would
    // be tedious. JSON mode emits each capture verbatim regardless.
    if (i === 0) {
      emit(
        `phase-1-capture-${file.replace('.json', '')}`,
        `Capture ${file} (showing first in detail)`,
        r,
        {
          preamble: `Each event is sent to the daemon as a complete EPCIS 2.0 ObjectEvent. The plugin returns 202 immediately with a captureID — lifting onto the chain happens asynchronously. We show the first capture in detail; the remaining ${eventFiles.length - 1} run silently below.`,
          kind: 'capture',
          interpretation: captureID ? `captureID: ${captureID}` : undefined,
        },
      );
      if (!JSON_MODE) await pauseAfter(`Press Enter to capture the remaining ${eventFiles.length - 1} events…`);
    } else if (JSON_MODE) {
      emit(`phase-1-capture-${file.replace('.json', '')}`, `Capture ${file}`, r, { kind: 'capture' });
    } else {
      fmt.note(`  · ${file} → ${captureID ? captureID.slice(0, 8) + '…' : 'no id'}`);
    }
  }
  if (!JSON_MODE) {
    console.log('');
    fmt.success(`Captured ${captureIds.length}/${eventFiles.length} events.`);
    await pauseAfter();
  }
  return captureIds;
}

async function phase2(captureIds) {
  await startPhase(PHASE_INTROS[2]);

  if (!JSON_MODE) {
    fmt.preamble(
      `Poll \`GET /api/epcis/capture/<id>\` for each of the ${captureIds.length} captures until every one has reached a terminal state (completed or failed). Each capture prints a one-liner as it finalizes — completions in green, failures in red. The first finalized capture's full response is shown after.`,
    );
    fmt.note('Polling…');
  }

  const start = Date.now();
  const final = new Map();
  let sampleShown = false;
  let sampleResult = null; // captured for the post-loop emit
  let lastTickReported = 0;

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const pending = captureIds.filter((id) => !final.has(id));
    if (pending.length === 0) break;

    // Poll the entire pending set in parallel. A round is bounded by the
    // slowest daemon response, not by 17×spawnSync cold-starts.
    const results = await Promise.all(pending.map((id) => fetchCaptureStatus(id)));

    let newlyFinalized = 0;
    for (let i = 0; i < pending.length; i += 1) {
      const id = pending[i];
      const r = results[i];
      const state = r.parsed?.state;
      // Publisher lift lifecycle: accepted → claimed → validated → broadcast
      // → included → finalized (success). `failed` is the error terminal.
      // Earlier "completed" was a misnomer — the EPCIS route passes through
      // the publisher's status verbatim, so the success terminal really is
      // "finalized". Anything else is still in progress.
      //
      // `http-error` is a synthetic terminal state injected by
      // fetchCaptureStatus when the daemon returned a non-2xx response —
      // treat it like `failed` so the loop breaks promptly with the HTTP
      // cause attributed correctly instead of timing out as "still pending".
      const isTerminal =
        state === 'finalized' || state === 'failed' || state === 'http-error';
      if (isTerminal) {
        final.set(id, { state, response: r.parsed });
        newlyFinalized += 1;
        if (!JSON_MODE) {
          // Use the format module's TTY-aware colorisers — hand-rolled
          // `\x1b[32m…\x1b[0m` escapes here would survive the non-TTY
          // strip path (paint() only paints the surrounding text inside
          // fmt.note, not embedded escapes), surfacing as raw bytes in
          // CI logs and other non-TTY consumers.
          const stateColored = state === 'finalized' ? fmt.green(state) : fmt.red(state);
          fmt.note(`  · ${id.slice(0, 12)}… → ${stateColored}`);
        }
        if (!sampleShown) {
          // Save the first finalized capture's raw response so we can emit
          // its full shape after the loop (instead of mid-progress where it
          // would interrupt the per-capture status lines).
          sampleResult = {
            exit: 0,
            stdout: JSON.stringify(r.parsed, null, 2),
            stderr: '',
            parsed: r.parsed,
            cmdString: `dkg epcis status ${id}`,
          };
          sampleShown = true;
        }
      }
    }
    // Periodic aggregate progress so the user sees "still alive" even when
    // no new capture finalized this round.
    if (!JSON_MODE && newlyFinalized === 0) {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      if (elapsed - lastTickReported >= 5) {
        fmt.note(`  … ${final.size}/${captureIds.length} done · ${elapsed}s elapsed`);
        lastTickReported = elapsed;
      }
    }
    if (final.size < captureIds.length) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  if (!JSON_MODE && sampleResult) {
    console.log('');
    emit('phase-2-status', 'Sample status (first finalized capture)', sampleResult, {
      kind: 'status',
      interpretation:
        sampleResult.parsed?.state === 'finalized'
          ? 'This capture made it on-chain. Its UAL is the durable identifier.'
          : 'This capture did not finalize. The error field explains why.',
    });
  }

  const finalized = [...final.values()].filter((v) => v.state === 'finalized').length;
  const failed = [...final.values()].filter((v) => v.state === 'failed').length;
  // Count `http-error` separately from `failed` so the diagnostic in the
  // aggregate line distinguishes "publisher lifted and the lift failed"
  // (`failed`) from "the daemon never gave us a usable status response"
  // (`http-error`). Both are terminal in the polling loop, but they point
  // at different root causes.
  const httpErrored = [...final.values()].filter((v) => v.state === 'http-error').length;
  const stuck = captureIds.length - finalized - failed - httpErrored;
  const chainStuck = [...final.values()].some((v) =>
    /tentative without onChainResult|cannot mark chain inclusion/i.test(
      v.response?.error ?? '',
    ),
  );
  const httpErrorSample = [...final.values()].find((v) => v.state === 'http-error');

  if (!JSON_MODE) {
    console.log('');
    const aggregateLine =
      `Aggregate — Finalized: ${finalized} · Failed: ${failed}` +
      (httpErrored > 0 ? ` · HTTP error: ${httpErrored}` : '') +
      ` · Still pending: ${stuck}`;
    fmt.note(aggregateLine);
    if (chainStuck) {
      fmt.warn(
        'Lift failed: chain adapter did not return a transaction hash. ' +
          'Devnet contracts may be out of sync — see commit 27490f2b (`dkg stop && dkg start` ' +
          'with a fresh devnet typically resolves it). The remainder of the demo runs against ' +
          'whatever data made it into SWM / the private partition.',
      );
    } else if (httpErrored > 0) {
      fmt.warn(
        `Daemon returned a non-2xx response for ${httpErrored} capture(s) during status polling. ` +
          `Sample error: ${httpErrorSample?.response?.error ?? '(no body)'}`,
      );
    } else if (stuck > 0) {
      fmt.warn('Some captures did not finalize within the timeout.');
    }
    await pauseAfter();
  }
  return final;
}

async function phase3() {
  await startPhase(PHASE_INTROS[3]);

  const swmGraph = `${CG_URI}/${SUB}/_shared_memory`;
  const sparqlA = `SELECT ?s ?p ?o WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } } LIMIT 50`;
  const a = runCli(['query', CG_ID, '-q', sparqlA, '--include-shared-memory']);
  emit('phase-3a-public-view', 'External view — raw SPARQL on the public partition', a, {
    preamble:
      'First, the EXTERNAL view. We query only the public partition — the named graph that holds the anchors. This is what any external peer with access to Acme\'s shared memory sees: each event is acknowledged to exist (`dkg:privateDataAnchor true`), but no payload triples (no eventTime, no bizStep, no readPoint).',
    interpretation: 'External peer sees: events exist. Nothing about WHAT they were.',
  });
  await pauseAfter();

  const b = runCli([
    'epcis', 'query',
    '--context-graph-id', CG_ID,
    '--sub-graph-name', SUB,
    '--finalized', 'false',
  ]);
  phase3bOwnerOk =
    (b.parsed?.epcisBody?.queryResults?.resultsBody?.eventList?.length ?? 0) > 0;
  emit('phase-3b-owner-view', 'Owner view — EPCIS composite query (finalized=false)', b, {
    preamble:
      'Now the OWNER view. Acme\'s daemon runs the same logical query, but its EPCIS plugin merges the public anchors with the private payloads it can read locally. Result: the full ObjectEvent — eventTime, bizStep, disposition, epcList, readPoint — for every captured event.',
    kind: 'epcis-query',
    interpretation: 'Owner sees full payloads. Same dataset, different visibility — driven entirely by which partition the requester can read.',
  });
  await pauseAfter();
}

async function phase4() {
  await startPhase(PHASE_INTROS[4]);

  // Finalized data lands at `<cg>/<sub>` (publisher uses
  // contextGraphSubGraphUri at agent/finalization-handler.ts:358-362).
  // Earlier the demo queried `<cg>/context/<sub>` — that's the un-sub-
  // graphed canonical URI shape and never holds sub-graph data, so the
  // query always returned 0 rows.
  const dataGraph = `${CG_URI}/${SUB}`;
  const sparqlA = `SELECT ?s ?p ?o WHERE { GRAPH <${dataGraph}> { ?s ?p ?o } } LIMIT 50`;
  const a = runCli(['query', CG_ID, '-q', sparqlA]);
  emit('phase-4a-public-view', 'External view — finalized data partition (post-lift)', a, {
    preamble:
      `Once async lift completes, anchors move out of \`_shared_memory\` into the canonical finalized partition (\`<cg>/${SUB}\`). Same external query as Phase 3, but against the durable view.`,
    interpretation: 'Anchor-only view in the finalized partition — same shape as 3a, but durably stored after on-chain confirmation.',
  });
  await pauseAfter();

  const b = runCli([
    'epcis', 'query',
    '--context-graph-id', CG_ID,
    '--sub-graph-name', SUB,
  ]);
  phase4bOwnerOk =
    (b.parsed?.epcisBody?.queryResults?.resultsBody?.eventList?.length ?? 0) > 0;
  emit('phase-4b-owner-view', 'Owner view — EPCIS query against finalized partition', b, {
    preamble:
      'Same EPCIS query as 3b but without `--finalized=false`. The plugin queries the finalized partition by default. Empty on a stuck devnet for the same reason as 4a.',
    kind: 'epcis-query',
    interpretation: 'Once lift finalizes, this returns the same payloads as 3b — just from the durable partition instead of SWM.',
  });
  await pauseAfter();
}

async function phase5() {
  await startPhase(PHASE_INTROS[5]);

  // Filters target the in-flight partition (--finalized=false). On a healthy
  // chain the same filters work against the finalized partition (drop the
  // flag); demoed against SWM here so they return data even when async lift
  // hasn't completed.
  const baseArgs = [
    'epcis', 'query',
    '--context-graph-id', CG_ID,
    '--sub-graph-name', SUB,
    '--finalized', 'false',
  ];
  const item = 'urn:acme:bike:item:BIKE-2026-W18-0001';

  const r1 = runCli([...baseArgs, '--epc', item]);
  emit('phase-5-by-epc', 'Filter 1/5 — by EPC (one item\'s lifecycle)', r1, {
    preamble: `Filter by a specific EPC (electronic product code). This returns every event mentioning item ${item} — its full traversal of Assembly Line W18.`,
    kind: 'epcis-query',
    interpretation: 'Use case: track-and-trace a specific item.',
  });
  await pauseAfter();

  const r2 = runCli([...baseArgs, '--biz-step', 'inspecting']);
  emit('phase-5-by-bizstep', 'Filter 2/5 — by bizStep=inspecting', r2, {
    preamble: 'Filter by GS1 CBV bizStep. `inspecting` matches every QA event in the batch (PaintInspection, FunctionalTest, etc.).',
    kind: 'epcis-query',
    interpretation: 'Use case: pull all QA events across the line.',
  });
  await pauseAfter();

  const r3 = runCli([...baseArgs, '--from', '2026-05-12T09:30:00Z', '--to', '2026-05-12T10:00:00Z']);
  emit('phase-5-by-time', 'Filter 3/5 — by time window', r3, {
    preamble: 'Filter by an `eventTime` range. Useful for incident windows ("what happened between 09:30:00 and 10:00:00 UTC?").',
    kind: 'epcis-query',
    interpretation: 'Use case: narrow scan around a known incident timestamp.',
  });
  await pauseAfter();

  const r4 = runCli([...baseArgs, '--per-page', '3', '--all']);
  emit('phase-5-paginated', 'Filter 4/5 — pagination (--per-page 3 --all)', r4, {
    preamble: 'Demonstrate cursor-based pagination. With `--per-page 3 --all`, the plugin walks all pages and the CLI merges them client-side. Same final result; lighter individual responses.',
    kind: 'epcis-query',
    interpretation: 'Use case: stream large result sets without one giant response.',
  });
  await pauseAfter();

  const r5 = runCli([...baseArgs, '--event-type', 'ObjectEvent']);
  emit('phase-5-baseline', 'Filter 5/5 — sanity baseline (event-type=ObjectEvent)', r5, {
    preamble: 'Sanity check: filter by event type only. EPCIS 2.0 has ObjectEvent / AggregationEvent / TransactionEvent / TransformationEvent / AssociationEvent. Assembly Line W18 emits ObjectEvents only, so this returns the full set.',
    kind: 'epcis-query',
    interpretation: 'Use case: baseline count for verification.',
  });
  await pauseAfter();
}

// Count how many KCs in this CG's meta graph already grant access to
// `allowedPeer`. Used to delta-check Phase 6's capture (after - before)
// instead of a bare existence check that would falsely succeed on reruns
// against a CG that already had grants from earlier demo runs.
//
// Returns `count: null` when the query itself failed (non-zero exit) so
// the caller can distinguish "0 grants for this peer" from "query never
// reached the daemon / parsed shape unrecognized". A silent coercion to
// 0 would let auth/daemon errors masquerade as "no new grants" and
// quietly turn Phase 6 verification into a permanent false negative.
async function countGrantsForPeer(allowedPeer, metaGraph) {
  const sparql =
    `SELECT (COUNT(?kc) AS ?c) WHERE { ` +
    `  GRAPH <${metaGraph}> { ` +
    `    ?kc <http://dkg.io/ontology/allowedPeer> ?peer . ` +
    `  } ` +
    `  FILTER(STR(?peer) = "${allowedPeer}") ` +
    `}`;
  // `dkg query` (the CLI front-end) prints a text table for binding results,
  // not JSON, so `runCli('query', …).parsed` is always undefined and the
  // pre/post-count delta in Phase 6 silently collapses to "unrecognized
  // response shape" before allow-list verification can run. Hit the daemon's
  // /api/query route directly (matches `node2Sparql`'s pattern) so we get
  // structured `{ result: { bindings } }` back and can read the COUNT cell.
  const auth = await getDaemonAuth();
  const cmdString = `POST ${auth.baseUrl}/api/query  ${sparql.length > 80 ? sparql.slice(0, 77) + '...' : sparql}`;
  let res;
  let text = '';
  let parsed;
  try {
    res = await fetch(`${auth.baseUrl}/api/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sparql, contextGraphId: CG_ID, includeSharedMemory: true }),
    });
    text = await res.text();
    try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
  } catch (err) {
    const message = err?.message ?? String(err);
    return {
      count: null,
      query: { exit: -1, stdout: '', stderr: message, parsed: undefined, cmdString },
      error: `daemon query fetch failed: ${message}`,
    };
  }
  const queryShape = { exit: res.ok ? 0 : res.status, stdout: text, stderr: res.ok ? '' : text, parsed, cmdString };
  if (!res.ok) {
    return { count: null, query: queryShape, error: `daemon /api/query HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  const bindings = Array.isArray(parsed?.result?.bindings) ? parsed.result.bindings : null;
  if (bindings === null) {
    return { count: null, query: queryShape, error: 'unrecognized response shape (no bindings)' };
  }
  const parsedCount = parseCountBinding(bindings[0]?.c);
  return { count: parsedCount, query: queryShape };
}

// Pull a numeric COUNT(*) value out of a SPARQL result cell. The DKG
// daemon currently returns plain strings shaped like
//   "0"^^<http://www.w3.org/2001/XMLSchema#integer>
// but the SPARQL-JSON spec also allows objects shaped like
//   { type: "literal", value: "17", datatype: "..." }
// — and proxies/newer endpoints can switch between the two. Calling
// String() on the object form yields "[object Object]" and the regex
// silently returns 0, masking a successful count as a missing one.
// Normalize via .value first when the cell is an object, then run the
// same regex to peel off any "..."^^<datatype> wrapper.
function parseCountBinding(cell) {
  const raw = cell == null
    ? '0'
    : typeof cell === 'object'
      ? cell.value ?? '0'
      : cell;
  const match = String(raw).match(/^"(\d+)"|^(\d+)$/);
  return Number(match?.slice(1).find(Boolean) ?? 0);
}

async function phase6() {
  await startPhase(PHASE_INTROS[6]);

  // Fresh per-run eventID so re-runs can never accidentally claim to
  // re-publish the same logical event. Each Phase 6 run is a NEW capture,
  // not a re-capture of the same event, so a stable eventID would be
  // semantically wrong even though the publisher tolerates it (each
  // capture wraps the doc in its own KC with a fresh root IRI).
  const summaryDoc = {
    '@context': EPCIS_CONTEXT,
    type: 'EPCISDocument',
    schemaVersion: '2.0',
    creationDate: new Date().toISOString(),
    epcisBody: {
      eventList: [
        {
          eventID: `urn:uuid:${randomUUID()}`,
          type: 'ObjectEvent',
          eventTime: '2026-05-12T10:30:00.000Z',
          eventTimeZoneOffset: '+00:00',
          epcList: ['urn:acme:bike:item:BIKE-2026-W18-0001'],
          action: 'OBSERVE',
          bizStep: 'https://ref.gs1.org/cbv/BizStep-shipping',
          disposition: 'https://ref.gs1.org/cbv/Disp-active',
          readPoint: { id: 'urn:acme:bike:station:BatchSummary' },
          bizLocation: { id: 'urn:acme:bike:station:BatchSummary' },
        },
      ],
    },
  };
  // Synthesized per-run with a fresh `creationDate`, so write to tmp rather
  // than the committed `fixtures/` dir — keeps the worktree clean across runs.
  // The filename also includes a per-run uuid suffix so two demo processes
  // sharing $TMPDIR (e.g. parallel CI shards, two interactive runs on the
  // same workstation) can't overwrite each other's summary doc mid-flight.
  const summaryPath = join(
    tmpdir(),
    `epcis-bike-batch-summary-${randomUUID().slice(0, 8)}.json`,
  );
  await writeFile(summaryPath, `${JSON.stringify(summaryDoc, null, 2)}\n`, 'utf-8');

  // Pre-count existing allow-list grants for ALLOWED_PEER. If reruns or
  // shared devnets have already populated the meta graph, the post-capture
  // check needs to find at least one MORE binding to prove THIS run added
  // a grant — a bare existence check would falsely succeed on stale state.
  const metaGraph = `${CG_URI}/_meta`;
  const beforeResult = await countGrantsForPeer(ALLOWED_PEER, metaGraph);
  if (beforeResult.count === null) {
    emitFail(
      'phase-6-pre-count-fail',
      `Phase 6 pre-count query failed: ${beforeResult.error}`,
      { note: 'Skipping the rest of Phase 6 — verification is unreliable without a baseline.' },
    );
    phase6GrantOk = false;
    await pauseAfter();
    return;
  }
  const grantsBefore = beforeResult.count;

  const r = runCli([
    'epcis', 'capture', summaryPath,
    '--context-graph-id', CG_ID,
    '--sub-graph-name', SUB,
    '--access-policy', 'allowList',
    '--allowed-peer', ALLOWED_PEER,
  ]);
  const syntheticWarning = peerIsSynthetic()
    ? '\n\nNOTE: no second devnet node was detected, so `--allowed-peer` is a placeholder string (`urn:peerId:kit-researcher-demo`) that no real libp2p peer can match. The grant is still written durably so the WRITE side of the model is exercised, but no peer can satisfy the READ side. Run with a second node (e.g. `./scripts/devnet.sh start 2`) to bind the grant to a real peerId.'
    : '';
  emit('phase-6-allowlist-capture', 'Capture with allowList grant', r, {
    preamble:
      `We capture one synthetic "batch summary" event with \`--access-policy allowList --allowed-peer ${ALLOWED_PEER}\`. This signals to the publisher that the resulting Knowledge Collection should be readable by exactly that one peer (in addition to the owner) and no one else.${syntheticWarning}`,
    kind: 'capture',
    interpretation: `Capture queued. Lift will write the grant as durable triples in <cg>/_meta.`,
  });
  await pauseAfter();

  // Fail fast if the daemon rejected the capture (non-zero exit). Without
  // this check we'd waste time polling on a captureID the daemon never
  // accepted, then run the verify SPARQL against unchanged state — which,
  // even with delta-counting, would correctly report newGrants=0 but
  // attribute it to "lift didn't finalize" instead of the real cause
  // ("daemon rejected the request"). Surface the actual error.
  if (r.exit !== 0) {
    emitFail(
      'phase-6-capture-rejected',
      `Phase 6 capture rejected by daemon (exit ${r.exit}): ${r.stderr || '(no stderr)'}`,
      { note: 'Skipping polling and verify — this run did not write a grant.', daemonExit: r.exit },
    );
    phase6GrantOk = false;
    return;
  }

  // Wait for THIS capture to finalize before counting grants again.
  // A fixed sleep raced the publisher on slow devnets — the verify would
  // run against pre-finalization state and report 0 grants added. Mirror
  // Phase 2's terminal-state polling for the single capture instead.
  //
  // Capture WHICH terminal state was reached, not just "we exited the
  // loop". A `failed` lift writes no grant, so running the post-count
  // SPARQL anyway would correctly show newGrants=0 — but attribute it
  // to "verify SPARQL didn't see the grant" instead of "the lift never
  // wrote one". Surfacing the publisher error here points at the real
  // cause (chain stuck, gas, etc.) rather than burying it.
  const phase6CaptureId = r.parsed?.captureID;
  if (!phase6CaptureId) {
    // Symmetric to the Phase 1 hard-fail (cycle 9). A 0-exit capture
    // response without a captureID means the daemon returned an
    // unexpected shape (route changed, error body parsed as success,
    // plugin downgraded). Silently falling through used to skip
    // polling, run the post-count SPARQL anyway, and attribute the
    // missing grant to "the verify SPARQL didn't see it" — masking
    // the real "daemon never gave us an id" cause. Surface it.
    emitFail(
      'phase-6-missing-capture-id',
      'Phase 6 capture returned exit 0 but no captureID — cannot poll for finalization.',
      {
        note: 'Daemon response shape is malformed; verification skipped.',
        daemonResponse: JSON.stringify(r.parsed ?? r.stdout).slice(0, 300),
      },
    );
    phase6GrantOk = false;
    return;
  }
  let phase6FinalState = null;
  let phase6FinalBody = null;
  {
    const pollStartedAt = Date.now();
    while (Date.now() - pollStartedAt < POLL_TIMEOUT_MS) {
      const status = await fetchCaptureStatus(phase6CaptureId);
      const state = status.parsed?.state;
      // Treat `http-error` (synthesized on non-2xx by fetchCaptureStatus)
      // as a terminal state so we don't spin until POLL_TIMEOUT_MS waiting
      // for `finalized` to materialize from a daemon that's returning
      // 401 / 404 / 500. The post-loop branch surfaces the HTTP error.
      if (state === 'finalized' || state === 'failed' || state === 'http-error') {
        phase6FinalState = state;
        phase6FinalBody = status.parsed;
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
  if (phase6FinalState === 'failed' || phase6FinalState === 'http-error') {
    const cause = phase6FinalState === 'http-error'
      ? `Phase 6 status polling hit a daemon error: `
      : `Phase 6 lift failed before any grant could be written: `;
    emitFail(
      'phase-6-lift-fail',
      `${cause}${phase6FinalBody?.error ?? '(no error message)'}`,
      {
        note: 'Skipping post-count verify — the lift never reached the meta graph.',
        state: phase6FinalState,
      },
    );
    phase6GrantOk = false;
    return;
  }
  if (phase6FinalState === null) {
    // `phase6CaptureId` is guaranteed truthy here — the missing-id branch
    // above hard-fails out — so this condition is purely "polling
    // timed out without a terminal state".
    emitWarn(
      'phase-6-lift-timeout',
      `Phase 6 lift didn't reach a terminal state within ${POLL_TIMEOUT_MS / 1000}s. ` +
        'Running the verify anyway, but the grant may not be written yet.',
      { timeoutMs: POLL_TIMEOUT_MS },
    );
  }

  // After lift completes, the policy is written as durable triples in
  // <cg>/_meta:
  //   <kc> dkg:accessPolicy  "allowList"
  //   <kc> dkg:allowedPeer   "urn:peerId:..."
  // (see packages/publisher/src/metadata.ts:82,103-106). Read-side enforcement
  // queries those exact predicates (access-handler.ts:178-185).
  //
  // The triples live in a NAMED graph (<cg>/_meta), so the SPARQL must
  // wrap the pattern in `GRAPH ?g { ... }` (or target the meta URI
  // explicitly). A bare `?s ?p ?o` pattern only matches the default
  // graph, which is empty in V10 — that was a footgun in earlier
  // versions of this demo.
  //
  // Verification is delta-based: the EPCIS capture status route does not
  // currently expose the resulting UAL, so we can't scope the SPARQL to
  // THIS specific KC. Instead we count grants for ALLOWED_PEER before
  // and after — if the count went up, this capture's lift wrote a new
  // grant. Older grants from prior runs cannot satisfy the check.
  const grantsAfterResult = await countGrantsForPeer(ALLOWED_PEER, metaGraph);
  if (grantsAfterResult.count === null) {
    emitFail(
      'phase-6-post-count-fail',
      `Phase 6 post-count query failed: ${grantsAfterResult.error}`,
      { note: 'Cannot compute (after - before) delta — verification result is unknown for this run.' },
    );
    phase6GrantOk = false;
    return;
  }
  const grantsAfter = grantsAfterResult.count;
  const newGrants = grantsAfter - grantsBefore;
  phase6GrantOk = newGrants > 0;
  const verify = grantsAfterResult.query;
  const interpretationFooter =
    `Verification is delta-based (before=${grantsBefore}, after=${grantsAfter}, new=${newGrants}). The EPCIS capture status route doesn't expose the resulting UAL, so the SPARQL counts grants for this peer before AND after this capture; only a NEW grant proves THIS run wrote the triple, not an older one already in the meta graph.`;
  emit('phase-6-allowlist-verify', 'Verify allowedPeer triple in <cg>/_meta', verify, {
    preamble:
      'Now we verify the grant is durable. After lift completes, the publisher writes `<kc> dkg:allowedPeer "<peer>"` to the meta graph (`metadata.ts:82,103-106`); the access-handler queries those triples at read time (`access-handler.ts:178-185`). The SPARQL targets the `<cg>/_meta` named graph explicitly — bare patterns only see the default graph, which is empty in V10.',
    interpretation: peerIsSynthetic()
      ? `${newGrants} new grant(s) for the placeholder peer \`${ALLOWED_PEER}\` were written to <cg>/_meta. No real libp2p peer can satisfy this string — only the WRITE side of the model is exercised. ${interpretationFooter}`
      : `${newGrants} new grant(s) for libp2p peer \`${ALLOWED_PEER}\` were written to <cg>/_meta. That peer would be allowed to read the full payload of THIS KC via \`PROTOCOL_ACCESS\`; nobody else would. ${interpretationFooter}`,
  });
  await pauseAfter();
}

async function phase7() {
  await startPhase(PHASE_INTROS[7]);

  // Verification result tags shown in the final visibility table.
  let anchorOk = false;
  let privateInvisible = false;

  const node2Auth = await getNode2Auth();
  const node2Ident = node2Auth ? await fetchNode2Identity() : null;

  if (!node2Ident) {
    if (!JSON_MODE) {
      fmt.preamble(
        'Cross-node verification needs a second devnet node. None reachable, so this phase prints the visibility table without live verification. Set NODE2_DKG_HOME or run `./scripts/devnet.sh start 2` to enable it.',
      );
      fmt.warn('No second node — cross-node sub-steps skipped.');
    }
  } else {
    if (!JSON_MODE) {
      fmt.preamble(
        `Verifying the visibility claims from a SECOND node ("${node2Ident.name}", peerId ${node2Ident.peerId.slice(0, 12)}…). The owner persona was already verified in Phases 3-6; this phase covers the OTHER personas: any peer subscribed to the CG should see public anchors, and a non-grantee peer should see ZERO private payload.`,
      );
    }

    // 7.A — Anyone/Competitor sees public anchors.
    // On a SUBSCRIBER node (which is what node2 is here), the finalized
    // partition `<cg>/<sub>` is empty by architecture: only the
    // publishing node materializes finalized data into its own local
    // store. Subscribers receive anchors via SWM gossip and keep them
    // there. So on node2, finalized is normally empty and SWM holds
    // the data. We still try finalized first — if a future change
    // replicates finalized to subscribers, this code remains correct;
    // and on the publishing node (if this phase ever ran from there)
    // finalized would be the right target. Fall back to SWM when
    // finalized is empty, which is the expected path on a subscriber.
    //
    // Count `dkg:privateDataAnchor` subjects specifically rather than
    // COUNT(*). The privateDataAnchor predicate is what the publisher
    // writes per captured event into the public partition (see
    // packages/publisher/src/async-lift-publisher-impl.ts:117), so
    // counting those gives a meaningful "how many anchored events does
    // node2 see for this CG/sub-graph" — a tighter assertion than
    // counting every triple in the graph (provenance, type, owner,
    // etc., none of which prove anchors are visible).
    const finalizedGraphUri = `${CG_URI}/${SUB}`;
    const swmGraphUri = `${CG_URI}/${SUB}/_shared_memory`;
    const anchorSparql = (uri) =>
      `SELECT (COUNT(?s) AS ?c) WHERE { ` +
      `  GRAPH <${uri}> { ` +
      `    ?s <http://dkg.io/ontology/privateDataAnchor> ?o ` +
      `  } ` +
      `}`;
    // Use the shared parseCountBinding helper so the SPARQL-JSON
    // object-cell form (`{value: "17", datatype: ...}`) doesn't silently
    // coerce to 0 the way `String({...}).match(...)` would.
    const parseCount = (res) => parseCountBinding(res.bindings[0]?.c);
    // Treat HTTP failure or unrecognized response shape as "query
    // failed" — distinct from "0 anchors". Without this, daemon/auth
    // errors would silently coerce to count=0 → anchorOk=false and
    // the table would falsely report "anchors not visible".
    const querySucceeded = (res) =>
      res.status === 200 && Array.isArray(res.bindings);

    let anchorRes = await node2Sparql(anchorSparql(finalizedGraphUri));
    let anchorCount = querySucceeded(anchorRes) ? parseCount(anchorRes) : 0;
    let queriedPartition = 'finalized';
    let anchorQueryOk = querySucceeded(anchorRes);
    if (anchorQueryOk && anchorCount === 0) {
      anchorRes = await node2Sparql(anchorSparql(swmGraphUri));
      anchorQueryOk = querySucceeded(anchorRes);
      anchorCount = anchorQueryOk ? parseCount(anchorRes) : 0;
      queriedPartition = 'swm-fallback';
    }
    anchorOk = anchorQueryOk && anchorCount > 0;
    if (!JSON_MODE) {
      fmt.step('phase-7a-public-anchor-on-node2', 'Anyone — public anchor visible on a second node');
      fmt.preamble(
        'Run a SPARQL on node2\'s local store. Subscribers receive anchors via SWM gossip and keep them there — publisher peerId, KC root, and `dkg:privateDataAnchor "true"` triples — without needing a grant. The finalized partition `<cg>/<sub>` only populates on the publishing node, so on a subscriber the natural read path lands in SWM.',
      );
      fmt.command(anchorRes.cmdString);
      if (!anchorQueryOk) {
        fmt.warn(`Phase 7A SPARQL failed (HTTP ${anchorRes.status}) — anchor visibility unverified.`);
      } else {
        const partitionLabel = queriedPartition === 'finalized'
          ? `<cg>/${SUB} (finalized)`
          : `<cg>/${SUB}/_shared_memory (SWM — expected on a subscriber node)`;
        fmt.note(`  ${anchorCount} anchored event(s) on node2 in ${partitionLabel}`);
        if (anchorOk) fmt.success('Anyone (subscribed peer) sees public anchors. ✓');
        else fmt.warn('Expected anchors on node2 but found none in either partition — gossip may not have reached node2 yet.');
      }
      await pauseAfter();
    } else {
      process.stdout.write(`${JSON.stringify({ step: 'phase-7a-public-anchor-on-node2', anchorCount, partition: queriedPartition, queryOk: anchorQueryOk, ok: anchorOk })}\n`);
    }

    // 7.B — Private payload absent on node2 until access-protocol fetch.
    // The private partition stays on the publishing node's local store.
    // An allow-list grant authorizes a peer to fetch via libp2p
    // PROTOCOL_ACCESS but does NOT auto-replicate the payload. Until
    // node2 calls AccessClient.requestAccess (gap noted in 7.C), its
    // local <cg>/<sub>/_private is empty for ALL captures — granted or
    // not. So 0 here proves "no auto-leak", not "non-grantee denial".
    //
    // COUNT(*) is intentional here (vs the predicate-scoped anchor
    // count above): we want to detect ANY private data on node2, not
    // just specific predicates — any non-zero count would indicate a
    // replication leak regardless of what predicates landed.
    const privGraphUri = `${CG_URI}/${SUB}/_private`;
    const privSparql = `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${privGraphUri}> { ?s ?p ?o } }`;
    const privRes = await node2Sparql(privSparql);
    const privQueryOk = querySucceeded(privRes);
    const privCount = privQueryOk ? parseCount(privRes) : 0;
    privateInvisible = privQueryOk && privCount === 0;
    if (!JSON_MODE) {
      fmt.step('phase-7b-private-empty-on-node2', 'Private payload absent on node2 (no auto-replication)');
      fmt.preamble(
        'Same node2, different graph: the private partition. The publisher keeps payload on its own local store; allow-list grants authorize an on-demand `PROTOCOL_ACCESS` fetch from grantees, they do NOT push the data. Until that fetch runs (see 7.C), node2\'s local `<cg>/<sub>/_private` is empty regardless of grant. 0 here proves "no auto-leak", not "non-grantee denial".',
      );
      fmt.command(privRes.cmdString);
      if (!privQueryOk) {
        fmt.warn(`Phase 7B SPARQL failed (HTTP ${privRes.status}) — auto-replication absence unverified.`);
      } else {
        fmt.note(`  ${privCount} private triples on node2 in <cg>/${SUB}/_private`);
        if (privateInvisible) fmt.success('Private partition is empty on node2 — no payload was pushed. ✓');
        else fmt.warn(`Expected zero private triples on node2 but found ${privCount}. The publisher may be replicating private data unintentionally.`);
      }
      await pauseAfter();
    } else {
      process.stdout.write(`${JSON.stringify({ step: 'phase-7b-private-empty-on-node2', privCount, queryOk: privQueryOk, ok: privateInvisible })}\n`);
    }

    // 7.C — Document the missing piece. The KIT-positive case ("granted
    // peer can read the full payload via the access protocol") would
    // require the libp2p access-protocol fetch (publisher/access-client.ts)
    // which is not yet exposed via CLI. Honest call-out.
    if (!JSON_MODE) {
      fmt.step('phase-7c-grant-protocol-note', 'KIT (allowList) — grant durability proven; access-protocol fetch not yet CLI-exposed');
      fmt.preamble(
        `The Phase 6 grant is durably written to <cg>/_meta with peerId=${ALLOWED_PEER.slice(0, 12)}… (verified via Phase 6.2 SPARQL). At read time, the access-handler (packages/publisher/src/access-handler.ts:98-110) checks fromPeerId against meta.allowedPeers and signs/serves the private payload via libp2p PROTOCOL_ACCESS. The client side is in packages/publisher/src/access-client.ts — but this protocol is not yet wired to a CLI subcommand or HTTP route. Exercising "KIT can read full payload" end-to-end requires either a small CLI hook for AccessClient.requestAccess() or running the access protocol from a test harness.`,
      );
      fmt.note('  (gap noted — receiver-side fetch not yet CLI-exposed; tracked in #409)');
      await pauseAfter();
    } else {
      process.stdout.write(`${JSON.stringify({ step: 'phase-7c-grant-protocol-note' })}\n`);
    }
  }

  // 7.D — Visibility summary, annotated with verification status.
  // Owner-side reads need at least one of 3b/4b to have returned events
  // (3b reads pre-finalization SWM, 4b reads the finalized partition;
  // either succeeding is enough to prove the owner sees full payloads).
  // grantDurable comes from the Phase 6 SPARQL against <cg>/_meta —
  // a non-empty binding set proves the allowedPeer triple was written.
  const ownerOk = phase3bOwnerOk || phase4bOwnerOk;
  const grantDurable = phase6GrantOk;

  // KIT's verified state mirrors the human-readable table:
  //   - 'partial'  if the grant triple was observed AND it binds to a real peer
  //                (write side verified, read side not exercised)
  //   - false      if the grant triple was not observed OR the peer is the
  //                synthetic placeholder (no real libp2p peer can satisfy it)
  let kitVerified;
  let kitNote;
  if (!grantDurable) {
    kitVerified = false;
    kitNote = 'grant triple not observed in <cg>/_meta — capture may not have finalized';
  } else if (peerIsSynthetic()) {
    kitVerified = false;
    kitNote = 'grant durable but bound to synthetic placeholder peerId — no real peer can satisfy';
  } else {
    kitVerified = 'partial';
    kitNote = 'grant durable; access-protocol fetch not exercised';
  }

  // Competitor is an ACTIVE adversary — they would call PROTOCOL_ACCESS
  // and try to fetch the private payload. An empty private graph on the
  // grantee node (node2) only proves "no auto-replication"; it does NOT
  // prove that the access-handler would deny a non-grantee peer's fetch.
  // To verify denial we'd need a third, ungranted node calling fetch and
  // being rejected — out of scope for this 2-node setup.
  const competitorPrivateVerified = false; // active denial not exercised

  // The "Subscriber (pre-fetch)" row covers what we ACTUALLY tested:
  // the probe runs from node2, which (in this 2-node setup) is also the
  // grantee. So this row claims only that node2 — in its passive
  // subscriber role, before invoking the access-protocol fetch — sees
  // public anchors and zero private triples. We deliberately do NOT
  // call this row "Anyone (no grant)": that label would mis-attribute
  // a passive-subscriber observation as proof of non-grantee denial,
  // which we don't actually exercise here (see Competitor).
  const subscriberNote =
    'Probe runs from node2, which IS the grantee in this 2-node setup. ' +
    'This row reports node2\'s passive-subscriber state — public anchor ' +
    'visible, private partition empty — BEFORE the access-protocol fetch ' +
    'is invoked. Strict non-grantee denial (the "no grant" claim) would ' +
    'need a third, ungranted node calling PROTOCOL_ACCESS — see Competitor.';

  if (JSON_MODE) {
    process.stdout.write(
      `${JSON.stringify({
        step: 'phase-7d-table',
        visibility: [
          { persona: 'Subscriber (pre-fetch)', public_partition: 'anchor only', private_partition: 'nothing (not yet fetched)', verified: anchorOk && privateInvisible, note: subscriberNote },
          { persona: 'Acme (owner)', public_partition: 'anchor', private_partition: 'full payload', verified: ownerOk },
          { persona: 'KIT (allowList)', public_partition: 'anchor', private_partition: 'full payload (allowed events)', verified: kitVerified, note: kitNote },
          { persona: 'Competitor', public_partition: 'anchor only', private_partition: 'nothing', verified: anchorOk && competitorPrivateVerified, note: 'active access-handler denial not exercised — would need a third, ungranted node attempting PROTOCOL_ACCESS' },
        ],
      })}\n`,
    );
    return;
  }

  console.log('');
  fmt.step('phase-7d-table', 'Visibility summary (with verification status)');
  const tag = (ok, partial = false) => (ok ? '✓' : partial ? '~' : '?');
  fmt.table([
    {
      Persona: 'Subscriber (pre-fetch)',
      'Public partition': `Anchor only ${tag(anchorOk)}`,
      'Private partition': `Nothing (not yet fetched) ${tag(privateInvisible)}`,
    },
    {
      Persona: 'Acme (owner)',
      'Public partition': `Anchor ${tag(ownerOk)}`,
      'Private partition': `Full payload ${tag(ownerOk)}`,
    },
    {
      Persona: 'KIT (allowList)',
      'Public partition': `Anchor ${tag(anchorOk)}`,
      // The private cell tops out at "~" (grant durable, fetch not
      // exercised) when the grant is bound to a real peer. With the
      // synthetic placeholder peerId (no node2), even the WRITE side
      // is bound to a string no real libp2p node uses, so the read
      // path is fundamentally unreachable — drop to "?" to be honest.
      'Private partition': `Full payload (granted) ${grantDurable && !peerIsSynthetic() ? '~' : '?'}`,
    },
    {
      Persona: 'Competitor',
      'Public partition': `Anchor only ${tag(anchorOk)}`,
      // Drop to ? — see competitorPrivateVerified above. The signal we
      // have ("no auto-replication on node2") doesn't prove active
      // access-handler denial of a non-grantee fetch.
      'Private partition': 'Nothing ?',
    },
  ]);
  fmt.note('  ✓ verified live · ~ partially verified (grant durable, P2P fetch not yet CLI-exposed) · ? not verified');
  fmt.note(`  Subscriber (pre-fetch) row: ${subscriberNote}`);
  fmt.note('  Competitor row needs a third ungranted node attempting `PROTOCOL_ACCESS` to verify denial — out of scope for this 2-node setup.');
}

async function main() {
  CLI = await detectCli();
  await showOpening();
  await phase0();
  const captureIds = await phase1();
  if (captureIds.length > 0) await phase2(captureIds);
  await phase3();
  await phase4();
  await phase5();
  await phase6();
  await phase7();
  showClosing();
  if (!JSON_MODE) fmt.success('Demo complete.');
}

main().catch((err) => {
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify({ error: err.message, stack: err.stack })}\n`);
  } else {
    fmt.fail(err.message);
    if (err.stack) fmt.note(err.stack);
  }
  process.exit(1);
});
