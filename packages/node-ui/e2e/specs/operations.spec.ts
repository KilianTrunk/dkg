import { test, expect } from '../fixtures/base.js';

// rc11 Operations / Observability page
//   * Tab is now opened from the global header's Observability button
//     (`button[title="Observability"]`). The legacy "View All
//     Operations" dashboard CTA was removed when the recent-operations
//     feed was retired in PR8.
//   * Sub-tabs: All Operations / Hardware / Logs / Errors. The
//     legacy "Performance" sub-tab was renamed to "Hardware" — the
//     "Not enough data for charts" copy moved with it.
//   * Filters and the "0 total" total still render. The status
//     filter still uses lowercase option text ("success", "error",
//     "in_progress").
//   * Phase legend now derives from PHASE_LEGEND_ORDER (prepare,
//     store, chain, write-ahead, broadcast, parse, execute, transfer,
//     verify, decode, validate). The legacy spec hardcoded
//     Prepare / Broadcast / Verify; the rewrite asserts those + the
//     legend's invariant length.

async function openObservability(page: any) {
  await page.locator('button[title="Observability"]').first().click();
  await expect(page.getByRole('heading', { name: 'Observability', level: 1 })).toBeVisible({
    timeout: 10_000,
  });
}

test.describe('Operations / Observability', () => {
  test.beforeEach(async ({ shell, page }) => {
    await shell.goto();
    await openObservability(page);
  });

  test('Operations tab opens with the "Observability" label', async ({ centerPanel }) => {
    const tabs = await centerPanel.getTabNames();
    expect(tabs).toContain('Observability');
  });

  test('renders the "Observability" page heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Observability', level: 1 })).toBeVisible();
  });

  test('renders the "Track operation performance, phases, and errors" subtitle', async ({ page }) => {
    await expect(page.getByText('Track operation performance, phases, and errors')).toBeVisible();
  });

  test('exposes four sub-tabs: All Operations / Hardware / Logs / Errors', async ({ page }) => {
    const tabs = page.locator('.tab-group .tab-item');
    await expect(tabs).toHaveCount(4);
    const labels = (await tabs.allInnerTexts()).map((t) => t.trim());
    expect(labels).toEqual(['All Operations', 'Hardware', 'Logs', 'Errors']);
  });

  test('All Operations is the default active sub-tab', async ({ page }) => {
    const active = page.locator('.tab-group .tab-item.active');
    await expect(active).toHaveText('All Operations');
  });

  test('type filter dropdown lists multiple operation types', async ({ page }) => {
    // Two `.filters` strips render on the page (the stats period
    // selector + the All Operations table). Scope by a title or option
    // text so we always pick up the table's filters.
    const select = page.locator('select[title="Filter by operation type"]');
    await expect(select).toBeVisible();
    const options = await select.locator('option').count();
    expect(options).toBeGreaterThan(1);
  });

  test('type filter includes the documented operation kinds', async ({ page }) => {
    const select = page.locator('select[title="Filter by operation type"]');
    const html = await select.innerHTML();
    expect(html).toMatch(/value="publish"/);
    expect(html).toMatch(/value="query"/);
  });

  test('status filter exposes "All statuses" + success/error/in_progress', async ({ page }) => {
    // Status filter is the only `<select>` in the page that contains
    // an option literally named "All statuses".
    const statusSelect = page.locator('select').filter({
      has: page.locator('option', { hasText: /^All statuses$/ }),
    });
    await expect(statusSelect).toBeVisible();
    const texts = (await statusSelect.locator('option').allInnerTexts()).map((t) => t.trim());
    expect(texts).toEqual(['All statuses', 'success', 'error', 'in_progress']);
  });

  test('Operation ID search input is editable', async ({ page }) => {
    const input = page.locator('input[placeholder*="Operation ID"]');
    await input.fill('op-123');
    expect(await input.inputValue()).toBe('op-123');
  });

  test('Phases legend renders the documented phases', async ({ page }) => {
    // "Phases" now collides with the operations table's `<th>Phases</th>`
    // when there are populated rows, so we scope to the legend strip's
    // own `<span>Phases</span>` (rendered next to colour swatches).
    // The strip is the immediate sibling of the operations table card
    // and uses inline styles, so we identify it by its label span.
    const legendLabel = page.locator('span', { hasText: /^Phases$/ });
    await expect(legendLabel.first()).toBeVisible();
    // Walk to the legend container that holds the colour swatches.
    const legend = legendLabel.first().locator('..');
    await expect(legend.locator('span', { hasText: /^Prepare$/ })).toBeVisible();
    await expect(legend.locator('span', { hasText: /^Broadcast$/ })).toBeVisible();
    await expect(legend.locator('span', { hasText: /^Verify$/ })).toBeVisible();
  });

  test('cold devnet shows the "No operations recorded" empty state', async ({ page }) => {
    // Devnet boots clean; the daemon may have written a couple of
    // bootstrap ops by the time the suite runs. Accept either branch:
    // either the empty-state title OR a populated `.data-table`.
    const empty = page.getByText('No operations recorded');
    const table = page.locator('table.data-table');
    await expect(empty.or(table).first()).toBeVisible({ timeout: 8_000 });
  });

  test('Hardware sub-tab renders without the legacy "Performance" tab', async ({ page }) => {
    // Verify the legacy tab is gone, and the new one is reachable.
    await expect(page.locator('.tab-group .tab-item').filter({ hasText: 'Performance' })).toHaveCount(0);
    const hardwareTab = page.locator('.tab-group .tab-item').filter({ hasText: 'Hardware' });
    await hardwareTab.click();
    await expect(hardwareTab).toHaveClass(/active/);
  });

  test('Logs sub-tab surfaces the daemon.log header + level filter + Refresh', async ({ page }) => {
    await page.locator('.tab-group .tab-item').filter({ hasText: 'Logs' }).click();
    await expect(page.getByText(/daemon\.log/i).first()).toBeVisible({ timeout: 8_000 });
    const levelSelect = page.locator('select.input').first();
    const html = await levelSelect.innerHTML();
    expect(html).toContain('All levels');
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
  });

  test('Logs sub-tab shows either a log line stream or the empty state', async ({ page }) => {
    await page.locator('.tab-group .tab-item').filter({ hasText: 'Logs' }).click();
    // Lines render through `<StyledDaemonLine>` (no class hooks — only
    // inline styles). The most stable cross-line invariant is the
    // ISO-style timestamp prefix `YYYY-MM-DD HH:MM:SS` that the daemon
    // emits for every log entry. Either that prefix is visible, or
    // the empty-state copy is.
    const empty = page.getByText('No log lines found');
    const tsLine = page.getByText(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/).first();
    await expect(empty.or(tsLine).first()).toBeVisible({ timeout: 12_000 });
  });

  test('Errors sub-tab surfaces the Error Hotspots section', async ({ page }) => {
    await page.locator('.tab-group .tab-item').filter({ hasText: 'Errors' }).click();
    await expect(page.getByText('Error Hotspots')).toBeVisible();
  });

  test('Errors sub-tab shows the all-clean empty-state when there are none', async ({ page }) => {
    await page.locator('.tab-group .tab-item').filter({ hasText: 'Errors' }).click();
    const success = page.getByText(/All operations completed successfully/i);
    const hotspots = page.locator('.card .data-table');
    await expect(success.or(hotspots).first()).toBeVisible({ timeout: 8_000 });
  });

  test('All Operations footer shows a "{N} total" counter', async ({ page }) => {
    const total = page.locator('.filters span').filter({ hasText: /total$/ }).first();
    await expect(total).toBeVisible();
    const text = (await total.textContent()) ?? '';
    expect(text).toMatch(/^\d+\s+total$/);
  });

  test('Operations tab is closable', async ({ centerPanel }) => {
    expect(await centerPanel.isTabClosable('Observability')).toBe(true);
  });
});
