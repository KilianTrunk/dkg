import { useEffect, useState } from 'react';
import { isUsingMocks, subscribeMockMode } from '../api-wrapper.js';

/**
 * Visible indicator shown whenever the UI has silently fallen back to
 * fabricated demo data because the node is unreachable (GH #904).
 *
 * `api-wrapper.detectMockMode()` swaps every endpoint to `mocks/provider.ts`
 * fixtures on a non-OK (≠401) / timeout / network error from `/api/status`.
 * Without this banner the only signals were a `console.warn` and a
 * `window.__DKG_USING_MOCKS__` flag — so a node operator whose daemon is down
 * sees a healthy-looking dashboard (synced, peers, balances) built entirely
 * from fake data, with no way to tell it isn't live. This makes the fallback
 * unmissable.
 */
export function MockModeBanner() {
  const [usingMocks, setUsingMocks] = useState<boolean>(isUsingMocks());

  useEffect(() => {
    // Reconcile against any detection that completed before mount, then
    // subscribe for the async flip when detection finishes after mount.
    setUsingMocks(isUsingMocks());
    return subscribeMockMode(setUsingMocks);
  }, []);

  if (!usingMocks) return null;

  // Mock mode is latched in api-wrapper for the lifetime of the page (it is
  // detected once, on the first failed /api/status probe). Reconnecting the
  // daemon alone does NOT clear it — the page must reload — so make recovery
  // explicit/actionable rather than promising auto-recovery (Codex).
  return (
    <div className="v10-mock-banner" role="alert" aria-live="polite">
      <span className="v10-mock-banner-dot" aria-hidden="true" />
      <span>
        <strong>Demo data</strong> — the node is unreachable, so the UI is showing
        example data, not live node state. Reconnect the daemon, then reload.
      </span>
      <button
        type="button"
        className="v10-mock-banner-reload"
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  );
}
