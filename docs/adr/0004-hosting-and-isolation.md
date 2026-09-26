# ADR-0004: Static hosting, workers, and no cross-origin isolation

**Status:** proposed · **Date:** 2026-09-26

## Context

GitHub Pages cannot set HTTP headers, so `Cross-Origin-Opener-Policy` /
`Cross-Origin-Embedder-Policy` are unavailable and therefore `SharedArrayBuffer` and
WASM threads are unavailable. The only workaround is a service worker that injects the
headers (`coi-serviceworker`), which costs a first-load reload, breaks in Firefox private
mode, and needs `require-corp` plus CORP headers on every asset for Safari. Neither PDFium
nor pdf.js nor MuPDF ships threaded WASM builds; PDFium is not thread-safe anyway.
Site limit 1 GB, 10-minute `Cache-Control`, project sites live under `/repo/`.

## Decision

- Deploy with GitHub Actions (`upload-pages-artifact@v3` + `deploy-pages@v4`) from
  `main`; PR builds produce a downloadable preview artifact.
- **Single-threaded WASM in dedicated Web Workers**; parallelism across documents by
  running one worker per document plus a bounded pool for exports and thumbnails.
  Transfer `ArrayBuffer`s and `ImageBitmap`s, never copy.
- **No cross-origin isolation in v1.** `coi-serviceworker` is documented as an optional
  enhancement if a threaded component ever appears.
- Vite `base` derived from the repository name in CI; every path-dependent setting
  (manifest `scope`/`start_url`/`id`, service worker, worker URLs, WASM URLs) derives from it.
  Hash routing or no routing; no `404.html` redirect trick.
- Content-hashed filenames for all assets; large WASM excluded from precache and
  runtime-cached; `registerType: 'prompt'` for updates.
- Strict CSP via `<meta http-equiv>` (no headers available): `default-src 'self'`,
  `connect-src 'self'`, `worker-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`,
  `img-src 'self' blob: data:`, `font-src 'self'`, `object-src 'none'`.
- Recommend a custom domain before v1.0 to avoid shared-origin storage and service
  worker clashes with other project sites on the same `github.io` origin.

## Consequences

- Any single-document operation is bounded by one core and a ~2 GiB WASM heap; we design
  for streaming exports and ~1 GB per document as the ceiling.
- No first-visit reload, no Safari CORP headaches, no private-mode breakage.
- If a future feature needs threads (e.g. a Rust component with rayon), it must be an
  opt-in path with a fallback.
