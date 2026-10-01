# Roadmap

**Status:** revised 2026-10-01 after the owner's review of M5. Milestones are ordered by
dependency, not by calendar. We ship when a milestone's exit criteria pass, not on a date.
Versions follow SemVer and ADR-0017: M1–M5 were internal (0.1–0.5, never published); the
first public release is `1.0.0-beta.0` at the end of M7, and `1.0.0` only when the exit
criteria at the end of this document pass.

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

## M1 — Light table and structural editing  (→ 0.1, internal) — **done 2026-09-27**

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

## M2 — Viewer and annotations  (→ 0.2, internal) — **done 2026-09-27**

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

Exit: annotations created here render correctly in two independent renderers, our PDFium
build (Chrome-class viewers) and pdf.js (Firefox), checked headlessly by the automated
matrix (`pnpm --filter @pdf-editor/qa-tool matrix`, results and contact sheets in
`docs/qa/annotations-matrix.md`); Acrobat, Preview and Edge have an optional five-minute
spot check (owner decision, `DISCUSSION.md` #13). Structural conformance (AP, Rect,
QuadPoints, /P, /NM, Print flag, opacity ExtGState, Multiply blend) is asserted
automatically on every export. Open at the time of writing: pdf.js drew a second, black
underline under our links (missing `/C`); the engine fix is in progress.

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

## M3 — Documents as data  (→ 0.3, internal) — **done 2026-09-27**

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

Exit: v1.0 success criteria met in Chromium (relabelled 0.3 on 2026-10-01: nothing was published, and 1.0 now has the criteria at the end of this document).
Status: functionality complete and the independent correctness review of M3 resolved (9
findings fixed with regression tests). The M2 cross-viewer gate is now the automated
matrix; v1.0 is tagged once it is green in CI and the owner merges `develop` into `main`.

## M4 — Editing content  (→ 0.4, internal) — **done 2026-09-28**

Engine hosting moved to our own PDFium worker with guarded raw access (ADR-0011); the
viewer's PDFium worker chunk shrank from 1.7 MB to 1 MB.

| Feature | Engine | Notes | Status |
|---|---|---|---|
| Redaction marks: by selection, word, area, search hits, sensitive-data finder (e-mail, phone, IBAN, TCKN, cards, dates) | P | standard `/Redact` annotations through the edit runner; Redactions panel with snippets, review (J/K), honesty text | done |
| Apply redactions: engine pass + path/image removal + scrub + blank-region gate + fill + forensic self-check | P + L + raw | runs on private scratch documents; fails closed with reports; strings scrubbed document-wide (area-only option); attachments removed unless kept and then reported unverified; export re-checks the exact final bytes and blocks the download on any finding | done (no pre-apply tinting of graphics to be removed; overlay text drawn by pdf-lib; JBIG2/CCITT/JPX streams listed as not searched) |
| Text editing, tier 2 (same font, verified) and tier 1 (bundled subset font) | raw | split text object, dry-run read-back, fallback with honesty state; fit: keep, shrink to 75%, overflow; undo = reopen + replay; export renames subset fonts, repairs MCIDs and drops orphaned streams | done (one run = one text object per line; forms are tier 1 with the text moved to page level; Type3, paths, invisible and vertical text refused) |
| Image objects: move, resize, replace, extract | raw | handles, nudge, PNG/JPEG/WebP replace, JPEG pass-through on extract; transforms invertible, remove/replace replay-required | done (in-form images are moved to page level on transform/replace; replace drops the old object's clip and graphics state) |
| Crop with "remove content outside the crop" | model + P | margins, presets, draggable preview, Draw crop area in Read mode; discard runs the redaction pipeline with white fill in the same history entry; shared source pages remove only content hidden everywhere | done (no trim-to-content; content outside the source's own CropBox stays) |
| Page resize with annotation transforms | model + L | scale/fit/canvas, nine anchors, stretch; annotations, widgets, link and outline destinations transformed; verification checks annotations stay on the page | done (NoZoom icons keep their size; border widths and /DA font sizes not scaled) |
| Form field creation | model + L | seven kinds, live widgets, properties popover, tab order, AcroForm materialisation with the existing name policies, flatten, verification | done (`/Tabs` not written; push buttons have no actions; duplicated pages get no fields) |
| Outline editor | model + L | add at current view, rename, delete, move, indent/outdent, drag, open state, dead-link cleanup | done (no generate-from-headings; /XYZ navigation approximate) |

Known behaviours and follow-ups from the workstreams:

- The signature-field reader marks unsigned `/Sig` placeholders as signed after re-open
  (`listFormFields` pairs every `/Sig` field with PDFium's signature list).
- Edited lines become several runs; a later edit works on one run.
- `checkEditability` runs outside the edit queue; a race with a reopen only shows an error.
- Text edits refuse, with a shown reason, text in a form drawn more than once, text whose
  clip an edit would break, and encodings that cannot be read back; tier 2 refuses
  characters with more than one code in the font.
- The redaction content-text check does not decode custom font encodings inside streams
  that are never drawn; page text is covered by the extraction checks.

Exit: the independent correctness review (engine: 1 blocker, 5 major, 5 minor; web: 5
major, 8 minor) is resolved with regression tests (24 findings, 9 fix commits); the
blank-Read-view bug found on the way is fixed; docs and changesets current (relabelled
0.4, unpublished).

## M5 — Recognize and compare  (→ 0.5, internal) — **done 2026-09-28**

Spec: `docs/specs/recognize-and-compare.md`; decisions in ADR-0012 (OCR hosting), ADR-0013
(signatures), ADR-0014 (recipes); spikes in research 07 (OCR) and 08 (signing). Two new
lazy workers beside PDFium: the signature worker (pkijs) and the analysis worker (compare,
Markdown); tesseract's own worker is served from our origin.

| Feature | Engine | Notes | Status |
|---|---|---|---|
| OCR to searchable PDF: nine language packs on demand, quality Standard / High, replace existing invisible text | tesseract.js + P + L (layer written in the PDFium worker) | scope defaults to pages without text; greyscale rasters in display orientation; glyphless Type0 font, one Form XObject per page, verified in a scratch document; quality Good ≥ 90 / Review 80–90 / Poor < 80; OCR panel with low-confidence rows (J/K, ring on the page); language manager with Keep available offline and local import; `ocr.apply` stores the words, replay never recognises again | done (Chromium-verified: 98% of words found, hit boxes within 2 pt, render pixel-identical, zero external requests, offline after keeping a pack; export verification re-reads every recognised word; a run recognises again the pages that changed under it) |
| Compare two documents: page map, side by side or onion skin, changed areas, changed words, heat map, Changes panel, report PDF | analysis worker (pixelmatch + jsdiff) + P (render, text) | third stage view (3); auto / by index / best match; 100 or 150 dpi; rows in view diffed first; read-only, released when the view is left or a tab closes | done |
| Digital signatures: status on open, Sign… on export | signature worker (pkijs + WebCrypto) + L (incremental update) | Intact / Intact but changed later / Changed after signing / Broken / Cannot check with the fixed honesty line; never "valid"; PAdES-B approval signature as the last export step; existing signatures stripped on rewrite and said so | done (document timestamps checked, no LTV; later revisions read through the xref chain and the signed pages compared visually; DocMDP, encrypted outputs and legacy 3DES/RC2 PKCS#12 refused with the re-export command) |
| PDF → Markdown / text | analysis worker | whole document, page or range; page breaks; running headers and footers dropped or kept; hyphens joined; images in a ZIP; preview with honesty notes; "OCR first" opens the OCR dialog | done (reading order is a heuristic; tables are not detected) |
| Batch: saved recipes over many files | model (`recipe.ts`) + export service | OPFS recipes, import/export, five built-ins, plan review, per-file results with the export summary's notes, ZIP / files / folder delivery, two files at a time; recipes never store a password | done (OCR and Markdown/text steps run; one file at a time while OCR is in the recipe; signed inputs are stripped and the notes say so) |

Known behaviours and follow-ups from the workstreams:

- Engine OCR tests run in Chromium only; the spec asks for Firefox and WebKit too.
- The language manager's switch means "on this device": the pack store cannot tell a pack
  kept offline from one cached on first use.
- Pure OCR helpers are reachable only through the engine's main index; the UI mirrors the
  language-code table for display names.
- Signature classification errs towards "Changed after signing" on nonconforming writers
  (bytes outside any xref, ambiguous duplicate entries); a later revision that restores
  the signed content byte for byte reads "Intact but changed later" with nothing listed.
  Objects of later revisions in encrypted files compare as changed (no decryption).
- The visual comparison of signed revisions renders every page once per signature at
  50 dpi; bounded and cancellable, redundant for many-signature files.
- Compare has no "the file as opened" side (spec §2.1); Esc in the Compare view first
  clears a leftover page selection.
- A resized page's OCR words are verified by text only at export (the visible-box origin is
  not in the model); OCR words on a source redacted afterwards are covered by the
  redaction self-check instead.

Exit: two independent correctness reviews (engine: 1 blocker, 3 major, 6 minor; web: 1
blocker, 4 major, 7 minor) and a second pass on the blocker fixes (1 blocker, 1 major, 3
minor, plus one bypass found while fixing) resolved in six fix commits with regression
tests and five new attack fixtures; docs and changesets current (relabelled 0.5,
unpublished; the first public release follows M7).

## M6 — Experience  (→ 1.0.0-beta.0 together with M7)

Owner review after M5 (`DISCUSSION.md` item 23): the features are right, the experience is
not. Too much is visible at once, nobody can find Merge, and the pen interrupts writing.
Spec: `docs/specs/experience-redesign.md`; evidence: `docs/design/experience-audit-2026-10.md`.

| Feature | Notes | Status |
|---|---|---|
| Home view | open files as cards, multi-select, Combine N files, drag a card onto another to merge; the empty state is the same view with honest text | planned |
| Navigator with four labelled tabs | Pages (with Bookmarks), Find, Review (comments, redaction marks, form fields in one list), Files; content first, settings folded; inspector closed by default, metadata in a Document info sheet | planned |
| Task-grouped toolbar | about six labelled groups (Read, Mark up, Draw, Fill & sign, Pages, Redact); a group shows its 3–6 tools; options live with the armed tool; Document menu with sections and Merge, Split, Compare, Rotate | planned |
| Natural pen | creating a stroke never selects it; a compact pen bar with four presets that persist; strokes in a burst become one Ink annotation (one comment row, one undo step); lasso to recolour, resize, move or delete; coalesced pointer events, live smoothed preview, width from pressure or speed, fingers scroll when a pen is present | planned (spike S1 first: variable-width appearance across viewers; constant width stays in the Ink dictionary) |
| Merge discoverability and wording | Home actions, Document menu, Arrange shows every open document, palette synonyms in English and Turkish, "Ink" becomes "Pen", the two "Sign" features get distinct names | planned |
| Visual refresh | surface ladder with measured contrast, livelier glass with one elevation shadow for floating chrome, capsule toolbar with a solid accent for the active tool, pen presets as ink dots, rise-in motion honouring reduced motion | planned (DESIGN.md amendments listed in the spec) |

Exit: a new user merges two dropped files in under five actions (e2e); writing with the
pen never opens a bar or selects the stroke (e2e with synthetic pointer events and
pressure); the navigator has four tabs with counts; every surface in the visual refresh
passes the contrast checks recorded in the spec; screenshots and `docs/DESIGN.md` updated;
an independent experience review on the live build.

## M7 — Presentation and public beta  (→ 1.0.0-beta.0)

Spec: `docs/specs/presentation.md`; decisions: ADR-0015 (name: Recto), ADR-0016 (addresses
and migration), ADR-0017 (versioning and releases).

| Item | Notes | Status |
|---|---|---|
| Name and addresses | display name Recto, descriptor "Recto PDF"; repository `recto`, app at `erendenizk.github.io/recto/` (GitHub Pages only for now, owner decision 2026-10-01), redirect pages and a kill-switch worker at `/pdf-editor/` in the portfolio repository; storage names unchanged; a custom domain later follows ADR-0016 | planned (owner: trademark check) |
| README and media | thesis, hero, four GIFs (Arrange, Redact, OCR, Compare), feature table, "Check it yourself", worker diagram, limits; media produced by Playwright screencasts and ffmpeg in a deploy job, served from the site, zipped onto releases; fictional demo documents | planned |
| About page and metadata | `/about/` as a second entry with no app bundle; "About this app" in the menu; repository description, topics, social preview | planned |
| Release mechanics | Changesets pre-release mode, `v1.0.0-beta.0` tag, GitHub pre-release with notes and a dist zip with SHA-256 | planned |

Exit: the live site answers at the new address with the old one redirecting; README
renders with every image under budget; the About page passes its size budget; the
`v1.0.0-beta.0` release exists with notes.

## Exit criteria for 1.0 (ADR-0017)

- Every v1.0 success criterion in `VISION.md` passes as an automated test on Chromium,
  Firefox and WebKit.
- Final name and domain in place; load time and the zero-external-requests budget measured
  in CI.
- Stored formats (recipes, settings, caches) versioned with migration tests.
- At least four weeks and two betas without an open blocker or major bug; the known-issues
  list fixed or documented.
- Accessibility pass; complete English and Turkish; documentation current; an independent
  review of the beta.

## M8 — Ecosystem  (→ 2.0)

- Light theme on the same tokens (moved from M6 on 2026-10-01).
- Plugin API for tools.
- Optional Tauri desktop shell with file associations.
- Browser extension "open with".
- Touch-optimized interaction for tablets.
- Annotation set export/import as files.
- Text editing tier 3: paragraph re-typesetting with embedded substitute fonts.

## Explicitly deferred or declined

- Office ↔ PDF conversion (fidelity), PDF/A claims (no validator), cloud collaboration,
  any hosted or metered service, any telemetry.
