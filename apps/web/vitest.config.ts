import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig } from 'vitest/config';

import { chromiumLaunchOptions } from '../../tooling/playwright-chromium.ts';
import viteConfig from './vite.config.ts';

// Component tests run in a real browser (Vitest browser mode) with the same Vite plugins
// (React, React Compiler, `@` alias) as the application build.
export default mergeConfig(
  viteConfig,
  defineConfig({
    server: {
      fs: {
        // Vite 8 denies *.{crt,pem,key,p12,pfx,cer,der} by default; the signature tests read
        // the test-only .p12 files in test/fixtures/pki, so only .p12 is re-allowed (as in
        // packages/engine/vitest.config.ts).
        deny: [
          '.env',
          '.env.*',
          '*.{crt,pem,key,pfx,cer,der}',
          '.npmrc',
          '.yarnrc.yml',
          '**/.git/**',
        ],
      },
    },
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
        // The paragraph layout (main thread, text-edit/ParagraphEditor.tsx); CommonJS.
        '@pdf-editor/engine > linebreak',
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
        provider: playwright({ launchOptions: process.env.DIAG_KEEP_PARTITIONING ? { ...chromiumLaunchOptions(), ignoreDefaultArgs: ['--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion'], args: ['--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion'] } : chromiumLaunchOptions() }),
        instances: [{ browser: 'chromium' }],
      },
    },
  }),
);
