import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig } from 'vitest/config';

import { chromiumLaunchOptions } from '../../tooling/playwright-chromium.ts';
import viteConfig from './vite.config.ts';

// Component tests run in a real browser (Vitest browser mode) with the same Vite plugins
// (React, React Compiler, `@` alias) as the application build.
export default mergeConfig(
  viteConfig,
  defineConfig({
    // Pre-bundle every dependency the tests reach lazily (engine wasm loader, fontkit,
    // fflate, the UI primitives). Discovering one mid-run makes Vite reload the browser,
    // which times out whichever test iframe is starting at that moment (seen in CI).
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        '@base-ui/react',
        '@testing-library/react',
        '@embedpdf/pdfium',
        '@pdf-editor/engine > @embedpdf/engines',
        '@pdf-editor/engine > @embedpdf/engines/pdfium-worker-engine',
        '@cantoo/pdf-lib',
        // Dependencies reached only through the linked engine package resolve from its
        // own node_modules, so they must be named as nested entries.
        '@pdf-editor/engine > fflate',
        '@pdf-editor/engine > @cantoo/fontkit',
        '@pdf-editor/engine > @cantoo/pdf-lib',
        '@pdf-editor/engine > comlink',
        'zustand',
        '@tanstack/react-virtual',
        '@atlaskit/pragmatic-drag-and-drop-hitbox/list-item',
      ],
    },
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
