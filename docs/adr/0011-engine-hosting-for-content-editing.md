# ADR-0011: Engine hosting for content editing (own PDFium worker, raw access)

**Status:** accepted · **Date:** 2026-09-27

## Context

M0–M3 drive PDFium through EmbedPDF's own worker (`createPdfiumEngine` from
`@embedpdf/engines/pdfium-worker-engine`). That worker exposes the `PdfEngine` interface
only. M4 needs calls that interface does not offer: the page-object API for removing
path objects under a redaction and for splitting text objects, `FPDFText_LoadCidType2Font`
for typesetting replacement text with a subset font, and `FPDFPage_GenerateContent`. The
two spikes (`docs/research/05-text-editing-spike.md`, `06-redaction-spike.md`) established:

- `@embedpdf/pdfium`'s `init()` returns a wrapped module with every `FPDF_*`/`EPDF_*`
  function; `@embedpdf/engines` exports `PdfiumNative` (the executor) and `PdfEngine`
  (the orchestrator). `new PdfEngine(new PdfiumNative(module, { fontFallback: null }),
  { imageConverter })` behaves exactly like the worker engine for our adapter.
- `docPtr`/`pagePtr` for an open document are reachable through the executor's cache
  (`native.cache.getContext(id)`), a private member in the type definitions but stable in
  the pinned 2.15.1 build.
- Text edits must share the `FPDF_DOCUMENT` with the renderer so the page re-renders after
  an edit; redaction does not (marks are ordinary annotations; applying happens at export).
- Raw edits must not interleave with the orchestrator's queued tasks, and the executor's
  5-second page/text-page cache must be dropped after every raw edit.

## Decision

1. **The viewer's engine moves into our own Comlink worker**
   (`packages/engine/src/worker/pdfium.worker.ts`). It hosts `init` + `PdfiumNative` +
   `PdfEngine`, a `PdfiumAdapter` created with `engineFactory: () => engine`, and the M4
   editors. The main thread talks to a proxy that implements the existing
   `PdfRenderer`/`PdfEditor` interfaces and transfers `ImageBitmap`s. EmbedPDF's worker
   wrapper is no longer used.
2. **Raw access is confined to `packages/engine/src/pdfium/host/`**: module init, the
   guarded `docContext()` (throws with a clear message if the private layout changes; a
   test pins it), memory and string helpers, and a per-document lock that serialises raw
   edits with orchestrator tasks. Nothing outside `host/`, `text-edit/` and `redaction/`
   touches the raw module.
3. **Redaction applies in a private PDFium instance** (the `compress/pdfium-decoder.ts`
   pattern) at apply time, never in the user's open document, followed by the pdf-lib
   post-pass and the forensic self-check (spec §1.2, §1.4).
4. **Text edits run in the viewer's engine** through `PdfTextEditor` (spec §2.5): split
   the text object, re-encode in the original font (tier 2) or typeset with a fontkit
   subset loaded through `FPDFText_LoadCidType2Font` (tier 1), verify with a fresh text
   page, then `GenerateContent` and drop the cached page.
5. **Export of an edited source always garbage-collects** (reopen + save, or pdf-lib
   `dropUnreachable`), because a second `GenerateContent` on a page leaves the previous
   content stream unreachable but present.
6. **`@embedpdf/*` stays pinned exactly**; Renovate proposals for it run the host canary
   tests before anything else.

## Consequences

- One worker instead of EmbedPDF's; the adapter and every engine call cross Comlink. The
  adapter's API was designed for this (bitmaps are created fresh and transferable).
- Private-member access is a maintenance risk, accepted because the version is pinned
  and the failure mode is a loud test, not silent corruption.
- Anything that needs the raw module in the future (image objects, form-field creation,
  `FPDF_SaveAsCopy` with the incremental flag) has a home.

## Alternatives considered

- **Keep EmbedPDF's worker and do text edits with pdf-lib content-stream rewriting.**
  Rejected: writing our own operator parser and font re-encoder duplicates what PDFium
  already does, and the spike showed pdf-lib appending text loses reading order.
- **Fork EmbedPDF to export the pointers.** Rejected for now: a pinned private access with
  a canary is cheaper than maintaining a fork; revisit if upstream exposes an API.
- **A second PDFium instance for text edits.** Rejected: the viewer would render a
  different document than the one being edited, and every edit would need a full reopen.
