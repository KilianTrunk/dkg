import { test, expect } from '../../fixtures/base.js';
import { isDevnetAvailable, devnetApiFetch, waitForDevnetStatus } from '../../helpers/devnet.js';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(!isDevnetAvailable(1), 'Devnet node1 not running');
  await waitForDevnetStatus(1);
});

test.describe('MCP server tools (devnet API smoke)', () => {
  test('daemon status endpoint is healthy', async () => {
    const res = await devnetApiFetch('/api/status');
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { version?: string; identityId?: string };
    expect(json.version).toBeTruthy();
  });

  test('agent identity endpoint returns address', async () => {
    const res = await devnetApiFetch('/api/agent/identity');
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { agentAddress?: string };
    expect(json.agentAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  test('context graph list is non-empty on seeded devnet', async () => {
    const res = await devnetApiFetch('/api/context-graphs');
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { contextGraphs: unknown[] };
    expect(json.contextGraphs.length).toBeGreaterThan(0);
  });

  test('SPARQL query endpoint returns bindings for devnet CG', async () => {
    const cgs = await devnetApiFetch('/api/context-graphs');
    const { contextGraphs } = (await cgs.json()) as { contextGraphs: Array<{ id: string }> };
    test.skip(contextGraphs.length === 0, 'No CGs');
    const res = await devnetApiFetch('/api/query', {
      method: 'POST',
      body: JSON.stringify({
        sparql: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 1',
        contextGraphId: contextGraphs[0]!.id,
      }),
    });
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { result?: { bindings?: unknown[] } };
    expect(Array.isArray(json.result?.bindings)).toBe(true);
  });
});
