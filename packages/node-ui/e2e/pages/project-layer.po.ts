import { type Page, type Locator } from '@playwright/test';
import { sel } from '../helpers/selectors.js';

export class ProjectLayerPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async openProject(name: string) {
    await this.page
      .locator(sel.myContextGraphs.peerGroupBody)
      .locator(sel.leftPanel.sectionHeader)
      .filter({ hasText: name })
      .click();
  }

  async switchLayer(layer: 'Overview' | 'Working Memory' | 'Shared Working Memory' | 'Verifiable Memory' | 'Subgraphs') {
    const layerAttr: Record<string, string | null> = {
      Overview: null,
      'Working Memory': 'wm',
      'Shared Working Memory': 'swm',
      'Verifiable Memory': 'vm',
      Subgraphs: null,
    };
    const attr = layerAttr[layer];
    const btn = attr
      ? this.page.locator(`${sel.layer.switchBtn}[data-layer="${attr}"]`)
      : this.page.locator(sel.layer.switchBtn).filter({ hasText: layer });
    await btn.first().click();
  }

  async clickShare() {
    await this.page.locator(sel.layer.actionBtn).filter({ hasText: /Share/i }).click();
  }

  async clickImport() {
    await this.page.locator(sel.layer.actionBtn).filter({ hasText: /Import/i }).click();
  }

  async getStatStripCells(): Promise<Array<{ label: string; value: string }>> {
    const root = this.page.locator(sel.statStrip.root).first();
    await root.waitFor({ state: 'visible', timeout: 15_000 });
    const cells = root.locator(sel.statStrip.cell);
    const count = await cells.count();
    const out: Array<{ label: string; value: string }> = [];
    for (let i = 0; i < count; i++) {
      const cell = cells.nth(i);
      out.push({
        label: (await cell.locator(sel.statStrip.label).textContent())?.trim() ?? '',
        value: (await cell.locator(sel.statStrip.value).textContent())?.trim() ?? '',
      });
    }
    return out;
  }
}
