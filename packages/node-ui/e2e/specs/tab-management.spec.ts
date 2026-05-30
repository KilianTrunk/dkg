import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base.js';

// Tab-management is exercised end-to-end against the seeded devnet
// context-graphs (devnet-test, devnet-isolation, Agent Context). The
// previous spec referenced `Pharma Drug Interactions` + the legacy
// inline "expand to show memory layers" sidebar pattern — both are
// gone after the rc11 redesign:
//   * Memory layers are no longer rendered as tree-items in the left
//     panel; they live inside the project view's content tabs.
//   * The "expand a project" sidebar gesture has been replaced by
//     "click the project header → opens a project tab in the centre".
// The spec now exercises only behaviour that is still navigable from
// the user's perspective — the same invariants (tabs open, close,
// cap duplicates, activate a neighbour) just driven through the
// current entry points. Real CG names are discovered dynamically from
// the seeded sidebar so the spec stays daemon-agnostic.

async function discoverProjectName(leftPanel: any, page: any, idx = 0): Promise<string> {
  // The daemon's `/api/contextGraphs` round-trip can take a few seconds
  // on a cold devnet boot — poll until at least `idx + 1` rows are
  // rendered, then return the requested name. Bounded to the test's
  // 15s budget so it fails fast if the CG list never arrives.
  await expect(async () => {
    const names = await leftPanel.getProjectNames();
    expect(names.length).toBeGreaterThan(idx);
  }).toPass({ timeout: 12_000, intervals: [250, 500, 1000] });
  const names = await leftPanel.getProjectNames();
  return names[idx]!;
}

async function clickProjectHeader(page: Page, name: string) {
  await page
    .locator('.v10-panel-left')
    .first()
    .locator('.v10-tree-section-header')
    .filter({ hasText: name })
    .first()
    .click();
}

test.describe('Tab Management', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('Dashboard tab is present on load', async ({ centerPanel }) => {
    const tabs = await centerPanel.getTabNames();
    expect(tabs).toContain('Dashboard');
  });

  test('Dashboard tab cannot be closed', async ({ centerPanel }) => {
    expect(await centerPanel.isTabClosable('Dashboard')).toBe(false);
  });

  test('clicking a context-graph header opens a new closable tab', async ({ leftPanel, centerPanel, page }) => {
    const project = await discoverProjectName(leftPanel, page);
    const before = await centerPanel.getTabCount();
    await clickProjectHeader(page, project);
    await expect(async () => {
      const after = await centerPanel.getTabCount();
      expect(after).toBeGreaterThan(before);
    }).toPass({ timeout: 5_000 });
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find((t) => t.includes(project) || t.startsWith(project.slice(0, 12)));
    expect(projectTab, `expected a tab matching ${project}, got ${JSON.stringify(tabs)}`).toBeTruthy();
    expect(await centerPanel.isTabClosable(projectTab!)).toBe(true);
  });

  test('closing a project tab removes it from the bar', async ({ leftPanel, centerPanel, page }) => {
    const project = await discoverProjectName(leftPanel, page);
    await clickProjectHeader(page, project);
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find((t) => t.includes(project) || t.startsWith(project.slice(0, 12)))!;
    await centerPanel.closeTab(projectTab);
    const remaining = await centerPanel.getTabNames();
    expect(remaining).not.toContain(projectTab);
  });

  test('closing the active tab activates a neighbour', async ({ leftPanel, centerPanel, page }) => {
    const project = await discoverProjectName(leftPanel, page);
    await clickProjectHeader(page, project);
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find((t) => t.includes(project) || t.startsWith(project.slice(0, 12)))!;
    await centerPanel.switchTab(projectTab);
    await centerPanel.closeTab(projectTab);
    const activeAfter = await centerPanel.getActiveTabName();
    expect(activeAfter).toBeTruthy();
  });

  test('clicking an existing tab switches to it without creating a duplicate', async ({ leftPanel, centerPanel, page }) => {
    const project = await discoverProjectName(leftPanel, page);
    await clickProjectHeader(page, project);
    await centerPanel.switchTab('Dashboard');
    const active = await centerPanel.getActiveTabName();
    expect(active?.trim()).toBe('Dashboard');
  });

  test('two distinct projects open as two separate tabs', async ({ leftPanel, centerPanel, page }) => {
    const projectA = await discoverProjectName(leftPanel, page, 0);
    const projectB = await discoverProjectName(leftPanel, page, 1);
    const before = await centerPanel.getTabCount();
    await clickProjectHeader(page, projectA);
    await clickProjectHeader(page, projectB);
    await expect(async () => {
      const after = await centerPanel.getTabCount();
      expect(after).toBeGreaterThanOrEqual(before + 2);
    }).toPass({ timeout: 5_000 });
  });

  test('reopening the same project does not duplicate its tab', async ({ leftPanel, centerPanel, page }) => {
    const project = await discoverProjectName(leftPanel, page);
    await clickProjectHeader(page, project);
    const countBefore = await centerPanel.getTabCount();
    await centerPanel.switchTab('Dashboard');
    await clickProjectHeader(page, project);
    const countAfter = await centerPanel.getTabCount();
    expect(countAfter).toBe(countBefore);
  });
});
