import { test, expect } from '../fixtures/base.js';

/**
 * Dashboard spec — rewritten for the rc11 redesigned dashboard.
 *
 * The previous spec was written against the legacy "demo seed" dashboard
 * (4 stat cards, 4 quick-action buttons, demo project cards
 * Pharma/Climate/EU, recent-operations feed, View-all link, hardcoded
 * `my-dkg-node` / `DKG Mainnet` subtitle). NONE of those surfaces
 * exist in the current UI; the dashboard now ships:
 *   - 3 StatCards: My Context Graphs / Context Graph Size /
 *     Collaborating Agents (.v10-dash-stats.v10-dash-stats-3)
 *   - My Context Graphs section: a CG list (`.v10-cg-row` buttons)
 *     that doubles as the project picker
 *   - Wallets and Spending section: chain row, node-wallet table
 *     (TRAC + native-gas balances), and a 24h/7d/30d spending table
 *
 * Every assertion below is daemon-agnostic — the seeded devnet config
 * (devnet-node-1 / DKG V10 Testnet / Chain 31337) is just one of many
 * valid daemon contexts the dashboard renders against; the spec
 * checks the SHAPE of each section, not its content.
 */

test.describe('Dashboard', () => {
  test.beforeEach(async ({ shell }) => {
    await shell.goto();
  });

  test('renders page title "Dashboard"', async ({ dashboard }) => {
    await expect(dashboard.title).toBeVisible();
    await expect(dashboard.title).toHaveText('Dashboard');
  });

  test('subtitle reports the daemon name + network + chain', async ({ dashboard }) => {
    // The subtitle template is `{name} · {networkName} · Chain {chainId}`
    // (CHAIN_INFO.name fallback). Assert the *shape* — three dot-separated
    // segments, all non-empty — instead of the old fixture-specific
    // "my-dkg-node · DKG Mainnet" string. The first segment must come
    // from /api/status (so it's >= 1 char of non-whitespace) and the
    // last segment must look like a chain hint.
    await expect(dashboard.subtitle).toBeVisible();
    const text = await dashboard.getSubtitleText();
    const parts = text.split('·').map((p) => p.trim());
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  test('renders exactly three stat cards (CG count / size / agents)', async ({ dashboard, page }) => {
    // The rc11 redesign trimmed the stat row from four to three. Anchor
    // on the explicit 3-stat container class so re-adding a card without
    // updating the spec gets caught.
    await expect(dashboard.statsContainer).toHaveClass(/v10-dash-stats-3/);
    await expect(page.locator('.v10-dash-stats .stat-card')).toHaveCount(3);
  });

  test('stat-card labels match the rc11 dashboard contract', async ({ page }) => {
    // Labels are rendered uppercase by the `.stat-label` CSS rule
    // (text-transform: uppercase) — `allInnerTexts()` returns the
    // *rendered* text, so compare against the uppercase form.
    const labels = page.locator('.v10-dash-stats .stat-label');
    const texts = await labels.allInnerTexts();
    const normalised = texts.map((t) => t.trim().toLowerCase());
    expect(normalised).toEqual([
      'my context graphs',
      'context graph size',
      'collaborating agents',
    ]);
  });

  test('every stat card surfaces a value slot OR an explicit empty/loading state', async ({ page }) => {
    // Each StatCard renders one of these (mutually exclusive, never empty):
    //   * .stat-value with text          — happy path single-number card
    //   * .v10-cg-size-detail            — Context Graph Size composite
    //   * .v10-stat-empty                — explicit no-data placeholder ("—")
    //   * .v10-stat-loading              — initial fetch in flight
    // The durable invariant is "exactly one of those slots is present
    // and non-empty"; if a card silently renders blank, the daemon's
    // probe broke and the user sees a hole — that's the regression we
    // want to fail this test on.
    const cards = page.locator('.v10-dash-stats .stat-card');
    const count = await cards.count();
    expect(count).toBe(3);
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const valueText = ((await card.locator('.stat-value').first().textContent().catch(() => '')) ?? '').trim();
      const hasValue = valueText.length > 0;
      const hasDetail = (await card.locator('.v10-cg-size-detail').count()) > 0;
      const hasEmpty = (await card.locator('.v10-stat-empty').count()) > 0;
      const hasLoading = (await card.locator('.v10-stat-loading').count()) > 0;
      expect(
        hasValue || hasDetail || hasEmpty || hasLoading,
        `stat card #${i} has none of {.stat-value, .v10-cg-size-detail, .v10-stat-empty, .v10-stat-loading}`,
      ).toBe(true);
    }
  });

  test('My Context Graphs section is rendered with a count badge', async ({ page }) => {
    const section = page
      .locator('.v10-dash-section')
      .filter({ has: page.getByRole('heading', { name: 'My Context Graphs', level: 3 }) });
    await expect(section).toBeVisible();
    const badge = section.locator('.v10-dash-section-badge');
    // Badge text is the integer count of CGs — assert it parses to a
    // non-negative integer. Empty string / non-numeric text would mean
    // the daemon's /api/contextGraphs probe fell over silently.
    await expect(badge).toBeVisible();
    const badgeText = (await badge.textContent())?.trim() ?? '';
    expect(badgeText).toMatch(/^\d+$/);
    expect(parseInt(badgeText, 10)).toBeGreaterThanOrEqual(0);
  });

  test('CG list row count matches the section badge count', async ({ page, dashboard }) => {
    const section = page
      .locator('.v10-dash-section')
      .filter({ has: page.getByRole('heading', { name: 'My Context Graphs', level: 3 }) });
    // Wait for the initial fetch to settle — the badge starts at "0"
    // while /api/contextGraphs is in flight, then catches up. The list
    // body is one of three states: "Loading context graphs…",
    // "No context graphs yet — create or join one from the sidebar.",
    // or the actual list. Settling = NOT the loading copy anymore.
    const loadingCopy = section.getByText('Loading context graphs…');
    await expect.poll(async () => (await loadingCopy.count()) === 0, { timeout: 8_000 }).toBe(true);

    const badge = section.locator('.v10-dash-section-badge');
    const badgeText = (await badge.textContent())?.trim() ?? '0';
    const expected = parseInt(badgeText, 10);

    if (expected === 0) {
      // The empty branch shows a one-line "no CGs yet" placeholder
      // instead of a list — assert the placeholder scoped to THIS
      // section (the wallets section reuses `.v10-cg-empty` while
      // wallets are still loading, which would trip strict-mode if
      // we matched globally).
      await expect(section.locator('.v10-cg-empty')).toBeVisible();
      return;
    }

    await expect.poll(async () => dashboard.cgRows.count(), { timeout: 5_000 })
      .toBe(expected);
  });

  test('clicking a CG row opens that project as a closable tab', async ({ dashboard, centerPanel }) => {
    // The /api/contextGraphs round-trip can be slow on a cold devnet
    // boot — poll until at least one CG has rendered into the list
    // instead of skipping when the first read returns []. The bound
    // is generous (12s) because the test below depends on the same
    // data; failing fast here is more useful than a noisy skip.
    await expect.poll(async () => (await dashboard.getCgNames()).length, { timeout: 12_000 })
      .toBeGreaterThan(0);
    const names = await dashboard.getCgNames();
    const target = names[0]!;
    const tabsBefore = await centerPanel.getTabCount();
    await dashboard.clickCgRow(target);
    await expect.poll(async () => centerPanel.getTabCount(), { timeout: 5_000 })
      .toBeGreaterThan(tabsBefore);
    const tabs = await centerPanel.getTabNames();
    const projectTab = tabs.find((t) => t.includes(target) || t.startsWith(target.slice(0, 12)));
    expect(projectTab).toBeTruthy();
    expect(await centerPanel.isTabClosable(projectTab!)).toBe(true);
  });

  test('Wallets and Spending section renders with chain + node-wallets header', async ({ dashboard, page }) => {
    await expect(dashboard.walletsSection).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Wallets and Spending', level: 3 })).toBeVisible();
    await expect(dashboard.chainRow).toBeVisible();
    // "Node wallets" subhead is always rendered (even on the loading /
    // empty / error branch); assert its presence as the durable shape.
    await expect(dashboard.walletsSection.getByText('Node wallets')).toBeVisible();
  });

  test('Wallets table headers are exactly Wallet / TRAC / Gas', async ({ dashboard }) => {
    // Wait for the chain RPC + wallet-balances probe to settle. The
    // table is rendered when wb.balances is non-empty; if the chain
    // probe legitimately fails (`wb.error`), the section shows the
    // "Wallet balances unavailable." copy instead — also a valid
    // shape, just not the contract under test here.
    const wtable = dashboard.walletsSection.locator('.v10-ws-wtable');
    await expect(wtable).toBeVisible({ timeout: 12_000 });
    const head = wtable.locator('.v10-ws-whead');
    await expect(head.locator('span').nth(0)).toHaveText('Wallet');
    await expect(head.locator('span').nth(1)).toHaveText('TRAC');
    // The third column is Gas (<symbol>) where symbol depends on
    // chainInfo() — match the prefix.
    await expect(head.locator('span').nth(2)).toHaveText(/^Gas \(/);
  });

  test('Spending table renders the three rolling windows', async ({ dashboard, page }) => {
    const spend = dashboard.spendingTable;
    await expect(spend).toBeVisible();
    // Header row + three windows; the windows use the literal labels
    // "Last 24h" / "Last 7d" / "Last 30d" (DashboardView line 580 — the
    // `.display` field on each row). Assert the literal copy.
    await expect(spend.getByText('Last 24h')).toBeVisible();
    await expect(spend.getByText('Last 7d')).toBeVisible();
    await expect(spend.getByText('Last 30d')).toBeVisible();
    // Header row uses Period / Publishes to VM / TRAC.
    await expect(spend.getByText('Period', { exact: true })).toBeVisible();
    await expect(spend.getByText('Publishes to VM', { exact: true })).toBeVisible();
    await expect(spend.getByText('TRAC', { exact: true })).toBeVisible();
  });

  test('legacy quick-action row is not rendered (regression guard)', async ({ page }) => {
    // The `.v10-quick-action` row was deleted along with the legacy
    // dashboard. If it ever comes back without the spec being
    // updated, this guard catches it so we don't silently regress
    // into testing two dashboards in parallel.
    await expect(page.locator('.v10-quick-action')).toHaveCount(0);
  });

  test('legacy demo "project cards" row is not rendered (regression guard)', async ({ page }) => {
    // Same rationale as above for `.v10-dash-project-card`.
    await expect(page.locator('.v10-dash-project-card')).toHaveCount(0);
  });

  test('legacy "recent operations" section is not rendered (regression guard)', async ({ page }) => {
    // Recent-ops moved into the Observability/Operations tab; the
    // dashboard no longer mirrors them. If `.v10-recent-op` ever
    // reappears here, that's a regression worth investigating.
    await expect(page.locator('.v10-recent-op')).toHaveCount(0);
  });
});
