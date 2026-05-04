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
 * Walks every `.ts` / `.tsx` / `.mts` / `.cts` / `.js` / `.jsx` / `.mjs` /
 * `.cjs` source file under `packages/*\/{src,utils}/**` and fails if it
 * finds `Wallet.createRandom(` outside the explicitly allowlisted call
 * sites below. Each allowlist entry pins ONE expected hit with a one-line
 * justification — adding a second `createRandom()` to the same file does
 * NOT inherit the existing exemption and must be reviewed on its own.
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
 *
 * Bypass-resistance notes
 * -----------------------
 *   - Whole-file scan after stripping `//` line comments and `/* … *​/`
 *     block comments, so split invocations like `Wallet\n.createRandom()`
 *     or `Wallet /* … *​/.createRandom()` cannot bypass the regex by
 *     formatting.
 *   - Per-hit allowlist (not per-file): an extra `createRandom()` call
 *     added to an already-exempt file fails CI and must be justified.
 *   - String literals containing `//` or `/​*` are treated as comments.
 *     Acceptable false-negative scope: a string containing
 *     `"Wallet.createRandom("` would slip past, but that pattern is
 *     trivially obvious in code review.
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-ui', '.git', '.turbo', 'coverage',
  'test', 'tests', '__tests__', 'cache', 'artifacts', 'typechain',
]);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const TEST_SUFFIXES = [
  '.test.ts', '.test.tsx', '.test.mts', '.test.cts', '.test.js', '.test.jsx', '.test.mjs', '.test.cjs',
  '.spec.ts', '.spec.tsx', '.spec.mts', '.spec.cts', '.spec.js', '.spec.jsx', '.spec.mjs', '.spec.cjs',
];

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
      if (TEST_SUFFIXES.some((s) => e.name.endsWith(s))) continue;
      const dot = e.name.lastIndexOf('.');
      if (dot === -1 || !SOURCE_EXTS.has(e.name.slice(dot))) continue;
      yield full;
    }
  }
}

// Each entry pins ONE expected hit. `expectedHits` is the number of
// `Wallet.createRandom(` invocations that must appear in this file; a
// future PR adding a second call will fail CI even though one is justified.
const ALLOWLIST = new Map([
  [
    'packages/agent/src/op-wallets.ts',
    {
      expectedHits: 1,
      justification: 'first-run admin+op wallet generation, persisted to wallets.json (chmod 0600)',
    },
  ],
  [
    'packages/agent/src/agent-keystore.ts',
    {
      expectedHits: 1,
      justification: 'custodial chat-agent keypair, returned to caller and persisted in keystore',
    },
  ],
  [
    'packages/evm-module/utils/helpers.ts',
    {
      expectedHits: 1,
      justification: 'hardhat deploy-script utility, key returned to operator (`generateEvmWallet`)',
    },
  ],
]);

// Match `Wallet . createRandom (` allowing arbitrary whitespace (including
// newlines) between the tokens. This is intentionally a single regex over
// the comment-stripped file, NOT a per-line scan — that previously let
// `Wallet\n  .createRandom()` bypass the audit by formatting alone.
const PATTERN = /\bWallet\s*\.\s*createRandom\s*\(/g;

/**
 * Strip `//` line comments and `/​* … *​/` block comments from `text`,
 * replacing them with whitespace of the same byte length so that match
 * indexes computed against the returned string still map back to the
 * original line numbers.
 *
 * Non-goals: this is not a full lexer. String literals containing comment
 * tokens (`const s = "// ...";`) are treated as comments, which is fine
 * for an audit that only cares about real `Wallet.createRandom(` calls —
 * such calls cannot live inside string literals.
 */
function stripCommentsPreservingPositions(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
    } else if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < text.length) {
        out += '  ';
        i += 2;
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function findHits(originalText) {
  const stripped = stripCommentsPreservingPositions(originalText);
  const hits = [];
  for (const m of stripped.matchAll(PATTERN)) {
    const upToMatch = stripped.slice(0, m.index);
    const line = upToMatch.split('\n').length;
    const lineStart = upToMatch.lastIndexOf('\n') + 1;
    const lineEnd = stripped.indexOf('\n', m.index);
    const snippet = originalText
      .slice(lineStart, lineEnd === -1 ? originalText.length : lineEnd)
      .trim();
    hits.push({ line, snippet });
  }
  return hits;
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
  const violations = [];
  const seenAllowlistPaths = new Set();
  for (const pkg of pkgs) {
    if (!pkg.isDirectory() || pkg.name.startsWith('.')) continue;
    for (const subdir of ['src', 'utils']) {
      const root = join(packagesDir, pkg.name, subdir);
      for await (const absPath of walkSourceFiles(root)) {
        const text = await readFile(absPath, 'utf8');
        const hits = findHits(text);
        if (hits.length === 0) continue;
        const relPath = relative(REPO_ROOT, absPath).split('\\').join('/');
        const exemption = ALLOWLIST.get(relPath);
        if (!exemption) {
          violations.push({
            path: relPath,
            kind: 'no-exemption',
            hits,
            expectedHits: 0,
          });
          continue;
        }
        seenAllowlistPaths.add(relPath);
        if (hits.length !== exemption.expectedHits) {
          violations.push({
            path: relPath,
            kind: 'hit-count-mismatch',
            hits,
            expectedHits: exemption.expectedHits,
            justification: exemption.justification,
          });
        }
      }
    }
  }

  // A stale allowlist entry is itself a violation — we don't want exemptions
  // to silently outlive the file/call site they were granted for.
  const staleAllowlist = [];
  for (const [path] of ALLOWLIST) {
    if (!seenAllowlistPaths.has(path)) staleAllowlist.push(path);
  }

  if (violations.length === 0 && staleAllowlist.length === 0) {
    console.log('audit-create-random: OK — no undisciplined Wallet.createRandom() in production code.');
    if (ALLOWLIST.size > 0) {
      console.log(`Allowlisted (${ALLOWLIST.size}):`);
      for (const [p, { expectedHits, justification }] of ALLOWLIST) {
        console.log(`  - ${p} (${expectedHits} hit${expectedHits === 1 ? '' : 's'}): ${justification}`);
      }
    }
    return 0;
  }

  console.error('audit-create-random: FAIL');
  for (const v of violations) {
    console.error(`\n  ${v.path}`);
    if (v.kind === 'no-exemption') {
      console.error(`    No allowlist entry. Found ${v.hits.length} hit${v.hits.length === 1 ? '' : 's'}:`);
    } else {
      console.error(`    Allowlisted for ${v.expectedHits} hit${v.expectedHits === 1 ? '' : 's'} (${v.justification}), but found ${v.hits.length}:`);
    }
    for (const h of v.hits) console.error(`    L${h.line}: ${h.snippet}`);
  }
  for (const p of staleAllowlist) {
    console.error(`\n  ${p}`);
    console.error('    Allowlist entry is stale (no Wallet.createRandom() found in the file).');
    console.error('    Remove the entry from ALLOWLIST in scripts/audit-create-random.mjs.');
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
