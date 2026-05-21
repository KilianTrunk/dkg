import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import type { RoutePlugin } from './plugin-api.js';

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
  specs: readonly string[],
  log: Logger,
): Promise<RoutePlugin[]> {
  const out: RoutePlugin[] = [];
  const ctx = createOperationContext('system');
  for (const spec of specs) {
    try {
      // Bare package names go through Node's ESM resolver (which honours
      // both `import` and `require` conditions in the package's `exports`
      // map). Using `require.resolve` here would refuse to resolve any
      // package that only declares an `import` condition — common in
      // ESM-first packages — and silently fail the load.
      const target = isAbsolute(spec) ? pathToFileURL(spec).href : spec;
      const mod = await import(target);
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
