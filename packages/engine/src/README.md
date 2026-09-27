# @pdf-editor/engine

Engine contracts (`types.ts`) and their adapters. UI code depends only on the interfaces
(ADR-0002); nothing here loads anything from a CDN.

| Adapter | Implements | Engine |
| --- | --- | --- |
| `PdfiumAdapter` | `PdfRenderer`, `PdfEditor`, `PdfVerifier` | PDFium via `@embedpdf/engines` 2.x |
| `PdfLibAssembler` | `PdfAssembler` | `@cantoo/pdf-lib` |
| `createAssemblerProxy(worker)` | `PdfAssembler` | `PdfLibAssembler` in a Worker via Comlink |

## PDFium (render, text, annotations, forms, redaction, verification)

```ts
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'; // app code: Vite-specific import
import { PdfiumAdapter } from '@pdf-editor/engine';

const pdfium = new PdfiumAdapter({ wasmUrl });
const doc = await pdfium.open(sourceId, bytes, { password });
const { bitmap } = await pdfium.renderPage(sourceId, 0, { scale: devicePixelRatio });
```

- **wasm URL**: injected by the app. Use the package export `@embedpdf/pdfium/pdfium.wasm`
  (`dist/pdfium.wasm` is not in the package's `exports` map). Relative URLs are resolved
  against `location` because EmbedPDF's worker runs from a `blob:` URL; the CSP therefore
  needs `worker-src blob:` and `connect-src 'self'` for the wasm fetch.
- **Font fallback is off by default** (`fontFallback: null`). EmbedPDF's default would fetch
  fonts from cdn.jsdelivr.net, which this project never does. To enable fallback, host the
  fonts yourself and pass a `FontFallbackConfig` (`FontCharset` is re-exported), e.g.
  `{ baseUrl: '/fonts/', fonts: { [FontCharset.SHIFTJIS]: 'NotoSansJP-Regular.otf' } }`.
  The config is posted to the worker, so use URLs, not a `fontLoader` function.
- The engine starts lazily on the first call; `destroy()` terminates its worker.
- **Page labels and /Lang**: EmbedPDF has no API for them (PDFium's `FPDF_GetPageLabel` is
  exported by `@embedpdf/pdfium` but unreachable inside EmbedPDF's blob: worker). Pass an
  `inspector` (the assembler proxy, or a `PdfLibAssembler`): `open` then inspects a copy of
  the bytes with pdf-lib in parallel and fills `pages[].label` and `metadata.language`.
- **`flags.repaired`**: PDFium and pdf-lib repair silently, so `open` runs
  `checkXrefStructure` (pure, header + tail + xref sections only): header at byte 0,
  `startxref` → `xref` table with a trailer or an xref stream, valid `/Prev` chain, sampled
  entry offsets. Any failure means the reader reconstructed the file.
- **Outline facts**: EmbedPDF drops the /Count sign and reports null /XYZ parameters as 0.
  With an inspector, `open` reads both with pdf-lib and merges them into
  `OpenedDocument.outline` (`open`, and `left`/`top` kept when they are exactly 0). Without
  one, every node is closed and a 0 coordinate reads as "keep current".
- **Pages** carry `cropBox` (user space). Glyph rects, search hits, annotation rects and
  render clips are absolute user space; subtract the CropBox origin to place them on the
  rendered page.
- **Search** streams: `search(id, q, { onProgress })` is called per page as PDFium finishes
  it; hits carry `matchStart`/`matchLength` into `context`.
- **Verification** (`verify`) checks page count and sizes, and optionally rotations,
  outline count/titles, page labels (needs the inspector), form field names, annotation
  counts per page (`annotationCounts`, links excluded) and annotation conformance
  (`checkAnnotations`, optionally scoped to `annotationIds`).
- All geometry is PDF user space (unrotated, origin bottom-left). `renderPage` returns a
  fresh `ImageBitmap`; if you put the adapter behind Comlink, transfer the bitmap.
- Every call accepts an `AbortSignal`; aborting rejects with `EngineError('aborted')`.

## Assembly (virtual document → bytes)

```ts
import { createAssemblerProxy } from '@pdf-editor/engine';
import AssemblerWorker from '@pdf-editor/engine/assembler.worker?worker'; // Vite, app code

const assembler = createAssemblerProxy(new AssemblerWorker());
const { bytes, report } = await assembler.assemble({ document, sources, blobs }, { signal });
```

Source and blob `ArrayBuffer`s are transferred to the worker (detached for the caller).
`assembler.inspect(bytes)` / `getPageLabels(bytes)` read labels and /Lang in the same worker.

`planExport(workspace, documentId)` derives the assembly document (label ranges via
`deriveLabelRanges` only when `needsPageLabels`, outline via `dropUnresolved`), the source
names used for form namespaces, and the `VerificationExpectation` for the output. The
assembler writes exactly the labels it is given. Reconciliation covers: outlines (explicit
and named destinations resolved on open), links (explicit and named, rewritten or dropped
and counted), AcroForm (`namespace-by-source`, `rename-collisions`, `unify-same-name`),
/PageLabels, structure tree removal, XFA removal, fresh /ID and XMP, /Lang passthrough.
`PdfLibAssembler` can also be used directly on the main thread.

Overlay placement: anchors and offsets refer to the visible page (CropBox after /Rotate);
`offset` is in points, +x right, +y up. Text overlays use the standard 14 fonts until M3.

## Annotations (M2)

`PdfiumAdapter` implements every kind of spec viewer-annotations.md §3 through EmbedPDF,
plus a pdf-lib post-pass in `save()` (`annotations/finalize.ts`) for what EmbedPDF leaves
out. Geometry is PDF user space; quads, ink points and vertices survive create → list →
save → re-open → list within 0.01 pt (tests: `test/annotations.test.ts`).

| Kind | Create / update / delete | Notes |
| --- | --- | --- |
| highlight, underline, strikeout, squiggly | native | Highlights get a Multiply blend. Fewer quads on update = delete + recreate with the same id. |
| ink | native | /Rect derived from the paths plus half the stroke width. |
| square, circle | native | |
| line, polygon, polyline | native | `lineEndings` → /LE (arrow = `open-arrow`); /Rect derived from the vertices. |
| free-text | native, **limited** | Standard-14 Helvetica/Times/Courier with WinAnsi encoding (PDFium generates the /AP and declares the font in its resources; the font is not embedded). Text outside WinAnsi (e.g. Turkish ğ ı ş) is refused with `EngineError('unsupported')`: PDFium writes an **empty** appearance for it. The spec's embedded Inter subset is not possible through EmbedPDF 2.15. |
| text (note) | native + post-pass | Icon, contents, color native. Popup (/Popup ↔ /Parent) and open state (/Open) written by `save()`; `open` is kept by the adapter until then and read back from the popup on open (inspector). |
| stamp (image) | native + post-pass | PNG, JPEG, or a one-page PDF appearance (`getAnnotationAppearance` returns one, used to recreate deleted stamps). Opacity (/CA + ExtGState wrapper) is written by `save()`; PDFium's live render shows the stamp opaque until then. A new image = delete + recreate with the same id. |
| stamp (named) | generated appearance | `name` in `STAMP_NAMES` (Approved, Draft, Confidential, ...) without an image gets a text-only appearance generated with pdf-lib (`annotations/stamp-appearance.ts`). Other names: `EngineError('unsupported')`. |
| link | native (read-only use) | Listed with `uri` / `targetPageIndex`. Created links get EmbedPDF's default underline border. |
| popup | not listed | Belongs to its parent (`NoteAnnotation.open`). |

What `save()` adds (post-pass, runs in the assembly worker when the inspector offers
`finalizeAnnotations`):

- `/P` on every annotation (PDFium writes none) — conformance failure in EmbedPDF's output.
- `/M` is always passed to EmbedPDF (PDFium writes it only when given); `/F` Print forced
  on annotations created or updated in this session.
- Popups for notes and for commented markup (unless `includeComments: false`, which removes
  every popup); orphan popups of deleted notes are removed. EmbedPDF has no popup support.
- Stamp opacity (EmbedPDF writes no /CA for stamps).

EmbedPDF's own output was otherwise conformant: /AP with an ExtGState carrying CA/ca when
opacity < 1, QuadPoints in UL, UR, LL, LR order, /Rect = appearance BBox.

Other EmbedPDF 2.15 quirks handled here: annotation and widget rects are read back with the
unrotated size at a rotated corner on /Rotate 90/180/270 pages (`annotationRectToUser`);
an update merges into the existing object, so absent `contents`/`author` are written as
empty (updates carry the full state).

`flattenAnnotations` bakes every annotation except links and popups. Saving annotation
edits into an encrypted document requires `removeSecurity` (pdf-lib would write the post-
pass output unencrypted); export always removes and re-applies security.

### Ids (/NM) and the edit log

`createAnnotation({ ..., id })` creates the annotation with that /NM (EmbedPDF honours a
supplied id; duplicates on the page are refused). `edits/` builds on it:
`applyEngineEdit(editor, edit)` applies an `EngineEdit` (annotation create/update/delete,
form set-value) and returns its inverse (whose `inverse` is the applied edit, for redo);
`applyEngineEditWithResult` also returns the applied edit with the engine-assigned id filled
in (record that one). `replayEngineEdits` re-applies a log on freshly opened sources (crash
recovery). Payloads are JSON (`edits/payloads.ts`; stamp images travel as base64).
Redaction edits are refused (`unsupported`) until M4.

### Conformance

`checkAnnotationConformance(bytes, { ids? })` (`annotations/conformance.ts`) checks what the
research (04-feature-feasibility.md §3) lists; rules and their exact reading are documented
in the file. The QA sample and matrix for real viewers live in `docs/qa/`.
