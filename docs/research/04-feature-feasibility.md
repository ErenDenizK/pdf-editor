---
title: "Research: client-side feasibility of PDF editing features"
date: 2026-09-26
status: snapshot
---

> Research snapshot gathered on 2026-09-26. Library capabilities were verified against upstream source and documentation at that date and will drift. The feasibility matrix at the end feeds `docs/ROADMAP.md`; the correctness list feeds `docs/ARCHITECTURE.md`.

# Client-side PDF editing feasibility (TypeScript + WASM, no server) — verified 2026-09-26

## 0. Scope, method, and what was verified

Verified against current sources (npm registry, upstream source/headers on GitHub, GitHub issues). Several doc hosts were blocked by the egress proxy (readthedocs, pdfium.googlesource.com, pdf-lib.js.org, embedpdf.com, helpx.adobe.com, mupdf.com), so I used the GitHub mirrors of the same files (raw pdfium headers via `github.com/chromium/pdfium`, MuPDF `.rst` docs via `github.com/ArtifexSoftware/mupdf/docs`). Where I could not verify a claim, it is marked **[unverified]**.

**Library versions (npm registry, 2026-09-26):**

| Library | Version | License | Notes |
|---|---|---|---|
| `mupdf` (MuPDF.js) | 1.28.1 | AGPL-3.0-or-later (commercial available) | https://registry.npmjs.org/mupdf/latest ; 1.26 **removed linearization**, 1.28 deprecated `decrypt` in favour of `encrypt=none` (https://raw.githubusercontent.com/ArtifexSoftware/mupdf/master/CHANGES) |
| `pdf-lib` (Hopding) | 1.17.1 | MIT | effectively unmaintained; https://registry.npmjs.org/pdf-lib/latest |
| `@cantoo/pdf-lib` | 2.11.1 | MIT | maintained fork: AES-256 encryption, decryption, incremental updates, PDF/A conversion, `extractContents()`, flatten orphan widgets (https://raw.githubusercontent.com/cantoo-scribe/pdf-lib/master/README.md) |
| `pdfjs-dist` | 6.3.289 | Apache-2.0 | https://registry.npmjs.org/pdfjs-dist/latest |
| `@embedpdf/pdfium` | 2.15.1 | MIT | PDFium fork with `EPDF_*` extensions, unpacked ~7.55 MB; https://registry.npmjs.org/@embedpdf%2Fpdfium/latest |
| `@hyzyla/pdfium` | 2.1.13 | MIT | stock PDFium, render-oriented; https://github.com/hyzyla/pdfium |
| `@neslinesli93/qpdf-wasm` | 0.3.0 | ISC | qpdf CLI in WASM, ~1.38 MB unpacked; https://github.com/neslinesli93/qpdf-wasm (`@jspawn/qpdf-wasm` 0.0.2 is 4 years stale) |
| `tesseract.js` | 7.0.0 | Apache-2.0 | https://registry.npmjs.org/tesseract.js/latest |
| `@signpdf/signpdf` | 3.3.0 | MIT | https://github.com/vbuch/node-signpdf |

Spec: ISO 32000-2:2020 (+Amd 1, ISO/TS 32001/32002) is free at https://pdfa.org/sponsored-standards/ (https://pdfa.org/announcing-no-cost-access-to-iso-32000-2-pdf-2-0/).

---

## 1. Merge with arbitrary page interleaving

**(a) Correct behaviour (ISO 32000-2):** a page is a node in the `/Pages` tree (§7.7.3) with *inheritable* attributes (`/Resources`, `/MediaBox`, `/CropBox`, `/Rotate`) that must be materialised when the page leaves its tree. Everything that hangs off the page but is anchored at the catalog must be re-anchored: outlines (§12.3.3, `/Outlines` tree, destinations as page refs or named dests in `/Dests`/`/Names`), link annotations with `/Dest`/`/A GoTo` (§12.5.6.5, §12.6.4.2), AcroForm (§12.7: `/AcroForm /Fields` array is the field roots, widgets point up via `/Parent`, fully-qualified names must be unique in a document), `/PageLabels` number tree (§12.4.2), `/StructTreeRoot` + `/ParentTree` + per-page `/StructParents` (§14.7/14.8), optional content `/OCProperties` (§8.11), `/Info` and XMP `/Metadata` (§14.3).

**(b) What the three engines actually do:**

- **pdf-lib `copyPages`** (`PDFObjectCopier`, https://raw.githubusercontent.com/Hopding/pdf-lib/master/src/core/PDFObjectCopier.ts): resolves inherited attributes onto the page, deletes `/Parent`, then deep-copies *every* referenced object. Consequences, all confirmed in issues: outlines not copied (https://github.com/Hopding/pdf-lib/issues/218, https://github.com/Hopding/pdf-lib/issues/1017); links to named destinations break (https://github.com/Hopding/pdf-lib/issues/341); form fields disappear because `/AcroForm` is not touched — widgets come along but are orphans (https://github.com/Hopding/pdf-lib/issues/1205, https://github.com/Hopding/pdf-lib/issues/1587); duplicated pages share field names/values (https://github.com/Hopding/pdf-lib/issues/1240); shared `/Resources` dictionaries drag along every XObject in the source (split files as big as the original, https://github.com/Hopding/pdf-lib/issues/1662). Because widget `/P` and `/Parent` chains are followed, a copy can also pull unrelated pages into the destination.
- **MuPDF.js `graftPage(to, srcDoc, srcPage)` / `graftObject` / `newGraftMap()`** (https://raw.githubusercontent.com/ArtifexSoftware/mupdf/master/docs/reference/javascript/types/PDFDocument.rst): "Deep copy an object into the destination document." A graft map keeps object identity across many grafts, so shared resources are copied once. Still page-level only: no AcroForm merge, no outline merge, no page labels, no struct tree. But MuPDF gives you the primitives to do these correctly: `OutlineIterator.insert/delete/update` (https://raw.githubusercontent.com/ArtifexSoftware/mupdf/master/docs/reference/javascript/types/OutlineIterator.rst), `setPageLabels(index, style, prefix, start)`, `getTrailer()`/`PDFObject.get/put`, `Document.resolveLink`/`formatLinkURI`, `Page.createLink/deleteLink`.
- **PDFium `FPDF_ImportPages` / `FPDF_ImportPagesByIndex`** (https://raw.githubusercontent.com/chromium/pdfium/main/public/fpdf_ppo.h): `CPDF_PageExporter` copies all page keys except `/Type` and `/Parent`, resolving `MediaBox/CropBox/Rotate/Resources` inheritance (https://raw.githubusercontent.com/chromium/pdfium/main/core/fpdfapi/edit/cpdf_pageexporter.cpp). `UpdateReference` remaps object numbers but **skips the keys `Parent`, `Prev`, `First`** (https://raw.githubusercontent.com/chromium/pdfium/main/core/fpdfapi/edit/cpdf_pageorganizer.cpp) — so widget→field `/Parent` links and popup parents are cut, and AcroForm/outlines/struct tree are not handled. `FPDF_CopyViewerPreferences` exists; there is **no write API for bookmarks, page labels or metadata** (`fpdf_doc.h` is read-only: https://raw.githubusercontent.com/chromium/pdfium/main/public/fpdf_doc.h).

**Recommended implementation:** virtual document (see §13) → on export, one grafting engine (MuPDF graft map, or pdf-lib copier if you stay MIT) plus your own *document-level merger*:
1. Build a `srcPageRef → dstPageRef` map per source.
2. **Outlines:** walk each source outline; keep items whose target page survives, remap dests (explicit `[page /XYZ ...]` and named dests via `/Dests`/`/Names/Dests`); optional "wrap under a per-file parent" (pdfcpu's `--bookmark-mode wrap`, https://raw.githubusercontent.com/pdfcpu/pdfcpu/master/pkg/pdfcpu/merge.go).
3. **Links:** rewrite `/Dest` and `/A << /S /GoTo >>` on copied Link annots; drop intra-doc links whose target page was not copied (PyMuPDF does exactly this: https://raw.githubusercontent.com/pymupdf/PyMuPDF/main/docs/document.rst).
4. **Forms:** create/merge `/AcroForm`: merge `/DR` fonts (rename on clash), keep `/DA`, `/NeedAppearances`, `/CO`; wrap each source's `/Fields` under a per-document parent node (pdfcpu `mergeInFields`) *or* rename colliding fully-qualified names with a namespace prefix (pdfcpu `renameSourceOrphanWidgetFields` uses `namespace + "." + name`). Adobe/Acrobat behaviour: same-name fields become one field with a shared value (https://community.adobe.com/t5/acrobat-discussions/form-fields-with-same-name-are-merging-and-i-don-t-want-them-to-please-help-2019/td-p/10465911).
5. **Page labels:** rebuild `/PageLabels` number tree from per-page labels (qpdf preserves labels since 8.3: https://raw.githubusercontent.com/qpdf/qpdf/main/manual/cli.rst).
6. **Tagged PDF:** nobody does this well — qpdf drops/does not merge structure trees (open since 2020: https://github.com/qpdf/qpdf/issues/490), PyMuPDF the same (https://github.com/pymupdf/PyMuPDF/issues/2469). Minimum correct behaviour: if you cannot merge `/StructTreeRoot`, **remove it and `/MarkInfo`** rather than emit a document that claims to be tagged with dangling `/StructParents`/MCIDs.
7. **Metadata:** pick a policy (first doc's Info/XMP, or fresh), regenerate `/ID`.

**(c) Difficulty:** page copy Easy; outlines/links Medium; forms Medium-Hard; tagged PDF Research.

**(d) Pitfalls:** orphan widgets; `/NeedAppearances`; duplicated `/Resources` bloat; named dests; `/StructParents` pointing into a missing parent tree; OCGs referenced in content (`/OC`) but no `/OCProperties`; `/Rotate` inherited from an intermediate `/Pages` node and lost.

**(e) References:** pdfcpu merge (Go; forms + bookmarks), qpdf `--pages` (fast but explicitly "Outlines, threads, and other document-level features … are not preserved"), PyMuPDF `insert_pdf` doc for its explicit list of what is ignored, Stirling-PDF browser merge (pdf-lib; "skips TOC generation and signature handling", https://github.com/Stirling-Tools/Stirling-PDF/pull/4732).

---

## 2. Split / extract / delete / reorder / rotate / duplicate / blank / image pages / N-up / crop / resize

- **Split & extract:** same machinery as merge; by bookmark = use outline dests to compute page ranges; by size = greedy pack after estimating per-page object footprint (only exact after serialization → iterate). pdf-lib `copyPages`, MuPDF `graftPage`, PDFium `FPDF_ImportPagesByIndex`.
- **Delete/reorder/duplicate:** MuPDF `rearrangePages(pages)` — "Pages not listed will be removed, and pages may be duplicated." pdf-lib `removePage/insertPage/movePage`. Correctness: fix outlines/links/labels/struct tree afterwards (same as merge); duplicating a page that carries a widget duplicates a *field instance* (same name → shared value) unless you clone the field with a new name.
- **Rotate:** set `/Rotate` (multiple of 90, §7.7.3.3) — do **not** rewrite content. Viewers rotate content *and* annotations (annotation `/Rect`/`QuadPoints` are in unrotated user space). pdf-lib `page.setRotation()` only sets the flag, which is the correct thing (https://github.com/Hopding/pdf-lib/issues/360, https://github.com/Hopding/pdf-lib/issues/170); pitfalls: FreeText/widget appearance orientation (`/MK /R`), `NoRotate` annotation flag, and code that reads `MediaBox` width/height without applying `/Rotate` (thumbnails, N-up, watermark placement). PDFium `FPDFPage_SetRotation`.
- **Blank pages:** trivial (pdf-lib `addPage([w,h])`, MuPDF `addPage(mediabox, rotate, resources, contents)` + `insertPage`).
- **Images as pages:** JPEG → embed bytes as `/DCTDecode` untouched (pdf-lib `embedJpg`); PNG → decode/flatten alpha into `/SMask` (pdf-lib `embedPng`); WebP/HEIC/AVIF → decode via `createImageBitmap`/canvas or WASM (libheif-js / heic2any ≈2.7 MB, https://github.com/alexcorvi/heic2any) and re-encode. Honour EXIF orientation and CMYK JPEG (`/Decode [1 0 1 0 1 0 1 0]` for Adobe APP14 inverted CMYK).
- **N-up / booklet:** wrap each page as a Form XObject (pdf-lib `embedPage`/`embedPdf`; PDFium `FPDF_NewXObjectFromPage` + `FPDF_ImportNPagesToOne`, which uses `scale = min(xscale, yscale)` and **drops annotations**: https://raw.githubusercontent.com/chromium/pdfium/main/core/fpdfapi/edit/cpdf_npagetooneexporter.cpp). Booklet = N-up with the saddle-stitch order (n,1 | 2,n-1 | ...). Annotations/links must be transformed by the same matrix or flattened first.
- **Crop:** `/CropBox` (display) vs `/MediaBox` (physical); `/CropBox` must lie inside `/MediaBox` (viewers clip it). Cropping **does not remove content** — a cropped-out SSN is still in the stream (hence Acrobat's "Remove hidden information" removes "deleted or cropped content"). If the UI calls it "crop", offer "crop & discard" via redaction. pdf-lib `setCropBox`, MuPDF `setPageBox(box, rect)`, PDFium `FPDFPage_SetCropBox`.
- **Resize/scale (A4↔Letter):** either (i) new page + page-as-XObject with `cm` (loses annots unless transformed) or (ii) prepend `q <matrix> cm` to content, change boxes, and transform every annotation `/Rect`, `/QuadPoints`, `/InkList`, `/Vertices`, `/L`, plus `/BBox`-less appearance matrices. (ii) keeps interactivity; watch content streams that do not balance `q/Q`. Difficulty: Medium.

---

## 3. Annotations (create, render elsewhere, flatten)

**(a) Spec:** §12.5. Each annotation needs `/Subtype`, `/Rect`, `/F` flags, and for reliable cross-viewer rendering a `/AP << /N ... >>` appearance stream (§12.5.5, a Form XObject whose `/BBox`+`/Matrix` map onto `/Rect`). Text markup (§12.5.6.10 Highlight/Underline/Squiggly/StrikeOut) needs `/QuadPoints` (order x1 y1 x2 y2 x3 y3 x4 y4 = upper-left, upper-right, lower-left, lower-right per quad — many tools get this wrong and Acrobat tolerates it, others don't). Highlights conventionally use a `/Multiply` blend ExtGState in the AP. Ink needs `/InkList`; FreeText needs `/DA` and `/DS`/`/RC` optional; Stamps `/Name` or an AP with an image XObject; Popup with `/Parent`. `/CA` opacity, `/C`/`/IC` colours, `/T` author, `/M` modified, `/NM` unique name.

**(b) Libraries:**
- **pdf-lib:** *no* annotation API. You build the dicts (`PDFDict`, `context.register`, `page.node.addAnnot`) and write AP streams yourself. Fully possible, entirely your correctness burden.
- **MuPDF.js:** `PDFPage.createAnnotation(type)` for Text, FreeText, Line, Square, Circle, Polygon, PolyLine, Highlight, Underline, Squiggly, StrikeOut, Stamp, Ink, FileAttachment, Redaction; setters `setQuadPoints/addQuadPoint`, `setInkList/addInkListStroke`, `setVertices`, `setLine`, `setRect`, `setColor/setInteriorColor`, `setOpacity`, `setBorderWidth`, `setDefaultAppearance(font,size,color)`, `setStampImage`, `setIcon`, `setAppearanceFromDisplayList`; `annot.update()` **synthesises the appearance stream** (https://raw.githubusercontent.com/ArtifexSoftware/mupdf/master/docs/reference/javascript/types/PDFAnnotation.rst). This is the only client-side engine that writes standards-conformant APs for you. Flatten: `PDFDocument.bake(bakeAnnots, bakeWidgets)` — "Bakes the appearance of annotations and/or form fields onto the page, before removing the interactive objects."
- **PDFium:** `FPDFPage_CreateAnnot` for circle, fileattachment, freetext, highlight, ink, link, popup, square, squiggly, stamp, strikeout, text, underline; `FPDFAnnot_SetAttachmentPoints` (quads), `FPDFAnnot_AddInkStroke`, `FPDFAnnot_AppendObject` (path/image/text objects into the AP), `FPDFAnnot_SetAP`; `FPDFAnnot_SetColor` *fails on annotations that already have an AP* (https://raw.githubusercontent.com/chromium/pdfium/main/public/fpdf_annot.h). Flatten: `FPDFPage_Flatten(page, FLAT_NORMALDISPLAY|FLAT_PRINT)`; "all failures return FLATTEN_FAIL with no indication of the cause" (https://raw.githubusercontent.com/chromium/pdfium/main/public/fpdf_flatten.h). Stock PDFium generates APs only for a subset (`CPDF_AnnotList`/`CPDF_GenerateAP` for Square/Circle/Highlight/Ink/Popup/Square/Squiggly/StrikeOut/Text/Underline — **[unverified for current tree]**). EmbedPDF's fork adds richer generation.
- **pdf.js:** its editor creates FreeText, Ink, Stamp, Highlight and `saveDocument()` writes them as real annotation objects via an *incremental update* (`incrementalUpdate()` in https://raw.githubusercontent.com/mozilla/pdf.js/master/src/core/writer.js). Highlight quads come from the text layer selection (`HighlightOutline.build(boxes)`, `serializeQuadPoints`, https://raw.githubusercontent.com/mozilla/pdf.js/master/src/display/editor/highlight.js) — good reference for turning DOM selection into QuadPoints. The text layer is needed for markup: use `getTextContent()` items (transform, width, height) or MuPDF `StructuredText.highlight(p,q)` / `search()` which return quads directly (https://raw.githubusercontent.com/ArtifexSoftware/mupdf/master/docs/reference/javascript/types/StructuredText.rst).

**(c) Difficulty:** markup/ink/shapes with MuPDF: Easy-Medium; hand-rolled with pdf-lib: Medium (AP correctness); FreeText with rich text and custom fonts: Medium-Hard (font embedding + `/DA` resource in `/AcroForm /DR` or AP `/Resources`); flatten: Easy (MuPDF/PDFium), Medium (pdf-lib: draw AP XObject with `/Matrix`+`/BBox`→`/Rect` mapping, honour `Hidden`/`NoView`/`Print` flags).

**(d) Pitfalls:** missing AP → Acrobat renders, Chrome/Preview may not; QuadPoint order; `/Rect` not enclosing the AP after rotation; AP `/Matrix` vs `/BBox` algorithm (§12.5.5) mis-implemented → shifted flattening; Popup annotations not linked (`/Popup`, `/Parent`, `/Open`); annotation `/P` not pointing to the page; fonts in FreeText `/DA` referencing a `/DR` that doesn't exist; opacity requires ExtGState in the AP, `/CA` alone is not honoured by all viewers.

---

## 4. Forms (AcroForm) and XFA

**(a) Spec:** §12.7. Field dict (`/FT`, `/T`, `/V`, `/DV`, `/Ff`) + widget annotation (`/Subtype /Widget`, `/MK`, `/DA`, `/AP`). `/NeedAppearances true` tells the viewer to regenerate APs; ideally you generate them yourself and set it false. Fully-qualified names via `/Parent`.

**(b) Libraries:**
- **pdf-lib `PDFForm`:** read/fill text, checkbox, radio, dropdown, option list, button; `createTextField/createCheckBox/createRadioGroup/createDropdown/createOptionList/createButton`; `flatten({updateFieldAppearances})`; `updateFieldAppearances(font)` (Helvetica default; only WinAnsi glyphs, so non-Latin values render as boxes unless you embed a font via fontkit); `hasXFA()/deleteXFA()`; "pdf-lib does not support creation, modification, or reading of XFA fields" (https://raw.githubusercontent.com/Hopding/pdf-lib/master/src/api/form/PDFForm.ts). `getForm()` **silently deletes XFA** — warn users.
- **MuPDF.js `PDFWidget`:** `getFieldType()` (button/checkbox/combobox/listbox/radiobutton/signature/text), `getValue`, `setTextValue`, `setChoiceValue`, `toggle`, flags; appearances regenerated via `update()`; 1.27 "respect AcroForm/NeedAppearances flag". Field *creation*: only `PDFPage.createSignature(name)` is exposed; other field types must be built with `PDFObject` primitives **[creation API for text fields unverified]**. Flatten: `bake(false, true)`.
- **PDFium:** filling is UI-event based (`FORM_OnLButtonDown`, `FORM_ReplaceSelection`, `FORM_SetIndexSelected`) — there is no "set field value" in stock PDFium (https://raw.githubusercontent.com/chromium/pdfium/main/public/fpdf_formfill.h); EmbedPDF's fork adds `EPDF_*` setters **[exact names unverified — embedpdf.com blocked]**. Flatten via `FPDFPage_Flatten`.
- **qpdf:** `--generate-appearances` (ASCII/WinAnsi/MacRoman only, ignores quadding/rich text/multi-select) and `--flatten-annotations`; will *skip* flattening when APs are out of sync with values unless you regenerate first (https://raw.githubusercontent.com/qpdf/qpdf/main/manual/cli.rst).

**XFA — confirmed essentially unsupported everywhere client-side:** pdf.js has experimental XFA rendering (`enableXfa` default true in https://raw.githubusercontent.com/mozilla/pdf.js/master/web/app_options.js), but "XFA Foreground documents are not supported" (https://github.com/mozilla/pdf.js/issues/14249) and complex forms fail (https://github.com/mozilla/pdf.js/issues/13508). PDFium supports XFA only when built with `pdf_enable_xfa` (https://raw.githubusercontent.com/chromium/pdfium/main/pdfium.gni); Chrome and every WASM package build without it. pdf-lib deletes XFA; MuPDF ignores it. `@cantoo/pdf-lib` can *extract/modify the XFA XML packet* but not render. Recommended policy: detect `/AcroForm /XFA`; if the form is "XFA foreground" (has AcroForm widgets too) fill via AcroForm and strip `/XFA` with an explicit warning; if pure XFA ("dynamic"), refuse to edit.

**(c) Difficulty:** fill/flatten Easy-Medium; field creation Medium; JavaScript calculations (`/AA`, `/CO`) Hard (pdf.js has a sandboxed `enableScripting`; MuPDF has a JS engine in native builds — **[availability in the wasm build unverified]**).

---

## 5. Editing existing text (the "holy grail")

**Why it is hard:** page content is positioned glyph runs (`Tj/TJ` with kerning adjustments, `Tm`/`Td`), not paragraphs. Fonts are usually **subsets** (`ABCDEF+Name`) that contain only the glyphs used; simple fonts have at most 256 codes and often custom `/Differences` encodings; CID fonts map codes→GIDs via `CIDToGIDMap`/CMaps; `/Widths`/`/W` arrays exist only for present glyphs; `/ToUnicode` may be missing/wrong. There is no reflow information; line breaks, hyphenation, justification and columns must be *inferred*. Type3 fonts and text drawn as paths cannot be edited at all. Tagged PDF `/StructParents`/MCIDs must be kept in sync.

**What the engines offer:**
- **PDFium** (`fpdf_edit.h`, https://raw.githubusercontent.com/chromium/pdfium/main/public/fpdf_edit.h): `FPDFPageObj_NewTextObj`, `FPDFText_SetText` (UTF-16LE), `FPDFText_SetCharcodes`, `FPDFText_LoadFont` (embeds the **full** font, Type1/TrueType or CID with Identity-H + CIDToGIDMap), `FPDFText_LoadStandardFont`, `FPDFPage_RemoveObject`/`InsertObject`, `FPDFPageObj_Transform`, and mandatory `FPDFPage_GenerateContent` (otherwise "changes to page will be lost"). `FPDFText_SetText` simply maps each Unicode char through `CharCodeFromUnicode()` of the *existing* font with **no check that the glyph, width or encoding slot exists** (https://raw.githubusercontent.com/chromium/pdfium/main/fpdfsdk/fpdf_edittext.cpp). MegaPDF measured this on 1,533 files: ~890 with letter-spaced text (missing widths), ~340 dropped characters (no encoding slot), ~140 wrong glyphs (https://github.com/SlyWombat/MegaPDF/issues/116). Also `GenerateContent` re-serialises the whole content stream (loses comments/marked-content nuances **[unverified extent]**), and text shaping is 1 glyph per char (no ligatures/complex scripts).
- **MuPDF.js:** no text-edit API. It gives extraction (`StructuredText.walk` with `onChar(utf, origin, font, size, quad, argb, flags)`, `asJSON` — needs `preserve-spans`), low-level content access (`PDFObject.readStream/writeStream`, `PDFPage.process(PDFProcessor)` to walk operators), and font/graft primitives — so you could implement a content-stream rewriter yourself. Its own approach to changing text (redaction) *removes* glyphs and rewrites the stream.
- **pdf-lib:** none; you can parse/emit content streams (`PDFContentStream`, `PDFOperator`) and embed fonts with fontkit subsetting.

**Pragmatic tiers (what commercial products actually do):**
1. **White-out + overlay** (Sejda "whiteout", every online editor): draw a filled rect and new text on top. Cheap, but the old text remains searchable/extractable (a redaction failure in disguise) — if you do this, *remove* the underlying glyphs (tier 3) or clearly label it "cover".
2. **In-place re-encoding with verification:** try `FPDFText_SetText`-style edits only when every new character has a code, glyph and width in the existing font; read back and compare; fall back otherwise (MegaPDF's proposed fix).
3. **"Edit as text block" with re-typesetting:** detect the line/paragraph (structured text), delete those glyph runs from the content stream, and re-layout the paragraph with a **substitute font you embed** (match family/weight via name heuristics + metrics, e.g. Liberation/Noto). This is what Acrobat does when the original font is not installed/embedded-with-permissions: it either restricts you to size/colour changes or substitutes (Acrobat rules per Adobe help: font embedded but not installed → colour/size only; neither installed nor embedded → not editable; https://helpx.adobe.com/acrobat/using/edit-text-pdfs1.html, blocked for me but consistent with search excerpts). Sejda limits itself to web-safe/hosted fonts and warns that embedded fonts may lack characters (https://www.sejda.com/help); PDFgear uses system fonts, no font upload (https://www.pdfgear.com/pdf-editor-reader/edit-pdf-text-with-same-font-online.htm). All of them break: justified lines re-flow, ligatures split, small caps/fake bold lost, text inside Form XObjects untouched, tagged structure broken.

**Difficulty:** Research for "true" editing; Medium for tier 1; Hard for tier 3 done well. Recommendation: v1 tier 1 *with glyph removal*, v2 tier 3 limited to single lines/paragraphs in simple/TrueType fonts, always embedding the replacement font subset (fontkit) and rewriting `/Widths`.

---

## 6. Redaction and metadata scrubbing

**(a) Spec:** §12.5.6.23 Redact annotations (`/Subtype /Redact`, `/QuadPoints`, `/IC`, `/RO`, `/OverlayText`, `/Repeat`, `/DA`, `/Q`) are only *marks*; applying them must remove the underlying content. A correct implementation removes, within the region: text glyphs (splitting `TJ` runs), vector paths (or clips them), image pixels (re-encode) or whole images, inline images, shading; also content inside Form XObjects and annotation appearance streams, hidden/OCG content, and then the mark itself. Beyond the page: annotations overlapping the area (comments, links, popups), form field values, bookmarks/outline titles, `/Info`, XMP, embedded files/attachments, JavaScript, thumbnails (`/Thumb`), *and earlier revisions* (incremental-update history — a full rewrite is mandatory after redaction).

**(b) Libraries:**
- **MuPDF.js `PDFPage.applyRedactions(blackBoxes, imageMethod, lineArtMethod, textMethod)`** with `REDACT_IMAGE_NONE|REMOVE|PIXELS|UNLESS_INVISIBLE`, `REDACT_LINE_ART_NONE|REMOVE_IF_COVERED|REMOVE_IF_TOUCHED`, `REDACT_TEXT_NONE|REMOVE` (https://raw.githubusercontent.com/ArtifexSoftware/mupdf/master/docs/reference/javascript/types/PDFPage.rst) — the only production-grade true redaction in the browser. Note "Repaired documents or applying redactions prevents incremental saves" (`canBeSavedIncrementally`), which is exactly right. After applying, also delete overlapping annotations yourself, scrub metadata, and save with `garbage` so removed objects are physically gone.
- **PDFium (EmbedPDF fork):** `@embedpdf/plugin-redaction` uses fork-specific `EPDFText_RedactInQuads`; a bug left residual glyphs when one text object crossed two regions (matrix mutated mid-loop), fixed in PRs #813/#820 (https://github.com/embedpdf/embed-pdf-viewer/issues/801). Good warning: redaction code needs a *forensic test corpus* (extract text after redaction, render diff, grep raw bytes).
- **pdf-lib:** cannot redact. Drawing a black rectangle is not redaction (see failure taxonomy: https://redactpdf.io/blog/how-pdf-redaction-can-fail, and the browser checker https://github.com/dochush/pdf-redaction-checker which flags text under covers, render-mode-3 text, XMP/Info, attachments, JavaScript, bookmarks and earlier incremental versions).

**Metadata scrubbing checklist (PyMuPDF `Document.scrub` is a good spec: metadata, xml_metadata, javascript, attached_files, embedded_files, hidden_text, thumbnails, reset_fields, …, https://raw.githubusercontent.com/pymupdf/PyMuPDF/main/docs/document.rst):** `/Info` (replace, don't just blank — `/Producer` from the source app leaks), catalog `/Metadata` XMP (also per-image/per-font XMP streams), `/PieceInfo`, `/Names /EmbeddedFiles`, FileAttachment annots, `/Names /JavaScript` and `/AA`/`/OpenAction`, `/Thumb`, `/StructTreeRoot` `/ActualText`/`/Alt` (may contain redacted text!), outline titles, form `/V`/`/DV`, `/Dests` names, trailer `/ID` regeneration, then **full rewrite + garbage collect** (MuPDF `garbage=` levels; qpdf `--decrypt --object-streams=generate`). With pdf-lib you can do the dictionary-level scrub (MIT), but not content redaction.

**(c) Difficulty:** MuPDF Medium; anything else Research.

---

## 7. Compression / optimisation

What each tool can do in the browser:
- **MuPDF.js `saveToBuffer(opts)`** option string (mutool clean semantics): `garbage=1..4` (unused objects → compact xref → dedupe identical objects → check streams), `compress`, `compress-fonts`, `compress-images` (Flate on uncompressed streams — **not** JPEG re-encoding), `compress-effort=1..100`, `clean`/`sanitize` content streams, `objstms`, `encrypt=…`. Linearize was *removed* in 1.26 (CHANGES). Image downsampling is not built in — but `PDFObject.writeStream()` lets you replace an image XObject's data/dict after you re-encode it.
- **qpdf-wasm:** `--object-streams=generate`, `--recompress-flate --compression-level=9`, `--optimize-images` (converts *non-JPEG* images to DCT only when smaller and ≥128×128/16384 px; will not downsample), `--remove-unreferenced-resources=yes`, `--coalesce-contents`, `--linearize`, `--decrypt`. Structural only; typical gain 5–25%.
- **pdf-lib:** `useObjectStreams` (default true); no image recompression (https://github.com/Hopding/pdf-lib/issues/71). You can implement recompression yourself: enumerate `/XObject /Subtype /Image`, decode with the browser (`createImageBitmap` on a JPEG blob; Flate/raw via your own decoder for the common colourspaces), downsample on an `OffscreenCanvas`, re-encode with `canvas.convertToBlob({type:'image/jpeg', quality})` or MozJPEG WASM (`@jsquash/jpeg`, https://github.com/jamsinclair/jSquash), swap the stream, fix `/Width /Height /ColorSpace /BitsPerComponent /Filter`, drop `/DecodeParms`, handle `/SMask` and `/Mask` separately, never touch JBIG2/CCITT bilevel scans unless you re-encode to CCITT G4/JBIG2 (no browser encoder; leave them). Fonts: subsetting *existing* embedded fonts is Research (fontkit can subset a font you load, but you must map used glyphs from every content stream and rewrite `/Widths`/`/FirstChar`/CID maps); mostly skip.
- **Ghostscript WASM** does true image downsampling + re-encoding (`-dPDFSETTINGS=/ebook`), but AGPL, ~page-by-page slow in the browser, best under ~10 pages (https://github.com/laurentmmeyer/ghostscript-pdf-compress.wasm); real-world reductions 62–78% on scans (https://gist.github.com/ahmed-musallam/27de7d7c5ac68ecbd1ed65b6b48416f9).

**Honest size expectations:** text-only/vector PDFs: 0–20% (object streams, dedupe, flate level). Office-exported PDFs with embedded full fonts: 10–40% only if you subset (hard). Scanned/photo-heavy PDFs: 50–90% from downsampling to 150 dpi + JPEG q≈60–75 (the only lever that matters; images are ~80–90% of typical file size). Already-JPEG-compressed 150 dpi scans: <10%. Warn users when nothing can be gained; never re-encode JPEG→JPEG at higher quality than the source (generational loss for no gain).

**Linearization:** only qpdf can produce it client-side; its value for a client-side editor is low (pdf.js does not exploit hint tables well: https://github.com/mozilla/pdf.js/issues/14224). Ship as an option, not a default.

---

## 8. Encryption, passwords, permissions; digital signatures

**Spec:** §7.6 standard security handler — R2/R3 RC4 40/128, R4 crypt filters (AESV2/RC4), R5 (deprecated Adobe ext.), **R6 AES-256 (PDF 2.0, SHA-256/384/512 hash loop, UTF-8 SASLprep passwords)**; `/P` permission bits; `/EncryptMetadata`. Public-key (`/Filter /Adobe.PubSec`) is rare.

- **pdf.js:** decrypts RC4 40/128, AESV2, AESV3 (R6) for rendering; refuses public-key handlers ("unknown encryption method", https://raw.githubusercontent.com/mozilla/pdf.js/master/src/core/crypto.js); password via `getDocument({password})` / `onPassword(cb, PasswordResponses.NEED_PASSWORD|INCORRECT_PASSWORD)`. Its `saveDocument()` can write back an incremental update on an encrypted doc (writer handles encryption **[extent unverified]**).
- **pdf-lib 1.17:** throws `EncryptedPDFError`; `ignoreEncryption:true` **does not decrypt** — saving produces a corrupt file (https://github.com/Hopding/pdf-lib/issues/1601, https://github.com/Hopding/pdf-lib/issues/1326, https://github.com/Hopding/pdf-lib/issues/1390). Fork `@cantoo/pdf-lib` decrypts and encrypts (AES-256 default, AES-128, RC4); add-ons `pdf-encrypt-lib` (R6 for pdf-lib, https://github.com/alestre/pdf-encrypt-lib), `@pdfsmaller/pdf-encrypt`.
- **MuPDF.js:** `needsPassword()`, `authenticatePassword(pw)` → bitfield (1 none needed, 2 user, 4 owner), `hasPermission("print"|"edit"|"copy"|"annotate"|"form"|"accessibility"|"assemble"|"print-hq")`; write `encrypt=none|keep|rc4-40|rc4-128|aes-128|aes-256`, `user-password=`, `owner-password=`, `permissions=` (per mutool clean docs; 1.28 deprecates `decrypt`).
- **qpdf-wasm:** `--decrypt`, `--encrypt --user-password= --owner-password= --bits=40|128|256 [--print=… --modify=… --extract=… --annotate=… --form=… --assemble=… --cleartext-metadata] --`; 40-bit requires `--allow-weak-crypto`. qpdf "does not obey encryption restrictions already imposed on the file" — you need the *owner* password policy in your UI (removing an owner password without knowing it is legally/ethically your product decision; technically trivial with any of these).
- **PDFium:** opens RC4/AES-128/AES-256 with password; `FPDF_SaveAsCopy(..., FPDF_REMOVE_SECURITY)` strips encryption; **no encryption writer in the public API** (https://github.com/SlyWombat/MegaPDF/issues/131; https://raw.githubusercontent.com/chromium/pdfium/main/public/fpdf_save.h).

**Digital signatures (§12.8, PAdES = ETSI EN 319 142):**
- *Viewing/validating:* pdf.js shows signature widgets but does not validate; PDFium exposes raw data only (`FPDF_GetSignatureCount`, `FPDFSignatureObj_GetContents/GetByteRange/GetSubFilter/GetDocMDPPermission`, no verification: https://raw.githubusercontent.com/chromium/pdfium/main/public/fpdf_signature.h). MuPDF's `PDFWidget.isSigned/validateSignature/checkCertificate/checkDigest/getSignatory/sign` are documented **"mutool only"** (https://raw.githubusercontent.com/ArtifexSoftware/mupdf/master/docs/reference/javascript/types/PDFWidget.rst) — i.e. not in the wasm build. So validation must be done in JS: parse `/ByteRange` + `/Contents` (CMS via **pkijs**), hash the byte ranges with WebCrypto, verify `SignedData` → `messageDigest`/`signingCertificateV2`, check `/ByteRange` covers the whole file except `/Contents` and that later incremental updates are only allowed changes (DocMDP/`/P`). Chain/trust: you need a trust store (AATL/EUTL) shipped with the app; revocation (OCSP/CRL) needs network (CORS!). Libraries: pkijs (https://github.com/PeculiarVentures/PKI.js), https://github.com/ninja-labs-tech/verify-pdf.
- *Signing:* `@signpdf/signpdf` + `@signpdf/placeholder-pdf-lib` + `@signpdf/signer-p12` (node-forge; runs in browser with a Buffer polyfill): adds a `/Sig` field with zero-filled `/Contents`, computes detached PKCS#7 over `/ByteRange`; PAdES-B via `SubFilter /ETSI.CAdES.detached`. Stated limitations: no timestamps, no LTV, no encrypted PDFs, no incremental updates (https://raw.githubusercontent.com/vbuch/node-signpdf/develop/README.md) — the last means signing a *second* time invalidates the first unless you write the signature as an incremental update yourself (pdf.js's writer or `@cantoo/pdf-lib` incremental save help). Timestamps (RFC 3161, `/DocTimeStamp /ETSI.RFC3161`): https://github.com/mingulov/pdf-rfc3161 works in browsers with WebCrypto, but almost no TSA sends CORS headers, so a proxy is needed (BentoPDF had exactly this bug: https://github.com/alam00000/bentopdf/pull/869; rfc3161.ai.moda reportedly sends CORS). LTV (DSS dictionary with certs/OCSP/CRLs) is feasible technically but OCSP/CRL fetching is again blocked by CORS → client-side LTV is effectively "bring your own proxy". P12 parsing in-browser: pkijs/forge PKCS#12 (PBES2/AES fine; legacy RC2-40 P12s need forge). Certificates are private key material — never leave the tab, use WebCrypto non-extractable keys where possible.

**Difficulty:** open/decrypt Easy; set password/permissions Easy (MuPDF/qpdf/Cantoo); sign PAdES-B Medium; validate Medium-Hard; timestamps/LTV Hard (network).

---

## 9. OCR → searchable PDF

- **tesseract.js 7.0.0** (https://github.com/naptha/tesseract.js): outputs `text, blocks, layoutBlocks, hocr, tsv, box, unlv, osd, pdf, imageColor/Grey/Binary` — all but `text` off by default since v6 (`worker.recognize(img, {}, {hocr:true, tsv:true})`). README: "Tesseract.js does not support PDF files" as *input* — you rasterise pages with pdf.js/MuPDF at 300 dpi first. The built-in `pdf` output exists but you will want your own layer to keep the original image bytes, so use `hocr`/`blocks` (per-word bbox, baseline, confidence).
- **Language data:** default LSTM "best_int" from tessdata.projectnaptha.com; English ≈2 MB gz (https://github.com/naptha/tesseract.js/blob/master/docs/performance.md); `tessdata_fast` eng ≈3.9 MB raw (https://github.com/tesseract-ocr/tessdata_fast); `tessdata_best` ≈15 MB; CJK legacy up to ~20 MB. Cache in IndexedDB (`cacheMethod`), let users pick languages, load SIMD core (`corePath` must point at the directory with all four core variants).
- **Performance:** reuse one worker (or a `Scheduler` with 2–4 workers); roughly 1–5 s per 300-dpi A4 page on a laptop with the SIMD core **[order of magnitude, unverified]**; binarise/deskew before OCR improves accuracy.
- **Text layer construction (reference: Tesseract's own `pdfrenderer.cpp`, https://raw.githubusercontent.com/tesseract-ocr/tesseract/main/src/api/pdfrenderer.cpp):** a Type0/CIDFontType2 "GlyphLessFont" whose `CIDToGIDMap` maps every CID to GID 0 of a one-glyph TrueType (`pdf.ttf`), a `ToUnicode` CMap so copy/paste yields the words, text render mode **`3 Tr`** (invisible), one `Tm` per word placed on the line baseline, and **`Tz` horizontal scaling** so the word advance equals its bbox width. Then draw the original image XObject (`/Im1 Do`) *under* the text. OCRmyPDF's hOCR→PDF renderer follows the same idea (https://github.com/ocrmypdf/OCRmyPDF, `hocrtransform`). Pitfalls: some extractors dislike glyphless fonts (https://github.com/tesseract-ocr/tesseract/issues/2034) — alternative is an embedded real font (e.g. subset of a Latin sans) with `3 Tr`; keep the original image stream (don't re-encode); handle page `/Rotate`; write `/Lang`; OCR text is not tagged structure (don't claim PDF/UA). Difficulty: Medium.

---

## 10. Conversions

- **Images → PDF:** Easy (see §2). WebP/AVIF decode natively via `createImageBitmap`; HEIC needs libheif WASM.
- **PDF → images:** pdf.js `page.render({canvasContext, viewport: page.getViewport({scale: dpi/72})})` or MuPDF `toPixmap(Matrix.scale(dpi/72), ColorSpace.DeviceRGB, alpha, showExtras, "View", "CropBox")` then `asPNG()/asJPEG()`. Watch canvas max size (~16k px per side, 268 MP total in Chrome) — tile above ~600 dpi. Easy.
- **PDF → text/Markdown:** pdf.js `getTextContent()` (items with transform/width, no paragraph structure) or MuPDF `StructuredText` (1.26 added paragraph breaking, table detection; `asJSON` with `preserve-spans` keeps font changes → infer headings from size/weight; `asHTML`). Markdown = heuristics (font-size clustering → headings, indentation → lists, table detection). Medium, quality capped.
- **HTML/DOCX → PDF:** no client-side layout engine except the browser's. Options: (i) `window.print()`/`printToPDF` — vector output, but the user drives a dialog, no programmatic bytes, `@page size` support varies, and pdf.js-canvas printing is rasterised (https://www.nutrient.io/blog/how-to-print-pdfs-using-pdfjs/); (ii) **paged.js** paginates HTML in the DOM with CSS Paged Media polyfill (running headers/footers, counters) but the final PDF still comes from the print dialog (https://pagedjs.org/en/documentation/3-w3c-specifications-for-printing/); (iii) html2canvas/html2pdf.js → raster, poor; (iv) your own HTML→PDF typesetter (pdfkit + own layout) for a *restricted* subset. DOCX: mammoth → HTML → (i)/(ii), fidelity is low; docx-wasm is commercial; LibreOffice WASM (used by BentoPDF) is ~hundreds of MB and AGPL/MPL — impractical for most. Verdict: "print to PDF" UX only; Hard to impossible for fidelity.
- **PDF/A:** requirements (ISO 19005): all fonts embedded (+ ToUnicode for A-2u/3u), `/OutputIntent` with embedded ICC profile, XMP with `pdfaid:part/conformance` and Info↔XMP consistency, no encryption, no JavaScript/launch actions, no transparency (A-1), no LZW/JPX (A-1), embedded files only as PDF/A (A-2) or any with `/AFRelationship` (A-3), no `/Rotate` issues, tagged PDF for level A. Converting arbitrary input requires font embedding/substitution of non-embedded fonts and colour management — Ghostscript (`-dPDFA=2 -sColorConversionStrategy=RGB`, AGPL, used by BentoPDF via CDN) is the only client-side engine that does it; `@cantoo/pdf-lib` advertises PDF/A conversion (adds XMP/OutputIntent — **[depth unverified]**). There is no veraPDF in WASM; you cannot honestly claim conformance without validation. Recommendation: offer "PDF/A-2b for files that already embed all fonts" with a self-check list, otherwise refuse. Hard/Research.

### 10b. Page numbers, headers/footers, watermarks, Bates

All Easy–Medium with pdf-lib alone: `drawText/drawImage/drawRectangle` support `opacity`, `blendMode` (Multiply etc.), `rotate` (https://raw.githubusercontent.com/Hopding/pdf-lib/master/src/api/PDFPageOptions.ts). Correctness points: (1) respect `/Rotate` and `/CropBox` when computing "top-left"; (2) **behind** content = prepend a content stream to `/Contents` (make it an array) wrapped in `q…Q`, not append; (3) wrap your overlay in `q … Q` and reset the graphics state (`/GS` for alpha) because the page's stream may end in an unbalanced state; (4) put watermark in a Form XObject reused by every page (size); (5) fonts: embed a Unicode font via fontkit subset (Stirling's browser page-number tool is limited to standard 14 fonts: https://github.com/Stirling-Tools/Stirling-PDF/pull/4732); (6) optionally mark the watermark as an `/Artifact` for tagged PDFs; (7) Bates = zero-padded counter + prefix/suffix, applied consistently across a *set* of documents — store the last number. Tiling = loop of `Do` with translation. Consider a removable variant as a `/Watermark` annotation (§12.5.6.22) with `/FixedPrint`.

---

## 11. Compare / diff

- **Visual:** render both at the same DPI (pdf.js/MuPDF), align by page (and optionally by page size), diff with **pixelmatch** (https://github.com/mapbox/pixelmatch) or Resemble.js with anti-aliasing tolerance; output overlay + change rectangles (connected components). Off-thread in a Worker with `OffscreenCanvas`. Easy–Medium.
- **Text:** extract per page (MuPDF structured text with reading order beats pdf.js item order), normalise whitespace/hyphenation, word-level diff with `diff` (jsdiff) or diff-match-patch; map words back to quads to paint differences on the page. Medium. Reference UX: Apryse/PDF.js Express compare (https://docs.apryse.com/web/guides/compare/pixels).

---

## 12. Repair

- **pdf.js** rebuilds the xref by scanning the whole file for `N G obj` and `trailer` when parsing throws `XRefParseException` (`indexObjects()`, https://raw.githubusercontent.com/mozilla/pdf.js/master/src/core/xref.js) — read-only recovery.
- **MuPDF** repairs on open; `wasRepaired()` tells you; 1.27/1.28 add `pdf_check_document`/`fz_check_document` to "scan and fix structural errors before editing" and `mutool audit` (CHANGES). Save with `garbage` to emit a clean file; incremental save is disabled for repaired docs (correct — the broken xref cannot be `/Prev`-chained).
- **qpdf** recovers damaged xref/stream lengths with heuristics (`--suppress-recovery` to disable) and rewrites.
- pdf-lib is *less* tolerant than viewers (https://github.com/Hopding/pdf-lib/issues/902) and had a parser bug where "stream" inside font data broke output for Acrobat (https://github.com/Hopding/pdf-lib/issues/1215) — don't use it as the repair engine. Strategy: open with MuPDF → if `wasRepaired()`, offer "Save repaired copy"; fall back to qpdf; last resort re-distill by rendering pages (lossy). Easy with MuPDF.

---

## 13. Undo/redo and the virtual document model

**Model:** keep an immutable `VirtualDocument = { pages: VirtualPage[], outline, labels, metadata, formPolicy }` where `VirtualPage = { sourceId, sourcePageIndex, rotationDelta, cropBox?, overlays: Op[], annotationsDelta, deletedAnnotIds }`. Sources are opened once (pdf.js for rendering/text, MuPDF/pdf-lib for export) and never mutated. Structural ops (reorder, delete, rotate, merge, split, N-up as a *derived page*) are O(1) array edits; only **export** materialises: graft pages from sources in order (graft map per source), apply `/Rotate` deltas, prepend/append overlay content, write annotations, rebuild outlines/labels/AcroForm as in §1. Rendering a virtual page = render source page + rotation + overlay canvas; thumbnails cached by `(sourceId, index, rotation)`.

**Undo/redo:** with immutable snapshots + structural sharing (Immer / persistent arrays) undo is a pointer move and memory is proportional to the change, which fits since pages are references, not bytes. Use the command pattern only for things that are not representable as pure state — e.g. destructive engine operations (MuPDF redaction, text edits done inside a MuPDF document). MuPDF itself has a journal: `enableJournal()`, `beginOperation(name)`/`endOperation()`, `canUndo/undo/redo`, `countUnsavedVersions()` (https://raw.githubusercontent.com/ArtifexSoftware/mupdf/master/docs/reference/javascript/types/PDFDocument.rst) — usable when you edit a live MuPDF document, but journalled documents and redaction interplay is subtle; simpler to treat destructive edits as "commit points" that snapshot the exported bytes. pdf.js's editor uses a command buffer (`CommandManager`: `{cmd, undo, post, type}`, `overwriteIfSameType`, `maxSize` 128, https://raw.githubusercontent.com/mozilla/pdf.js/master/src/display/editor/tools.js) — a good model for coalescing drag/colour changes. Persist the virtual doc + source blobs to IndexedDB/OPFS for crash recovery; export in a Worker.

**Incremental save vs rewrite:** if the user only annotated/filled a single source and it is signed or you want to preserve revision history, export as an *incremental update* (pdf.js `saveDocument` does this; `@cantoo/pdf-lib` supports it; MuPDF `incremental` when `canBeSavedIncrementally()`); after redaction/merge/repair, always full rewrite with garbage collection and a fresh `/ID`.

---

## Feasibility matrix

| # | Feature | Difficulty | Best engine (MIT path / AGPL path) | v1 | v2 | v3 |
|---|---|---|---|---|---|---|
| 1 | Merge/interleave pages | Easy | pdf-lib copier / MuPDF graft map | ✔ | | |
| 1 | …preserve outlines, links, labels | Medium | own merger over either | | ✔ | |
| 1 | …preserve forms (rename/wrap) | Medium-Hard | own merger; pdfcpu as model | | ✔ | |
| 1 | …tagged PDF structure merge | Research | none (strip StructTree instead) | | | ✔ |
| 2 | Split/extract/delete/reorder/duplicate/blank | Easy | pdf-lib / MuPDF | ✔ | | |
| 2 | Rotate (/Rotate) | Easy | any | ✔ | | |
| 2 | Images→pages, N-up/booklet | Easy-Medium | pdf-lib embedPage / PDFium ImportNPagesToOne | ✔ | | |
| 2 | Crop, resize with annotation transform | Medium | pdf-lib + own transforms | ✔ (crop) | ✔ (resize) | |
| 3 | Markup/ink/shapes/stamps with AP | Medium (pdf-lib hand-rolled) / Easy (MuPDF) | MuPDF `createAnnotation`+`update()` | ✔ | | |
| 3 | FreeText w/ custom fonts, flatten | Medium | MuPDF `bake` / pdf-lib flatten | | ✔ | |
| 4 | AcroForm fill + flatten | Easy-Medium | pdf-lib PDFForm / MuPDF PDFWidget | ✔ | | |
| 4 | Create fields | Medium | pdf-lib | | ✔ | |
| 4 | XFA | Not feasible | (detect, warn, strip) | ✔ (detect) | | |
| 5 | Text edit tier 1 (cover + remove glyphs) | Medium | MuPDF redaction + overlay | | ✔ | |
| 5 | Text edit tier 3 (re-typeset paragraph) | Hard/Research | own content-stream rewriter (PDFium fork or MuPDF primitives) | | | ✔ |
| 6 | True redaction | Medium | **MuPDF `applyRedactions`** (no MIT equivalent) | ✔ | | |
| 6 | Metadata/attachment/JS scrub | Easy-Medium | pdf-lib or MuPDF dict ops | ✔ | | |
| 7 | Structural optimisation (objstms, dedupe, unused res.) | Easy | MuPDF garbage / qpdf-wasm | ✔ | | |
| 7 | Image downsample + JPEG re-encode | Medium | own pipeline (canvas/MozJPEG) + stream swap | | ✔ | |
| 7 | Font subsetting of existing fonts, linearize | Hard / Easy(qpdf) | — / qpdf | | | ✔ |
| 8 | Open encrypted, remove password | Easy | MuPDF / qpdf / Cantoo (not pdf-lib, not PDFium for writing) | ✔ | | |
| 8 | Set passwords/permissions (AES-256) | Easy | MuPDF / qpdf / Cantoo | ✔ | | |
| 8 | Validate signatures (crypto + ByteRange) | Medium-Hard | pkijs + WebCrypto (own code) | | ✔ | |
| 8 | Sign PAdES-B with P12 | Medium | @signpdf + pkijs/forge (incremental update!) | | ✔ | |
| 8 | Timestamp / LTV | Hard (CORS) | pdf-rfc3161 + proxy | | | ✔ |
| 9 | OCR → searchable PDF | Medium | tesseract.js + own glyphless text layer | | ✔ | |
| 10 | Images↔PDF, PDF→images | Easy | pdf-lib / pdf.js / MuPDF | ✔ | | |
| 10 | PDF→text/Markdown | Medium | MuPDF StructuredText | | ✔ | |
| 10 | HTML/DOCX→PDF | Hard (fidelity) | paged.js + print dialog only | | | ✔ (print flow) |
| 10 | PDF/A | Hard/Research | Ghostscript-wasm (AGPL) or refuse | | | ✔ |
| 10b | Numbers/headers/footers/watermark/Bates | Easy-Medium | pdf-lib | ✔ | | |
| 11 | Visual + text compare | Easy-Medium | pdf.js/MuPDF + pixelmatch + jsdiff | | ✔ | |
| 12 | Repair | Easy | MuPDF (wasRepaired, check_document), qpdf | ✔ | | |
| 13 | Virtual doc + undo/redo | Medium (architecture) | own (Immer snapshots + commands) | ✔ | | |

Engine choice summary: **pdf.js** for viewing/text layer/incremental annotation save (Apache-2.0); **MuPDF.js** is the only engine that covers redaction, appearance-stream generation, bake/flatten, encryption writing, outline editing, page labels and repair in one WASM — but AGPL (or commercial licence) and ~10 MB+ wasm; **pdf-lib/@cantoo** for MIT-only structural work (prefer the Cantoo fork: encryption, incremental save, active maintenance); **qpdf-wasm** for linearize/encryption/structural clean-up (Apache-2.0); **PDFium** (stock) is a renderer with weak write APIs — only the EmbedPDF fork adds real editing, and text edit via `FPDFText_SetText` needs verification gates.

---

## Things competitors get wrong that we must get right

1. **"Redaction" that is a black rectangle**, or that removes page text but leaves it in annotations, form values, bookmarks, XMP/Info, attachments, `/ActualText`, thumbnails, or *earlier incremental revisions*. Always full-rewrite + garbage collect after redaction; run a self-check (re-extract text under boxes, grep raw bytes). (redactpdf.io, dochush, EmbedPDF #801.)
2. **Whiteout/"edit text" that leaves the original glyphs** searchable and copyable. Remove the glyph runs.
3. **Merging with pdf-lib `copyPages` alone:** loses bookmarks, breaks named-destination links, orphans/duplicates form fields with shared values, copies every XObject of shared `/Resources` (split output as large as the input). Rebuild `/AcroForm`, outlines, `/PageLabels`; prune unused resources.
4. **Field name collisions** silently unified (Acrobat semantics) — wrap under per-document parents or rename with a namespace; keep `/DR` fonts merged; regenerate appearances; do not leave `/NeedAppearances` inconsistent with your APs.
5. **Tagged PDF left half-broken**: a `/StructTreeRoot` pointing at MCIDs/`StructParents` that no longer exist is worse than untagged. Merge properly or strip `/StructTreeRoot`+`/MarkInfo` and say so.
6. **Rotation by rewriting content** instead of `/Rotate` (or ignoring `/Rotate`/`/CropBox` when placing watermarks, page numbers, annotations, N-up). Annotation coordinates live in unrotated user space.
7. **Cropping presented as removal.** `/CropBox` hides; it does not delete.
8. **Writing annotations without `/AP`** (or with wrong `/BBox`/`/Matrix`, wrong QuadPoint order, no `/P`, no `/NM`, opacity without ExtGState) → "renders in Acrobat, invisible in Chrome/Preview".
9. **Opening encrypted files with `ignoreEncryption`** and saving encrypted bytes as plaintext → corrupt output. Decrypt properly (MuPDF/qpdf/Cantoo) or refuse.
10. **Full rewrite of signed documents** (invalidates signatures) — use incremental updates for annotate/fill/sign on signed or "keep history" files; and conversely **never** incremental-save after redaction (history leaks).
11. **Unverified in-place text edits** (`FPDFText_SetText` on subset/simple fonts) causing letter-spacing, dropped or wrong glyphs — verify glyph/width/encoding coverage and fall back to an embedded substitute font, flag "font substituted" to the user.
12. **XFA silently deleted** (pdf-lib `getForm()`) or "supported" but rendered wrong — detect and warn.
13. **Compression that lies**: recompressing JPEGs at higher quality, re-encoding bilevel scans to JPEG, dropping `/SMask`, or reporting "compressed" with 0% gain. Downsample+re-encode only when smaller; keep CCITT/JBIG2; report actual delta.
14. **Metadata half-scrubbed**: `/Info` blanked but XMP kept (or vice versa), `/ID` unchanged, `/Producer` leaking the source app.
15. **Page labels dropped** on every structural operation (roman-numbered front matter turns into "1, 2, 3").
16. **OCR layers that break copy/paste** (no ToUnicode, wrong `Tz`, text not on baseline, mode-3 text over a re-encoded lossy image) — follow Tesseract's pdfrenderer design and keep the original image stream.
17. **Signature UX that "signs" without a proper incremental update, ByteRange or SubFilter**, timestamps failing on HTTPS deployments because TSAs lack CORS, or claiming LTV without embedding revocation data.
18. **Object-stream / xref-stream output that older readers reject** — expose a "compatibility (no object streams, PDF 1.4)" export and validate output by re-parsing it with a second engine (pdf.js) before offering the download.
19. **Repairing silently**: if the engine repaired the file on open, tell the user and offer to save the repaired copy rather than saving incrementally onto a broken xref.
20. **Claiming PDF/A** without validation. Don't.

Reference implementations worth reading: pdfcpu `merge.go` (forms/bookmarks), qpdf `cli.rst` (what "fast merge" loses), PyMuPDF `insert_pdf`/`scrub` docs, Tesseract `pdfrenderer.cpp`, pdf.js `writer.js`/`xref.js`/`editor/tools.js`, MuPDF JS reference (`PDFDocument.rst`, `PDFPage.rst`, `PDFAnnotation.rst`), MegaPDF issues #97/#116/#131 (PDFium editing pitfalls), BentoPDF (AGPL client-side toolkit mixing pdf-lib/pdf.js/qpdf-wasm/Tesseract/Ghostscript: https://github.com/alam00000/bentopdf), Stirling-PDF browser tools PR #4732.