# Daemon Route Plugins — Design

**Status:** Approved (2026-05-20)
**Author:** brainstorming session, claude@origin-trail.com
**Companion ADR:** `docs/adr/0001-daemon-route-plugins.md`

## Goal

Let forks (Kamstrup, JPB, future) add their own HTTP routes to the DKG daemon
without editing base-repo files. Today, the only way to add a route on a fork
is to insert a dispatch line into `packages/cli/src/daemon/handle-request.ts`,
which produces a merge conflict on every upstream sync. After this slice, forks
declare their routes in their own npm package and add the package name to the
daemon's config; the base-repo file is never touched again.

## Non-goals

- **Migrating EPCIS** to the new mechanism. EPCIS stays hard-coded in
  `handle-request.ts` as one of the chain steps. The new mechanism runs in
  parallel. Migration happens if/when someone has reason to touch EPCIS.
- **Authentication/authorization changes.** The existing `httpAuthGuard()` at
  `packages/cli/src/daemon/lifecycle.ts:1865` continues to run as the single
  global gate, before `handleRequest` is invoked. Plugins inherit auth from it.
- **Shipping any actual kafka or domain route.** This slice is pure
  infrastructure.
- **NPM provenance verification** of loaded plugins. Deferred to v2 — see
  "Future work" below for why slice 1 is operator-trust.
- **Hot reload.** Plugins load once at daemon startup. To pick up plugin
  changes, restart the daemon.
- **Conflict detection between plugins** declaring the same path. Plugins
  decide path ownership at runtime inside their `handle()` function; there is
  no manifest the loader can scan. First plugin in config order wins (chain
  semantics).

## Architecture

The daemon's HTTP router (`handleRequest` in `packages/cli/src/daemon/handle-request.ts`)
is a sequential chain of `await handleXxxRoutes(ctx)` calls, one per route
group, with `res.writableEnded` as an implicit `next`. Twelve route groups
exist today: `handleStatusRoutes`, `handleAgentChatRoutes`,
`handleOpenclawRoutes`, `handleHermesRoutes`, `handleMemoryRoutes`,
`handlePublisherRoutes`, `handleContextGraphRoutes`, `handleAssertionRoutes`,
`handleQueryRoutes`, `handleLocalAgentsRoutes`, `handleEpcisRoutes`,
`handlePcaRoutes`. If none claims the request, a `404` falls out at the end.

Route plugins are a thirteenth chain step — a dispatcher that iterates an
array of plugins (loaded once at startup) and calls each one's `handle(ctx)`
in turn. Each plugin is a function with the same `(ctx: RequestContext) => Promise<void>`
contract every existing route-group handler uses. Plugins use the same
short-circuit rule: write to `ctx.res` to claim the request, or fall through.

### Files added (3)

#### `packages/cli/src/daemon/plugin-api.ts`

The public surface for plugin authors. This is the **only** module a fork
imports from. Re-exports the `RequestContext` type plus a small set of
runtime helpers, and defines the `RoutePlugin` interface.

```ts
// packages/cli/src/daemon/plugin-api.ts
export type { RequestContext } from './routes/context.js';
export {
  jsonResponse,
  readBody,
  readBodyBuffer,
  MAX_BODY_BYTES,
  SMALL_BODY_BYTES,
} from './http-utils.js';

export interface RoutePlugin {
  /** Human-readable identifier for logs and error responses. */
  name: string;
  /** Per-request handler. Write to ctx.res to claim, or return to fall through. */
  handle(ctx: import('./routes/context.js').RequestContext): Promise<void> | void;
}
```

The CLI package's `package.json` `exports` field gets a new subpath export:

```jsonc
{
  "exports": {
    ".": "./dist/index.js",
    "./daemon/plugin-api": "./dist/daemon/plugin-api.js"
  }
}
```

Plugin authors import as:

```ts
import type { RoutePlugin } from '@origintrail-official/dkg/daemon/plugin-api';
import { jsonResponse, readBody } from '@origintrail-official/dkg/daemon/plugin-api';
```

Note: the CLI package is named `@origintrail-official/dkg`. Today it has no
`exports` field — consumers reach into `./dist/*` via deep paths. This slice
adds an `exports` field with `"."` (the existing bin entry remains via
`bin`) and `"./daemon/plugin-api"` as the **only** supported subpath for
plugin authors. The pattern matches `@origintrail-official/dkg-mcp`, which
already uses subpath exports (`./client`, `./manifest/publish`, etc.).

#### `packages/cli/src/daemon/plugin-loader.ts`

Pure function that resolves and imports each plugin spec from a string array.
Fail-soft: a bad plugin is logged and skipped; the rest still load.

```ts
// packages/cli/src/daemon/plugin-loader.ts
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import type { Logger } from '@origintrail-official/dkg-core';
import type { RoutePlugin } from './plugin-api.js';

const daemonRequire = createRequire(import.meta.url);

export async function loadRoutePlugins(
  specs: readonly string[],
  log: Logger,
): Promise<RoutePlugin[]> {
  const loaded: RoutePlugin[] = [];
  for (const spec of specs) {
    try {
      const resolved = isAbsolute(spec) ? spec : daemonRequire.resolve(spec);
      const mod = await import(resolved);
      const candidate = (mod.default ?? mod.plugin ?? mod) as unknown;
      const plugin = validateRoutePlugin(candidate, spec);
      loaded.push(plugin);
    } catch (err) {
      log.warn({ spec, err: serializeErr(err) }, 'route-plugin-load-failed');
    }
  }
  return loaded;
}

function validateRoutePlugin(candidate: unknown, spec: string): RoutePlugin {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`route plugin "${spec}" did not export a valid module`);
  }
  const obj = candidate as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    throw new Error(`route plugin "${spec}" missing string "name"`);
  }
  if (typeof obj.handle !== 'function') {
    throw new Error(`route plugin "${spec}" missing "handle" function`);
  }
  return { name: obj.name, handle: obj.handle as RoutePlugin['handle'] };
}

function serializeErr(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}
```

#### `packages/cli/src/daemon/routes/plugins.ts`

The per-request dispatcher. Matches the existing `routes/<group>.ts` shape.

```ts
// packages/cli/src/daemon/routes/plugins.ts
import { jsonResponse } from '../http-utils.js';
import type { RequestContext } from './context.js';

export async function handlePluginRoutes(ctx: RequestContext): Promise<void> {
  const plugins = ctx.routePlugins;
  if (!plugins || plugins.length === 0) return;
  for (const plugin of plugins) {
    try {
      await plugin.handle(ctx);
    } catch (err) {
      // Plugin threw mid-request. If it hasn't already written a response,
      // emit a 500 with the plugin name so the operator can correlate logs.
      if (!ctx.res.writableEnded) {
        jsonResponse(ctx.res, 500, {
          error: 'PluginError',
          plugin: plugin.name,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (ctx.res.writableEnded) return;
  }
}
```

### Files changed (5)

#### `packages/cli/src/daemon/handle-request.ts`

One new import, one new chain step inserted **before** the trailing 404. The
existing 12 chain steps stay unchanged. `handleRequest` currently takes 26
parameters; one new parameter is added (`routePlugins`) that flows the
loaded plugins into the per-request `ctx`.

```diff
 import { handlePcaRoutes } from './routes/pca.js';
+import { handlePluginRoutes } from './routes/plugins.js';
+import type { RoutePlugin } from './plugin-api.js';

 export async function handleRequest(
   req: IncomingMessage,
   ...
   apiPortRef: { value: number },
+  routePlugins: RoutePlugin[],
   emitMemoryGraphChanged?: (event: MemoryGraphChangedEvent) => void,
 ): Promise<void> {
   ...
   const ctx: RequestContext = {
     ...
     apiHost,
     apiPortRef,
+    routePlugins,
     url,
     ...
   };
   ...
   await handlePcaRoutes(ctx);
   if (res.writableEnded) return;

+  await handlePluginRoutes(ctx);
+  if (res.writableEnded) return;
+
   jsonResponse(res, 404, { error: 'Not found' });
 }
```

#### `packages/cli/src/daemon/routes/context.ts`

One new field on `RequestContext`:

```diff
 export interface RequestContext {
   ...
   apiHost: string;
   apiPortRef: { value: number };
+  routePlugins: RoutePlugin[];
   url: URL;
   ...
 }
+import type { RoutePlugin } from '../plugin-api.js';
```

#### `packages/cli/src/daemon/lifecycle.ts`

Call `loadRoutePlugins` once during startup, after agent/publisher init and
before `server.listen()`. Pass the loaded array into `handleRequest`.

```diff
+import { loadRoutePlugins } from './plugin-loader.js';
+
 // ... after agent + publisher init, before server.listen() ...
+const routePlugins = await loadRoutePlugins(config.routePlugins ?? [], logger);
+logger.info(
+  { loaded: routePlugins.length, configured: config.routePlugins?.length ?? 0 },
+  'route-plugins-loaded',
+);

 // inside the request handler:
 await handleRequest(
   req, res, agent, publisherControl, publisherRuntime, config,
   startedAt, dashDb, opWallets, network, tracker, memoryManager,
   bridgeAuthToken, nodeVersion, nodeCommit, catchupTracker,
   extractionRegistry, fileStore, extractionStatus,
   assertionImportLocks, vectorStore, embeddingProvider,
   validTokens, apiHost, apiPortRef,
+  routePlugins,
   emitMemoryGraphChanged,
 );
```

#### `packages/cli/src/config.ts`

One new optional field on `DkgConfig`:

```diff
 export interface DkgConfig {
   ...
+  /** Route plugin specs — npm package names or absolute paths. Loaded at startup. */
+  routePlugins?: string[];
 }
```

#### `packages/cli/package.json`

Add an `exports` field with the new public subpath. The package currently has
no `exports` field (only a `bin` entry); workspace-internal grep confirms
nothing else imports from `@origintrail-official/dkg` today, so adding
`exports` is safe.

```diff
 {
   "name": "@origintrail-official/dkg",
   "bin": {
     "dkg": "./dist/cli.js"
   },
+  "exports": {
+    "./package.json": "./package.json",
+    "./daemon/plugin-api": {
+      "types": "./dist/daemon/plugin-api.d.ts",
+      "import": "./dist/daemon/plugin-api.js"
+    }
+  }
 }
```

## Request lifecycle

```
HTTP request
  → CORS preflight (lifecycle.ts)
  → httpAuthGuard()              ← single global auth gate
  → handleNodeUIRequest()        ← Node UI static + dashboard
  → handleRequest()
     → handleStatusRoutes(ctx)
     → handleAgentChatRoutes(ctx)
     → ... (10 more built-in chain steps)
     → handleEpcisRoutes(ctx)
     → handlePcaRoutes(ctx)
     → handlePluginRoutes(ctx)   ← NEW: iterates ctx.routePlugins
     → 404
```

By the time a request reaches a plugin's `handle()`, auth has already passed.
A plugin reads `ctx.requestAgentAddress` or `ctx.requestToken` for any
finer-grained policy decisions — same access every existing route group has.

## Startup lifecycle

```
daemon boot
  → loadConfig()                 ← reads ~/.dkg/config.json (operator state)
  → init agent, publisher, dashDb, ...
  → loadRoutePlugins(config.routePlugins ?? [], logger)   ← NEW
    → for each spec:
        → resolve via createRequire / absolute path
        → await import(resolved)
        → validate { name, handle } shape
        → on any error: log + skip
  → emit "route-plugins-loaded" with counts
  → server.listen()
```

## Failure modes

| Failure | Behaviour | Operator signal |
|---|---|---|
| Plugin package not found / resolve fails | Log + skip; daemon continues | `route-plugin-load-failed` log entry |
| Plugin import throws (syntax error, bad code) | Log + skip | same |
| Plugin missing `name` or `handle` | Log + skip | same |
| Plugin throws at request time | Catch; if response not started, emit 500 `{ error: 'PluginError', plugin, message }`; chain stops | Per-request `route-plugin-error` log + 500 response |
| Two plugins claim the same path | First plugin in config-list order wins (chain semantics: `res.writableEnded` short-circuits) | No detection; document |
| Plugin tries to read body twice | Plugin's problem; `readBody()` is one-shot. Document. | — |

Daemon never crashes on a plugin error. Startup logs total loaded vs configured.

## Configuration

User edits `~/.dkg/config.json` (the daemon's operator-state file, separate
from the npm-shipped package — survives upgrades):

```jsonc
{
  // ... existing config fields ...
  "routePlugins": [
    "@kamstrup/dkg-routes",
    "@jpb/dkg-domain-routes",
    "/abs/path/to/local-plugin/dist/index.js"
  ]
}
```

Resolution rules:

- An absolute path is loaded directly via `import(spec)`.
- Any other string is resolved with `createRequire(import.meta.url).resolve(spec)`,
  then imported.

A fork that wants its plugins available globally typically installs them
alongside the CLI: `npm install -g @origintrail-official/dkg @kamstrup/dkg-routes`,
then adds the package to `routePlugins`. A fork shipping a turnkey appliance
bundles plugins as regular deps in its own forked CLI distribution and
pre-seeds the config on first boot.

## How a fork builds a plugin

Plugin author's repo (separate from the base monorepo):

```ts
// @kamstrup/dkg-routes/src/index.ts
import type { RoutePlugin } from '@origintrail-official/dkg-cli/daemon/plugin-api';
import { jsonResponse, readBody } from '@origintrail-official/dkg-cli/daemon/plugin-api';

const plugin: RoutePlugin = {
  name: 'kamstrup-kafka-stream',
  async handle(ctx) {
    if (ctx.req.method === 'POST' && ctx.path === '/api/kamstrup/streams') {
      const body = await readBody(ctx.req);
      // ... domain logic using ctx.agent, ctx.publisherControl, ctx.config ...
      return jsonResponse(ctx.res, 200, { ok: true });
    }
    // No match — return without writing. Next plugin (or 404) gets a turn.
  },
};

export default plugin;
```

`package.json`:

```jsonc
{
  "name": "@kamstrup/dkg-routes",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "peerDependencies": {
    "@origintrail-official/dkg": "^10"
  }
}
```

`peerDependencies` because the type imports come from the CLI package; the
plugin doesn't bundle its own copy.

## Testing

### Unit — `packages/cli/test/daemon/plugin-loader.test.ts`

Vitest. Constructs a fake `Logger`, feeds the loader various spec lists:

- One absolute-path fixture pointing at a built sample plugin → returns 1
  plugin with the expected `name`.
- Non-existent package name → returns 0; `logger.warn` called with the spec
  and `route-plugin-load-failed`.
- Fixture that exports an object missing `handle` → returns 0; `logger.warn`
  called.
- Mixed list (one valid + one broken) → returns 1; one warn logged.
- Empty list → returns 0; no warns.

The fixture plugin lives at `packages/cli/test-fixtures/sample-route-plugin/`
as a pre-built JS module (no TS compile step in tests).

### Integration — `packages/cli/test/daemon/plugin-routes-api.e2e.test.ts`

Pattern from `packages/epcis/test/epcis-api.e2e.test.ts`. Spin a live daemon
with a temporary config containing
`routePlugins: ['<repo>/packages/cli/test-fixtures/sample-route-plugin/dist/index.js']`.

- `POST /api/sample-fixture/echo` with `{x:1}` → 200 with `{x:1}` echoed back.
- Built-in routes still work: `GET /api/status` → 200 (regression check).
- Spec pointing at a plugin that throws → 500 with
  `{ error: 'PluginError', plugin: 'sample-fixture-broken' }`. Daemon
  still answers subsequent requests (no crash).
- Plugin path that doesn't exist → daemon still starts; `GET /api/status` 200.

### Test fixture — `packages/cli/test-fixtures/sample-route-plugin/`

A tiny package with `dist/index.js` exporting two plugins (echo + throwing)
for the e2e tests to point at. Pre-built JS, no build step in CI.

## Future work (out of scope for slice 1)

- **NPM provenance verification.** Reuse
  `packages/cli/src/integrations/verify-npm-provenance.ts` once `routePlugins`
  config grows to support an object form with `{ package, version, expectedRepo }`.
  The config field can be widened from `string[]` to
  `(string | { package: string; ... })[]` without breaking existing configs.
- **Conflict detection at startup.** Would require plugins to declare a path
  manifest. Today they decide at runtime, so the loader has nothing to scan.
- **Hot reload.** Restart-required for now.
- **Test harness for plugin authors.** A `createMockRequestContext()` helper
  would help plugin authors unit-test their handlers without spinning up the
  daemon. Useful once a couple of forks have written plugins and we see the
  shared boilerplate.
- **EPCIS migration.** Once a code change in `routes/epcis.ts` is needed,
  consider extracting `handleEpcisRoutes` into a published plugin package
  (`@origintrail-official/dkg-routes-epcis`) and dropping the hard-coded
  chain step. Pure cleanup, no behaviour change.
