import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import type { RoutePlugin } from './plugin-api.js';

const require_ = createRequire(import.meta.url);

// Detect "the ESM resolver could not pick an entry for this spec"
// (the package exists but its `exports` map matched no `import`/`default`
// condition) vs "the ESM loaded and then failed". Only the first case
// is safe to retry via CJS; everything else — a `SyntaxError` in the
// ESM source, a top-level evaluation crash, a rejected top-level
// `await`, OR an `ERR_MODULE_NOT_FOUND` raised from inside the loaded
// ESM because one of its own imports is missing — must bubble up so
// the plugin author and the operator who installed the package see the
// broken build instead of being silently rescued by a CJS twin (Codex
// PR #593 round 13).
//
// Production Node sets `err.code` to `ERR_PACKAGE_PATH_NOT_EXPORTED`
// for the "no condition matched" case. Vitest's Vite-based resolver
// wraps the underlying failure and strips the typed code, emitting
// untyped errors whose message contains a recognizable phrase ("No
// known conditions for…", `No "exports" main defined`, "Failed to
// resolve entry for package"). We deliberately do NOT match on the
// broader `ERR_MODULE_NOT_FOUND` / "Cannot find package" — those are
// ambiguous with "the ESM tried to import a transitive that wasn't
// installed", which is a real failure we want to surface, not rescue.
const RESOLVER_FAILURE_CODES = new Set([
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
]);
const RESOLVER_FAILURE_MESSAGE_PATTERNS = [
  /No known conditions for/i,
  /No "exports" main defined/i,
  /Failed to resolve entry for package/i,
];
function isResolverFailure(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && RESOLVER_FAILURE_CODES.has(code)) return true;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== 'string') return false;
  return RESOLVER_FAILURE_MESSAGE_PATTERNS.some((p) => p.test(message));
}

async function importSpec(spec: string): Promise<unknown> {
  if (isAbsolute(spec)) {
    return import(pathToFileURL(spec).href);
  }
  // Reject relative specs ('./foo', '../foo'). The README promises that
  // relative paths fail to load. Without this guard, Node's dynamic
  // import would resolve them relative to THIS loader's source file
  // (packages/cli/dist/daemon/plugin-loader.js), not relative to the
  // operator's ~/.dkg/config.json. That could silently import an
  // unrelated daemon module — e.g. `../config.js` resolves to the real
  // daemon config module — and pass it to pickCandidate as if it were a
  // plugin. Force operators onto absolute paths or bare package names.
  if (spec.startsWith('./') || spec.startsWith('../')) {
    throw new Error(
      `relative paths are not supported in routePlugins; use an absolute filesystem path or a resolvable package name (got "${spec}")`,
    );
  }
  // Bare specifier: try Node's ESM resolver first (honours `import` and
  // `default` exports conditions). If that fails — e.g. for a CJS-only
  // package whose `exports` map declares only a `require` condition —
  // fall back to CJS resolution and re-import the resolved file URL.
  // Node's dynamic `import()` of a CJS file gives us
  // `{ default: module.exports }`, which `pickCandidate` handles.
  //
  // Codex PR #593 review round 12: the fallback fires ONLY for typed
  // resolver errors (`ERR_PACKAGE_PATH_NOT_EXPORTED` =
  // exports map matched no `import` condition; `ERR_MODULE_NOT_FOUND` =
  // the spec did not resolve to anything Node can find). Any other
  // failure — `SyntaxError` in the ESM source, `ReferenceError` during
  // top-level evaluation, a rejected top-level `await` — bubbles up so
  // the plugin author (and the operator who installed the package)
  // actually see the broken ESM build instead of having the loader
  // silently rescue them with the CJS path.
  try {
    return await import(spec);
  } catch (esmErr) {
    if (!isResolverFailure(esmErr)) throw esmErr;
    try {
      const resolved = require_.resolve(spec);
      return await import(pathToFileURL(resolved).href);
    } catch {
      throw esmErr;
    }
  }
}

function isRoutePlugin(value: unknown): value is RoutePlugin {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && v.name.length > 0 && typeof v.handle === 'function';
}

function pickCandidate(mod: unknown): unknown {
  if (mod && typeof mod === 'object') {
    const m = mod as Record<string, unknown>;
    if (isRoutePlugin(m.plugin)) return m.plugin;
    if (isRoutePlugin(m.default)) return m.default;
    if (m.default !== undefined) return m.default;
    if (m.plugin !== undefined) return m.plugin;
  }
  return mod;
}

export async function loadRoutePlugins(
  // `unknown` (not `readonly string[]`) because the caller passes raw
  // operator config from a JSON file. A typo there must not crash the
  // daemon — we validate shape inside and fall back to [] on anything
  // that isn't a clean string array.
  specs: unknown,
  log: Logger,
): Promise<RoutePlugin[]> {
  const out: RoutePlugin[] = [];
  const ctx = createOperationContext('system');

  if (specs === undefined || specs === null) return out;
  if (!Array.isArray(specs)) {
    log.warn(
      ctx,
      `route-plugins-invalid-config: expected an array of plugin spec strings, got ${typeof specs}; ignoring`,
    );
    return out;
  }

  for (const rawSpec of specs as readonly unknown[]) {
    if (typeof rawSpec !== 'string' || rawSpec.length === 0) {
      log.warn(
        ctx,
        `route-plugins-invalid-spec: ignoring non-string entry: ${safeStringify(rawSpec)}`,
      );
      continue;
    }
    const spec = rawSpec;
    try {
      const mod = await importSpec(spec);
      const candidate = pickCandidate(mod);
      if (!isRoutePlugin(candidate)) {
        log.warn(ctx, `route-plugin-load-failed: ${spec}: invalid shape`);
        continue;
      }
      out.push(candidate);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(ctx, `route-plugin-load-failed: ${spec}: ${msg}`);
    }
  }
  return out;
}

/**
 * Count plugin specs the way the validation path in `loadRoutePlugins`
 * sees them. Use this for startup telemetry (the `route-plugins-loaded`
 * log line) so that a malformed config (string, object, ...) reports
 * `configured=0` instead of leaking the raw `.length` of whatever
 * `config.routePlugins` happened to be. Arrays return their length —
 * the individual element validation still happens inside the loader and
 * can drop entries.
 */
export function countConfiguredPluginSpecs(raw: unknown): number {
  return Array.isArray(raw) ? raw.length : 0;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
