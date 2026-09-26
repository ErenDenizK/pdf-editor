# ADR-0002: PDF engine stack

**Status:** proposed · **Date:** 2026-09-26 · **Depends on:** ADR-0001

## Context

See `docs/research/01-engine-landscape.md` and `04-feature-feasibility.md`. Under a
permissive license the candidates are pdf.js (render, Apache-2.0), PDFium WASM via the
EmbedPDF v2 packages (render + edit, MIT), `@cantoo/pdf-lib` (structure, MIT; the
original pdf-lib has been unmaintained since 2021), qpdf WASM (structure/crypto/repair,
Apache-2.0) and tesseract.js (OCR, Apache-2.0). None requires WASM threads.

Key facts: PDFium is Chrome's engine and, through the EmbedPDF fork, exposes annotation
CRUD with appearance generation, form value setters, true redaction in quads, flatten,
encryption set/remove, page import, save. It has no write API for bookmarks, page labels or
metadata; pdf-lib does. pdf.js is lighter (0.5 MB vs 2.15 MB gzip) and has a mature DOM
text layer, but its only write path is an incremental update of its own editor
annotations and form values.

## Decision

1. **PDFium (`@embedpdf/pdfium` + `@embedpdf/engines`, v2 line, pinned)** is the single
   renderer and the content/annotation/form/redaction editor, one instance per open
   document in a dedicated Web Worker.
2. **`@cantoo/pdf-lib`** is the assembler: page copying between documents, rotation,
   overlays, outline / page label / AcroForm / metadata reconciliation, encryption.
3. **qpdf WASM** (built from qpdf 12.x source in our CI, not an npm wrapper) is the
   plumber: repair, object streams, linearization, second crypto path.
4. **tesseract.js** for OCR (M5), producing an invisible text layer over the original image.
5. **pdf.js is not bundled** in v1. It stays the documented fallback renderer and a
   reference implementation.
6. All engines are wrapped by project-owned interfaces (`PdfRenderer`, `PdfEditor`,
   `PdfAssembler`, `PdfPlumber`). UI code never imports an engine package directly.
7. No engine or asset is loaded from a CDN.

## Consequences

- One rendering engine means what the user sees is what the engine wrote (no pdf.js vs
  PDFium pixel disagreements), at the price of a 2.15 MB gzip download on first document
  open (service-worker cached afterwards).
- We must build our own DOM text layer from PDFium glyph geometry for selection,
  search highlighting and accessibility (pdf.js has this built in).
- EmbedPDF v3 (Apache-2.0, own PDFium fork) is pre-production; migrating later is
  contained by the interface layer.
- Document-level reconciliation on merge/split is our code and our test burden; this is
  deliberate because it is exactly where competitors fail.
- Two document models exist at export time (PDFium bytes → pdf-lib assembly). The export
  pipeline (ARCHITECTURE.md §4) sequences them and verifies the result with a fresh
  PDFium parse.

## Alternatives considered

- **pdf.js for viewing + PDFium for editing**: smaller first load, best text layer, but
  two renderers and duplicated text-geometry code. Kept as fallback.
- **pdf.js only**: cannot edit existing annotations, redact, encrypt, or generate
  appearances; rejected.
- **MuPDF.js only**: best API, AGPL; rejected by ADR-0001.
- **pdfcpu WASM**: 8 MB Go runtime, unofficial builds; rejected.
- **Stock `@hyzyla/pdfium`**: render-only wrapper; rejected in favor of EmbedPDF's build.
