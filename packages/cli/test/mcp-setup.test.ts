import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
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
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'mcp-setup-test-'));
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    // node:os homedir() reads USERPROFILE on win32, HOME elsewhere; set both.
    process.env.USERPROFILE = tmpHome;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalUserprofile !== undefined) process.env.USERPROFILE = originalUserprofile;
    else delete process.env.USERPROFILE;
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
    return {
      loadNetworkConfig,
      writeDkgConfig,
      startDaemon,
      readWalletsWithRetry,
      requestFaucetFunding,
      logManualFundingInstructions,
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

  it('honours --no-start: skips daemon start AND faucet (faucet depends on running daemon)', async () => {
    mkdirSync(join(tmpHome, '.cursor'), { recursive: true });
    const deps = makeDeps();

    await mcpSetupAction({ start: false, verify: false }, deps);

    expect(deps.startDaemon).not.toHaveBeenCalled();
    expect(deps.requestFaucetFunding).not.toHaveBeenCalled();
    // But registration still proceeds.
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(true);
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

    await mcpSetupAction({ verify: false }, deps);

    expect(deps.logManualFundingInstructions).toHaveBeenCalledTimes(1);
    // Registration still proceeds.
    expect(existsSync(join(tmpHome, '.cursor', 'mcp.json'))).toBe(true);
  });
});
