import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base.js';

// rc11 project view (`ProjectView` + `ProjectOverviewCard`):
//   * The legacy `MemoryExplorer`-based view (`<h1>` project name +
//     "↑ Import" header button + "No knowledge yet" hexagon empty
//     state) was replaced. The new Overview is rendered as
//     `.v10-po` and is composed of the Knowledge Pipeline cards,
//     "At a glance" stat strip, Participant agents, Pending join
//     requests (curator-only), and a Recent activity feed.
//   * Project name lives in the persistent `ProjectHeaderStrip` (top
//     of the project tab, before the LayerSwitcher) instead of an
//     `<h1>`. The layer-action buttons (Share / Import / Refresh) are
//     `aria-label`-ed icon buttons inside the LayerSwitcher.
//   * Demo project fixtures (`Pharma Drug Interactions`, …) are gone;
//     the spec discovers the first seeded CG and drives every test
//     against it.

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
  // Wait for ProjectOverviewCard to settle.
  await expect(page.locator('.v10-po')).toBeVisible({ timeout: 10_000 });
}

test.describe('Project View', () => {
  let projectName: string;

  test.beforeEach(async ({ shell, leftPanel, page }) => {
    await shell.goto();
    projectName = await discoverProjectName(leftPanel);
    await openProjectTab(page, projectName);
  });

  test('opens a tab labelled with the context-graph name', async ({ centerPanel }) => {
    const tabs = await centerPanel.getTabNames();
    expect(tabs.some((t) => t.trim() === projectName)).toBe(true);
  });

  test('Overview is the default view (renders ProjectOverviewCard)', async ({ page }) => {
    await expect(page.locator('.v10-po')).toBeVisible();
    await expect(page.locator('.v10-po [data-section="identity"]')).toBeVisible();
    await expect(page.locator('.v10-po [data-section="at-a-glance"]')).toBeVisible();
    await expect(page.locator('.v10-po [data-section="pipeline"]')).toBeVisible();
  });

  test('LayerSwitcher exposes Share / Import / Refresh action buttons', async ({ page }) => {
    await expect(page.locator('button[aria-label="Share Context Graph"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Import into Context Graph"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Refresh Context Graph data"]')).toBeVisible();
  });

  test('Overview surfaces the identity row (role + access badges)', async ({ page }) => {
    const identity = page.locator('.v10-po-identity');
    await expect(identity).toBeVisible();
    await expect(identity.getByText('Your role:', { exact: true })).toBeVisible();
    await expect(identity.getByText('Context Graph:', { exact: true })).toBeVisible();
  });

  test('Overview "What is a Context Graph?" primer button is present', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: 'What is a Context Graph?' }).first(),
    ).toBeVisible();
  });

  test('"At a glance" stat strip surfaces Entities / Triples / Subgraphs', async ({ page }) => {
    const strip = page.locator('[data-section="at-a-glance"]');
    await expect(strip).toBeVisible();
    await expect(strip.getByText('Entities', { exact: true })).toBeVisible();
    await expect(strip.getByText('Triples', { exact: true })).toBeVisible();
    await expect(strip.getByText('Subgraphs', { exact: true })).toBeVisible();
  });

  test('Knowledge Pipeline renders the WM / SWM / VM step cards', async ({ page }) => {
    const pipeline = page.locator('[data-section="pipeline"]');
    await expect(pipeline).toBeVisible();
    const steps = pipeline.locator('.v10-po-pipeline-step');
    await expect(steps).toHaveCount(3);
    const labels = await steps.locator('.v10-po-pipeline-step-label').allInnerTexts();
    expect(labels.map((l) => l.trim())).toEqual([
      'Working Memory',
      'Shared Working Memory',
      'Verifiable Memory',
    ]);
  });

  test('Knowledge Pipeline step buttons switch the active layer', async ({ page }) => {
    const wmStep = page
      .locator('.v10-po-pipeline-step')
      .filter({ has: page.getByText(/^Working Memory$/) })
      .first();
    await wmStep.click();
    // Switching layer renders the layer-detail surface; Overview is
    // unmounted (`.v10-po` is gone), the layer header takes its place.
    await expect(page.locator('.v10-layer-detail-title')).toHaveText('Working Memory', {
      timeout: 8_000,
    });
  });

  test('Participant agents section lists at least the local agent', async ({ page }) => {
    const section = page
      .locator('.v10-po')
      .locator('div')
      .filter({ has: page.locator('.v10-po-section-title', { hasText: 'Participant agents' }) })
      .first();
    await expect(section).toBeVisible();
    // The local devnet agent is always a participant, so the section
    // should never be entirely empty.
    const text = (await section.textContent()) ?? '';
    expect(text.length).toBeGreaterThan('Participant agents'.length);
  });

  test('LayerSwitcher Import action opens the Import Files modal', async ({ page, importFilesModal }) => {
    await page.locator('button[aria-label="Import into Context Graph"]').click();
    await expect(importFilesModal.overlay).toBeVisible();
    await importFilesModal.cancel();
  });

  test('Refresh action does not crash the project view', async ({ page }) => {
    await page.locator('button[aria-label="Refresh Context Graph data"]').click();
    await expect(page.locator('.v10-po')).toBeVisible();
  });

  test('project tab is closable', async ({ centerPanel }) => {
    expect(await centerPanel.isTabClosable(projectName)).toBe(true);
  });

  test('closing the project tab returns focus to the Dashboard tab', async ({ centerPanel }) => {
    await centerPanel.closeTab(projectName);
    await expect(async () => {
      const active = await centerPanel.getActiveTabName();
      expect(active?.trim()).toBe('Dashboard');
    }).toPass({ timeout: 5_000 });
  });

  test('Recent activity section renders with an empty-state hint on cold devnet', async ({ page }) => {
    const activity = page.locator('[data-section="activity"]');
    await expect(activity).toBeVisible();
    // Either the empty hint is visible (cold seed) or activity rows
    // render. Both are valid; we only care that the surface is mounted.
    const empty = activity.getByText(/Once knowledge starts being added/i);
    const rows = activity.locator('.v10-overview-activity').locator('li, .activity-row, button');
    await expect(empty.or(rows.first()).first()).toBeVisible({ timeout: 8_000 });
  });

  test('legacy MemoryExplorer chrome stays removed (regression guard)', async ({ page }) => {
    // Pre-rc11 project view used `.v10-me-*` classes for header,
    // empty-state hexagon icon, project dot, etc. The redesign
    // replaced all of them with `.v10-po-*` and the LayerSwitcher.
    await expect(page.locator('.v10-me-header')).toHaveCount(0);
    await expect(page.locator('.v10-me-empty-icon')).toHaveCount(0);
    await expect(page.locator('.v10-me-project-dot')).toHaveCount(0);
  });
});
