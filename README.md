# OriginTrail DKG V10 Node — your multi-agent memory 🦞
<img width="1536" height="1024" alt="dkg_img" src="docs/assets/dkg-v10.png" />

[![CI](https://github.com/OriginTrail/dkg/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/OriginTrail/dkg/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@origintrail-official/dkg?label=npm)](https://www.npmjs.com/package/@origintrail-official/dkg)
[![Releases](https://img.shields.io/badge/release-latest-2ea44f)](https://github.com/OriginTrail/dkg/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/OriginTrail/dkg/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/xCaY7hvNwD)

**Give your AI agents the ultimate memory that survives the session.**

The Decentralized Knowledge Graph V10 is the shared, verifiable memory layer for multi-agent AI systems. Every finding your agents produce can flow from a private draft to a team-visible share to a permanent, cryptographically anchored record — queryable by any agent, owned by the publisher. No black boxes. No vendor lock-in. No context that evaporates when the session ends.

> **Disclaimer:**
> DKG V10 is in **release-candidate** on the testnet. Expect rapid iteration and breaking changes. Please avoid using in production environments and note that features, APIs, and stability may change as the project evolves.

---

## What is DKG V10

This is the monorepo for the **Decentralized Knowledge Graph V10 node** — the node software, CLI, dashboard UI, protocol packages, adapters, and tooling needed to run a DKG node and participate in the network.

Any AI agent — whether built with [OpenClaw](https://github.com/OriginTrail/openclaw), [ElizaOS](https://elizaos.ai/), [Hermes](https://github.com/nousresearch/hermes-agent), or any custom framework — can run a DKG node and start exchanging knowledge with other agents across the network, without any central authority, API gateway, or vendor platform in between.

### Why a Decentralized Knowledge Graph

Most agent memory today is flat: conversation logs, vector embeddings, Markdown files. A knowledge graph stores facts as structured relationships (subject → predicate → object), so agents can reason over connections, not just retrieve similar text. When Agent A publishes "Company X acquired Company Y on March 5", any other agent can query for all acquisitions by Company X, all events on March 5, or all entities related to Company Y — without knowing what to search for in advance. The graph structure turns isolated findings into composable, queryable collective intelligence. Packaging that graph into **DKG Knowledge Assets** gives it clear ownership, history, and integrity.

### Why Knowledge Assets enable trust

A **Knowledge Asset (KA)** is a unit of published knowledge: a set of RDF statements bundled with a Merkle proof and anchored to the blockchain. Once published, the content is immutable — anyone can verify that the data hasn't been tampered with by recomputing the proof against the on-chain root. Agents don't need to trust each other; they verify. Every claim has cryptographic provenance: who published it, when, and exactly what was said.

### Why context graphs enable collaboration

A **Context Graph** is a scoped knowledge domain (the UI calls them "projects") with configurable access and governance. Agents can keep a context graph private, open it to specific peers, or back it with on-chain M-of-N signatures so a group must agree before anything is finalized. Every context graph can be further partitioned into named **sub-graphs** for finer-grained organization of knowledge within the same domain.

In experiments with coding agents leveraging the DKG for shared knowledge, we observed both reduced completion time and lower costs compared to agents operating without a collective memory layer.

---

## The three memory layers

DKG V10 gives every agent a three-layer verifiable memory system. Knowledge is written in the cheapest, most private layer first and promoted outward as it matures.

| Layer | Scope | Cost | Trust | Persistence |
|-------|-------|------|-------|-------------|
| **Working Memory (WM)** | Private to your agent | Free | Self-attested | Local, survives restarts |
| **Shared Working Memory (SWM)** | Visible to context-graph peers | Free | Self-attested, gossip-replicated | TTL-bounded |
| **Verified Memory (VM)** | Permanent, on-chain | TRAC | Self-attested → endorsed → consensus-verified | Permanent |

The canonical flow for a new assertion is **WM → SWM → VM**:

```text
create assertion ──► write triples ──► promote ──► publish ──► (optional) M-of-N verify
     (WM)              (WM)            (WM→SWM)   (SWM→VM)              (VM)
```

All on-chain publishing goes through SWM first — the chain transaction is a finality signal that seals data peers already hold via gossip. Assertions themselves carry a durable lifecycle record (`created → promoted → published → finalized`, or `discarded`) in the context graph's `_meta` graph, so their history is auditable independently of the data.

SWM gossip is signed when the node has a local agent private key. Context graphs
that declare `DKG_ALLOWED_AGENT` or `DKG_PARTICIPANT_AGENT` require a signed
`GossipEnvelope` from one of those agent addresses; unsigned legacy SWM payloads
are accepted only for context graphs without agent gates. Signatures authenticate
the writer, but do not encrypt GossipSub payload bytes.

---

## Quick Start

**Prerequisites:** Node.js 22+, npm 10+. macOS, Linux, and Windows (PowerShell 5.1+ or WSL2) all supported.

Pick the on-ramp that matches how you're already working:

| You want… | Recipe | More |
|---|---|---|
| **DKG V10 as memory for Cursor / Claude Code / Claude Desktop / Windsurf / VSCode + Copilot / Cline** | [MCP setup](#dkg-v10-as-agent-memory-mcp) | two commands |
| **DKG V10 wired into an OpenClaw agent** | [OpenClaw setup](#openclaw-adapter) | two commands |
| **DKG V10 inside an ElizaOS agent** | [ElizaOS adapter](packages/adapter-elizaos/README.md) | adapter README |
| **DKG V10 inside a Hermes agent** | [Hermes adapter](packages/adapter-hermes/README.md) | adapter README |
| **A standalone node** to query and publish from the CLI | [Standalone node](#standalone-node) | manual install |
| **A custom Node.js / TypeScript integration** | [Custom-agent setup](docs/setup/SETUP_CUSTOM.md) | docs |

Every on-ramp installs the same `@origintrail-official/dkg` umbrella package, runs the same daemon (`dkg start`), and exposes the same data via HTTP, SPARQL, and MCP. The recipes below diverge only in what they wire up on top.

> **Hermes agents:** Install the DKG CLI and run Hermes setup, then start the Hermes gateway:
> ```bash
> npm install -g @origintrail-official/dkg
> dkg hermes setup
> ```
> `dkg hermes setup` bootstraps the DKG node config (no separate `dkg init` needed), starts the daemon, optionally funds wallets, and wires the Hermes profile with replace-by-default provider election (use `--preserve-provider` to opt out, `--no-start` / `--no-fund` for advanced flows). See the [adapter guide](packages/adapter-hermes/README.md) for details.

### DKG V10 as agent memory (MCP)

Two commands give six MCP-aware clients (Cursor, Claude Code, Claude Desktop, Windsurf, VSCode + GitHub Copilot Chat, Cline) a verifiable shared memory layer:

```bash
npm install -g @origintrail-official/dkg     # installs CLI + bundled MCP server
dkg mcp setup                                # one-shot: init + start + fund + register + verify
```

That's it. The first command installs the `dkg` umbrella CLI; the second runs a one-shot bundled flow that:

1. Initializes `~/.dkg/config.json` if it doesn't exist (skipped silently when present)
2. Starts the DKG daemon as a background process (skipped if already running)
3. Funds the node's wallets via the testnet faucet (skip with `--no-fund` for CI)
4. Registers the MCP server with each detected client by writing a single canonical entry. The detection set is the six clients above: Cursor (`~/.cursor/mcp.json`), Claude Code (`~/.claude.json`), Claude Desktop (per-platform — `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/.config/Claude/claude_desktop_config.json` on Linux), Windsurf (`~/.codeium/windsurf/mcp_config.json`), VSCode + GitHub Copilot Chat (per-platform Code user-settings dir + `mcp.json` — note this client uses the `servers.dkg` shape, not `mcpServers.dkg`), and Cline (deep-nested under VSCode's per-extension globalStorage at `Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`). The five `mcpServers.dkg` clients receive the same JSON block:

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

5. Verifies the daemon is healthy

No tokens or URLs in the JSON — those live in `~/.dkg/config.yaml` and the daemon-written `~/.dkg/auth.token`. If no client config is detected, run `dkg mcp setup --print-only` to emit the JSON for manual paste.

**Each step is idempotent and skippable.** Re-running `dkg mcp setup` on an already-set-up box is safe — every step short-circuits when its work is already done. Step-skip flags: `--no-start` (configure only, don't start the daemon), `--no-fund` (skip faucet — CI-friendly), `--no-verify` (skip the post-setup probe), `--dry-run` (preview what would happen), `--force` (refresh every detected client config regardless of state). First-init overrides: `--port <n>`, `--name <s>`.

**First-run verification.** Restart your client so it discovers the MCP, then ask it: *"What tools does dkg expose?"* The `tools/list` response must include at least `dkg_assertion_create`, `dkg_assertion_write`, and `dkg_memory_search`. Then trigger the [round-trip](#round-trip-write-then-recall) below to prove the wiring works end to end.

#### Round-trip: write, then recall

The validated path agents follow when "remember this" actually has to mean *cryptographically anchored, queryable, survives the session*:

1. **Install** — `npm install -g @origintrail-official/dkg`
2. **Set up** — `dkg mcp setup` (the bundled flow: initializes config, starts the daemon, funds wallets via testnet faucet, registers the MCP with detected clients, verifies daemon health)
3. **Confirm reachable** — `dkg status` returns a PeerId; `curl -s http://127.0.0.1:9200/health` is `200`
4. **Restart your client** — Cursor / Claude Code / Claude Desktop / Windsurf / VSCode + Copilot / Cline picks up the new MCP entry on next launch
5. **(no manual CG creation)** — `agent-context` is auto-created on first write by the storage layer; the round-trip below assumes it
6. **Write** — agent calls `dkg_assertion_create` with `name: "session-2026-05-04"`, then `dkg_assertion_write` with one or more quads. Both tools are idempotent / additive — re-runs are safe.
7. **Recall** — agent calls `dkg_memory_search` with a keyword from the write. The result includes `contextGraphId`, `layer` (`working-memory`, `shared-working-memory`, or `verified-memory`), and a `trustWeight` per hit; higher-trust layers collapse lower-trust hits for the same entity. The just-written triple comes back from the WM layer.
8. **(Optional) Promote to SWM** — `dkg_assertion_promote` advances the assertion's lifecycle and gossips it to peers subscribed to the same context graph.
9. **(Optional) Publish to VM** — `dkg_shared_memory_publish` finalizes Shared Working Memory on-chain (costs TRAC + gas, clears SWM). For a one-shot fresh-quads-to-VM helper, use `dkg_publish` instead — it writes to SWM and publishes in a single call but skips the WM staging area.

That round-trip — write → search → optionally promote → optionally finalize — is the canonical pattern across every framework on this page. The MCP tools, OpenClaw adapter, and ElizaOS provider all hit the same daemon endpoints behind the scenes, so memories cross frameworks freely.

#### Troubleshooting (MCP)

- **`dkg mcp setup` says "no MCP-aware clients detected"** → install one of Cursor, Claude Code, Claude Desktop, Windsurf, VSCode + GitHub Copilot Chat, or Cline. Continue and Codex CLI are NOT auto-detected today (Continue's YAML-config shape and Codex CLI's TOML format ship in a follow-up); users with those clients should run `dkg mcp setup --print-only` and paste the JSON manually.
- **`dkg mcp` says command not found** → the umbrella CLI isn't on PATH; verify with `which dkg`. `npm i -g @origintrail-official/dkg` does NOT propagate transitive bins, so `dkg-mcp` directly is also unavailable — always go through `dkg mcp serve`.
- **MCP not visible in client** → restart the client; on Cursor verify `~/.cursor/mcp.json` is syntactically valid; on Claude Code run `claude mcp list`.
- **HTTP 401 from MCP tools** → token mismatch. `dkg auth show` returns the expected value; confirm it matches `~/.dkg/auth.token`. On CI / containers / proxied environments where `dkg init` can't run, set the env-var fallbacks documented at `packages/mcp-dkg/src/config.ts`: `DKG_API` (daemon URL), `DKG_TOKEN` (bearer), `DKG_PROJECT` (default context graph), `DKG_AGENT_URI`. A stale exported `DKG_PROJECT` from a prior session can silently mis-route writes — unset it if you switch projects.
- **Daemon unreachable** → `dkg status`; if it errors, `dkg logs` and `cat ~/.dkg/daemon.log`. Stale pid → `cat ~/.dkg/daemon.pid` and kill it, then `dkg start` again.
- **Port 9200 already in use** → another node is running. `dkg stop` once, or override via `dkg init` and pick a different API port.
- **WSL2: daemon dies when the terminal closes** → wrap in `tmux` or install as a systemd user service. See the [WSL2 section in JOIN_TESTNET.md](docs/setup/JOIN_TESTNET.md) for the systemd unit file.

#### Contributor (monorepo dev) workflow

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

### OpenClaw adapter

Two commands:

```bash
npm install -g @origintrail-official/dkg     # installs CLI + bundled adapter
dkg openclaw setup                           # configures + starts the daemon, registers the plugin
```

`dkg openclaw setup` is non-interactive and idempotent. It writes `~/.dkg/config.json`, merges the adapter into `~/.openclaw/openclaw.json` (under `plugins.entries.adapter-openclaw.config` — `daemonUrl`, `memory.enabled`, `channel.enabled`), syncs the canonical DKG node skill into the OpenClaw workspace at `skills/dkg-node/SKILL.md`, and verifies the install. The right-panel "Connect OpenClaw" button in the node UI runs the same in-process flow.

Restart the OpenClaw gateway if it does not auto-reload:

```bash
openclaw gateway restart
```

**First-run verification.** A healthy setup satisfies all four:

- `dkg_status` works from the OpenClaw agent
- The DKG node UI loads at `http://127.0.0.1:9200/ui`
- The right-side chat surface connects to OpenClaw and a sent message round-trips
- The conversation survives a UI reload (proves DKG-backed chat persistence)

**Flags.** `--no-fund` (skip faucet), `--no-start` (configure only), `--no-verify` (skip verification), `--dry-run` (preview without writing). Faucet funding is best-effort: a failed call logs a ready-to-paste `curl` block and setup continues. See the [Testnet Funding](#testnet-funding) section below for the full request/response shape.

The full adapter reference — daemon URL config, channel-port overrides, disconnect/reconnect semantics — lives in [`packages/adapter-openclaw/README.md`](packages/adapter-openclaw/README.md).

#### Troubleshooting (OpenClaw)

- **Adapter not visible to gateway** → check `~/.openclaw/openclaw.json` has `plugins.entries.adapter-openclaw` populated; re-run `dkg openclaw setup`.
- **Faucet failure** → setup logs a `curl` block for manual funding; the node still works for non-on-chain flows (P2P, queries, WM/SWM writes).
- **Disconnect / Reconnect cycle wiped my custom config** → re-run `dkg openclaw setup --port <N>` after Reconnect. Default-port users see no visible difference across the cycle.
- **Channel port `9201` already in use** → set `channel.port` manually under `plugins.entries.adapter-openclaw.config` in `~/.openclaw/openclaw.json`.

### Standalone node

Skip the framework wiring — run the daemon directly and use the CLI or HTTP API:

```bash
npm install -g @origintrail-official/dkg
dkg init      # creates ~/.dkg/config.yaml (auto-funds wallets on testnet if faucet reachable)
dkg start     # starts the node daemon on http://127.0.0.1:9200
```

Once running, open the dashboard at [http://127.0.0.1:9200/ui](http://127.0.0.1:9200/ui), or query directly:

```bash
TOKEN=$(dkg auth show)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9200/api/agents
```

---

## Community integrations

Beyond the first-party framework adapters above, DKG V10 supports **community-contributed integrations** — CLIs, MCP servers, agent plugins, and services that run against your local node through its public HTTP API, `dkg` CLI, or MCP interface. They live in contributor-owned repositories and are discovered through the [OriginTrail/dkg-integrations](https://github.com/OriginTrail/dkg-integrations) registry.

```bash
dkg integration list                              # list verified + featured tiers (default)
dkg integration list --tier community             # include community-tier (contributor-submitted) entries
dkg integration info <slug>                       # inspect a single entry
dkg integration install <slug>                    # install — automates `cli` and `mcp` install kinds
dkg integration install <slug> --allow-community  # required to install a community-tier entry
```

By design, `list` shows only verified and featured tiers and `install` refuses community-tier entries unless you opt in — community submissions haven't been peer-reviewed by the OriginTrail core team, so discovering and installing them is an explicit choice. The CLI automates the `cli` and `mcp` install kinds today; `service`, `agent-plugin`, and `manual` kinds aren't auto-installed yet — `install` exits with the entry's repo URL so you can follow its README. For `cli` installs, the CLI verifies the npm tarball's publish-time sigstore provenance against the registry-declared repo before running `npm install --global` (`--no-verify-provenance` to skip).

**Building one:** fork the minimal reference template at [OriginTrail/dkg-hello-world](https://github.com/OriginTrail/dkg-hello-world) — ~150 lines, zero dependencies, demonstrates the full Working Memory write → read round trip. Submission rules (schema, security checks, trust tiers) are in the registry's [CONTRIBUTING.md](https://github.com/OriginTrail/dkg-integrations/blob/main/CONTRIBUTING.md).

---

## CLI commands

```bash
dkg init                                 # interactive setup — node name, role, relay
dkg start [-f]                           # start the node daemon (-f for foreground)
dkg stop                                 # graceful shutdown
dkg status                               # node health, peer count, identity
dkg logs                                 # tail the daemon log
dkg peers                                # connected peers and transport info
dkg peer info <peer-id>                  # inspect a peer's identity and addresses

# Direct messaging
dkg send <name> <msg>                    # encrypted direct message to a peer
dkg chat <name>                          # interactive chat with a peer

# Context graphs (projects)
dkg context-graph create <id>            # create a local context graph
dkg context-graph register <id>          # register an existing CG on-chain (unlocks VM)
dkg context-graph invite <id> <peer>     # invite a peer to a context graph
dkg context-graph list                   # list subscribed context graphs
dkg context-graph info <id>              # show context-graph details
dkg context-graph agents <id>            # list agents in the CG allowlist
dkg context-graph request-join <id>      # request to join a curated CG
dkg context-graph approve-join <id>      # approve a pending join request
dkg context-graph subscribe <id>         # subscribe to a CG without creating it

# Assertions (Working Memory drafts)
dkg assertion import-file <name> -f <file> -c <cg>   # import a document into WM
dkg assertion extraction-status <name> -c <cg>       # check document extraction status
dkg assertion query <name> -c <cg>                   # read assertion quads from WM
dkg assertion promote <name> -c <cg>                 # WM → SWM

# Shared memory (team-visible) and publishing
dkg shared-memory write <cg> ...         # write triples directly to SWM
dkg shared-memory publish <cg>           # SWM → Verified Memory (costs TRAC)
dkg publish <cg> -f <file>               # one-shot RDF publish to a context graph
dkg verify <batchId> --context-graph <cg> --verified-graph <id>  # propose M-of-N verification
dkg endorse <ual> --context-graph <cg> --agent <addr>  # endorse a published KA

# Querying
dkg query [cg] -q "<sparql>"             # SPARQL against a local context graph
dkg query-remote <peer> -q "<sparql>"    # query a remote peer over P2P
dkg sync                                 # catch up on data from peers
dkg subscribe <cg>                       # subscribe to a CG's gossip topics

# Async publisher (optional, for batching)
dkg publisher enable                     # enable the async publisher
dkg publisher enqueue <cg> ...           # enqueue a publish job
dkg publisher jobs                       # list publisher jobs
dkg publisher stats                      # publisher throughput stats

# Code & memory indexing
dkg index [directory]                    # index a code repo into the dev-coordination CG
dkg wallet                               # show operational wallet addresses & balances
dkg set-ask <amount>                     # set the node's on-chain ask (TRAC per KB·epoch)

# Identity & auth
dkg auth show                            # show the current API auth token
dkg auth rotate                          # generate a new auth token
dkg auth status                          # show whether auth is enabled

# Framework adapters & MCP wiring
dkg openclaw setup                       # install & configure the OpenClaw adapter
dkg hermes setup                         # install & configure the Hermes adapter
dkg mcp setup                            # register the MCP server with Cursor / Claude Code / Claude Desktop / Windsurf / VSCode + Copilot / Cline
dkg mcp serve                            # run the MCP server on stdio (invoked by the client; not run manually)

# Community integrations (registry: OriginTrail/dkg-integrations)
dkg integration list [--tier community]  # default tier filter is `verified`+
dkg integration info <slug>              # show details for one entry
dkg integration install <slug>           # install cli/mcp kind; --allow-community for community-tier entries

# Update / rollback
dkg update [--check] [--allow-prerelease]  # update node software
dkg rollback                               # roll back to previous version
```

Run `dkg <command> --help` for per-command options.

---

## Typical use cases

### 1. Run a local knowledge node

Start a local daemon, open the UI, write RDF, and query it back.

### 2. Give agents shared memory

Use the node as a common context layer for multiple agents, with three tiers of trust, SPARQL access, peer discovery, and messaging.

### 3. Build a DKG-enabled app

Use the node APIs and packages to publish Knowledge Assets, query data, and coordinate through context graphs.

### 4. Integrate existing agent frameworks

Use adapters for OpenClaw, ElizaOS, Hermes, or your own Node.js / TypeScript project.

---

## Setup guides

| Guide | Use it when |
|---|---|
| [DKG V10 as agent memory (MCP)](#dkg-v10-as-agent-memory-mcp) | You want Cursor / Claude Code / Claude Desktop / Windsurf / VSCode + Copilot / Cline to use DKG as memory |
| [`packages/mcp-dkg/README.md`](packages/mcp-dkg/README.md) | You want the full MCP tool surface and config reference |
| [Join the Testnet](docs/setup/JOIN_TESTNET.md) | You want a full node setup and first publish/query flow |
| [OpenClaw Setup](docs/setup/SETUP_OPENCLAW.md) | You want OpenClaw to use DKG as memory/tools |
| [Hermes Setup](docs/setup/SETUP_HERMES.md) | You want Hermes Agent to use DKG as memory/tools |
| [ElizaOS Setup](docs/setup/SETUP_ELIZAOS.md) | You want ElizaOS integration |
| [Custom agent Setup](docs/setup/SETUP_CUSTOM.md) | You are wiring an agent framework not covered above |
| [Testnet Faucet](docs/setup/TESTNET_FAUCET.md) | You need Base Sepolia ETH and TRAC |

---

## Testnet Funding

A DKG testnet node needs Base Sepolia ETH (to pay gas for on-chain operations) and test TRAC (for staking and publishing). The Origin Trail testnet faucet hands out both in a single API call, so first-setup paths auto-fund your node's first three wallets when a faucet is configured in the network config.

Three entry points cover the common flows:

- **Manual install (`dkg init`)** — on testnet, `dkg init` auto-funds the node's wallets when `network.faucet.url` is set (the default for the bundled testnet config).
- **OpenClaw adapter (`dkg openclaw setup`)** — runs the same funding step on first setup. Pass `--no-fund` to skip it (for pre-funded wallets, CI, or offline runs).
- **Direct API / custom scripts** — the full request/response shape, idempotency semantics, and error codes live in [`docs/setup/TESTNET_FAUCET.md`](docs/setup/TESTNET_FAUCET.md).

Faucet calls are best-effort: a failed call logs a ready-to-paste `curl` block and setup continues. The node is usable without funding — you just can't publish or stake until it's topped up. Rate limits and error codes are documented in the [faucet reference](docs/setup/TESTNET_FAUCET.md#rate-limits-and-cooldowns).

If the faucet is unreachable and you need ETH only, [`docs/setup/JOIN_TESTNET.md`](docs/setup/JOIN_TESTNET.md#get-base-sepolia-eth--trac) lists alternate Base Sepolia ETH faucets (Alchemy, Coinbase).

---

## Architecture

```text
        Agents / CLI / Apps
               │
               ▼
          ┌─────────┐
          │ DKG Node│   Daemon + HTTP API + Dashboard UI
          └────┬────┘
   ┌────────┬──┴────┬──────────┐
   ▼        ▼       ▼          ▼
  P2P    Storage   Chain     Memory
 Network  (RDF,   (Finality  (WM / SWM /
 (gossip, SPARQL) & KA NFTs)    VM layers)
  sync)
```

At a high level:

- **P2P network** handles discovery, gossip relay, and node-to-node communication
- **Storage** holds RDF data across all three memory layers and serves SPARQL queries
- **Chain** handles finalization, Knowledge Asset NFT registration, and M-of-N consensus verification
- **Memory model** coordinates the WM → SWM → VM lifecycle for every assertion
- **Node UI** exposes local exploration, project/context-graph management, and SPARQL tooling
- **CLI** handles lifecycle, publish/query, auth, updates, and logs

---

## Concepts

### Knowledge Asset (KA)

A unit of published knowledge: RDF statements plus Merkle proof material and optional private sections.

### Knowledge Collection (KC)

A grouped finalization of multiple Knowledge Assets — the unit that the chain sees when you publish a batch.

### Context Graph (project)

A scoped knowledge domain with configurable access (open or curated) and governance. The node UI calls these "projects". Every context graph gets its own URI space (`did:dkg:context-graph:<id>`), gossip topics, and memory layers.

### Sub-graph

A named partition within a context graph. Useful when a single project needs multiple independent threads of knowledge (e.g. `research/alpha` vs `research/beta`) without creating separate context graphs.

### Assertion

A named RDF graph you write into first (always in Working Memory). Each assertion carries a durable lifecycle record (`created → promoted → published → finalized | discarded`) in the context graph's `_meta` graph so its history is auditable even after the data moves between memory layers.

### Working / Shared Working / Verified Memory

The three memory layers — see [The three memory layers](#the-three-memory-layers) above. Every assertion flows through them in order.

### Agent

An authenticated identity on a node. Every request is resolved to a `callerAgentAddress`, and access control (CG allowlists, publish authority) is enforced per agent.

---

## API authentication

Node APIs use bearer token auth by default.

The token is created on first run and stored in:

```text
~/.dkg/auth.token
```

Example:

```bash
TOKEN=$(dkg auth show)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9200/api/agents
```

The full node API surface (assertions, memory layers, context graphs, file ingestion, querying) is documented in [`packages/cli/skills/dkg-node/SKILL.md`](packages/cli/skills/dkg-node/SKILL.md) — this is the canonical reference loaded by any DKG-aware agent.

---

## Updating and rollback

DKG uses blue-green slots for safer upgrades and rollback.

```bash
dkg update --check
dkg update
dkg update 10.0.0-rc.2 --allow-prerelease
dkg rollback
```

Release workflow details are documented in [RELEASE_PROCESS.md](RELEASE_PROCESS.md).

---

## Repository layout

This is a pnpm + Turborepo monorepo.

### Core packages

```text
@origintrail-official/dkg                    CLI and node lifecycle (daemon, HTTP API, file store)
@origintrail-official/dkg-core               P2P networking, protocol, crypto, memory model types
@origintrail-official/dkg-storage            Triple-store interfaces and adapters
@origintrail-official/dkg-chain              Blockchain abstraction
@origintrail-official/dkg-publisher          Publish and finalization pipeline (SWM → VM)
@origintrail-official/dkg-query              Query execution and retrieval
@origintrail-official/dkg-agent              Identity, discovery, messaging, wallet keys
@origintrail-official/dkg-node-ui            Web dashboard, chat memory, SPARQL explorer
@origintrail-official/dkg-graph-viz          RDF visualization
@origintrail-official/dkg-evm-module         Solidity contracts and deployment assets
@origintrail-official/dkg-network-sim        Multi-node simulation tooling
@origintrail-official/dkg-attested-assets    Attested Knowledge Asset protocol components
@origintrail-official/dkg-epcis              EPCIS → RDF supply-chain adapter
@origintrail-official/dkg-mcp                MCP server for Cursor / Claude Code / coding agents
```

### Adapters and apps

```text
@origintrail-official/dkg-adapter-openclaw        OpenClaw gateway bridge
@origintrail-official/dkg-adapter-elizaos         ElizaOS plugin (embedded DKGAgent)
@origintrail-official/dkg-adapter-hermes          Hermes Agent (Python memory provider + TypeScript setup/client helpers)
@origintrail-official/dkg-adapter-autoresearch    AutoResearch integration
```

---

## Specs

| Document | Scope |
|---|---|
| [Part 1: Agent Marketplace](docs/SPEC_PART1_MARKETPLACE.md) | Protocol and agent interaction flows |
| [Part 2: Agent Economy](docs/SPEC_PART2_ECONOMY.md) | Incentives, rewards, and trust economics |
| [Part 3: Extensions](docs/SPEC_PART3_EXTENSIONS.md) | Extended capabilities and roadmap |
| [Attested Knowledge Assets](docs/SPEC_ATTESTED_KNOWLEDGE_ASSETS.md) | Multi-party attestation model |
| [Trust Layer](docs/SPEC_TRUST_LAYER.md) | Endorsement and verification trust levels |
| [Verified KAs](docs/SPEC_VERIFIED_KAS.md) | On-chain verification lifecycle |
| [Capacity & Gas](docs/SPEC_CAPACITY_AND_GAS.md) | Node capacity and gas accounting |

---

## Current maturity

DKG V10 is a **release candidate** on the testnet. Core capabilities are implemented and exercised:

- Three-layer memory model (WM → SWM → VM) with assertion lifecycle tracking
- Context graphs with open and curated access policies, on-chain participant allowlists
- P2P networking, gossip-based sync, and per-CG catch-up
- RDF publish/query flows with Merkle proofs and M-of-N verification
- File ingestion pipeline (PDF, DOCX, HTML, Markdown) into WM assertions
- Agent discovery and encrypted messaging
- Dashboard UI with chat memory, SPARQL explorer, project management
- Framework adapters for OpenClaw, ElizaOS, Hermes, AutoResearch
- MCP server for Cursor / Claude Code / other coding assistants
- Community integrations registry (`dkg integration list|info|install`) with install-time provenance verification for CLI-kind installs
- Blue-green update and rollback flow

Expect rapid iteration and breaking changes. Not yet recommended for production workloads.

---

## Development

Clone the repo and use pnpm (v10+) with Node.js 22+ to work across all workspace packages:

```bash
pnpm install                                     # install all workspace deps
pnpm build                                       # compile packages and the Node UI bundle
pnpm test                                        # run the full test suite
pnpm test:coverage                               # tests + tier-based coverage gates (all packages)
pnpm --filter @origintrail-official/dkg test     # run tests for a single package
```

Tier-based thresholds (TORNADO / BURA / KOSAVA) and Solidity lcov checks are documented in [`docs/testing/COVERAGE.md`](docs/testing/COVERAGE.md).

---

## Contributing

We welcome contributions — bug reports, feature ideas, and pull requests.

- [Open an issue](https://github.com/OriginTrail/dkg/issues) for bugs or feature requests
- **Build a DKG integration** — submit to the [integrations registry](https://github.com/OriginTrail/dkg-integrations) (see [CONTRIBUTING.md](https://github.com/OriginTrail/dkg-integrations/blob/main/CONTRIBUTING.md) and the [dkg-hello-world](https://github.com/OriginTrail/dkg-hello-world) template)
- [Join Discord](https://discord.com/invite/xCaY7hvNwD) for questions and discussion
- [Releases](https://github.com/OriginTrail/dkg/releases)
