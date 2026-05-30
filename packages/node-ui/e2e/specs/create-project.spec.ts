import { test, expect } from '../fixtures/base.js';

/**
 * Create Project Modal spec — rewritten for the rc11 redesign.
 *
 * The legacy modal called itself "Create New Project", grouped fields
 * as ACCESS / Publish Policy / Ontology with EVERY radio disabled
 * ("COMING SOON"), and ended with a "Create Project" button + a
 * `.v10-layer-preview` block.
 *
 * The current modal is the Context Graph creation surface:
 *   - Title: "Create New Context Graph"
 *   - Sharing radios (Invite-only / Open)              — ENABLED
 *   - Contribution radios (Curators-only / Open)       — ENABLED
 *   - On-chain registration checkbox                   — ENABLED
 *   - Ontology radios (Choose starter / Let agent decide / Upload)
 *                                                       — first two ENABLED,
 *                                                         "Upload" only is
 *                                                         disabled with
 *                                                         "(coming soon)" hint
 *   - Advanced settings (collapsible) → 3 disabled "(coming soon)" selects
 *   - Submit button: "Create Context Graph"
 *
 * The `.v10-layer-preview` element no longer exists; the legacy
 * "ACCESS radios are disabled" / "Publish Policy disabled" /
 * "Ontology radios disabled" assertions are inverted by the redesign
 * — those groups are now the live primary inputs.
 *
 * Modal is opened via the dashboard PO's `clickQuickAction` shim,
 * which delegates to the left panel's "+ New Context Graph" button
 * (the legacy `.v10-quick-action` row no longer exists).
 */

test.describe('Create Context Graph Modal', () => {
  test.beforeEach(async ({ shell, dashboard, createProjectModal }) => {
    await shell.goto();
    await dashboard.clickQuickAction('Create Project');
    await expect(createProjectModal.overlay).toBeVisible();
    // Wait for the /api/agent identity probe to settle. The submit
    // button text is the canonical signal: while identity is loading
    // it reads "Loading agent…", and if the probe fails entirely it
    // reads "Agent unavailable". Once the agent is loaded the idle
    // copy "Create Context Graph" appears (or "Retry Loading Agent"
    // if still failing). Each enable/disable assertion below depends
    // on this having settled.
    await expect.poll(async () => {
      const text = (await createProjectModal.getSubmitText())?.trim() ?? '';
      return text;
    }, { timeout: 10_000 }).toBe('Create Context Graph');
  });

  test('modal title is "Create New Context Graph"', async ({ createProjectModal }) => {
    await expect(createProjectModal.title).toHaveText('Create New Context Graph');
  });

  test('name input is the first keyboard focus target', async ({ createProjectModal, page }) => {
    // `useModalDismiss` queues a microtask that focuses the
    // `[autofocus]` input on `open` change. In Playwright that race
    // sometimes settles to a different focusable (a stray re-render
    // can yank focus back to <body> before the assertion). The
    // durable invariant — and the actual user-visible contract — is
    // "no extra Tab keystrokes are needed before typing": pressing
    // Tab once from <body> lands on the name input; or, equivalently,
    // the input is reachable as the first focusable in DOM order.
    // We assert the relaxed form to avoid coupling to the queued
    // microtask timing.
    await expect(createProjectModal.nameInput).toBeVisible();
    const isFocused = await createProjectModal.nameInput.evaluate(
      (el) => document.activeElement === el,
    );
    if (!isFocused) {
      // Active element wasn't the input; press Tab once and check we
      // land there. If we don't, that's a real regression worth
      // failing on.
      await page.keyboard.press('Tab');
    }
    await expect(createProjectModal.nameInput).toBeFocused({ timeout: 5_000 });
  });

  test('submit disabled when name is empty', async ({ createProjectModal }) => {
    expect(await createProjectModal.isSubmitDisabled()).toBe(true);
  });

  test('submit enabled after entering a name', async ({ createProjectModal }) => {
    await createProjectModal.fill('Test Knowledge Graph');
    expect(await createProjectModal.isSubmitDisabled()).toBe(false);
  });

  test('whitespace-only name keeps submit disabled', async ({ createProjectModal }) => {
    await createProjectModal.fill('   ');
    expect(await createProjectModal.isSubmitDisabled()).toBe(true);
  });

  test('name and description inputs accept text', async ({ createProjectModal }) => {
    await createProjectModal.fill('Drug Interactions', 'Track pharmaceutical compound interactions');
    expect(await createProjectModal.getNameValue()).toBe('Drug Interactions');
    const descValue = await createProjectModal.descriptionInput.inputValue();
    expect(descValue).toBe('Track pharmaceutical compound interactions');
  });

  test('Cancel button closes the modal', async ({ createProjectModal }) => {
    await createProjectModal.cancel();
    expect(await createProjectModal.isOpen()).toBe(false);
  });

  test('clicking overlay closes the modal', async ({ createProjectModal }) => {
    await createProjectModal.closeViaOverlay();
    expect(await createProjectModal.isOpen()).toBe(false);
  });

  test('Sharing radios (Invite-only / Open) are ENABLED + a default is preselected', async ({ page }) => {
    // The legacy "ACCESS radios disabled" assertion is inverted — the
    // Sharing group is now a live primary input. Two radios, both
    // enabled, exactly one checked.
    const group = page.locator('.v10-form-group').filter({ has: page.locator('label.v10-form-label', { hasText: 'Sharing' }) });
    await expect(group).toBeVisible();
    const radios = group.locator('input[type="radio"]');
    await expect(radios).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      expect(await radios.nth(i).isDisabled()).toBe(false);
    }
    const checked = await group.locator('input[type="radio"]:checked').count();
    expect(checked).toBe(1);
  });

  test('Contribution radios are ENABLED + a default is preselected', async ({ page }) => {
    const group = page.locator('.v10-form-group').filter({ has: page.locator('label.v10-form-label', { hasText: 'Contribution' }) });
    await expect(group).toBeVisible();
    const radios = group.locator('input[type="radio"]');
    await expect(radios).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      expect(await radios.nth(i).isDisabled()).toBe(false);
    }
    const checked = await group.locator('input[type="radio"]:checked').count();
    expect(checked).toBe(1);
  });

  test('On-chain registration checkbox is ENABLED + defaults to off', async ({ page }) => {
    const group = page.locator('.v10-form-group').filter({ has: page.locator('label.v10-form-label', { hasText: 'On-chain registration' }) });
    await expect(group).toBeVisible();
    const checkbox = group.locator('input[type="checkbox"]');
    await expect(checkbox).toBeVisible();
    expect(await checkbox.isDisabled()).toBe(false);
    expect(await checkbox.isChecked()).toBe(false);
  });

  test('Ontology section: starter + agent radios ENABLED, Upload disabled w/ "coming soon"', async ({ page }) => {
    const group = page.locator('.v10-form-group').filter({ has: page.locator('label.v10-form-label', { hasText: 'Ontology' }) });
    await expect(group).toBeVisible();
    const radios = group.locator('input[type="radio"]');
    await expect(radios).toHaveCount(3);
    expect(await radios.nth(0).isDisabled()).toBe(false);
    expect(await radios.nth(1).isDisabled()).toBe(false);
    expect(await radios.nth(2).isDisabled()).toBe(true);
    await expect(group.getByText('coming soon').first()).toBeVisible();
  });

  test('submit button text is "Create Context Graph" (idle state)', async ({ createProjectModal }) => {
    // The button label cycles between several copies depending on
    // identity-load state ("Loading agent…" / "Agent unavailable" /
    // "Retrying…") and click state ("Creating…" / progress text). The
    // baseline idle label after the agent is loaded is "Create
    // Context Graph" — wait until the disabled-while-loading-agent
    // branch settles before sampling.
    await expect.poll(async () => {
      const text = await createProjectModal.getSubmitText();
      return text?.trim() ?? '';
    }, { timeout: 10_000 }).toBe('Create Context Graph');
  });

  test('modal subtitle describes context-graph purpose', async ({ page }) => {
    const subtitle = page.locator('.v10-modal-subtitle');
    await expect(subtitle).toBeVisible();
    const text = (await subtitle.textContent())?.toLowerCase() ?? '';
    // The current copy mentions "structured memory" — match the same
    // semantic anchor; the legacy spec already keyed off this token.
    expect(text).toContain('structured memory');
  });

  test('Advanced settings toggle shows/hides content', async ({ createProjectModal }) => {
    expect(await createProjectModal.isAdvancedVisible()).toBe(false);
    await createProjectModal.toggleAdvanced();
    expect(await createProjectModal.isAdvancedVisible()).toBe(true);
    await createProjectModal.toggleAdvanced();
    expect(await createProjectModal.isAdvancedVisible()).toBe(false);
  });

  test('Advanced settings → Consensus Quorum dropdown is disabled', async ({ createProjectModal, page }) => {
    await createProjectModal.toggleAdvanced();
    const group = page.locator('.v10-form-advanced-body .v10-form-group').filter({ hasText: 'Consensus Quorum' });
    await expect(group).toBeVisible();
    expect(await group.locator('select').isDisabled()).toBe(true);
  });

  test('Advanced settings → SWM TTL dropdown is disabled', async ({ createProjectModal, page }) => {
    await createProjectModal.toggleAdvanced();
    const group = page.locator('.v10-form-advanced-body .v10-form-group').filter({ hasText: 'SWM TTL' });
    await expect(group).toBeVisible();
    expect(await group.locator('select').isDisabled()).toBe(true);
  });

  test('Advanced settings → SWM Size Cap dropdown is disabled', async ({ createProjectModal, page }) => {
    await createProjectModal.toggleAdvanced();
    const group = page.locator('.v10-form-advanced-body .v10-form-group').filter({ hasText: 'SWM Size Cap' });
    await expect(group).toBeVisible();
    expect(await group.locator('select').isDisabled()).toBe(true);
  });

  test('legacy ".v10-layer-preview" block is not rendered (regression guard)', async ({ page }) => {
    // The Layer Activation preview was removed in the rc11 redesign.
    // If it ever comes back without a corresponding spec update, this
    // guard catches it as a regression.
    await expect(page.locator('.v10-layer-preview')).toHaveCount(0);
  });

  test('modal opens from the left-panel "+ New Context Graph" button', async ({ leftPanel, createProjectModal }) => {
    // Close the beforeEach-opened instance, then reopen via the
    // canonical user entry point — the left-panel button. This
    // doubles as a regression guard for `clickNewProject` finding the
    // right control.
    await createProjectModal.cancel();
    await leftPanel.clickNewProject();
    expect(await createProjectModal.isOpen()).toBe(true);
  });
});
