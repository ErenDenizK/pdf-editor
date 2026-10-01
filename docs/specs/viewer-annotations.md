# Spec: Viewer and annotations (Read mode)

**Status:** draft (2026-09-27) · **Milestone:** M2 · **Owner:** project lead

Read mode is where a document is read, searched and marked up. Everything written here
must be a standard PDF annotation with an appearance stream, so that it renders the same
in Acrobat, Chrome, Preview and Firefox. Annotations are engine edits (PDFium) recorded in
the workspace history; export runs them through `PdfEditor.save()` before assembly
(ARCHITECTURE.md §4).

## 1. Viewer

- Continuous vertical scroll (exists), plus **single page** and **two-up** layouts; a
  **fit width / fit page / actual size / custom %** zoom model (exists) with pinch and
  Mod+Scroll zoom anchored under the cursor; tiling above 16 MP so 400% zoom stays crisp.
- **Thumbnail rail** (exists) with current page highlight and drag-to-scroll.
- **Text layer**: a DOM layer from glyph geometry per visible page, transparent, selectable
  with the native caret, copy with correct spaces and line breaks, screen-reader readable.
  Selection across pages allowed. Double-click selects a word, triple-click a line.
- **Search** (Mod+F): panel in the left rail with query, match case, whole word, result
  list grouped by page with context, up/down navigation (Enter / Shift+Enter, F3),
  highlights on the page, count in the status bar. Runs in the engine worker, incremental,
  cancellable on new input.
- **Outline** (exists), **page labels** in the status bar and go-to (Mod+G accepts labels
  such as "iv" and numbers), remembered last position per document fingerprint
  (localStorage, guarded).
- **Links**: internal GoTo links navigate; URI links show the destination in a tooltip
  and open only on click with a modifier-free confirmation popover (never silently).
- Keyboard: PageUp/PageDown, Home/End, arrows scroll, Space/Shift+Space page, `[`/`]`
  previous/next page, `+`/`-` zoom, `0` fit width, `1`/`2` Read/Arrange (exists).

## 2. Tools (floating bar, bottom center)

Select (V) · Highlight (H) · Underline (U) · Strikeout (S) · Ink (P) · Shapes (R: rectangle,
O: ellipse, L: line, A: arrow) · Text box (T) · Note (N) · Stamp/Image (Shift+I) · Signature (G).
Esc returns to Select. Tools are sticky until Esc; Shift while drawing constrains.

Shortcut changes in M4: E is Edit text (the eraser moved to Shift+E) and I is the Image tool
for the page's own images (move, resize, replace, extract; M4 §3), so the stamp / image
annotation tool moved from I to Shift+I.

A **contextual bar above the selection** replaces property dialogs: color swatches (a
fixed palette of 8 plus custom), opacity, stroke width, font size (text box), delete,
comment. Right panel "Properties" shows the same plus author, dates and the note text.

## 3. Annotation behaviors

| Kind | Creation | Geometry | Notes |
|---|---|---|---|
| Highlight / Underline / Strikeout / Squiggly | Select text then tool, or tool then drag over text | QuadPoints from text runs (upper-left, upper-right, lower-left, lower-right order) | Multiply blend in the AP; merges adjacent quads on one line |
| Ink | Freehand; width from pressure (pen) or speed (mouse, touch); `/InkList` centre lines with a constant `/BS /W` (the nominal width); the varying width lives only in our appearance stream, with the per-point widths in the private `/PdfEditorInkWidths` so a later session regenerates it after an edit (ADR-0018). Viewers that redraw ink from `/InkList` show the nominal width. Strokes written in a burst share one annotation. (M6 amendment A7) | InkList paths | Straight line with Shift; eraser mode removes whole strokes |
| Rectangle / Ellipse / Line / Arrow | Drag | Rect / vertices | Arrow = Line with `/LE [/None /OpenArrow]`; snap to 45° with Shift |
| Text box (FreeText) | Click or drag a box, type | Rect, `/DA` font size and color | Auto-grow height; font: bundled Inter subset embedded by the engine; no rich text in M2 |
| Note (Text) | Click | 20×20 icon rect | Popup with author, date, text; comment icon; open state persisted |
| Stamp / Image | Pick image or a named stamp | Rect, keep aspect | PNG/JPEG; "Draft", "Approved", "Confidential" as built-in stamps |
| Signature | Draw, type (bundled script-like font is out of scope: use a neutral font), or image | Stamp annotation | Clearly labeled "image signature, not a digital signature" in the panel |

Common: author from a local setting (default empty), `/M` modification date, `/NM` unique
name, `/F` Print set, `/CA` opacity with an ExtGState in the AP, `/P` back-pointer, `/Popup`
for notes and markup comments. Selection handles for move/resize where geometry allows
(not for text markup). Rotated pages: annotations are placed in unrotated user space and
displayed rotated.

## 4. Editing existing annotations

Annotations present in the source open as editable objects: select, move, resize, change
color/opacity, edit note text, delete. Locked annotations (`/F` Locked) show a lock badge
and are read-only. Widgets (form fields) are not annotations for this spec (M3).

## 5. History

Every create/update/delete is one history entry; drags and color slider changes coalesce
(800 ms window). Undo restores the exact annotation including its `/NM`. History labels:
"Highlight on page 3", "Move note", "Delete 2 annotations".

## 6. Flattening and export

Export dialog gains "Flatten annotations" (off by default) and "Include comments as
popups" (on). Verification adds an annotation count check per page against the model.

## 7. Cross-viewer conformance

`docs/qa/annotations-matrix.md` records for each kind whether it renders correctly (presence,
colour, translucency, stroke position, placement on rotated pages) and whether its text
reaches the comment UI, in two independent renderers run headlessly: our PDFium build
(Chrome-class viewers) and pdf.js (Firefox). The table and the contact sheets are written
by `pnpm --filter @pdf-editor/qa-tool matrix`, which fails on any `fail` cell and runs in
CI. M2 exits when that matrix is green. Acrobat Reader, Preview (macOS) and Edge get an
optional five-minute manual spot check against the contact sheets; they are not a gate
(owner decision 2026-09-27, `DISCUSSION.md` #13).

## 8. Performance and limits

- Text layer built lazily for visible pages ± 1; discarded beyond ± 3.
- Search over a 1,000-page document returns first results within 500 ms and streams the
  rest; the UI stays responsive.
- Ink strokes simplified (Douglas–Peucker, 0.3 pt tolerance) before writing.

## 9. Accessibility

Tools have names and shortcuts; the text layer is the accessible content of the page;
annotation objects are listed in a "Comments" panel as a navigable list with author, page
and text; live region announces creation and deletion; color is never the only cue (each
kind has an icon).

## 10. Out of scope for M2

Form filling (M3), redaction (M4), text editing (M4), rich text in FreeText, measurement
tools, collaboration or import/export of annotation sets (M6).
