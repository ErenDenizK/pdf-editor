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

## Amendment (2026-09-27, M3): built from source, committed, verified in CI

**Status:** implemented as decided; no npm wrapper is used.

- The source build worked in the development sandbox, so the npm fallback
  (`@neslinesli93/qpdf-wasm`, qpdf 12.2) was not needed. `packages/engine/qpdf/build.sh`
  builds **qpdf v12.4.2** with **zlib v1.3.1** and **libjpeg-turbo 3.1.2** (SIMD off), all
  fetched with `git clone` at pinned tags, using **Emscripten 6.0.10**. Emscripten's own
  ports (`-sUSE_ZLIB`, `-sUSE_LIBJPEG`) download GitHub archive tarballs, which the
  sandbox's egress policy blocks, so the script builds both libraries itself; that also
  keeps every input pinned in one file. Crypto is qpdf's native provider (no OpenSSL or
  GnuTLS), which covers AES-256 (R6) and the legacy algorithms for decryption.
- Link flags: `MODULARIZE`, `EXPORT_ES6` (factory `createQpdf`), `INVOKE_RUN=0`,
  `FORCE_FILESYSTEM` (MEMFS), `ALLOW_MEMORY_GROWTH` up to 4 GB, `ENVIRONMENT=web,worker`,
  C++ exceptions enabled (qpdf reports errors with exceptions), single-threaded.
- The artifact (`qpdf.mjs` 80 KB, `qpdf.wasm` 3.0 MB, 0.8 MB gzipped) is committed in
  `packages/engine/qpdf/dist/` with `BUILD-INFO.txt` (versions and SHA-256). A nested
  `.gitignore` re-includes that `dist/`, which the root `.gitignore` ignores. The app
  serves it same-origin, runtime-cached like PDFium's wasm, never from a CDN.
- `.github/workflows/qpdf-wasm.yml` rebuilds it from source whenever
  `packages/engine/qpdf/**` changes (and weekly) and fails if the result differs from the
  committed files, so the shipped binary is always reproducible from the script.
- Runtime (`packages/engine/src/plumber/qpdf-plumber.ts`): `QpdfPlumber implements
  PdfPlumber`, used only inside the compress worker. The wasm is compiled once; each job
  instantiates a fresh module (no C++ or MEMFS state leaks between jobs), writes the input
  to MEMFS, runs `callMain` with the flags from `qpdf-args.ts` and reads the output.
  Inputs above 512 MB are refused before loading. `repaired` is derived from qpdf's
  recovery warnings; `check()` (`qpdf --check`) returns structural warnings for the
  diagnostics panel.
- Upstream quirk found: when a damaged file has no trailer at all (`truncated.pdf`),
  qpdf 12.4.2 writes a trailer (or xref stream) without the required `/Size`. The plumber
  detects this, rewrites with a classic xref table, patches `/Size` in place (no offsets
  move) and, when object streams, linearization or encryption were requested, runs that
  job on the patched copy. Worth reporting upstream.

### Consequences of the amendment

- Updating qpdf means changing the tags in `build.sh`, running it with the pinned
  Emscripten and committing `dist/`; CI rejects a `dist/` that the script does not
  reproduce.
- A second crypto path exists: `PlumberOptions.encrypt` writes AES-256 through qpdf, and
  `decrypt` reads every standard security handler qpdf supports. The export pipeline uses
  it when compressing an encrypted output (decrypt, compress, re-encrypt with the same
  policy).
