import { fileURLToPath } from 'node:url';

import { playwright } from '@vitest/browser-playwright';
import { searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';

import { chromiumLaunchOptions } from '../../tooling/playwright-chromium.ts';

// The sample is written by the app's PDFium adapter, which runs where the app runs: in a
// browser (EmbedPDF's worker, WASM). Vitest browser mode provides that, and its built-in
// `commands.writeFile` saves the result into docs/qa/samples (inside the workspace root,
// which `server.fs.allow` opens). This is a tool, not a test: `pnpm test` does not run it.
export default defineConfig({
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(fileURLToPath(new URL('.', import.meta.url)))],
    },
  },
  test: {
    include: ['make-annotation-sample.ts'],
    testTimeout: 60_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: chromiumLaunchOptions() }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
