/**
 * SPIKE S1 (M5): not product code. Runs the evidence for docs/research/07-ocr-spike.md.
 * Not part of `pnpm test`; run it explicitly:
 *
 *   pnpm --filter @pdf-editor/ocr-spike spike              # everything (~30 min)
 *   pnpm --filter @pdf-editor/ocr-spike spike csp-offline  # one file
 *
 * Two projects:
 * - `csp` (Node): csp-offline.spike.ts starts its own static server and drives Playwright
 *   Chromium itself, so it can log every request and set the browser offline.
 * - `browser` (Vitest browser mode, Chromium): the accuracy / timing matrix and the
 *   invisible-layer check, which need the app's PDFium adapter (EmbedPDF WASM) in a browser.
 *   `node_modules/.spike-downloads/public` (assets.ts) is Vite's public dir, so the OCR files are served as they are.
 *
 * `rendererMemory` is a browser command that reads the RSS of Chromium's renderer
 * processes from /proc (Linux only): tesseract's workers live in the renderer process, and
 * their WASM heaps are not visible to any page API.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';

import { playwright } from '@vitest/browser-playwright';
import { searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';

import { chromiumLaunchOptions } from '../../tooling/playwright-chromium.ts';
import { ensureAssets, PUBLIC_DIR, SPIKE_ROOT } from './assets.ts';

interface RendererMemory {
  readonly rssMiB: number;
  readonly peakMiB: number;
}

/** Sum of VmRSS and of VmHWM over Chromium renderer processes. */
function rendererMemory(): RendererMemory {
  let rss = 0;
  let peak = 0;
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmdline.includes('--type=renderer')) continue;
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      rss += Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
      peak += Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0);
    } catch {
      // The process exited while we read it.
    }
  }
  return { rssMiB: Math.round(rss / 1024), peakMiB: Math.round(peak / 1024) };
}

export default defineConfig(() => {
  ensureAssets();
  return {
    publicDir: PUBLIC_DIR,
    optimizeDeps: {
      include: ['pdfjs-dist/legacy/build/pdf.mjs', 'tesseract.js'],
    },
    server: {
      fs: { allow: [searchForWorkspaceRoot(SPIKE_ROOT)] },
    },
    test: {
      projects: [
        {
          extends: true,
          test: {
            name: 'csp',
            include: ['csp-offline.spike.ts'],
            environment: 'node',
            testTimeout: 120_000,
          },
        },
        {
          extends: true,
          test: {
            name: 'browser',
            include: ['ocr-accuracy.spike.ts', 'ocr-layer.spike.ts'],
            testTimeout: 1_800_000,
            hookTimeout: 120_000,
            browser: {
              enabled: true,
              headless: true,
              screenshotFailures: false,
              provider: playwright({ launchOptions: chromiumLaunchOptions() }),
              instances: [{ browser: 'chromium' as const }],
              commands: {
                rendererMemory: () => rendererMemory(),
                // Recorded with every result file: the spike ran on a shared machine.
                hostLoad: () => ({
                  loadavg: loadavg().map((v) => Math.round(v * 100) / 100),
                  cpus: cpus().length,
                  cpu: cpus()[0]?.model ?? '',
                }),
              },
            },
          },
        },
      ],
    },
  };
});
