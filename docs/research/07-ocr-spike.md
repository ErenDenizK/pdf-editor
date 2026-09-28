---
title: "Research: OCR spike S1 (tesseract.js 7 offline, accuracy, invisible layer) for M5 §1"
date: 2026-09-28
status: snapshot
---

> Spike S1 of `docs/specs/recognize-and-compare.md` §8.1, run on 2026-09-28 against
> tesseract.js 7.0.0, tesseract.js-core 7.0.0, tessdata_fast `87416418`, `@tesseract.js-data/*`
> 1.0.0 (`4.0.0_best_int`), `@embedpdf/pdfium` 2.15.1, `@cantoo/pdf-lib` 2.11.1, pdfjs-dist
> 6.3.289. Evidence: `tools/ocr-spike/` (`pnpm --filter @pdf-editor/ocr-spike spike`, ~25 min;
> results in `tools/ocr-spike/results/`, git-ignored). **Chromium 141 only** (headless, Linux):
> Firefox and WebKit are not installed here. Machine: 4 vCPU Xeon @ 2.1 GHz, shared with other
> jobs (load average 2–6 during runs, recorded in every result file); times are indicative.

# OCR spike: offline tesseract.js, accuracy, invisible layer

## 1. Offline from our origin under the app's exact CSP

`csp-offline.spike.ts` serves a page whose CSP meta is read verbatim from `apps/web/index.html`,
drives Chromium with Playwright, logs every request twice (Playwright incl. dedicated-worker
requests; our server) and aborts anything off-origin. 15 scenarios, all pass.

| Scenario | Result |
|---|---|
| tesseract.js defaults | `blob:` worker refused (`worker-src`); nothing fetched |
| `workerBlobURL: false` only | `new Worker(cdn.jsdelivr…)` throws (cross-origin worker); nothing fetched |
| our worker + core + `{ code, data }` pack, **stock** `worker.min.js` | never initialises: `"initialization failed"` (bug below) |
| same with the one-token patched worker | OCR correct, **0 non-self requests, 0 violations** |
| `.js`+`.wasm` / single-file `.wasm.js` / directory `corePath` | all work; the directory form makes tesseract.js pick a `.wasm.js` |
| stock worker, pack by `langPath` on our origin | works (the worker fetches the pack itself) |
| worker in `split/worker/`, core in `split/core/` | hangs: the `.wasm` is requested at `split/worker/…wasm` (3 × 404) |
| page `fetch` to a foreign origin / same fetch from a same-origin worker | page blocked (`connect-src`); **worker allowed** |
| first use online, then `setOffline(true)` behind a CacheFirst service worker | second run correct with **0 server hits** (worker `importScripts`, `.wasm` and pack all served by the SW) |

Findings the spec did not have:

1. **tesseract.js bug:** `initialize` joins `l.data` instead of `l.code` for `{ code, data }`
   languages (`src/worker-script/index.js`; still on master `a1ca80d9`). Our own bytes can only
   be used with a patched worker: `return"string"==typeof t?t:t.data}` → `…t.code}` in
   `dist/worker.min.js` (exactly one site; `assets.ts` asserts it).
2. **The `.wasm` is found next to the worker, not next to the core:** in a worker the Emscripten
   glue resolves `scriptDirectory` from `self.location`. Worker and cores must share one directory.
3. **A meta CSP does not bind a dedicated worker** (Chromium, measured): the worker has no policy,
   so a missing `corePath`/`langPath` would fetch jsDelivr silently. The request log (e2e) is the
   real guarantee; `workerPath`, `corePath` and the packs must always be explicit.
4. **Vite dev/preview serve `*.gz` with `Content-Encoding: gzip`**: the browser inflates it, so
   the loader must sniff the gzip magic (`1f 8b`) rather than trust the file name.
5. Core variant: the worker's own detection only picks `.wasm.js`. For `.js`+`.wasm` we pass one
   file, chosen with the two `WebAssembly.validate` probes of wasm-feature-detect (inlined, 70 bytes,
   no dependency). Chromium 141 → `relaxedsimd-lstm`. Other browsers not measured.

Start-up on loopback, fresh context, two runs (ms): API chunk 20–65; pack fetched +20–50; worker
ready (core fetch, compile, init) +230–270 with `.js`+`.wasm`, +316–324 with `.wasm.js`; one line
recognised +170–320. Inflating on the main thread with `DecompressionStream` (~40 ms) instead of
tesseract.js's JS inflater in the worker: worker ready +135–175 instead of +248–269. A warm
context was no faster. In the accuracy harness `createWorker` took 125–205 ms (packs in memory).

## 2. Bytes over the wire

Raw / gzip -9 / brotli 11 (bytes, MB = 10⁶). The three LSTM cores differ by < 7 KB.

| File | Raw | gzip | brotli |
|---|---|---|---|
| `tesseract.esm.min.js` (API, lazy chunk) | 63,220 | 0.011 MB | 0.008 MB |
| `worker.min.js` | 111,307 | 0.034 MB | 0.028 MB |
| `tesseract-core-relaxedsimd-lstm.js` (glue) | 89,360 | 0.025 MB | 0.021 MB |
| `tesseract-core-relaxedsimd-lstm.wasm` | 2,862,266 | 1.065 MB | 0.825 MB |
| `tesseract-core-relaxedsimd-lstm.wasm.js` (single file) | 3,905,767 | 1.456 MB | 1.124 MB |
| tessdata_fast `eng` / `tur` | 4,113,088 / 4,550,554 | 1.962 / 1.998 MB | — |
| `4.0.0_best_int` `eng` / `tur` (npm, gz) | 5,199,098 / 4,680,866 | 2.953 / 2.141 MB | — |

First use, one language (fast): **3.10 MB** if the host compresses `.js` and `.wasm`; **4.89 MB**
if it does not compress `application/wasm`; **3.46 MB** with `.wasm.js`. Whether GitHub Pages
compresses `application/wasm` and serves `*.gz` without `Content-Encoding` is **unverified**.

## 3. Accuracy and time (`ocr-accuracy.spike.ts`)

Pages: `simple-text.pdf` p1 (26 words); a dense A4 page in English (586 words) and in Turkish
(450 words, every Turkish letter), Noto Serif 11 pt, both digital and as "scans" (PDFium render at
the scan DPI, rotated, blurred, noised, JPEG, one image per page): **scan300** 1.5°, σ 12, q .85;
**scan200** −0.8°, σ 20, blur .6; **scan150** 2.5°, σ 35, blur 1, q .6; **scan120** 2°, σ 38,
blur 1.1; **scan100** 3°, σ 45, blur 1.2. Pipeline: PDFium adapter `renderPage` → 8-bit grey →
PGM → tesseract.js (one reused worker). Word accuracy = LCS of edge-punctuation-trimmed words
over truth words; "kept" = after dropping words with confidence < 30 (spec §1.3).

| Page (300 dpi) | fast: ms | acc. | kept mean conf | best_int: ms | acc. | kept mean conf |
|---|---|---|---|---|---|---|
| simple-text p1 | 398 | 100 | 95.2 | 419 | 100 | 95.3 |
| en digital / scan300 / scan200 | 3945 / 3858 / 3812 | 99.7 / 100 / 100 | 95.8–96.0 | 5857 / 5412 / 5301 | 100 / 100 / 100 | 95.8–95.9 |
| tr digital / scan300 / scan200 | 3286 / 3293 / 3622 | 100 / 99.3 / 100 | 95.4–95.7 | 5778 / 5346 / 5295 | 100 / 99.1 / 100 | 95.6–95.8 |
| en scan150 | 4670 | 90.3 | 87.3 | 6254 | 91.1 | 87.8 |
| tr scan150 | 4210 | 88.9 | 85.6 | 6160 | 88.2 | 86.5 |
| en / tr scan120 | 3179 / 3184 | 34.5 / 26.7 | 70.2 / 64.1 | 3881 / 4057 | 34.3 / 35.6 | 69.4 / 72.6 |
| en / tr scan100 | **62,378 / 41,105** | 2.2 / 1.1 | 38.7 / 36.6 | **66,060 / 75,616** | 3.4 / 0.9 | 38.9 / 38.3 |
| tr scan300, `tur+eng` | 4115 | 99.1 | 95.5 | 5570 | 98.9 | 95.6 |

- **fast vs best_int:** equal on clean pages; on scan150 best_int is +0.8 (en) and −0.7 (tr)
  points on kept words (+1.8 / −0.5 on all words), below the spec's 2-point rule, while it is
  1.4–1.8× slower and 0.99 MB (eng) / 0.14 MB (tur) larger. **tessdata_fast wins.**
- **DPI:** on every page read at ≥ 99%, 200, 300 and 400 dpi agree within 0.5 points (11 pt
  text); 400 costs +9–41% recognise time and 1.5–2× render time over 300. Render (PDFium, grey conversion) at
  200/300/400: 128–340 / 229–585 / 443–873 ms. Small print (< 9 pt) was not tested.
- `tur+eng` costs +25% time for −0.2 points on a Turkish page.
- **Noise explodes time:** scan100 produced 2,844–4,243 "words" (mostly < 30) in 41–76 s.
  A per-page time budget is needed; tesseract.js cannot abort a job, only `terminate()` the worker.
- **PGM vs PNG** (en scan300, 8.7 MP): PGM encodes in 5 ms (8.7 MB), PNG in 399–460 ms (11.1 MB),
  and recognition from PGM was 4.4 s vs 6.3 s from PNG; identical words. **Pick PGM.**

**Per-word calibration** (all runs, words per confidence band → % correct, fast / best_int):
< 30: 1.1 / 1.0 · 30–49: 5 / 5 · 50–59: 29 / 33 · 60–69: 52 / 51 · 70–79: 77 / 62 ·
80–84: 89 / 78 · 85–89: 87 / 84 · 90–94: 96 / 98 · ≥ 95: 100 / 99.9 (n ≥ 78 per band).

**One vs two recognizers** (fast eng, 8 pages: dense, scan300, scan200, scan150 × 2):
s/page 3.27 → 1.92 (200 dpi), 3.97 → 2.40 (300), 5.24 → 3.24 (400): two workers give 1.6–1.7×
on 4 vCPU. Footprint (renderer RSS with the workers alive minus after `terminate`, noisy):
~90–130 MiB for one recognizer, ~190–350 MiB for two; renderer peak 1.5–1.7 GiB for the whole
harness (PDFium, images, test runner).

**`rotateAuto`** (en scan300, 1.5° applied): detected −1.50°. Box centres vs truth, 586 words:
without it 0.84 pt from the scan's coordinates (5.67 pt from deskewed); with it 0.77 pt from
the **deskewed** coordinates (5.71 pt from the scan's). It adds 27% time (3.9 → 4.9 s) and no
accuracy here. So: do not use it; keep the raster's coordinates and take each line's angle
from `line.baseline` (what the layer below does). If ever used, boxes must be rotated back by
`rotateRadians` about the image centre.

## 4. Invisible text layer (`ocr-layer.spike.ts`, `spike-lib.ts` `addInvisibleLayer`)

Tesseract's `pdf.ttf` (572 bytes, 2 glyphs; GID 1 advance 1024/2048 em, box 0…1024 × 0…2048)
embedded as Type0 / CIDFontType2, Identity-H, `/CIDToGIDMap` → GID 1, `/DW 500`, identity
`ToUnicode`, `/FontBBox [0 0 500 1000]`, `/Ascent 1000`, `/Descent -1` (Tesseract's values). One
Form XObject (tagged `/PdfEditorOCR`) drawn by a `q /PdfEditorOCR0 Do Q` stream appended after
the page content (pdf-lib's normalisation wraps the old content in `q … Q`). Per word: `BT 3 Tr`,
size = the line's row height, `Tm` rotated to the line's baseline slope, origin on the descender
line, `Tz` = box width / (UTF-16 units × 0.5 × size), text = UTF-16BE hex plus a space.
Tested on the 300 dpi scans (1.5° skew), words with confidence ≥ 30:

| Check | eng (586 words) | tur (448 words) |
|---|---|---|
| PDFium `search` (matchCase) finds every distinct word ≥ 3 chars | 124 / 124 | 105 / 105 |
| hit rect vs OCR box, worst edge: median / p95 / max | 0.60 / 1.24 / 1.28 pt | 0.64 / 1.28 / 1.74 pt |
| hit height / OCR box height (median) | 1.35 (row band) | 1.20 |
| render at 150 dpi, pixels differing | 0 of 2,174,960 | 0 of 2,174,960 |
| PDFium `getPageText`: same words | yes; 3 line-end words out of place | yes; 2 out of place |
| pdf.js `getTextContent`: same words | 4 line-end pairs glued | 3 pairs glued |
| Turkish letters (ç ğ ı İ ö ş ü Ç Ğ Ö Ş Ü) in PDFium and pdf.js | — | all 12 |
| layer size (Flate) | 12.1 KB (≈ 21 B/word) | 10.2 KB |

The misplaced words are all at line ends on the skewed page: a 1.5° line drops ~12.6 pt over
its width, so its last word sits within ~3 pt of the next line's start and both readers treat
them as one line (pdf.js also drops our explicit space there). A variant with one `TJ` per line
fixed PDFium's order but moved word ends (median 1.7–2.1 pt, p95 5.6–6.9 pt, only 50–59% of
hits within 2 pt) and pdf.js then glued most words: **keep one text object per word**
(Tesseract's own layout) and accept the line-end effect on skewed pages. PDFium's case-insensitive
search folds `istanbul`/`ISTANBUL` to `İstanbul` but not `ışık` to `Işık` (a search-UI note).

## 5. Licences (for `NOTICE`)

Core submodules at tag v7.0.0 (`acffef2b`), licence files read at the pinned commits; presence
in the `.wasm` confirmed by strings (libpng, zlib, JPEG, WebP, GIF, TIFF, Leptonica, Tesseract).

| Component (commit) | Version | Licence |
|---|---|---|
| tesseract.js / tesseract.js-core | 7.0.0 | Apache-2.0 |
| Tesseract fork `Balearica/tesseract` (`2a9c1c49`) | `5.1.0-288-g2a9c1` | Apache-2.0 |
| Leptonica (`4af068b5`) | 1.83.0 | BSD-2-Clause style (leptonica-license.txt) |
| libpng (`a37d4836`) | 1.6.38.git | PNG Reference Library License v2 |
| zlib (`21767c65`) | 1.2.12 | zlib licence |
| libjpeg, IJG (`6c0fcb8d`, LuaDist mirror) | 9a | IJG licence ("based in part on the work of the Independent JPEG Group") |
| libtiff (`b51bb157`) | 4.3.0 | libtiff licence (BSD-like, Leffler/SGI) |
| libwebp (`20ef03ee`) | 1.2.2 | BSD-3-Clause + PATENTS grant |
| giflib (`fa376720`) | 5.1.4 | MIT-style |
| openlibm (`ae2d9169`) | — | MIT/BSD/ISC; built by `build.sh`, linking not evidenced |
| `worker.min.js` bundles | — | buffer (MIT), ieee754 (BSD-3), regenerator-runtime (MIT), zlib.js (MIT) |
| tessdata_fast (`87416418`) | — | Apache-2.0 (LICENSE read) |
| `@tesseract.js-data/*` | 1.0.0 | npm says MIT; its repo `naptha/tessdata` LICENSE is Apache-2.0 |
| `pdf.ttf`, tessconfigs (`3decf1c8`) | SHA-256 `c7845420…ef1a59` | Apache-2.0; byte-identical to `tesseract/tessdata/pdf.ttf` |

All are permissive, but ADR-0001 names only MIT, BSD, Apache-2.0, ISC and MPL-2.0: ADR-0012
should accept the zlib, libpng, IJG, libtiff and giflib licences explicitly.

## 6. PWA fit

- Precache must exclude `ocr/**` (`globIgnores`): `globPatterns: **/*.js` would take the worker,
  the glue and the 3.9 MB `.wasm.js` files, which fit under the 4 MiB limit and would not fail.
- The existing `pdf-editor-wasm` rule matches any same-origin `.wasm`, so tesseract's core would
  join PDFium and qpdf in a 4-entry cache: the OCR route must come first and exclude `/ocr/`.
- Runtime: `pdf-editor-ocr`, CacheFirst for `ocr/**`, 200-only, ~16 entries (worker, one glue,
  one core, API chunk if not precached, ≤ 9 packs), no age limit (versioned paths);
  `cleanupOutdatedCaches` does not touch runtime caches, so the loader deletes other
  `ocr/tesseract-*` entries on version change.
- Download on demand: the dialog fetches the pack(s) through the same cache (`cache.add`, or the
  SW on the first run) and shows the size; "Keep available offline" also adds worker, glue and
  core (sizes: eng 1.96 MB, tur 2.00 MB, engine once 1.1 MB). Verified with a hand-written
  CacheFirst SW (same mechanics as Workbox, not Workbox itself).

## 7. Recommendations

- **Go.** Offline with zero non-self requests, ≈ 4 s per dense A4 page at 300 dpi, exact search
  rects and Turkish round-trip, in Chromium. Packs: **tessdata_fast**, gzip, SHA-256 lock.
- Core: `.js` + `.wasm`, all three LSTM variants beside `worker.min.js` in
  `ocr/tesseract-7.0.0/`, picked by the two probes; fall back to `.wasm.js` only if the deploy
  check shows the host does not compress `application/wasm` (then 3.46 MB instead of 4.89 MB).
- Worker: `worker.min.js` patched (pnpm `patchedDependencies`, upstream PR); packs inflated with
  `DecompressionStream` on our side, `cacheMethod: 'none'`.
- Input: PGM from the PDFium worker. DPI: **300 standard**; 200 was as accurate on 11 pt text
  and 1–21% faster, so a "Fast" option is possible; keep 400 ("High") only for small print
  (untested). No `rotateAuto`.
- **Thresholds** (mean confidence of words ≥ 30): **Good ≥ 90**, **Review 80–90**, **Poor < 80**,
  No text = 0 kept words. Our pages: clean 95.2–96.0 (≥ 98.9% right) → Good; scan150 85.6–87.8
  (88–91%) → Review; scan120 64–73 (27–36%) → Poor; scan100 ~37–39 (≈ 1–3%) → Poor. The spec's
  85/60 would call scan120 "Review". There are no samples between 73 and 85: re-check on F's scans.
  List words < 90 as low-confidence (bands 85–89 are 84–87% right).
- Time budget: median 3.3–3.9 s recognise + ≤ 0.6 s render meets the ≤ 6 s acceptance with fast
  (best_int would not). Terminate a recognizer after 30 s on one page and mark it Poor.
- Pool: 2 recognizers when `hardwareConcurrency ≥ 4` (1.65×, ~+100 MiB), else 1.
- Still to check in Firefox and WebKit: CSP/worker behaviour, variant picked, timings.

## 8. Draft ADR-0012: OCR engine hosting and language packs

**Status:** proposed · **Context:** M5 OCR (spec §1) must run offline under ADR-0004's CSP.
tesseract.js 7 defaults to jsDelivr and a `blob:` worker; its worker cannot take our pack bytes
without a one-token fix; Emscripten finds the `.wasm` beside the worker; a meta CSP does not
bind the worker (research 07).

**Decision.**
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

**Consequences.** First use downloads ~3.1 MB (one language, compressed host); each further
language ~2 MB. A patched third-party file is kept until upstream releases a fix. Accuracy on
degraded scans is limited (≈ 90% at scan150 quality) and shown as Review/Poor. Revisit best_int
only if F's real scans show ≥ 2 points.

**Alternatives.** Stock worker with `langPath` on our origin (works, but no local import and no
progress of our own); single-file `.wasm.js` (+0.36 MB compressed, no streaming compile;
fallback if the host does not compress wasm); `4.0.0_best_int` (slower, larger, not more
accurate here); `rotateAuto` (deskewed coordinates, +27% time).
