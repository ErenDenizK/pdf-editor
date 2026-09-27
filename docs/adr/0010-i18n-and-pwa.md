# ADR-0010: i18n with Paraglide JS, offline with vite-plugin-pwa

**Status:** accepted · **Date:** 2026-09-27

## Context

ARCHITECTURE.md §6–7 name Paraglide JS for messages and vite-plugin-pwa for offline
support (research 03 §4, §7). M0 needs English and Turkish, runtime language switching,
and an installable app that opens PDFs offline on GitHub Pages under `/<repo>/`. The
engine wasm is 4.6 MB; the app shell is ≈ 2.9 MB including all font subsets.

## Decision

**i18n**

- `@inlang/paraglide-js` 2.x with its Vite plugin. Project at `apps/web/project.inlang`,
  catalogs `apps/web/messages/{en,tr}.json` (inlang message format; plural variants use
  `Intl.PluralRules`). The plugin module is loaded from `node_modules`, not a CDN, so
  builds work offline. Compiled output (`src/i18n/paraglide`) is generated, git-ignored
  and rebuilt by Vite, `pnpm i18n`, `typecheck` and `lint`.
- Locale resolution is ours (`src/i18n/locale.ts` overwrites `getLocale`/`setLocale`):
  `?lang=` → saved choice (localStorage) → `navigator.languages` → `en`. `?lang=` is not
  persisted; the palette's Language commands are, and never reload the page.
- A language switch remounts the shell (`LocaleBoundary`). The React Compiler caches JSX
  with no reactive inputs, so `m.*()` calls would otherwise keep the old language. App
  state lives in Zustand stores outside React; the remount costs a repaint.
- `<html lang dir>` follow the locale. Both catalogs ship in the bundle (≈ 29 KiB minified for
  ~230 messages); per-locale splitting is deferred until there are more locales.

**PWA**

- vite-plugin-pwa 1.x, `generateSW`, `registerType: 'prompt'`, `clientsClaim`, no
  `skipWaiting` until the user presses Reload in the "Update available" notice (reloading
  closes open documents). Update checks also run on window focus (throttled to 1/min).
- The manifest lives in `vite.config.ts` (the static `public/manifest.webmanifest` is
  gone); `id`, `start_url`, `scope`, the worker scope and `navigateFallback` all derive
  from Vite `base`. The fallback allowlist is the app's own entry only, so other paths keep
  GitHub Pages' real 404 (ADR-0004).
- **Caching policy.** Precache: HTML, JS (including worker chunks), CSS, manifest icons,
  fonts ≤ 1 MB; `maximumFileSizeToCacheInBytes` = 4 MiB so an unexpectedly large asset
  fails the build. Never precached: `*.wasm` and fonts > 1 MB. Runtime: same-origin
  `.wasm` and fonts via `CacheFirst` + expiration (wasm: 4 entries, fonts: 24, 180 days);
  filenames are content-hashed, so a new engine is a new URL and old entries age out.
  Once the shell is offline-ready the wasm is fetched in idle time (skipped with
  Save-Data) so the first offline session can open files; first paint never waits on it.

## Consequences

- Turkish and English stay in lockstep: a unit test fails when catalogs differ in keys.
  Engineers add English first; untranslated keys fail that test, not the build.
- Offline works after one online visit; `e2e/offline.spec.ts` proves shell + PDF open
  with the network off, under `/` and `/pdf-editor/`.
- A first visit downloads the wasm once even if no PDF is opened.

## Alternatives considered

- i18next / Lingui: larger runtime or macro tooling; Paraglide's typed, tree-shaken
  messages fit a static app. Per-component `useLocale()` subscriptions instead of the
  remount: correct but easy to forget in every component.
- `autoUpdate`: would reload under the user and lose unsaved work.
- Precaching the wasm with a raised size limit: first install would wait on 4.6 MB.
- `@vite-pwa/core`: not stable yet; migrate when it is (research 03 §4).
