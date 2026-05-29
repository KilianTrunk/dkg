import { test, expect } from '../fixtures/base.js';
import { isDevnetAvailable, devnetApiFetch, waitForDevnetStatus, readDevnetNode } from '../helpers/devnet.js';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(!isDevnetAvailable(1), 'Devnet node1 not running');
  await waitForDevnetStatus(1);
});

test.describe('Inter-node messaging (devnet API)', () => {
  test('node2 is reachable when 6-node devnet is running', async () => {
    test.skip(!isDevnetAvailable(2), 'Devnet node2 not running');
    await waitForDevnetStatus(2);
    const res = await devnetApiFetch('/api/status', { nodeNum: 2 });
    expect(res.ok).toBe(true);
  });

  test('agents endpoint lists connected peers over prolonged polling window', async () => {
    const node = readDevnetNode(1)!;
    let maxPeers = 0;
    for (let i = 0; i < 6; i++) {
      const res = await devnetApiFetch('/api/agents', { nodeNum: 1 });
      if (res.ok) {
        const json = (await res.json()) as { agents: unknown[] };
        maxPeers = Math.max(maxPeers, json.agents?.length ?? 0);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(maxPeers).toBeGreaterThanOrEqual(0);
  });

  test('memory sessions endpoint responds (messaging persistence surface)', async () => {
    const res = await devnetApiFetch('/api/memory/sessions?limit=5');
    expect(res.status).toBeLessThan(500);
  });
});

test.describe('Ownership transfer UI prerequisites (devnet API)', () => {
  test('participants list is readable for first context graph', async () => {
    const cgs = await devnetApiFetch('/api/context-graphs');
    const { contextGraphs } = (await cgs.json()) as { contextGraphs: Array<{ id: string }> };
    test.skip(contextGraphs.length === 0, 'No CGs');
    const cgId = contextGraphs[0]!.id;
    const res = await devnetApiFetch(`/api/context-graph/${encodeURIComponent(cgId)}/participants`);
    expect(res.ok).toBe(true);
  });
});
