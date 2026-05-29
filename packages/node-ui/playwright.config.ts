import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CI = !!process.env.CI;
const PORT = 5173;
const DEVNET_NODE = process.env.DEVNET_NODE || process.env.UI_NODE_ID;

function devServerCommand(projectUsesDevnet: boolean): string {
  if (projectUsesDevnet && DEVNET_NODE) {
    return `cross-env DEVNET_NODE=${DEVNET_NODE} pnpm dev:ui`;
  }
  return 'pnpm dev:ui';
}

export default defineConfig({
  testDir: './e2e/specs',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 1 : undefined,
  timeout: CI ? 30_000 : 15_000,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: `http://localhost:${PORT}/ui/`,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    actionTimeout: CI ? 15_000 : 10_000,
  },

  projects: [
    {
      name: 'mock-ui',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/devnet/**', '**/*.devnet.spec.ts'],
    },
    {
      name: 'devnet-ui',
      use: { ...devices['Desktop Chrome'] },
      testMatch: ['**/devnet/**', '**/*.devnet.spec.ts'],
      timeout: CI ? 120_000 : 60_000,
    },
  ],

  webServer: {
    command: devServerCommand(!!DEVNET_NODE),
    cwd: __dirname,
    port: PORT,
    reuseExistingServer: !CI,
    timeout: CI ? 60_000 : 30_000,
  },
});
