#!/usr/bin/env node
/**
 * Dependency deny-list scanner — supply-chain hardening §13.
 *
 * Reads `.github/dependency-deny-list.json` and asserts that:
 *
 *   1. No name in `denied_package_names[]` appears in `pnpm-lock.yaml`
 *      or in any `package.json` file under the workspace.
 *   2. No path in `denied_files[]` exists on disk.
 *
 * Exit codes:
 *
 *     0  clean (and the lockfile sanity check passed)
 *     1  one or more denied entries matched
 *     2  scanner broken (deny-list file missing / unparseable, OR the
 *        sanity-check package was NOT found in pnpm-lock.yaml so the
 *        scan path cannot be trusted to be exercising the lockfile)
 *
 * Design constraints:
 *
 *   - Vanilla Node only. No `npm install` step in the calling workflow.
 *     We use `node:fs`, `node:path`, `node:url`. Nothing else.
 *   - Hard sanity check: if a known-present dep is NOT found in the
 *     lockfile, we exit 2 so a future workflow refactor (e.g. someone
 *     renaming `pnpm-lock.yaml` or moving it) does not silently start
 *     reporting clean for unrelated reasons. The previous version of
 *     `supply-chain-scan.yml`'s pnpm-audit step shipped without this
 *     and got a false-confidence bug (now fixed); we apply the same
 *     lesson here from the outset.
 *   - Both pnpm-lock.yaml AND every package.json under packages/* are
 *     scanned. Lockfile catches transitives; package.json catches a
 *     direct-dep addition before the lockfile updates.
 *   - Outputs both a job-summary table (when run in GHA) and a plain
 *     terminal report (when run locally) so the same script works for
 *     pre-push checks and CI gates.
 *
 * Usage:
 *
 *     node scripts/check-dependency-deny-list.mjs
 *
 *     # Pre-push hook:
 *     pnpm exec node scripts/check-dependency-deny-list.mjs || exit 1
 */

import { readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));

const DENY_LIST_PATH = '.github/dependency-deny-list.json';
const LOCKFILE_PATH = 'pnpm-lock.yaml';

function fail(code, message) {
  console.error(`::error title=dependency-deny-list scanner::${message}`);
  process.exit(code);
}

function info(message) {
  console.log(message);
}

function loadDenyList() {
  const path = join(repoRoot, DENY_LIST_PATH);
  if (!existsSync(path)) {
    fail(2, `${DENY_LIST_PATH} not found; cannot scan.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    fail(2, `${DENY_LIST_PATH} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed.denied_package_names)) {
    fail(2, `${DENY_LIST_PATH} missing or malformed denied_package_names[].`);
  }
  if (!Array.isArray(parsed.denied_files)) {
    fail(2, `${DENY_LIST_PATH} missing or malformed denied_files[].`);
  }
  if (!parsed.scanner_sanity_check?.expected_package_in_lockfile) {
    fail(2, `${DENY_LIST_PATH} missing scanner_sanity_check.expected_package_in_lockfile.`);
  }
  return parsed;
}

/**
 * Build a regex that matches a package NAME (not a substring of a longer
 * name). Package names in pnpm-lock.yaml appear in several positions:
 *
 *   /pkg-name@x.y.z:           ← snapshots block, leading `/`
 *   pkg-name:                  ← importers / specifiers
 *   'pkg-name@x.y.z':          ← quoted keys
 *   "pkg-name@x.y.z":          ← double-quoted
 *
 * The left and right edge characters must NOT be part of a valid npm
 * package name char ([a-z0-9-._/]) — that prevents matching e.g.
 * `defi-env-auditor` inside `super-defi-env-auditor-pro` if a future
 * legitimate package shares a substring.
 */
function buildNameMatcher(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9._/@-])${escaped}(@|/|"|'|:|\\s|$)`, 'm');
}

function scanFileForNames(filePath, deniedNames) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const hits = [];
  for (const entry of deniedNames) {
    if (buildNameMatcher(entry.name).test(content)) {
      hits.push(entry);
    }
  }
  return hits;
}

function findPackageJsonFiles(dir) {
  const out = [];
  // Avoid recursing into node_modules, .git, build outputs, etc.
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache', 'coverage', '.publish-artifacts']);
  function walk(d) {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name === 'package.json') {
        out.push(full);
      }
    }
  }
  walk(dir);
  return out;
}

function checkLockfileSanity(sanityName) {
  const path = join(repoRoot, LOCKFILE_PATH);
  if (!existsSync(path)) {
    fail(2, `${LOCKFILE_PATH} not found at repo root; the lockfile must exist for the deny-list scan to mean anything.`);
  }
  const content = readFileSync(path, 'utf-8');
  if (!buildNameMatcher(sanityName).test(content)) {
    fail(2, `Sanity check failed: expected '${sanityName}' to appear in ${LOCKFILE_PATH}, but the scanner did not find it. This means either the lockfile path/format has drifted or the matcher regex is broken. Refusing to report clean. Update scanner_sanity_check.expected_package_in_lockfile in ${DENY_LIST_PATH} if the chosen sanity package has been removed from deps.`);
  }
}

function emitSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, lines.join('\n') + '\n');
  } catch (err) {
    console.error(`(non-fatal) failed to write GITHUB_STEP_SUMMARY: ${err.message}`);
  }
}

function main() {
  const denyList = loadDenyList();
  const sanity = denyList.scanner_sanity_check.expected_package_in_lockfile;

  // Sanity check FIRST. If this fails we don't even attempt to report
  // clean — the scanner is broken and any "no hits" result is meaningless.
  checkLockfileSanity(sanity);
  info(`✓ Lockfile sanity check passed (found '${sanity}' in ${LOCKFILE_PATH}).`);

  const allHits = [];

  // 1. Package-name deny-list scan against the lockfile.
  const lockHits = scanFileForNames(join(repoRoot, LOCKFILE_PATH), denyList.denied_package_names);
  for (const hit of lockHits) {
    allHits.push({ kind: 'package_name', file: LOCKFILE_PATH, ...hit });
  }

  // 2. Same scan against every package.json under the workspace.
  const pkgJsonFiles = findPackageJsonFiles(repoRoot);
  for (const pkgJson of pkgJsonFiles) {
    const hits = scanFileForNames(pkgJson, denyList.denied_package_names);
    for (const hit of hits) {
      allHits.push({ kind: 'package_name', file: relative(repoRoot, pkgJson), ...hit });
    }
  }

  // 3. File-name deny-list.
  for (const denied of denyList.denied_files) {
    const path = join(repoRoot, denied.path);
    if (existsSync(path)) {
      allHits.push({ kind: 'denied_file', file: denied.path, ...denied });
    }
  }

  info(`Scanned ${pkgJsonFiles.length} package.json files + 1 lockfile + ${denyList.denied_files.length} denied file paths.`);

  if (allHits.length === 0) {
    info(`✓ Clean. ${denyList.denied_package_names.length} denied package names and ${denyList.denied_files.length} denied file paths checked; zero matches.`);
    emitSummary([
      '## Dependency deny-list scan',
      '',
      '✓ **Clean.** No denied package names or paths found.',
      '',
      `**Scanned:** ${pkgJsonFiles.length} \`package.json\` files + \`${LOCKFILE_PATH}\` + ${denyList.denied_files.length} denied paths.`,
      `**Deny-list entries:** ${denyList.denied_package_names.length} package names, ${denyList.denied_files.length} file paths.`,
      `**Lockfile sanity check:** found \`${sanity}\` ✓`,
    ]);
    process.exit(0);
  }

  // Hits found — emit detailed annotations for each.
  console.error(`✗ ${allHits.length} deny-list hit(s) found:`);
  const summaryLines = [
    '## Dependency deny-list scan',
    '',
    `✗ **${allHits.length} deny-list hit(s) found.** Refusing to merge.`,
    '',
    '| Kind | Match | Where | Campaign | Source |',
    '|------|-------|-------|----------|--------|',
  ];
  for (const hit of allHits) {
    const label = hit.kind === 'package_name' ? hit.name : hit.path;
    console.error(`  - ${hit.kind}: ${label} (file: ${hit.file}, campaign: ${hit.campaign})`);
    console.error(`::error file=${hit.file},title=Denied ${hit.kind} matched::${label} is on the supply-chain deny-list (campaign: ${hit.campaign}). See ${hit.source_url}`);
    summaryLines.push(`| ${hit.kind} | \`${label}\` | \`${hit.file}\` | ${hit.campaign} | [link](${hit.source_url}) |`);
  }
  summaryLines.push('', `If a hit is a known false positive, document the rationale and remove the entry from \`${DENY_LIST_PATH}\` in the same PR. Do not bypass this check by editing the scanner.`);
  emitSummary(summaryLines);
  process.exit(1);
}

main();
