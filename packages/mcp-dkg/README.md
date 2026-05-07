# `@origintrail-official/dkg-mcp`

[Model Context Protocol](https://modelcontextprotocol.io) server that exposes your local DKG V10 daemon to **Cursor**, **Claude Code**, **Claude Desktop**, **Windsurf**, **VSCode + GitHub Copilot Chat**, **Cline**, and any other MCP-aware coding assistant. It is the canonical V10 surface for "DKG as agent memory."

The package ships transitively as part of `@origintrail-official/dkg`. You don't run the bin directly — the umbrella CLI's `dkg mcp serve` invokes it on the client's behalf.

## Install

Two commands, same shape as `dkg openclaw setup`:

```bash
npm install -g @origintrail-official/dkg     # umbrella CLI bundles this MCP server
dkg mcp setup                                # one-shot: init + start + fund + register + verify
```

`dkg mcp setup` runs a bundled, idempotent flow. In order, it:

1. Initializes `~/.dkg/config.json` if absent (skipped silently when present)
2. Starts the DKG daemon as a background process (skipped if already running)
3. Funds the node's wallets via the testnet faucet (skip with `--no-fund`)
4. Detects each MCP-aware client by its config file and writes the canonical entry. **You confirm per detected client interactively** (`Register DKG MCP with <client>? [Y/n]`) unless `--yes` is passed; non-TTY invocations (CI, piped stdin) auto-confirm so scripts don't hang. The detection set is six clients: **Cursor** (`~/.cursor/mcp.json`), **Claude Code** (`~/.claude.json`), **Claude Desktop** (per-platform — `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/.config/Claude/claude_desktop_config.json` on Linux), **Windsurf** (`~/.codeium/windsurf/mcp_config.json`), **VSCode + GitHub Copilot Chat** (per-platform Code user-settings dir + `mcp.json` — note this client uses the `servers.dkg` shape, not `mcpServers.dkg`), and **Cline** (deep-nested under VSCode's per-extension globalStorage at `Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`). The five `mcpServers.dkg` clients receive the same JSON block
5. Verifies the daemon is healthy

Every step short-circuits when its work is already done, so re-running on a set-up box is safe. Step-skip flags: `--no-start`, `--no-fund`, `--no-verify`, `--dry-run` (preview only), `--force` (refresh every detected client config regardless of state), `--yes` (auto-confirm per-client registrations; default false — TTY mode prompts interactively, non-TTY auto-confirms; pass `--yes` in scripts for the safer scripted-environment posture). First-init overrides: `--port <n>`, `--name <s>`. The bundled flow re-uses the same primitives `dkg openclaw setup` does, so the two verbs stay byte-aligned on network defaults, daemon-readiness probes, faucet retry/back-off, and manual-curl fallback.

The canonical entry written into each client's config:

```json
{
  "mcpServers": {
    "dkg": {
      "command": "dkg",
      "args": ["mcp", "serve"]
    }
  }
}
```

No tokens or URLs in the JSON — those live in `~/.dkg/config.yaml` and the daemon-written `~/.dkg/auth.token`. If no client is detected, run `dkg mcp setup --print-only` to emit the JSON for manual paste.

After `dkg mcp setup` runs, restart your client so it discovers the MCP. Verify by asking the agent: *"What tools does dkg expose?"* The `tools/list` response must include `dkg_assertion_create`, `dkg_assertion_write`, and `dkg_memory_search`.

### Manual config (alternative)

For environments where `dkg mcp setup` can't run (CI, locked-down configs, custom paths), drop the same block in by hand:

- **Cursor** — `~/.cursor/mcp.json` (or workspace `.cursor/mcp.json`); `mcpServers.dkg`
- **Claude Code** — `~/.claude.json`, or run `claude mcp add dkg dkg mcp serve`; `mcpServers.dkg`
- **Claude Desktop** — per-platform path (see step 4 above); `mcpServers.dkg`
- **Windsurf (Codeium)** — `~/.codeium/windsurf/mcp_config.json`; `mcpServers.dkg`
- **VSCode + GitHub Copilot Chat** — per-platform Code user-settings dir + `mcp.json`; **`servers.dkg`** (Copilot Chat uses `servers`, not `mcpServers` — copy the inner block, not the outer wrapper)
- **Cline** — `Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` under your VSCode user dir; `mcpServers.dkg`
- **Continue / Codex CLI / generic MCP client** — Continue uses YAML and Codex CLI uses TOML; not auto-detected today (deferred to a follow-up). Run `dkg mcp setup --print-only` to emit the canonical JSON block, then translate into the client's native format

### Contributor (monorepo dev) workflow

If you run `dkg mcp setup` from inside a `dkg-v9` monorepo checkout, the CLI auto-detects the workspace via `findDkgMonorepoRoot()` and writes a different entry that points at your local build instead of the globally-installed `dkg`:

```json
{
  "mcpServers": {
    "dkg": {
      "command": "node",
      "args": ["/absolute/path/to/dkg-v9/packages/cli/dist/cli.js", "mcp", "serve"]
    }
  }
}
```

This lets the registered MCP run your in-progress changes the next time the client spawns it. **Required prereq: rebuild before re-running setup.**

```bash
pnpm --filter @origintrail-official/dkg build      # rebuild the CLI dist
dkg mcp setup                                      # re-register against the freshly-built dist
```

Skip the rebuild and the registered entry points at a stale `dist/cli.js` — your edits won't show up.

**Mode overrides** (mutually exclusive — pass at most one):

- `--installed` forces installed-mode even from a monorepo cwd. Use this to test the published CLI from inside the monorepo (e.g. dogfooding a release candidate).
- `--monorepo` forces monorepo-mode and errors if no DKG monorepo root is locatable. Use this to fail loudly if your CI expects a monorepo path but the workspace lookup goes sideways.

**Moved checkout caveat.** The written `args` carry an absolute path. If you rename or move your checkout, every registered client still points at the old path. Re-run `dkg mcp setup --force` from the new location to refresh every detected client's entry.

### Configuration sources

The MCP server resolves config from two places, in priority order:

1. **`.dkg/config.yaml`** — walked upwards from the working directory (the spec-canonical workspace config; see `dkgv10-spec / 22_AGENT_ONBOARDING §2.1`)
2. **environment variables** — `DKG_API`, `DKG_TOKEN`, `DKG_PROJECT`, `DKG_AGENT_URI`

Env values win over the file; tool-call arguments (`projectId`, `view`, …) win over both.

#### Minimal `.dkg/config.yaml`

Copy `packages/mcp-dkg/config.yaml.example` into `<workspace>/.dkg/config.yaml` and edit:

```yaml
contextGraph: my-research

node:
  api: http://localhost:9200
  tokenFile: ~/.dkg/auth.token

agent:
  uri: urn:dkg:agent:cursor-branarakic

capture:
  subGraph: chat
  assertion: chat-log
  privacy: team
autoShare: true
```

`.dkg/` is gitignored repo-wide so this file stays local to each operator. The `tokenFile` path is resolved relative to the YAML; default of `~/.dkg/auth.token` matches what `dkg start` writes on first boot.

## Tool surface (21 tools)

All tools are available the moment `dkg mcp setup` registers the MCP with your client. They group into six categories tracking how a session typically uses memory: discover the graph, write to it, finalize it, recall from it, query it, and check it.

### Health / identity

| Tool | What it does |
|---|---|
| `dkg_status` | Show DKG node status: peer ID, connected peers, multiaddrs, wallet addresses. First call most agents make to verify the daemon is running. |
| `dkg_wallet_balances` | TRAC and ETH balances per operational wallet, plus chain id and RPC URL. Use before publishing to verify funds. |

### Discovery (graph navigation)

| Tool | What it does |
|---|---|
| `dkg_list_context_graphs` | List all context graphs (called "projects" in the DKG node UI) this node knows about. Returns id, display name, role (curator / participant), and layer. The first call most agents make when joining a workspace. |
| `dkg_sub_graph_list` | List the sub-graphs inside a context graph (e.g. `code`, `github`, `decisions`, `tasks`, `meta`, `chat`) with entity counts. Use to figure out what kind of knowledge a CG exposes before querying. |
| `dkg_get_entity` | All triples where the given URI is the subject, plus a 1-hop inbound-edges neighbourhood. Equivalent to the entity detail page in the Node UI. Use to understand a specific decision, task, file, or PR end-to-end. |
| `dkg_list_activity` | Recent activity across all sub-graphs, newest first. Mirrors the "Recent activity" feed on the project overview page: decisions, tasks, PRs, chat turns. Use to catch up at the start of a session. |
| `dkg_get_agent` | Look up an agent by URI (or display name) and return its profile card: framework, operator, wallet address, joined-at, reputation, plus everything that agent has authored in the project. |

### Setup (graph CRUD)

| Tool | What it does |
|---|---|
| `dkg_context_graph_create` | Create a context graph (called "projects" in the DKG node UI). The `id` slug is auto-derived from `name` when omitted. Idempotent — pre-existing CGs are returned unchanged. |
| `dkg_subscribe` | Subscribe to a context graph so its data syncs locally from peers. Defaults to also syncing Shared Working Memory; pass `includeSharedMemory: false` to skip SWM. |
| `dkg_sub_graph_create` | Create a named sub-graph inside a context graph (e.g. `code`, `tasks`, `meta`). Idempotent — pre-existing sub-graphs are silently reused. |

### Write (the canonical assertion lifecycle)

The four-tool write flow that lets agents stage memory, share it, and recover from mistakes — the canonical V10 pattern, mirrored byte-for-byte across the OpenClaw adapter and the umbrella CLI.

| Tool | Step | What it does |
|---|---|---|
| `dkg_assertion_create` | 1 | Create an empty Working Memory assertion graph. Idempotent — duplicate names land as `alreadyExists: true`. Slug `/^[a-z0-9-]+$/`. |
| `dkg_assertion_write` | 2 | Append RDF quads into an existing WM assertion. Set-merge — duplicates collapse. To replace, call `dkg_assertion_discard` first or mint a unique name. |
| `dkg_assertion_promote` | 3 | Promote a WM assertion (or specific root entities) from private WM to Shared Working Memory so teammates see it. Omit `entities` to promote every root. |
| `dkg_assertion_discard` | rollback | Discard a WM assertion without promoting it. Idempotent — no-op on a missing assertion. Use before re-writing an assertion whose name you want to keep stable. |
| `dkg_assertion_query` | introspect | Return every quad in a WM assertion. The canonical introspection step for the create + write + promote round-trip. |
| `dkg_assertion_import_file` | bulk | Import a local document (markdown, PDF, DOCX, HTML, txt, csv) into a WM assertion via the daemon's extraction pipeline. Useful for seeding a context graph from existing documents in one step. |
| `dkg_assertion_history` | audit | An assertion's lifecycle descriptor: author, extraction status, promotion state, timestamps. Returns 404 if no record exists. |

### Publish (SWM → on-chain)

Two distinct surfaces (both documented in `SKILL.md §4a`):

| Tool | When to use |
|---|---|
| `dkg_publish` | "I have fresh quads, publish them now." Two-call helper: writes the supplied quads to SWM, then publishes the entire SWM in the CG to Verified Memory and clears SWM. Skip the WM staging area. |
| `dkg_shared_memory_publish` | Canonical step-4 finalizer for the stepwise flow (`assertion_create + write + promote` → this). Publishes existing SWM (filterable by `rootEntities`), clears SWM. Pass `registerIfNeeded: true` to upgrade a local-only CG to on-chain registration in the same call (may spend gas/TRAC). |

Both ship ungated — no `agent.canPublishToVm` flag — to mirror the OpenClaw adapter exactly.

### Search & query

| Tool | What it does |
|---|---|
| `dkg_memory_search` | Trust-weighted free-text recall across WM/SWM/VM in the agent-context graph (and an optional project graph). Higher-trust layers (VM > SWM > WM) collapse lower-trust hits for the same entity URI. Each hit surfaces `contextGraphId`, `layer`, and `trustWeight`. Use this for "ask my memory anything" recall. |
| `dkg_query` | Execute SPARQL SELECT / ASK / CONSTRUCT against a context graph. Known prefixes are auto-prepended. Scope with `view`: `"working-memory"` (default), `"shared-working-memory"`, or `"verified-memory"`. Set `includeSharedMemory: true` alongside `view: "working-memory"` to query WM ∪ SWM in one call. |

## The canonical round-trip

Lifted from the repo-root README's [DKG V10 as agent memory quickstart](../../README.md#round-trip-write-then-recall), reproduced here for completeness:

1. `dkg_assertion_create` with a slug name (idempotent — re-runs return `alreadyExists: true`).
2. `dkg_assertion_write` with one or more quads (additive set-merge).
3. `dkg_memory_search` with a keyword from the write — the just-written triple comes back from the WM layer with `trustWeight` set.
4. *(optional)* `dkg_assertion_promote` to advance the lifecycle to SWM and gossip to peers.
5. *(optional)* `dkg_shared_memory_publish` to finalize on-chain (costs TRAC + gas, clears SWM).

For ad-hoc filtering or non-text-search queries, `dkg_query` is the lower-level SPARQL surface. For one-shot fresh-quads-to-VM writes that skip the WM staging area, use `dkg_publish` instead of the assertion lifecycle — but prefer the lifecycle for anything an agent will iterate on.

## View semantics

The `view` argument (on `dkg_query`) and the `layer` argument (on `dkg_get_entity`, `dkg_list_activity`) scope reads to one of the three DKG memory tiers:

- `working-memory` — private to this node's agents (default for most reads)
- `shared-working-memory` — gossiped to every participant on the CG; trust-weighted above WM in `dkg_memory_search`
- `verified-memory` — on-chain anchored; responses include UAL + publisher info; highest trust weight

A separate `includeSharedMemory: boolean` axis (on `dkg_query` and `dkg_subscribe`) layers SWM on top of the requested view; `view: "working-memory"` + `includeSharedMemory: true` matches what the Node UI's default reader shows.

## Capture hook

The package ships a tool-agnostic hook script at `hooks/capture-chat.mjs` that turns every conversation turn into `chat:Turn` triples on the project's `chat` sub-graph and auto-promotes them to SWM so teammates see them immediately. The same script works for Cursor and Claude Code — only the event wiring differs.

### Cursor — `.cursor/hooks.json`

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [{ "command": "DKG_WORKSPACE=/path/to/repo node /path/to/packages/mcp-dkg/hooks/capture-chat.mjs beforeSubmitPrompt", "failClosed": false }],
    "afterAgentResponse": [{ "command": "DKG_WORKSPACE=/path/to/repo node /path/to/packages/mcp-dkg/hooks/capture-chat.mjs afterAgentResponse", "failClosed": false }]
  }
}
```

`DKG_WORKSPACE` tells the hook where to walk upward from when looking for `.dkg/config.yaml` — useful when Cursor's cwd differs from the repo root (e.g. multi-folder workspaces). `failClosed: false` is deliberate — the hook exists to enrich the DKG, never to block the user's conversation. Errors log to `/tmp/dkg-capture.log` (override via `DKG_CAPTURE_LOG`) and the hook still exits `0`.

### Claude Code — `~/.claude/settings.json`

Merge the following `hooks` block into your existing `~/.claude/settings.json`. The script accepts the native Claude Code event names (`UserPromptSubmit`, `Stop`) as aliases for `beforeSubmitPrompt` / `afterAgentResponse`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "DKG_WORKSPACE=/path/to/repo DKG_CAPTURE_TOOL=claude-code DKG_AGENT_URI=urn:dkg:agent:claude-code-<op> node /path/to/packages/mcp-dkg/hooks/capture-chat.mjs UserPromptSubmit" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "DKG_WORKSPACE=/path/to/repo DKG_CAPTURE_TOOL=claude-code DKG_AGENT_URI=urn:dkg:agent:claude-code-<op> node /path/to/packages/mcp-dkg/hooks/capture-chat.mjs Stop" }] }
    ]
  }
}
```

`DKG_CAPTURE_TOOL=claude-code` ensures turns carry `chat:speakerTool "claude-code"` in the graph so the UI chips them correctly. `DKG_AGENT_URI` lets you attribute Claude Code sessions to a distinct agent entity from your Cursor sessions — recommended (the "one human, two tools" shape in spec §4 of `22_AGENT_ONBOARDING`).

Per-turn state is kept in `~/.cache/dkg-mcp/sessions/*.json`; safe to delete at any time.

## Troubleshooting

- **`dkg mcp setup` says "no MCP-aware clients detected"** → install one of Cursor, Claude Code, Claude Desktop, Windsurf, VSCode + GitHub Copilot Chat, or Cline. Continue and Codex CLI are NOT auto-detected today (Continue's YAML-config shape and Codex CLI's TOML format ship in a follow-up); users with those clients should run `dkg mcp setup --print-only` and paste the JSON manually.
- **`dkg mcp` says command not found** → the umbrella CLI isn't on PATH. Verify with `which dkg`. Note: `npm i -g @origintrail-official/dkg` does NOT propagate transitive bins to global PATH, so the `dkg-mcp` bin is only reachable through `dkg mcp serve` or via a direct `npx -p @origintrail-official/dkg-mcp dkg-mcp`.
- **MCP not visible in client** → restart the client. On Cursor, verify `~/.cursor/mcp.json` is syntactically valid JSON. On Claude Code, run `claude mcp list`.
- **"No project specified"** → set `contextGraph: <id>` in `.dkg/config.yaml`, or pass `projectId` on each tool call, or export `DKG_PROJECT`.
- **HTTP 401 from MCP tools** → token mismatch. `dkg auth show` returns the expected value; confirm it matches `~/.dkg/auth.token`. On CI / containers / proxied environments where `dkg init` can't run, the env-var fallbacks are `DKG_API` (daemon URL, default `http://localhost:9200`), `DKG_TOKEN` (bearer), `DKG_PROJECT` (default context graph), `DKG_AGENT_URI` (operator agent URI). A stale exported `DKG_PROJECT` from a prior session can silently mis-route writes — unset it if you switch projects.
- **HTTP 404 on `/api/context-graph/list`** → you're on an older daemon; the client automatically falls back to the legacy endpoint.
- **`tools/list` is missing tools after `dkg mcp setup`** → the client's MCP config still points at a prior install. Re-run `dkg mcp setup --force` to refresh stale entries.

## Package layout

| File | Purpose |
|---|---|
| `src/index.ts` | Stdio MCP server entrypoint. Boots `McpServer` and registers the 21 tools. |
| `src/tools.ts` | Read tools (`dkg_list_context_graphs`, `dkg_sub_graph_list`, `dkg_query`, `dkg_get_entity`, `dkg_list_activity`, `dkg_get_agent`). |
| `src/tools/assertions.ts` | Assertion lifecycle (`dkg_assertion_*` × 7). |
| `src/tools/health.ts` | `dkg_status`, `dkg_wallet_balances`. |
| `src/tools/memory-search.ts` | `dkg_memory_search` with WM/SWM/VM fan-out and trust-weighted ranking. |
| `src/tools/publish.ts` | `dkg_publish`, `dkg_shared_memory_publish`. |
| `src/tools/setup.ts` | `dkg_context_graph_create`, `dkg_subscribe`, `dkg_sub_graph_create`. |
| `src/client.ts` | `DkgClient` HTTP wrapper. Re-exported as `@origintrail-official/dkg-mcp/client`. |
| `src/manifest/{publish,fetch,install}.ts` | Project manifest publish/install pipeline. Re-exported as `@origintrail-official/dkg-mcp/manifest/*` and consumed by the umbrella CLI's daemon routes. |
| `hooks/capture-chat.mjs` | Cursor/Claude Code chat-turn capture hook (above). |
| `schema/dev-context-graph.ttl` | The canonical dev-coordination ontology (devgraph namespace). |

## Historical recovery

Ten V9-era and coding-project tools were dropped from the V10 surface during consolidation. The annotated git tag `pre-v10-tool-drop` preserves them — recover any individual handler with `git show pre-v10-tool-drop:packages/mcp-dkg/src/tools/<file>`. Design rationale and reintroduction-pointers for each drop are in [`agent-docs/dkg-v10-mcp-consolidation/v9-design-archive.md`](../../agent-docs/dkg-v10-mcp-consolidation/v9-design-archive.md).
