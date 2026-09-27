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
- **Verification** (`verify`) checks page count and sizes, and optionally rotations,
  outline count/titles, page labels (needs the inspector) and form field names.
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
