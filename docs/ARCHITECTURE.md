# Architecture

**Status:** proposed (2026-09-26). Decisions referenced here are recorded as ADRs in
`docs/adr/`; anything marked *open* is still under discussion in `docs/DISCUSSION.md`.

## 1. Constraints that shape everything

| Constraint | Consequence |
|---|---|
| No backend; static hosting on GitHub Pages | All PDF processing in the browser (JS + WebAssembly). No custom HTTP headers, so no COOP/COEP, so **no SharedArrayBuffer / WASM threads** by default. |
| Permissive license (proposed Apache-2.0, ADR-0001) | MuPDF.js, Ghostscript WASM and scribe.js (all AGPL) are excluded. Allowed engines: pdf.js, PDFium, pdf-lib, qpdf, tesseract.js. |
| Large files (hundreds of MB, thousands of pages) | Engines run in Web Workers; single-threaded WASM per worker; one worker per document; ~2 GiB heap ceiling per worker; OPFS for scratch; streaming saves. |
| Multi-document editing with cheap undo | A **virtual document model** that references source pages and only materializes on export. |
| Correctness | Document-level structures (outlines, links, page labels, AcroForm, metadata) are reconciled explicitly by our own code, never left to a library's `copyPages`. |

## 2. Engine layering (ADR-0002)

```
                    ┌──────────────────────────────────────────┐
  UI (main thread)  │ React + Zustand stores + canvas overlays  │
                    └──────────────┬───────────────────────────┘
                                   │ Comlink RPC (transferables)
          ┌────────────────────────┼────────────────────────────┐
          ▼                        ▼                            ▼
 ┌─────────────────┐   ┌────────────────────────┐   ┌───────────────────────┐
 │ Render/Edit     │   │ Assembly worker        │   │ Aux workers (lazy)    │
 │ worker (1/doc)  │   │ @cantoo/pdf-lib        │   │ qpdf-wasm (repair,    │
 │ PDFium via      │   │ merge/split/rotate,    │   │ linearize, crypto     │
 │ @embedpdf/      │   │ overlays (numbers,     │   │ fallback)             │
 │ engines v2      │   │ watermark), outlines,  │   │ tesseract.js (OCR)    │
 │ render, text,   │   │ labels, AcroForm       │   │ image codecs (jSquash)│
 │ search, annots, │   │ reconciliation,        │   └───────────────────────┘
 │ forms, redact,  │   │ metadata, encryption   │
 │ flatten, save   │   └────────────────────────┘
 └─────────────────┘
```

Roles:

- **PDFium (`@embedpdf/pdfium` + `@embedpdf/engines`, MIT, v2 line)** is the single
  rendering engine and the content-level editor: page bitmaps and thumbnails, glyph
  geometry for selection and search, annotation CRUD with generated appearance streams,
  form field values and widget appearance regeneration, true redaction, flatten, save.
  Since M4 (ADR-0011) it runs in the app's own module worker
  (`@pdf-editor/engine/pdfium.worker` behind `createPdfiumProxy`): one hosted engine
  (`init` + `PdfiumNative` + `PdfEngine`) serves the adapter and, through a guarded raw
  access with a per-source lock (`pdfium/host/`), the content editors (`text-edit/`,
  `image-objects/`, `redaction/`). ~1 MB gzip worker chunk, loaded on first document
  open and cached by the service worker.
- **`@cantoo/pdf-lib` (MIT)** is the *assembler*: it turns a virtual document into bytes.
  It copies pages between documents, applies rotation, prepends/appends overlay content
  (page numbers, headers, watermarks), rebuilds `/Outlines`, `/PageLabels`, `/AcroForm`,
  `/Info` and XMP, and encrypts (AES-256). Pure JS, ~250 KB gzip.
- **qpdf (WASM, Apache-2.0)** is the *plumber*: structural repair, object-stream
  generation, linearization, and a second, independent decrypt/encrypt path. ~0.45 MB
  gzip, loaded only when needed. We build the WASM ourselves in CI from qpdf 12.x rather
  than depending on a single-maintainer npm wrapper (*open*).
- **tesseract.js (Apache-2.0)** for OCR in v2, producing an invisible text layer over the
  untouched scanned image.
- **pdf.js is not in the default build.** It remains the documented fallback renderer
  if PDFium fidelity or performance disappoints on a class of files, and its source is our
  reference for text-layer and highlight QuadPoint construction. (*open*: see
  `DISCUSSION.md` item 2.)

Every engine sits behind a TypeScript interface owned by us (`PdfRenderer`,
`PdfEditor`, `PdfAssembler`, `PdfPlumber`) so an engine can be swapped without touching
the UI. Nothing is loaded from a CDN; all WASM and font/CMap assets ship with the app.

## 3. Virtual document model

```ts
interface Workspace {
  sources: Record<SourceId, SourceDocument>;   // opened files, immutable bytes
  documents: Record<DocId, VirtualDocument>;   // what the user sees in tabs
  history: HistoryStack;                        // immutable snapshots, structural sharing
}

interface SourceDocument {
  id: SourceId; name: string; bytes: ArrayBuffer /* transferred to its worker */;
  pageCount: number; encrypted: boolean; repaired: boolean; hasXfa: boolean;
  edits: EngineEditLog;   // annotation/form/redaction edits applied inside PDFium
}

interface VirtualDocument {
  id: DocId; title: string;
  pages: VirtualPage[];
  outline: OutlineNode[];          // reconciled from sources, user-editable
  labels: PageLabelRange[];        // preserved from sources
  metadata: DocumentMetadata;      // Info + XMP policy
  security?: SecurityPolicy;       // passwords + permission bits
}

interface VirtualPage {
  id: PageId;
  ref: { source: SourceId; index: number } | { blank: { width: number; height: number } }
     | { image: BlobId };
  rotation: 0 | 90 | 180 | 270;    // delta on top of the source /Rotate
  cropBox?: Rect;
  resize?: PageResize;             // new page size, applied after the crop (see below)
  overlays: OverlayOp[];           // page numbers, watermark, header/footer (declarative)
}

interface PageResize {             // unrotated user space, like cropBox
  width: number; height: number;   // the new page box, points
  mode: 'scale' | 'fit' | 'canvas'; // cover (or `stretch`), fit with margins, keep 100%
  anchor: Anchor;                  // nine positions; where the content sits
  stretch?: boolean;               // scale only: per-axis scale, fills exactly
}
```

- Structural operations (reorder, delete, rotate, duplicate, move across documents,
  split, merge) are array edits on `VirtualDocument.pages`. They are O(1) to O(n) on
  small arrays and instantly undoable.
- Content operations (annotate, fill, redact, edit text, move or replace images) are
  applied to the source's PDFium document inside the worker and recorded per source as
  `EngineEdit`s. Annotation and form edits and image transforms carry exact inverses; text
  edits, image removal or replacement and applied redactions are non-invertible and marked
  "replay required": undo reopens the source's original bytes and replays the remaining
  edit list (byte-identical by construction), redo re-applies the recorded edit. Applied
  redactions and crop-with-discard replace the source's bytes with a verified result under
  the same page ids.
- **Undo/redo** is a pointer into a persistent history of workspace snapshots (Immer-style
  structural sharing) plus command replay for engine-side edits. Drag and color changes
  coalesce (pdf.js `CommandManager` model). History is persisted to IndexedDB/OPFS with
  the source bytes so a crashed tab can be recovered.
- Rendering a virtual page = render the source page (cached `ImageBitmap` keyed by
  source, index, rotation, scale) + overlay canvas.
- **Resize** maps the content box (what the crop leaves visible) into the new page box by
  x' = a·x + e, y' = d·y + f (document-model `resize.ts`, shared by every consumer). It is
  stored unrotated so a later rotation turns the resized page as a whole; the dialog's
  displayed size and anchor are converted per page. On screen the source bitmap is placed
  at the content placement and the viewer's page frame folds the matrix in, so text,
  links, annotations, forms and search follow; at export the assembler keeps the copied
  page and wraps its content in `q <matrix> cm … Q`, transforming page boxes, annotation
  and widget geometry and destinations (`pdflib/page-resize.ts`). The verification pass
  checks the new page sizes and that annotations of pages whose content fits stay inside.

## 4. Export pipeline

1. For each source that has engine edits: PDFium `saveAsCopy` in its worker → edited
   bytes (annotations, form values, redactions applied; redaction forces full rewrite).
2. Assembly worker (pdf-lib): create the output document; for each `VirtualPage` copy the
   page from the (edited) source with a per-source copier that de-duplicates shared
   resources; set `/Rotate`; apply crop; draw overlays behind or over content inside
   balanced `q … Q`.
3. **Document-level reconciliation** (our code, the part competitors skip):
   - outlines: walk each source outline, keep nodes whose target page survived, remap
     destinations (explicit and named), optionally wrap each source under a parent node;
   - links: rewrite `/Dest` and GoTo actions, drop links to removed pages;
   - AcroForm: merge `/DR` fonts, wrap each source's fields under a namespaced parent (or
     rename collisions), regenerate appearances, set `/NeedAppearances false`;
   - page labels: rebuild `/PageLabels` from per-page labels;
   - tagged PDF: if the structure tree cannot be preserved intact, remove
     `/StructTreeRoot` and `/MarkInfo` and tell the user;
   - metadata: apply the chosen policy, regenerate `/ID`.
4. Optional: encrypt (pdf-lib AES-256) or hand to qpdf for linearize / compatibility mode
   (no object streams, PDF 1.4).
5. **Verification pass**: re-open the output in a fresh PDFium worker, check page count,
   extract text under redaction boxes (must be empty), compare page sizes. Only then offer
   the download.
6. Delivery: File System Access API stream (Chromium) → OPFS + `<a download>`
   (Firefox/Safari).

Incremental updates (append-only saves) are used only when the user annotated or filled a
single source and the source is signed or the user asks to preserve history. Never after
redaction, merge or repair.

## 5. File input

Three-tier open path: `showOpenFilePicker` → `<input type=file multiple>` fallback;
drag and drop resolves `DataTransferItem.getAsFileSystemHandle()` →
`webkitGetAsEntry()` (recursive folder walk) → `getAsFile()`. Bytes are transferred
(not copied) to the document's worker. Encrypted files prompt for a password in the UI and
are opened by PDFium; "remove password" and "set password" go through pdf-lib (fallback
qpdf). Files that PDFium had to repair on open are flagged and the user is offered a
repaired copy rather than an incremental save onto a broken xref.

## 6. Frontend (ADR-0003)

- **Vite 8 + TypeScript 7 (strict) + React 19 with the React Compiler.**
- State: **Zustand** stores (workspace, viewer, selection, tool mode); history implemented
  as our own snapshot stack, not a generic middleware.
- Tool/mode state machine: a small explicit state machine (XState Store or hand-rolled)
  for `idle → selecting → dragging → committing`, so drag-and-drop, keyboard moves and
  touch share one model.
- Virtualization: **TanStack Virtual** for the light table grid and thumbnail rail.
- Drag and drop: **Atlassian pragmatic-drag-and-drop** (native HTML5 DnD, cross-document
  and OS file drops share primitives) with our own keyboard fallback and live-region
  announcements.
- Worker RPC: **Comlink** behind our interfaces.
- Styling: **design tokens as CSS custom properties + CSS Modules**; no component
  framework. Headless accessibility primitives for menus, dialogs, tooltips (*open*:
  Radix Primitives vs Base UI).
- Routing: hash-based or none; the app is a single workspace.
- i18n: **Paraglide JS** (compiled, typed messages); English first, Turkish second.

## 7. Deployment and offline

- GitHub Actions: `ci.yml` (lint, typecheck, unit, build, Playwright on Chromium /
  Firefox / WebKit) and `deploy.yml` (`actions/upload-pages-artifact@v3` +
  `actions/deploy-pages@v4`, `environment: github-pages`, `concurrency: pages`).
- Vite `base` set to the project path; the same base propagated to the manifest, service
  worker scope, worker URLs and WASM URLs. A custom domain avoids shared-origin storage
  clashes between project sites and is recommended before v1.0.
- PWA via `vite-plugin-pwa` (migrate to `@vite-pwa/core` when stable):
  `registerType: 'prompt'`; multi-megabyte WASM excluded from precache and cached at
  runtime (CacheFirst) so first paint never waits on an engine download.
- Strict CSP in a `<meta>` tag: `default-src 'self'`, `connect-src 'none'` (or `'self'`
  only for our own assets), `worker-src 'self'`, `wasm-unsafe-eval` for WASM. The privacy
  indicator in the UI reads the live `PerformanceObserver` resource list to display
  "0 external requests".
- Cross-origin isolation (`coi-serviceworker`) is **not** used in v1; it is a documented
  progressive enhancement if a threaded component is ever added (ADR-0004).

## 8. Testing strategy

- Unit tests (Vitest 5) for the virtual document model, history, reconciliation logic.
- **Engine tests in Vitest Browser Mode** (real WASM, workers, OPFS) against a curated
  corpus in `test/fixtures/` (see `ROADMAP.md`, M0): tagged PDFs, forms with colliding
  names, outlines with named destinations, page labels, encrypted (RC4/AES-128/AES-256),
  broken xref, XFA, Type3 fonts, CCITT/JBIG2/JPX scans, huge page counts.
- **Golden-file tests**: every structural operation's output is re-parsed by a second
  parser and compared (page count, sizes, outline titles, field names, label strings,
  extracted text).
- **Redaction forensic tests**: raw byte grep + text extraction under every redaction.
- Playwright (1.63) end-to-end with screenshot comparison of rendered pages, baselines
  generated in the CI Docker image only.
- Lighthouse CI budget on total JS+WASM bytes and interaction latency.

## 9. Browser support

Chromium 125+, Firefox current and ESR, Safari 18+. Desktop-first; the layout must not
break on tablets, but touch-optimized interaction is a v2 item. Firefox and Safari lack
the File System Access API; saving there uses OPFS + download link. Safari has no
`getAsFileSystemHandle`; folder drops degrade to file drops.
