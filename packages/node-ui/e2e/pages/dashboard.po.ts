import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class DashboardPage {
  readonly page: Page;
  readonly root: Locator;
  readonly title: Locator;
  readonly subtitle: Locator;
  readonly statsContainer: Locator;
  readonly quickActions: Locator;
  readonly projectCards: Locator;
  readonly recentOps: Locator;
  readonly viewAllLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator(sel.dashboard.root);
    this.title = page.locator(sel.dashboard.title);
    this.subtitle = page.locator(sel.dashboard.subtitle);
    this.statsContainer = page.locator(sel.dashboard.stats);
    this.quickActions = page.locator(sel.dashboard.quickAction);
    this.projectCards = page.locator(sel.dashboard.projectCard);
    this.recentOps = page.locator(sel.dashboard.recentOp);
    this.viewAllLink = page.locator(sel.dashboard.sectionLink).filter({ hasText: 'View all' });
  }

  async getStatCards() {
    const cards = this.statsContainer.locator(sel.dashboard.statCard);
    const count = await cards.count();
    const stats: Array<{ label: string; value: string }> = [];
    for (let i = 0; i < count; i++) {
      const label = await cards.nth(i).locator(sel.dashboard.statLabel).textContent() ?? '';
      const value = await cards.nth(i).locator(sel.dashboard.statValue).textContent() ?? '';
      stats.push({ label: label.trim(), value: value.trim() });
    }
    return stats;
  }

  async clickQuickAction(label: string) {
    // The legacy `.v10-quick-action` row on the dashboard was removed in
    // the rc11 redesign — the entry points moved into the left panel
    // ("+ New Context Graph") and into the project view ("Import files"
    // hub). Rather than ripping every spec that opens these modals as a
    // precondition, this method now resolves to the still-extant entry
    // point per label so the *modal-under-test* is what gets asserted,
    // not the obsolete dashboard row.
    const entryByLabel: Record<string, () => Promise<void>> = {
      'Create Project': async () => {
        await this.page
          .locator('.v10-new-project-btn')
          .filter({ hasText: /New Context Graph/i })
          .first()
          .click();
      },
    };
    const direct = this.quickActions.filter({ hasText: label });
    if ((await direct.count()) > 0) {
      await direct.first().click();
      return;
    }
    const fallback = entryByLabel[label];
    if (fallback) {
      await fallback();
      return;
    }
    // Preserve the original locator-error if neither path resolves so a
    // future regression doesn't silently no-op.
    await direct.click();
  }

  async getProjectCardNames() {
    const count = await this.projectCards.count();
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const name = await this.projectCards.nth(i).locator(sel.dashboard.projectName).textContent();
      if (name) names.push(name.trim());
    }
    return names;
  }

  async clickProjectCard(name: string) {
    await this.projectCards.filter({ hasText: name }).click();
  }

  async getRecentOperations() {
    const count = await this.recentOps.count();
    const ops: Array<{ type: string; status: string }> = [];
    for (let i = 0; i < count; i++) {
      const type = await this.recentOps.nth(i).locator(sel.dashboard.recentOpType).textContent() ?? '';
      const status = await this.recentOps.nth(i).locator(sel.dashboard.recentOpStatus).textContent() ?? '';
      ops.push({ type: type.trim(), status: status.trim() });
    }
    return ops;
  }

  async clickViewAllOperations() {
    await this.viewAllLink.click();
  }
}
