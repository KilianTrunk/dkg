import { test, expect } from '../fixtures/base.js';

// Left-panel surface in rc11:
//   * Two top-row buttons: "+ New Context Graph" / "↗ Join Context Graph"
//   * Two mode tabs: "Context Graphs" (default) / "Context Oracle"
//   * Dashboard row above the collapsible peer-groups
//   * "My Context Graphs" peer-group with a row per CG; clicking the
//     row's header opens a project tab. The × button hides the CG from
//     the sidebar (reversible via "↺ Show N hidden…").
//   * Inline expand-to-see-memory-layers, demo-data CG names, the
//     "Memory Stack" row, and the per-row asset count badge are all
//     gone — the rewritten spec exercises only what's actually
//     navigable.
// Discovery flow mirrors tab-management.spec: pick the first CG that
// the seeded devnet returns and drive everything off that name, so the
// spec stays daemon-agnostic.

async function discoverProjectName(leftPanel: any): Promise<string> {
  await expect(async () => {
    const names = await leftPanel.getProjectNames();
    expect(names.length).toBeGreaterThan(0);
  }).toPass({ timeout: 12_000, intervals: [250, 500, 1000] });
  const names = await leftPanel.getProjectNames();
  return names[0]!;
}

test.describe('Left Panel Navigation', () => {
  test.beforeEach(async ({ shell, page }) => {
    await shell.goto();
    await page.locator('.v10-panel-left .v10-tree-header').waitFor({ state: 'visible', timeout: 10_000 });
  });

  test('Context Graphs mode is active by default', async ({ leftPanel }) => {
    const mode = await leftPanel.getActiveMode();
    expect(mode?.trim().toLowerCase()).toBe('context graphs');
  });

  test('top row exposes the create + join action buttons', async ({ leftPanel }) => {
    await expect(leftPanel.newProjectBtn).toBeVisible();
    await expect(leftPanel.joinProjectBtn).toBeVisible();
  });

  test('Dashboard row is rendered above the CG list', async ({ leftPanel }) => {
    const dashboard = leftPanel.root.locator('.v10-tree-dashboard').filter({ hasText: 'Dashboard' });
    await expect(dashboard).toBeVisible();
  });

  test('clicking the Dashboard row activates the Dashboard tab', async ({ leftPanel, centerPanel }) => {
    await leftPanel.clickDashboard();
    const active = await centerPanel.getActiveTabName();
    expect(active?.trim()).toBe('Dashboard');
  });

  test('My Context Graphs peer-group is expanded by default', async ({ page }) => {
    const header = page
      .locator('.v10-panel-left .v10-peer-group-header')
      .filter({ hasText: 'My Context Graphs' })
      .first();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  test('My Context Graphs peer-group can be collapsed and re-expanded', async ({ page }) => {
    const header = page
      .locator('.v10-panel-left .v10-peer-group-header')
      .filter({ hasText: 'My Context Graphs' })
      .first();
    const body = page.locator('.v10-panel-left .v10-peer-group-body').first();
    await expect(body).toBeVisible();
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(body).toBeHidden();
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(body).toBeVisible();
  });

  test('seeded devnet renders at least one context graph in the sidebar', async ({ leftPanel }) => {
    const name = await discoverProjectName(leftPanel);
    expect(name.length).toBeGreaterThan(0);
  });

  test('every CG row has a × hide button next to its label', async ({ leftPanel, page }) => {
    await discoverProjectName(leftPanel);
    const rows = page.locator('.v10-panel-left .v10-peer-group-body .v10-tree-section');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const hide = rows.nth(i).locator('.v10-tree-hide-btn');
      await expect(hide).toBeVisible();
    }
  });

  test('clicking a CG header opens the corresponding project tab', async ({ leftPanel, centerPanel }) => {
    const name = await discoverProjectName(leftPanel);
    await leftPanel.clickProject(name);
    await expect(async () => {
      const tabs = await centerPanel.getTabNames();
      expect(tabs.some((t) => t.trim() === name)).toBe(true);
    }).toPass({ timeout: 5_000 });
  });

  test('the project tab opened from the sidebar is the active tab', async ({ leftPanel, centerPanel }) => {
    const name = await discoverProjectName(leftPanel);
    await leftPanel.clickProject(name);
    await expect(async () => {
      const active = await centerPanel.getActiveTabName();
      expect(active?.trim()).toBe(name);
    }).toPass({ timeout: 5_000 });
  });

  test('hiding a CG removes it from the sidebar and surfaces the restore button', async ({ leftPanel, page }) => {
    const before = await leftPanel.getProjectNames();
    test.skip(before.length < 2, 'need at least two CGs to safely hide one without losing list shape');
    const target = before[0]!;
    await leftPanel.hideProject(target);
    await expect(async () => {
      const after = await leftPanel.getProjectNames();
      expect(after).not.toContain(target);
    }).toPass({ timeout: 4_000 });
    await expect(page.locator('.v10-tree-show-hidden')).toBeVisible();
    // Restore so the suite leaves the local-storage clean for siblings.
    await page.locator('.v10-tree-show-hidden').click();
    await expect(async () => {
      const restored = await leftPanel.getProjectNames();
      expect(restored).toContain(target);
    }).toPass({ timeout: 4_000 });
  });

  test('Context Oracle mode swaps the tree for the catalogue placeholder', async ({ leftPanel, page }) => {
    // rc11 replaced the legacy `.v10-oracle-placeholder` "coming soon"
    // copy with a real Context Oracle view: a list of non-joined CGs
    // when the daemon has any, otherwise a `<p>` empty-state inviting
    // the user to "Join Context Graph". On the seeded devnet the
    // local agent owns its CGs, so the empty-state branch renders.
    await leftPanel.switchToMode('oracle');
    const oracleEmpty = page
      .locator('.v10-panel-left p')
      .filter({ hasText: /Join Context Graph|catalogue/i })
      .first();
    const oracleList = page.locator('.v10-panel-left .v10-tree-group-label').filter({ hasText: 'Context Oracle' });
    await expect(oracleEmpty.or(oracleList)).toBeVisible({ timeout: 4_000 });
  });

  test('switching back to Context Graphs restores the CG list', async ({ leftPanel }) => {
    // Establish a stable baseline first — the CG list async-loads via
    // `/api/contextGraphs`, so reading `getProjectNames()` immediately
    // after `goto` can race the round-trip and observe an empty list.
    await discoverProjectName(leftPanel);
    const before = await leftPanel.getProjectNames();
    await leftPanel.switchToMode('oracle');
    await leftPanel.switchToMode('explorer');
    await expect(async () => {
      const restored = await leftPanel.getProjectNames();
      expect(restored.length).toBe(before.length);
    }).toPass({ timeout: 4_000 });
  });

  test('+ New Context Graph button opens the create modal', async ({ leftPanel, createProjectModal }) => {
    await leftPanel.clickNewProject();
    await expect(createProjectModal.overlay).toBeVisible();
  });

  test('legacy inline memory-layer rows do not reappear (regression guard)', async ({ page }) => {
    // The pre-rc11 sidebar exposed `.v10-tree-layer-header` rows under
    // each project (agent drafts / team workspace / verified assets /
    // import files…). The rewrite removed them — guard against
    // regressions that re-add inline layer navigation here instead of
    // on the project view's LayerSwitcher.
    await expect(page.locator('.v10-panel-left .v10-tree-layer-header')).toHaveCount(0);
  });
});
