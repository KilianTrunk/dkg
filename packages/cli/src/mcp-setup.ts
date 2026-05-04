/**
 * `dkg mcp setup` — register the DKG MCP server with one or more
 * MCP-aware coding clients (Cursor, Claude Code).
 *
 * Mirrors `dkg openclaw setup` in posture: non-interactive-when-possible,
 * idempotent, safe to re-run. Per the user's refinement (2026-04-30):
 *   - Skip `dkg init` re-prompting entirely if `~/.dkg/config.yaml` (or
 *     `~/.dkg/config.json`) already exists. Existing settings are not
 *     touched.
 *   - For each detected MCP-aware client, classify state as `registered`
 *     (entry present, matches expected shape), `stale` (entry present but
 *     differs), or `not registered`. Emit a single per-client summary line
 *     and a prompt-or-action line. With `--yes`, default to register-new
 *     and leave already-matching alone.
 *   - Fast-exit on no-op re-runs: nothing to write → print "nothing to
 *     do" and return without touching any config file.
 *   - `--force` refreshes every detected client regardless of state (used
 *     when the entry shape changes between releases).
 *   - `--print-only` emits the canonical JSON to stdout, skips client
 *     detection, never writes.
 *
 * Tokens and URLs are intentionally NOT in the emitted JSON. The MCP
 * server reads `~/.dkg/config.yaml` + the daemon-written `auth.token`
 * via `loadConfig` (`packages/mcp-dkg/src/config.ts`). The setup verb
 * therefore needs no token handling.
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
 * wiring already uses across the rest of the codebase
 * (`packages/mcp-dkg/README.md:96`).
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
    // Surface the candidate even when only the parent directory exists —
    // the user has the client installed but hasn't configured any MCP yet.
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
  // Pretty-printed, trailing newline. Matches the conventions used by
  // `mergeJson` in `packages/mcp-dkg/src/manifest/install.ts`.
  const dir = dirname(target.configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(target.configPath, JSON.stringify(body, null, 2) + '\n');
}

/**
 * Main entrypoint invoked by the `dkg mcp setup` commander handler in
 * `cli.ts`. Idempotent — re-running on an already-registered tree prints
 * the no-op message and returns without touching any file.
 */
export async function mcpSetupAction(opts: McpSetupCliOptions): Promise<void> {
  const force = opts.force === true;
  const printOnly = opts.printOnly === true;

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

  // Step 1: respect existing node config. Per the user's refinement, we
  // do NOT re-prompt for node settings if `~/.dkg/config.yaml` (or its
  // older JSON sibling) already exists.
  const dkgDir = join(homedir(), '.dkg');
  const yamlPath = join(dkgDir, 'config.yaml');
  const jsonPath = join(dkgDir, 'config.json');
  if (existsSync(yamlPath) || existsSync(jsonPath)) {
    console.log(`Node config exists (${tildify(existsSync(yamlPath) ? yamlPath : jsonPath)}); leaving untouched.`);
  } else {
    console.log('No ~/.dkg/config.yaml found.');
    console.log('  Run `dkg init` first to create the daemon config.');
    console.log('  (This setup only registers the MCP server with your coding client.)');
  }

  // Step 2: client detection.
  const clients = detectClients();
  if (clients.length === 0) {
    console.log('\nNo MCP-aware clients detected.');
    console.log('  Print the canonical JSON for manual paste:');
    console.log('    dkg mcp setup --print-only');
    return;
  }

  // Step 3: classify every detected client.
  const states = clients.map(classify);

  // Step 4: decide actions.
  type Action = 'register' | 'refresh' | 'skip';
  const planned: Array<{ s: ClientState; action: Action }> = states.map((s) => {
    if (force) return { s, action: 'refresh' };
    if (s.state === 'not-registered') return { s, action: 'register' };
    if (s.state === 'stale') return { s, action: 'refresh' };
    return { s, action: 'skip' };
  });

  const writes = planned.filter((p) => p.action !== 'skip');

  console.log('');
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

  // Step 5: fast-exit when nothing to do.
  if (writes.length === 0) {
    console.log('\nNothing to do. Re-run with --force to refresh all detected clients.');
    return;
  }

  // Step 6: write.
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

  // Step 7: post-setup hint.
  console.log('');
  console.log('Next steps:');
  console.log('  1. Restart your MCP-aware client (Cursor / Claude Code) so it picks up the new server.');
  console.log('  2. If the daemon is not running yet, start it in a separate terminal:');
  console.log('       dkg start');
  console.log('  3. From inside the client, ask "what tools does dkg expose?" — you should see');
  console.log('     dkg_assertion_create, dkg_assertion_write, dkg_assertion_query, and friends.');
  console.log('');
}

// Note: `expandHome` retained as a small reusable helper. Currently unused
// here but exported for symmetry with `tildify` in case future client
// detection adds env-var-based config-path overrides.
export { expandHome };
