# @pdf-editor/document-model

## 1.0.0-beta.0

### Major Changes

- First public beta: Recto 1.0.0-beta.0. A PDF editor that runs entirely in the browser:
  many PDFs on one light table, annotations, forms, redaction, text editing, OCR, compare,
  digital signatures, Markdown export and batch recipes, with every export re-opened and
  checked before download. Milestones M1 to M6 were internal (ADR-0017).

### Minor Changes

- 27b0faa: First usable milestone (M1): open PDFs into tabs, arrange pages on a multi-document light
  table with drag-and-drop, marquee and keyboard editing, split / merge / interleave / rename,
  insert blank and image pages, undo history, command palette, and export with outline, link,
  page-label and form-field reconciliation verified by re-parsing the output. English and
  Turkish interface, offline-capable PWA, strict CSP with no network use after load.
- d5e899c: M4 content editing: true redaction (marks, sensitive-data finder, apply with a blank-region
  gate and a forensic self-check on the exported bytes), in-place text editing with verified
  honesty states, form field creation, and crop with an option to remove the hidden content;
  the viewer's PDFium now runs in the app's own worker (ADR-0011).
- 4d62767: Image tool (I): select an image of the page to move it, resize it with handles (Shift keeps
  the aspect ratio, Alt resizes from the centre), nudge it with the arrow keys, replace it with
  a PNG, JPEG or WebP file, extract it (the original JPEG, or a PNG) or delete it; every change
  is one undo step and is verified by locating the page's images again. The stamp tool moves
  to Shift+I.
- 8ccc673: Edit the outline (bookmarks): add a bookmark at the current page and scroll position, rename
  in place (F2, double-click), delete, reorder, indent and outdent with Alt+Arrows, the context
  menu or drag and drop, point a bookmark at the current view and choose whether it opens
  expanded. Bookmarks follow their pages when pages move; those whose page was deleted are
  marked and can be removed in one step. Every edit is undoable and exported, verified.
- 3fc05f7: Resize pages: change the page size of selected pages, a whole document or every page of a
  given size to A4, A3, A5, Letter, Legal, Tabloid or a custom size (pt, mm, in), scaling the
  content to fit, filling the page, or keeping it at 100% on a larger or smaller canvas around
  an anchor. Annotations, links, form fields and bookmarks follow the content; the page keeps
  its rotation. Undoable, shown immediately on the light table, and verified on export.
- b42c52f: Batch: recipes of existing operations (rotate, delete pages, crop, resize, page numbers,
  headers and footers, Bates numbers, watermarks, metadata, flatten, compress, passwords,
  export as PDF, images, Markdown or text) saved in the browser and run over many files
  without opening them as tabs; every output goes through the normal export verification,
  failures are isolated per file, and recipes never store a password.
- b42c52f: Recognize text (OCR): scanned pages get an invisible, searchable text layer written over
  the untouched page image with Tesseract (nine language packs served from the app's own
  origin and downloaded on demand, nothing leaves the browser). Each page reports its quality
  as Good, Review, Poor or No text found, low-confidence words are listed for review, and the
  run is one undoable history entry whose replay never recognises again.
