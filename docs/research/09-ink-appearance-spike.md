---
title: "Research: ink appearance spike S1 (variable-width ink in our own appearance stream) for M6 §6.7"
date: 2026-10-01
status: snapshot
---

> Spike S1 of `docs/specs/experience-redesign.md` §6.7, run on 2026-10-01 with `@embedpdf/*`
> 2.15.1, `@cantoo/pdf-lib` 2.11.1 and `pdfjs-dist` 6.3.289 in headless Chromium 141 (Linux).
> Evidence: `packages/engine/src/pdfium/ink-appearance.spike.test.ts` (8 tests, about 15 s,
> `[spike] …` lines with `--silent=false`); under the 60 s budget, so CI runs it. New, exported,
> unused by the app: `pdfium/host/annot-appearance.ts` (raw helpers) and
> `annotations/ink-outline.ts` (our own outline generator; no `perfect-freehand`, see §5).

# Ink appearance spike: variable width lives in our appearance stream

## 0. Verdict

**Go for P4.** PDFium renders our appearance stream exactly as written, and so does pdf.js,
`/Rotate 90` included. Saving, reopening, flattening, export and the export verification all
keep it. On every page we tested, the drawn width is within 0.1 pt of the planned width. Two
findings shape P4:

- **Updates replace our appearance.** `PdfiumAdapter.updateAnnotation` passes
  `regenerateAppearance: true`, so EmbedPDF redraws the ink at a constant `/BS /W`. The
  private widths survive; writing our appearance again restores the variable width.
- **Each in-session rewrite leaves an orphan stream** in `save()` output; export drops them
  (ADR-0011 §5).

The private key works, but as a **text string** rather than an array (§5).

## 1. Hypotheses

H1: the PDFium host can replace an ink's normal appearance (`FPDFAnnot_SetAP`) on create and
update, and PDFium renders it without generating its own. H2: pdf.js draws it with the right
colour, opacity and placement, `/Rotate 90` included. H3: `save()`, flattening, export and
`verify()` keep it; a 64-path annotation costs tens of KB and well under 100 ms per update.
H4: the two matrix rows of §6.7 can express it.

## 2. Method

- **Strokes.** Straight tapers: 25 `/InkList` points, widths 1 → 9 pt linear, nominal
  `/BS /W` 4 pt; `#1E5BD8` opaque and `#E53935` at 60 %. The 64-path case is a full burst
  (spec §6.4): 64 strokes × 40 points, 0.5–2 pt (nominal 1.5 pt).
- **Write.** `adapter.createAnnotation` (EmbedPDF draws the ink at `/BS /W`), then one
  `host.withRawAccess` running `setAnnotationAppearance`: `FPDFAnnot_SetRect` (outline bounds
  + 0.5 pt, which becomes the /BBox), `FPDFAnnot_SetAP` (all outlines in one nonzero `f`),
  `FPDFAnnot_SetStringValue` (`/PdfEditorInkWidths`), then the page cache is dropped.
- **Width.** At 10/30/50/70/90 % along the stroke, pixels along the normal are projected onto
  "white → expected colour composited over white" (other colours count 0) and integrated in
  points: drawn width and centre offset. Each renderer maps points to pixels itself
  (`coords.ts` for PDFium, `viewport.convertToViewportPoint` for pdf.js). Pass: every sample
  within 0.6 pt of the plan, centre within 0.6 pt, last/first ≥ 3 (a constant width fails).
- **Renderers.** PDFium: `PdfiumAdapter.renderPage` on the hosted engine at 2×. pdf.js: canvas
  at 2× with `AnnotationMode.ENABLE`, plus `getAnnotations()`.
- **Corpus.** A taper on each of 18 pages (`simple-text`, `rotated-pages` 0/90/180/270,
  `cropbox`, `mixed-sizes`, `annotations`, `tagged`): written, saved, verified with
  `checkAnnotations`, reopened, drawn by both. The **matrix sample**
  (`docs/qa/samples/annotations-sample.pdf`) gets the two proposed entries in memory.

## 3. Measurements

**Q1 (PDFium) and Q2 (pdf.js).** Drawn width at 10/30/50/70/90 %, planned 1.8/3.4/5.0/6.6/8.2:

| Step | Width (pt) |
|---|---|
| PDFium, EmbedPDF's own appearance after create (both pages) | 4/4/4/4/4 (a stroke at `/BS /W`) |
| PDFium after `FPDFAnnot_SetAP`, page 1 | 1.86/3.41/5.07/6.60/8.28 (centre ≤ 0.04 pt off) |
| PDFium after `FPDFAnnot_SetAP`, page 2 (`/Rotate 90`, 60 %) | 1.88/3.41/5.07/6.60/8.29 |
| PDFium after `adapter.updateAnnotation` (colour change) | 4/4/4/4/4: EmbedPDF's again |
| PDFium after re-applying from the stored widths | variable again, within tolerance |
| pdf.js, saved file, page 1 | 1.86/3.36/5.00/6.66/8.16 (centre 0 off) |
| pdf.js, saved file, page 2 (`/Rotate 90`, 60 %) | 1.79/3.41/5.00/6.60/8.20 (centre 0 off) |

Rendering, listing and rendering again leave `FPDFAnnot_GetAP` byte-identical to what we
wrote: PDFium does not regenerate an existing `/AP /N`; no `PDFIUM_HasGeneratedAP` key is
written. In both renderers the thick end's colour is within 14 per channel of the composited
one. pdf.js's `getAnnotations()` reports `borderStyle.width` 4 and the 25-point `inkLists`.

**Q3: save, reopen, flatten, export.**

- **Saved keys:** `/AP /BS /C [/CA] /Contents /F /InkList /M /NM /P /PdfEditorInkWidths /Rect
  /Subtype /T /Type`; `/BS /W` 4; /BBox = /Rect; the stream is `/FlateDecode` (PDFium's writer
  compresses our unfiltered stream). With /CA 0.6 PDFium added `/Resources /ExtGState /GS`
  (CA 0.6), so our `/GS gs` resolves and the conformance `opacity` rule passes.
- **Reopen (a later session):** the stream is byte-identical; the widths decode against
  `/InkList`; a move (adapter update, then re-apply) draws the variable width at the new place;
  widths whose point count no longer matches decode to `undefined`.
- **Flatten:** `save({ flattenAnnotations: true })` leaves 0 annotations (verified); both
  renderers draw the baked outline with the same widths.
- **Export:** `save()` → `PdfLibAssembler.assemble` → `verify({ checkAnnotations,
  annotationIds, rotations })` is `{ ok: true, problems: [] }`; the stream is byte-identical
  and PDFium draws it with variable width.
- **Corpus:** all 18 pages pass in both renderers, conformance and verification clean; widths
  at 10 % → 90 % were 1.78–1.86 → 8.15–8.28 pt for every rotation and crop box.

**Q3: the 64-path annotation** (2,560 points; times from two runs on a shared 4-vCPU machine).

| Measure | Value |
|---|---|
| Our appearance content (uncompressed / zlib) | 91,370 B / 22,873 B |
| EmbedPDF's constant-width appearance (uncompressed) | 44,455 B |
| `/PdfEditorInkWidths` (2 decimals / 1 decimal) | 12,673 B / 10,241 B, an uncompressed dict string |
| `save()` with EmbedPDF's appearance → with ours | 60,052 B → 94,414 B (+34,362 B, of which one orphan, below) |
| `save()` after 5 update + re-apply rounds | 249,971 B: 12 form XObjects, **11 unreachable** |
| Export of that (assembler, object streams) | 34,711 B: 1 form XObject, 0 unreachable |
| `createAnnotation` (EmbedPDF, 64 paths) | 21–49 ms |
| Outline + content generation | 9–12 ms |
| `setAnnotationAppearance` (rect, AP, widths, cache drop) | 13–16 ms |
| `updateAnnotation` (EmbedPDF rewrites `/InkList` and regenerates) | 13–21 ms (median of 5) |
| Re-apply (outline + raw write) | 9–20 ms (median of 5) |
| Page render at 2×, ours / EmbedPDF's appearance | 39.7 / 38.8 ms |

Appending a stroke costs as much as a recolour (both rewrite every path): 25–40 ms in all.

## 4. Q4: matrix proposal and result

`tools/qa/annotation-sample-plan.ts` gains `PROPOSED_INK_ENTRIES` and `PROPOSED_INK_ROWS`
behind `PROPOSED_INK_WIDTH_ENABLED = false`; the generator and checker read only `PLAN` and
`ROWS`, so the committed sample and `docs/qa/annotations-matrix.md` do not change. P4 turns the
flag on, merges them, writes `widths` from the generator and adds the `width` and
`nominal-width` checks to `annotation-matrix.ts` (reference: the spike's `widthProfile`).
Measured on the committed sample (in memory), both rows pass in both renderers:

| Row | PDFium | pdf.js |
|---|---|---|
| Ink, variable width (appearance), page 1 | ok: 1.86/3.41/5.07/6.60/8.28 | ok: 1.86/3.35/5.00/6.66/8.16 |
| Same, page 2 (`/Rotate 90`, 60 %) | ok: 1.89/3.41/5.07/6.60/8.29 | ok: 1.79/3.40/5.00/6.60/8.20 |
| Ink `/BS /W` equals the nominal width (both) | ok: `strokeWidth` 4 | ok: `borderStyle.width` 4 |

## 5. Recommended write path

1. **Format** (spec §6.7, one change): `/InkList` centre lines; `/BS /W` nominal width;
   `/AP /N` our outline (user space, /BBox = /Rect = outline bounds + 0.5 pt, one nonzero
   fill, `/GS gs` only when /CA < 1); `/PdfEditorInkWidths` a **PDF text string**
   `1;w w …;w w …` (version, one group per path, 2 decimals), not an array. PDFium's public API
   reads and writes only string and number values of arbitrary keys
   (`FPDFAnnot_Get/SetStringValue`); an array needs pdf-lib at save and at open, outside the
   session's document (`/PdfEditorOCR` is written by pdf-lib into bytes, never into it).
2. **Where.** The raw write lives in `pdfium/host/annot-appearance.ts` (ADR-0011's raw home;
   no new one). P4's `annotations/ink-appearance.ts` folds in `ink-outline.ts`. The adapter
   calls the host right after EmbedPDF's create or update of an ink with `widths`, in the same
   adapter call, so the app paints only the finished state.
3. **Update.** For ink with widths, pass `regenerateAppearance: false` to EmbedPDF, then write
   ours: no constant-width intermediate, half the orphans. Not exercised here (the adapter
   passes `true`); P4 verifies it with the same `widthProfile` check.
4. **Read and regenerate.** `listAnnotations` reads the key (`FPDFAnnot_GetStringValue`) and
   decodes it against `/InkList`, dropping `widths` on a mismatch (spec §9); any later update
   regenerates from (paths, widths). P4 decides how widths scale on a resize.
5. **One outline function** for preview and commit, pure in (centre line, widths), exported to
   the app like `./overlay-geometry`. `perfect-freehand` may still turn pressure or speed into
   widths in P3, but it moves points (`streamline`, `smoothing`): its outline is not a function
   of `/InkList`, so a later session could not regenerate it and "outline equality preview vs
   commit" would compare different shapes.

## 6. Risks

- **Viewers that redraw ink from `/InkList`** show the nominal width, e.g. editors that
  rebuild the appearance when the user edits it (Acrobat, pdf.js's editor on an existing ink):
  the honesty line of spec §6.7. Acrobat, Preview and Edge were not tested; plain viewing in
  pdf.js and PDFium uses our stream.
- **Orphans:** each in-session `SetAP` or regeneration leaves the previous stream in `save()`
  output (about 25 KB per rewrite of a 64-path burst). Export collects them (measured); any
  other path that ships `save()` bytes must too. Flattening bakes exactly our outline.
- **Validators:** `/PdfEditorInkWidths` is a private, unregistered key (ISO 32000 Annex E
  recommends a registered prefix). PDF/A validators generally accept extra keys, and an Ink
  with /AP and the Print flag meets the usual PDF/A annotation rules, but no validator
  (veraPDF) was available here: **not verified**.
- **Outline quality:** miter joins (limit 2) and round caps; a very sharp turn can leave a
  small notch on the inner side. P4 judges it on real handwriting.
- **Size:** our stream is about 2× EmbedPDF's uncompressed, about 23 KB per full burst
  compressed; the widths string is uncompressed in `save()` output (export object streams
  compress it).

## 7. Decision to record (draft ADR-0018: variable-width ink)

**Status:** proposed · **Context:** spec experience-redesign.md §6.7. Ink has no standard
per-point width; research 09 shows our own appearance stream survives PDFium, pdf.js, save,
flatten and export.

**Decision.**

1. A variable-width ink is a standard Ink annotation: `/InkList` centre lines, `/BS /W` the
   nominal width, `/AP /N` our filled outline (one nonzero fill, user space, /BBox = /Rect),
   and the private text string `/PdfEditorInkWidths` (`1;…`, widths parallel to `/InkList`).
2. The engine writes it through the PDFium host (`FPDFAnnot_SetRect`, `FPDFAnnot_SetAP`,
   `FPDFAnnot_SetStringValue`; `pdfium/host/annot-appearance.ts`) inside the adapter's create
   and update, after EmbedPDF's own write (without regeneration once P4 verified that flag).
3. The outline is a pure, versioned function of centre line and widths, shared by the preview
   and the engine, and regenerates the appearance after any update.
4. Widths that do not match `/InkList` are dropped (constant width); other ink is unchanged.
5. Export keeps collecting garbage (ADR-0011 §5), which drops the replaced streams.

**Consequences.** Pressure and speed reach every viewer that draws `/AP`; viewers that redraw
from `/InkList` show the nominal width (stated in the UI). An update costs about 25–40 ms for a
64-stroke burst; files grow by about 23 KB (appearance) + 13 KB (widths) per full burst.

**Alternatives.** A real array key (pdf-lib at save and at open);
`EPDFAnnot_SetAppearanceFromPage` from a one-page PDF, as stamps do (heavier, and PDFium already
compresses on save); one annotation per segment (bloats the Review list); `perfect-freehand` in
the engine (cannot regenerate from `/InkList`, §5); constant width only (§6.7's failure path).
