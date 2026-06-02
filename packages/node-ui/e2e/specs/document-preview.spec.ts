import { test, expect } from '../fixtures/rich.js';
import { PRIMARY_CG } from '../helpers/real-node.js';

test.describe('Document preview', () => {
  test.beforeEach(async ({ shell, leftPanel, page }) => {
    await shell.goto();
    await leftPanel.expandProject(PRIMARY_CG);
    await page.locator('[data-layer="wm"]').click();
    await page.locator('.v10-layer-expand-tab').filter({ hasText: 'Documents' }).click();
  });

  test('Documents tab is reachable on WM layer', async ({ page }) => {
    await expect(page.locator('.v10-layer-expand-tab.active').filter({ hasText: 'Documents' })).toBeVisible();
  });

  test('Documents tab shows empty state without error when no docs seeded', async ({ page }) => {
    // The seeded entities are RDF triples, not uploaded documents, so the
    // Documents tab is genuinely empty on a fresh devnet CG.
    await expect(page.locator('.v10-me-error')).toBeHidden();
    await expect(page.getByText(/No documents in this layer yet/i)).toBeVisible();
  });
});
