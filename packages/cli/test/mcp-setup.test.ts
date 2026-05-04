import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir, platform } from 'node:os';
import { join } from 'node:path';
import { mcpSetupAction, type McpSetupActionDeps } from '../src/mcp-setup.js';

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
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mcp-setup-test-'));
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    originalAppdata = process.env.APPDATA;
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
      const dkgDir = join(tmpHome, '.dkg');
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
    return {
      loadNetworkConfig,
      writeDkgConfig,
      startDaemon,
      readWalletsWithRetry,
      requestFaucetFunding,
      logManualFundingInstructions,
      findDkgMonorepoRoot,
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
    expect(cursorConfig.mcpServers.dkg).toEqual({
      command: 'dkg',
      args: ['mcp', 'serve'],
    });
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
    // Asserted JSON shape on stdout.
    const allWrites = (stdoutSpy.mock.calls as any[]).map((c) => c[0]).join('');
    const parsed = JSON.parse(allWrites);
    expect(parsed.mcpServers.dkg).toEqual({ command: 'dkg', args: ['mcp', 'serve'] });
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

  // Helper: extract the JSON object emitted by --print-only. Vitest's
  // own progress reporter occasionally interleaves a non-JSON write
  // ahead of production stdout, so we slice from the first `{` to
  // the matching last `}`. The production code emits exactly one
  // JSON object via `process.stdout.write`, so first-`{` to last-`}`
  // is a tight bracket.
  const parseStdoutJson = (
    spy: ReturnType<typeof vi.spyOn>,
  ): Record<string, any> => {
    const all = (spy.mock.calls as any[]).map((c) => String(c[0])).join('');
    const start = all.indexOf('{');
    const end = all.lastIndexOf('}');
    if (start < 0 || end < 0 || end <= start) {
      throw new Error(`No JSON object in stdout: ${JSON.stringify(all)}`);
    }
    return JSON.parse(all.slice(start, end + 1));
  };

  it('phase-2: --print-only with monorepo auto-detect emits the local-CLI-dist absolute-path form', async () => {
    const fakeRepoRoot = join('/fake', 'dkg-v9');
    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => fakeRepoRoot),
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true }, deps);

    const parsed = parseStdoutJson(stdoutSpy);
    // Monorepo form: command is `node`, args[0] is the absolute
    // path to the contributor's local CLI dist as produced by
    // path.join — platform-native separators.
    expect(parsed.mcpServers.dkg.command).toBe('node');
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
    expect(parsed.mcpServers.dkg).toEqual({ command: 'dkg', args: ['mcp', 'serve'] });
    stdoutSpy.mockRestore();
  });

  it('phase-2: --installed forces the standard form even from inside a monorepo', async () => {
    const deps = makeDeps({
      findDkgMonorepoRoot: vi.fn(() => join('/fake', 'dkg-v9')),
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await mcpSetupAction({ printOnly: true, installed: true }, deps);

    const parsed = parseStdoutJson(stdoutSpy);
    expect(parsed.mcpServers.dkg).toEqual({ command: 'dkg', args: ['mcp', 'serve'] });
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
    const fakeRepoRoot = join('/fake', 'dkg-v9');
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
    // platform-native paths from `path.join`.
    const after = JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf-8'));
    expect(after.mcpServers.dkg.command).toBe('node');
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
    expect(written.mcpServers.dkg).toEqual({
      command: 'dkg',
      args: ['mcp', 'serve'],
    });
  });

  it('phase-3: Windsurf is detected at ~/.codeium/windsurf/; gets canonical entry written', async () => {
    const windsurfPath = join(tmpHome, '.codeium', 'windsurf', 'mcp_config.json');
    mkdirSync(join(windsurfPath, '..'), { recursive: true });

    const deps = makeDeps();
    await mcpSetupAction({ start: false, fund: false, verify: false }, deps);

    expect(existsSync(windsurfPath)).toBe(true);
    const written = JSON.parse(readFileSync(windsurfPath, 'utf-8'));
    expect(written.mcpServers.dkg).toEqual({
      command: 'dkg',
      args: ['mcp', 'serve'],
    });
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
    expect(written.mcpServers.dkg).toEqual({ command: 'dkg', args: ['mcp', 'serve'] });
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
    expect(written.servers?.dkg).toEqual({ command: 'dkg', args: ['mcp', 'serve'] });
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
    expect(written.servers.dkg).toEqual({ command: 'dkg', args: ['mcp', 'serve'] });
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
    expect(written.mcpServers.dkg).toEqual({ command: 'dkg', args: ['mcp', 'serve'] });
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
    expect(written.mcpServers.dkg).toEqual({ command: 'dkg', args: ['mcp', 'serve'] });
  });

  it('phase-4: VSCode staleness — pre-existing dkg entry under `servers.dkg` reclassifies on context flip to monorepo', async () => {
    // Cross-shape staleness: a Cursor-shaped entry written into
    // VSCode's `servers.dkg` wouldn't classify as `registered` if
    // the canonical entry's command/args differ. Here we pin the
    // installed→monorepo flip works for VSCode the same as for
    // Cursor (phase-2 covered the Cursor case).
    const fakeRepoRoot = join('/fake', 'dkg-v9');
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
    expect(written.servers.dkg.command).toBe('node');
    expect(written.servers.dkg.args[0]).toBe(
      join(fakeRepoRoot, 'packages', 'cli', 'dist', 'cli.js'),
    );

    fetchSpy.mockRestore();
  });
});
