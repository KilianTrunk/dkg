#!/usr/bin/env node
/**
 * Audit: ban undisciplined `Wallet.createRandom()` in production code.
 *
 * Why this exists
 * ---------------
 * On 2026-05-01 every testnet node bootstrapped on the V10 isolated Hub got
 * its on-chain admin key from `ethers.Wallet.createRandom()` inside
 * `EVMChainAdapter.ensureProfile()`. The wallet existed only as a local
 * variable for the duration of one `createProfile` tx, then was garbage
 * collected. The private key was never logged, never persisted, never
 * surfaced to the operator. Result: nine identities (1–9) had their admin
 * keys destroyed at registration time, breaking PR #366's auto-add of
 * operational ACK signers (which is `onlyAdmin`) and forcing a partial
 * network rebuild.
 *
 * PR #366 itself fixed `ensureProfile` (added a hard `if (!this.adminSigner)
 * throw` guard so the random+discard path can't run silently). This audit
 * script keeps that fix from regressing AND catches the same anti-pattern
 * elsewhere — the publisher constructor had an analogous bug producing
 * unverifiable signatures attributed to throw-away addresses, fixed in the
 * same PR as this script.
 *
 * What it does
 * ------------
 * Walks every `.ts` / `.js` source file under `packages/*\/src/**` and fails
 * if it finds `Wallet.createRandom(` outside the explicitly allowlisted
 * call sites below. Each allowlist entry has a one-line justification —
 * if you need to add a new one, justify it in code review.
 *
 * What's allowed
 * --------------
 * Random key generation IS legitimate when the resulting key is either
 *   (a) returned to a caller that persists it (e.g. `loadOpWallets`
 *       writes to `wallets.json`, custodial agent registration writes to
 *       the keystore), OR
 *   (b) used in a hardhat deploy script that prints the key for the
 *       operator to capture.
 * It is NEVER legitimate to use a random key for actual signing inside the
 * daemon and let it go out of scope without persistence.
 *
 * Tests are excluded — they routinely use random keys for fixtures and
 * never run against real chains.
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

// Plain recursive walk — keeps this script dependency-free so it can run
// in any CI step before `pnpm install`. Only descends into directories we
// actually care about (skips node_modules, dist, .git, test dirs).
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-ui', '.git', '.turbo', 'coverage',
  'test', 'tests', '__tests__', 'cache', 'artifacts', 'typechain',
]);
const SOURCE_EXTS = new Set(['.ts', '.js', '.mjs', '.cjs']);

async function* walkSourceFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walkSourceFiles(full);
    } else if (e.isFile()) {
      if (e.name.endsWith('.test.ts') || e.name.endsWith('.test.js')) continue;
      if (e.name.endsWith('.spec.ts') || e.name.endsWith('.spec.js')) continue;
      const dot = e.name.lastIndexOf('.');
      if (dot === -1 || !SOURCE_EXTS.has(e.name.slice(dot))) continue;
      yield full;
    }
  }
}

// Each allowlist entry must have a justification. Reviewers should not
// extend this list without understanding why — see file header.
const ALLOWLIST = new Map([
  [
    'packages/agent/src/op-wallets.ts',
    'first-run admin+op wallet generation, persisted to wallets.json (chmod 0600)',
  ],
  [
    'packages/agent/src/agent-keystore.ts',
    'custodial chat-agent keypair, returned to caller and persisted in keystore',
  ],
  [
    'packages/evm-module/utils/helpers.ts',
    'hardhat deploy-script utility, key returned to operator (`generateEvmWallet`)',
  ],
]);

// Match `Wallet.createRandom(` (with the dot, so `createRandom` standalone
// or as a method on something else still passes). Trailing `(` is required
// to avoid matching identifiers in narrative prose.
const PATTERN = /\bWallet\.createRandom\s*\(/;

// Skip single-line `//` comments and JSDoc-style block-comment lines
// starting with `*`. This isn't a full comment parser — multi-line
// `/* … */` regions on a single line still get scanned, which is fine
// for this audit (they're rare and obvious in review).
function isCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*');
}

function fileHasOffense(text) {
  for (const line of text.split('\n')) {
    if (isCommentLine(line)) continue;
    if (PATTERN.test(line)) return true;
  }
  return false;
}

async function main() {
  const packagesDir = join(REPO_ROOT, 'packages');
  let pkgs;
  try {
    pkgs = await readdir(packagesDir, { withFileTypes: true });
  } catch (err) {
    console.error(`audit-create-random: cannot read ${packagesDir}: ${err.message}`);
    return 2;
  }
  const offenders = [];
  for (const pkg of pkgs) {
    if (!pkg.isDirectory() || pkg.name.startsWith('.')) continue;
    // Scan src/ and utils/ — utils/ catches packages/evm-module/utils/
    for (const subdir of ['src', 'utils']) {
      const root = join(packagesDir, pkg.name, subdir);
      for await (const absPath of walkSourceFiles(root)) {
        const text = await readFile(absPath, 'utf8');
        if (!fileHasOffense(text)) continue;
        const relPath = relative(REPO_ROOT, absPath).split('\\').join('/');
        if (ALLOWLIST.has(relPath)) continue;
        const lines = text.split('\n');
        const hits = [];
        for (let i = 0; i < lines.length; i++) {
          if (isCommentLine(lines[i])) continue;
          if (PATTERN.test(lines[i])) hits.push({ line: i + 1, text: lines[i].trim() });
        }
        if (hits.length > 0) offenders.push({ path: relPath, hits });
      }
    }
  }

  if (offenders.length === 0) {
    console.log('audit-create-random: OK — no undisciplined Wallet.createRandom() in production code.');
    if (ALLOWLIST.size > 0) {
      console.log(`Allowlisted (${ALLOWLIST.size}):`);
      for (const [p, why] of ALLOWLIST) console.log(`  - ${p}: ${why}`);
    }
    return 0;
  }

  console.error('audit-create-random: FAIL — Wallet.createRandom() found outside the audited allowlist:');
  for (const o of offenders) {
    console.error(`\n  ${o.path}`);
    for (const h of o.hits) console.error(`    L${h.line}: ${h.text}`);
  }
  console.error(`
Why this matters: random keys generated in-process and then discarded
produce unverifiable signatures and unrecoverable on-chain identities.
This is exactly how the May 2026 testnet incident destroyed nine admin
keys — see scripts/audit-create-random.mjs header for the full story.

If your new use site genuinely persists the key (and the operator can
recover it), add it to the ALLOWLIST in scripts/audit-create-random.mjs
with a one-line justification. Otherwise: take a key from the caller.
`);
  return 1;
}

const exitCode = await main();
process.exit(exitCode);
