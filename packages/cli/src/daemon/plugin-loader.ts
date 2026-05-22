import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import type { RoutePlugin } from './plugin-api.js';

const require_ = createRequire(import.meta.url);

// Only retry CJS when ESM failed because no `import` condition matched; everything else (SyntaxError,
// missing transitive `ERR_MODULE_NOT_FOUND`, ...) bubbles up so authors see the broken build.
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
  // Reject relative specs — Node resolves them relative to this loader source
  // (packages/cli/dist/daemon/), not to ~/.dkg/config.json. See ADR 0001.
  // Separator-agnostic so Windows-style `.\foo`, `..\foo` are also caught.
  if (/^\.{1,2}[\\/]/.test(spec)) {
    throw new Error(
      `relative paths are not supported in routePlugins; use an absolute filesystem path or a resolvable package name (got "${spec}")`,
    );
  }
  // Bare specifier: ESM first (honours `import`/`default` conditions), then CJS resolve only on
  // resolver failure. Dynamic import of CJS yields { default: module.exports } for pickCandidate.
  try {
    return await import(spec);
  } catch (esmErr) {
    if (!isResolverFailure(esmErr)) throw esmErr;
    let resolved: string;
    try {
      resolved = require_.resolve(spec);
    } catch {
      throw esmErr;
    }
    // CJS resolve succeeded — any error from loading the resolved file is a real
    // evaluation failure (SyntaxError, missing transitive) and must bubble up, not be rewritten as esmErr.
    return await import(pathToFileURL(resolved).href);
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
  // `unknown` — caller passes raw JSON; we validate inside, fail-soft to [].
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

/** Spec count for `route-plugins-loaded` telemetry; non-arrays report 0 so malformed config isn't leaked. */
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
