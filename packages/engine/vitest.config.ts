import { fileURLToPath } from 'node:url';

import { playwright } from '@vitest/browser-playwright';
import { searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';

import { chromiumLaunchOptions } from '../../tooling/playwright-chromium.ts';

// Engine tests run in a real browser (Vitest browser mode) so that PDFium's WASM, workers
// and OPFS behave exactly as in production. See docs/ARCHITECTURE.md §8.
export default defineConfig({
  server: {
    fs: {
      // PDFium's `.wasm` is served straight from node_modules; with pnpm that lives at the
      // workspace root, outside this package.
      allow: [searchForWorkspaceRoot(fileURLToPath(new URL('.', import.meta.url)))],
    },
  },
  // `@embedpdf/pdfium` locates its binary with `new URL('pdfium.wasm', import.meta.url)`.
  // Pre-bundling was verified not to break that under Vite 8, so it is left enabled. If it
  // ever does, add: optimizeDeps: { exclude: ['@embedpdf/pdfium', '@embedpdf/engines'] }.
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    passWithNoTests: true,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: chromiumLaunchOptions() }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
