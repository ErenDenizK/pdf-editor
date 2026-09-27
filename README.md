# pdf-editor

> A free, open-source PDF editor that runs entirely in your browser. Nothing is uploaded.
> One workspace, not forty tools.

**Status: planning.** No application code yet. This repository currently holds the
research, architecture, roadmap and design documents that the implementation will follow.
Development happens on `develop`; `main` will receive the first milestone once it is usable.

## What it will do

- Open many PDFs, lay their pages out on a light table, and drag pages between documents.
  Merge, split, reorder, rotate, delete, duplicate, interleave. Export a file whose
  bookmarks, links, page labels and form fields are preserved or deliberately reconciled.
- Read, search, and annotate with standard PDF annotations that survive in other viewers.
- Fill forms, add page numbers and watermarks, edit metadata, set passwords, compress with
  honest numbers, repair broken files.
- Later: redaction that truly removes content, careful text editing, OCR, comparison,
  signatures.
- Always: offline-capable, no telemetry, no accounts, no quotas, no upload. Served as
  static files from GitHub Pages.

## Documents

| Document | Purpose |
|---|---|
| [`docs/VISION.md`](docs/VISION.md) | Thesis, principles, non-goals, v1.0 success criteria |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Engine layering, virtual document model, export pipeline, deployment, testing |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Milestones M0–M6 with engine mapping and exit criteria |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Design intent, layout, tokens, interaction and accessibility rules |
| [`docs/DISCUSSION.md`](docs/DISCUSSION.md) | Open decisions awaiting the owner |
| [`docs/adr/`](docs/adr/) | Architecture Decision Records |
| [`docs/research/`](docs/research/) | Research snapshots (engines, market and UX, platform constraints, feature feasibility) |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Workflow, conventions, standards |

## Proposed stack (see ADRs)

PDFium (EmbedPDF v2, MIT) for rendering and content editing · `@cantoo/pdf-lib` for
assembly · qpdf WASM for repair and structure · tesseract.js for OCR · Vite 8 · TypeScript 7
· React 19 · Zustand · TanStack Virtual · pragmatic-drag-and-drop · Comlink · Vitest ·
Playwright. Everything runs in Web Workers; nothing is fetched from a CDN.

## Development

Requires Node.js 22 (see `.nvmrc`) and pnpm via Corepack.

```sh
corepack enable    # once per machine; provides the pnpm version pinned in package.json
pnpm install       # dependencies and Git hooks
pnpm dev           # web app at http://localhost:5173
pnpm run ci        # format check, lint, typecheck, tests, build
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow and repository layout.

## License

[Apache-2.0](LICENSE). Bundled third-party components are listed in [`NOTICE`](NOTICE).
See [ADR-0001](docs/adr/0001-license.md) for the reasoning.
