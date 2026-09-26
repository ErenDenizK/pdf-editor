---
title: "Research: browser PDF engines and libraries"
date: 2026-09-26
status: snapshot
---

> Research snapshot gathered on 2026-09-26. Versions, sizes and licenses were verified against the npm registry and upstream repositories at that date and will drift. Decisions derived from this document live in `docs/adr/`.

# Browser-only PDF engine research (as of 2026-09-26)

**Method.** npm's website and the GitHub REST API were blocked from this sandbox, so version/date/license facts come from the npm registry API (`registry.npmjs.org`, authoritative for publish dates), file sizes were measured by downloading the actual npm tarballs (raw and `gzip -9`), and exported APIs were grepped from the shipped `.d.ts`/`.wasm` files. GitHub pages, READMEs and issues were read via web fetch. Where a fact could not be verified it is marked as such.

---

## A. Rendering engines

### A1. pdf.js (`pdfjs-dist`) — Mozilla

| Fact | Value | Source |
|---|---|---|
| Latest | **6.3.289**, published 2026-08-29; monthly cadence (5.4.624 Feb, 5.5.207 Mar, 5.6.205 Mar 29, 5.7.284 Apr 27, 6.0.227 May 30, 6.1.200 Jun 27, 6.2.108 Jul 28, 6.3.289 Aug 29 2026) | https://registry.npmjs.org/pdfjs-dist |
| License | Apache-2.0 | same; https://github.com/mozilla/pdf.js |
| Stars | ~54k | https://github.com/mozilla/pdf.js |
| Size (measured) | `build/pdf.min.mjs` 459 KB (131 KB gz); `build/pdf.worker.min.mjs` 1.27 MB (374 KB gz); legacy build 519 KB / 1.32 MB. Optional `wasm/` decoders: openjpeg.wasm 252 KB, jbig2.wasm 105 KB, qcms_bg.wasm 97 KB, quickjs-eval.wasm 469 KB | tarball pdfjs-dist-6.3.289.tgz |

**Worker model.** Parsing/rendering-command generation runs in a Web Worker (`pdf.worker.min.mjs`); the API and worker versions must match exactly or loading fails ("The API version does not match the Worker version") — https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions. Static assets you must host and point to via `getDocument` params: `wasmUrl` ("The URL where the wasm files are located"), `cMapUrl`, `standardFontDataUrl`, `iccUrl`; `useWasm` "Attempt to use WebAssembly in order to improve e.g. image decoding performance"; `password` "For decrypting password-protected PDFs" — https://github.com/mozilla/pdf.js/blob/master/src/display/api.js. Since 5.x pdf.js uses WASM for JPX (OpenJPEG), JBIG2 and ICC (qcms) decoding, so a static site must serve the `wasm/` directory too (measured in tarball).

**Text layer / annotation layer / editor.** `pdf.mjs` exports `TextLayer`, `AnnotationLayer`, `XfaLayer`, `AnnotationEditorLayer`, `AnnotationEditorUIManager`, `DrawLayer`, `ColorPicker`, `SignatureExtractor` (grep of `build/pdf.mjs`). The editor supports `AnnotationEditorType` FREETEXT(3), HIGHLIGHT(9), STAMP(13), INK(15), POPUP(16), SIGNATURE(101), COMMENT(102) — https://github.com/mozilla/pdf.js/blob/master/src/shared/util.js; the editor layer registers FreeText, Ink, Stamp, Highlight, Signature editors — https://github.com/mozilla/pdf.js/blob/master/src/display/editor/annotation_editor_layer.js. `PDFDocumentProxy.saveDocument()` writes form-field values and newly created editor annotations from `annotationStorage` ("Storage for annotation data in forms") into an incremental update — https://github.com/mozilla/pdf.js/blob/master/src/display/api.js. Caveat: this is the *only* write path pdf.js has; it cannot merge/split/rotate/reorder or edit existing content (the 6.0 viewer gained "insert an image as a new page" and "merge several PDFs via the picker", but that is viewer UI built on the same limited save path — https://github.com/mozilla/pdf.js/releases/tag/v6.0.227).

**v6.0 breaking changes (2026-05-30).** Minimum browsers bumped to Chrome 125 / Safari 18 (needs `AbortSignal.any()`, `:dir()`, `light-dark()`, CSS nesting) — https://github.com/mozilla/pdf.js/pull/21152; `getDocument()` without a parameter object and `PDFDocumentProxy.destroy()` removed; `getDestinations/getAttachments/getViewerPreferences/getOpenAction` now return `Map`s — https://github.com/mozilla/pdf.js/releases/tag/v6.0.227, https://github.com/wojtekmaj/react-pdf/issues/2091. FAQ support matrix: modern build = latest Firefox/Chrome; legacy build = Firefox ESR+, Chrome 125+, Chromium Edge/Opera, Safari 18+ "mostly", Node 22+ — https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions.

**Perf / known limitations.** FAQ recommends rendering only visible pages to limit memory. Reported weaknesses: memory blow-ups on image-heavy/scanned docs, slow CCITT fax streams, XFA "still experimental", no ICC/spot colour/overprint simulation — https://github.com/mozilla/pdf.js/issues/13508, https://www.nutrient.io/blog/pdfjs-limitations-commercial-upgrade/, https://github.com/mozilla/pdf.js/issues/6575. pdf.js is JS (not WASM) so rendering fidelity on exotic files is generally below PDFium/MuPDF, but it is the most battle-tested (Firefox's built-in viewer).

### A2. PDFium compiled to WASM

PDFium's LICENSE file carries a BSD-3 header plus the full Apache-2.0 text — https://raw.githubusercontent.com/chromium/pdfium/main/LICENSE; EmbedPDF redistributes it as Apache-2.0 (`LICENSE.pdfium`) — https://registry.npmjs.org/@embedpdf%2Fpdfium (README). Either way it is permissive and MIT-compatible. **Threading:** PDFium "is not thread safe" / single-threaded — https://groups.google.com/g/pdfium/c/s_YHSLdb8kU, https://pkg.go.dev/github.com/klippa-app/go-pdfium — so WASM builds are single-threaded and should live in one dedicated Web Worker (both wrappers below ship worker entry points).

**`@embedpdf/pdfium` (EmbedPDF project) — recommended PDFium build**
- 2.15.1, published 2026-09-16; monthly releases (2.14.1 Apr 22 → 2.15.1 Sep 16 2026); MIT (wrapper) + Apache-2.0 (PDFium) — https://registry.npmjs.org/@embedpdf%2Fpdfium
- `dist/pdfium.wasm` **4.65 MB raw / 2.15 MB gzip** (measured); Stirling-PDF measured 2,095 KB gzip / 1,610 KB brotli for the same asset — https://github.com/Stirling-Tools/Stirling-PDF/pull/8043
- Exposes **388 FPDF*/FORM*/EPDF* functions** (grep of `dist/*.d.ts`), including write/edit surface: `FPDF_SaveAsCopy`, `FPDF_SaveWithVersion`, `FPDF_CreateNewDocument`, `FPDF_ImportPages(ByIndex)`, `FPDFPage_New/Delete/SetRotation/Flatten/GenerateContent/InsertObject`, `FPDFPageObj_NewImageObj/NewTextObj/CreateTextObj/CreateNewPath/CreateNewRect`, `FPDFImageObj_LoadJpegFile(Inline)/SetBitmap/SetMatrix`, `FPDFTextObj_SetTextRenderMode`, `FPDFAnnot_Set*/AddInkStroke/AppendObject/RemoveObject/SetAP`, full `FORM_On*` interaction, `FPDFDoc_AddAttachment`, and custom `EPDF_SetEncryption / EPDF_RemoveEncryption / EPDF_UnlockOwnerPermissions / EPDF_SetMetaText / EPDF_PNG_EncodeRGBA / EPDFText_RedactInQuads`. README lists: rendering, text extraction & search, form filling, annotations, signature verification, "PDF modification and creation".
- Stirling-PDF's new frontend is built on `@embedpdf` v2.14.x — https://github.com/Stirling-Tools/Stirling-PDF/pull/8043 (a strong production signal).
- Recent critical bug (fixed): `EPDFText_RedactInQuads` left residual glyphs when several redactions were on one line; opened 2026-09-08, closed via PRs #813/#820 — https://github.com/embedpdf/embed-pdf-viewer/issues/801. Lesson: redaction is high-stakes; pin versions and test.

**`@hyzyla/pdfium`**
- 2.1.13, published 2026-05-12 (sparse releases: 2.1.9 Jul 2025 → 2.1.11 Feb 2026), MIT, ~187 stars — https://registry.npmjs.org/@hyzyla%2Fpdfium, https://github.com/hyzyla/pdfium
- `dist/pdfium.wasm` 3.99 MB / 2.03 MB gz (measured); built on paulocoutinhox/pdfium-lib.
- Public API (from `.d.ts`): `loadDocument(buf, password)`, `getPage`, `render` (bitmap, optional `renderFormFields`), `getText`, `objects/getObject` (image extraction), `initializeFormFields`. **No save/edit API** — it is a render+extract wrapper only. Docs: https://pdfium.js.org/docs/extract-text-from-page (blocked from sandbox; via search snippet).

**`pdfium-wasm` (urish)** — 0.0.2, last published 2018-06-16, ISC; abandoned — https://registry.npmjs.org/pdfium-wasm.

### A3. MuPDF.js (`mupdf`, Artifex)

- **1.28.1**, published 2026-09-06 (1.27.0 Jan 2026, 1.28.0 Jun 2026); license `AGPL-3.0-or-later`; ~610 stars on the bindings repo — https://registry.npmjs.org/mupdf, https://github.com/ArtifexSoftware/mupdf.js
- `dist/mupdf-wasm.wasm` **10.4 MB raw / 4.7 MB gzip** (ships a 3.6 MB `.br` too) — measured. ESM-only; docs say to run in a Web Worker.
- Capabilities (from shipped `mupdf.d.ts` + README): classes `Document, PDFDocument, PDFPage, PDFAnnotation, PDFWidget, StructuredText, DocumentWriter, PDFGraftMap…`; methods `createAnnotation`, `applyRedactions`, `deletePage/insertPage/graftPage/rearrangePages`, `setPageBox`, `bake` (flatten), `addImage/addFont/addSimpleFont/addCJKFont`, `addEmbeddedFile`, `authenticatePassword`, `enableJournal` (undo), `canBeSavedIncrementally`, `subsetFonts`, `saveToBuffer(options)` with write options `garbage`, `incremental`, `compress-images`, `compress-fonts`, `decrypt`, `encrypt=rc4-40|rc4-128|aes-128|aes-256` (strings present in the wasm; also https://mupdf.readthedocs.io/en/1.27.0/reference/common/pdf-write-options.html). README: "rendering, text extraction, searching, annotations, redactions, page manipulation, document merging, metadata, form field management, password handling". No lossy image-recompression write option was found in the 1.28.1 wasm strings (only lossless `compress-images`). Real text *content* editing is not a first-class API (you can add objects/streams, not reflow existing text).
- **License implication.** README: "If you distribute software that uses mupdf.js, or provide it as a network service, you must release your source code under the AGPL", otherwise buy a commercial licence — https://github.com/ArtifexSoftware/mupdf.js/blob/master/README.md, https://www.npmjs.com/package/mupdf. Serving the WASM from GitHub Pages *is* distribution (conveying) of the AGPL work to every visitor; a combined work that includes AGPL code must be licensed as a whole under AGPL (MIT → AGPL is one-way) — https://fossa.com/resources/devops-tools/license-compatibility-checker/mit-vs-agpl-3-0/, https://en.wikipedia.org/wiki/GNU_Affero_General_Public_License. **Conclusion: MuPDF.js is technically the most complete single engine, but it cannot be used in a project that wants to remain MIT/Apache.** BentoPDF, which loads AGPL engines (PyMuPDF, Ghostscript, cpdf) at runtime from a CDN, is itself AGPL-3.0 with a paid commercial licence — https://github.com/alam00000/bentopdf, https://github.com/alam00000/bentopdf/blob/main/LICENSE — so it is not a model for an MIT project.

### A4. Other notable: EmbedPDF (embedpdf.com) as a foundation

- Monorepo https://github.com/embedpdf/embed-pdf-viewer, ~4.5k stars, framework-agnostic viewer (React/Vue/Svelte/Preact/vanilla), plugin architecture: annotations (highlight, sticky notes, free text, ink), "true redaction (content is actually removed)", search, selection, zoom, rotation, virtualized scrolling.
- **Versions/licences:** the stable **v2 line** (`@embedpdf/* 2.15.1`, 2026-09-16) is **MIT** — https://github.com/embedpdf/embed-pdf-viewer/blob/v2/LICENSE, https://registry.npmjs.org/@embedpdf%2Fengines. The **v3 line** on `main` (`@embedpdf/core@3.0.0-next.14`, 2026-09-20) is **Apache-2.0** for `packages/`, but `cloudpdf/server/` is Fair Core License (FCL-1.0-ALv2, converts to Apache-2.0 two years after each release) — https://github.com/embedpdf/embed-pdf-viewer/blob/main/LICENSING.md, https://github.com/embedpdf/embed-pdf-viewer/blob/main/cloudpdf/server/LICENSE. README: "EmbedPDF v3 is under active development and is not yet recommended for production use. For the current stable release, use the v2 branch"; v3 runs on "EmbedPDF Runtime, our fork of PDFium" (Apache-2.0) — https://github.com/embedpdf/embed-pdf-viewer/blob/main/README.md.
- **`@embedpdf/engines` 2.15.1 (MIT)** is the sweet spot for a foundation without adopting their UI: `PdfEngine` methods (from `.d.ts`): `openDocumentBuffer, createDocument, renderPageRaw/renderPageRect/renderThumbnailRaw, getPageTextRects/getPageGlyphs/extractText, searchInPage/searchAllPages, getPageAnnotations, createPageAnnotation/updatePageAnnotation/removePageAnnotation, redactTextInRects/redactTextInQuads/applyRedaction/applyAllRedactions, flattenPage/flattenAnnotation, mergePages/extractPages/importPages/deletePage, setFormFieldValue/setFormFieldState/regenerateWidgetAppearances, setMetadata, setBookmarks, addAttachment, setDocumentEncryption/removeEncryption/unlockOwnerPermissions, saveAsCopy/saveDocument`, plus a ready-made `worker-engine.js` (712 KB) — https://registry.npmjs.org/@embedpdf%2Fengines. Note there is no dedicated "rotate page"/"insert blank page" method; rotation of the stored page is done via the raw `FPDFPage_SetRotation` or via pdf-lib.
- pdf-lib-style rendering: none (`pdf-lib`, `pdfkit`, `jsPDF` are writers only).

---

## B. Manipulation / writing

### B1. `pdf-lib` and forks

**`pdf-lib` (Hopding)** — 1.17.1, last published **2021-11-06** (nearly 5 years), MIT, ~8.6k stars, 278 open issues / 39 open PRs, no releases since — https://registry.npmjs.org/pdf-lib, https://github.com/Hopding/pdf-lib. `pdf-lib.esm.min.js` 523 KB / 206 KB gz (measured). README gaps: "pdf-lib does not currently support encrypted documents" (throws `EncryptedPDFError`; `ignoreEncryption` does not decrypt), cannot extract page text, cannot edit text outside form fields, no HTML/CSS — https://github.com/Hopding/pdf-lib/blob/master/README.md. No incremental save. Recent open issues: `removeField()` leaves stale widget refs (#1784, Jun 2026), ReDoS (#1773, Mar 2026), merged PDFs blank in Acrobat (#1767), standard fonts limited to WinAnsi (#1759) — https://github.com/Hopding/pdf-lib/issues. It does expose `TextRenderingMode.Invisible = 3` and `setTextRenderingMode` (verified in `cjs/api/operators.js`) — useful for OCR layers.

**`@cantoo/pdf-lib` — the maintained fork to use.** 2.11.1 published **2026-09-15**; six releases in Aug–Sep 2026 alone (2.8.4, 2.9.0, 2.9.1, 2.9.2, 2.11.0, 2.11.1); MIT; ~353 stars — https://registry.npmjs.org/@cantoo%2Fpdf-lib, https://github.com/cantoo-scribe/pdf-lib. Bundle 614 KB / 252 KB gz (measured); deps `culori, fflate, node-html-better-parser, tslib` (pako dropped in 2.11.0). Adds over upstream (README/CHANGELOG): **`PDFDocument.encrypt()` AES-256 R6 default, AES-128/RC4 optional, in-tree crypto + WebCrypto `getRandomValues`**; **decryption** of encrypted inputs (2.9.2 fixed indirect crypt filters, e.g. iText 2.x); **incremental updates** (`forIncrementalUpdate`, `commit()`); `drawSvg/embedSvg` full SVG; XFA & document JavaScript access; PDF/A conversion; Factur-X; attachments; optional content layers; "more robust parsing… Recover truncated PDFs"; `@cantoo/fontkit`. Maintenance statement: "We maintain this project for our own product needs and cannot guarantee support for every issue outside that roadmap — but contributions that fit the library are welcome" — https://github.com/cantoo-scribe/pdf-lib/blob/master/README.md, https://github.com/cantoo-scribe/pdf-lib/blob/master/CHANGELOG.md.

**`@pdfme/pdf-lib`** — 6.2.1 published 2026-09-26, MIT; internal fork used by pdfme (MIT, ~4.8k stars, template designer/generator) — https://registry.npmjs.org/@pdfme%2Fpdf-lib, https://github.com/pdfme/pdfme. Tracks pdfme's needs, not a general-purpose fork; no encryption. `pdf-lib-plus-encrypt` (1.1.0, 2023) is dead — https://registry.npmjs.org/pdf-lib-plus-encrypt.

### B2. qpdf WASM and pdfcpu WASM

**qpdf** (upstream): Apache-2.0, ~5.4k stars, latest 12.4.1 on 2026-08-27; "content-preserving transformations": linearization, encryption/decryption, split/merge, repair, object streams; "does not render PDFs or perform text extraction" — https://github.com/qpdf/qpdf, https://github.com/qpdf/qpdf/releases.
- `@jspawn/qpdf-wasm` 0.0.2, published 2022-07-26, Apache-2.0, wraps **qpdf 11.0.0** (version string in wasm), `qpdf.wasm` 1.27 MB / 422 KB gz; CLI-only ("doesn't expose the qpdf library - just the CLI") — https://registry.npmjs.org/@jspawn%2Fqpdf-wasm, https://github.com/jsscheller/qpdf-wasm.
- `@neslinesli93/qpdf-wasm` 0.3.0, published 2025-06-27, wrapper licence ISC on npm, wraps **qpdf 12.2.0**, `dist/qpdf.wasm` 1.33 MB / 443 KB gz; Emscripten `callMain([...])` + MEMFS; ~38 stars — https://registry.npmjs.org/@neslinesli93%2Fqpdf-wasm, https://github.com/neslinesli93/qpdf-wasm.
- `qpdf-wasm-esm-embedded` 1.1.1 (2024-04-26, Apache-2.0) — https://registry.npmjs.org/qpdf-wasm-esm-embedded.
- Assessment: small (≈0.45 MB gz), permissive, mature engine; great for **decrypt/encrypt (incl. 256-bit AES), repair (`--qdf`/rebuild xref), linearize, `--object-streams=generate`, `--recompress-flate`, page selection**. Ergonomics are CLI-through-virtual-FS; all wrappers are one-person projects, so plan to be able to rebuild the wasm yourself (qpdf builds cleanly with Emscripten).

**pdfcpu** (Go): Apache-2.0, ~8.9k stars, latest v0.15.0 on 2026-08-11 (proxy.golang.org); features validate/optimize/split/merge/encrypt/decrypt/watermark/stamp/forms/images/signatures — https://github.com/pdfcpu/pdfcpu, https://proxy.golang.org/github.com/pdfcpu/pdfcpu/@latest. **No official WASM target**; community builds (`GOOS=js GOARCH=wasm`) exist (wcchoi/go-wasm-pdfcpu, LaserKaspar/go-wasm-pdfcpu, alitrack/pdfcpu) and weigh ~8 MiB uncompressed, which the authors themselves call "very large" — https://github.com/wcchoi/go-wasm-pdfcpu/blob/master/article.md, https://github.com/LaserKaspar/go-wasm-pdfcpu, https://github.com/alitrack/pdfcpu. Go-wasm also needs `wasm_exec.js` and has GC/memory overhead. Not recommended over qpdf-wasm + pdf-lib.

### B3. MuPDF / PDFium write capabilities
See A2/A3: PDFium via `@embedpdf/pdfium` can create/modify/save documents (`FPDF_SaveAsCopy`, page objects, annotations, forms, flatten, encryption via EPDF extensions); MuPDF.js can do the same and more (redaction, journaling, incremental, encryption options) but is AGPL.

### B4. Generating new content: pdf-lib vs pdfkit vs jsPDF

| | `@cantoo/pdf-lib` | `pdfkit` | `jsPDF` |
|---|---|---|---|
| Version / date | 2.11.1 / 2026-09-15 | 0.20.2 / 2026-08-30 | 4.2.1 / 2026-03-17 |
| License / stars | MIT / 353 (upstream 8.6k) | MIT / ~10.7k | MIT / ~31.3k |
| Size (measured, min, gz) | 252 KB | standalone 1.42 MB raw / 349 KB gz (browser build 294 KB raw) | `jspdf.es.min.js` 109 KB gz |
| Modify existing PDFs | **Yes** (core strength) | No (generate only) | No (generate only) |
| Browser I/O | Uint8Array in/out | needs `blob-stream`; no fs — pass Uint8Array/ArrayBuffer | Blob/ArrayBuffer out |
| Encryption | AES-256/128, RC4 | RC4/AES with owner/user passwords & permissions (`@noble/ciphers`) | basic RC4 |
| Notes | UTF-8 fonts via fontkit; SVG; forms; invisible text mode | rich text layout, PDF/A, PDF/UA, outlines, forms | `renderingMode: 'invisible'` for OCR; fonts limited to ASCII unless custom TTF |
| Sources | registry + GitHub above | https://registry.npmjs.org/pdfkit, https://github.com/foliojs/pdfkit | https://registry.npmjs.org/jspdf, https://github.com/parallax/jsPDF |

For an editor whose core job is *modifying* PDFs, pdf-lib (cantoo) covers image→PDF, page numbers, watermarks, headers/footers and blank pages with one dependency; pdfkit/jsPDF add little except nicer text layout, at the cost of a second document model.

### B5. Compression (client-side)

- **Ghostscript WASM**: `@jspawn/ghostscript-wasm` 0.0.2, published 2022-08-25, **AGPL-3.0**, `gs.wasm` 16.2 MB raw / **11.2 MB gzip** (Artifex 2022 build) — https://registry.npmjs.org/@jspawn%2Fghostscript-wasm, https://github.com/jsscheller/ghostscript-wasm. The known demo (`-sDEVICE=pdfwrite -dPDFSETTINGS=/ebook` in a worker) is AGPL too — https://github.com/laurentmmeyer/ghostscript-pdf-compress.wasm. Rules it out for an MIT project (licence) and for UX (11 MB download).
- **MuPDF**: lossless `compress-images/compress-fonts/garbage` only; AGPL. Out.
- **Pure-JS/canvas approach (feasible, permissive)**: parse the object graph with pdf-lib, find `/Subtype /Image` XObjects, decode with the browser (`createImageBitmap`/canvas) or pdf.js's decoders, optionally downsample, re-encode as JPEG (canvas `toBlob` or a WASM MozJPEG/jSquash encoder), replace the stream only if smaller, then save with `useObjectStreams: true`. Working reference: drikusroor/compress-pdf, which documents the unsafe cases it skips — CMYK/JPEG2000, CCITT fax, indexed colour, images with SMask — https://github.com/drikusroor/compress-pdf.
- **PDFium route**: `@embedpdf/pdfium` exports `FPDFImageObj_LoadJpegFileInline / SetBitmap / SetMatrix` + `FPDFPage_GenerateContent` + `FPDF_SaveAsCopy`, so images can be swapped in place with PDFium doing the parsing (handles JPX/CCITT decode for you via `FPDFImageObj_GetRenderedBitmap`). Same licence class as pdf.js.
- **Structural squeeze**: qpdf-wasm `--object-streams=generate --recompress-flate --compression-level=9 --remove-unreferenced-resources=yes` gives a lossless 5–20% typically.
- **Fallback for scans**: rasterize each page with pdf.js at chosen DPI → JPEG → new PDF via pdf-lib (lossy "rebuild" mode; loses text unless combined with OCR layer).
Verdict: a real "Compress PDF" is feasible without AGPL code; expect large wins on image-heavy/scanned files and small wins on text-only files, and disclose that.

### B6. OCR: tesseract.js

- `tesseract.js` **7.0.0**, published 2025-12-15, Apache-2.0, ~38.7k stars; core `tesseract.js-core` 6.1.2 — https://registry.npmjs.org/tesseract.js, https://github.com/naptha/tesseract.js. README: "Tesseract.js does not support PDF files" (as *input*; you render pages to canvas with pdf.js first).
- Sizes (measured): `tesseract.min.js` 63 KB, `worker.min.js` 111 KB; core `tesseract-core-simd-lstm.wasm` 2.87 MB / 1.06 MB gz (LSTM-only, the default), `tesseract-core-simd.wasm` 3.47 MB / 1.30 MB gz (legacy+LSTM). Language data (npm `@tesseract.js-data/*` 1.0.0): eng 13.9 MB, deu 8.4 MB, fra 7.0 MB unpacked (gzipped `.traineddata.gz` served from jsDelivr by default) — https://registry.npmjs.org/@tesseract.js-data%2Feng. Four core variants must be hosted; the loader picks SIMD/LSTM at runtime — https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md.
- **Searchable PDF output.** Verified in the 7.0.0 source: `recognize(image, {pdfTitle, pdfTextOnly}, {pdf: true})` returns `data.pdf` (Tesseract's own image+invisible-text "sandwich" renderer; `src/worker-script/utils/dump.js`, `index.d.ts`), and v4 notes "getPDF function replaced by pdf recognize option" — README. This is undocumented in `docs/api.md`, so treat as semi-supported. The more controllable approach for an editor: request `blocks`/`hocr` output, then overlay words onto the *original* page with pdf-lib using `pushOperators(setTextRenderingMode(TextRenderingMode.Invisible))` (mode 3 — the same primitive Tesseract/Acrobat/ABBYY use; robust for PDF/A, unlike opacity 0) — https://pdf-lib.js.org/docs/api/enums/textrenderingmode, https://github.com/Hopding/pdf-lib/pull/1216. jsPDF's `renderingMode: 'invisible'` is the equivalent if you generate fresh PDFs — jspdf source.
- Alternative with better accuracy and native PDF input, **scribe.js** (0.16.0, 2026-09-25) is **AGPL-3.0** — https://registry.npmjs.org/scribe.js-ocr, https://github.com/scribeocr/scribe.js/blob/master/docs/scribe_vs_tesseract.md — so not usable here.

---

## C. Comparison table

| Library | Purpose | License | Approx. size (gz) | Maintenance (latest / date) | Key strengths | Key gaps |
|---|---|---|---|---|---|---|
| `pdfjs-dist` | Render, text layer, annotation/form display, limited editor save | Apache-2.0 | 131 KB main + 374 KB worker + ~0.5 MB optional wasm | Very active, monthly (6.3.289 / 2026-08-29) | Battle-tested, DOM text layer, a11y, small, no WASM needed for most files | Read-mostly; save only via annotationStorage; JS renderer slower on heavy scans; Chrome 125+/Safari 18+ |
| `@embedpdf/pdfium` + `@embedpdf/engines` (v2) | Render, text, search, annotations CRUD, forms, redaction, flatten, merge/extract, encryption, save | MIT (+ PDFium Apache-2.0) | ~2.15 MB wasm + ~0.2–0.7 MB JS | Active (2.15.1 / 2026-09-16); used by Stirling-PDF | Chrome's engine fidelity; full write path; worker engine; true redaction | 2 MB download; single-threaded; v3 is pre-production and Apache-2.0/FCL split; no page-rotate helper (raw FPDF) |
| `@hyzyla/pdfium` | Render + text/image extraction | MIT | ~2.0 MB wasm | Slow (2.1.13 / 2026-05-12) | Simple typed API | No save/edit/annotations; smaller community |
| `mupdf` (MuPDF.js) | Everything: render, edit, annotate, redact, forms, encrypt, incremental save | **AGPL-3.0** (or commercial) | 4.7 MB gz (3.6 MB br) | Active (1.28.1 / 2026-09-06), Artifex | Most complete single engine | AGPL forces whole app to AGPL; 10 MB wasm; no lossy image recompression |
| `pdf-lib` (Hopding) | Structural manipulation & generation | MIT | 206 KB | **Unmaintained** (1.17.1 / 2021-11-06) | Huge ecosystem/API familiarity | No encryption/decryption, no incremental save, parsing bugs, no text extraction |
| `@cantoo/pdf-lib` | Same + AES-256 encrypt/decrypt, incremental, SVG, PDF/A, robust parsing | MIT | 252 KB | Very active (2.11.1 / 2026-09-15) | Drop-in for pdf-lib; pure JS; encryption | Small team ("own product needs"); no rendering/text extraction; annotation appearance streams still DIY |
| `@jspawn/qpdf-wasm` / `@neslinesli93/qpdf-wasm` | Encrypt/decrypt, repair, linearize, object streams | Apache-2.0 (qpdf); wrappers Apache-2.0 / ISC | ~0.43 MB wasm | Wrappers 2022 / 2025 (qpdf 11.0 / 12.2); qpdf itself 12.4.1 2026-08-27 | Robust, tiny, permissive; best-in-class repair | CLI+MEMFS ergonomics; one-person wrappers (be ready to rebuild) |
| pdfcpu WASM (community) | Encrypt, optimize, validate, watermark | Apache-2.0 | ~8 MB raw | Upstream active (v0.15.0 / 2026-08-11); no official wasm | Broad feature set | Go-wasm size/GC; unofficial builds |
| `@jspawn/ghostscript-wasm` | Compression (`pdfwrite`), PDF/A | **AGPL-3.0** | 11.2 MB | Dead (0.0.2 / 2022-08-25) | Best lossy compression quality | AGPL + 11 MB → unusable here |
| `pdfkit` | Generate new PDFs | MIT | 349 KB (standalone) | Active (0.20.2 / 2026-08-30) | Text layout, PDF/A-UA, encryption | Cannot modify existing PDFs |
| `jspdf` | Generate new PDFs | MIT | 109 KB | Active (4.2.1 / 2026-03-17) | Small, popular, invisible text mode | Cannot modify; ASCII fonts unless custom TTF |
| `tesseract.js` (+core, +lang) | OCR, hOCR/blocks, sandwich PDF | Apache-2.0 | ~1.1 MB core + 0.17 MB JS + 3–14 MB/language | Active (7.0.0 / 2025-12-15) | Only permissive browser OCR; SIMD wasm; workers | Accuracy on skewed/low-res; big language packs; PDF output undocumented |

---

## D. Recommended architecture (for an MIT/Apache, static-hosted editor)

**Guiding rule:** every engine must be MIT/Apache/BSD → **pdf.js, PDFium (EmbedPDF v2), @cantoo/pdf-lib, qpdf, tesseract.js** are in; **MuPDF, Ghostscript, scribe.js, pdfcpu-wasm (size) are out.** Load engines lazily by feature so a plain merge/split never downloads 2 MB of PDFium or 15 MB of OCR data.

**(a) Rendering & viewing — `pdfjs-dist` 6.x (primary), PDFium (secondary/optional).**
pdf.js gives page canvases, thumbnails (render at small scale), a DOM `TextLayer` for selection/search/a11y, `AnnotationLayer`/`XfaLayer` for display, at ~0.5 MB gz total; host `wasm/`, `cmaps/`, `standard_fonts/`, `iccs/` next to the app and set the `*Url` params. Run it in its worker; pin api/worker versions. If you adopt `@embedpdf/engines` for editing (below), you can alternatively render *edited* pages through PDFium to guarantee WYSIWYG for appearance streams PDFium generated; keep pdf.js as the default renderer because it is lighter and has the richer text layer. Trade-off: two rendering engines can disagree by a pixel or two; use one per view (viewer = pdf.js, "preview result" = the engine that wrote it).

**(b) Structural manipulation — `@cantoo/pdf-lib` (pure JS, 252 KB gz).**
Merge (`copyPages`), split, delete, reorder, rotate (`setRotation`), crop/boxes, blank pages, image→PDF (`embedJpg/embedPng`), page numbers/headers/footers/watermarks (`drawText/drawImage/drawSvg` with opacity), metadata (`setTitle…`, XMP via PDF/A helpers), attachments, bookmarks/outlines (low-level `PDFDict`), form filling/flattening (`form.flatten()`), `save({ useObjectStreams: true })`. Wrap it behind your own `PdfDocumentModel` so you can swap engines. Use qpdf-wasm's repair pass (`--qdf`-less rebuild) as an automatic fallback when pdf-lib throws on a malformed file.

**(c) Annotation / form editing — hybrid.**
- Lightweight path: pdf.js's `AnnotationEditorLayer` (FreeText, Ink, Highlight, Stamp, Signature) + `saveDocument()` gives working in-viewer annotation with appearance streams generated by pdf.js; forms are filled through `annotationStorage`. Limitation: only *new* editor annotations and field values are written; you cannot edit or delete pre-existing arbitrary annotations, and the output is an incremental update.
- Full path (lazy-loaded, ~2.2 MB gz): `@embedpdf/engines` v2 (`PdfEngine` in `worker-engine.js`) for `createPageAnnotation/updatePageAnnotation/removePageAnnotation`, `setFormFieldValue`, `regenerateWidgetAppearances`, `flattenPage`, `redactTextInRects/applyAllRedactions`, `setBookmarks`, `setMetadata`, `saveAsCopy`. Pin to a 2.x version, keep an eye on the v3 (Apache-2.0) migration, and add regression tests for redaction (see issue #801). Do **not** hand-write annotation appearance streams in pdf-lib beyond simple squares/highlights — that is exactly the area where pdf-lib users hit "not visible in Acrobat" bugs.

**(d) Encryption / permissions — `@cantoo/pdf-lib` first, qpdf-wasm second.**
`PDFDocument.encrypt({ userPassword, ownerPassword, permissions })` (AES-256 R6) and `PDFDocument.load(bytes, { password })` cover 95% in pure JS with zero extra download. Keep `qpdf-wasm` (~0.45 MB gz, Apache-2.0) as the fallback for unusual security handlers, for `--decrypt` of owner-only-locked files, `--linearize`, and structural repair; build your own wasm from qpdf 12.4.x if the wrappers lag (both wrappers are single-maintainer). EmbedPDF's `EPDF_SetEncryption/RemoveEncryption` is a third option if PDFium is already loaded.

**(e) Compression — permissive pipeline, three tiers.**
1. Lossless: pdf-lib `useObjectStreams` + qpdf `--object-streams=generate --recompress-flate --remove-unreferenced-resources=yes`.
2. Lossy images: enumerate image XObjects (pdf-lib or PDFium), decode (browser codecs / `FPDFImageObj_GetRenderedBitmap`), downsample to target DPI, re-encode JPEG (canvas or a WASM MozJPEG such as jSquash), replace only when smaller; skip SMask/indexed/CMYK/CCITT/JPX unless going through PDFium; expose quality/DPI presets.
3. "Rebuild as images" for scans: pdf.js render → JPEG → pdf-lib, optionally combined with (f) to keep text searchable.
Explicitly avoid Ghostscript/MuPDF (AGPL, 5–11 MB).

**(f) OCR — `tesseract.js` 7 in a worker, output an invisible text layer.**
Render pages with pdf.js at 2–3× (~300 DPI), `worker.recognize(canvas, {}, { text: true, blocks: true })`, then draw each word at its bbox with `@cantoo/pdf-lib` after `page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible))`, scaling font size to the box height — the original page image stays byte-identical, and the result is searchable/selectable in pdf.js, Acrobat and Preview. Ship the four core variants yourself (GitHub Pages is fine) or use jsDelivr; lazy-download language packs (eng ≈ 14 MB unpacked; consider offering only `*_fast` variants and caching in the browser via the built-in `idb-keyval` cache). Tesseract's own `pdf: true` output is a viable shortcut for "image-only → searchable" but is undocumented; keep it behind a flag.

**Licence trade-off summary.** Everything above is MIT/Apache/BSD (qpdf Apache-2.0; PDFium Apache-2.0/BSD; pdf.js Apache-2.0; tesseract Apache-2.0; pdf-lib MIT), so the project can stay MIT with a NOTICE file. MuPDF.js would remove the need for pdf.js + PDFium + pdf-lib + qpdf in one 4.7 MB engine and has the best editing API, but AGPL §13 plus ordinary distribution means an MIT project cannot ship it (only an AGPL-licensed app, or one with an Artifex commercial licence, can). If the project ever accepts AGPL, MuPDF.js + tesseract.js would be the simplest two-engine stack; until then, the pdf.js + EmbedPDF-PDFium(v2) + @cantoo/pdf-lib + qpdf-wasm + tesseract.js combination is the strongest permissive architecture, and it is the same family of components Stirling-PDF (EmbedPDF v2) and BentoPDF (pdf-lib, pdf.js, EmbedPDF, qpdf-wasm) converged on in 2026.

**Practical watch-list.** (1) pdf.js drops old browsers monthly (Chrome 125+/Safari 18+ today) — publish the legacy build if you care about ~2-year-old browsers. (2) EmbedPDF v3 will move to Apache-2.0 with its own PDFium fork; plan an abstraction over `PdfEngine`. (3) All qpdf/ghostscript wasm wrappers are hobby packages — vendor/rebuild the wasm in CI. (4) pdf-lib upstream is effectively frozen; target `@cantoo/pdf-lib` and contribute fixes there.
