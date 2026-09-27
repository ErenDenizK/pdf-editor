import { fileURLToPath } from 'node:url';

import { paraglideVitePlugin } from '@inlang/paraglide-js';
import babel from '@rolldown/plugin-babel';
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

/** Escapes a string for use inside a RegExp. */
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default defineConfig({
  base,
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
        name: 'pdf-editor',
        short_name: 'pdf-editor',
        description:
          'A PDF editor that runs entirely in your browser. Files never leave your device.',
        start_url: base,
        scope: base,
        display: 'standalone',
        lang: 'en',
        theme_color: '#101215',
        background_color: '#0a0b0d',
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
        globIgnores: ['**/*.wasm', '404.html'],
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
        runtimeCaching: [
          {
            // Content-hashed engine wasm: fetched once, then served from cache.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.endsWith('.wasm'),
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
  },
  build: {
    // Never inline fonts or wasm as data: URLs: the CSP allows `font-src 'self'` only, and
    // a data: font (Vite inlined a 2 KB subset once) is silently blocked.
    assetsInlineLimit: (filePath) =>
      /\.(woff2?|ttf|otf|wasm)$/.test(filePath) ? false : undefined,
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        // Static "not found" page for GitHub Pages. Built as an HTML entry (not copied from
        // `public/`) so that `%BASE_URL%` is substituted; no SPA redirect trick (ADR-0004).
        notFound: fileURLToPath(new URL('./404.html', import.meta.url)),
      },
    },
  },
});
