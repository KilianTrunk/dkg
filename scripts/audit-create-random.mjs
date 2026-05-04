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
 *   - Whole-file scan after a small lexer blanks comments AND string /
 *     template-literal contents (preserving byte length and newlines so
 *     line numbers in error output stay accurate). This means:
 *       * Split invocations like `Wallet\n.createRandom()` or
 *         `Wallet /* … *​/.createRandom()` cannot bypass via formatting.
 *       * `//` or `/​*` inside a string literal does NOT trigger comment
 *         mode (so `const url = "http://"; Wallet.createRandom();` is
 *         correctly flagged — previously the `//` inside the string
 *         silently blanked the real call after it).
 *       * A string literal containing the literal text `Wallet.createRandom(`
 *         is blanked along with the rest of the string, so the regex
 *         can't false-positive on it either.
 *   - Per-hit allowlist (not per-file): an extra `createRandom()` call
 *     added to an already-exempt file fails CI and must be justified.
 *   - Template-literal substitutions (`${ … }`) ARE scanned as code, so a
 *     `\`${Wallet.createRandom()}\`` would be flagged. Strings nested
 *     inside such substitutions are not recursively re-lexed; an exotic
 *     `\`${"Wallet.createRandom("}\`` would false-positive (acceptable —
 *     false-positive is much safer than false-negative for a security
 *     audit, and that pattern is trivially obvious in review).
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
 * Blank out comments AND string / template-literal contents from `text`,
 * replacing them with spaces (newlines preserved) so the returned string
 * has the same byte length as the input and match indexes still resolve
 * to the original line numbers.
 *
 * State machine (small, intentionally not a full TS parser):
 *
 *   normal              → code we want to scan
 *   line-comment        // … \n          (entered only from normal)
 *   block-comment       /​* … *​/          (entered only from normal)
 *   sq-string           ' … '            (entered only from normal; \-escapes consumed)
 *   dq-string           " … "            (entered only from normal; \-escapes consumed)
 *   tpl-string          ` … `            (entered only from normal; \-escapes consumed)
 *   tpl-substitution    ${ … }           (entered from tpl-string; brace-balanced; treated as normal code)
 *
 * Why the explicit string state? The previous comment-only stripper
 * treated `//` and `/​*` as comment-start unconditionally — so the line
 * `const url = "http://"; Wallet.createRandom();` blanked everything
 * after `//`, swallowing the real `createRandom()` call after the string.
 * That is a false-NEGATIVE bypass for a security audit, the worst case.
 * The fixed stripper enters `dq-string` at the opening `"`, blanks the
 * string contents, exits at the closing `"`, then resumes normal scanning
 * which sees `Wallet.createRandom(` intact.
 *
 * Strings are blanked rather than passed through verbatim so that a
 * literal `"Wallet.createRandom("` inside a string can't false-positive
 * the regex either.
 *
 * Regex literals (`/foo/g`) are NOT explicitly handled — we'd need full
 * JS expression context to disambiguate `/` from division. In practice
 * the only pattern that could bypass is a regex literal whose body
 * contains an unescaped `/​/` or `/​*`, which is exotic enough to ignore.
 */
export function stripCommentsPreservingPositions(text) {
  const len = text.length;
  let out = '';
  let i = 0;
  let state = 'normal';
  let stringQuote = ''; // " | ' | ` for sq/dq/tpl
  let braceDepth = 0;   // tracked inside tpl-substitution

  const blank = (c) => (c === '\n' ? '\n' : ' ');

  while (i < len) {
    const c = text[i];
    const next = i + 1 < len ? text[i + 1] : '';

    if (state === 'normal') {
      if (c === '/' && next === '/') {
        out += '  '; i += 2;
        state = 'line-comment';
      } else if (c === '/' && next === '*') {
        out += '  '; i += 2;
        state = 'block-comment';
      } else if (c === '"' || c === "'") {
        out += ' '; i += 1;
        state = c === '"' ? 'dq-string' : 'sq-string';
        stringQuote = c;
      } else if (c === '`') {
        out += ' '; i += 1;
        state = 'tpl-string';
        stringQuote = '`';
      } else {
        out += c; i += 1;
      }
      continue;
    }

    if (state === 'line-comment') {
      if (c === '\n') {
        out += '\n'; i += 1;
        state = 'normal';
      } else {
        out += ' '; i += 1;
      }
      continue;
    }

    if (state === 'block-comment') {
      if (c === '*' && next === '/') {
        out += '  '; i += 2;
        state = 'normal';
      } else {
        out += blank(c); i += 1;
      }
      continue;
    }

    if (state === 'sq-string' || state === 'dq-string') {
      if (c === '\\' && i + 1 < len) {
        // Consume escape sequence (e.g. \", \\, \n) — blank both bytes.
        out += blank(c) + blank(text[i + 1]);
        i += 2;
      } else if (c === stringQuote) {
        out += ' '; i += 1;
        state = 'normal';
        stringQuote = '';
      } else {
        out += blank(c); i += 1;
      }
      continue;
    }

    if (state === 'tpl-string') {
      if (c === '\\' && i + 1 < len) {
        out += blank(c) + blank(text[i + 1]);
        i += 2;
      } else if (c === '`') {
        out += ' '; i += 1;
        state = 'normal';
        stringQuote = '';
      } else if (c === '$' && next === '{') {
        // Enter a substitution: subsequent code is scanned as normal.
        // We DO NOT recursively re-lex strings inside the substitution —
        // see the docstring's bypass-resistance notes for the trade-off.
        out += '  '; i += 2;
        state = 'tpl-substitution';
        braceDepth = 1;
      } else {
        out += blank(c); i += 1;
      }
      continue;
    }

    if (state === 'tpl-substitution') {
      if (c === '{') {
        braceDepth += 1;
        out += c; i += 1;
      } else if (c === '}') {
        braceDepth -= 1;
        if (braceDepth === 0) {
          out += ' '; i += 1;
          state = 'tpl-string';
        } else {
          out += c; i += 1;
        }
      } else {
        // Pass through so regex catches Wallet.createRandom() inside ${...}
        out += c; i += 1;
      }
      continue;
    }
  }
  return out;
}

export function findHits(originalText) {
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

// Run only when invoked directly (so the test file can import the lexer
// + findHits without triggering a full repository scan + process.exit).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const exitCode = await main();
  process.exit(exitCode);
}
