## Phase 2 — Architecture refactor PR plan

This document scopes the refactoring work that came out of the v10‑rc cleanup pass. Phase 0 (dead code / unused deps) shipped as PR #238. Phase 1 (security/correctness fixes) shipped as PRs #239, #241, #242, #243. Phase 2 is everything that needs more design discussion and *should not* land overnight.

The headline observations:

| File | LOC | Concern |
|---|---|---|
| `packages/cli/src/daemon.ts` | 10,303 | Single-file HTTP daemon with 60+ routes, journaling, MCP install, agent registration, publisher queue, sync, file uploads, and start-up wiring all interleaved |
| `packages/agent/src/dkg-agent.ts` | 7,259 | A "god class" wrapping publisher + sync + discovery + chain + WM/SWM + chat + skills + endorse/verify + curator gates — ~170 methods |
| `packages/cli/src/cli.ts` | 2,983 | Mixed CLI command dispatch + interactive REPL + setup wizards |
| `packages/publisher/src/dkg-publisher.ts` | 2,250 | Two publish paths (V10/V9) and two update paths inlined into one class — see also P‑1.2 follow‑up |
| `packages/chain/src/evm-adapter.ts` | 2,060 | Acceptable for now (one adapter per chain, lots of typed view-call helpers) |
| `packages/adapter-openclaw/src/DkgChannelPlugin.ts` | 1,824 | Out of scope (adapter, not core) |

This plan covers the two highest‑leverage targets: `daemon.ts` and `dkg-agent.ts`. Other files are flagged as follow‑ups but not designed in detail here.

---

### 1. `packages/cli/src/daemon.ts` (10.3k LOC) — split into a routed daemon

#### Today

`daemon.ts` is one 10k‑line file that:

- Bootstraps process state (env, config, agent, publisher, memory manager, journal).
- Runs an HTTP server with 60+ routes (`/api/status`, `/api/agents`, `/api/publisher/...`, `/api/context-graph/...`, `/api/assertion/...`, `/api/query`, `/api/openclaw-channel/...`, `/api/file/...`, `/api/genui/render`, etc.).
- Owns operations journaling, catch‑up tracker, MCP install/version logic, manifest resolution, MarkItDown lifecycle, semver parsing, peer connect, and a long tail of helpers.
- Reads request bodies, parses query strings, JSON‑responds, and writes the operations journal — all inline.

#### Split target (one PR per group, mergeable independently)

Each split is a "lift, don't rewrite" — extract a module that exposes a `register(router)` function and receives only the dependencies it actually uses. The common spine is `{ agent, publisher, journal, log, config }`, but several routes additionally need shared daemon state that already exists in `daemon.ts` today and must be threaded through, not duplicated:

- `apiHost` / `apiPortRef` (for routes that produce self‑referential URLs)
- `catchupTracker` (context‑graph / sub‑graph routes)
- the SSE client registry used by `/api/events`
- the in‑flight extraction/operation locks used by `publisher`, `assertion`, and `openclaw-channel` routes
- manifest + MarkItDown + MCP helpers currently inlined into `daemon.ts`

The exact dependency shape per module is discovered when the split happens; the plan below is meant as "each module receives the explicit dependencies it needs" rather than a frozen signature.

```
packages/cli/src/
├── daemon.ts                        ~600 LOC — bootstrap + listen + auth
├── daemon/
│   ├── http/
│   │   ├── router.ts                # tiny pattern matcher (req.method, path) → handler
│   │   ├── auth.ts                  # extractBearerToken, resolveAgentAddress
│   │   ├── responses.ts             # jsonResponse, errorResponse, sse helpers
│   │   └── readBody.ts
│   ├── routes/
│   │   ├── status.ts                # /api/status, /api/info, /api/connections, /api/peer-info
│   │   ├── agents.ts                # /api/agent/register, /api/agents, /api/agent/identity
│   │   ├── skills.ts                # /api/skills, /api/invoke-skill
│   │   ├── chat.ts                  # /api/chat, /api/messages, /api/chat-openclaw
│   │   ├── openclaw-channel.ts      # /api/openclaw-channel/*  (~600 LOC today)
│   │   ├── publisher.ts             # /api/publisher/*  (~400 LOC today)
│   │   ├── context-graph.ts         # /api/context-graph/*
│   │   ├── sub-graph.ts             # /api/sub-graph/*  (shares state with context-graph.ts via dep injection)
│   │   ├── assertion.ts             # /api/assertion/*
│   │   ├── query.ts                 # /api/query
│   │   ├── connect.ts               # /api/connect, /api/update, /api/subscribe
│   │   ├── paranet.ts               # /api/paranet/create|list|rename|exists
│   │   │                            # NOT a pure alias — see below
│   │   ├── shared-memory.ts         # /api/shared-memory/write,
│   │   │                            #   /api/shared-memory/publish,
│   │   │                            #   /api/shared-memory/conditional-write
│   │   │                            #   (writes into a CG's `_shared_memory` graph;
│   │   │                            #   query/subscribe flow through /api/query +
│   │   │                            #   /api/context-graph/subscribe — there is no
│   │   │                            #   dedicated /api/shared-memory/query|subscribe)
│   │   ├── query-remote.ts          # /api/query-remote  (RPC-over-libp2p variant
│   │   │                            #   of /api/query — the SPARQL form rides on
│   │   │                            #   the same endpoint via a `sparql` body field;
│   │   │                            #   no separate /api/query-remote-sparql route)
│   │   ├── sync.ts                  # /api/sync/catchup-status  (the only
│   │   │                            #   /api/sync/* route on the wire today;
│   │   │                            #   programmatic sync triggers flow through
│   │   │                            #   /api/context-graph/subscribe and
│   │   │                            #   /api/update)
│   │   ├── settings.ts              # /api/settings/shared-memory-ttl,
│   │   │                            #   /api/settings/workspace-ttl
│   │   │                            #   (runtime-tunable SWM retention)
│   │   ├── local-agent-integrations.ts # /api/local-agent-integrations*,
│   │   │                            #   /api/integrations, /api/register-adapter,
│   │   │                            #   /api/openclaw-agents
│   │   ├── verify.ts                # /api/verify (verified-memory single-KA verify),
│   │   │                            #   /api/endorse
│   │   ├── ccl.ts                   # /api/ccl/eval, /api/ccl/policy/*,
│   │   │                            #   /api/ccl/results
│   │   ├── memory.ts                # /api/memory/turn, /api/memory/search
│   │   ├── epcis.ts                 # /api/epcis/events, /api/epcis/capture
│   │   ├── identity.ts              # /api/identity, /api/identity/ensure,
│   │   │                            #   /api/wallet, /api/wallets, /api/wallets/balances
│   │   │                            #   (ensureIdentity, keystore wallet CRUD)
│   │   ├── chain.ts                 # /api/chain/rpc-health
│   │   ├── host.ts                  # /api/host/info, /api/shutdown
│   │   ├── files.ts                 # /api/file/*
│   │   ├── genui.ts                 # /api/genui/render
│   │   ├── events.ts                # /api/events  (SSE)
│   │   └── well-known.ts            # /.well-known/skill.md
│   ├── manifest/                    # buildManifestInstallContext + helpers
│   ├── markitdown/                  # carryForwardBundledMarkItDownBinary etc.
│   ├── mcp-version.ts               # parseSemver, versionSatisfiesRange, readMcpDkgVersion
│   ├── catchup.ts                   # CatchupTracker + job state
│   └── journal/                     # operations journal (already partially separated)
```

Acceptance criteria per route module:

- Same wire format and status codes (snapshot the full `daemon.ts` behaviour with a CDC test before splitting; the existing playwright + node-ui tests should keep passing).
- Auth resolution (`requestAgentAddress`) is performed by `http/auth.ts`, not the route module.
- Phase events (`tracker.start/startPhase/completePhase/complete`) stay at the route boundary so the journal contract doesn't change.
- **Every existing legacy path stays wired.** The refactor is a pure file move, not an API break. Before merging any route split, grep the monorepo for the route string and confirm in-repo clients (`packages/mcp-dkg`, `packages/node-ui`) resolve against the new location. (The historical `mcp-server` package was a third in-repo client at plan-authoring time; it was removed in the V10 keeper consolidation 2026-05-04 — see the `pre-v10-tool-drop` tag.) The known legacy aliases that must survive the move (verified against `packages/cli/src/daemon.ts` at the time of writing) are:
  - `/api/subscribe` → V10 `/api/context-graph/subscribe`
  - `/api/paranet/create | list | rename | exists` → V10 `/api/context-graph/*` (see the paranet caveat below; `paranet/create` is a narrower legacy shim, not a pure alias)
  - `/api/workspace/write` → V10 `/api/shared-memory/write` (dual-wired at `daemon.ts:4646-4650`)
  - `/api/workspace/enshrine` → V10 `/api/shared-memory/publish` (dual-wired at `daemon.ts:4706-4710`)

  A route split that omits any of these aliases silently breaks older CLI builds, the historical legacy MCP package (now removed; see `pre-v10-tool-drop` tag), and any user automation that hit the V9 surface.

Recommended PR ordering (smallest → largest, each is independently mergeable):

1. Extract `http/router.ts`, `http/auth.ts`, `http/responses.ts`, `http/readBody.ts` only. `daemon.ts` keeps the giant `if (req.method === ... && path === ...)` chain but each branch becomes a 5‑line dispatch.
2. Extract `routes/status.ts`, `routes/well-known.ts`, `routes/files.ts`, `routes/events.ts` — the simple, side‑effect‑light routes.
3. Extract `routes/agents.ts`, `routes/identity.ts`, `routes/skills.ts`, `routes/chat.ts`.
4. Extract `routes/openclaw-channel.ts` — by itself ~600 LOC, the largest single sub‑surface.
5. Extract `routes/publisher.ts`.
6. Extract `routes/context-graph.ts` and `routes/sub-graph.ts` (paired — sub-graph routes share the private-CG gating helpers that live with context-graph), then `routes/paranet.ts` (V10 create/register multiplexing lives here — see note below), `routes/assertion.ts`, `routes/query.ts`, `routes/query-remote.ts`, `routes/shared-memory.ts`, `routes/sync.ts`, `routes/local-agent-integrations.ts`, `routes/verify.ts`, `routes/ccl.ts`, `routes/memory.ts`, `routes/epcis.ts`, `routes/connect.ts`, `routes/genui.ts`.
7. Move helpers into `manifest/`, `markitdown/`, `mcp-version.ts`, `catchup.ts`.

> **`/api/paranet/create` is the narrower legacy shim, NOT the richer route.** Actual wiring in `packages/cli/src/daemon.ts:4955-5081` has the V10 `/api/context-graph/create` handler own the richer flow — when the body carries `participantIdentityIds` (with or without `id`/`name`) it multiplexes the on‑chain create/register path, and it is the route that understands `register`, `allowedPeers`, `participantIdentityIds`, `requiredSignatures`, plus paranet curator + ACL parameters. `/api/paranet/create` (`daemon.ts:7623-7701`) is the legacy shim: it takes only `{ id, name, description, allowedAgents, accessPolicy }` and delegates into the local‑create code path. The split must keep both handlers, but follow‑up PRs MUST NOT "consolidate" by moving the richer behaviour onto the legacy route — the contract in the tree today is that the V10 context‑graph handler is canonical and the paranet one is a compatibility stub. Any consolidation is its own semver‑breaking PR with a dedicated migration note, not part of this "lift, don't rewrite" phase.

End state: `daemon.ts` ≤ 1 kLOC; no single route module > 800 LOC.

---

### 2. `packages/agent/src/dkg-agent.ts` (7.3k LOC) — split into named subsystems

#### Today

`DKGAgent` wraps almost every primitive in the codebase: publisher, sync, discovery, chain identity, WM/SWM, chat, skills, endorse/verify, curator gates, profile manager, peer connection, key management. ~170 methods, ~30 private fields.

Several Phase 1 fixes (A‑1, A‑12) revealed that the boundary between "the local node" and "an authenticated agent on the local node" is muddled. Splitting the file is also the *enabling step* for the deferred A‑1.2 (authenticated scoped handle for in‑process callers).

#### Split target

```
packages/agent/src/
├── dkg-agent.ts                     ~1.0 kLOC — facade: composes the parts, owns lifecycle
├── agent/
│   ├── identity.ts                  # peerId, wallet, defaultAgentAddress, registerAgent,
│   │                                # listLocalAgents, resolveAgentByToken, resolveAgentAddress,
│   │                                # ensureIdentity (keystore bootstrap / wallet creation)
│   ├── profile.ts                   # publishProfile (already exists; merge ProfileManager here)
│   ├── discovery.ts                 # findAgents, findSkills, findAgentByPeerId  (already a module)
│   ├── publish.ts                   # publish, update, share, conditionalShare,
│   │                                # publishFromSharedMemory, enshrineFromWorkspace
│   ├── query.ts                     # query, queryRemote, queryRemoteSparql,
│   │                                # lookupEntity, findEntitiesByType, getEntityTriples
│   │                                # ← lands the A-1.2 callerAgentAddress refactor here
│   ├── sync.ts                      # syncFromPeer, syncSharedMemoryFromPeer,
│   │                                # syncContextGraphFromConnectedPeers,
│   │                                # cleanupExpiredSharedMemory, setSharedMemoryTtlMs
│   ├── context-graph.ts             # createContextGraph, registerContextGraphOnChain,
│   │                                # addBatchToContextGraph, isCuratorOf,
│   │                                # inviteToContextGraph, subscribe/unsubscribe
│   ├── context-graph-discovery.ts   # listContextGraphs, getContextGraphMetadata,
│   │                                # catch-up helpers (pullContextGraphFromPeers),
│   │                                # approveJoinRequest, listParticipants
│   ├── endorse.ts                   # endorse  (delegates to existing endorse.ts builder)
│   ├── verify.ts                    # verify, propose-verify, ConsensusVerified promotion
│   ├── ccl.ts                       # CCL policy eval + policy CRUD flows currently
│   │                                # inlined on DKGAgent (evalCcl, registerPolicy, etc.)
│   ├── network.ts                   # networkId, pingPeers, peer list helpers
│   │                                # (libp2p health/identity surface exposed on DKGAgent)
│   ├── chat.ts                      # sendChat, onChat
│   └── skills.ts                    # invokeSkill + skill registration
└── dkg-agent-types.ts               # public option/result interfaces shared by the parts
```

Acceptance criteria:

- `DKGAgent` remains the primary public export. The classes that are currently re‑exported from `packages/agent/src/index.ts` (`ProfileManager`, `DiscoveryClient`) and documented in `packages/agent/README.md` stay exported and importable from the same paths — this refactor is a pure file move, not a semver break. New sub‑modules under `agent/` are package‑internal (`@internal` JSDoc) unless a sub‑module is explicitly promoted to the public API in a separate PR.
- **Packaging boundary for `@internal`**: `packages/agent/package.json` today publishes the whole `dist/` tree and has no `exports` map, so `@internal` JSDoc on its own does **not** prevent third parties from deep‑importing `@origintrail-official/dkg-agent/dist/agent/query.js`, etc. To make the boundary real, the refactor PR that introduces the `agent/` sub‑tree **must** ship an `exports` map in `packages/agent/package.json` that pins the public surface to the package entry (`"."`) and blocks deep paths (`"./*": null` or an explicit allow‑list of curated sub‑paths). Until that map lands, every sub‑module under `agent/` is technically reachable from userland — we will treat that as an unsupported deep‑import path in release notes, and the `exports` map closes it in the same PR to avoid a window where the JSDoc and the published package disagree.
- Each sub‑module receives its dependencies via constructor (no `this.parent` reach‑backs).
- Existing `import { DKGAgent, ProfileManager, DiscoveryClient } from '@origintrail-official/dkg-agent'` keeps working unchanged.
- `agent/query.ts` is the natural landing site for the A‑1.2 follow‑up: it can carry an `AuthenticatedHandle` that pre‑binds `callerAgentAddress`, removing the "trusted in‑process caller" exemption introduced by PR #242.

Recommended PR ordering:

1. Lift `endorse.ts` and `chat.ts` (both already mostly self‑contained).
2. Lift `discovery.ts`, `profile.ts`, `identity.ts` (already partially separated as `discovery.ts` / `profile.ts` / `profile-manager.ts` — finish the move).
3. Lift `verify.ts` and `endorse.ts` consumers.
4. Lift `query.ts`, then `publish.ts`, then `sync.ts`, then `context-graph.ts`.
5. Final pass: thin `dkg-agent.ts` to a facade.

End state: `dkg-agent.ts` ≤ 1.5 kLOC; no sub‑module > 1.2 kLOC. The implementations of `ProfileManager` and `DiscoveryClient` move into `agent/profile.ts` and `agent/discovery.ts` respectively, **but the classes themselves remain public exports from `@origintrail-official/dkg-agent`** — the old import paths keep working. Collapsing them into plain functions (which would be a semver‑breaking change and would force `packages/cli`, the keystore tests, and `packages/agent/README.md` examples to be rewritten) is deferred to a separate, explicitly‑breaking PR and is NOT part of Phase 2.

---

### 3. Smaller follow‑ups (separate PRs, no design needed)

| File | LOC | Action |
|---|---|---|
| `packages/cli/src/cli.ts` | 2,983 | Split per command group; same router pattern as daemon.ts |
| `packages/publisher/src/dkg-publisher.ts` | 2,250 | Split V10 publish path / V9 publish path / update path; aligns with the **P‑1.2** follow‑up (split adapter sign/broadcast for write‑ahead txHash persistence) |
| `packages/node-ui/src/ui/api.ts` | 1,431 | Per‑surface split (query, chat, agent, paranet) |
| `packages/node-ui/src/chat-memory.ts` | 1,362 | Already touched in A‑1 review — the WM read/write seam is the natural split point |

---

### 4. Risks & mitigations

- **Risk:** churn in import paths breaks downstream consumers (CLI, node‑ui, MCP).
  **Mitigation:** keep `dkg-agent.ts` and `daemon.ts` as facades that re‑export the public surface. Between every split PR, run `pnpm -r build` (builds every package that exposes a `build` script — this is the closest thing to a repo‑wide typecheck we have today) and the following test suites:
  - `packages/agent` (DKGAgent unit + integration)
  - `packages/publisher` (phase-sequences + publish/update regression)
  - `packages/cli` (daemon HTTP behaviour + CLI integration)
  - `packages/node-ui` (chat-memory, operations view)
  - `packages/mcp-dkg` (MCP tool schema + integration — the MCP server is an in-repo client of `/api/query`, `/api/shared-memory/write`, `/api/shared-memory/publish`, `/api/context-graph/list`, and `/api/context-graph/create` as wired in its `client.ts`; a route move that breaks any of those calls would otherwise slip through the daemon-only tests. The list must be re‑grepped before any PR that touches routes — if this file falls out of sync with `client.ts`, the verification checklist stops catching MCP‑publish regressions. The historical legacy MCP package was a separate fourth client at plan-authoring time and has since been removed in the V10 keeper consolidation 2026-05-04; see `pre-v10-tool-drop` tag for its original wiring.)

  A repo‑wide `typecheck` script per package is itself a Phase‑2 follow‑up, not a prerequisite.

- **Risk:** lifting code accidentally widens trust boundaries (e.g. dropping the A‑1 `callerAgentAddress` check during a route move or during the `DKGAgent` split).
  **Mitigation:** two-layer coverage, landing in phases. Both layers must be present and green before any `DKGAgent` sub‑module split or `/api/query` route extraction merges.
  1. *Agent-layer (exists today)* — `packages/agent/test/wm-multi-agent-isolation-extra.test.ts` registers two distinct agents on one `DKGAgent`, writes WM under each, and asserts the structural graph‑URI scoping invariant plus the in‑process `DKGAgent.query(view:'working-memory', agentAddress: OTHER)` guard. This catches regressions in the per‑module split (e.g. if `agent/query.ts` forgets to thread `callerAgentAddress`). Note: this file does **not** currently exercise non‑string `agentAddress` rejection — that test will be added alongside the `agent/query.ts` extraction PR, to lock the rejection message at the module boundary rather than only at the daemon.
  2. *HTTP-layer (lands with PR #242, then extended)* — `packages/cli/test/daemon-http-behavior-extra.test.ts` gets an `A-1 follow-up: auth-disabled /api/query fails closed on foreign WM` block in PR #242 that covers the daemon‑child‑process path with `authEnabled: false` and an invalid bearer. Before the `/api/query` route extraction merges, that block must be extended to also cover the **authEnabled: true** branch (agent‑scoped bearer attempting a foreign‑WM read → `401/403`; node‑level admin bearer → bypass allowed). This catches regressions in the route split (e.g. if `routes/query.ts` stops forwarding `requestAgentAddress` as `callerAgentAddress`, or reverts the agent‑scoped/node‑level token distinction added in PR #242).
  If a future route or module lift removes the agent-layer test's relevance (say by moving the guard into a scoped handle) the HTTP-layer test still locks the externally observable contract — do not delete it.

- **Risk:** golden‑sequence tests (e.g. `packages/publisher/test/phase-sequences.test.ts`) break when phases get re‑ordered during a split.
  **Mitigation:** publisher split goes LAST; the phase contract is frozen by PR #241.

---

### 5. Out of scope for Phase 2 (deferred)

- **P‑1.2 / P‑1.3:** real write‑ahead txHash persistence (requires splitting the EVM adapter's sign/broadcast — non‑trivial, want devnet validation).
- **P‑2:** per‑node fencing tokens (needs spec discussion).
- **A‑5:** per‑CG `requiredSignatures` enforcement at publish time (PROD‑BUG; needs quorum manager).
- **A‑7:** ENDORSE signature + nonce (PROD‑BUG; needs key‑mgmt path through `endorse.ts`).
- **A‑15:** sign every gossip envelope (PROD‑BUG; needs `GossipPublisher` to wrap the libp2p layer).
- **A‑13:** workspace‑config loader (SPEC‑GAP; new module).
- **Q‑1:** per‑quad trust filtering inside surviving WM graphs (complement to PR #239's graph‑level minTrust filter).
- **A‑1.2:** authenticated scoped handle for in‑process callers (`ChatMemoryManager`, `DkgMemoryPlugin`). Behavioural fix, scoped to its own PR. The §2 split creates the *natural home* for it (`agent/query.ts`) but A‑1.2 is NOT part of the §2 "lift, don't rewrite" split PRs — that framing is preserved by keeping behaviour identical during the split and fixing A‑1.2 in a follow‑up once the module exists.
- **A‑12.2:** migrate the remaining `did:dkg:agent:${this.peerId}` uses inside `dkg-agent.ts` (creator DID, sync‑auth self‑reference, gossip endorsement self‑DID) to the EVM form. Same framing as A‑1.2 — lands AFTER the §2 split in a dedicated behavioural PR, not as part of the split itself, so the no‑behavioural‑change contract of Phase 2 holds.

---

### 6. Suggested merge order

1. PR #238 (Phase 0 cleanup) — already merged
2. PRs #239, #241, #242, #243 (Phase 1 fixes) — review and merge in any order; independent
3. **This doc** — PR for review/discussion before any §1 or §2 PR opens
4. §1 daemon.ts splits (7 PRs)
5. §2 dkg-agent.ts splits (5 PRs), interleaved with §1 if desired
6. §3 follow‑ups
7. Deferred Phase 1 security work (A‑5, A‑7, A‑15, P‑2, etc.) — separate planning doc

Estimated total: ~12 reviewable PRs, each ≤ 1.5 kLOC of moved code, none introducing behavioural change.
