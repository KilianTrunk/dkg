# `@origintrail-official/dkg-mcp`

A small [Model Context Protocol](https://modelcontextprotocol.io) server
that exposes your local DKG daemon to **Cursor**, **Claude Code**, and
any other MCP-aware coding assistant.

Once installed, an agent can do things like:

- `dkg_list_context_graphs` — see every context graph (called "projects" in the DKG node UI) this node participates in
- `dkg_list_activity` — catch up on the last 25 entities authored across the graph, with attribution
- `dkg_assertion_create` + `dkg_assertion_write` — open a Working Memory assertion and append RDF quads to it
- `dkg_assertion_promote` — promote a Working Memory assertion to Shared Working Memory so teammates see it
- `dkg_memory_search "tree-sitter"` — trust-weighted free-text recall across WM/SWM/VM in the agent-context graph (and an optional project graph)
- `dkg_get_entity urn:dkg:…` — pull an entity's full triples + 1-hop neighbours
- `dkg_query "SELECT ?d WHERE { ?d a decisions:Decision }"` — drop down to raw SPARQL when the canned tools aren't enough

## Install

```bash
# in the monorepo
pnpm --filter @origintrail-official/dkg-mcp build

# once published to npm
npx -p @origintrail-official/dkg-mcp dkg-mcp
```

The binary is called `dkg-mcp` and reads config from two places, in order:

1. **`.dkg/config.yaml`** walked upwards from the working directory (the spec-canonical workspace config, see `dkgv10-spec / 22_AGENT_ONBOARDING §2.1`)
2. **environment variables** — `DKG_API`, `DKG_TOKEN`, `DKG_PROJECT`, `DKG_AGENT_URI`

Env values always win over the file, and tool-call arguments (`projectId`,
`layer`, …) always win over env.

### Minimal `.dkg/config.yaml`

Copy `packages/mcp-dkg/config.yaml.example` into `<workspace>/.dkg/config.yaml`
and edit:

```yaml
contextGraph: dkg-code-project

node:
  api: http://localhost:9200
  tokenFile: ../.devnet/node1/auth.token   # relative to the YAML file

agent:
  uri: urn:dkg:agent:cursor-branarakic

capture:
  subGraph: chat
  assertion: chat-log
  privacy: team
autoShare: true
```

`.dkg/` is gitignored repo-wide so this file stays local to each operator.

## Wire it into Cursor

Put this in `~/.cursor/mcp.json` (or the workspace-scoped
`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "dkg": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp-dkg/dist/index.js"]
    }
  }
}
```

Published via npm:

```json
{
  "mcpServers": {
    "dkg": {
      "command": "npx",
      "args": ["-y", "-p", "@origintrail-official/dkg-mcp", "dkg-mcp"]
    }
  }
}
```

Cursor automatically picks up `.dkg/config.yaml` from the workspace,
so as long as your project has one committed, the server will resolve
the right daemon URL, token, and project id without any per-machine
tweaks.

## Wire it into Claude Code

Either edit `~/.claude.json` / workspace `.claude/mcp.json` with the same
block as above, or run:

```bash
claude mcp add dkg node /absolute/path/to/packages/mcp-dkg/dist/index.js
```

Inside a Claude Code session you can then do:

```
/mcp dkg_list_activity
/mcp dkg_memory_search "branarakic tree-sitter"
```

## Capture hook

The package ships a tool-agnostic hook script at
`hooks/capture-chat.mjs` that turns every conversation turn into
`chat:Turn` triples on the project's `chat` sub-graph and auto-promotes
them to SWM so teammates see them immediately. The same script works
for Cursor and Claude Code — only the event wiring differs.

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

`DKG_WORKSPACE` tells the hook where to walk upward from when looking
for `.dkg/config.yaml` — useful when Cursor's cwd is different from the
repo root (e.g. a multi-folder workspace). `failClosed: false` is
deliberate — the hook exists to enrich the DKG, never to block the
user's conversation. Any error is logged to `/tmp/dkg-capture.log`
(override via `DKG_CAPTURE_LOG`) and the hook still exits `0`.

### Claude Code — `~/.claude/settings.json`

Merge the following `hooks` block into your existing `~/.claude/settings.json`
(the capture-chat script handles the native Claude Code event names
`UserPromptSubmit` / `Stop` as aliases for `beforeSubmitPrompt` /
`afterAgentResponse`):

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

`DKG_CAPTURE_TOOL=claude-code` ensures turns carry `chat:speakerTool
"claude-code"` in the graph so the UI chips them correctly.
`DKG_AGENT_URI` lets you attribute Claude Code sessions to a distinct
agent entity from your Cursor sessions (recommended — this is the
"one human, two tools" shape in spec §4 of `22_AGENT_ONBOARDING`).

### Shared state

Per-turn state is kept in `~/.cache/dkg-mcp/sessions/*.json`; safe to
delete at any time.

## Tools at a glance

| Tool                       | What it does                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `dkg_list_context_graphs`  | List every context graph (called "projects" in the DKG node UI) this node knows   |
| `dkg_sub_graph_list`       | List the sub-graphs in one context graph with entity counts                        |
| `dkg_query`                | Execute any SPARQL (prefixes auto-injected) scoped by `view` (WM/SWM/VM) ± SWM     |
| `dkg_get_entity`           | Entity detail: all outgoing triples + inbound 1-hop neighbours                     |
| `dkg_list_activity`        | Recent activity feed, newest first, with agent attribution                         |
| `dkg_get_agent`            | Agent profile card + per-type authored counts                                      |
| `dkg_assertion_create`     | Step 1 of the canonical write flow: create an empty WM assertion (idempotent)      |
| `dkg_assertion_write`      | Step 2: append RDF quads into an existing WM assertion                             |
| `dkg_assertion_promote`    | Step 3: promote a WM assertion (or specific roots) into Shared Working Memory      |
| `dkg_assertion_discard`    | Discard a WM assertion without promoting (rollback / replace-then-write pattern)   |
| `dkg_assertion_query`      | Dump every quad in a WM assertion — closed-loop introspection for the round-trip  |
| `dkg_memory_search`        | Trust-weighted free-text recall across WM/SWM/VM, agent-context + optional project |

## View semantics

The `view` argument (where supported) scopes the query to one of the
three DKG memory tiers:

- `working-memory` — private to this node's agents (default)
- `shared-working-memory` — gossiped to every participant on the CG
- `verified-memory` — on-chain anchored; responses include UAL +
  publisher info

A separate `includeSharedMemory: boolean` axis (where supported) layers
SWM on top of the requested view; `view: "working-memory" +
includeSharedMemory: true` matches what the Node UI's default reader
shows.

## Troubleshooting

- **"No project specified"** — set `contextGraph: <id>` in `.dkg/config.yaml`
  or pass `projectId` on each tool call.
- **HTTP 401** — your token is wrong. Point `node.tokenFile` at the
  `auth.token` file produced by your daemon's devnet setup, or export
  `DKG_TOKEN`.
- **HTTP 404 on `/api/context-graph/list`** — you're on an older daemon;
  the client automatically falls back to `/api/paranet/list`.
