# Roadmap

**Status:** proposed (2026-09-26). Milestones are ordered by dependency, not by calendar.
We ship when a milestone's exit criteria pass, not on a date. Versions follow SemVer:
`0.x` until the v1.0 success criteria in `VISION.md` are met.

Legend for engine columns: **P** = PDFium (EmbedPDF engines), **L** = @cantoo/pdf-lib,
**Q** = qpdf-wasm, **T** = tesseract.js, **own** = our own code on top.

## M0 — Foundation (no user-visible features) — **done 2026-09-27**

Goal: a repository a Microsoft/Google-grade team would be comfortable contributing to.

- Repository scaffolding: Vite 8, TypeScript 7 strict, React 19, ESLint 10 flat config +
  typescript-eslint, Biome formatter, lefthook + commitlint (Conventional Commits),
  Changesets, Renovate, EditorConfig, CODEOWNERS, issue/PR templates.
- CI: lint, typecheck, unit tests, build, Playwright smoke on three browsers; deploy to
  GitHub Pages from `main`; preview build artifact on PRs.
- Engine abstraction layer (`packages/engine`): `PdfRenderer`, `PdfEditor`,
  `PdfAssembler`, `PdfPlumber` interfaces; PDFium worker with Comlink; pdf-lib assembly
  worker. qpdf is integrated in M3 (ADR-0008).
- Test corpus (`test/fixtures/`) with provenance notes and licenses for every file.
- Design tokens and the base UI shell (app frame, panels, command palette skeleton).
- Docs: this set, plus `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`.

Exit: `pnpm run ci` green; a page from a dropped PDF renders in the shell; deploy works.
Status: all three met except the first production deploy, which needs GitHub Pages enabled
on the repository and a merge to `main` (owner action).

## M1 — Light table and structural editing  (→ v0.1) — **done 2026-09-27**

The mandatory feature: merge many PDFs with drag-and-drop reordering.

Status as of 2026-09-27 (legend: **done**, **partial** with what is missing).

| Feature | Engine | Notes | Status |
|---|---|---|---|
| Open many files (picker, drop, folder drop) | own | three-tier input path; PNG/JPEG/WebP accepted too | done |
| Tabs per document; light table view of any set of documents | own | pin via tab menu, tab drag, "Show all" | done |
| Thumbnail grid, virtualized, adjustable size | P | cached bitmaps; image pages drawn from their blobs | done |
| Select (click, shift, marquee), drag between documents, insertion indicator | own | pragmatic-dnd; keyboard alternative (cut/paste, Alt+Arrows) | done |
| Reorder, delete, duplicate, rotate, reverse, interleave (odd/even, duplex) | own | virtual model; Interleave dialog previews the first 6 pages | done |
| Split: by ranges, every N, by outline, extract selection to new tab | own | Split dialog (every N, typed ranges with inline errors, top-level bookmarks, before selected pages); "Move / Copy to new document" | partial: only top-level bookmarks cut (no deeper outline level); split titles by bookmark only in outline mode |
| Merge: into another document, all open documents | own | section/tab menu "Merge into…" (submenu of documents); "Merge all open documents" with reorderable order and title | done |
| Rename documents | own | in place in tab or section header (double-click, F2, menus), validated | done |
| Insert blank page, insert images as pages (JPEG/PNG/WebP) | L | blank size follows the preceding page; images at 72 dpi, "Fit to A4 width" or "Original size"; WebP re-encoded to PNG, JPEG passed through; a drop onto a section is one undo step | partial: EXIF orientation of JPEGs is not applied in the PDF; no GIF/HEIC |
| Export with outline/link/label/AcroForm reconciliation | L + own | the correctness core; image pages get their blobs | done (engine warnings in the summary are English only) |
| Verification pass before download | P | | done |
| Undo/redo with history panel | own | every section operation is one labelled history entry | done |
| Command palette, shortcuts, `?` overlay | own | section operations in the "Documents" group; F2 renames | done |
| Privacy indicator, offline PWA | own | | done |
| English and Turkish UI | own | Paraglide catalogs; palette groups re-register on language change | done |
| Form-widget warning badge on duplicated pages (spec §5) | own | needs the per-page form policy (M3) | not started |

Exit: the five-file merge scenario in `VISION.md` passes with golden-file tests
(`packages/engine/test/merge-golden.test.ts`, six corpus files) — met. The UI flow (drop,
Merge all, export, page count checked with pdf-lib) is covered by
`apps/web/e2e/light-table.spec.ts`.

## M2 — Viewer and annotations  (→ v0.2) — **implemented 2026-09-27, exit pending QA matrix**

| Feature | Engine | Notes | Status |
|---|---|---|---|
| Continuous virtualized page view, zoom (fit, width, %), rotation view | P | plus single-page and two-up layouts; pointer-anchored pinch and Mod+wheel zoom; tiles above 16 MP | done |
| Text selection from glyph geometry, copy, search across pages | P | text layer per run mapped through page frame (CropBox origin, rotation); streamed search with match offsets | done (one stretched span per run; approximate for unusual fonts) |
| Outline panel, page labels shown, go-to-page, remembered position | P + own | authored open state; Mod+G accepts labels | done |
| Highlight / underline / strikeout from selection (QuadPoints) | P | squiggly too; merged per line, order verified in saved bytes | done |
| Ink, shapes (rect, ellipse, line, arrow), free text, sticky notes | P | arrows via line endings; notes with popups written at save; free text limited to WinAnsi characters with standard fonts | partial: no embedded Inter font for free text; each ink stroke is its own annotation |
| Image stamp, signature (draw / type / image), clearly labeled as not cryptographic | P | built-in DRAFT / APPROVED / CONFIDENTIAL text stamps | partial: stamp opacity only via post-pass |
| Contextual floating toolbar for the selection; properties panel | own | 8 swatches + custom, opacity, stroke, font size, comment | done (no arrow-key nudging; multi-select within one page) |
| Flatten annotations on export (optional) | P | plus include-comments toggle; conformance check in verification | done |
| Comments panel | own | by page, author setting | done |

Exit: annotations created here render identically in Acrobat Reader, Chrome, Firefox,
Preview and Edge (manual matrix in `docs/qa/annotations-matrix.md`, sample file
`docs/qa/samples/annotations-sample.pdf`) — **pending: needs a person with those viewers**.
Structural conformance (AP, Rect, QuadPoints, /P, /NM, Print flag, opacity ExtGState,
Multiply blend) is asserted automatically on every export.

Known engine behaviours to keep in mind (from the M2 correctness review; tracked as
follow-ups, not blockers):

- EmbedPDF regenerates the page content stream on every annotation update, so an edited
  source is exported through PDFium's re-serialization rather than byte-preserved.
- Reading annotations assigns a `/NM` to any annotation that lacks one; edited sources
  therefore leave with ids on annotations that had none.
- Undoing a delete or update of an annotation that came with the file rebuilds it from our
  mapping and regenerates its appearance; custom appearances, rich text and unmapped keys
  are not restored. Annotations created in the app round-trip exactly.
- Free text is limited to WinAnsi characters with the standard fonts until an embedded
  Unicode font path exists (M3, together with overlay fonts).
- Note icons (NoRotate) keep their orientation on pages with an intrinsic /Rotate, as
  ISO 32000 §12.5.6.4 requires (some PDFium-based viewers turn them with the page): the
  icon hangs upright from the /Rect's upper-left corner, so the annotation layer places a
  note's hit target and selection on the drawn icon rather than on its /Rect. The renderer
  does apply the app's own view rotation to them, so a note on a page rotated in the app
  looks turned until export, where the rotation becomes /Rotate and conformant viewers
  show it upright.
- NoZoom is ignored by the renderer: note icons scale with the zoom.

## M3 — Documents as data  (→ v0.3) — **done 2026-09-27**

| Feature | Engine | Notes | Status |
|---|---|---|---|
| Fill AcroForms; flatten; detect and warn about XFA | P + L | inline editors for every field type, Tab order across pages, forms panel, pdf-lib flatten pass (PDFium cannot flatten checkboxes) | done (EmbedPDF cannot clear radio groups or empty non-editable dropdowns; option export values not exposed) |
| Page numbers, headers/footers, Bates numbering | L | embedded Inter / JetBrains Mono / Noto Serif subsets, shared placement function, live preview, mirroring, page ranges | done (document-level rules: pages inserted later inherit them; Bates runs derive each document's start from current page counts, so numbers stay unique) |
| Watermark (text/image, opacity, tiling, behind/over) | L | Form XObject reused per page | done (removable /Watermark annotation mode skipped) |
| Metadata view/edit/strip (Info + XMP + attachments + JS) | L | custom keys, BCP-47 language, strip checklist, unreachable objects removed, fresh /ID | done |
| Open encrypted; remove password; set user/owner password and permissions (AES-256) | P + L (Q fallback) | restricted-source badge with permission bits and handler, strength meter, random owner password when omitted | done (qpdf fallback for exotic filters not wired) |
| Compress: lossless pass (object streams, dedupe, unused resources) | L + Q | qpdf built from source, reproducible, CI-verified | done |
| Compress: image downsample + JPEG re-encode with presets | own + P | analysis table, estimate, presets, compare view; skips alpha/CCITT/JBIG2/JPX and at-target images | done (Gray/CMYK re-encoded as RGB; no font subsetting) |
| PDF → images (PNG/JPEG at DPI) | P | plus WebP, tiling, ZIP, clipboard | done |
| Repair broken files with notice | P + Q | "Save repaired copy" through qpdf with verification; diagnostics panel | done (no e2e yet) |
| qpdf built from source in CI behind `PdfPlumber` | Q | ADR-0008 amended: Emscripten 6, zlib and libjpeg-turbo in-tree | done |

Exit: v1.0 success criteria met → **v1.0.0**, merge `develop` into `main`, tag.
Status: functionality complete and the independent correctness review of M3 resolved (9
findings fixed with regression tests). The one remaining gate before v1.0 is the M2
cross-viewer annotation matrix, which needs a person with Acrobat, Preview and Edge.

## M4 — Editing content  (→ v1.x)

- True redaction (PDFium redact in quads + annotation/metadata scrub + forensic
  self-check + forced full rewrite).
- Text editing, tier 1: "cover and remove" (glyphs actually removed, new text overlaid).
- Text editing, tier 2: in-place edits when the embedded font has every needed glyph,
  verified by read-back; visible "font substituted / reflow risk" state otherwise.
- Image objects: move, resize, replace, extract.
- Crop (as CropBox) with an explicit "crop and discard content" option; page resize with
  annotation transforms.
- Form field creation.
- Outline editor.

## M5 — Recognize and compare  (→ v1.x)

- OCR to searchable PDF (tesseract.js in a worker; glyphless invisible text layer;
  language packs downloaded on demand and cached).
- Compare two documents (visual pixel diff + text diff).
- Digital signature validation (pkijs + WebCrypto); PAdES-B signing with a local
  PKCS#12 as an incremental update. Timestamps and LTV documented as needing a proxy.
- PDF → text / Markdown.
- Batch: apply a recipe to many documents; saved recipes.

## M6 — Ecosystem  (→ v2)

- Plugin API for tools.
- Optional Tauri desktop shell with file associations.
- Browser extension "open with".
- Touch-optimized interaction for tablets.
- Annotation set export/import as files.
- Text editing tier 3: paragraph re-typesetting with embedded substitute fonts.

## Explicitly deferred or declined

- Office ↔ PDF conversion (fidelity), PDF/A claims (no validator), cloud collaboration,
  any hosted or metered service, any telemetry.
