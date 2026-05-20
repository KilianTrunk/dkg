import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@origintrail-official/dkg-core';
import { loadRoutePlugins } from '../../src/daemon/plugin-loader.js';

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
});
