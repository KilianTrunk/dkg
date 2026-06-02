/**
 * KNOWN-BUG repro — intentionally FAILING until the linked issue is fixed.
 *
 * GH ISSUE: https://github.com/OriginTrail/dkg/issues/905 — "Views show a
 * perpetual 'Loading…' placeholder (no error/retry) when an API fetch fails".
 *
 * Root cause: `useFetch` (src/ui/hooks.ts) DOES expose an `error`, but several
 * data-driven views ignore it and gate their render on `data` only — so a
 * failed fetch renders the SAME "Loading…" placeholder forever (and never
 * self-heals if the endpoint stays down). ProjectView is the clearest case:
 *   if (!cg) return <div ...>Loading context graph...</div>;   // ProjectView.tsx:691
 * (api.fetchContextGraphs goes through api-wrapper.withFallback, which — when
 * NOT in mock mode — lets the real error propagate uncaught, leaving cgData
 * null.) The same `data`-only-gated pattern affects the Operations operation
 * detail drawer ("Loading…") and the SWM / node-log panels (empty-state on
 * failure). This test pins the ProjectView instance.
 *
 * We keep `/api/status` healthy so the page does NOT enter mock mode (the
 * base-fixture `_noMockModeGuard` therefore stays satisfied) and only fault
 * `/api/context-graph/list`, the endpoint ProjectView's own useFetch hits.
 */
import { test, expect } from '../../fixtures/base.js';
import { PRIMARY_CG } from '../../helpers/real-node.js';

test.describe('KNOWN BUG: views stick on "Loading…" with no error state when a fetch fails', () => {
  test('ProjectView shows an error/retry state (not a perpetual "Loading context graph...")', async ({
    page,
    shell,
    leftPanel,
  }) => {
    await shell.goto();
    // Let the sidebar populate from a SUCCESSFUL list fetch first, so the CG row
    // is present and clickable. useFetch keeps its last-good data on a later
    // error, so the row stays even after we start faulting the endpoint.
    await leftPanel.waitForProjectsLoaded();

    // Now the context-graph list endpoint goes down. /api/status stays healthy,
    // so this is a genuine partial outage, NOT mock mode.
    await page.route('**/api/context-graph/list**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"forced-down for known-bug repro"}',
      }),
    );

    // Open the project. ProjectView mounts and fires api.fetchContextGraphs,
    // which now 500s; `cgData` stays null → the center is stuck on the loading
    // placeholder. (We click the row directly rather than expandProject(), which
    // would just time out waiting for the explorer that never mounts.)
    await leftPanel.clickProject(PRIMARY_CG);

    const center = page.locator('.v10-center-content');

    // The loading placeholder appears...
    await expect(
      center.locator('.v10-view-placeholder').filter({ hasText: /Loading context graph/i }),
    ).toBeVisible({ timeout: 10_000 });

    // ==== THE BUG ====
    // CORRECT behavior: once the fetch has failed, the view should surface an
    // error + retry affordance, not pretend it is still loading forever. This
    // encodes the desired behavior and FAILS today (no error UI is rendered).
    const errorState = center.getByText(
      /failed to load|couldn.?t load|error loading|unable to load|could not load|something went wrong|retry|try again/i,
    );
    await expect(
      errorState.first(),
      'ProjectView renders "Loading context graph..." indefinitely when /api/context-graph/list fails; it never distinguishes loading from error and offers no retry — see linked GH issue.',
    ).toBeVisible({ timeout: 12_000 });
  });
});
