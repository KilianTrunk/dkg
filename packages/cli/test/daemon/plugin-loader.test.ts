import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
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

const ctx = createOperationContext('system');
void ctx;

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
});
