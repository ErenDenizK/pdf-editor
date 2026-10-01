# pdf-editor

> A free, open-source PDF editor that runs entirely in your browser. Nothing is uploaded.
> One workspace, not forty tools.

**Status: M1–M3 implemented (v1.0 candidate).** Light table, viewer with search and
annotations, forms, page numbers and watermarks, metadata, passwords, compression, image
export and repair are in place; the M3 correctness review and the cross-viewer annotation
matrix are the remaining gates. Open many PDFs,
arrange their pages on the light table (drag-and-drop, split, merge, interleave, rotate,
images as pages), and export a verified file whose bookmarks, links, labels and form fields
are reconciled. English and Turkish UI, offline PWA, no network after load. CI runs on
Chromium, Firefox and WebKit. See [`docs/ROADMAP.md`](docs/ROADMAP.md). Development
happens on the integration branch; `main` receives milestones.

## What it will do

- Open many PDFs, lay their pages out on a light table, and drag pages between documents.
  Merge, split, reorder, rotate, delete, duplicate, interleave. Export a file whose
  bookmarks, links, page labels and form fields are preserved or deliberately reconciled.
- Read, search, and annotate with standard PDF annotations that survive in other viewers.
- Fill forms, add page numbers and watermarks, edit metadata, set passwords, compress with
  honest numbers, repair broken files.
- Redact so the content is really gone, edit text in place with honest fidelity states,
  move and replace images, crop, resize pages, create form fields, edit bookmarks.
- Recognize text in scans into a searchable layer (nine languages, downloaded on demand),
  compare two documents visually and by words, check and add digital signatures without
  ever calling anything "valid", export pages as Markdown or text, and run saved recipes
  over many files at once.
- Keep it simple to work in: a Home view where the open files combine from one button, a
  navigator with four labelled tabs, tools grouped by task with their options beside them,
  and a pen that writes without interruption, keeps four presets and edits with a lasso.
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
