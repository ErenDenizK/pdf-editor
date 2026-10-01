import { defineConfig } from '@playwright/test';

import { chromiumLaunchOptions } from '../../tooling/playwright-chromium.ts';
import { HERMETIC_ARGS } from './lib/browser.ts';
import { viewportOptions } from './lib/viewport.ts';

// Media scenes (docs/specs/presentation.md §2) run against the production build served by
// `vite preview`, on a port of their own so a running e2e server (4173) is never reused by
// mistake. MEDIA_SKIP_BUILD=1 reuses apps/web/dist, like E2E_SKIP_BUILD in the e2e config.
const port = Number(process.env.MEDIA_PORT ?? 4180);
const origin = `http://localhost:${port}`;
const build = process.env.MEDIA_SKIP_BUILD ? '' : 'pnpm --filter @pdf-editor/web build && ';
// 1440 × 900 at 2x: a real 2x window by default, since an emulated scale factor gives 1x
// screencast frames (lib/viewport.ts).
const { args, ...viewport } = viewportOptions();

export default defineConfig({
  testDir: './scenes',
  testMatch: /\.(still|clip)\.ts$/,
  // One browser at a time: parallel scenes would compete for the CPU and drop frames.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  // Clips hold on their results and the first visit installs the service worker.
  timeout: 120_000,
  reporter: [['list']],
  outputDir: './out/test-results',
  globalSetup: './lib/global-setup.ts',
  use: {
    baseURL: `${origin}/`,
    browserName: 'chromium',
    launchOptions: { ...chromiumLaunchOptions(), args: [...args, ...HERMETIC_ARGS] },
    ...viewport,
    timezoneId: 'UTC',
    locale: 'en-US',
    colorScheme: 'dark',
    // The scenes record themselves (lib/recorder.ts); Playwright's own artifacts stay off.
    video: 'off',
    trace: 'off',
    screenshot: 'off',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: `${build}pnpm --filter @pdf-editor/web preview --port ${port} --strictPort`,
    url: `${origin}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
