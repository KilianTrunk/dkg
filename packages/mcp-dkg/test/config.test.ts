import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

/**
 * Tests for `loadConfig()`'s DKG_HOME precedence. Codex Round-11
 * Fix 18: when `DKG_HOME` is set, the loader reads
 * `<DKG_HOME>/config.yaml` directly (no cwd-walk fallback). When
 * `DKG_HOME` is unset, the existing cwd-walk for `.dkg/config.yaml`
 * is preserved as the spec-canonical workspace path.
 *
 * Round-9 Fix 16 propagates `DKG_HOME` into the MCP entry's `env`
 * field so spawned MCP servers (in GUI clients that don't inherit
 * shell env) read the same home setup just bootstrapped. Without
 * Fix 18, that propagation was inert at runtime — `loadConfig`
 * ignored `DKG_HOME`.
 */
describe('loadConfig — DKG_HOME precedence (Codex Round-11 Fix 18)', () => {
  let tmpRoot: string;
  let originalDkgHome: string | undefined;
  let originalCwd: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-dkg-config-test-'));
    originalDkgHome = process.env.DKG_HOME;
    delete process.env.DKG_HOME;
    originalCwd = process.cwd();
  });

  afterEach(() => {
    if (originalDkgHome !== undefined) process.env.DKG_HOME = originalDkgHome;
    else delete process.env.DKG_HOME;
    try {
      process.chdir(originalCwd);
    } catch {
      // Best-effort restore — the original cwd may have been deleted by a
      // sibling test that used the same pattern. Leave the next test's
      // beforeEach to set its own working dir.
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('Codex Round-11 Fix 18: DKG_HOME set + <DKG_HOME>/config.yaml exists → loads from there', () => {
    // Pre-fix: loadConfig ignored DKG_HOME entirely, only walking
    // `.dkg/config.yaml` from cwd. Round-9 Fix 16's `env: {
    // DKG_HOME }` propagation was inert at runtime. Post-fix: when
    // DKG_HOME is set, config is read from `<DKG_HOME>/config.yaml`
    // directly.
    const home = join(tmpRoot, 'fake-dkg-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.yaml'),
      'node:\n  api: http://x:9001\n',
    );
    process.env.DKG_HOME = home;

    const cfg = loadConfig();
    expect(cfg.api).toBe('http://x:9001');
    expect(cfg.sourcePath).toBe(join(home, 'config.yaml'));
  });

  it('Codex Round-11 Fix 18: DKG_HOME set + no config.yaml at that path → no fallback to cwd-walk', () => {
    // The no-fallback contract: when DKG_HOME is set explicitly,
    // a missing config.yaml at that path returns null
    // (sourcePath: null), NOT a silent fall-through to a cwd-walk.
    // Falling back would mask a missing-config issue and
    // re-introduce the cwd-dependence Fix 16 was meant to break.
    //
    // Setup: DKG_HOME=<empty dir>, then chdir into a workspace
    // that DOES have `.dkg/config.yaml`. Pre-fix, the cwd-walk
    // would have found and loaded the workspace config. Post-fix,
    // the empty DKG_HOME wins → sourcePath: null.
    const home = join(tmpRoot, 'empty-dkg-home');
    mkdirSync(home, { recursive: true });
    process.env.DKG_HOME = home;

    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(join(workspace, '.dkg'), { recursive: true });
    writeFileSync(
      join(workspace, '.dkg', 'config.yaml'),
      'node:\n  api: http://workspace:9999\n',
    );
    process.chdir(workspace);

    const cfg = loadConfig();
    // sourcePath null → no config file located.
    expect(cfg.sourcePath).toBeNull();
    // The workspace config was NOT silently loaded.
    expect(cfg.api).not.toBe('http://workspace:9999');
  });

  it('Codex Round-11 Fix 18: DKG_HOME unset → existing cwd-walk for .dkg/config.yaml preserved', () => {
    // Regression guard for the spec-canonical workspace path. With
    // DKG_HOME unset, walking upwards from cwd looking for
    // `.dkg/config.yaml` MUST still work.
    const workspace = join(tmpRoot, 'workspace');
    mkdirSync(join(workspace, '.dkg'), { recursive: true });
    writeFileSync(
      join(workspace, '.dkg', 'config.yaml'),
      'node:\n  api: http://workspace:9999\n',
    );
    process.chdir(workspace);

    const cfg = loadConfig();
    expect(cfg.api).toBe('http://workspace:9999');
    expect(cfg.sourcePath).toBe(join(workspace, '.dkg', 'config.yaml'));
  });

  it('Codex Round-11 Fix 18: round-trip — mcp-setup-style env propagation reads from the bootstrapped home', () => {
    // Integration check: simulate what happens when a GUI client
    // spawns the registered MCP entry. `dkg mcp setup` (Round-9
    // Fix 16) writes `env: { DKG_HOME }` into the MCP entry; the
    // client's spawn injects DKG_HOME into the server process's
    // env; the server's loadConfig then reads from <DKG_HOME>.
    // This tests that whole loop works end-to-end inside
    // loadConfig's own contract.
    const setupHome = join(tmpRoot, 'setup-home');
    mkdirSync(setupHome, { recursive: true });
    // `project` is a TOP-LEVEL field per loadConfig's contract
    // (`fromFile.contextGraph` || `fromFile.project`); only `api`
    // and `token` are nested under `node`.
    writeFileSync(
      join(setupHome, 'config.yaml'),
      'node:\n  api: http://setup:9100\nproject: setup-project\n',
    );
    // Simulate the spawn-time env injection.
    process.env.DKG_HOME = setupHome;

    // chdir somewhere unrelated to verify cwd is not consulted.
    process.chdir(tmpRoot);

    const cfg = loadConfig();
    expect(cfg.api).toBe('http://setup:9100');
    expect(cfg.defaultProject).toBe('setup-project');
    expect(cfg.sourcePath).toBe(join(setupHome, 'config.yaml'));
  });

  // ── Codex Round-19 Fix 25: read JSON+YAML from DKG_HOME ──────────

  it('Codex Round-19 Fix 25: DKG_HOME + <DKG_HOME>/config.json exists → loads JSON (matches what `dkg mcp setup` writes)', async () => {
    // Pre-fix: Round-11 Fix 18 only checked config.yaml under
    // DKG_HOME. But `dkg mcp setup`'s writeDkgConfig writes
    // config.json — so after a fresh setup the GUI client's MCP
    // server hit the DKG_HOME branch, found no yaml, fell through
    // to env defaults (empty token, null project), and every
    // write 401'd. Post-fix: JSON-first precedence matches the
    // bootstrapped state.
    const home = join(tmpRoot, 'json-dkg-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        node: { token: 'abc', api: 'http://h:9001' },
        project: 'p',
      }),
    );
    process.env.DKG_HOME = home;

    const cfg = loadConfig();
    expect(cfg.token).toBe('abc');
    expect(cfg.api).toBe('http://h:9001');
    expect(cfg.defaultProject).toBe('p');
    expect(cfg.sourcePath).toBe(join(home, 'config.json'));
  });

  it('Codex Round-19 Fix 25: both config.json AND config.yaml exist at DKG_HOME → JSON wins (deterministic precedence)', async () => {
    // When both files exist, Fix 25's JSON-first precedence
    // mirrors `dkg mcp setup`'s actual write order. JSON has the
    // bootstrapped state; YAML may be stale operator hand-edit
    // from a previous workspace.
    const home = join(tmpRoot, 'both-formats-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ node: { api: 'http://json:9100' } }),
    );
    writeFileSync(
      join(home, 'config.yaml'),
      'node:\n  api: http://yaml:9200\n',
    );
    process.env.DKG_HOME = home;

    const cfg = loadConfig();
    // JSON wins.
    expect(cfg.api).toBe('http://json:9100');
    expect(cfg.sourcePath).toBe(join(home, 'config.json'));
  });

  it('Codex Round-19 Fix 25: DKG_HOME + only config.yaml exists → falls back to YAML', async () => {
    // YAML fallback: when no JSON is present (e.g. a workspace
    // where the operator hand-edited config.yaml without going
    // through `dkg mcp setup`), the YAML loader takes over.
    // Round-11 Fix 18's contract preserved.
    const home = join(tmpRoot, 'yaml-only-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.yaml'),
      'node:\n  api: http://yaml:9300\n',
    );
    process.env.DKG_HOME = home;

    const cfg = loadConfig();
    expect(cfg.api).toBe('http://yaml:9300');
    expect(cfg.sourcePath).toBe(join(home, 'config.yaml'));
  });

  it('Codex Round-19 Fix 25: DKG_HOME + neither file exists → sourcePath null + env defaults preserved', async () => {
    // Behavior preserved from Round-11 Fix 18: when DKG_HOME
    // points to a directory with neither config.json nor
    // config.yaml, the loader returns sourcePath=null and falls
    // through to env defaults (rather than walking cwd, which
    // would mask the missing-config issue).
    const home = join(tmpRoot, 'empty-home');
    mkdirSync(home, { recursive: true });
    process.env.DKG_HOME = home;

    const cfg = loadConfig();
    expect(cfg.sourcePath).toBeNull();
    // Default api when no config + no env: localhost:9200.
    expect(cfg.api).toBe('http://localhost:9200');
  });
});
