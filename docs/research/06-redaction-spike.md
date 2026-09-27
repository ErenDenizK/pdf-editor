---
title: "Research: redaction spike (EmbedPDF 2.15.1 PDFium) for M4 §1"
date: 2026-09-27
status: snapshot
---

> Spike run on 2026-09-27 against `@embedpdf/engines` / `@embedpdf/pdfium` 2.15.1 and
> `@cantoo/pdf-lib` 2.11.1. The evidence is `packages/engine/src/pdfium/redaction.spike.test.ts`
> (19 tests, about 3 s). Its assertions pin the behaviour described here, so an EmbedPDF upgrade
> that changes any of it fails the spike. Feeds `docs/specs/redaction-and-text-editing.md` §1.2.

# Redaction spike: what EmbedPDF removes and what we must add

## 0. Method

Each case builds its own PDF with pdf-lib. The secret token is `SECRET-7731`, and sentinel
strings such as `KEEP-ME` must survive. Every case is redacted in four ways:

- **rects**: `redactTextInRects`, with `recurseForms` true and `drawBlackBoxes` true.
- **annot-all**: a /Redact annotation with `color` #000 (so /IC is black), then `applyAllRedactions`.
- **annot-one**: the same annotation, then one `applyRedaction` call per annotation.
- **adapter**: `PdfiumAdapter.createAnnotation({kind:'redact'})`, then `applyRedactions`, then `save`.

Every output goes through `saveAsCopy`, the same path as the adapter's `save`. The output is
then checked through these channels:
- PDFium `getPageText` over the whole page and inside the regions, plus `searchAllPages`.
- A raw byte grep for the token as ASCII, UTF-16BE and ASCII-hex / UTF-16BE-hex (both cases).
- The same grep over every stream after fflate `unzlibSync`.
- A pdf-lib walk that decodes every string of every indirect object.
- Reachability of each object from the trailer.
- Pixels of a scale-2 render, and the decoded pixels of the image XObjects.
- The annotation list, `/Prev`, and the number of `%%EOF` markers.

To rerun with artifacts: `VITE_REDACTION_SPIKE_OUT=.vitest/redaction-spike pnpm --filter @pdf-editor/engine exec vitest run src/pdfium/redaction.spike.test.ts`.
This writes the PNGs and `findings.json` under `packages/engine/.vitest/` (gitignored).

## 1. What the API actually does (read from `direct-engine-*.js` and confirmed at runtime)

- **`redactTextInRects(doc, page, rects, {recurseForms, drawBlackBoxes})`** calls
  `EPDFText_RedactInQuads(page, quads, recurseForms, false)` and then `FPDFPage_GenerateContent`.
  - The wrapper hard-codes `drawBlackBoxes` to **false**, so the option is ignored.
  - Despite the "Text" in the name, the call also whitens image pixels and converts inline images (§2).
  - It does nothing to paths, annotations or widgets.
  - Rects are in EmbedPDF's display space: top-left origin, after /Rotate. Convert them with
    `coords.userToDeviceRect`.
- **Raw `EPDFText_RedactInRect(page, FS_RECTF*, recurse, true)`** is reachable only through the
  raw module. With drawing on, it appends a plain black path to the page content
  (`q x y w h re f Q`). This is not an annotation, and its colour is fixed.
- **`createPageAnnotation(REDACT)`** writes these keys:
  - `/QuadPoints`
  - `/IC`, taken from `color`
  - `/OC`, taken from `overlayColor`
  - `/C`, taken from `strokeColor`
  - `/OverlayText`, `/DA`, `/AP` (N/R/D) and `/RO`

  The `/RO` stream is only a rectangle filled with the /IC colour (`/GS gs 0 0 0 rg … re f`).
  **The overlay text is never drawn** and is not extractable after apply (`fill-overlay.png`).
- **`applyRedaction` / `applyAllRedactions`** call `EPDFAnnot_ApplyRedaction` /
  `EPDFPage_ApplyRedactions`.
  - They remove content the same way as `recurseForms: true`.
  - They flatten `/RO` into a new Form XObject appended to the page (`q /FXXn Do Q`).
  - They delete the /Redact annotations: none were left in any run.
  - /IC is honoured (red gives a red fill). With no /IC, content is removed and nothing is painted.
- **Adapter bug:** for `redact`, `annotation-mapping.ts` `toEmbedPdf` maps `color` to `strokeColor`
  and `interiorColor` to `overlayColor`, and never sets `color`.
  - As a result /IC is cleared, and the adapter's `applyRedactions` removes the text but paints
    **no box** (`fill-adapter.png`, `e-after-adapter.png`).
  - The existing adapter test does not catch this because it checks text only.
  - Fix for M4: `color: a.interiorColor ?? '#000000'`, and a separate field for the overlay colour.
- **`saveAsCopy`** (`PDFiumExt_SaveAsCopy`) always writes a full copy with no `/Prev` and a single
  `%%EOF`.
  - It **drops** objects that were unreachable in the *parsed* file: the case (k) history and the
    case (k2) orphans.
  - It **still writes objects created in this session that became unreachable** (§2, #801 row).
    This is the one leak we found in the engine's own output.
- **Speed is not a concern.**

  | Measurement | Time |
  | --- | --- |
  | many-pages p200, apply | 3–4 ms |
  | many-pages, open → apply → save of 400 pages | 20 ms |
  | 3,000 text objects on one page | 16 ms (annot) / 30 ms (rects) |
  | 20 annotations, one `applyAllRedactions` | 15 ms |

## 2. Channel matrix

Key: **yes** means removed in every method. The **Post-pass** column is what we must add.

| Case | Engine result | Post-pass / pipeline must |
| --- | --- | --- |
| (a) token in one Tj | **yes**: text, search, raw bytes, inflated streams all clean. The stream is regenerated (text written as hex `<…> Tj`). `rects` paints nothing; `annot-*` paints the /IC box (`a-*.png`). | Nothing for content. Draw the fill ourselves if we use `rects`. |
| (b) token split across 2 text objects and 2 TJ arrays | **yes**. TJ runs are split and the survivors keep their exact position (`TAIL-PUBLIC` x = 225.2 before and after). Neighbours `HEAD-PUBLIC` and `TAIL-PUBLIC` are kept. | Nothing. |
| (#801) one text object crossing 2 regions | **yes** in all methods (`AAA BBB CCC` remains), so the upstream fix is in 2.15.1. **But** applying annotations one at a time (`annot-one`, or two adapter "Apply" rounds in one session) leaves an **unreachable intermediate content stream** in the saved file. It still holds the second token, as hex text. | **Garbage-collect before download:** pdf-lib `dropUnreachable`, or a PDFium open → saveAsCopy round trip (verified clean). Apply once per page. The self-check must assert "no unreachable objects". |
| (c) partially covered glyphs | **Whole glyphs** go when their box intersects the area at all. A 40 % cover of `CONFIDENTIALWORD` leaves `NTIALWORD`. A strip over the top 30 % of `TOPSLICEWORD` removes the whole word. No half-glyphs remain (`c-after-rects.png`). | Nothing for safety. The UI preview should snap to glyph extents, because rectangle marks over-redact neighbours. |
| (d) text in a Form XObject shared by 2 pages | `recurseForms` true, and the annotation path: **yes** on the redacted page, **copy-on-write**. Page 0 gets a redacted copy (`/FXX1`). The shared original stays and still shows the token on page 1, which is correct. `recurseForms` false: **no** (`applied=false`). | Always use recurse (the annotation path does). The self-check must be per page and region, because a whole-file grep legitimately hits page 1. "Redact all matches" must mark every page. |
| (e) raster image, half covered and fully covered | **Pixels overwritten with white** inside the image data, in place (same objects). The half-covered image is 50 % white and 50 % original. The fully covered image is **kept as an all-white image, not removed**. No orphan originals are left. A JPEG is **re-encoded as Flate** (images.pdf grew from 54 to 72 KB). `annot-*` adds the box on top (`e-*.png`). | Optional: remove images that end up fully blank, and re-encode grown JPEGs through the compress pipeline. |
| (f) inline image (BI/ID/EI) | **yes**. It is converted to an image XObject with the covered pixels white. `BI` is gone from the content. | Nothing. |
| (g) vector paths | **no**. Paths are neither removed nor clipped. `rects` leaves the stream untouched, and `annot-*` paints the box over intact geometry (`g-after-annot-all.png`). | **Our pass.** With raw PDFium page objects (`FPDFPage_CountObjects` / `GetObject` / `FPDFPageObj_GetType` / `GetBounds` / `FPDFPage_RemoveObject` / `GenerateContent`, prototyped): "covered" removed 1 path, "touched" removed 3, including the whole background bar (`paths-remove-*.png`). Policy decision in §5. |
| (h) Link (URI with token), Text note + Popup, Highlight, plus a Square elsewhere | **no**. All annotations survive in every method, and `/URI` and `/Contents` still carry the token as raw ASCII. | Delete every annotation that intersects a region, together with its /Popup and IRT replies. Delete links. Also delete any annotation whose strings contain a redacted string. |
| (i) text-field widget with the token as value | **no**. `/V` and `/AP` are untouched, and `listFormFields` still returns the value. **The widget paints above the black box, so the value stays fully visible** (`i-after-annot-all.png`). PDFium text extraction does not see widget text. | Clear `/V` and `/DV`, drop `/AP`, and remove the widget, plus the field if it has no widgets left. Drop `/XFA` datasets. Check with a render that uses `withForms`. |
| (j) outline title, Info Title/Subject/Keywords, XMP, named-dest key, FileAttachment (`/Contents` and the EF stream), EmbeddedFiles (`/Desc` and body), `/ActualText`, `/Alt` | **no**, with one exception. The engine drops `/ActualText` and `/Alt` **only on the struct element whose marked content it removed**, and leaves its `/K 0` MCID dangling. All other channels survive. | Full document scrub (§3 step 4). The prototype scrub in the spike made every channel clean. pdf-lib's `attach()` also lists the filespec in catalog **`/AF`**: missing it left one leak. |
| (k) incremental history (hand-written update: new page version, new Info, orphaned old Info and old content stream) | **yes**. `saveAsCopy` output has no `/Prev`, one `%%EOF`, and neither the old title nor the old content stream. | The self-check asserts it. Never offer an incremental save after redaction (the adapter already refuses `incremental`). |
| (k2) unreferenced objects in a single-revision source | **yes**. They are dropped by `saveAsCopy`, even without redaction. | Nothing. |
| (l) render mode 3 (invisible OCR text) | **yes**. It is found by search and removed; invisible neighbours outside the area survive. | Nothing. |
| (m) /Rotate 90 page | **yes** with display-space rects, from `userToDeviceRect` or the search rects. A user-space rect passed unconverted **silently misses** (token survives, `applied=true`). | Always convert through `coords.ts`, and let the self-check catch mistakes. |

## 3. Recommended pipeline for M4 §1.2

**Where it runs.** Run it in a dedicated worker with a **private `PdfiumNative`**. The compress
worker already does this in `compress/pdfium-decoder.ts`. The viewer's EmbedPDF worker exposes
neither the page-object API (paths) nor black-box drawing. It would also accumulate in-session
orphans in the user's open document. The viewer only creates and edits the /Redact marks, which
are ordinary annotations.

0. **Capture before applying.** For every mark, record the page, user-space quads, fill colour and
   overlay text. Also record the **redacted strings**: the glyph text under each quad from
   `getPageText`, plus any search term that produced the marks. Normalise case and whitespace for
   the scrub and the check.
1. **Engine pass.** Open the source bytes in the private PDFium, calling `removeEncryption` if the
   file is encrypted.
   - For each page with marks, create the /Redact annotations with **`color: 'transparent'`**
     (no /IC).
   - Call **`applyAllRedactions(doc, page)` exactly once per page**. This removes text in page
     content and forms (copy-on-write), invisible text and inline images, and whitens image pixels.
     The marks disappear.
   - An equivalent alternative is `redactTextInRects(… {recurseForms: true})`. Both give a region
     that must now **render blank**.
2. **Page-object pass** (raw module, same worker): remove path objects according to the §5 policy.
   - Optionally remove image objects whose pixels are now all white.
   - `FPDFPage_GenerateContent`, then `saveAsCopy`.
3. **Blank-region gate.** Render each region at scale 2 with annotations and forms. Every pixel
   must be the page background. Anything else is content the engine did not remove: a path, a
   widget or annotation on top, or an unhandled construct. It is reported per region, *before* any
   fill hides it.
4. **pdf-lib post-pass** on those bytes:
   1. **Annotations.** Delete those whose /Rect or /QuadPoints intersect a region, together with
      their /Popup, IRT replies and FileAttachments. Also delete any annotation whose strings
      contain a redacted string, and all links in regions.
   2. **AcroForm.** For fields with a widget in a region: clear `/V` and `/DV`, remove the widget
      and its `/AP`, and remove the field from `/Fields` when it has no widgets left. Remove `/XFA`.
   3. **Strings.** In outline `/Title`, `/Info`, struct `/ActualText` `/Alt` `/E` `/T`, name-tree
      keys (`/Dests`: rename and update `/Dest` / GoTo `/D` referrers, keep the tree sorted), page
      labels and annotation strings, replace redacted strings with the placeholder. The spike's
      `replaceStrings` is the naive version of this.
   4. **Metadata.** Regenerate XMP from the scrubbed Info with `pdflib/metadata.ts` `writeXmp`.
      Delete per-object `/Metadata`, `/PieceInfo`, page `/Thumb`, `/Names/JavaScript`,
      `/OpenAction` scripts and `/AA` (reuse the "Strip metadata" predicates). Also drop dangling
      struct `/K` MCIDs, or mark the file untagged.
   5. **Attachments.** Remove every `/EmbeddedFiles` entry, catalog `/AF` entry and FileAttachment
      whose name, description or decoded body contains a redacted string. Binary bodies cannot be
      searched reliably, so default to "remove all attachments" with an opt-out.
   6. **Fill.** Draw the fill rectangles, in black or the chosen colour, as page content: append a
      `q … re f Q` stream to the page content with pdf-lib, plus the overlay text with an
      embedded standard font. The engine's `/RO` cannot draw overlay text anyway.
   7. **Rewrite.** `dropUnreachable(doc)` (this removes the #801 in-session orphans), regenerate
      `/ID`, then `save()`. A full rewrite without `/Prev` is always the result, because pdf-lib
      never writes incremental sections.
5. **Encryption and object streams** (qpdf plumber), only if the export asks for them. They run
   *after* step 6 on the unencrypted bytes, and the check reruns on the final bytes with the password.
6. **Forensic self-check** (§4) on the exact bytes offered for download. Any hit blocks the export.

## 4. Forensic self-check design

Inputs:
- the final bytes and the password;
- the regions (page and user-space rects);
- the redacted strings S;
- the fill colour;
- "all occurrences" (the whole-document search mode) or "area only".

| # | Check | Tool | Catches |
| --- | --- | --- | --- |
| 1 | Single revision: no `/Prev` in any trailer or xref-stream dict. Exactly one `startxref`, since we never linearize after redaction. | Latin-1 regex on raw bytes | incremental history (k) |
| 2 | **No unreachable indirect objects:** `enumerateIndirectObjects` minus the set reachable from Root and Info must be empty. | pdf-lib (the spike's `reachableRefs`) | #801 in-session orphans, stale revisions |
| 3 | No glyph box intersects a region (existing `PdfVerifier.redactedRegions`) on every affected page. | PDFium `getPageText` | text left in the area, whole-glyph logic |
| 4 | Search every s in S: zero hits ("all occurrences"), or the same hit count outside regions as before ("area only"). | PDFium `searchAllPages` | forms on other pages, OCR layers, mode-3 text |
| 5 | Decode every string and name of every object: outline, Info, struct tree, dest keys, annotation and field strings, filespecs. No s may appear. | pdf-lib object walk (the spike's `stringHits`) | (h), (i), (j) document channels |
| 6 | Grep raw bytes and every inflated stream for s. Encodings: ASCII, UTF-16BE, ASCII-hex and UTF-16BE-hex in both cases, and literal-string escapes. Covers XMP, attachments, JavaScript, AP streams and hex `Tj` in PDFium-written content. | fflate `unzlibSync` plus byte search. Other filters via pdf-lib `decodePDFRawStream`, with undecodable streams (DCT, JBIG2) listed as "not searched" | anything outside the object model |
| 7 | No annotation or widget intersects a region, and no /Redact annotation remains. | PDFium `listAnnotations` and `listFormFields` | leftover links, notes and widgets |
| 8 | Render each region at scale 2 with annotations and forms: at least 99 % of pixels equal the fill colour, and the overlay text is allowed. | PDFium render | widget painted over the fill (i), missing fill (adapter bug) |

The spike's `inspect()` already implements checks 1 and 3–7 in about 100 lines. It needs
per-hit messages (channel, page, object number) and the counting rules of check 4.

Limitation: content streams in non-standard encodings (CID fonts, Type3) cannot be byte-grepped.
They are covered by checks 3 and 4 plus the blank-region gate. The export summary must say so.

## 5. Risks and open questions

1. **Vector paths policy (decision needed).** The options are:
   - *covered*: remove only paths fully inside a region. This is safe for layout but leaves
     geometry under the box, for example a signature stroke that crosses the edge.
   - *touched*: MuPDF's `REMOVE_IF_TOUCHED`. It removes whole backgrounds and table rules.
   - *clip*: split paths at the region. PDFium has no API for this, so it would be a research task.

   Proposal: default to *touched* for paths whose bounds are smaller than about 2× the region, and
   *covered* otherwise. Show the before/after preview, and let the blank-region gate report
   anything left.
2. **The fork is opaque.** The EmbedPDF PDFium redaction C code is not in the npm package.
   Behaviour is known only from this spike, so keep the spike running in CI as a canary and pin
   the version (Renovate must not auto-merge `@embedpdf/*`).
3. **In-session orphans** are an engine-level leak that `saveAsCopy` does not fix. Any other code
   that saves after `GenerateContent` twice (text editing M4 §2, flatten) inherits it. The GC in
   step 4.7 and check 2 must run on every export that follows a destructive edit, not only on
   redaction.
4. **Glyph residue in fonts.** Removed glyphs stay in embedded font subsets and `/ToUnicode`. This
   reveals the character set, not the order, and was not tested. Re-subsetting is out of scope, so
   note it in the honesty text.
5. **Image growth.** JPEGs are re-encoded as Flate, and an all-white image is left in place (images.pdf grew
   from 54 KB to 72 KB for a single 160×120 JPEG). Route through the compress pipeline, or delete blank
   images.
6. **Not covered yet**, needing fixtures in the M4 corpus:
   - OCG-hidden content;
   - shadings (`sh`) and patterns;
   - Type3 fonts;
   - text used as a clip (Tr 7);
   - annotation appearance streams with text (FreeText, Stamp);
   - XFA datasets;
   - JavaScript containing the string;
   - `/Thumb`;
   - encrypted and object-stream sources through the whole pipeline;
   - a real-world scanned PDF with an OCR layer.
7. **Tagged PDFs.** The engine drops `/ActualText` and `/Alt` only where it removed marked
   content, and leaves dangling MCIDs. It is undecided whether to repair the structure tree or
   downgrade to untagged, with a note.
8. **Adapter fixes before M4 UI work:**
   - write /IC for `redact`;
   - do not call `applyAllRedactions` on the viewer's document;
   - move apply into the redaction worker.
