import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_PATTERNS = [
  /dkg-v9/i,
  /DKG V9/i,
];

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = path.join(ROOT_DIR, 'packages');
const LOCKFILE_PATH = path.join(ROOT_DIR, 'pnpm-lock.yaml');
const BETTER_SQLITE3_PACKAGE = 'better-sqlite3';
// Exact pin is tied to verified Node ABI v137 macOS arm64 prebuild availability.
const EXPECTED_BETTER_SQLITE3_VERSION = '12.11.1';
const PACKAGES_EXPECTED_TO_USE_BETTER_SQLITE3 = new Set([
  '@origintrail-official/dkg',
  '@origintrail-official/dkg-node-ui',
]);

function firstMatchSample(value) {
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const lower = normalized.toLowerCase();
  let matchIndex = -1;
  for (const pattern of FORBIDDEN_PATTERNS) {
    const idx = lower.search(new RegExp(pattern.source, 'i'));
    if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
      matchIndex = idx;
    }
  }
  if (matchIndex === -1) {
    return normalized.slice(0, 120);
  }
  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(normalized.length, matchIndex + 100);
  return normalized.slice(start, end);
}

function hasForbiddenText(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(value));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inspectPackageBetterSqlite3(pkg, packageJsonPath) {
  const violations = [];
  const dependencyRange = pkg.dependencies?.[BETTER_SQLITE3_PACKAGE];
  const optionalRange = pkg.optionalDependencies?.[BETTER_SQLITE3_PACKAGE];
  const relativePackageJson = path.relative(ROOT_DIR, packageJsonPath);
  const expectedPackage = PACKAGES_EXPECTED_TO_USE_BETTER_SQLITE3.has(pkg.name);

  if (expectedPackage && dependencyRange === undefined) {
    violations.push({
      packageName: pkg.name,
      location: `${relativePackageJson}#dependencies.${BETTER_SQLITE3_PACKAGE}`,
      sample: '<missing>',
      expected: EXPECTED_BETTER_SQLITE3_VERSION,
    });
  }

  const productionRanges = [
    { field: 'dependencies', value: dependencyRange },
    { field: 'optionalDependencies', value: optionalRange },
  ];

  for (const entry of productionRanges) {
    if (entry.value === undefined) continue;
    if (entry.value !== EXPECTED_BETTER_SQLITE3_VERSION) {
      violations.push({
        packageName: pkg.name,
        location: `${relativePackageJson}#${entry.field}.${BETTER_SQLITE3_PACKAGE}`,
        sample: entry.value,
        expected: EXPECTED_BETTER_SQLITE3_VERSION,
      });
    }
  }

  return violations;
}

function collectBetterSqlite3LockfileViolations() {
  if (!fs.existsSync(LOCKFILE_PATH)) {
    return [{
      packageName: 'workspace',
      location: 'pnpm-lock.yaml',
      sample: '<missing>',
      expected: `contains ${BETTER_SQLITE3_PACKAGE}@${EXPECTED_BETTER_SQLITE3_VERSION}`,
    }];
  }

  const lockfile = fs.readFileSync(LOCKFILE_PATH, 'utf8');
  const violations = [];
  const lockfilePackagePattern = new RegExp(
    `^\\s{2}${escapeRegExp(BETTER_SQLITE3_PACKAGE)}@([^:\\s(]+)(?:\\([^)]*\\))?:`,
    'gm',
  );
  const resolvedVersions = new Set();

  for (const match of lockfile.matchAll(lockfilePackagePattern)) {
    resolvedVersions.add(match[1]);
  }

  if (!resolvedVersions.has(EXPECTED_BETTER_SQLITE3_VERSION)) {
    violations.push({
      packageName: 'workspace',
      location: 'pnpm-lock.yaml',
      sample: `${BETTER_SQLITE3_PACKAGE}@${EXPECTED_BETTER_SQLITE3_VERSION} not found`,
      expected: `${BETTER_SQLITE3_PACKAGE}@${EXPECTED_BETTER_SQLITE3_VERSION}`,
    });
  }

  for (const version of [...resolvedVersions].sort()) {
    if (version === EXPECTED_BETTER_SQLITE3_VERSION) continue;
    violations.push({
      packageName: 'workspace',
      location: 'pnpm-lock.yaml',
      sample: `${BETTER_SQLITE3_PACKAGE}@${version}`,
      expected: `only ${BETTER_SQLITE3_PACKAGE}@${EXPECTED_BETTER_SQLITE3_VERSION}`,
    });
  }

  return violations;
}

function collectViolations() {
  const violations = [];
  const packageDirs = fs.readdirSync(PACKAGES_DIR, { withFileTypes: true });

  for (const entry of packageDirs) {
    if (!entry.isDirectory()) continue;

    const packageDir = path.join(PACKAGES_DIR, entry.name);
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;

    const pkg = readJson(packageJsonPath);
    if (pkg.private) continue;

    violations.push(...inspectPackageBetterSqlite3(pkg, packageJsonPath));

    const repository =
      typeof pkg.repository === 'string'
        ? pkg.repository
        : pkg.repository?.url ?? '';
    const bugs = typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url ?? '';

    const fieldsToCheck = [
      { field: 'description', value: pkg.description ?? '' },
      { field: 'repository', value: repository },
      { field: 'homepage', value: pkg.homepage ?? '' },
      { field: 'bugs', value: bugs },
    ];

    for (const field of fieldsToCheck) {
      if (!hasForbiddenText(field.value)) continue;
      violations.push({
        packageName: pkg.name,
        location: `${path.relative(ROOT_DIR, packageJsonPath)}#${field.field}`,
        sample: firstMatchSample(field.value),
      });
    }

    const readmePath = path.join(packageDir, 'README.md');
    if (fs.existsSync(readmePath)) {
      const readme = fs.readFileSync(readmePath, 'utf8');
      if (hasForbiddenText(readme)) {
        violations.push({
          packageName: pkg.name,
          location: `${path.relative(ROOT_DIR, readmePath)}#content`,
          sample: firstMatchSample(readme),
        });
      }
    }
  }

  violations.push(...collectBetterSqlite3LockfileViolations());

  return violations;
}

const violations = collectViolations();

if (violations.length > 0) {
  console.error('Found npm package metadata, README, or native dependency policy violations:\n');
  for (const violation of violations) {
    console.error(`- ${violation.packageName}: ${violation.location}`);
    console.error(`  ${violation.sample}`);
    if (violation.expected) {
      console.error(`  expected: ${violation.expected}`);
    }
  }
  process.exit(1);
}

console.log('NPM metadata check passed: no stale v9 references and better-sqlite3 is pinned to a Node 24-capable build.');
