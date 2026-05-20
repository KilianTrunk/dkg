# Daemon

The long-running DKG node process. Exposes the HTTP API the CLI, MCP server,
and external integrations talk to. Lifecycle is in `lifecycle.ts`; the HTTP
router is in `handle-request.ts`; per-route-group dispatchers live in `routes/`.

## Language

**Route group**:
A self-contained file under `routes/` that exports a single
`handleXxxRoutes(ctx: RequestContext): Promise<void>` function. The router
calls each route group in order; the first one to write a response wins.
Examples: `routes/epcis.ts`, `routes/status.ts`.

**Route plugin**:
A fork-supplied npm package whose default export is `{ name, handle(ctx) }`,
loaded at daemon startup and dispatched as the last step in the route
group chain. Lets forks add HTTP endpoints without editing `handle-request.ts`.
See `docs/adr/0001-daemon-route-plugins.md`.
_Distinct from_: **Agent plugin** (ElizaOS-style), **Integration**.

**Integration**:
A trusted third-party tool installed via the `dkg integration install` CLI
from a curated registry (`OriginTrail/dkg-integrations`). Kinds are `cli`,
`mcp`, `service`, `agent-plugin`, `manual`. Lives in
`packages/cli/src/integrations/`. Does **not** add HTTP routes to the
daemon — that's what **Route plugins** do.
_Avoid_: "plugin" (ambiguous with route plugin / agent plugin).

**Agent plugin**:
An ElizaOS framework plugin packaged as an `InstallAgentPlugin` integration
(`kind: 'agent-plugin'`). Runs inside an ElizaOS agent, not inside the
daemon. Different mechanism from **Route plugin** despite the shared word.
See `packages/adapter-elizaos/`.

**RequestContext**:
The bag of per-request state passed to every route group and route plugin.
Holds the live agent, publisher, config, dashDb, vectorStore, file store,
and the derived per-request fields (`url`, `path`, `requestToken`,
`requestAgentAddress`). Defined in `routes/context.ts`.

**httpAuthGuard**:
The single global authentication gate at `lifecycle.ts:1865`. Runs **before**
`handleRequest`, so every route group and route plugin downstream sees only
authenticated requests. Plugins inherit auth from it — there is no
per-plugin auth surface.

**Operator state**:
Per-install daemon state in `~/.dkg/` — PID file, log file, API port marker,
`config.json`. **Not shipped with the npm package**; survives daemon
upgrades. `routePlugins` lives here.

## Relationships

- The router calls each **Route group** in declaration order; the first one
  to write a response claims the request.
- **Route plugins** are dispatched by a single trailing **Route group**
  (`routes/plugins.ts`) that iterates `ctx.routePlugins`.
- **Route plugins** are loaded from **Operator state** (`routePlugins` field
  in `config.json`) once at daemon boot, after agent/publisher init and
  before `server.listen()`.
- An **Integration** never adds HTTP routes; if a fork needs HTTP routes,
  it ships a **Route plugin** (separate mechanism).

## Example dialogue

> **Dev:** "I want my fork to expose `POST /api/kamstrup/streams` — do I
> publish a route plugin or an integration?"
> **Maintainer:** "Route plugin. Integrations don't add daemon endpoints —
> they install CLI tools and MCP servers. Publish an npm package exporting
> `{ name, handle(ctx) }`, then put the package name in `routePlugins` in
> the operator's `~/.dkg/config.json`."

## Flagged ambiguities

- The word "plugin" appears in three places with three different meanings:
  - **Route plugin** — this CONTEXT, the HTTP route extension mechanism.
  - **Agent plugin** — ElizaOS-style, lives in `adapter-elizaos`.
  - "Plugin" used colloquially for the EPCIS package header (which calls
    itself a "plugin" but is actually a hard-coded daemon dependency, not
    a loadable extension).

  When writing or reading code, always use the qualified form
  ("route plugin", "agent plugin") to keep the three apart.
