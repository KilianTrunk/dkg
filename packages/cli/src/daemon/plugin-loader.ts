import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import type { RoutePlugin } from './plugin-api.js';

const require_ = createRequire(import.meta.url);

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
  try {
    return await import(spec);
  } catch (esmErr) {
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

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
