#!/usr/bin/env node
/**
 * Backfill RS per-cgId `_meta` graphs on a receiver core.
 *
 * Why
 * ===
 * Until cd68fa689 ("fix(agent): always plumb on-chain CG id into
 * finalization gossip") landed on `release/rc.12`, every non-REMAP
 * publish emitted a finalization gossip with `targetContextGraphId:
 * undefined`. Receivers reading the envelope literally then promoted
 * the SWM snapshot's per-KC `_meta` into the legacy
 * `<cgName>/_meta` graph instead of the per-cgId
 * `<cgName>/context/<cgId>/_meta` graph the RS prover reads from —
 * leaving every freshly-published KC invisible to RS and the prover
 * loops on `kc-not-synced` indefinitely.
 *
 * cd68fa689 fixes the publisher and (with the receiver-defensive
 * lookup that lands alongside it) fixes the receiver for any FUTURE
 * publish. It does NOT touch the meta that already landed at the
 * wrong URI before the upgrade. This script copies the per-KC subset
 * of every `<cgName>/_meta` graph into the corresponding per-cgId
 * graph by calling the daemon's
 * `POST /api/random-sampling/backfill-percgid-meta` admin endpoint
 * (added in the same PR as this script).
 *
 * Operation is idempotent — re-running it on a node that's already
 * been backfilled reports `already-populated` for each CG and writes
 * nothing.
 *
 * Usage
 * =====
 *
 *   # Probe a remote core (no writes; just see what would happen).
 *   node scripts/backfill-rs-percgid-meta.mjs \
 *     --api=https://beacon-01.example.com:9200 \
 *     --token=PZcq... \
 *     --dry-run
 *
 *   # Backfill all subscribed CGs on the locally-running daemon.
 *   node scripts/backfill-rs-percgid-meta.mjs
 *
 *   # Backfill only specific CGs.
 *   node scripts/backfill-rs-percgid-meta.mjs \
 *     --cg=miles-publish-stress-26may \
 *     --cg=rs-test-20kc-2026-05-27
 *
 *   # On a beacon, using the bearer token from `~/.dkg/auth.token`:
 *   ssh beacon-01 'cd dkg && DEVNET_API=http://127.0.0.1:9200 \
 *     node scripts/backfill-rs-percgid-meta.mjs'
 *
 * Args (all optional, env vars listed in parens):
 *   --api=URL          (DEVNET_API)    daemon URL (default http://localhost:9200)
 *   --token=BEARER     (DEVNET_TOKEN)  bearer token (fallback: ~/.dkg/auth.token)
 *   --cg=NAME          (repeatable)    restrict to specific CG names; default: all subscribed
 *   --dry-run                          probe-only; no writes
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient, parseArgs, resolveToken } from './lib/dkg-daemon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const rawArgs = process.argv.slice(2);
const args = parseArgs(rawArgs);
const API_BASE = (args.api ?? process.env.DEVNET_API ?? 'http://localhost:9200').replace(/\/$/, '');
const TOKEN = args.token ?? process.env.DEVNET_TOKEN ?? resolveToken(REPO_ROOT);
const DRY_RUN = args['dry-run'] === 'true' || args.dryRun === 'true';

// `parseArgs` collapses repeated flags onto the last one. Recover the
// list of `--cg=...` args by scanning the raw argv.
const cgArgs = rawArgs
  .map((a) => /^--cg=(.+)$/.exec(a)?.[1])
  .filter((v) => typeof v === 'string' && v.length > 0);

const client = makeClient({ apiBase: API_BASE, token: TOKEN });

console.log(`[backfill] api=${API_BASE} dryRun=${DRY_RUN} restrict=${cgArgs.length > 0 ? cgArgs.join(',') : '(all subscribed)'}`);

let result;
try {
  result = await client.request('POST', '/api/random-sampling/backfill-percgid-meta', {
    contextGraphIds: cgArgs,
    dryRun: DRY_RUN,
  });
} catch (err) {
  console.error(`[backfill] FAILED: ${err.message}`);
  process.exit(1);
}

const { processed, summary, reports } = result;
console.log(
  `[backfill] processed=${processed} backfilled=${summary.backfilled} ` +
  `alreadyPopulated=${summary.alreadyPopulated} noSourceMeta=${summary.noSourceMeta} ` +
  `notOnChain=${summary.notOnChain} failed=${summary.failed}`,
);

for (const r of reports) {
  const tag = r.onChainId ? `cg=${r.contextGraphId}#${r.onChainId}` : `cg=${r.contextGraphId}`;
  switch (r.status) {
    case 'backfilled':
      console.log(`  · ${tag} BACKFILLED copied=${r.copiedTriples}${DRY_RUN ? ' (dry-run)' : ''}`);
      break;
    case 'already-populated':
      console.log(`  · ${tag} ALREADY-POPULATED target=${r.preExistingTargetTripleCount} triples`);
      break;
    case 'no-source-meta':
      console.log(`  · ${tag} NO-SOURCE-META (nothing to copy)`);
      break;
    case 'not-on-chain':
      console.log(`  · ${tag} NOT-ON-CHAIN (skipped; on-chain id unknown)`);
      break;
    case 'failed':
      console.warn(`  ! ${tag} FAILED: ${r.error}`);
      break;
    default:
      console.log(`  ? ${tag} status=${r.status}`);
  }
}

// Exit non-zero only when an actual operation failed; "nothing to do"
// states are not errors so the script is safe to chain in a multi-host
// for-loop.
if (summary.failed > 0) {
  process.exit(2);
}
