import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig } from 'vitest/config';

import { chromiumLaunchOptions } from '../../tooling/playwright-chromium.ts';
import viteConfig from './vite.config.ts';

// Component tests run in a real browser (Vitest browser mode) with the same Vite plugins
// (React, React Compiler, `@` alias) as the application build.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
      setupFiles: ['./test/setup.ts'],
      passWithNoTests: true,
      browser: {
        enabled: true,
        headless: true,
        provider: playwright({ launchOptions: chromiumLaunchOptions() }),
        instances: [{ browser: 'chromium' }],
      },
    },
  }),
);
