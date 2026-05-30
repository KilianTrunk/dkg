import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CI = !!process.env.CI;
const PORT = 5173;
// Default to node1 ONLY for the Vite proxy. The bootstrap chained
// into `webServer.command` (see e2e/bootstrap-devnet.ts) is responsible
// for ensuring `.devnet/node${DEVNET_NODE}/api.port` exists by the
// time Vite reads its config. Operators can point at a different node
// with `UI_NODE_ID=5 pnpm test:e2e:ui`; bootstrap honours the same
// precedence.
const DEVNET_NODE = process.env.DEVNET_NODE || process.env.UI_NODE_ID || '1';

export default defineConfig({
  testDir: './e2e/specs',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 1 : undefined,
  timeout: CI ? 30_000 : 15_000,
  // JUnit reporter is wired unconditionally so Jenkins (and any other
  // JUnit-aware CI) finds `packages/node-ui/results.xml` regardless of
  // whether `CI` is exported. The `github` reporter only fires when CI
  // is true so local runs stay quiet.
  reporter: CI
    ? [['github'], ['html', { open: 'never' }], ['junit', { outputFile: 'results.xml' }]]
    : [['list'], ['junit', { outputFile: 'results.xml' }]],

  // globalTeardown stops the devnet ONLY if our bootstrap script
  // (chained into webServer.command below) was the one that started
  // it -- see e2e/global-teardown.ts. Idempotent; safe to re-run; an
  // operator who had a devnet up before the run keeps it.
  //
  // We deliberately do NOT use Playwright's `globalSetup` for the
  // bootstrap: globalSetup and webServer run in PARALLEL, so Vite
  // would still race ahead of the devnet boot and crash on the
  // missing `.devnet/node${N}/api.port`. Chaining the bootstrap
  // INTO the webServer command gives us deterministic ordering via
  // the shell.
  globalTeardown: resolve(__dirname, 'e2e/global-teardown.ts'),

  use: {
    baseURL: `http://localhost:${PORT}/ui/`,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    actionTimeout: CI ? 15_000 : 10_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    // `bootstrap-devnet.ts` is idempotent: it reuses a running devnet
    // (operator already had one up) or spawns a fresh one and writes
    // an ownership marker that global-teardown.ts honours. Cold-start
    // can take 45-90s -- the webServer timeout below has to be wide
    // enough to cover bootstrap + Vite serving + initial proxy round
    // trip (default 5min on CI, 3min locally).
    command:
      `pnpm exec tsx e2e/bootstrap-devnet.ts && cross-env DEVNET_NODE=${DEVNET_NODE} pnpm dev:ui`,
    cwd: __dirname,
    port: PORT,
    reuseExistingServer: !CI,
    timeout: CI ? 300_000 : 180_000,
  },
});
