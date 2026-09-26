# ADR-0008: qpdf integration deferred to M3 and built from source

**Status:** accepted · **Date:** 2026-09-26

## Context

No M1 or M2 feature needs qpdf: page assembly, rotation, overlays and outline
reconciliation are pdf-lib work; rendering, annotations and forms are PDFium work. qpdf is
needed for repair, linearization, object-stream normalization and as a second crypto path,
all M3 items. The available npm WASM wrappers are single-maintainer and lag upstream
(qpdf 11.0 and 12.2 vs 12.4.1 upstream).

## Decision

- qpdf enters the codebase in M3, behind the `PdfPlumber` interface defined in M0.
- It is built from upstream source in CI with Emscripten (single-threaded, MEMFS,
  `MODULARIZE`, `EXPORT_ES6`), pinned to a qpdf release tag, with the build script in
  `packages/engine/qpdf/`. The resulting artifact is committed as a release asset or
  cached in CI, never fetched from a CDN at runtime.

## Consequences

- M0 stays focused on scaffolding, the two primary engines, the model, and the shell.
- The `PdfPlumber` interface exists from M0 so M1/M2 code is written against it.
