# @pdf-editor/engine

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
- 3fc05f7: Resize pages: change the page size of selected pages, a whole document or every page of a
  given size to A4, A3, A5, Letter, Legal, Tabloid or a custom size (pt, mm, in), scaling the
  content to fit, filling the page, or keeping it at 100% on a larger or smaller canvas around
  an anchor. Annotations, links, form fields and bookmarks follow the content; the page keeps
  its rotation. Undoable, shown immediately on the light table, and verified on export.
- b42c52f: Compare two documents: a third stage view pairs the pages of two open files (by index or
  by best match), shows them side by side or as an onion skin, outlines changed areas, marks
  changed words and offers a heat map; a Changes panel lists text, visual, page and
  document-fact changes with keyboard stepping and exports a comparison report PDF or a text
  list. Read-only; the pixel diff runs at 100 or 150 dpi in an analysis worker.
- b42c52f: Export as Markdown or text: the whole document, the current page or a range, with a choice
  of page breaks, running headers and footers kept or dropped, line-end hyphens joined, and
  images in a ZIP next to the Markdown. The dialog previews the first lines and says what the
  conversion cannot know (reading order is reconstructed, tables are not detected, pages
  without text need OCR first).
- b42c52f: Recognize text (OCR): scanned pages get an invisible, searchable text layer written over
  the untouched page image with Tesseract (nine language packs served from the app's own
  origin and downloaded on demand, nothing leaves the browser). Each page reports its quality
  as Good, Review, Poor or No text found, low-confidence words are listed for review, and the
  run is one undoable history entry whose replay never recognises again.
- b42c52f: Digital signatures: sources with signatures are checked on open in a signature worker and
  shown as Intact, Intact but changed later, Changed after signing, Broken or Cannot check,
  with the signer facts, the claimed time and the later changes by revision; the app never
  says "valid" and states that identity and trust are not verified. Sign… adds one PAdES-B
  approval signature with a local PKCS#12 file as the last export step; existing signatures
  are stripped on export because every export rewrites the file, and the dialog says so.
- 8712b62: M6 experience redesign: Home shows the open files as cards and combines them in one step
  ("Combine all 3 files", or drag one card onto another; the merge dialog always confirms);
  the navigator has four labelled tabs with counts (Pages with Bookmarks, Find, Review,
  Files), with comments, redaction marks and form fields in one Review list; the inspector
  is closed by default and document metadata, password and diagnostics moved to a Document
  info sheet; the tool bar shows six labelled task groups (Read, Mark up, Draw, Fill & sign,
  Pages, Redact), a tool's options sit with the armed tool, and the Document menu is labelled
  and sectioned with Merge, Split, Compare and Rotate. The pen never selects or interrupts:
  four presets as ink dots that persist, strokes written together become one annotation
  (one Review row, one undo), a lasso recolours, resizes, moves or deletes strokes, and the
  width follows pen pressure or speed, written into the ink's appearance with a constant
  `/BS /W` for other viewers. Ink is now "Pen", the two signing features are "Signature image"
  and "Sign with certificate…", and the palette finds commands by English and Turkish
  keywords without diacritics. Darker canvas, lighter panels and glass with one elevation
  shadow, a capsule tool bar with a solid accent for the armed tool; every ratio is checked by
  a test.

### Patch Changes

- Updated dependencies [27b0faa]
- Updated dependencies [d5e899c]
- Updated dependencies [4d62767]
- Updated dependencies [8ccc673]
- Updated dependencies [3fc05f7]
- Updated dependencies [b42c52f]
- Updated dependencies [b42c52f]
- Updated dependencies
  - @pdf-editor/document-model@1.0.0-beta.0
