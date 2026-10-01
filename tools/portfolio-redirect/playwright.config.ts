import { defineConfig } from '@playwright/test';

import { chromiumLaunchOptions } from '../../tooling/playwright-chromium.ts';

// The redirect folder's end-to-end test (README.md). Each test starts its own static server
// on a free localhost port (e2e/site.ts), so there is no webServer here. Chromium only:
// the test is about the kill switch's effect on a registered worker and its caches.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    launchOptions: chromiumLaunchOptions(),
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
});
