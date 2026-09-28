# ADR-0012: OCR engine hosting and language packs

**Status:** accepted · **Date:** 2026-09-28

 ## Context

 M5 OCR (spec §1) must run offline under ADR-0004's CSP.
tesseract.js 7 defaults to jsDelivr and a `blob:` worker; its worker cannot take our pack bytes
without a one-token fix; Emscripten finds the `.wasm` beside the worker; a meta CSP does not
bind the worker (research 07).


## Decision

1. Engine: tesseract.js 7.0.0 + tesseract.js-core 7.0.0, LSTM-only (`oem 1`). `worker.min.js`
   carried with a pnpm patch (`l.data` → `l.code` in `initialize`) until upstream fixes it; the
   build asserts the patch site.
2. Hosting: `ocr/tesseract-<version>/` holds `worker.min.js` and the `lstm`, `simd-lstm`,
   `relaxedsimd-lstm` `.js` + `.wasm` files, unhashed (the version is the directory). The page
   picks the variant with `WebAssembly.validate` probes and always passes `workerBlobURL: false`,
   `workerPath`, `corePath` and `cacheMethod: 'none'`. The API is a lazy chunk.
3. Packs: tessdata_fast at a pinned commit, fetched by a script, gzipped, SHA-256 per file in
   `packages/engine/ocr/langs.lock.json`, committed like the qpdf artifact and re-verified in CI;
   served as `ocr/lang/<code>.traineddata.gz`. Set: eng, tur, then deu fra spa ita por nld rus.
   Our loader fetches, sniffs gzip, inflates with `DecompressionStream`, and hands
   `{ code, data }` to the worker. Local import: `.traineddata[.gz]` into OPFS; no remote URLs.
4. Caching (amends ADR-0010): nothing under `ocr/` is precached; a `pdf-editor-ocr` CacheFirst
   runtime cache, matched before the `.wasm` rule, which excludes `/ocr/`; packs and the core
   are added on first use or by "Keep available offline"; old versions deleted by the loader.
5. Raster input is 8-bit PGM from the PDFium worker; the invisible layer uses Tesseract's
   `pdf.ttf` (Apache-2.0), one text object per word.
6. Licences: `NOTICE` lists tesseract.js, Tesseract, Leptonica, libpng, zlib, IJG libjpeg,
   libtiff, libwebp, giflib and tessdata/pdf.ttf; this ADR accepts the zlib, libpng, IJG,
   libtiff and giflib licences under ADR-0001's permissive policy.
7. Guarantee: an e2e test with a Playwright request log asserts zero non-self requests
   during OCR, and offline OCR after "Keep available offline".


## Consequences

 First use downloads ~3.1 MB (one language, compressed host); each further
language ~2 MB. A patched third-party file is kept until upstream releases a fix. Accuracy on
degraded scans is limited (≈ 90% at scan150 quality) and shown as Review/Poor. Revisit best_int
only if F's real scans show ≥ 2 points.


## Alternatives considered

 Stock worker with `langPath` on our origin (works, but no local import and no
progress of our own); single-file `.wasm.js` (+0.36 MB compressed, no streaming compile;
fallback if the host does not compress wasm); `4.0.0_best_int` (slower, larger, not more
accurate here); `rotateAuto` (deskewed coordinates, +27% time).
