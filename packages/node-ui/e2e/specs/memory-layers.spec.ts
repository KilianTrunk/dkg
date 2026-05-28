import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base.js';

// rc11 layer-view rewrite:
//   * Memory layers no longer open as standalone centre-panel tabs.
//     Each context graph has a single tab; the WM / SWM / VM /
//     Subgraphs / Overview switch is rendered as the LayerSwitcher
//     INSIDE the project view (`button[aria-label="Working Memory"]`,
//     etc.).
//   * The legacy `MemoryLayerView` (SPARQL bar + Run + Table/Graph
//     toggle + `.v10-mlv-*` classes) was replaced by the
//     LAYER_CONFIG-driven layer-detail surface in
//     `src/ui/views/project/components.tsx`. The new surface wraps
//     the layer in `.v10-layer-detail` with a header (icon / title /
//     `Private agent scratchpad — ephemeral, fast local storage`
//     description) and a sub-tab strip (Entities / Assertions / Graph
//     / Documents — Assertions hidden on VM).
//   * The VM tab keeps its `.v10-vm-search-panel` structured search
//     affordance, but the raw SPARQL bar is now reached through the
//     LayerSwitcher's "More → Query Catalogue" entry, which is exercised
//     in operations.spec.ts.
//
// "Memory Stack" was removed in PR8 — the entire describe block is
// gone. A single regression guard ensures the `.v10-tree-dashboard`
// row labelled "Memory Stack" doesn't reappear in the sidebar.

async function discoverProjectName(leftPanel: any): Promise<string> {
  await expect(async () => {
    const names = await leftPanel.getProjectNames();
    expect(names.length).toBeGreaterThan(0);
  }).toPass({ timeout: 12_000, intervals: [250, 500, 1000] });
  const names = await leftPanel.getProjectNames();
  return names[0]!;
}

async function openProjectTab(page: Page, name: string) {
  await page
    .locator('.v10-panel-left')
    .first()
    .locator('.v10-tree-section-header')
    .filter({ hasText: name })
    .first()
    .click();
}

async function openLayer(
  page: Page,
  layer: 'Working Memory' | 'Shared Working Memory' | 'Verifiable Memory',
) {
  const btn = page.locator(`button[aria-label="${layer}"]`).first();
  await expect(btn).toBeVisible({ timeout: 10_000 });
  await btn.click();
  await expect(
    page.locator('.v10-layer-detail-title').filter({ hasText: layer }),
  ).toBeVisible({ timeout: 10_000 });
}

test.describe('Memory Layer Views', () => {
  test.describe('Working Memory', () => {
    test.beforeEach(async ({ shell, leftPanel, page }) => {
      await shell.goto();
      const project = await discoverProjectName(leftPanel);
      await openProjectTab(page, project);
      await openLayer(page, 'Working Memory');
    });

    test('renders the WM detail header with icon + title + desc', async ({ page }) => {
      const header = page.locator('.v10-layer-detail-header');
      await expect(header).toBeVisible();
      await expect(header.locator('.v10-layer-detail-icon')).toHaveText('◇');
      await expect(header.locator('.v10-layer-detail-title')).toHaveText('Working Memory');
      const desc = (await header.locator('.v10-layer-detail-desc').textContent()) ?? '';
      expect(desc.toLowerCase()).toContain('private agent scratchpad');
    });

    test('exposes the WM sub-tab strip (Entities / Assertions / Graph / Documents)', async ({ page }) => {
      const tabs = page.locator('.v10-layer-expand-tab');
      const labels = await tabs.allTextContents();
      const normalised = labels.map((t) => t.trim().toLowerCase());
      // The Entities tab uses a layer-specific label via `layerNoun`
      // ("entities"/"working entities") so we only assert it starts
      // with "entit", and pin the other three.
      expect(normalised.length).toBe(4);
      expect(normalised[0]).toMatch(/entit/);
      expect(normalised.slice(1)).toEqual(['assertions', 'graph', 'documents']);
    });

    test('Entities sub-tab is the default active tab for WM', async ({ page }) => {
      const active = page.locator('.v10-layer-expand-tab.active');
      await expect(active).toHaveCount(1);
      const text = ((await active.textContent()) ?? '').toLowerCase();
      expect(text).toMatch(/entit/);
    });

    test('seeded empty WM surfaces the "No entities yet" empty state', async ({ page }) => {
      // Empty seeded CG → the LayerWidgetStrip + EntityList both render
      // empty-state cards. We only assert on the cross-cutting copy
      // ("No entities yet") which both surfaces share.
      const emptyCards = page.locator('.v10-layer-detail').getByText(/No entities yet/i);
      await expect(emptyCards.first()).toBeVisible({ timeout: 8_000 });
    });

    test('WM empty state surfaces the "Import data or chat" hint', async ({ page }) => {
      await expect(page.getByText(/Import data or chat with agents/i)).toBeVisible();
    });

    test('clicking the Graph sub-tab activates the graph body', async ({ page }) => {
      const graphTab = page.locator('.v10-layer-expand-tab').filter({ hasText: /^Graph$/ });
      await graphTab.click();
      await expect(graphTab).toHaveClass(/active/);
      // The graph body renders inside `v10-layer-expand-body.full-width`
      // (LayerGraphPanel). On an empty CG it shows a placeholder; we
      // assert the container, not the specific empty-state copy.
      await expect(page.locator('.v10-layer-expand-body.full-width')).toBeVisible();
    });

    test('clicking the Documents sub-tab activates the documents body', async ({ page }) => {
      const docsTab = page.locator('.v10-layer-expand-tab').filter({ hasText: /^Documents$/ });
      await docsTab.click();
      await expect(docsTab).toHaveClass(/active/);
      await expect(page.locator('.v10-layer-expand-body.full-width')).toBeVisible();
    });

    test('layer icon renders the WM glyph (◇)', async ({ page }) => {
      await expect(page.locator('.v10-layer-detail-icon').first()).toHaveText('◇');
    });
  });

  test.describe('Shared Working Memory', () => {
    test.beforeEach(async ({ shell, leftPanel, page }) => {
      await shell.goto();
      const project = await discoverProjectName(leftPanel);
      await openProjectTab(page, project);
      await openLayer(page, 'Shared Working Memory');
    });

    test('renders the SWM detail header', async ({ page }) => {
      await expect(page.locator('.v10-layer-detail-icon').first()).toHaveText('◈');
      await expect(page.locator('.v10-layer-detail-title')).toHaveText('Shared Working Memory');
    });

    test('SWM keeps the Assertions sub-tab', async ({ page }) => {
      // Unlike VM, SWM still surfaces an Assertions promotion path.
      const assertionsTab = page.locator('.v10-layer-expand-tab').filter({ hasText: /^Assertions$/ });
      await expect(assertionsTab).toBeVisible();
    });

    test('SWM exposes Entities / Assertions / Graph / Documents sub-tabs', async ({ page }) => {
      const tabs = page.locator('.v10-layer-expand-tab');
      await expect(tabs).toHaveCount(4);
    });
  });

  test.describe('Verifiable Memory', () => {
    test.beforeEach(async ({ shell, leftPanel, page }) => {
      await shell.goto();
      const project = await discoverProjectName(leftPanel);
      await openProjectTab(page, project);
      await openLayer(page, 'Verifiable Memory');
    });

    test('renders the VM detail header', async ({ page }) => {
      await expect(page.locator('.v10-layer-detail-icon').first()).toHaveText('◉');
      await expect(page.locator('.v10-layer-detail-title')).toHaveText('Verifiable Memory');
    });

    test('VM hides the Assertions sub-tab and shows three tabs', async ({ page }) => {
      const tabs = page.locator('.v10-layer-expand-tab');
      await expect(tabs).toHaveCount(3);
      const labels = (await tabs.allTextContents()).map((t) => t.trim().toLowerCase());
      expect(labels).not.toContain('assertions');
    });

    test('empty VM renders the "Nothing published yet" hero', async ({ page }) => {
      // The VM hero either shows the empty-state hero OR the loading
      // spinner; both surface inside `.v10-layer-detail`.
      const hero = page.locator('.v10-vm-hero, .v10-layer-widgets-strip.empty');
      await expect(hero.first()).toBeVisible({ timeout: 12_000 });
    });
  });

  test.describe('Layer regression guards', () => {
    test('the legacy "Memory Stack" sidebar row stays removed', async ({ page, shell }) => {
      await shell.goto();
      const stackRow = page
        .locator('.v10-panel-left .v10-tree-dashboard')
        .filter({ hasText: 'Memory Stack' });
      await expect(stackRow).toHaveCount(0);
    });

    test('memory layers do NOT open as separate centre-panel tabs', async ({ shell, leftPanel, centerPanel, page }) => {
      await shell.goto();
      const project = await discoverProjectName(leftPanel);
      await openProjectTab(page, project);
      const before = await centerPanel.getTabCount();
      await openLayer(page, 'Working Memory');
      await openLayer(page, 'Shared Working Memory');
      await openLayer(page, 'Verifiable Memory');
      const after = await centerPanel.getTabCount();
      expect(after).toBe(before);
    });

    test('the legacy `.v10-mlv-*` SPARQL bar is no longer the default surface', async ({ shell, leftPanel, page }) => {
      // Default WM/SWM view should NOT render the legacy MemoryLayerView
      // chrome (`.v10-mlv-query-input` / `.v10-mlv-run-btn`); those have
      // moved behind "More → Query Catalogue" in the LayerSwitcher.
      await shell.goto();
      const project = await discoverProjectName(leftPanel);
      await openProjectTab(page, project);
      await openLayer(page, 'Working Memory');
      await expect(page.locator('.v10-mlv-query-input')).toHaveCount(0);
      await expect(page.locator('.v10-mlv-run-btn')).toHaveCount(0);
    });
  });
});
