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
  /**
   * Force installed-mode command form even when invoked from inside
   * a monorepo dev checkout. Escape hatch for contributors who want
   * to test the published-CLI shape from a dev cwd. Mutually
   * exclusive with `--monorepo`.
   */
  installed?: boolean;
  /**
   * Force monorepo-mode command form (writes the absolute path to
   * the local CLI dist). Errors if no monorepo root can be located.
   * Mutually exclusive with `--installed`.
   */
  monorepo?: boolean;
}

/**
 * Setup context — drives `canonicalEntry`'s output shape. `'installed'`
 * is the default for npm-installed CLIs (writes
 * `{ command: "dkg", args: ["mcp", "serve"] }`); `'monorepo'` is the
 * contributor-from-dev-checkout case (writes
 * `{ command: "node", args: ["<repo>/packages/cli/dist/cli.js",
 * "mcp", "serve"] }` so the contributor's local-build runs, not a
 * stale globally-installed version).
 */
export type SetupContext = 'installed' | 'monorepo';

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
  /**
   * Walks ancestors looking for a DKG monorepo root. Defaulted to the
   * dkg-core implementation in production; injectable so tests can
   * stub it without touching the real filesystem.
   */
  findDkgMonorepoRoot: typeof import('@origintrail-official/dkg-core').findDkgMonorepoRoot;
}

/**
 * The canonical MCP-server entry written into client config files.
 * Context-aware: `'installed'` uses the global `dkg` bin (the npm-
 * installed shape); `'monorepo'` uses an absolute path to the local
 * CLI dist so a contributor's dev build runs even when a stale
 * `dkg` from a prior global install is still on PATH.
 */
function canonicalEntry(
  context: SetupContext,
  monorepoRoot: string | null,
): Record<string, unknown> {
  if (context === 'monorepo' && monorepoRoot) {
    return {
      command: 'node',
      args: [join(monorepoRoot, 'packages', 'cli', 'dist', 'cli.js'), 'mcp', 'serve'],
    };
  }
  return { command: 'dkg', args: ['mcp', 'serve'] };
}

/**
 * Detect the setup context. With `force` set to a literal value, that
 * value wins (with `--monorepo` requiring a discoverable monorepo
 * root). Without `force`, walk ancestors of the CLI's compiled
 * location: a hit means we're invoked from a monorepo dev checkout,
 * so write the local-cli-dist absolute path; a miss means we're
 * globally installed and the standard `dkg` shape is correct.
 *
 * `--installed` and `--monorepo` are mutually exclusive — the caller
 * is expected to have validated that before calling. We accept the
 * narrow union here so the action can pass through whichever flag
 * commander produced without re-validating.
 */
function detectContext(
  findRoot: typeof import('@origintrail-official/dkg-core').findDkgMonorepoRoot,
  opts: { force?: SetupContext } = {},
): { context: SetupContext; monorepoRoot: string | null } {
  if (opts.force === 'installed') {
    return { context: 'installed', monorepoRoot: null };
  }
  if (opts.force === 'monorepo') {
    const root = findRoot();
    if (!root) {
      throw new Error(
        '--monorepo flag passed but no DKG monorepo root could be located from this CLI invocation.',
      );
    }
    return { context: 'monorepo', monorepoRoot: root };
  }
  const root = findRoot();
  return root
    ? { context: 'monorepo', monorepoRoot: root }
    : { context: 'installed', monorepoRoot: null };
}

interface ClientTarget {
  name: string;
  configPath: string;
  /** Pretty path for display, with `~` substituted back in. */
  displayPath: string;
  /**
   * Per-client config-file format. Defaults to `'json'` so the existing
   * Cursor + Claude Code targets stay byte-identical post-refactor.
   * Future clients with non-JSON config (Codex CLI = TOML, Continue
   * may be YAML) declare the format here so `writeRegistration` and
   * `classify` dispatch to the right serializer.
   */
  format?: 'json' | 'toml' | 'yaml';
  /**
   * Dotted path to the per-server entry inside the parsed config.
   * Defaults to `'mcpServers.dkg'` — the shape Cursor / Claude Code /
   * Claude Desktop / Windsurf / Cline all use. Clients diverging from
   * that shape (VSCode + Copilot Chat uses `servers.dkg`; Codex CLI
   * uses `mcp_servers.dkg` under TOML) declare the alternate path
   * here so a single registration helper covers all surfaces without
   * per-client write functions.
   */
  entryPath?: string;
}

const DEFAULT_FORMAT: NonNullable<ClientTarget['format']> = 'json';
const DEFAULT_ENTRY_PATH = 'mcpServers.dkg';

/**
 * Resolve a dotted entry-path (`'mcpServers.dkg'`, `'servers.dkg'`,
 * `'mcp_servers.dkg'`) into its head segments + final key. Used by
 * both classify (read) and writeRegistration (write) to navigate the
 * parsed config object identically.
 */
function splitEntryPath(entryPath: string | undefined): { head: string[]; leaf: string } {
  const path = entryPath ?? DEFAULT_ENTRY_PATH;
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Invalid entryPath "${entryPath}": must be a non-empty dotted path`);
  }
  return { head: parts.slice(0, -1), leaf: parts[parts.length - 1] };
}

/**
 * Walk a parsed config object down a list of head segments, lazily
 * creating intermediate `Record<string, unknown>` containers for any
 * missing levels. Returns the parent container of the leaf key.
 *
 * Used at write time only. At read time we tolerate missing
 * intermediates (the entry just classifies as `not-registered`).
 */
function ensurePathContainer(
  body: Record<string, unknown>,
  head: string[],
): Record<string, unknown> {
  let cursor: Record<string, unknown> = body;
  for (const segment of head) {
    const next = cursor[segment];
    if (next === undefined || next === null || typeof next !== 'object') {
      const fresh: Record<string, unknown> = {};
      cursor[segment] = fresh;
      cursor = fresh;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  return cursor;
}

/**
 * Read the leaf value at a dotted entry-path; returns `undefined` if
 * any intermediate is missing or non-object. Used by `classify` so
 * staleness detection works regardless of how deep the entry is
 * nested.
 */
function readEntryAt(
  body: Record<string, unknown>,
  entryPath: string | undefined,
): unknown {
  const { head, leaf } = splitEntryPath(entryPath);
  let cursor: unknown = body;
  for (const segment of head) {
    if (cursor === undefined || cursor === null || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor === undefined || cursor === null || typeof cursor !== 'object') {
    return undefined;
  }
  return (cursor as Record<string, unknown>)[leaf];
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

/**
 * Read the parsed body of a per-client config, dispatching on
 * `target.format`. JSON is the default + only format wired today;
 * TOML / YAML branches throw `NotImplementedError`-style errors so
 * targets that declare them but ship pre-phase-5 trip cleanly at
 * registration time rather than silently writing garbage. Phase 5
 * (Codex CLI) wires the TOML branch; Continue (phase 4) wires YAML
 * if Continue's config-file detection lands on `.yaml`.
 */
function readConfigBody(target: ClientTarget): Record<string, unknown> {
  const format = target.format ?? DEFAULT_FORMAT;
  switch (format) {
    case 'json':
      return readJson(target.configPath);
    case 'toml':
      throw new Error(
        `TOML config format not yet implemented (target: ${target.name}). Land phase 5 first.`,
      );
    case 'yaml':
      throw new Error(
        `YAML config format not yet implemented (target: ${target.name}). Land phase 4 first.`,
      );
    default:
      throw new Error(`Unknown client config format: ${String(format)}`);
  }
}

/**
 * Serialize a parsed body to disk, dispatching on `target.format`.
 * Mirrors `readConfigBody`'s dispatch shape so phase 4/5 wiring is a
 * symmetric extension. JSON output keeps the pre-refactor formatting
 * (2-space indent, trailing newline) byte-for-byte.
 */
function writeConfigBody(target: ClientTarget, body: Record<string, unknown>): void {
  const format = target.format ?? DEFAULT_FORMAT;
  const dir = dirname(target.configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  switch (format) {
    case 'json':
      writeFileSync(target.configPath, JSON.stringify(body, null, 2) + '\n');
      return;
    case 'toml':
      throw new Error(
        `TOML config format not yet implemented (target: ${target.name}). Land phase 5 first.`,
      );
    case 'yaml':
      throw new Error(
        `YAML config format not yet implemented (target: ${target.name}). Land phase 4 first.`,
      );
    default:
      throw new Error(`Unknown client config format: ${String(format)}`);
  }
}

function classify(
  target: ClientTarget,
  expected: Record<string, unknown>,
): ClientState {
  const body = readConfigBody(target);
  const current = readEntryAt(body, target.entryPath) as
    | Record<string, unknown>
    | null
    | undefined;
  // Treat both `undefined` (key absent) and `null` (key present but
  // explicitly nulled) as "not-registered". Pre-F7 a `{ dkg: null }`
  // entry classified as `stale`, which made the operator-facing
  // log line claim there was a current value to refresh — there
  // wasn't. Same registration outcome under `--force`; clearer log.
  if (current === undefined || current === null) {
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

function writeRegistration(
  target: ClientTarget,
  entry: Record<string, unknown>,
): void {
  const body = readConfigBody(target);
  const { head, leaf } = splitEntryPath(target.entryPath);
  const container = ensurePathContainer(body, head);
  container[leaf] = entry;
  writeConfigBody(target, body);
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

  // Phase-2: detect setup context (installed vs monorepo dev). Drives
  // `canonicalEntry`'s output shape so a contributor's local CLI dist
  // is the one Cursor / Claude Code etc. invoke, not a stale globally-
  // installed version. `--installed` / `--monorepo` are mutually
  // exclusive overrides; flag them at the boundary so a misuse
  // surfaces with a clear error rather than silent precedence.
  if (opts.installed === true && opts.monorepo === true) {
    throw new Error(
      '--installed and --monorepo are mutually exclusive; pass at most one.',
    );
  }
  const forcedContext: SetupContext | undefined = opts.installed
    ? 'installed'
    : opts.monorepo
      ? 'monorepo'
      : undefined;
  const { context, monorepoRoot } = detectContext(deps.findDkgMonorepoRoot, {
    force: forcedContext,
  });
  const expectedEntry = canonicalEntry(context, monorepoRoot);

  if (printOnly) {
    const block = {
      mcpServers: {
        dkg: expectedEntry,
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

  /**
   * F6 fix: read-back must run on BOTH branches (skip-write AND
   * write-then-read), not just inside the `else`. The pre-F6 layout
   * only reconciled `effectivePort` after `writeDkgConfig` ran,
   * leaving the skip-write branch with the CLI default 9200 even when
   * the persisted config had a different port. Concrete reproducer:
   * a user previously ran `dkg openclaw setup --port 9300`; running
   * `dkg mcp setup` with no flags would start the daemon on 9200 and
   * the verification probe + registered MCP entry would point at the
   * wrong port.
   *
   * Pulling the read-back into a helper that runs unconditionally
   * after the (optional) write keeps the daemon-start, faucet, and
   * verify steps all aligned with the persisted config — which is
   * the source of truth for an existing install.
   */
  const reconcileFromPersistedConfig = (): void => {
    if (!existsSync(jsonPath)) return;
    try {
      const merged = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      const mergedPort = Number(merged.apiPort);
      if (Number.isInteger(mergedPort) && mergedPort >= 1 && mergedPort <= 65535) {
        effectivePort = mergedPort;
      }
      if (typeof merged.name === 'string' && merged.name.trim()) {
        effectiveAgentName = merged.name.trim();
      }
    } catch { /* corrupt config; downstream uses pre-merge values */ }
  };

  // F25: reconcile BEFORE the branch decision so dry-run preview
  // and skip-write log lines see the persisted-port value. Pre-F25
  // the dry-run branch printed the CLI-default `apiPort` (9200)
  // even when `~/.dkg/config.json` had `apiPort: 9300`. Lifting
  // the call here also collapses the two duplicate calls (one in
  // the skip-write branch, one in the write-then-read branch)
  // into a single up-front read.
  if (configExists) {
    reconcileFromPersistedConfig();
  }

  if (configExists && opts.name == null && opts.port == null) {
    console.log(`[setup] Node config exists (${tildify(existsSync(yamlPath) ? yamlPath : jsonPath)}); leaving untouched.`);
  } else if (dryRun) {
    console.log(`[setup] [dry-run] Would write ~/.dkg/config.json (port ${effectivePort}, name "${effectiveAgentName}")`);
  } else {
    try {
      const network = deps.loadNetworkConfig();
      deps.writeDkgConfig(effectiveAgentName, network, apiPort, {
        nameExplicit: opts.name != null,
        portExplicit: opts.port != null,
      });
      // Re-read after writeDkgConfig in case the daemon's config-
      // merge changed `apiPort` / `name` (first-wins semantics on
      // existing fields, explicit overrides on new).
      reconcileFromPersistedConfig();
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
  //
  // F14: the funding decision is decoupled from `shouldStart`. The
  // pre-fix outer guard `if (shouldFund && !dryRun && shouldStart)`
  // silently skipped funding whenever `--no-start` was supplied,
  // even when the daemon was already running from a prior invocation
  // and a re-run-to-retry-funding was the user's actual goal.
  // Post-fix flow:
  //   1. Honour `--no-fund` (explicit opt-out, unchanged).
  //   2. Honour `--dry-run` (no network calls).
  //   3. Probe daemon reachability at `/api/status` on
  //      `effectivePort`. If unreachable, log explicit
  //      "skipping wallet funding (daemon not reachable on port X)"
  //      with the reason — replaces the silent omission. If
  //      reachable, proceed with funding regardless of which
  //      invocation started the daemon.
  if (!shouldFund) {
    console.log('[setup] Skipping wallet funding (--no-fund)');
  } else if (dryRun) {
    console.log('[setup] [dry-run] Would attempt wallet funding');
  } else {
    let daemonReachable = false;
    try {
      // F26: bound the probe with AbortSignal.timeout(2000) so a
      // partially-up daemon (port bound but unresponsive — half-stuck
      // process or deadlocked startup) doesn't hang setup. The probe
      // is best-effort; treating timeout as "not reachable" is the
      // correct fallback because we move on to log the explicit
      // skip-with-reason message anyway.
      const probe = await fetch(`http://127.0.0.1:${effectivePort}/api/status`, {
        signal: AbortSignal.timeout(2000),
      });
      daemonReachable = probe.ok;
    } catch { /* not reachable (or timed out) */ }

    if (!daemonReachable) {
      console.log(
        `[setup] Skipping wallet funding (daemon not reachable on port ${effectivePort})`,
      );
    } else {
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
    }
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

  const states = clients.map((c) => classify(c, expectedEntry));
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
        writeRegistration(s.target, expectedEntry);
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
      // F26: same hang-bound as the funding-step reachability probe.
      // A partially-up daemon must not block setup completion.
      const res = await fetch(`http://127.0.0.1:${effectivePort}/api/status`, {
        signal: AbortSignal.timeout(2000),
      });
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
