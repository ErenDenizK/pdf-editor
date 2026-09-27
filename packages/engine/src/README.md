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
`PdfLibAssembler` can also be used directly on the main thread.

Overlay placement: anchors and offsets refer to the visible page (CropBox after /Rotate);
`offset` is in points, +x right, +y up. Text overlays use the standard 14 fonts until M3.
