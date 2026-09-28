# Spec: Recognize and compare (M5)

**Status:** draft (2026-09-28) · **Milestone:** M5 (→ v1.2) · **Owner:** project lead

M5 adds OCR, document comparison, signature validation and PAdES-B signing, text /
Markdown conversion and batch recipes. Each has limits the output does not show, so each
ships with named honesty states and a second reader checks every result before it is
offered. No server, nothing fetched from another origin (ADR-0004).

## 0. Verified facts (npm registry via the proxy, upstream sources; 2026-09-28)

| Package / asset | Version | Licence | Facts |
|---|---|---|---|
| `tesseract.js` | 7.0.0 | Apache-2.0 | 1.41 MB unpacked; `worker.min.js` 111 KB, ESM API 63 KB. `workerPath`, `corePath`, `langPath` default to `cdn.jsdelivr.net`; `workerBlobURL` defaults to true (a `blob:` worker); `langs` accepts `{ code, data }` (our bytes); input must be an encoded image (bmp, jpg, png, pbm, webp, gif), not raw pixels. Deps all MIT/Apache-2.0. |
| `tesseract.js-core` | 7.0.0 | Apache-2.0 | npm `latest` tag still 6.1.2. LSTM-only variants (plain, SIMD, relaxed SIMD): `.wasm` 2.86 MB (1.06 MB gzip) + 89 KB glue, or single-file `.wasm.js` 3.90 MB (1.46 MB gzip). Embeds Tesseract `5.1.0-288-g2a9c1` (fork), Leptonica, libwebp; their licences **[unverified]**, S1 lists them for `NOTICE`. |
| tessdata_fast (`tesseract-ocr`) | main | Apache-2.0 (LICENSE read) | raw / gzip: eng 4.11 / 1.98 MB, tur 4.55 / 2.02, deu 1.53 / 0.85; raw: fra 1.13, spa 2.29, ita 2.70, por 1.98, nld 6.05, rus 3.86 MB. tessdata_best raw: eng 15.4, tur 7.5 MB. |
| `@tesseract.js-data/{eng,tur}` | 1.0.0 | npm says MIT; models derive from tessdata_best (Apache-2.0) | tesseract.js 7's default `4.0.0_best_int`: eng 2.95, tur 2.14 MB gzip. |
| `pdf.ttf` (`tesseract-ocr/tessconfigs`) | main | Apache-2.0 | 572 bytes; the glyphless font of Tesseract's `pdfrenderer.cpp` (UTF-16 codes, `/DW 500`, `3 Tr`, `Tz`, CIDs → GID 1). |
| `pkijs` | 3.4.1 | BSD-3-Clause | ESM 782 KB (87 KB gzip); deps `asn1js` 3.0.10, `bytestreamjs` (BSD-3), `pvtsutils`, `pvutils`, `@noble/hashes` 1.8.0 (MIT). PKCS#12 decryption is **PBES2 only** (`decryptEncryptedContentInfo` throws for other OIDs): legacy 3DES/RC2 `.p12` files cannot be opened. |
| `diff` (jsdiff) | 9.0.0 | BSD-3-Clause | own types; `diffArrays`, `diffWords` with `intlSegmenter`, `timeout` / `maxEditLength`. (`diff-match-patch` 1.0.5, Apache-2.0, unmaintained: not chosen.) |
| `pixelmatch` | 7.2.0 | ISC | 21.5 KB, ESM, one pure function (`pngjs` is for its CLI). |
| `@cantoo/pdf-lib` (in repo) | 2.11.1 | MIT | **Has an incremental writer**: `load(…, { forIncrementalUpdate: true })`, `takeSnapshot()`, `saveIncremental()`, `commit()`, writes `/Prev` (types and `PDFWriter.js` read). Research 04 §8's "no incremental updates" is about `@signpdf`. |
| `@embedpdf/pdfium` (in repo) | 2.15.1 | MIT | exports `FPDFSignatureObj_GetContents/GetByteRange/GetSubFilter/GetTime/GetDocMDPPermission`, `FPDFTextObj_Get/SetTextRenderMode`, `FPDFPage_RemoveObject`. |
| `@signpdf/*`, `node-forge` | 3.3.0, 1.4.0 | MIT; BSD-3 OR GPL-2.0 | Not shipped: forge + `Buffer`, no incremental updates. |

In this repository the CSP (`worker-src 'self'`, `connect-src 'self'`) rejects blob
workers and CDN paths; the PWA precaches `**/*.js` up to 4 MiB (a 3.9 MB `.wasm.js` would
be precached) and `pdf-editor-wasm` keeps 4 entries (tesseract would evict PDFium or qpdf).

## 1. OCR to searchable PDF

### 1.1 Engine, hosting, language packs

- tesseract.js 7, LSTM-only core (`oem 1`). Its classic `worker.min.js` is served from our
  origin with `workerBlobURL: false`; the API chunk is lazy-loaded on the main thread (it
  only posts messages). The core sits unhashed in a versioned directory
  (`ocr/tesseract-7.0.0/`, Emscripten finds the `.wasm` by name); we detect SIMD with
  `wasm-feature-detect` and pass one file as `corePath`. S1 picks `.js`+`.wasm` (0.4 MB
  smaller) or `.wasm.js`. A pool of 1–2 recognizers, reused, terminated after 60 s idle.
- PWA: `globIgnores: ['ocr/**']`; a separate `pdf-editor-ocr` CacheFirst cache for core,
  worker and packs. Nothing OCR-related downloads before the OCR dialog opens.
- Packs are `ocr/lang/<code>.traineddata.gz` on our origin, fetched by our loader, cached
  in `pdf-editor-ocr`, handed over as `{ code, data }` with `cacheMethod: 'none'` (no
  second copy in IndexedDB). **Proposed set:** `eng tur deu fra spa ita por nld rus`
  (≈ 13 MB gzip in the deploy); none precached; the dialog shows size and state ("on this
  device" / "downloads 2.0 MB") and a "Keep available offline" toggle.
- **Source (ADR-0012):** tessdata_fast at a pinned commit, SHA-256 per file in
  `packages/engine/ocr/langs.lock.json`, fetched by a script and committed like the qpdf
  artifact (ADR-0008), hashes re-checked in CI. S1 measures `4.0.0_best_int` (tesseract.js's
  default, 0.1–1 MB larger per pack); if it is ≥ 2 points more accurate on the scan
  fixtures, the ADR takes it instead (npm packages, pnpm-pinned; `NOTICE` says Apache-2.0).
- Other languages: "Import language file…" takes a local `.traineddata[.gz]`, stored in
  OPFS; no remote URL can be entered. Default selection: UI language + `eng`.

### 1.2 Pages, rasterisation, the invisible layer

- `ocrPageFacts` reports per page: visible text, invisible text (none / ours / foreign),
  effective DPI of the largest image. Default scope: pages without visible text. Invisible
  text is kept unless "Replace existing invisible text" is chosen (ours: drop our Form
  XObject; foreign: remove render-mode-3 text objects through the raw API, ADR-0011).
- Render at 300 dpi (High: 400) or the dominant image's DPI clamped to 200–400; 40 MP per
  page (larger sheets drop DPI, with a note); no annotations or widgets; in display
  orientation (`/Rotate` plus the model's delta), so what looks upright is read upright. The
  PDFium worker returns 8-bit greyscale (PGM or BMP, S1 picks) with the pixel → user-space
  matrix. `rotateAuto` fixes small skew (S1 checks the box coordinates); sideways pages are
  rotated first.
- **Layer**, written by pdf-lib in the PDFium worker with the redaction pattern (ADR-0011
  §3): save the source as it is, append, verify in a scratch document, replace the open
  document under the same id. Original content and image bytes are untouched: one Form
  XObject per page, drawn from a content stream appended to `/Contents` in `q … Q`, tagged
  `/PdfEditorOCR << /Engine … /Lang … >>` so a later session can replace it.
- **Font:** Type0 / CIDFontType2 from `pdf.ttf`, Identity-H, codes = UTF-16 units,
  `/CIDToGIDMap` → GID 1, `/DW 500`, `ToUnicode`, `/FontBBox`, `/Ascent`, `/Descent` set so
  PDFium's loose boxes cover the word (S1 checks). Any Unicode works, Turkish (ğ ı İ ş ç ö
  ü) included. Per word: `BT 3 Tr`, size and origin from the word's ink box along its
  line's angle (the row height only as a fallback near 45° or for a degenerate box), `Tm`
  on that rotated box, `Tz` so the advance equals the box width, a trailing space except at
  line end; this keeps PDFium's search hits within 2 pt of the word boxes (research 07 §4).
  `/Lang` set from the OCR language when absent. Not tagged; no PDF/UA claim.

### 1.3 Quality, honesty, model

- Words under confidence 30 are dropped as noise (counted). Page quality from mean word
  confidence: **Good** ≥ 90, **Review** 80–90, **Poor** < 80, **No text found**
  (thresholds set by S1, research 07 §7; ADR-0012). The right panel's **OCR** section (page selected) shows
  quality, languages, DPI and low-confidence words as rows (J/K; the focused word gets the
  1px ring, the page is never tinted, DESIGN §3); the document view lists pages by quality.
- Honesty text: recognised text may contain errors; the page image is unchanged; search
  and copy use the recognised text; it cannot be edited in M5. OCR on a signed source
  warns first that the export will invalidate its signatures (§3).
- New `EngineEdit` kind `ocr.apply`, payload `OcrLayerPlan` (the words themselves, so
  replay never re-runs recognition), inverse "replay required" (undo = reopen + replay, as
  `redaction.apply`). One history entry per finished run ("Recognize text: 12 pages,
  tur+eng"); a cancelled run commits nothing; re-OCR = a new run with `replace: 'ours'`.
  ≈ 40 bytes per word (≈ 2 MB for 100 dense pages). Export garbage-collects such sources
  (ADR-0011 §5); `VerificationExpectation.ocrWords` checks each OCR'd output page yields
  its words through PDFium.

### 1.4 Interfaces (`packages/engine/src/types.ts`, additive)

```ts
export type OcrQuality = 'good' | 'review' | 'poor' | 'no-text';
export interface OcrPageFacts { readonly pageIndex: number; readonly visibleText: boolean;
  readonly invisibleText: 'none' | 'ours' | 'foreign'; readonly imageDpi?: number }
export interface OcrRaster { readonly bytes: ArrayBuffer; readonly width: number;
  readonly height: number; readonly dpi: number; readonly toUser: TextMatrix }
export interface OcrWord { readonly text: string; readonly rect: Rect; readonly angle: number;
  readonly fontSize: number; readonly confidence: number }
export interface OcrPageResult { readonly pageIndex: number; readonly dpi: number;
  readonly languages: readonly string[]; readonly words: readonly OcrWord[];
  readonly meanConfidence: number; readonly quality: OcrQuality; readonly engine: string }
export interface OcrLayerPlan { readonly pages: readonly OcrPageResult[];
  readonly replace: 'none' | 'ours' | 'all-invisible'; readonly lang?: string }
export interface PdfOcrLayer {                          // PDFium worker
  ocrPageFacts(id: SourceId, o?: EngineCallOptions): Promise<readonly OcrPageFacts[]>;
  renderForOcr(id: SourceId, page: number, o: EngineCallOptions & { dpi: number }): Promise<OcrRaster>;
  applyOcrLayer(id: SourceId, plan: OcrLayerPlan, o?: EngineCallOptions): Promise<OcrApplyResult>;
}                                   // OcrApplyResult: pages and words written, dropped, verified, problems
export interface OcrRecognizer {                        // browser adapter over tesseract.js (ADR-0007)
  ensureLanguages(codes: readonly string[], o?: EngineCallOptions & { onProgress?: ProgressCallback }): Promise<void>;
  recognize(r: OcrRaster, page: number, codes: readonly string[], o?: EngineCallOptions): Promise<OcrPageResult>;
  dispose(): Promise<void>;
}
```

### 1.5 UI, fixtures, tests

- "Recognize text (OCR)…" (palette, Document menu): a side dialog with pages, languages
  (size, availability), quality (Standard / High) and replace option; progress in the
  dialog and status bar, continuing when it closes, cancellable. Settings → **OCR
  languages** (size, offline, remove, import). i18n ≈ 40 keys; names via `Intl.DisplayNames`.
- Fixtures, rendered from existing fixtures with PDFium in Node and embedded as the only
  page content: `scan-simple.pdf` (from `simple-text.pdf`, 300 dpi), `scan-turkish.pdf`
  (every Turkish letter), `scan-skewed.pdf` (1.5°, seeded noise), `scan-rotated.pdf`
  (`/Rotate 90`), `scan-foreign-ocr.pdf` (another tool's mode-3 layer); words in the manifest.
- Tests: search finds ≥ 98% of `scan-simple` and ≥ 95% of `scan-turkish` words (every
  Turkish letter in some hit); render before/after is pixel-identical at 150 dpi; hit rects
  within 2 pt of the manifest boxes; the export yields the words in PDFium and pdf.js (qa
  tool); undo restores the original bytes; replay is byte-identical; e2e offline after "Keep
  available offline"; the Playwright request log has no non-self request.

## 2. Compare two documents

### 2.1 Behaviour

- **Entry:** "Compare with…" picks another open tab, "the file as opened" (this tab's
  sources without edits) or a file from disk. Both sides render as the engine sees them
  (content, edits, rotation, crop, resize); export-time overlays (numbers, watermark,
  headers) are excluded and the view says so.
- **Page matching:** by index, or best match (default when counts differ): Needleman–Wunsch
  over page similarity (Jaccard of word 3-shingles; without text, 32×32 greyscale thumbnail
  distance). Unpaired pages are inserted or deleted pages. O(n·m) is fine to 2 000 pages.
- **Visual:** both pages at the same DPI (100; option 150) in a common top-left frame (a
  size difference is itself a change); `pixelmatch` threshold 0.1 with anti-alias
  detection; changed pixels grouped on an 8 px grid into regions in user space; a heatmap.
- **Text:** tokens from `getPageText` runs via `Intl.Segmenter` (word, document language),
  normalised (NFKC, whitespace, soft hyphens, optional line-end hyphen joining), each with
  its glyph rects; `diffArrays` over the whole document (reflow across pages is not a
  change), per page pair when the 2 s `timeout` trips.
- **Facts:** page count and sizes, metadata, field values, annotation counts, attachments,
  signatures (existing inspection data). **Report:** a pdf-lib PDF with a summary page
  (files, fingerprints, page map, counts, honesty text), then each changed page of the
  second document with `/Square` and `/Highlight` annotations whose `/Contents` give old
  and new text; optionally a Markdown summary.

### 2.2 Placement, performance, honesty

- A **Compare** view in the stage (a third view-switch segment while a comparison is open;
  Esc leaves): paired columns, synced scroll, Side by side / Overlay (onion skin slider) /
  Difference (heatmap); a right-panel **Changes** list (J/K), rows with a +/−/~ glyph, never
  colour alone. Read-only; no history. Work runs in a new **analysis worker** (pure JS),
  visible pages first, then in the background; rendering stays in the PDFium worker at low
  priority; results cached per page pair and render key.
- Honesty text: a pixel diff shows *where* pages look different at this resolution, not
  why; the text diff sees only extractable text (scans need OCR; the view offers it) and
  depends on reading order; neither sees metadata, hidden annotations, scripts, undrawn
  field values, tags or object changes that render the same, beyond the facts list.

### 2.3 Interfaces, fixtures, tests

```ts
export interface CompareToken { readonly text: string; readonly rects: readonly Rect[] }
export interface ComparePage { readonly key: string; readonly size: Size;
  readonly tokens: readonly CompareToken[]; readonly thumb?: Uint8Array }
export interface PagePair { readonly a?: number; readonly b?: number; readonly similarity: number }
export interface PixelDiffResult { readonly changedRatio: number; readonly regions: readonly Rect[];
  readonly sizeMismatch: boolean; readonly heatmap: ImageBitmap }
export interface TextChange { readonly kind: 'added' | 'removed' | 'changed';
  readonly a?: TextSpanRef; readonly b?: TextSpanRef }   // TextSpanRef: page, text, rects
export interface PdfComparer {                          // analysis worker
  alignPages(a: readonly ComparePage[], b: readonly ComparePage[], o?: EngineCallOptions): Promise<readonly PagePair[]>;
  diffPixels(a: ImageBitmap, b: ImageBitmap, frame: { a: Size; b: Size; dpi: number },
    o?: EngineCallOptions & { threshold?: number }): Promise<PixelDiffResult>;
  diffText(a: readonly ComparePage[], b: readonly ComparePage[], pairs: readonly PagePair[],
    o?: EngineCallOptions & { scope?: 'document' | 'page-pairs' }): Promise<readonly TextChange[]>;
}   // PdfAssembler gains buildComparisonReport(input, o?): Promise<ArrayBuffer>
```

`compare-a.pdf` / `compare-b.pdf`: B changes three words, inserts and deletes a page, moves
an image, enlarges a page, edits the title. Tests: exactly those changes are reported; A
against A reports nothing; alignment tests with shuffled and duplicated pages; the report
re-opens with the expected annotations; 200 synthetic pages within the §8.5 budget.

## 3. Digital signatures

### 3.1 Validation

Runs on open when `SourceFlags.hasSignatures` is set, in a new lazily loaded **signature
worker** (pkijs, asn1js, pdf-lib). For each `/Sig` field with a `/V`:

1. **Byte range:** four integers from 0; the gap is exactly the `/Contents` hex string
   (read from the raw gap bytes, never from a decrypted string); inside the file; ending
   at a revision end.
2. **Digest:** WebCrypto hash of the ranges (SHA-256/384/512; SHA-1 flagged weak; MD5 is
   Cannot check) against `messageDigest` (`adbe.pkcs7.sha1`: the encapsulated digest;
   `ETSI.RFC3161`: the `TSTInfo` imprint).
3. **Signature** over the signed attributes with the signer key (RSASSA-PKCS1-v1_5,
   RSA-PSS, ECDSA P-256/384/521); `signingCertificateV2` present and matching.
4. **Chain** through certificates in the CMS and `/DSS`; each link verified; validity at
   the claimed time and now; key usage. **No trust store**: the best outcome is "chain
   complete to a root included in the file".
5. **Timestamp token**, if embedded: its CMS signature and imprint are checked; the TSA is
   not trusted. Embedded revocation data is listed "not evaluated"; nothing is fetched.
6. **Later changes:** each later revision is parsed (pdf-lib on the truncated bytes) and
   its changed objects classified: form fill, annotations, signature, DSS, metadata, pages,
   content. DocMDP `/P` decides what is allowed when present; otherwise form fill,
   annotations, signatures and DSS are. The signed revision's pages are pixel-compared with
   the current ones (§2 engine); "View signed version" opens that revision read-only.

**Statuses (ADR-0013); the UI never says "valid":** **Intact** (digest and signature
match, whole file covered), **Intact, changed later** (allowed kinds only, listed),
**Changed after signing** (other changes, with pages), **Broken** (digest, signature or
byte range wrong), **Cannot check** (format, algorithm or damaged CMS, with the reason).
Every status carries: "Checked on this device against the certificates in the file.
Signer identity, trust and revocation are not verified." Signer, issuer, the claimed time
("claimed by the signer") and each check's outcome are expandable.

### 3.2 PAdES-B signing: decision

**Signing stays in M5, conditional on spike S2.** The incremental writer already exists
in our pinned `@cantoo/pdf-lib`, so our own code is the signature dictionary and
placeholder, `/ByteRange` patching, CMS construction and verification: small and
testable. The open risk is that writer's correctness on our corpus, which S2 measures;
if it fails and a minimal own writer does not fit the spike (§8.1), signing moves to M6
and M5 ships validation only.

- **Identity:** a `.p12`/`.pfx` and password, parsed by pkijs (PBES2 only; 3DES/RC2 files
  refused with re-export instructions, e.g. OpenSSL `-keypbe AES-256-CBC -certpbe
  AES-256-CBC`). The key becomes a non-extractable WebCrypto key in the signature worker;
  bytes and password are dropped; nothing is stored; the worker ends after signing or 5
  minutes idle. RSA (PKCS#1 v1.5, SHA-256), ECDSA P-256/P-384.
- **Where:** the last step of export, over the verified output bytes, never an open
  source. `load(bytes, { forIncrementalUpdate: true })`; an approval field (invisible, or a
  visible widget with name, date, reason in bundled Inter); `/SubFilter
  /ETSI.CAdES.detached`, `/M`, fixed-width `/ByteRange`, zero-filled `/Contents` sized from
  the chain (default 16 KB), `/SigFlags 3`; `commit` without object streams; patch
  `/ByteRange` in the appended section only; CMS SignedData (contentType, messageDigest,
  signingCertificateV2, no signingTime, per PAdES) with the chain; write the DER hex or fail
  if it does not fit. Before download: our validator says Intact over the whole file,
  PDFium opens it, `qpdf --check` passes.
- **Refused in M5:** encrypted outputs (Cantoo's `encrypt()` writes strings in plaintext,
  `test/fixtures/README.md`); certification signatures; timestamps and LTV (TSAs and
  OCSP/CRL responders need network, lack CORS and are blocked by `connect-src 'self'`; only
  a user-run proxy would work, ADR-0007). **Existing signatures at export:** an unedited
  signed source exports as its original bytes (signing may append); any other export of a
  signed source says "Existing signatures will no longer verify in this file" first.

### 3.3 Interfaces

```ts
export type SignatureStatus = 'intact' | 'intact-changed-later' | 'changed-after-signing' | 'broken' | 'cannot-check';
export interface SignatureCheck { readonly id: 'byte-range' | 'digest' | 'signature' | 'signing-certificate'
  | 'chain' | 'validity' | 'key-usage' | 'timestamp' | 'later-changes';
  readonly outcome: 'pass' | 'fail' | 'not-checked' | 'unsupported'; readonly detail: string }
export interface RevisionChange { readonly revision: number; readonly kind: 'form-fill' | 'annotations'
  | 'signature' | 'dss' | 'metadata' | 'pages' | 'content' | 'other'; readonly pages: readonly number[] }
export interface SignatureValidation { readonly fieldName: string; readonly pageIndex?: number;
  readonly rect?: Rect; readonly subFilter: string; readonly revision: number;
  readonly signer?: CertificateSummary; readonly chain: readonly CertificateSummary[];
  readonly claimedTime?: string; readonly timestamp?: { readonly time: string; readonly tsa: string };
  readonly status: SignatureStatus; readonly checks: readonly SignatureCheck[];
  readonly laterChanges: readonly RevisionChange[]; readonly visuallyChangedPages: readonly number[] }
export interface PdfSignatureValidator {                // signature worker
  validate(bytes: ArrayBuffer, o?: EngineCallOptions & { password?: string }): Promise<readonly SignatureValidation[]>;
  revisionBytes(bytes: ArrayBuffer, revision: number): Promise<ArrayBuffer>;
}
export interface PdfSigner {                            // signature worker
  loadIdentity(p12: ArrayBuffer, password: string, o?: EngineCallOptions): Promise<SigningIdentity>;
  sign(bytes: ArrayBuffer, handle: string, req: SignRequest, o?: EngineCallOptions):
    Promise<{ readonly bytes: ArrayBuffer; readonly validation: SignatureValidation }>;
  forget(handle: string): Promise<void>;
}   // SigningIdentity: handle, subject, issuer, notAfter, key kind, chain length.
    // SignRequest: reason, location, contact, visible?: { pageIndex, rect }, reserveBytes.
```

`listFormFields` pairs signatures by parsed `/V` instead of by count (fixes the M4
follow-up: unsigned `/Sig` placeholders reported as signed).

### 3.4 UI, fixtures, tests

- A status word with a shield glyph in the tab and status bar; a **Signatures** section in
  the right panel (each signature, its checks, "Show on page", "View signed version"); the
  Forms panel shows it on signature fields. "Sign with certificate…" takes file, password
  and an optional visible box, and becomes the Export section "Sign (PAdES-B)", applied at
  download. i18n ≈ 50 keys.
- Fixtures: a test PKI (root, intermediate, RSA-2048 and P-256 signers; PKCS#8 and PBES2
  `.p12`, marked test-only, `test/fixtures/pki/`) and one legacy 3DES `.p12`; signed files
  made by an **independent** signer (`@signpdf` + forge, dev-only in `tools/fixtures`):
  `signed-pades`, `signed-then-annotated`, `signed-then-changed`, `signed-tampered`,
  `signed-twice`, `signed-sha1` (`adbe.pkcs7.sha1`), `signed-empty-field`.
- Tests: expected status and checks per fixture; a byte flip at 20 random positions in the
  ranges is always Broken; our output passes our validator, `openssl cms -verify` on the
  extracted ranges and poppler `pdfsig` (qa tool, CI-only; §8.6); signing twice keeps the
  first Intact; the key is non-extractable and the worker is gone after signing.

## 4. PDF → text / Markdown

- **Input:** the tab's pages (rotation applied): `getPageText` runs, `locateImages`, URI
  links. `PdfTextConverter.convert(pages, options): Promise<ConvertResult>` (files and a
  report of pages without text, headings, lists, images, suspected tables), analysis worker.
- **Reading order:** runs → lines (baseline clustering, tolerance 0.3 × font size) →
  blocks (gap > 1.2 × line height or indent change) → columns by recursive XY-cut on
  whitespace gutters → left to right, top to bottom. Lines repeated at the same place on
  ≥ 50% of pages (running headers, page numbers) are dropped unless kept. Tagged-PDF
  structure order is a follow-up.
- **Markdown:** body size = the size covering most characters; larger clusters (≥ 1.15×)
  and short bold standalone blocks become `#`–`####`; bullets (• ◦ ▪ – - *) and enumerators
  (`1.` `a)` `iv.`) become lists nested by indent; line-end hyphens joined; links as
  `[text](uri)`; images as `![Page 3, image 1](images/p3-1.png)` at their position, PNG (JPEG
  passed through) in a ZIP with the `.md` (fflate). Tables are not detected: their text
  comes out in reading order and the report counts suspected tables.
- **Output:** Markdown (`.md`, or `.zip` with images) or plain text; whole document or per
  page; page breaks as nothing, `---` or `<!-- page 3 -->`. **UI:** "Export as Markdown /
  text…" dialog with a monospace preview of the current page; i18n ≈ 25 keys.
- **Honesty:** "Reading order and headings are reconstructed from positions and font
  sizes: columns, sidebars, footnotes, tables and rotated text may come out in the wrong
  order." Pages without text are listed with an "OCR first" action.
- **Tests:** `markdown-structure.pdf` (title, H2/H3, lists, two columns, running
  header/footer, image, link) converts to a golden `.md`; unit tests per heuristic.

## 5. Batch: recipes over many documents

- **Recipe** = ordered existing operations plus an output rule. Steps: rotate, delete
  pages, crop, resize, page numbers, header/footer, Bates (continuous across the batch),
  watermark (image ≤ 1 MB embedded as base64), metadata set / strip, flatten, compress
  (preset), OCR (languages, quality or a fixed dpi, scope, what to do with existing invisible text; the batch renders at the recipe's dpi, Standard = 300), set password (permissions stored, passwords asked at
  run time, never stored), remove password (asked), convert (Markdown / text / images; last
  step). Page selectors: all, odd, even, ranges, first, last, landscape, portrait.
  Redaction is excluded on purpose (M4: nothing is applied automatically).
- **Schema (ADR-0014):** `{ "format": "pdf-editor.recipe", "version": 1, "id", "name",
  "description"?, "steps": [{ "op": "watermark", … }], "output": { "mode": "per-file" |
  "merge", "naming": "{name}-{recipe}", "zip": true } }`. Types and hand-written readers
  (in the style of `serialize.ts`) in `packages/document-model/src/recipe.ts`; stepwise
  migrations from older versions; newer versions and unknown ops rejected with the op name;
  imported recipes are data and pass the same readers.
- **Storage:** OPFS `recipes/<id>.json` (`navigator.storage.persist()` on first save);
  import/export as `.pdfrecipe.json`; built-ins: Scan to searchable, Web-ready,
  Print-ready, Strip metadata, Number pages.
- **Run:** files never become tabs. Each opens as a private source, the steps become model
  operations and engine edits, the normal export pipeline verifies the result, the source
  closes; one file at a time (two without OCR). Per file: done, done with notes (the export
  summary's honesty lines), or failed (password, XFA, corrupt, verification) with "Open in
  workspace". Output as a ZIP or, on Chromium, into a folder. "Apply recipe to this
  document" runs the steps on the open tab as one history entry.
- **UI:** "Batch…" opens a full-window dialog: recipes (list, import, export), steps (forms
  reuse the existing dialogs' controls), files (drop files or a folder), per-file progress
  and results. i18n ≈ 45 keys. **Tests:** write → read equal; unknown op, newer version and
  stored password rejected; migration from a v0 fixture; 5 steps over 10 fixtures give 10
  verified outputs and a ZIP; Bates continuous; e2e import, drop three files, run, download.

## 6. Also in M5

- `NOTICE`: tesseract.js, the core and its bundled libraries, the language models,
  `pdf.ttf`, pkijs, asn1js, jsdiff, pixelmatch; the CI licence check covers them.
- Privacy indicator: a Playwright check keeps "0 external requests" through OCR,
  compare, signing and batch. `ARCHITECTURE.md` §2 gains the two new workers.

## 7. Out of scope

Timestamps (RFC 3161), LTV/DSS writing, revocation checking, trust lists (AATL, EUTL),
certification signatures, signing encrypted files, hardware tokens (no browser API),
legacy `.p12` encryption (unless the owner decides otherwise), editing OCR text,
right-to-left and vertical OCR layers, handwriting, table extraction, DOCX export,
tagged-PDF reading order, comparing structure, scripts or annotation semantics beyond the
facts list, redaction in recipes, PDF/A.

## 8. Implementation plan

### 8.1 Spikes (first, in parallel with fixtures)

- **S1 — OCR offline feasibility and size** (`docs/research/07-ocr-spike.md`): worker and
  core from our origin under our exact CSP with `workerBlobURL: false` in Chromium,
  Firefox and WebKit, zero non-self requests; core variant and bytes over the wire;
  tessdata_fast vs `4.0.0_best_int` accuracy and time (eng, tur); glyphless layer: PDFium
  search rects, pdf.js extraction, Turkish; time and memory per page at 200/300/400 dpi
  with one and two recognizers; `rotateAuto` coordinates; bundled C library licences.
  Exit: numbers, thresholds, the ADR-0012 draft.
- **S2 — Incremental writer and PKCS#12** (`docs/research/08-signing-spike.md`): Cantoo
  `commit` on every corpus file (prefix byte-identical, `/Prev`, xref kind matching the
  source, objects inside object streams, two commits in a row); placeholder and
  `/ByteRange` patch; output accepted by a validator prototype, `openssl cms`, `pdfsig`
  and PDFium; pkijs parsing of OpenSSL 3 and Windows (AES256-SHA256) exports, 3DES
  refused; RSA and ECDSA signing with non-extractable keys. Rule: pass → sign on Cantoo;
  fail → an own minimal writer (new objects, rewritten AcroForm and page dictionaries,
  classic xref or xref stream matching the source) if it fits ≤ 600 lines with tests
  inside the spike; otherwise signing moves to M6.

### 8.2 ADRs needed

- **ADR-0012: OCR engine hosting and language packs** (core variant, pack source and
  set, on-demand fetch, OCR cache, local import; amends ADR-0010's caching policy).
- **ADR-0013: Signature validation semantics and signing** (status meanings offline, no
  trust store, signing as the last export step, keys in a terminating worker, refusals).
- **ADR-0014: Recipe file format** (public, versioned, secret-free, migration promise).

### 8.3 Workstreams and ownership

| # | Workstream | Owns | Depends on |
|---|---|---|---|
| W1 | OCR engine: recognizer adapter, pack loader and lock file, `ocrPageFacts`, `renderForOcr`, layer writer, `ocr.apply`, verification, build copy and PWA rules | `packages/engine/src/ocr/**`, `packages/engine/ocr/**`, `types.ts` and `EngineEdit` kinds (additive), `apps/web/vite.config.ts` (additive) | S1, ADR-0012, F |
| W2 | Analysis worker: alignment, pixel and text diff, report builder, layout → Markdown / text, ZIP | `packages/engine/src/analysis/**`, `src/convert/**`, `worker/analysis.worker.ts`, `pdflib/compare-report.ts` | F |
| W3 | Signatures: validator, revision classifier, signer, signature worker, `listFormFields` pairing | `packages/engine/src/signatures/**`, `worker/signature.worker.ts`, `pdfium/pdfium-adapter.ts` (pairing only) | S2, ADR-0013, F |
| W4 | OCR and convert UI: OCR dialog, panel section, language manager, Markdown dialog | `apps/web/src/ocr/**`, `apps/web/src/convert/**`, `messages/*.json` (new keys) | W1, W2 API shapes |
| W5 | Compare view and signatures UI: stage view, Changes panel, report export, badges, Signatures section, sign dialog and export section | `apps/web/src/compare/**`, `apps/web/src/signatures/**`, `stage/**`, `export/**` (additive), `messages/*.json` | W2, W3 API shapes |
| W6 | Batch: recipe types and readers, runner over the export service, storage, built-ins, dialog | `packages/document-model/src/recipe.ts`, `apps/web/src/batch/**`, `messages/*.json` | ADR-0014; W1 for the OCR step |
| F | Fixtures and QA cross-checks: scans, compare pair, PKI and independently signed files, Markdown fixture; qa-tool checks (pdf.js text, `openssl cms`, `pdfsig`) | `tools/fixtures/**`, `test/fixtures/**`, `tools/qa/**` | — |
| R | Independent correctness review of W1, W3, W6 with the corpus | read-only, findings as issues | all |

Rules as in M4: one agent per workstream, no edits outside owned paths, the lead
integrates and commits, every R finding is fixed with a regression test.

### 8.4 Order

1. S1, S2 and F in parallel (F delivers the scans first for S1, the PKI for S2).
2. ADR-0012, 0013, 0014 with the owner.
3. W1, W2, W3 and the model part of W6 in parallel; W4 and W5 start on the API shapes.
4. UI integration; W6's OCR step after W1; signing wired into export last.
5. R, fixes, docs (`ARCHITECTURE.md`, `ROADMAP.md`, `NOTICE`), changeset (`minor`).

### 8.5 Acceptance (in addition to §1–§5)

- **OCR:** §1.5 thresholds on all three browsers; zero non-self requests; works offline
  after "Keep available offline"; median ≤ 6 s per A4 page at 300 dpi on the CI runner
  (Chromium, eng; S1 may revise with measurements); first use downloads ≤ 4 MB gzip for one
  language (core + worker + pack); no OCR file precached.
- **Compare:** exactly the seeded changes; 200 pages at 100 dpi in ≤ 60 s on the CI runner
  with no main-thread task over 200 ms (Long Tasks API in e2e).
- **Signatures:** zero false Intact in the tamper test; no incremental output unless the
  user signed or exported an unedited signed source. **Batch:** no password in any
  serialized recipe (property test over generated recipes).
- **Bundle:** the shell grows ≤ 60 KB gzip; tesseract, pkijs and the analysis code load
  only when used (Lighthouse budget).

### 8.6 Open questions for the owner

1. The language set on the origin (§1.1), and fast vs best_int, after S1.
2. Legacy (3DES/RC2) `.p12`: refuse with instructions (proposed), or add a decryptor
   (node-forge under its BSD-3 option, ≈ 1.6 MB unpacked, or our own code).
3. Poppler `pdfsig` (GPL) as a CI-only cross-check, never distributed: acceptable under
   ADR-0001, which governs shipped dependencies?
4. Approval signatures only in M5, certification in M6?
5. Validate signatures automatically on open (proposed; purely local) or on request?
6. Compare report: change annotations on the second document (proposed) or full
   side-by-side page images (larger files)?

### 8.7 Decisions (project lead, 2026-09-28; the owner delegated these)

1. Language packs: eng and tur first, then deu, fra, spa, ita, por, nld, rus, all from our
   origin; fast versus best_int is decided by spike S1's accuracy and size numbers.
2. Legacy 3DES/RC2 PKCS#12 files are refused with re-export instructions in M5; a
   decryptor is reconsidered only if users hit it.
3. poppler `pdfsig` may run as a CI-only cross-check: ADR-0001 governs shipped code, and
   CI tooling is not distributed. It must never enter a package dependency.
4. Approval signatures only in M5; certification signatures in M6.
5. Signatures are validated automatically on open (purely local); the result is a badge
   with the fixed honesty line.
6. The compare report annotates the second document; full side-by-side images are not
   produced.
