import { fileURLToPath } from 'node:url';

import { playwright } from '@vitest/browser-playwright';
import { searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';

import { chromiumLaunchOptions } from '../../tooling/playwright-chromium.ts';

// Browser half of spike S2 (Q5): the same modules in a Chromium page and in a dedicated
// module worker. Needs `pnpm run spike:node` first (it writes the test PKI under
// test-results/pki); `commands.readFile` reads it and the corpus from the workspace.
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  optimizeDeps: { include: ['pkijs', 'asn1js', '@cantoo/pdf-lib'] },
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(root)],
      // Vite 8 denies *.{crt,pem,key,p12,pfx,cer,der} by default, which also blocks
      // `commands.readFile` on the test .p12 files; only .p12 is re-allowed here.
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
  test: {
    include: ['spikes/*.browser.ts'],
    testTimeout: 120_000,
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      provider: playwright({ launchOptions: chromiumLaunchOptions() }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
