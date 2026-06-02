import { type Page } from '@playwright/test';
import { test, expect } from '../fixtures/base.js';
import { sel } from '../helpers/selectors.js';

/**
 * Peer connectivity against the real multi-node devnet.
 *
 * Topology (scripts/devnet.sh): node1 is the relay HUB and every other node is
 * booted with `relay = node1's multiaddr`, so each one dials node1. The UI talks
 * to node1, which therefore reports exactly N-1 connected peers. The suite boots
 * 3 nodes (playwright.config `PLAYWRIGHT_DEVNET_NUM_NODES` default), so node1
 * MUST show >= 2 connected peers — the degenerate "1 peer" reading means a peer
 * failed to dial or the relay broke, which is precisely the regression this spec
 * is here to catch.
 *
 * Counts are polled (not read once) to ride out libp2p dial timing on a cold
 * boot; on the persistent/reused devnet the mesh is already settled, so this is
 * effectively instant there.
 */
const MIN_PEERS = 2;

async function readStatus(page: Page): Promise<{
  connectedPeers?: number;
  connections?: { total?: number; direct?: number; relayed?: number };
} | null> {
  return page.evaluate(async () => {
    // Retry on transient 5xx — the daemon's own status poll behaves the same.
    for (let i = 0; i < 8; i++) {
      const r = await fetch('/api/status');
      if (r.ok) return r.json();
      await new Promise((res) => setTimeout(res, 500));
    }
    return null;
  });
}

function parsePeerCount(text: string | null): number {
  // No trailing `\b`: a container's textContent concatenates adjacent spans
  // (e.g. "2 peers2 direct / 0 relayed"), so "peers" is often immediately
  // followed by a digit — a word boundary there would never match.
  const m = (text ?? '').match(/(\d+)\s+peers?/);
  return m ? Number(m[1]) : -1;
}

test.describe('Peer connectivity (multi-node devnet)', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('node1 reports more than one connected peer (full devnet mesh)', async ({ page }) => {
    await expect
      .poll(
        async () => (await readStatus(page))?.connectedPeers ?? -1,
        { timeout: 30_000, message: 'connectedPeers never reached the expected devnet mesh size (>1)' },
      )
      .toBeGreaterThanOrEqual(MIN_PEERS);
  });

  test('the libp2p connection breakdown accounts for every connected peer', async ({ page }) => {
    await expect
      .poll(async () => (await readStatus(page))?.connectedPeers ?? -1, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(MIN_PEERS);

    const s = await readStatus(page);
    expect(s, '/api/status must return JSON').toBeTruthy();
    const peers = s!.connectedPeers ?? 0;
    const direct = s!.connections?.direct ?? 0;
    const relayed = s!.connections?.relayed ?? 0;
    const total = s!.connections?.total ?? 0;

    expect(peers).toBeGreaterThanOrEqual(MIN_PEERS);
    // A single peer can hold both a direct and a relayed link, so the link
    // counts sum to >= the unique-peer count, and total >= peers.
    expect(direct + relayed).toBeGreaterThanOrEqual(peers);
    expect(total).toBeGreaterThanOrEqual(peers);
  });

  test('the header renders the live peer count, and it is > 1', async ({ page }) => {
    // The header reads `connectedPeers` straight off /api/status, so its rendered
    // "N peers" must reach the same multi-peer value once the mesh settles.
    const meta = page.locator(sel.header.meta);
    await expect(meta).toBeVisible();
    await expect
      .poll(async () => parsePeerCount(await meta.textContent()), {
        timeout: 30_000,
        message: 'header peer count never rendered > 1',
      })
      .toBeGreaterThanOrEqual(MIN_PEERS);
  });

  test('the right-panel Network mode reflects the live multi-peer count', async ({ rightPanel, page }) => {
    // The Network summary's "N peers" stat carries a tooltip promising it
    // "matches the count in the header" — assert that contract holds against the
    // real mesh. Scope to that exact stat span so the assertion can't be fooled
    // by the adjacent "N direct / N relayed" figure.
    await rightPanel.switchMode('Network');
    const peerStat = page.locator(
      '.v10-agents-summary span[title*="Unique libp2p peers"]',
    );
    await expect(peerStat).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => parsePeerCount(await peerStat.textContent()), {
        timeout: 30_000,
        message: 'right-panel Network summary never showed > 1 peer',
      })
      .toBeGreaterThanOrEqual(MIN_PEERS);
  });
});
