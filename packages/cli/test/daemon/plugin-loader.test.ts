import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@origintrail-official/dkg-core';
import {
  loadRoutePlugins,
  countConfiguredPluginSpecs,
} from '../../src/daemon/plugin-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureAbs = resolve(
  __dirname,
  '../../test-fixtures/sample-route-plugin/dist/index.js',
);

function makeLogger() {
  const log = new Logger('test');
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  return { log, warn };
}

function writeTempEsm(filename: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-plugin-loader-'));
  const abs = join(dir, filename);
  writeFileSync(abs, source);
  return abs;
}

describe('countConfiguredPluginSpecs', () => {
  // Regression for codex PR review #593 (round 9): the startup log line
  // `route-plugins-loaded loaded=X configured=Y` was reading `Y` straight
  // from `config.routePlugins?.length`. For a malformed config (string,
  // object, ...) that produced misleading telemetry — e.g. an operator
  // typo `"routePlugins": "@foo/bar"` would log `configured=8` (string
  // length) rather than 0 (the count the loader actually validates). The
  // count must match the validation path: array → length, anything else → 0.

  it('returns the array length when given a proper array of specs', () => {
    expect(countConfiguredPluginSpecs(['@x/y', '/abs/path/plugin.js'])).toBe(2);
  });

  it('returns 0 for an empty array', () => {
    expect(countConfiguredPluginSpecs([])).toBe(0);
  });

  it('returns 0 for a string (operator forgot the brackets)', () => {
    expect(countConfiguredPluginSpecs('@my-fork/plugin')).toBe(0);
  });

  it('returns 0 for a plain object', () => {
    expect(countConfiguredPluginSpecs({ '0': '@my-fork/plugin' })).toBe(0);
  });

  it('returns 0 for null / undefined', () => {
    expect(countConfiguredPluginSpecs(null)).toBe(0);
    expect(countConfiguredPluginSpecs(undefined)).toBe(0);
  });

  it('returns 0 for a number', () => {
    expect(countConfiguredPluginSpecs(42)).toBe(0);
  });
});

describe('loadRoutePlugins', () => {
  it('returns empty array for empty input without warnings', async () => {
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins([], log);
    expect(plugins).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('loads a single plugin from an absolute-path spec (default export)', async () => {
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins([fixtureAbs], log);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('sample-fixture-echo');
    expect(typeof plugins[0].handle).toBe('function');
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips and warns on a non-existent package name', async () => {
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(['definitely-not-a-real-pkg-xyz'], log);
    expect(plugins).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const arg = String(warn.mock.calls[0][1]);
    expect(arg).toContain('route-plugin-load-failed');
    expect(arg).toContain('definitely-not-a-real-pkg-xyz');
  });

  it('skips and warns when the module shape is missing handle', async () => {
    const tempAbs = writeTempEsm(
      'no-handle.mjs',
      'export default { name: "no-handle" };',
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([tempAbs], log);
      expect(plugins).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][1])).toContain('route-plugin-load-failed');
    } finally {
      rmSync(dirname(tempAbs), { recursive: true, force: true });
    }
  });

  it('accepts a CommonJS module that exposes the plugin as a named `plugin` export', async () => {
    const tempAbs = writeTempEsm(
      'cjs-named.cjs',
      "module.exports.plugin = { name: 'cjs-named-plugin', handle() {} };",
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([tempAbs], log);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('cjs-named-plugin');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(dirname(tempAbs), { recursive: true, force: true });
    }
  });

  it('loads an ESM-only package referenced by bare name (exports.import only)', async () => {
    // Regression for codex PR review #593: the loader must support packages
    // whose package.json `exports` block declares only an `import` condition
    // (no `require`, no `default`). `require.resolve` throws
    // `ERR_PACKAGE_PATH_NOT_EXPORTED` for such packages because no CJS
    // condition matches; a direct `await import(spec)` honours the `import`
    // condition and succeeds.
    //
    // We install a tiny ESM-only fixture into the CLI package's node_modules
    // so that bare-name resolution from the loader's `import.meta.url` (a file
    // under `packages/cli/src/daemon/`) can find it via standard Node lookup.
    const pkgName = `@dkg-test/esm-only-fixture-${process.pid}-${Date.now()}`;
    const cliNodeModules = resolve(__dirname, '../../node_modules');
    const installDir = join(cliNodeModules, ...pkgName.split('/'));
    const parentDir = dirname(installDir);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, 'package.json'),
      JSON.stringify({
        name: pkgName,
        version: '0.0.0',
        type: 'module',
        exports: { '.': { import: './index.mjs' } },
      }),
    );
    writeFileSync(
      join(installDir, 'index.mjs'),
      "export default { name: 'esm-only-fixture-plugin', handle() {} };\n",
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([pkgName], log);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('esm-only-fixture-plugin');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('loads a CJS-only package referenced by bare name (exports.require only)', async () => {
    // Regression for codex PR review #593: the dual `import()` fix introduced
    // for ESM-only packages must not regress the inverse case — a package
    // whose `exports` map declares only a `require` condition (no `import`,
    // no `default`). Dynamic `import(spec)` runs in import-context and
    // refuses to match those, so the loader needs a CJS-resolve fallback
    // before declaring the spec dead.
    //
    // Fixture: a tiny CJS-only package installed into the CLI's
    // node_modules so bare-name resolution from the loader's
    // `import.meta.url` finds it via standard Node lookup.
    const pkgName = `@dkg-test/cjs-only-fixture-${process.pid}-${Date.now()}`;
    const cliNodeModules = resolve(__dirname, '../../node_modules');
    const installDir = join(cliNodeModules, ...pkgName.split('/'));
    const parentDir = dirname(installDir);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, 'package.json'),
      JSON.stringify({
        name: pkgName,
        version: '0.0.0',
        // No `"type": "module"` — defaults to CommonJS.
        exports: { '.': { require: './index.cjs' } },
      }),
    );
    writeFileSync(
      join(installDir, 'index.cjs'),
      "module.exports = { name: 'cjs-only-fixture-plugin', handle() {} };\n",
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([pkgName], log);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('cjs-only-fixture-plugin');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('returns [] and warns once when routePlugins is a non-array string value', async () => {
    // Regression for codex PR review #593: `config.routePlugins` is untyped
    // operator input (JSON edited by humans). A common typo is to forget the
    // brackets and write a single string. The loader must reject the wrong
    // shape with one warning instead of iterating string characters as
    // individual plugin specs.
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(
      // Intentionally wrong shape — bypass the typed signature in the test.
      '@my-fork/dkg-routes' as unknown as readonly string[],
      log,
    );
    expect(plugins).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][1]);
    expect(msg).toContain('route-plugins-invalid-config');
    expect(msg).toContain('string');
  });

  it('returns [] and warns once when routePlugins is a plain object', async () => {
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(
      { foo: '@my-fork/dkg-routes' } as unknown as readonly string[],
      log,
    );
    expect(plugins).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][1]);
    expect(msg).toContain('route-plugins-invalid-config');
  });

  it('returns [] silently when routePlugins is undefined or null', async () => {
    const { log: log1, warn: warn1 } = makeLogger();
    const plugins1 = await loadRoutePlugins(
      undefined as unknown as readonly string[],
      log1,
    );
    expect(plugins1).toEqual([]);
    expect(warn1).not.toHaveBeenCalled();

    const { log: log2, warn: warn2 } = makeLogger();
    const plugins2 = await loadRoutePlugins(
      null as unknown as readonly string[],
      log2,
    );
    expect(plugins2).toEqual([]);
    expect(warn2).not.toHaveBeenCalled();
  });

  it('filters non-string entries from a partially-malformed array, warning per bad entry', async () => {
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(
      [fixtureAbs, 42, null, '', { not: 'a string' }] as unknown as readonly string[],
      log,
    );
    // Only the valid absolute path should resolve to a plugin.
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('sample-fixture-echo');
    // One warn per non-string entry: 42, null, '' (empty), object → 4 warns.
    expect(warn).toHaveBeenCalledTimes(4);
    for (const [, msg] of warn.mock.calls) {
      expect(String(msg)).toContain('route-plugins-invalid-spec');
    }
  });

  it('rejects a relative-path spec (./foo) instead of resolving it from the loader source dir', async () => {
    // Regression for codex PR review #593 (round 8): the README promises
    // that relative paths in routePlugins config "are not resolved against
    // ~/.dkg and will fail to load". But Node's dynamic import resolves
    // ./foo relative to the IMPORTING module (the loader source file),
    // not relative to ~/.dkg/. That could silently load an unrelated
    // daemon module that happens to live next to the loader. The loader
    // must reject relative specs explicitly with a clear log.
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(['./not-a-real-plugin.js'], log);
    expect(plugins).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][1]);
    expect(msg).toContain('route-plugin-load-failed');
    expect(msg.toLowerCase()).toContain('relative');
  });

  it('rejects a parent-relative path spec (../foo)', async () => {
    // `../config.js` actually resolves to `packages/cli/dist/config.js` —
    // a real daemon module that just happens to live up one directory from
    // the loader. Without an explicit rejection, the loader would import
    // an internal daemon module as a plugin candidate.
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(['../config.js'], log);
    expect(plugins).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][1]);
    expect(msg.toLowerCase()).toContain('relative');
  });

  it('keeps the valid plugin and warns on the broken one in a mixed list', async () => {
    const { log, warn } = makeLogger();
    const plugins = await loadRoutePlugins(
      [fixtureAbs, 'definitely-not-a-real-pkg-xyz'],
      log,
    );
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('sample-fixture-echo');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not silently fall back to CJS when the ESM entry has a syntax error', async () => {
    // Regression for codex PR review #593 round 12: a dual-published
    // package whose `exports.import` points at a broken ESM file (e.g.
    // a syntax error escaped a build) used to silently load via the
    // CJS `exports.require` path, hiding the broken publish from the
    // plugin author. The fallback must fire only on
    // "no ESM condition matched" failures
    // (`ERR_PACKAGE_PATH_NOT_EXPORTED` + the Vite-resolver equivalents);
    // real evaluation errors in the ESM must bubble up so operators see
    // them.
    const pkgName = `@dkg-test/broken-esm-fixture-${process.pid}-${Date.now()}`;
    const cliNodeModules = resolve(__dirname, '../../node_modules');
    const installDir = join(cliNodeModules, ...pkgName.split('/'));
    const parentDir = dirname(installDir);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, 'package.json'),
      JSON.stringify({
        name: pkgName,
        version: '0.0.0',
        type: 'module',
        exports: { '.': { import: './index.mjs', require: './index.cjs' } },
      }),
    );
    // Broken ESM: stray `{{` causes a SyntaxError during parse.
    writeFileSync(
      join(installDir, 'index.mjs'),
      "export default { name: 'broken-esm-plugin', handle() {{} };\n",
    );
    // Valid CJS — would silently rescue the load before the fix.
    writeFileSync(
      join(installDir, 'index.cjs'),
      "module.exports = { name: 'broken-esm-plugin', handle() {} };\n",
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([pkgName], log);
      expect(plugins).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0][1]);
      expect(msg).toContain('route-plugin-load-failed');
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it('does not silently fall back to CJS when the ESM entry is missing an internal import', async () => {
    // Regression for codex PR review #593 round 13: Node throws
    // `ERR_MODULE_NOT_FOUND` for two distinct situations:
    // (a) the configured plugin spec does not resolve to any package
    //     ("@scope/pkg" is not installed);
    // (b) the ESM entry resolves and starts loading, but one of its
    //     own internal imports — a relative file, a transitive package
    //     — cannot be found.
    // Falling back to CJS on (b) silently rescues a broken ESM build by
    // running the CJS twin instead, leaving the plugin author unaware
    // their ESM is missing a dependency. The loader must surface (b)
    // unchanged so it shows up in `route-plugin-load-failed`.
    const pkgName = `@dkg-test/missing-import-fixture-${process.pid}-${Date.now()}`;
    const cliNodeModules = resolve(__dirname, '../../node_modules');
    const installDir = join(cliNodeModules, ...pkgName.split('/'));
    const parentDir = dirname(installDir);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, 'package.json'),
      JSON.stringify({
        name: pkgName,
        version: '0.0.0',
        type: 'module',
        exports: { '.': { import: './index.mjs', require: './index.cjs' } },
      }),
    );
    // ESM entry imports a sibling file that does not exist on disk.
    // Node raises `ERR_MODULE_NOT_FOUND` when loading this module.
    writeFileSync(
      join(installDir, 'index.mjs'),
      "import helper from './missing-helper.mjs';\nexport default { name: 'missing-import-plugin', handle: helper };\n",
    );
    // Valid CJS — would silently rescue the load before the fix.
    writeFileSync(
      join(installDir, 'index.cjs'),
      "module.exports = { name: 'missing-import-plugin', handle() {} };\n",
    );
    try {
      const { log, warn } = makeLogger();
      const plugins = await loadRoutePlugins([pkgName], log);
      expect(plugins).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0][1]);
      expect(msg).toContain('route-plugin-load-failed');
      // The original "module not found" diagnostic should reach the
      // operator. We don't pin the exact phrasing (Node vs Vite differ)
      // but the missing file's basename is the recognizable handle.
      expect(msg).toContain('missing-helper');
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });
});
