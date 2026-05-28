import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class LeftPanelPage {
  readonly page: Page;
  readonly root: Locator;
  readonly newProjectBtn: Locator;
  readonly joinProjectBtn: Locator;
  readonly oraclePlaceholder: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.locator(sel.leftPanel.root).first();
    // rc11 renamed "+ New Project" -> "+ New Context Graph". The button
    // class (`.v10-new-project-btn`) was kept for backwards-compat but
    // is now shared with "↗ Join Context Graph", so each handle filters
    // by visible label to disambiguate.
    this.newProjectBtn = this.root.locator(sel.leftPanel.newProjectBtn).filter({ hasText: /New Context Graph/i });
    this.joinProjectBtn = this.root.locator(sel.leftPanel.newProjectBtn).filter({ hasText: /Join Context Graph/i });
    this.oraclePlaceholder = page.locator(sel.leftPanel.oraclePlaceholder);
  }

  async isVisible() {
    return this.root.isVisible();
  }

  async clickDashboard() {
    await this.root.locator(sel.leftPanel.dashboard).filter({ hasText: 'Dashboard' }).click();
  }

  async switchToMode(mode: 'explorer' | 'oracle') {
    // rc11 renamed mode tab "Projects" -> "Context Graphs"; the underlying
    // store value `treeMode` is still 'explorer'/'oracle'.
    const label = mode === 'explorer' ? 'Context Graphs' : 'Context Oracle';
    await this.root.locator(sel.leftPanel.modeBtn).filter({ hasText: label }).click();
  }

  async getActiveMode() {
    const active = this.root.locator(`${sel.leftPanel.modeBtn}.active`);
    return active.textContent();
  }

  async clickNewProject() {
    await this.newProjectBtn.first().click();
  }

  async clickJoinProject() {
    await this.joinProjectBtn.first().click();
  }

  /**
   * Returns the names of every context graph rendered under the
   * "My Context Graphs" peer-group. Each CG row is a
   * `.v10-tree-section > .v10-tree-section-header > .v10-tree-section-label`;
   * scoping the locator to `.v10-peer-group-body` keeps us from picking
   * up the parent peer-group label or the Integrations section.
   */
  async getProjectNames() {
    const body = this.root.locator(sel.leftPanel.peerGroupBody).first();
    const labels = body.locator(sel.leftPanel.sectionLabel);
    const count = await labels.count();
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await labels.nth(i).textContent();
      if (text) names.push(text.trim());
    }
    return names;
  }

  /**
   * Click a context-graph header. In rc11 this opens the project tab in
   * the centre panel; the inline "expand to see memory layers" gesture
   * was removed (memory layers live inside the project view's
   * LayerSwitcher now).
   */
  async clickProject(name: string) {
    const section = this.root.locator(sel.leftPanel.section).filter({ hasText: name }).first();
    await section.locator(sel.leftPanel.sectionHeader).first().click();
  }

  /**
   * Click the inline `×` next to a CG row, which hides the CG from the
   * sidebar (reversibly — a "↺ Show N hidden context graphs" button
   * appears underneath the list while any are hidden).
   */
  async hideProject(name: string) {
    const section = this.root.locator(sel.leftPanel.section).filter({ hasText: name }).first();
    await section.locator(sel.leftPanel.sectionHeader).first().getByRole('button', { name: '×' }).click();
  }

  async expandIntegrations() {
    const header = this.root.locator(sel.leftPanel.peerGroupHeader).filter({ hasText: 'Integrations' });
    await header.click();
  }

  async getEmptyStateTitle() {
    return this.root.locator(sel.leftPanel.emptyTitle).textContent();
  }
}
