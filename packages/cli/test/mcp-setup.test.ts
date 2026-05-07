import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir, platform } from 'node:os';
import { join } from 'node:path';
import { mcpSetupAction, type McpSetupActionDeps } from '../src/mcp-setup.js';

/**
 * Codex Round-4: canonical entry shape that production now writes
 * for INSTALLED context. Both modes emit `{ command:
 * process.execPath, args: [<cli script path>, 'mcp', 'serve'] }`;
 * installed-mode resolves the script path from `process.argv[1]`
 * via `realpathSync` (canonicalises symlinks). Tests that assert
 * the exact installed-mode entry contents call this helper so they
 * stay byte-aligned with production without hardcoding the
 * test-runner-specific argv[1].
 */
const EXPECTED_INSTALLED_ENTRY = () => ({
  command: process.execPath,
  args: [realpathSync(process.argv[1]), 'mcp', 'serve'],
});

/**
 * Bundled-flow fixture for `dkg mcp setup`. Per W6-pre task brief, asserts
 * that on a clean machine the action:
 *   (a) creates `~/.dkg/config.json` (init step calls writeDkgConfig)
 *   (b) starts the daemon (startDaemon stub records the port)
 *   (c) writes client registration entries to detected clients
 *
 * Every external primitive is stubbed via the `deps` injection point —
 * no real filesystem outside the temp HOME, no real daemon spawn, no
 * real faucet HTTP call.
 */
describe('mcpSetupAction — bundled init + daemon-start + register flow', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;
  let originalAppdata: string | undefined;
  let originalDkgHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mcp-setup-test-'));
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    originalAppdata = process.env.APPDATA;
    // Codex Round-2 Bug A: mcpSetupAction now sets DKG_HOME for the
    // duration of the action so adapter-openclaw / dkg-core flows
    // pick up the resolved home. Save+restore it like HOME/APPDATA
    // so the env mutation is bounded to each test.
    originalDkgHome = process.env.DKG_HOME;
    delete process.env.DKG_HOME;
    process.env.HOME = tmpHome;
    // node:os homedir() reads USERPROFILE on win32, HOME elsewhere; set both.
    process.env.USERPROFILE = tmpHome;
    // Phase-3: Claude Desktop's Windows path resolves under
    // %APPDATA%; redirect that into tmpHome too so the per-platform
    // path resolver lands inside the test sandbox on Win32. macOS
    // and Linux ignore APPDATA.
    process.env.APPDATA = join(tmpHome, 'AppData', 'Roaming');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalUserprofile !== undefined) process.env.USERPROFILE = originalUserprofile;
    else delete process.env.USERPROFILE;
    if (originalAppdata !== undefined) process.env.APPDATA = originalAppdata;
    else delete process.env.APPDATA;
    if (originalDkgHome !== undefined) process.env.DKG_HOME = originalDkgHome;
    else delete process.env.DKG_HOME;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /**
   * Build a fresh stubbed deps surface. `writeDkgConfig` writes a real
   * file into the temp HOME so the post-merge readback in mcpSetupAction
   * sees a valid config — that's the byte-aligned behaviour with the
   * production primitive without spawning a real daemon.
   */
  function makeDeps(overrides: Partial<McpSetupActionDeps> = {}): McpSetupActionDeps {
    const startDaemon = vi.fn(async (_port: number) => {});
    const writeDkgConfig = vi.fn((agentName: string, _network: any, apiPort: number) => {
      // Codex Round-2 Bug A: production `writeDkgConfig` uses
      // adapter-openclaw's `dkgDir()` which delegates to
      // `resolveDkgConfigHome()` and respects `DKG_HOME`. Mirror that
      // posture in the stub so monorepo-mode tests that flip
      // `isDkgMonorepo` see the side effects in the dev-home dir.
      const dkgDir = process.env.DKG_HOME ?? join(tmpHome, '.dkg');
      mkdirSync(dkgDir, { recursive: true });
      writeFileSync(
        join(dkgDir, 'config.json'),
        JSON.stringify({ name: agentName, apiPort, nodeRole: 'edge' }, null, 2),
      );
    });
    const loadNetworkConfig = vi.fn(() => ({
      networkName: 'test-net',
      relays: [],
      defaultContextGraphs: ['agent-context'],
      defaultNodeRole: 'edge',
      faucet: { url: 'http://faucet.test', mode: 'testnet' },
    }) as any);
    const readWalletsWithRetry = vi.fn(async () => ['0xtest1', '0xtest2', '0xtest3']);
    const requestFaucetFunding = vi.fn(async () => ({ success: true }) as any);
    const logManualFundingInstructions = vi.fn(() => {});
    // Phase-2: detectContext defaults to "installed" by returning null
    // from findDkgMonorepoRoot. Tests that exercise the monorepo path
    // override this dep to return a mock repo root.
    const findDkgMonorepoRoot = vi.fn((_startDir?: string) => null as string | null);
    // Codex Round-4: `resolveDkgBin` was removed from the deps
    // surface — both modes now register `process.execPath +
    // <cli.js path>`, so the `which dkg` resolution it provided is
    // obsolete.
    // Codex Round-2 Bug A: resolveDkgConfigHome defaults to mirroring
    // the production dkg-core posture against the test's tmpHome.
    // `isDkgMonorepo: true` ⇒ `<tmpHome>/.dkg-dev`; otherwise ⇒
    // `<tmpHome>/.dkg`. Existing tests that don't exercise the
    // monorepo path keep landing in `<tmpHome>/.dkg` byte-aligned
    // with the pre-Bug-A behaviour.
    const resolveDkgConfigHome = vi.fn(
      (opts: { isDkgMonorepo?: boolean } = {}): string => {
        if (opts.isDkgMonorepo) {
          const devDir = join(tmpHome, '.dkg-dev');
          // Tests that hit the monorepo branch expect writeDkgConfig
          // to land in this directory; create it eagerly so existsSync
          // probes downstream don't trip over a missing parent.
          mkdirSync(devDir, { recursive: true });
          return devDir;
        }
        return join(tmpHome, '.dkg');
      },
    );
    return {
      loadNetworkConfig,
      writeDkgConfig,
      startDaemon,
      readWalletsWithRetry,
      requestFaucetFunding,
      logManualFundingInstructions,
      findDkgMonorepoRoot,
      resolveDkgConfigHome,
      ...overrides,
    };
  }

  it('on a clean machine: creates config, starts daemon, writes client entry', async () => {
    // Pre-create a Cursor-style config dir so `detectClients` finds Cursor
    // as a candidate. Real users have ~/.cursor/ from installing Cursor.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    // Avoid the verify step's real-network probe.
    await mcpSetupAction({ verify: false, fund: false }, deps);

    // (a) writeDkgConfig was called with port 9200 (default) + a fallback agent name.
    expect(deps.writeDkgConfig).toHaveBeenCalledTimes(1);
    const writeArgs = (deps.writeDkgConfig as any).mock.calls[0];
    expect(writeArgs[2]).toBe(9200);
    expect(typeof writeArgs[0]).toBe('string');
    expect(writeArgs[0]).toMatch(/^mcp-agent-/);
    expect(existsSync(join(tmpHome, '.dkg', 'config.json'))).toBe(true);

    // (b) startDaemon was called once with the effective port.
    expect(deps.startDaemon).toHaveBeenCalledTimes(1);
    expect((deps.startDaemon as any).mock.calls[0][0]).toBe(9200);

    // (c) Cursor client config was written with the canonical entry.
    const cursorConfig = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursorConfig.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  it('skips writeDkgConfig when ~/.dkg/config.yaml already exists and no overrides given', async () => {
    // Pre-existing config — first-init should be skipped silently.
    const dkgDir = join(tmpHome, '.dkg');
    mkdirSync(dkgDir, { recursive: true });
    writeFileSync(join(dkgDir, 'config.yaml'), 'name: persisted-agent\napiPort: 9200\n');
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ verify: false, fund: false }, deps);

    expect(deps.writeDkgConfig).not.toHaveBeenCalled();
    // Daemon start still runs unless --no-start was passed.
    expect(deps.startDaemon).toHaveBeenCalledTimes(1);
  });

  // F6 (qa-review-round-1): when the existing-config skip-write branch
  // is taken, `effectivePort` MUST be reconciled against the persisted
  // config, not the CLI default. Pre-fix concrete reproducer: a user
  // who previously ran `dkg openclaw setup --port 9300` (so
  // `~/.dkg/config.json` has `apiPort: 9300`) and then runs `dkg mcp
  // setup` with no flags would have the daemon started on 9200 (the
  // CLI default), the verification probe hit the wrong port, and the
  // registered MCP entry would point nowhere useful.
  it('F6: existing config with non-default port — startDaemon receives the persisted port, not the CLI default', async () => {
    const dkgDir = join(tmpHome, '.dkg');
    mkdirSync(dkgDir, { recursive: true });
    // Pre-existing config has apiPort 9300; the user is running `dkg
    // mcp setup` with NO --port flag, so the CLI default would be 9200.
    writeFileSync(
      join(dkgDir, 'config.json'),
      JSON.stringify({ name: 'persisted-agent', apiPort: 9300, nodeRole: 'edge' }, null, 2),
    );
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ verify: false, fund: false }, deps);

    // writeDkgConfig MUST NOT have run — the existing-config branch
    // was taken (no overrides supplied).
    expect(deps.writeDkgConfig).not.toHaveBeenCalled();
    // startDaemon MUST receive the persisted 9300, not the CLI default.
    expect(deps.startDaemon).toHaveBeenCalledTimes(1);
    expect((deps.startDaemon as any).mock.calls[0][0]).toBe(9300);
  });

  it('F6: existing config with non-default port + --no-start — read-back still runs', async () => {
    // Even with --no-start, the read-back must populate effective state
    // so faucet (if enabled) and verify (if enabled) target the right
    // port. Asserting via writeDkgConfig staying uncalled (skip-write
    // branch taken) without throwing — the read-back sits on the same
    // branch entry that the F6 fix lifts out of the `else`.
    const dkgDir = join(tmpHome, '.dkg');
    mkdirSync(dkgDir, { recursive: true });
    writeFileSync(
      join(dkgDir, 'config.json'),
      JSON.stringify({ name: 'persisted', apiPort: 9400 }, null, 2),
    );
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, verify: false, fund: false }, deps);

    // Daemon-start was opted out, faucet was opted out — no port
    // assertion possible directly. The read-back's correctness here
    // is structural: the branch ran without throwing on the corrupt
    // configs / missing fields path the helper handles. Companion
    // assertion to the port-9300 case above.
    expect(deps.writeDkgConfig).not.toHaveBeenCalled();
    expect(deps.startDaemon).not.toHaveBeenCalled();
  });

  it('honours --no-start: skips daemon start; faucet path is gated on daemon reachability (F14)', async () => {
    // Pre-F14, --no-start was conflated with "skip funding" via the
    // outer `shouldFund && shouldStart` guard. Post-F14 the funding
    // decision is decoupled: if the daemon is reachable on
    // effectivePort, funding proceeds regardless of which invocation
    // started the daemon. This test pins the daemon-not-reachable
    // path: --no-start with no running daemon → faucet skipped via
    // the new explicit "daemon not reachable on port X" log line
    // (NOT the silent omission that pre-F14 produced).
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('connection refused');
    });

    await mcpSetupAction({ start: false, verify: false }, deps);

    expect(deps.startDaemon).not.toHaveBeenCalled();
    expect(deps.requestFaucetFunding).not.toHaveBeenCalled();
    // Registration still proceeds — orthogonal axis.
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(true);
    // And the new explicit log line fired (replacing the pre-F14
    // silent omission).
    const logged = (logSpy.mock.calls as any[]).map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/Skipping wallet funding \(daemon not reachable on port 9200\)/);

    fetchSpy.mockRestore();
  });

  // F14 (qa-review-round-2): the canonical decoupled-flow test.
  // --no-start with a daemon already running (e.g. user re-runs to
  // retry funding after the faucet was down on first run) MUST
  // proceed with funding — pre-F14 it was silently skipped because
  // the outer guard required `shouldStart === true`.
  it('F14: --no-start with daemon already reachable → funding proceeds', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      // Daemon is up and healthy; probe returns ok.
      return new Response('{}', { status: 200 }) as any;
    });

    await mcpSetupAction({ start: false, verify: false }, deps);

    expect(deps.startDaemon).not.toHaveBeenCalled();
    // Funding MUST proceed — daemon is reachable, --no-fund was not
    // supplied. This is the bug F14 fixes.
    expect(deps.requestFaucetFunding).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  });

  it('F14: --no-fund + --no-start → explicit-skip log (not the unreachable log)', async () => {
    // The --no-fund explicit-skip path takes precedence over the
    // daemon-reachability probe — no probe should fire when funding
    // is explicitly opted out, and the existing
    // "Skipping wallet funding (--no-fund)" log line stays intact.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('should not be called when --no-fund is set');
    });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(deps.requestFaucetFunding).not.toHaveBeenCalled();
    const logged = (logSpy.mock.calls as any[]).map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/Skipping wallet funding \(--no-fund\)/);
    // The unreachable-path log line MUST NOT fire when --no-fund
    // short-circuits the funding step.
    expect(logged).not.toMatch(/daemon not reachable/);

    fetchSpy.mockRestore();
  });

  it('honours --no-fund: skips the faucet step but starts daemon + registers', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();

    await mcpSetupAction({ fund: false, verify: false }, deps);

    expect(deps.startDaemon).toHaveBeenCalledTimes(1);
    expect(deps.requestFaucetFunding).not.toHaveBeenCalled();
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(true);
  });

  it('honours --dry-run: no filesystem writes, no daemon start, no faucet call', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();

    await mcpSetupAction({ dryRun: true }, deps);

    expect(deps.writeDkgConfig).not.toHaveBeenCalled();
    expect(deps.startDaemon).not.toHaveBeenCalled();
    expect(deps.requestFaucetFunding).not.toHaveBeenCalled();
    expect(existsSync(join(tmpHome, '.dkg', 'config.json'))).toBe(false);
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('honours --print-only: short-circuits before any other step', async () => {
    const deps = makeDeps();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true }, deps);

    expect(deps.writeDkgConfig).not.toHaveBeenCalled();
    expect(deps.startDaemon).not.toHaveBeenCalled();
    // Codex Issue 5: --print-only now emits TWO JSON blocks (the
    // canonical mcpServers.dkg shape PLUS a VSCode-shape note).
    // Use parseStdoutJson which walks the first balanced object.
    const parsed = parseStdoutJson(stdoutSpy);
    expect(parsed.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    stdoutSpy.mockRestore();
  });

  it('rejects an out-of-range --port at the action boundary', async () => {
    const deps = makeDeps();
    await expect(
      mcpSetupAction({ port: 'not-a-number' }, deps),
    ).rejects.toThrow(/Invalid port/);
    await expect(
      mcpSetupAction({ port: '99999' }, deps),
    ).rejects.toThrow(/Invalid port/);
  });

  it('--port and --name overrides flow through to writeDkgConfig', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();

    await mcpSetupAction({ port: '9300', name: 'override-agent', verify: false, fund: false }, deps);

    const writeArgs = (deps.writeDkgConfig as any).mock.calls[0];
    expect(writeArgs[0]).toBe('override-agent');
    expect(writeArgs[2]).toBe(9300);
    expect(writeArgs[3]).toEqual({ nameExplicit: true, portExplicit: true });
    // Daemon start uses the override port.
    expect((deps.startDaemon as any).mock.calls[0][0]).toBe(9300);
  });

  it('faucet failure logs manual instructions; setup continues to register clients', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps({
      requestFaucetFunding: vi.fn(async () => {
        throw new Error('faucet 503');
      }),
    });
    // F14 + F26: the funding step now probes daemon reachability via
    // `/api/status` before attempting the faucet call. Stub fetch to
    // mark the daemon reachable so the throwing-faucet mock is
    // actually reached. Without this stub the funding step would
    // short-circuit on the unreachable-path log line and the
    // throwing-faucet mock would never run.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('{}', { status: 200 }) as any;
    });

    await mcpSetupAction({ verify: false }, deps);

    expect(deps.logManualFundingInstructions).toHaveBeenCalledTimes(1);
    // Registration still proceeds.
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(true);

    fetchSpy.mockRestore();
  });

  // ── Phase-2: monorepo context detection + --installed/--monorepo flags ──

  // Helper: parse the single canonical JSON object from spied stdout.
  // Codex Round-2 Bug B: --print-only stdout is now contractually a
  // single JSON document (the VSCode-shape note + secondary block
  // moved to stderr). `JSON.parse(all)` would also work, but we
  // keep the brace-walking shape so leading/trailing whitespace
  // around the JSON body never trips the parser.
  const parseStdoutJson = (
    spy: ReturnType<typeof vi.spyOn>,
  ): Record<string, any> => {
    const all = (spy.mock.calls as any[]).map((c) => String(c[0])).join('');
    const start = all.indexOf('{');
    if (start < 0) throw new Error(`No JSON object in stdout: ${JSON.stringify(all)}`);
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < all.length; i++) {
      const ch = all[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return JSON.parse(all.slice(start, i + 1));
        }
      }
    }
    throw new Error(`Unbalanced JSON object in stdout: ${JSON.stringify(all)}`);
  };

  // Codex Bug 3: tests that pass a fake monorepoRoot via the
  // findDkgMonorepoRoot stub MUST also pre-create
  // `<root>/packages/cli/dist/cli.js` because canonicalEntry now
  // existsSync-checks the path before returning the monorepo entry.
  // This helper does both: builds a fake root under tmpHome, creates
  // the dist file as an empty placeholder, returns the root path.
  function makeFakeMonorepoRoot(): string {
    const root = join(tmpHome, 'fake-monorepo');
    const distDir = join(root, 'packages', 'cli', 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'cli.js'), '// fake CLI dist for tests\n');
    return root;
  }

  it('phase-2: --print-only with monorepo auto-detect emits the local-CLI-dist absolute-path form', async () => {
    const fakeRepoRoot = makeFakeMonorepoRoot();
    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true }, deps);

    const parsed = parseStdoutJson(stdoutSpy);
    // Codex Bug 2: command is `process.execPath` (absolute path to
    // the running Node binary), not bare `'node'`. args[0] is the
    // absolute path to the contributor's local CLI dist as produced
    // by path.join — platform-native separators.
    expect(parsed.mcpServers.dkg.command).toBe(process.execPath);
    expect(parsed.mcpServers.dkg.args[0]).toBe(
      join(fakeRepoRoot, 'packages', 'cli', 'dist', 'cli.js'),
    );
    expect(parsed.mcpServers.dkg.args.slice(1)).toEqual(['mcp', 'serve']);
    stdoutSpy.mockRestore();
  });

  it('phase-2: --print-only with no monorepo detected emits the standard `dkg` installed form', async () => {
    const deps = makeDeps(); // findDkgMonorepoRoot defaults to returning null
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true }, deps);

    const parsed = parseStdoutJson(stdoutSpy);
    expect(parsed.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    stdoutSpy.mockRestore();
  });

  it('phase-2: --installed forces the standard form even from inside a monorepo', async () => {
    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => makeFakeMonorepoRoot()),
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true, installed: true }, deps);

    const parsed = parseStdoutJson(stdoutSpy);
    expect(parsed.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    stdoutSpy.mockRestore();
  });

  it('phase-2: --monorepo from outside any monorepo throws the canonical error', async () => {
    const deps = makeDeps(); // findDkgMonorepoRoot returns null
    await expect(
      mcpSetupAction({ printOnly: true, monorepo: true }, deps),
    ).rejects.toThrow(/--monorepo flag passed but no DKG monorepo root/);
  });

  it('phase-2: --installed and --monorepo together throw the mutual-exclusion error', async () => {
    const deps = makeDeps();
    await expect(
      mcpSetupAction({ printOnly: true, installed: true, monorepo: true }, deps),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('phase-2: a stored installed-form entry classifies as `stale` when run in monorepo mode', async () => {
    // Stale-across-context: a config with the `dkg` (installed) form
    // is correct when the user is on the global install but stale
    // when they switch to a dev-checkout invocation. Asserts the
    // staleness detection compares against the context-aware
    // canonical entry, not a hardcoded form.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    // Pre-populate Cursor with the installed-form entry.
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify(
        { mcpServers: { dkg: { command: 'dkg', args: ['mcp', 'serve'] } } },
        null,
        2,
      ),
    );

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('connection refused');
    });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    // Post-write, the config now carries the monorepo-form entry —
    // command is `process.execPath` (Codex Bug 2), args[0] is the
    // absolute CLI dist path.
    const after = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(after.mcpServers.dkg.command).toBe(process.execPath);
    expect(after.mcpServers.dkg.args[0]).toBe(
      join(fakeRepoRoot, 'packages', 'cli', 'dist', 'cli.js'),
    );
    expect(after.mcpServers.dkg.args.slice(1)).toEqual(['mcp', 'serve']);

    fetchSpy.mockRestore();
  });

  // ── Phase-3: Claude Desktop + Windsurf detection + write ──────────

  /**
   * Helper: resolve the per-platform Claude Desktop config path under
   * a fake home root. Mirrors the production `claudeDesktopPaths`
   * resolver byte-for-byte so the test pins what the production
   * code does on whatever platform is running this test.
   */
  function claudeDesktopPathUnder(fakeHome: string): string {
    const p = platform();
    if (p === 'darwin') {
      return join(fakeHome, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    }
    if (p === 'win32') {
      const appData = process.env.APPDATA ?? join(fakeHome, 'AppData', 'Roaming');
      return join(appData, 'Claude', 'claude_desktop_config.json');
    }
    return join(fakeHome, '.config', 'Claude', 'claude_desktop_config.json');
  }

  it('phase-3: Claude Desktop is detected when its config dir exists; gets canonical entry written', async () => {
    // Pre-create the per-platform config directory so detection
    // fires even though the file doesn't exist yet (parent-dir
    // existence is a sufficient detection signal).
    const claudePath = claudeDesktopPathUnder(tmpHome);
    mkdirSync(join(claudePath, '..'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(claudePath)).toBe(true);
    const written = JSON.parse(readFileSync(claudePath, 'utf-8'));
    expect(written.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  it('phase-3: Windsurf is detected at ~/.codeium/windsurf/; gets canonical entry written', async () => {
    const windsurfPath = join(tmpHome, '.codeium', 'windsurf', 'mcp_config.json');
    mkdirSync(join(windsurfPath, '..'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(windsurfPath)).toBe(true);
    const written = JSON.parse(readFileSync(windsurfPath, 'utf-8'));
    expect(written.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  it('phase-3: clients with no config dir are not detected — silent and absent', async () => {
    // Cursor's parent dir exists (we'll pre-create it), but Claude
    // Desktop's and Windsurf's do NOT — so only Cursor should be
    // touched. Pins the "permissive but only when the parent
    // directory exists" detection contract.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(true);
    expect(existsSync(claudeDesktopPathUnder(tmpHome))).toBe(false);
    expect(existsSync(join(tmpHome, '.codeium', 'windsurf', 'mcp_config.json'))).toBe(false);
  });

  it('phase-3: pre-existing Claude Desktop entry on a sibling key is preserved', async () => {
    // Common real-world shape: a Claude Desktop user already has
    // other MCP servers registered. The setup must merge — write
    // `dkg` alongside without clobbering siblings.
    const claudePath = claudeDesktopPathUnder(tmpHome);
    mkdirSync(join(claudePath, '..'), { recursive: true });
    writeFileSync(
      claudePath,
      JSON.stringify(
        {
          mcpServers: {
            'some-other-server': { command: 'foo', args: ['bar'] },
          },
        },
        null,
        2,
      ),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const written = JSON.parse(readFileSync(claudePath, 'utf-8'));
    // Sibling preserved.
    expect(written.mcpServers['some-other-server']).toEqual({ command: 'foo', args: ['bar'] });
    // dkg added.
    expect(written.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  // ── Phase-4: VSCode + Copilot Chat (servers.dkg shape) ────────────

  /**
   * Helper: resolve VSCode + Copilot Chat's per-platform user-mcp
   * config path under a fake home root. Mirrors the production
   * `vscodeMcpPaths` resolver so the test pins exactly what the
   * production code does on this platform.
   */
  function vscodeMcpPathUnder(fakeHome: string): string {
    const p = platform();
    if (p === 'darwin') {
      return join(fakeHome, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    }
    if (p === 'win32') {
      const appData = process.env.APPDATA ?? join(fakeHome, 'AppData', 'Roaming');
      return join(appData, 'Code', 'User', 'mcp.json');
    }
    return join(fakeHome, '.config', 'Code', 'User', 'mcp.json');
  }

  it('phase-4: VSCode + Copilot Chat is detected and writes under `servers.dkg` (not `mcpServers.dkg`)', async () => {
    const vscodePath = vscodeMcpPathUnder(tmpHome);
    mkdirSync(join(vscodePath, '..'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(vscodePath)).toBe(true);
    const written = JSON.parse(readFileSync(vscodePath, 'utf-8'));
    // VSCode + Copilot Chat keys under `servers`, NOT `mcpServers`.
    // Pins the entryPath dispatch wired in phase 1.
    expect(written.servers?.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    // The canonical `mcpServers.dkg` shape MUST NOT be present in
    // VSCode's file — that would be the wrong key for Copilot Chat.
    expect(written.mcpServers).toBeUndefined();
  });

  it('phase-4: pre-existing VSCode `servers.<other>` siblings are preserved on merge', async () => {
    const vscodePath = vscodeMcpPathUnder(tmpHome);
    mkdirSync(join(vscodePath, '..'), { recursive: true });
    writeFileSync(
      vscodePath,
      JSON.stringify(
        { servers: { 'other-mcp': { command: 'baz' } } },
        null,
        2,
      ),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const written = JSON.parse(readFileSync(vscodePath, 'utf-8'));
    expect(written.servers['other-mcp']).toEqual({ command: 'baz' });
    expect(written.servers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  // ── Phase-5: Cline (deep-nested VSCode globalStorage path) ────────

  /**
   * Helper: resolve Cline's per-platform globalStorage settings
   * path under a fake home root. Mirrors the production
   * `clineMcpPaths` resolver byte-for-byte.
   */
  function clineMcpPathUnder(fakeHome: string): string {
    const suffix = join(
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    );
    const p = platform();
    if (p === 'darwin') {
      return join(fakeHome, 'Library', 'Application Support', 'Code', 'User', suffix);
    }
    if (p === 'win32') {
      const appData = process.env.APPDATA ?? join(fakeHome, 'AppData', 'Roaming');
      return join(appData, 'Code', 'User', suffix);
    }
    return join(fakeHome, '.config', 'Code', 'User', suffix);
  }

  it('phase-5: Cline is detected at VSCode globalStorage and writes canonical `mcpServers.dkg`', async () => {
    const clinePath = clineMcpPathUnder(tmpHome);
    // Pre-create the parent dir (the deep-nested
    // globalStorage/saoudrizwan.claude-dev/settings/ chain) so
    // detection fires.
    mkdirSync(join(clinePath, '..'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(clinePath)).toBe(true);
    const written = JSON.parse(readFileSync(clinePath, 'utf-8'));
    // Cline keys under canonical `mcpServers.dkg` (unlike VSCode's
    // `servers.dkg`), so no entryPath override on the candidate.
    expect(written.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  it('phase-5: Cline siblings preserved — pre-existing entries don\'t get clobbered', async () => {
    const clinePath = clineMcpPathUnder(tmpHome);
    mkdirSync(join(clinePath, '..'), { recursive: true });
    writeFileSync(
      clinePath,
      JSON.stringify(
        { mcpServers: { 'github': { command: 'gh-mcp' } } },
        null,
        2,
      ),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const written = JSON.parse(readFileSync(clinePath, 'utf-8'));
    expect(written.mcpServers['github']).toEqual({ command: 'gh-mcp' });
    expect(written.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
  });

  // ── F30: resolve absolute `dkg` bin path on installed-mode setup ──

  // ── Codex Round-4: process.execPath unification ──────────────────

  it('Codex Round-4: installed mode writes process.execPath + cli.js path (no `dkg` bin shim)', async () => {
    // Round-4 unified the canonical entry shape across both modes.
    // Installed mode: `{ command: process.execPath, args: [<cli.js>,
    // 'mcp', 'serve'] }` — Node binary directly + the cli.js script
    // Node is currently executing. No more `which dkg` step; no
    // dependency on `dkg` shim or `node` binary being on the GUI
    // client's PATH.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const cursorConfig = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursorConfig.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    // Specific shape pins:
    expect(cursorConfig.mcpServers.dkg.command).toBe(process.execPath);
    expect(typeof cursorConfig.mcpServers.dkg.args[0]).toBe('string');
    expect(cursorConfig.mcpServers.dkg.args.slice(1)).toEqual(['mcp', 'serve']);
    // Belt-and-braces: the registered command MUST NOT be the bare
    // `dkg` shim form anymore — that's the F30 PATH-dependency we
    // removed by switching to direct-Node invocation.
    expect(cursorConfig.mcpServers.dkg.command).not.toBe('dkg');
  });

  it('Codex Round-4: monorepo mode writes process.execPath + local cli.dist path', async () => {
    // Monorepo mode is byte-aligned with installed mode on the
    // command field (process.execPath) and differs only on args[0]
    // (local cli.dist absolute path vs the installed cli.js path
    // realpathSync resolves to). Asserts the unification.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const cursorConfig = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursorConfig.mcpServers.dkg.command).toBe(process.execPath);
    expect(cursorConfig.mcpServers.dkg.args[0]).toBe(
      join(fakeRepoRoot, 'packages', 'cli', 'dist', 'cli.js'),
    );
    expect(cursorConfig.mcpServers.dkg.args.slice(1)).toEqual(['mcp', 'serve']);
  });

  it('Codex Round-4: legacy bare-"dkg" entries auto-migrate to process.execPath form on stock re-run', async () => {
    // Pre-Round-4 setup runs (or pre-F30 hand-edited configs) wrote
    // `{ command: "dkg", args: ["mcp", "serve"] }`. Round-4's pure
    // string equality classifier sees that as `stale` against the
    // new `process.execPath + cli.js` expected entry, and refreshes
    // to the new shape on a stock re-run — no `--force` needed.
    //
    // This is the migration story for users upgrading from any
    // earlier version of the setup tool.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify(
        { mcpServers: { dkg: { command: 'dkg', args: ['mcp', 'serve'] } } },
        null,
        2,
      ),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const after = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(after.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    expect(after.mcpServers.dkg.command).toBe(process.execPath);
  });

  it('Codex Round-4: pre-existing F30-style absolute `dkg` bin entry ALSO migrates (uniform classifier)', async () => {
    // The interim Round-1 F30 form was `{ command: "/usr/local/bin/
    // dkg", args: ["mcp", "serve"] }`. Round-4's process.execPath
    // form supersedes it (skips the bin shim entirely). Pure
    // string equality classifies the old absolute-bin entry as
    // `stale` and migrates it forward — no special-casing needed.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    const legacyAbsBin = platform() === 'win32'
      ? 'C:\\Users\\test\\AppData\\Local\\fnm\\dkg.exe'
      : '/usr/local/bin/dkg';
    writeFileSync(
      join(cursorDir, 'mcp.json'),
      JSON.stringify(
        { mcpServers: { dkg: { command: legacyAbsBin, args: ['mcp', 'serve'] } } },
        null,
        2,
      ),
    );

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const after = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(after.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    expect(after.mcpServers.dkg.command).not.toBe(legacyAbsBin);
  });

  // ── F31: per-client interactive confirm prompts ───────────────────

  it('F31: --yes skips prompts; confirmPlan stub passes plan through unchanged', async () => {
    // The action MUST call confirmPlan with `yes: true` so the
    // stub knows the operator opted into auto-confirm. The stub
    // returns the plan unchanged → all detected clients register.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const confirmPlan = vi.fn(async (planned: any) => [...planned]);
    const deps = makeDeps({ confirmPlan });

    await mcpSetupAction({ start: false, fund: false, verify: false, yes: true }, deps);

    expect(confirmPlan).toHaveBeenCalledTimes(1);
    expect(confirmPlan.mock.calls[0][1]).toEqual({ yes: true });
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(true);
  });

  it('F31: confirmPlan-stub-says-no on a single-client plan → zero writes', async () => {
    // Operator declined the only pending registration. The action
    // emits the "All pending registrations declined" log line and
    // writes nothing. Asserts the decline path is non-fatal and
    // the file stays absent.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const confirmPlan = vi.fn(async (planned: any) =>
      planned.map((p: any) => ({ ...p, action: 'skip' })),
    );
    const deps = makeDeps({ confirmPlan });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(confirmPlan).toHaveBeenCalledTimes(1);
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
    const logged = (logSpy.mock.calls as any[]).map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/All pending registrations declined/);
    // Codex Round-5 Fix 7: the guidance recommends `--yes` (skips
    // prompts), not `--force` alone (which only refreshes
    // already-registered clients but still prompts in TTY mode). A
    // re-run with `--force` would re-prompt the same declined
    // entries; only `--yes` (or `--force --yes`) escapes the prompt
    // loop.
    expect(logged).toMatch(/--yes/);
    expect(logged).not.toMatch(/Re-run with --force or --yes/);
  });

  it('F31: mixed yes/no — declined entries skip; accepted entries register', async () => {
    // Two clients pending. Stub declines Cursor, accepts Claude
    // Desktop. Post-action: only Claude Desktop's file exists.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const claudePath = claudeDesktopPathUnder(tmpHome);
    mkdirSync(join(claudePath, '..'), { recursive: true });

    const confirmPlan = vi.fn(async (planned: any) =>
      planned.map((p: any) =>
        p.s.target.name === 'Cursor' ? { ...p, action: 'skip' } : p,
      ),
    );
    const deps = makeDeps({ confirmPlan });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
    expect(existsSync(claudePath)).toBe(true);
  });

  it('F31: all-skip plan (everything already registered) → confirmPlan still called but produces zero writes', async () => {
    // Pre-populate every detected-by-default client with the
    // Round-4 canonical entry (process.execPath + cli.js path) so
    // they all classify as `registered`. Plan ends up all-skip;
    // confirmPlan still called (the action doesn't pre-filter) but
    // no writes follow.
    const cursorDir = join(tmpHome, '.cursor');
    mkdirSync(cursorDir, { recursive: true });
    const canonical = { mcpServers: { dkg: EXPECTED_INSTALLED_ENTRY() } };
    writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify(canonical, null, 2));
    // ~/.claude.json's parent IS tmpHome → always detected. Pre-register.
    writeFileSync(join(tmpHome, '.claude.json'), JSON.stringify(canonical, null, 2));
    const beforeCursor = (await import('node:fs')).statSync(join(cursorDir, 'mcp.json')).mtimeMs;
    const beforeClaude = (await import('node:fs')).statSync(join(tmpHome, '.claude.json')).mtimeMs;

    const confirmPlan = vi.fn(async (planned: any) => [...planned]);
    const deps = makeDeps({ confirmPlan });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    // No rewrite of either file — both existing entries' mtimes
    // are unchanged.
    const afterCursor = (await import('node:fs')).statSync(join(cursorDir, 'mcp.json')).mtimeMs;
    const afterClaude = (await import('node:fs')).statSync(join(tmpHome, '.claude.json')).mtimeMs;
    expect(afterCursor).toBe(beforeCursor);
    expect(afterClaude).toBe(beforeClaude);
    // The "all up-to-date" log line fires (the original phrasing,
    // NOT the F31 declined-prompt phrasing).
    const logged = (logSpy.mock.calls as any[]).map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/Clients all up-to-date/);
    expect(logged).not.toMatch(/All pending registrations declined/);
  });

  it('F31: dry-run skips confirmPlan entirely (preview-only; no point asking about non-writes)', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const confirmPlan = vi.fn(async (planned: any) => [...planned]);
    const deps = makeDeps({ confirmPlan });

    await mcpSetupAction({ dryRun: true }, deps);

    expect(confirmPlan).not.toHaveBeenCalled();
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('F31: production confirmPlan auto-confirms when stdin.isTTY is false (CI / piped input)', async () => {
    // Direct test of the production helper (not the stub) — we
    // import it from the same module and call it without going
    // through `mcpSetupAction`. This pins the non-TTY auto-confirm
    // contract that lets CI runs work without `--yes`.
    const { confirmPlan: prodConfirmPlan } = await import('../src/mcp-setup.js');
    const fakePlan = [
      { s: { target: { name: 'Cursor', displayPath: '~/.cursor/mcp.json' } } as any, action: 'register' as const },
      { s: { target: { name: 'Claude Code', displayPath: '~/.claude.json' } } as any, action: 'refresh' as const },
    ];

    // Vitest already runs non-TTY; document the assumption and
    // assert the no-prompt path returns the plan unchanged.
    expect(process.stdin.isTTY).toBeFalsy();
    const result = await prodConfirmPlan(fakePlan, { yes: false });
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.action)).toEqual(['register', 'refresh']);
  });

  it('Codex Round-4 Fix 5: confirmPlan auto-confirms when stdout.isTTY is false even if stdin.isTTY is true', async () => {
    // Pre-fix: the auto-confirm guard only checked
    // `process.stdin.isTTY`. If stdout was redirected/captured but
    // stdin still happened to be a TTY (e.g. `dkg mcp setup > log.txt`
    // from an interactive shell), the helper opened a readline
    // prompt that emitted to a non-visible stdout — the user saw
    // nothing while their terminal blocked.
    //
    // Post-fix: BOTH stdin AND stdout must be TTY before prompting.
    // Either non-TTY end ⇒ auto-confirm.
    const { confirmPlan: prodConfirmPlan } = await import('../src/mcp-setup.js');
    const fakePlan = [
      { s: { target: { name: 'Cursor', displayPath: '~/.cursor/mcp.json' } } as any, action: 'register' as const },
    ];

    const originalStdinIsTTY = process.stdin.isTTY;
    const originalStdoutIsTTY = process.stdout.isTTY;
    try {
      // Force stdin TTY=true (the scenario the pre-fix missed),
      // stdout TTY=false (redirected). The post-fix guard MUST
      // auto-confirm and not block on readline.
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });

      // No timeout / hang protection needed — if the guard regresses
      // and the helper actually prompts, vitest's per-test timeout
      // catches it. Under the post-fix guard, this resolves
      // synchronously with the plan unchanged.
      const result = await prodConfirmPlan(fakePlan, { yes: false });
      expect(result).toHaveLength(1);
      expect(result[0].action).toBe('register');
    } finally {
      // Restore the original TTY flags so subsequent tests aren't
      // affected by the override.
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalStdinIsTTY,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutIsTTY,
        configurable: true,
      });
    }
  });

  // ── PR #394 Codex review round 1 ────────────────────────────────

  it('Codex Bug 1: detectContext passes process.cwd() to findDkgMonorepoRoot', async () => {
    // Pre-fix: findDkgMonorepoRoot() was called with no argument,
    // defaulting to the dirname of @origintrail-official/dkg-core's
    // installed location. For a globally-installed CLI run from
    // inside a user's monorepo cwd, that walks node_modules/...
    // not the user's cwd → monorepo auto-detect never fires.
    // Post-fix: cwd is passed explicitly.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const findStub = vi.fn((startDir?: string) => {
      // Mimic the production semantic: only return monorepo root
      // when startDir is something inside the monorepo. Without the
      // Bug 1 fix, startDir would be undefined here (default arg).
      return startDir ? fakeRepoRoot : null;
    });
    const deps = makeDeps({ findDkgMonorepoRoot: findStub });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    // The stub was called with a defined startDir argument (the
    // production code now passes process.cwd() explicitly).
    expect(findStub).toHaveBeenCalled();
    const callArg = findStub.mock.calls[0][0];
    expect(callArg).toBeDefined();
    expect(typeof callArg).toBe('string');
    // Monorepo mode fired: the entry uses execPath + cli.js, not the
    // bare-`"dkg"` installed form.
    const cursorConfig = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    expect(cursorConfig.mcpServers.dkg.command).toBe(process.execPath);
  });

  it('Codex Bug 2: monorepo entry uses process.execPath, not bare "node"', async () => {
    // Pre-fix: command was hard-coded to 'node'. Same PATH-
    // inheritance failure as bare-`"dkg"` for GUI MCP clients.
    // Post-fix: process.execPath (absolute path to running Node).
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const cursorConfig = JSON.parse(readFileSync(join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    // process.execPath is always an absolute path; assert that
    // shape rather than hardcoding the runtime-specific value.
    expect(cursorConfig.mcpServers.dkg.command).toBe(process.execPath);
    expect(cursorConfig.mcpServers.dkg.command).not.toBe('node');
    // Sanity: it's actually absolute on this platform.
    expect(cursorConfig.mcpServers.dkg.command.length).toBeGreaterThan(4);
  });

  it('Codex Bug 3: monorepo mode errors clearly when local cli.dist/cli.js is missing', async () => {
    // Fresh checkout / pnpm clean / source-only edits all leave
    // dist absent. Pre-fix: setup wrote a broken entry that points
    // at a non-existent file, overwriting a previously-working
    // installed registration. Post-fix: throws an actionable error
    // and writes nothing.
    const fakeRepoRoot = join(tmpHome, 'fake-monorepo-no-dist');
    // Deliberately do NOT create packages/cli/dist/cli.js — root exists
    // (so findDkgMonorepoRoot's stub returning it is plausible) but
    // the dist file is absent.
    mkdirSync(fakeRepoRoot, { recursive: true });
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });

    await expect(
      mcpSetupAction({ start: false, fund: false, verify: false }, deps),
    ).rejects.toThrow(/Local CLI dist not found at .*Run `pnpm.*build` first/);

    // No client config was written; the previously-empty Cursor
    // dir stays empty (no file touched).
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('Codex Issue 5 + Round-2 Bug B: --print-only stdout stays pure canonical JSON; VSCode note goes to stderr', async () => {
    // Round-1 of Issue 5: --print-only appended a second JSON block
    // + prose to stdout to disambiguate VSCode's `servers.dkg`
    // shape. Round-2 Codex feedback: that broke the
    // `dkg mcp setup --print-only | jq …` flag contract — stdout
    // must be a single canonical JSON document. Final shape: stdout
    // stays the canonical `mcpServers.dkg` block (single JSON
    // document, parses cleanly with `jq`), and the VSCode-shape
    // note is emitted on stderr instead.
    const deps = makeDeps();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true }, deps);

    // STDOUT: a single JSON document, parseable as-is — no prose,
    // no second object. This is the `dkg mcp setup --print-only |
    // jq …` flag contract.
    const stdoutText = (stdoutSpy.mock.calls as any[]).map((c) => String(c[0])).join('');
    const stdoutParsed = JSON.parse(stdoutText);
    expect(stdoutParsed.mcpServers.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());
    // No `servers.dkg` (the VSCode shape) on stdout — keeps it
    // machine-readable.
    expect(stdoutParsed.servers).toBeUndefined();

    // STDERR: the VSCode-shape disambiguation note + a second JSON
    // block under `servers.dkg`. Same entry contents as the canonical
    // block — pinning that the note isn't drift.
    const stderrText = (stderrSpy.mock.calls as any[]).map((c) => String(c[0])).join('');
    expect(stderrText).toMatch(/VSCode/i);
    expect(stderrText).toMatch(/servers\.dkg/);
    // The stderr note contains a parseable `{ servers: { dkg: ... } }`
    // block; extract the JSON portion (between the first `{` and the
    // matching closing `}`) and parse it.
    const stderrJsonStart = stderrText.indexOf('{');
    expect(stderrJsonStart).toBeGreaterThanOrEqual(0);
    const stderrJsonText = stderrText.slice(stderrJsonStart).trim();
    const stderrParsed = JSON.parse(stderrJsonText);
    expect(stderrParsed.servers?.dkg).toEqual(EXPECTED_INSTALLED_ENTRY());

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('phase-4: VSCode staleness — pre-existing dkg entry under `servers.dkg` reclassifies on context flip to monorepo', async () => {
    // Cross-shape staleness: a Cursor-shaped entry written into
    // VSCode's `servers.dkg` wouldn't classify as `registered` if
    // the canonical entry's command/args differ. Here we pin the
    // installed→monorepo flip works for VSCode the same as for
    // Cursor (phase-2 covered the Cursor case).
    const fakeRepoRoot = makeFakeMonorepoRoot();
    const vscodePath = vscodeMcpPathUnder(tmpHome);
    mkdirSync(join(vscodePath, '..'), { recursive: true });
    writeFileSync(
      vscodePath,
      JSON.stringify(
        { servers: { dkg: { command: 'dkg', args: ['mcp', 'serve'] } } },
        null,
        2,
      ),
    );

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('connection refused');
    });

    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    const written = JSON.parse(readFileSync(vscodePath, 'utf-8'));
    // Codex Bug 2: command is process.execPath, not bare 'node'.
    expect(written.servers.dkg.command).toBe(process.execPath);
    expect(written.servers.dkg.args[0]).toBe(
      join(fakeRepoRoot, 'packages', 'cli', 'dist', 'cli.js'),
    );

    fetchSpy.mockRestore();
  });

  // ── Codex Round-2 review fixes ────────────────────────────────────

  it('Codex Round-2 Bug A: monorepo context routes DKG home to dev dir + sets DKG_HOME', async () => {
    // Pre-fix: mcpSetupAction hard-coded `~/.dkg` regardless of
    // monorepo detection. The registered local CLI dist (whose
    // own dkgDir() resolves to `~/.dkg-dev` from inside the
    // monorepo) would read a different home than mcp-setup just
    // bootstrapped — config / daemon / faucet split across two
    // dirs. Post-fix: thread the monorepo signal into
    // `resolveDkgConfigHome({ isDkgMonorepo: true })` and set
    // `DKG_HOME` so adapter-openclaw's dkgDir() and dkg-core's
    // daemon-lifecycle agree on the dev home.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    let isDkgMonorepoArg: boolean | undefined;
    let dkgHomeAtWriteCall: string | undefined;
    let dkgHomeAtStartDaemonCall: string | undefined;

    const resolveDkgConfigHomeSpy = vi.fn((opts: { isDkgMonorepo?: boolean } = {}) => {
      isDkgMonorepoArg = opts.isDkgMonorepo;
      const dir = opts.isDkgMonorepo ? join(tmpHome, '.dkg-dev') : join(tmpHome, '.dkg');
      mkdirSync(dir, { recursive: true });
      return dir;
    });

    const writeDkgConfigSpy = vi.fn((agentName: string, _network: any, apiPort: number) => {
      // Capture the env at the moment writeDkgConfig is invoked so
      // we can assert that DKG_HOME was set BEFORE step 1's write.
      dkgHomeAtWriteCall = process.env.DKG_HOME;
      const dir = process.env.DKG_HOME ?? join(tmpHome, '.dkg');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ name: agentName, apiPort, nodeRole: 'edge' }, null, 2),
      );
    });

    const startDaemonSpy = vi.fn(async (_port: number) => {
      dkgHomeAtStartDaemonCall = process.env.DKG_HOME;
    });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
      resolveDkgConfigHome: resolveDkgConfigHomeSpy,
      writeDkgConfig: writeDkgConfigSpy,
      startDaemon: startDaemonSpy,
    });

    await mcpSetupAction({ fund: false, verify: false }, deps);

    // (1) resolveDkgConfigHome was called with isDkgMonorepo: true —
    // the monorepo signal threaded through.
    expect(isDkgMonorepoArg).toBe(true);

    // (2) DKG_HOME was set BEFORE step 1's writeDkgConfig and was
    // still set BEFORE step 2's startDaemon. Both downstream
    // primitives delegate to dkgDir() which respects this env var,
    // so all four flows (mcp-setup, openclaw, core daemon-lifecycle,
    // and the registered local CLI) land in the SAME home.
    expect(dkgHomeAtWriteCall).toBe(join(tmpHome, '.dkg-dev'));
    expect(dkgHomeAtStartDaemonCall).toBe(join(tmpHome, '.dkg-dev'));

    // (3) The bootstrapped config landed in the dev home, not ~/.dkg.
    expect(existsSync(join(tmpHome, '.dkg-dev', 'config.json'))).toBe(true);
    expect(existsSync(join(tmpHome, '.dkg', 'config.json'))).toBe(false);
  });

  it('Codex Round-2 Bug A: installed context keeps DKG home at ~/.dkg (no dev-dir leak)', async () => {
    // Counterpart to the monorepo case: when no monorepo is
    // detected, DKG home stays at the canonical `~/.dkg`. Pre-fix
    // and post-fix behaviour byte-aligned for installed-mode users.
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });

    let isDkgMonorepoArg: boolean | undefined;
    const resolveDkgConfigHomeSpy = vi.fn((opts: { isDkgMonorepo?: boolean } = {}) => {
      isDkgMonorepoArg = opts.isDkgMonorepo;
      return join(tmpHome, '.dkg');
    });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => null),
      resolveDkgConfigHome: resolveDkgConfigHomeSpy,
    });

    // Capture DKG_HOME at write time (mid-action) — the only
    // observable point where the env mutation is visible. Round-3
    // Fix 3 added a try/finally that restores DKG_HOME after the
    // action returns, so reading it post-`await` no longer reflects
    // the in-action value.
    let dkgHomeAtWriteCall: string | undefined;
    const writeDkgConfigSpy = vi.fn((agentName: string, _network: any, apiPort: number) => {
      dkgHomeAtWriteCall = process.env.DKG_HOME;
      const dir = process.env.DKG_HOME ?? join(tmpHome, '.dkg');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ name: agentName, apiPort, nodeRole: 'edge' }, null, 2),
      );
    });
    (deps as any).writeDkgConfig = writeDkgConfigSpy;

    await mcpSetupAction({ fund: false, verify: false }, deps);

    expect(isDkgMonorepoArg).toBe(false);
    // During the action, DKG_HOME was the resolved installed home.
    expect(dkgHomeAtWriteCall).toBe(join(tmpHome, '.dkg'));
    expect(existsSync(join(tmpHome, '.dkg', 'config.json'))).toBe(true);
    // No accidental .dkg-dev creation on the installed path.
    expect(existsSync(join(tmpHome, '.dkg-dev'))).toBe(false);
  });

  // ── Codex Round-5 Fix 6: --monorepo bypasses configExists fallback ─

  it('Codex Round-5 Fix 6: --monorepo with pre-existing ~/.dkg/config.json still isolates to ~/.dkg-dev', async () => {
    // Pre-fix: `--monorepo` only set `isDkgMonorepo: true` on the
    // resolveDkgConfigHome call. The helper still respected the
    // configExists short-circuit (Round-3 Fix 2 made it OR
    // config.json | config.yaml), so a user with a pre-existing
    // `~/.dkg/config.json` (typical for anyone who has ever
    // installed the global CLI) who passed `--monorepo` would
    // bootstrap their local checkout against the installed node's
    // state — exactly the dev/installed mixup the flag is meant
    // to break.
    //
    // Post-fix: `--monorepo` (forcedContext === 'monorepo' AND a
    // monorepo root located) bypasses resolveDkgConfigHome
    // entirely, computing `~/.dkg-dev` directly via homedir().
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    // Pre-existing `~/.dkg/config.json` — the configExists short-
    // circuit would normally redirect us back to `~/.dkg`.
    const installedDkg = join(tmpHome, '.dkg');
    mkdirSync(installedDkg, { recursive: true });
    writeFileSync(
      join(installedDkg, 'config.json'),
      JSON.stringify({ name: 'persisted', apiPort: 9200, nodeRole: 'edge' }, null, 2),
    );

    // Real production-shape resolveDkgConfigHome stub: respects
    // configExists. The Fix 6 bypass means this stub MUST NOT be
    // called when `--monorepo` is forced.
    const resolveDkgConfigHomeSpy = vi.fn((opts: { isDkgMonorepo?: boolean; configExists?: boolean } = {}) => {
      // Mirror production: configExists wins over isDkgMonorepo.
      if (opts.configExists ?? existsSync(join(installedDkg, 'config.json'))) {
        return installedDkg;
      }
      if (opts.isDkgMonorepo) return join(tmpHome, '.dkg-dev');
      return installedDkg;
    });

    let dkgHomeAtWriteCall: string | undefined;
    const writeDkgConfigSpy = vi.fn((agentName: string, _network: any, apiPort: number) => {
      dkgHomeAtWriteCall = process.env.DKG_HOME;
      const dir = process.env.DKG_HOME ?? installedDkg;
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ name: agentName, apiPort, nodeRole: 'edge' }, null, 2),
      );
    });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
      resolveDkgConfigHome: resolveDkgConfigHomeSpy,
      writeDkgConfig: writeDkgConfigSpy,
    });

    await mcpSetupAction({ monorepo: true, fund: false, verify: false }, deps);

    // (1) The bypass kicked in: resolveDkgConfigHome was NOT called
    // for the dkgDirPath computation under forced --monorepo.
    expect(resolveDkgConfigHomeSpy).not.toHaveBeenCalled();
    // (2) DKG_HOME was set to ~/.dkg-dev mid-action — bootstrap
    // state landed in the dev home, NOT the installed home.
    expect(dkgHomeAtWriteCall).toBe(join(tmpHome, '.dkg-dev'));
    // (3) The pre-existing installed config is untouched.
    const installedConfig = JSON.parse(readFileSync(join(installedDkg, 'config.json'), 'utf-8'));
    expect(installedConfig.name).toBe('persisted');
    // (4) The dev-home config was newly written.
    expect(existsSync(join(tmpHome, '.dkg-dev', 'config.json'))).toBe(true);
  });

  it('Codex Round-5 Fix 6: --monorepo with pre-existing ~/.dkg/config.yaml still isolates to ~/.dkg-dev', async () => {
    // Same as above but with YAML instead of JSON. Round-3 Fix 2
    // extended configExists to OR both file types; Round-5 Fix 6
    // bypasses the whole short-circuit when --monorepo is forced,
    // so neither file shape redirects the dev-home isolation.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const installedDkg = join(tmpHome, '.dkg');
    mkdirSync(installedDkg, { recursive: true });
    writeFileSync(join(installedDkg, 'config.yaml'), 'name: persisted\napiPort: 9200\n');

    const resolveDkgConfigHomeSpy = vi.fn(() => installedDkg);
    let dkgHomeAtWriteCall: string | undefined;
    const writeDkgConfigSpy = vi.fn((agentName: string, _network: any, apiPort: number) => {
      dkgHomeAtWriteCall = process.env.DKG_HOME;
      const dir = process.env.DKG_HOME ?? installedDkg;
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ name: agentName, apiPort, nodeRole: 'edge' }, null, 2),
      );
    });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
      resolveDkgConfigHome: resolveDkgConfigHomeSpy,
      writeDkgConfig: writeDkgConfigSpy,
    });

    await mcpSetupAction({ monorepo: true, fund: false, verify: false }, deps);

    expect(resolveDkgConfigHomeSpy).not.toHaveBeenCalled();
    expect(dkgHomeAtWriteCall).toBe(join(tmpHome, '.dkg-dev'));
    // YAML preserved untouched.
    const yaml = readFileSync(join(installedDkg, 'config.yaml'), 'utf-8');
    expect(yaml).toContain('name: persisted');
  });

  it('Codex Round-5 Fix 6: AUTO-detect (no --monorepo flag) + monorepo cwd + existing ~/.dkg/config.json → still respects configExists, returns ~/.dkg', async () => {
    // Pin the asymmetry between forced and auto. Auto-detect
    // monorepo (no flag) MUST keep the configExists short-circuit
    // — users who installed the CLI globally and happen to walk
    // into a monorepo checkout shouldn't be silently redirected
    // to a dev home they don't know about.
    //
    // Only the explicit --monorepo flag bypasses the fallback;
    // auto-detect defers to resolveDkgConfigHome's existing
    // semantics.
    const fakeRepoRoot = makeFakeMonorepoRoot();
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const installedDkg = join(tmpHome, '.dkg');
    mkdirSync(installedDkg, { recursive: true });
    writeFileSync(
      join(installedDkg, 'config.json'),
      JSON.stringify({ name: 'persisted', apiPort: 9200, nodeRole: 'edge' }, null, 2),
    );

    let resolveCallArgs: { isDkgMonorepo?: boolean } | undefined;
    const resolveDkgConfigHomeSpy = vi.fn((opts: { isDkgMonorepo?: boolean } = {}) => {
      resolveCallArgs = opts;
      // Mirror production semantics: configExists wins → ~/.dkg.
      return installedDkg;
    });

    // Use startDaemon as the mid-action observable. With a
    // pre-existing config, the action skips writeDkgConfig (F25
    // reconcile path), but startDaemon always runs and DKG_HOME is
    // already set by the time it does.
    let dkgHomeAtStartDaemon: string | undefined;
    const startDaemonSpy = vi.fn(async (_port: number) => {
      dkgHomeAtStartDaemon = process.env.DKG_HOME;
    });

    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
      resolveDkgConfigHome: resolveDkgConfigHomeSpy,
      startDaemon: startDaemonSpy,
    });

    // No --monorepo flag — auto-detect path.
    await mcpSetupAction({ fund: false, verify: false }, deps);

    // (1) resolveDkgConfigHome WAS called (auto-detect doesn't
    // bypass), and isDkgMonorepo: true was passed to it.
    expect(resolveDkgConfigHomeSpy).toHaveBeenCalledTimes(1);
    expect(resolveCallArgs?.isDkgMonorepo).toBe(true);
    // (2) Despite the monorepo signal, configExists short-circuit
    // returned ~/.dkg, and DKG_HOME mid-action reflects that.
    expect(dkgHomeAtStartDaemon).toBe(installedDkg);
    // (3) No accidental .dkg-dev creation on the auto-detect path
    // when an installed config already exists.
    expect(existsSync(join(tmpHome, '.dkg-dev'))).toBe(false);
  });

  it('Codex Round-2 Bug B: --print-only stdout is a single parseable JSON document (jq-compatible)', async () => {
    // Round-1 of Issue 5 emitted the canonical JSON + prose + a
    // second JSON object on stdout, breaking
    // `dkg mcp setup --print-only | jq …`. Round-2 fix: stdout
    // stays a single JSON document. This test asserts the strict
    // contract: `JSON.parse(allStdout)` succeeds, with no leftover
    // bytes after the canonical block.
    const deps = makeDeps();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true }, deps);

    const stdoutText = (stdoutSpy.mock.calls as any[]).map((c) => String(c[0])).join('');
    // jq-style strict parse: the entire stdout (after trimming
    // trailing newline) must round-trip through JSON.parse with
    // nothing left over.
    const trimmed = stdoutText.trim();
    expect(() => JSON.parse(trimmed)).not.toThrow();
    const parsed = JSON.parse(trimmed);
    // Exactly one top-level key: `mcpServers`. No `servers` (VSCode
    // shape) on stdout.
    expect(Object.keys(parsed)).toEqual(['mcpServers']);
    // No prose contamination on stdout.
    expect(stdoutText).not.toMatch(/Note/);
    expect(stdoutText).not.toMatch(/VSCode/i);

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  // Codex Round-2 Bug C tests retired: Round-4's process.execPath
  // unification eliminated the `isAbsoluteDkgBinPath` equivalence
  // those tests pinned. Both modes now write the same absolute
  // process.execPath form, so any divergent entry — bare `"dkg"`,
  // an old absolute-bin path, a moved-checkout cli.js path —
  // classifies as `stale` via pure string equality and refreshes
  // forward. The auto-migration story is exercised by the
  // "legacy bare-`dkg` migrates" and "F30-style absolute migrates"
  // Round-4 tests above.

  // ── Codex Round-3 Fix 3: try/finally DKG_HOME env mutation ────────

  it('Codex Round-3 Fix 3: action throwing midway restores DKG_HOME', async () => {
    // Pre-fix: `process.env.DKG_HOME = dkgDirPath` was a permanent
    // global side effect. If the action threw mid-body (e.g. step 2's
    // `startDaemon` rejected; step 4's client-config write hit a
    // permissions error), the override leaked into the rest of the
    // process and any unrelated downstream code reading DKG_HOME.
    //
    // Post-fix: try/finally wraps the action body. The finally
    // restores the prior `DKG_HOME` value (or unsets it if it wasn't
    // set going in) on BOTH throw and normal exit.
    const PRIOR = '/some/external/dkg-home';
    process.env.DKG_HOME = PRIOR;

    // Force a throw mid-action: stub `startDaemon` to reject. By
    // then DKG_HOME has been mutated to `<tmpHome>/.dkg`.
    const deps = makeDeps({
      startDaemon: vi.fn(async () => {
        throw new Error('synthetic startDaemon failure for env-restore test');
      }),
    });

    await expect(
      mcpSetupAction({ fund: false, verify: false }, deps),
    ).rejects.toThrow(/synthetic startDaemon failure/);

    // The finally restored DKG_HOME to its prior value.
    expect(process.env.DKG_HOME).toBe(PRIOR);
  });

  it('Codex Round-3 Fix 3: action with previously-unset DKG_HOME deletes the var on exit', async () => {
    // Counterpart: when DKG_HOME wasn't set going into the action,
    // the finally must DELETE it (not set to `undefined` or empty
    // string), so the next caller's `process.env.DKG_HOME` lookup
    // sees `undefined` and falls through to the auto-detect path.
    delete process.env.DKG_HOME;

    const deps = makeDeps();
    await mcpSetupAction({ fund: false, verify: false }, deps);

    expect(process.env.DKG_HOME).toBeUndefined();
    expect('DKG_HOME' in process.env).toBe(false);
  });

  it('Codex Round-3 Fix 3: two sequential mcpSetupAction calls don\'t bleed env state', async () => {
    // Two back-to-back calls with different contexts: the first
    // forces monorepo (sets DKG_HOME to `<tmpHome>/.dkg-dev`); the
    // second forces installed (sets DKG_HOME to `<tmpHome>/.dkg`).
    // Without the try/finally, the second call would observe the
    // first's leftover override at the top of its body when it
    // calls `resolveDkgConfigHome()` — which prefers DKG_HOME over
    // any other signal — and silently inherit the wrong home.
    //
    // Post-fix: each call's env mutation is bounded to its own
    // body, so the second call observes the original (unset)
    // DKG_HOME at entry and gets to make the correct context-aware
    // resolution.
    delete process.env.DKG_HOME;

    const fakeRepoRoot = makeFakeMonorepoRoot();
    const observedHomesAtWriteCall: string[] = [];

    const writeDkgConfigSpy = vi.fn((agentName: string, _network: any, apiPort: number) => {
      observedHomesAtWriteCall.push(process.env.DKG_HOME ?? '<unset>');
      const dir = process.env.DKG_HOME ?? join(tmpHome, '.dkg');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ name: agentName, apiPort, nodeRole: 'edge' }, null, 2),
      );
    });

    // Call 1: force monorepo. `findDkgMonorepoRoot` stub returns
    // the fake repo root; `resolveDkgConfigHome` returns dev dir.
    const depsMono = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
      writeDkgConfig: writeDkgConfigSpy,
    });
    await mcpSetupAction({ monorepo: true, fund: false, verify: false }, depsMono);
    // After call 1: DKG_HOME restored to unset.
    expect(process.env.DKG_HOME).toBeUndefined();

    // Call 2: force installed. Default `resolveDkgConfigHome` stub
    // returns `<tmpHome>/.dkg`.
    const depsInstalled = makeDeps({
      writeDkgConfig: writeDkgConfigSpy,
    });
    await mcpSetupAction({ installed: true, fund: false, verify: false }, depsInstalled);
    // After call 2: DKG_HOME restored to unset.
    expect(process.env.DKG_HOME).toBeUndefined();

    // The two writeDkgConfig invocations saw different homes —
    // dev for call 1, prod-default for call 2 — confirming no
    // bleed of call 1's override into call 2.
    expect(observedHomesAtWriteCall).toEqual([
      join(tmpHome, '.dkg-dev'),
      join(tmpHome, '.dkg'),
    ]);
  });
});
