import { defineConfig, devices } from '@playwright/test';

import { chromiumLaunchOptions } from '../../tooling/playwright-chromium.ts';

// End-to-end tests run against the production build served by `vite preview`, under the
// same base path that GitHub Pages will use (VITE_BASE_PATH, default `/`).
const basePath = process.env.VITE_BASE_PATH ?? '/';
const port = Number(process.env.E2E_PORT ?? 4173);
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  ...(isCI ? { workers: 1 } : {}),
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: new URL(basePath, `http://localhost:${port}`).href,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: chromiumLaunchOptions() },
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    // Build first so the tests exercise exactly what is deployed; `pnpm build` in CI has
    // already produced `dist/`, and E2E_SKIP_BUILD=1 reuses it.
    command: `${process.env.E2E_SKIP_BUILD ? '' : 'pnpm build && '}pnpm preview --port ${port} --strictPort`,
    url: new URL(basePath, `http://localhost:${port}`).href,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
