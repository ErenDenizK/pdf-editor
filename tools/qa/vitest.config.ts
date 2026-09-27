import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { playwright } from '@vitest/browser-playwright';
import { searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';

import { chromiumLaunchOptions } from '../../tooling/playwright-chromium.ts';

function packageVersion(name: string): string {
  const url = new URL(`./node_modules/${name}/package.json`, import.meta.url);
  const { version } = JSON.parse(readFileSync(url, 'utf8')) as { version: string };
  return version;
}

const root = fileURLToPath(new URL('.', import.meta.url));
/** Optional directory for crops of every non-ok matrix region (e.g. a CI artifact). */
const evidenceDir = process.env.QA_MATRIX_EVIDENCE_DIR
  ? resolve(root, process.env.QA_MATRIX_EVIDENCE_DIR)
  : '';

// Both files are tools, not tests (`pnpm test` does not run them); each script picks one:
// - make-annotation-sample.ts (`sample`) writes the sample with the app's PDFium adapter,
//   which runs where the app runs: in a browser (EmbedPDF's worker, WASM).
// - annotation-matrix.ts (`matrix`) renders the sample with that adapter and with pdf.js
//   (canvas plus its annotation layer, screenshotted, hence the fixed viewport) and checks it.
// Vitest's built-in `commands.readFile` / `writeFile` read and write under docs/qa (inside
// the workspace root, which `server.fs.allow` opens). The browser runs in UTC so that no
// date in the sample can depend on the machine's time zone.
export default defineConfig({
  define: {
    __PDFIUM_PACKAGE_VERSION__: JSON.stringify(packageVersion('@embedpdf/pdfium')),
    __MATRIX_EVIDENCE_DIR__: JSON.stringify(evidenceDir),
  },
  // Pre-bundled up front: discovering them mid-run makes Vite reload the page.
  optimizeDeps: {
    include: ['pdfjs-dist/legacy/build/pdf.mjs', 'pdfjs-dist/legacy/web/pdf_viewer.mjs'],
  },
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(root), ...(evidenceDir ? [evidenceDir] : [])],
    },
  },
  test: {
    include: ['make-annotation-sample.ts', 'annotation-matrix.ts'],
    testTimeout: 60_000,
    browser: {
      enabled: true,
      headless: true,
      viewport: { width: 1700, height: 1700 },
      screenshotFailures: false,
      provider: playwright({
        launchOptions: chromiumLaunchOptions(),
        contextOptions: { timezoneId: 'UTC', locale: 'en-US' },
      }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
