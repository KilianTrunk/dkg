/**
 * `dkg mcp setup` — bundled init + daemon-start + MCP-client registration.
 *
 * Mirrors `dkg openclaw setup` so the user-visible flow is two commands
 * end-to-end:
 *
 *   npm install -g @origintrail-official/dkg
 *   dkg mcp setup
 *
 * Step order (each step is idempotent and skippable):
 *   1. Init `~/.dkg/config.json` if absent (uses the same network defaults
 *      + merge semantics as `dkg openclaw setup` — `loadNetworkConfig` +
 *      `writeDkgConfig` are re-exported from `@origintrail-official/dkg-adapter-openclaw`
 *      so behaviour stays byte-aligned).
 *   2. Start the daemon if not already reachable on the configured API
 *      port (uses the same `startDaemon` openclaw-setup uses — readiness
 *      probe, stale-PID handling, etc.).
 *   3. Optionally fund the node's wallets via testnet faucet (mirrors
 *      openclaw-setup's --no-fund posture).
 *   4. Detect MCP-aware clients and register the canonical
 *      `{ command: "dkg", args: ["mcp", "serve"] }` block. State-aware
 *      (`registered`/`stale`/`not registered`) and fast-exits on no-op
 *      re-runs.
 *
 * Flags (parity with `dkg openclaw setup` where applicable):
 *   --port <n>     Override daemon API port (default 9200).
 *   --name <s>     Override agent name (used only on first init).
 *   --no-start     Skip daemon start (configure only).
 *   --no-fund      Skip wallet funding via testnet faucet.
 *   --no-verify    Skip post-setup verification probe.
 *   --dry-run      Preview steps; no filesystem or network writes.
 *   --force        Refresh every detected client regardless of state.
 *   --print-only   Emit canonical JSON only; skip every other step.
 *   --yes          Auto-confirm (default; reserved for future prompts).
 *
 * Tokens and URLs are NOT in the emitted client-config block — the MCP
 * server reads them from `~/.dkg/config.yaml` + the daemon-written
 * `auth.token` via `loadConfig` (`packages/mcp-dkg/src/config.ts`).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface McpSetupCliOptions {
  /** Refresh every detected client regardless of current registration state. */
  force?: boolean;
  /** Emit the canonical JSON block to stdout; do not detect clients or write. */
  printOnly?: boolean;
  /** Auto-confirm registrations (default true; reserved for future interactive prompts). */
  yes?: boolean;
  /** Override daemon API port (default 9200). Mirrors openclaw-setup. */
  port?: string;
  /** Override agent name (used only on first init). Mirrors openclaw-setup. */
  name?: string;
  /** Skip daemon start (configure only). Mirrors openclaw-setup. */
  start?: boolean;
  /** Skip wallet funding via testnet faucet. Mirrors openclaw-setup. */
  fund?: boolean;
  /** Skip post-setup verification probe. Mirrors openclaw-setup. */
  verify?: boolean;
  /** Preview without writing or starting anything. Mirrors openclaw-setup. */
  dryRun?: boolean;
}

/**
 * Dependency surface for `mcpSetupAction`. All bundled-flow primitives
 * are injected so the action can be unit-tested without touching the
 * real filesystem or spawning the daemon. The CLI wiring in `cli.ts`
 * dynamically imports `@origintrail-official/dkg-adapter-openclaw` and
 * passes its real implementations.
 */
export interface McpSetupActionDeps {
  loadNetworkConfig: typeof import('@origintrail-official/dkg-adapter-openclaw').loadNetworkConfig;
  writeDkgConfig: typeof import('@origintrail-official/dkg-adapter-openclaw').writeDkgConfig;
  startDaemon: typeof import('@origintrail-official/dkg-adapter-openclaw').startDaemon;
  readWalletsWithRetry: typeof import('@origintrail-official/dkg-adapter-openclaw').readWalletsWithRetry;
  logManualFundingInstructions: typeof import('@origintrail-official/dkg-adapter-openclaw').logManualFundingInstructions;
  /** Faucet primitive from `@origintrail-official/dkg-core`. */
  requestFaucetFunding: typeof import('@origintrail-official/dkg-core').requestFaucetFunding;
}

/**
 * The canonical MCP-server entry written into client config files. Single
 * source of truth — every detected client gets the same block under
 * `mcpServers.dkg`.
 */
function canonicalEntry(): Record<string, unknown> {
  return {
    command: 'dkg',
    args: ['mcp', 'serve'],
  };
}

interface ClientTarget {
  name: string;
  configPath: string;
  /** Pretty path for display, with `~` substituted back in. */
  displayPath: string;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/**
 * Discover MCP-aware clients on the machine. We look at the standard
 * config-file locations rather than probing for installed binaries — a
 * config file is the artifact `dkg mcp setup` actually writes into, and
 * its existence (or non-existence) is the signal that matters.
 *
 * Cursor reads `~/.cursor/mcp.json`. Claude Code reads `~/.claude.json`
 * (and on some platforms `~/.claude/mcp_servers.json`); we target
 * `~/.claude.json` because that's the user-scoped path the MCP-server
 * wiring already uses across the rest of the codebase.
 *
 * Detection is deliberately permissive: any client whose config file is
 * already present OR whose config directory is already present counts as
 * "detected" for write purposes. Operators with a fresh machine and no
 * client installed still see the fallback "no clients detected; run
 * `dkg mcp setup --print-only`" message.
 */
function detectClients(): ClientTarget[] {
  const home = homedir();
  const candidates: ClientTarget[] = [
    {
      name: 'Cursor',
      configPath: join(home, '.cursor', 'mcp.json'),
      displayPath: '~/.cursor/mcp.json',
    },
    {
      name: 'Claude Code',
      configPath: join(home, '.claude.json'),
      displayPath: '~/.claude.json',
    },
  ];
  return candidates.filter((c) => {
    if (existsSync(c.configPath)) return true;
    if (existsSync(dirname(c.configPath))) return true;
    return false;
  });
}

type RegistrationState = 'registered' | 'stale' | 'not-registered';

interface ClientState {
  target: ClientTarget;
  state: RegistrationState;
  current: unknown;
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error(
      `Existing file is not valid JSON: ${tildify(path)}. Move it aside and re-run.`,
    );
  }
}

function classify(target: ClientTarget): ClientState {
  const expected = canonicalEntry();
  const body = readJson(target.configPath);
  const servers = (body.mcpServers as Record<string, unknown> | undefined) ?? {};
  const current = servers.dkg as Record<string, unknown> | undefined;
  if (current === undefined) {
    return { target, state: 'not-registered', current: null };
  }
  const matches =
    typeof current === 'object' &&
    current !== null &&
    (current as Record<string, unknown>).command === expected.command &&
    Array.isArray((current as Record<string, unknown>).args) &&
    JSON.stringify((current as Record<string, unknown>).args) ===
      JSON.stringify(expected.args);
  return {
    target,
    state: matches ? 'registered' : 'stale',
    current: current ?? null,
  };
}

function writeRegistration(target: ClientTarget): void {
  const body = readJson(target.configPath);
  const servers =
    (body.mcpServers as Record<string, unknown> | undefined) ?? {};
  servers.dkg = canonicalEntry();
  body.mcpServers = servers;
  const dir = dirname(target.configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(target.configPath, JSON.stringify(body, null, 2) + '\n');
}

/**
 * Fallback agent-name minter for first-init when no `--name` is passed
 * and no persisted config exists. Mirrors `discoverAgentName`'s
 * unique-fallback shape (`openclaw-agent-XXXXX`) but with `mcp-` prefix
 * so support traffic can tell which setup verb produced the identity.
 * Re-runs hit the persisted name instead because `writeDkgConfig`
 * preserves an existing `name` field.
 */
function mintFallbackAgentName(): string {
  const id = Math.random().toString(36).slice(2, 7);
  return `mcp-agent-${id}`;
}

/**
 * Read the persisted agent name from `~/.dkg/config.json`. Returns
 * `undefined` for missing/corrupt files. Used so a second `dkg mcp
 * setup` run on a config whose `name` was set by a prior init doesn't
 * regenerate a fresh random fallback.
 */
function readPersistedAgentName(dkgDirPath: string): string | undefined {
  const configPath = join(dkgDirPath, 'config.json');
  if (!existsSync(configPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw?.name === 'string' && raw.name.trim()) {
      return raw.name.trim();
    }
  } catch { /* corrupt config; let writeDkgConfig handle */ }
  return undefined;
}

/**
 * Main entrypoint invoked by the `dkg mcp setup` commander handler in
 * `cli.ts`. Idempotent — re-running on a fully-set-up tree prints
 * step-by-step skip notices and exits cleanly without touching any
 * file or restarting the daemon.
 */
export async function mcpSetupAction(
  opts: McpSetupCliOptions,
  deps: McpSetupActionDeps,
): Promise<void> {
  const force = opts.force === true;
  const printOnly = opts.printOnly === true;
  const dryRun = opts.dryRun === true;
  const shouldStart = opts.start !== false;
  const shouldFund = opts.fund !== false;
  const shouldVerify = opts.verify !== false;
  const apiPort = Number(opts.port ?? '9200');
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error(`Invalid port "${opts.port}" — must be an integer between 1 and 65535`);
  }

  if (printOnly) {
    const block = {
      mcpServers: {
        dkg: canonicalEntry(),
      },
    };
    process.stdout.write(JSON.stringify(block, null, 2) + '\n');
    return;
  }

  console.log('\nDKG MCP setup');
  console.log('='.repeat(40));
  if (dryRun) {
    console.log('[setup] DRY RUN — no files will be modified, no daemon will start\n');
  }

  // ── Step 1: ensure ~/.dkg/config.json ─────────────────────────────
  // Mirrors `dkg openclaw setup` step 3 byte-for-byte. If the file
  // already exists, `writeDkgConfig` merges (first-wins on `name` /
  // `apiPort` unless explicit overrides are passed).
  const dkgDirPath = join(homedir(), '.dkg');
  const yamlPath = join(dkgDirPath, 'config.yaml');
  const jsonPath = join(dkgDirPath, 'config.json');
  const configExists = existsSync(yamlPath) || existsSync(jsonPath);

  let effectivePort = apiPort;
  let effectiveAgentName = opts.name?.trim() || readPersistedAgentName(dkgDirPath) || mintFallbackAgentName();

  if (configExists && opts.name == null && opts.port == null) {
    console.log(`[setup] Node config exists (${tildify(existsSync(yamlPath) ? yamlPath : jsonPath)}); leaving untouched.`);
  } else if (dryRun) {
    console.log(`[setup] [dry-run] Would write ~/.dkg/config.json (port ${apiPort}, name "${effectiveAgentName}")`);
  } else {
    try {
      const network = deps.loadNetworkConfig();
      deps.writeDkgConfig(effectiveAgentName, network, apiPort, {
        nameExplicit: opts.name != null,
        portExplicit: opts.port != null,
      });
      // Read back the effective port + name from the merged config so
      // downstream steps use the persisted values when an existing
      // config preserved a different port/name.
      try {
        const merged = JSON.parse(readFileSync(jsonPath, 'utf-8'));
        const mergedPort = Number(merged.apiPort);
        if (Number.isInteger(mergedPort) && mergedPort >= 1 && mergedPort <= 65535) {
          effectivePort = mergedPort;
        }
        if (typeof merged.name === 'string' && merged.name.trim()) {
          effectiveAgentName = merged.name.trim();
        }
      } catch { /* use pre-merge values */ }
    } catch (err: any) {
      console.error(`[setup] Failed to load network config: ${err?.message ?? err}`);
      throw err;
    }
  }

  // ── Step 2: start the daemon ──────────────────────────────────────
  // `startDaemon` is no-op when a healthy daemon is already reachable
  // on `effectivePort`; otherwise it spawns one and polls for
  // readiness up to 30s. Same primitive openclaw-setup uses — see
  // `packages/adapter-openclaw/src/setup.ts:606+`.
  if (shouldStart && !dryRun) {
    await deps.startDaemon(effectivePort);
  } else if (shouldStart && dryRun) {
    console.log('[setup] [dry-run] Would start DKG daemon');
  } else {
    console.log('[setup] Skipping daemon start (--no-start)');
  }

  // ── Step 3: optional faucet ───────────────────────────────────────
  // Reads wallets from `~/.dkg/wallets.json` (written async by the
  // daemon) with the same 5×1s retry openclaw-setup uses. Faucet
  // failures log a manual `curl` block and continue — funding is
  // non-fatal for setup.
  if (shouldFund && !dryRun && shouldStart) {
    try {
      const network = deps.loadNetworkConfig();
      const faucetUrl = network.faucet?.url;
      const faucetMode = network.faucet?.mode ?? 'testnet';
      if (!faucetUrl) {
        console.log('[setup] No faucet URL configured for this network; skipping wallet funding.');
      } else {
        const wallets = await deps.readWalletsWithRetry();
        if (wallets.length === 0) {
          console.log('[setup] No wallets to fund yet (daemon may not have flushed wallets.json).');
        } else {
          try {
            const result = await deps.requestFaucetFunding(faucetUrl, faucetMode, wallets, effectiveAgentName);
            if (result?.success === false) {
              console.warn('[setup] Faucet returned failure; emitting manual instructions.');
              deps.logManualFundingInstructions(wallets, faucetUrl, faucetMode);
            } else {
              console.log(`[setup] Funded ${wallets.length} wallet(s) via testnet faucet.`);
            }
          } catch (err: any) {
            console.warn(`[setup] Faucet call failed (${err?.message ?? err}); emitting manual instructions.`);
            deps.logManualFundingInstructions(wallets, faucetUrl, faucetMode);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[setup] Faucet step skipped: ${err?.message ?? err}`);
    }
  } else if (!shouldFund) {
    console.log('[setup] Skipping wallet funding (--no-fund)');
  }

  // ── Step 4: client detection + classification ─────────────────────
  console.log('');
  const clients = detectClients();
  if (clients.length === 0) {
    console.log('No MCP-aware clients detected.');
    console.log('  Print the canonical JSON for manual paste:');
    console.log('    dkg mcp setup --print-only');
    return;
  }

  const states = clients.map(classify);
  type Action = 'register' | 'refresh' | 'skip';
  const planned: Array<{ s: ClientState; action: Action }> = states.map((s) => {
    if (force) return { s, action: 'refresh' };
    if (s.state === 'not-registered') return { s, action: 'register' };
    if (s.state === 'stale') return { s, action: 'refresh' };
    return { s, action: 'skip' };
  });

  for (const { s, action } of planned) {
    const stateLabel =
      s.state === 'registered'
        ? 'registered'
        : s.state === 'stale'
          ? 'stale'
          : 'not registered';
    const actionLabel =
      action === 'register'
        ? 'will register'
        : action === 'refresh'
          ? 'will refresh'
          : 'leaving alone';
    console.log(`  ${s.target.name.padEnd(13)} (${s.target.displayPath}) — ${stateLabel}; ${actionLabel}`);
  }

  const writes = planned.filter((p) => p.action !== 'skip');
  if (writes.length === 0) {
    console.log('\nClients all up-to-date; nothing to write. Re-run with --force to refresh anyway.');
  } else if (dryRun) {
    console.log('\n[setup] [dry-run] Would write to the clients listed above.');
  } else {
    console.log('');
    for (const { s, action } of writes) {
      try {
        writeRegistration(s.target);
        console.log(`  ${action === 'register' ? 'Registered' : 'Refreshed'} ${s.target.name} → ${s.target.displayPath}`);
      } catch (err: any) {
        console.error(`  Failed to write ${s.target.displayPath}: ${err?.message ?? err}`);
        throw err;
      }
    }
  }

  // ── Step 5: optional verification ─────────────────────────────────
  // Probe the daemon's `/api/status` to confirm it's healthy on the
  // effective port. Cheap reachability check; if the daemon is up but
  // misconfigured (auth, etc.) the probe still passes — deeper checks
  // are out of scope for setup.
  if (shouldVerify && !dryRun && shouldStart) {
    try {
      const res = await fetch(`http://127.0.0.1:${effectivePort}/api/status`);
      if (res.ok) {
        console.log(`\n[setup] Daemon healthy at http://127.0.0.1:${effectivePort}.`);
      } else {
        console.warn(`\n[setup] Daemon responded with HTTP ${res.status} at http://127.0.0.1:${effectivePort}.`);
      }
    } catch (err: any) {
      console.warn(`\n[setup] Verification probe failed: ${err?.message ?? err}`);
    }
  }

  // ── Final hint ────────────────────────────────────────────────────
  console.log('');
  console.log('Next steps:');
  console.log('  1. Restart your MCP-aware client (Cursor / Claude Code) so it picks up the new server.');
  console.log('  2. From inside the client, ask "what tools does dkg expose?" — you should see');
  console.log('     dkg_assertion_create, dkg_assertion_write, dkg_assertion_query, and friends.');
  console.log('');
}

export { expandHome };
