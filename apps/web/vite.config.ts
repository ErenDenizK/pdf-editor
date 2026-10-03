import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { paraglideVitePlugin } from '@inlang/paraglide-js';
import babel from '@rolldown/plugin-babel';
import { ocrAssetsPlugin } from '@pdf-editor/engine/ocr/assets';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves project sites under `/<repo>/`; CI sets VITE_BASE_PATH accordingly
// (ADR-0004). Every path-dependent setting must derive from `base`.
const base = process.env.VITE_BASE_PATH ?? '/';

/** Precache ceiling. Wasm is never precached; this only bounds JS chunks (the engine
 *  chunk is ~1.3 MB) so an accidental multi-megabyte asset fails the build (ADR-0010). */
const MAX_PRECACHE_BYTES = 4 * 1024 * 1024;
/** Fonts above this size are runtime-cached instead of precached (ADR-0010). */
const MAX_PRECACHED_FONT_BYTES = 1024 * 1024;
const DAY_SECONDS = 24 * 60 * 60;

/**
 * `@embedpdf/engines` declares no `sideEffects`, so importing `PdfiumNative` and `PdfEngine`
 * from its root (the PDFium host, ADR-0011) would keep everything the root re-exports:
 * EmbedPDF's own blob-worker engine (~700 KB, a second copy of the PDFium glue) and its CDN
 * font tables, which the app never uses. Its modules only declare classes and functions, so
 * unused ones can be dropped. Other modules keep their default side-effect handling.
 */
const EMBEDPDF_ENGINES_PURE = [{ test: /[\\/]@embedpdf[\\/]engines[\\/]/, sideEffects: false }];

/**
 * Build identity for the About dialog (ADR-0017 §6), injected as `define` constants and
 * read through `src/shell/about/build-info.ts`. The version is the web package's, which the
 * release workflow tags.
 */
const appVersion = (
  JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/** The about page's footer reads the version as `%VITE_APP_VERSION%`; CI may set it. */
process.env.VITE_APP_VERSION ??= appVersion;

/**
 * The about page links to the sources of the build it ships with (`%VITE_SOURCE_REF%` in
 * `about/index.html`): the full commit SHA, so the links hold whatever the branches do. CI's
 * `GITHUB_SHA`, else the checkout's HEAD, else the development branch.
 */
process.env.VITE_SOURCE_REF ??= sourceRef();

/** Full SHA of the built commit, else `develop` (no commit is known outside a checkout). */
function sourceRef(): string {
  const fromCi = process.env.GITHUB_SHA?.trim();
  if (fromCi) return fromCi;
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha === '' ? 'develop' : sha;
  } catch {
    return 'develop';
  }
}

/** Short SHA of the built commit: CI's `GITHUB_SHA`, else the checkout's HEAD, else "unknown". */
function appCommit(): string {
  const fromCi = process.env.GITHUB_SHA?.trim();
  if (fromCi) return fromCi.slice(0, 7);
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha === '' ? 'unknown' : sha;
  } catch {
    // Not a git checkout (e.g. a source tarball) or git is not installed.
    return 'unknown';
  }
}

/** ISO 8601 build time. `SOURCE_DATE_EPOCH` (seconds) pins it for reproducible builds. */
function buildDate(): string {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  const date =
    process.env.SOURCE_DATE_EPOCH && Number.isFinite(epoch) ? new Date(epoch * 1000) : new Date();
  return date.toISOString();
}

/** Escapes a string for use inside a RegExp. */
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default defineConfig({
  base,
  // Declared in src/pwa/env.d.ts; values are JSON so they replace as string literals.
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_COMMIT__: JSON.stringify(appCommit()),
    __BUILD_DATE__: JSON.stringify(buildDate()),
  },
  plugins: [
    react(),
    // React Compiler (ADR-0003), applied through Babel. Rolldown's filter in the preset
    // limits Babel to files that can contain components or hooks.
    babel({ presets: [reactCompilerPreset()] }),
    // Compiled, typed messages (ADR-0010). Locale resolution is ours (src/i18n/locale.ts
    // overwrites getLocale/setLocale), so the runtime keeps only the base-locale fallback.
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/i18n/paraglide',
      strategy: ['baseLocale'],
      emitReadme: false,
      // Same output as `pnpm i18n` (typecheck and lint run it without Vite).
      emitTsDeclarations: true,
    }),
    // OCR engine and language packs (ADR-0012 §2–§3): serves `ocr/**` in dev and emits it
    // into dist/ocr/ unhashed (`tesseract-<version>/` worker and cores,
    // `lang/<code>.traineddata.gz`), each file checked against
    // packages/engine/ocr/langs.lock.json. Never precached (below).
    ocrAssetsPlugin(),
    // Offline support (ARCHITECTURE.md §7, ADR-0010). Disabled under Vitest, where
    // `virtual:pwa-register` resolves to a no-op and no service worker is generated.
    VitePWA({
      disable: Boolean(process.env.VITEST),
      registerType: 'prompt',
      // Registered by src/pwa/register.ts, which owns the update flow.
      injectRegister: false,
      strategies: 'generateSW',
      // `scope`, `start_url` and `id` all equal Vite's `base`, so a project site at
      // /<repo>/ and a custom domain at / both install correctly.
      manifest: {
        id: base,
        name: 'Recto',
        short_name: 'Recto',
        description:
          'A PDF editor that runs entirely in your browser. Files never leave your device.',
        start_url: base,
        scope: base,
        display: 'standalone',
        lang: 'en',
        theme_color: '#181a1f',
        background_color: '#08090b',
        icons: [
          { src: 'icons/glyph.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          {
            src: 'icons/app-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // App shell: HTML, JS (including worker and engine chunks), CSS and fonts. The
        // manifest and its icons are added by the plugin (`includeManifestIcons`).
        globPatterns: ['**/*.{html,js,css,woff2}'],
        // Wasm is runtime-cached (below); the 404 page is not part of the app shell.
        // `worker-engine-*.js` is EmbedPDF's own worker engine, the adapter's lazy default
        // factory: the app always passes a factory (ADR-0011), so it is never loaded. `ocr/`
        // (tesseract's worker, cores and ~22 MB of packs) downloads only when OCR is used
        // (ADR-0012 §4).
        // `media/` (the about page's clips, posters and the media run's request log) is added
        // to the site by the deploy job and is never precached (presentation spec §2.6).
        globIgnores: ['**/*.wasm', '404.html', '**/worker-engine-*.js', 'ocr/**', 'media/**'],
        maximumFileSizeToCacheInBytes: MAX_PRECACHE_BYTES,
        manifestTransforms: [
          (entries) => {
            const fonts = /\.(woff2?|ttf|otf)$/;
            const manifest = entries.filter(
              (entry) => !(fonts.test(entry.url) && entry.size > MAX_PRECACHED_FONT_BYTES),
            );
            return Promise.resolve({ manifest, warnings: [] });
          },
        ],
        // Resolved against the service worker URL, so it honours `base`. Only the app's
        // own entry (with any query, e.g. ?lang=tr) falls back; other paths keep their
        // real 404 (ADR-0004: no SPA redirect trick).
        navigateFallback: 'index.html',
        navigateFallbackAllowlist: [new RegExp(`^${escapeRegExp(base)}(index\\.html)?(\\?.*)?$`)],
        // Take control on first install so the first session is cached too. Updates
        // still wait for the user (registerType 'prompt').
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Match callbacks are serialized into the service worker, so they cannot close over
        // `base`: `location` there is the worker script's URL, which sits at `base`.
        runtimeCaching: [
          {
            // OCR (ADR-0012 §4): the versioned tesseract directory and the language packs,
            // added on first use or by "Keep available offline" (the pack loader writes the
            // same cache and deletes old versions). No expiration: evicting a pack the user
            // kept offline would silently break offline OCR. Matched before the wasm rule.
            urlPattern: ({ url }) => url.href.startsWith(new URL('ocr/', location.href).href),
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdf-editor-ocr',
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Content-hashed engine wasm: fetched once, then served from cache. The OCR cores
            // are not (their cache is above), so they cannot evict PDFium or qpdf.
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin &&
              url.pathname.endsWith('.wasm') &&
              !url.href.startsWith(new URL('ocr/', location.href).href),
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdf-editor-wasm',
              expiration: { maxEntries: 4, maxAgeSeconds: 180 * DAY_SECONDS },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Fonts too large to precache.
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && /\.(woff2?|ttf|otf)$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdf-editor-fonts',
              expiration: { maxEntries: 24, maxAgeSeconds: 180 * DAY_SECONDS },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
    rolldownOptions: { treeshake: { moduleSideEffects: EMBEDPDF_ENGINES_PURE } },
  },
  build: {
    // Never inline fonts or wasm as data: URLs: the CSP allows `font-src 'self'` only, and
    // a data: font (Vite inlined a 2 KB subset once) is silently blocked.
    assetsInlineLimit: (filePath) =>
      /\.(woff2?|ttf|otf|wasm)$/.test(filePath) ? false : undefined,
    rolldownOptions: {
      treeshake: { moduleSideEffects: EMBEDPDF_ENGINES_PURE },
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        // Static "not found" page for GitHub Pages. Built as an HTML entry (not copied from
        // `public/`) so that `%BASE_URL%` is substituted; no SPA redirect trick (ADR-0004).
        notFound: fileURLToPath(new URL('./404.html', import.meta.url)),
        // The about page (presentation spec §3): plain HTML and CSS beside the app, built to
        // about/index.html. It loads none of the app's code.
        about: fileURLToPath(new URL('./about/index.html', import.meta.url)),
      },
    },
  },
});
