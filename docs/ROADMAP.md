# Roadmap

**Status:** revised 2026-10-03 after the owner's review of the beta (M8 added as Craft; the
former M8 is now M9, tablets M10); M8 built 2026-10-04. Milestones are ordered by
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

## M6 — Experience  (→ 1.0.0-beta.0 together with M7) — **done 2026-10-01**

Owner review after M5 (`DISCUSSION.md` item 23): the features are right, the experience is
not. Too much is visible at once, nobody can find Merge, and the pen interrupts writing.
Spec: `docs/specs/experience-redesign.md`; evidence: `docs/design/experience-audit-2026-10.md`
(with an "After M6" section); decisions in ADR-0018 (variable-width ink) and research 09
(the ink appearance spike); design rules in `docs/DESIGN.md` §2–§4 (amendments A1–A6) and
`docs/specs/viewer-annotations.md` (A7).

| Feature | Notes | Status |
|---|---|---|
| Home view | open files as cards, multi-select, Combine N files, drag a card onto another to merge; the empty state is the same view with honest text | done (from an empty app, drop two files, "Combine 2 files", "Merge": one document with every page in Read in 3 counted actions, e2e; a card dropped on another opens the merge dialog as [target, dragged]; nothing merges without the dialog) |
| Navigator with four labelled tabs | Pages (with Bookmarks), Find, Review (comments, redaction marks, form fields in one list), Files; content first, settings folded; inspector closed by default, metadata in a Document info sheet | done (four tabs with counts in their names, e.g. "Pages, 6 items"; Compare's Changes tab only in Compare, last; the inspector closed on first run and remembered once opened, e2e; the comment author asked once, inline) |
| Task-grouped toolbar | about six labelled groups (Read, Mark up, Draw, Fill & sign, Pages, Redact); a group shows its 3–6 tools; options live with the armed tool; Document menu with sections and Merge, Split, Compare, Rotate | done (six groups; the capsule morphs in place in one 160 ms movement, none under reduced motion; options in a tier attached to the bar; each shortcut arms its tool and shows its group, e2e; Document menu in five sections with no disabled twins) |
| Natural pen | creating a stroke never selects it; a compact pen bar with four presets that persist; strokes in a burst become one Ink annotation (one comment row, one undo step); lasso to recolour, resize, move or delete; coalesced pointer events, live smoothed preview, width from pressure or speed, fingers scroll when a pen is present | done (no bar and no selection at any time while writing, e2e with a MutationObserver from the first stroke; the preview stays until the committed stroke is painted; presets survive a reload; bursts of N = 1.5 s and D = 36 pt, at most 64 paths: three strokes are one Ink, one Review row "Pen · 3 strokes", one undo; the lasso takes every path it touches and splits edited paths into a new Ink in the same history entry; a pen stroke with force 0.2 → 1.0 is thinner at its start, written into our appearance with a constant `/BS /W` after S1 passed, both matrix rows ok in PDFium and pdf.js; after a pen, a finger drag scrolls and draws nothing) |
| Merge discoverability and wording | Home actions, Document menu, Arrange shows every open document, palette synonyms in English and Turkish, "Ink" becomes "Pen", the two "Sign" features get distinct names | done (Merge from Home, the Document menu, the tab menus and the palette; "draw", "kalem", "ciz", "birlestir" and "sertifika" list the right command first, e2e; Pen, Signature image, Sign with certificate…) |
| Visual refresh | surface ladder with measured contrast, livelier glass with one elevation shadow for floating chrome, capsule toolbar with a solid accent for the active tool, pen presets as ink dots, rise-in motion honouring reduced motion | done (canvas → panel 1.05:1 → 1.14:1; glass over the canvas 1.03:1 → 1.27:1; the armed tool 1.24:1 → 3.43:1 against the bar over a white page, 5.28:1 over the canvas; text on glass stays AA over every measured backdrop, minimum 4.51:1; `tokens.test.ts` asserts each ratio; measurements in `docs/design/audit-2026-10/V1-RESULTS.md`) |

Known behaviours and follow-ups from the workstreams:

- Home has no per-card ⋯ menu (Combine with…, Document info…), no reordering of cards by
  drag and no recent files; the card's size is the file's size as opened. The Files tab
  shares Home's selection with Combine and Show Home (review fix).
- Compare still has no "the file as opened" side (as in M5).
- Bursts' N (1.5 s), D (36 pt horizontally) and the line rule (bands overlapping by 30 %
  or a gap under 0.6 of the burst's median stroke height) are reasoned defaults; they are
  still to be tried on a real tablet with the owner. Both numbers are overridable in the
  stored pen settings, with no UI. Inside an open burst, undo removes one stroke.
- Variable width lives in our appearance stream; `/InkList` keeps the centre lines and
  `/BS /W` the nominal width, so a viewer that redraws ink itself (an editor rebuilding
  the appearance) shows one width. The pen's options tier says so in one honesty line,
  and the tier stays hidden until a pen has reported pressure in the session.
- A page resize scales the stored ink widths by the geometric mean of the scale (review
  fix); an ink that loses its widths keeps an empty `/PdfEditorInkWidths` key, read as
  "no widths".
- Clicking the armed preset while its tooltip is showing does not open the editor
  (keyboard and quick clicks do); a pre-existing tooltip interaction, listed for P2's
  follow-up.
- The bytes of a plain `save()` keep the replaced ink appearance streams until export,
  which rewrites the file.
- The §11 visual baselines (`visual.spec.ts`) are not in the suite, and the no-blink
  check is a component test (`annotations/writing.test.tsx`), not the frame-sampling e2e
  the spec describes.

Exit: the independent review on the live build (no blocker; 3 major correctness findings
on lasso and selection width changes and self-selecting redaction marks, 4 minor, and five
experience gaps) and the accessibility pass (F6 regions, roving tabindex everywhere, joined
announcements, zero axe violations on every state) are resolved in one fix commit with
regression tests; the merge, pen, navigator and contrast criteria pass as recorded above;
`docs/DESIGN.md` and the screenshots are current. **Done 2026-10-01**, pending the owner's
tablet try-out of the burst defaults.

## M7 — Presentation and public beta  (→ 1.0.0-beta.0) — **built 2026-10-01, release pending the owner's steps**

Spec: `docs/specs/presentation.md`; decisions: ADR-0015 (name: Recto), ADR-0016 (addresses
and migration), ADR-0017 (versioning and releases).

| Item | Notes | Status |
|---|---|---|
| Name and addresses | display name Recto, descriptor "Recto PDF"; repository `recto`, app at `erendenizk.github.io/recto/` (GitHub Pages only for now, owner decision 2026-10-01), redirect pages and a kill-switch worker at `/pdf-editor/` in the portfolio repository; storage names unchanged; a custom domain later follows ADR-0016 | done in the repository (the redirect folder and kill-switch worker in `tools/portfolio-redirect/` with an end-to-end hand-over test; the rename pass with a unit test that the storage names of ADR-0015 §3 are unchanged). Owner steps: create `ErenDenizK.github.io` with the folder, rename the repository, then remove the temporary lychee exclusions; trademark check |
| README and media | thesis, hero, four GIFs (Arrange, Redact, OCR, Compare), feature table, "Check it yourself", worker diagram, limits; media produced by Playwright screencasts and ffmpeg in a deploy job, served from the site, zipped onto releases; fictional demo documents | done (fictional demo documents in `test/fixtures/demo/` with a `--check` mode; the media tool in `tools/media/` with nine scenes, the social image, budgets, a request log and the spike in research 10; the README rewritten with evidence links; the copy check and lychee in CI's `docs` job; the deploy workflow's `media` job) |
| About page and metadata | `/about/` as a second entry with no app bundle; "About this app" in the menu; repository description, topics, social preview | done in the repository (`/about/` with its budget test; "About this app" in the Document menu and the palette; Open Graph tags). Owner steps: repository description, topics and the social preview upload (spec §4) |
| Release mechanics | Changesets pre-release mode, `v1.0.0-beta.0` tag, GitHub pre-release with notes and a dist zip with SHA-256 | prepared (the in-app About dialog with version, commit, build date and "Public beta"; `release.yml` with the notes template `.github/release-notes.md`; pre mode entered and the packages versioned `1.0.0-beta.0` on `develop`). Remaining: the release pull request `develop` → `main`, whose merge tags `v1.0.0-beta.0` and publishes the pre-release |

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

## M8 — Craft  (→ 1.0.0-beta.1 and beta.2, tagged only when the owner says so) — **built 2026-10-04; drop 1 and drop 2 built, tagging waits for the owner**

Owner review of the beta (`docs/DISCUSSION.md` #28, 2026-10-03): every feature exists and
works, but the experience is raw. Text editing feels like a patch and hides under "Pages";
the pen is slightly laggy and sticky with a mouse; Draw and Mark up both have a highlighter;
the lasso ignores arrows; colours look unclean; Home · Read · Arrange is the wrong top-level
model; glass should go wider but never opaque. Spec: `docs/specs/craft.md` (what each work
package delivered is in its §15); decisions: ADR-0019 (modes), ADR-0020 (paragraph editing
tiers), ADR-0021 (one Highlighter, lasso for every kind, one palette); research 11
(paragraph editing in PDF), 12 (low-latency ink), 13 (glass and modes), 14 (the glass spike);
audits summarised in the spec's §1.2; design rules in `docs/DESIGN.md` §2–§5 (amendments
A8–A14, A15 as a trial) and §9. Approved by the owner on 2026-10-03 with Tier C dropped; the
drops below are planning units and the owner decides when a drop is tagged as a beta.

Latency figures come from `apps/web/e2e/ink-latency.spec.ts` on a shared 4-core container
in headless Chromium, under a load average of 9–15 unless stated, so they are upper bounds;
the baseline and every step are in `docs/qa/ink-latency-baseline.md`.

| Feature | Engine | Notes | Status |
|---|---|---|---|
| Home as a view; documents in Read (locked) ⇄ Edit; Arrange as a view; keys 0–4; Edit bar with five groups (Select · Write · Text · Fill & sign · Redact) | own | per-document mode flag; the bar collapses to one Edit button in Read; "Switch to Edit to fill" on fields; a text selection bar and a page context menu; Recents on Home with file handles where the browser keeps them (P2, moved in from M9) | done (drop 1; Recents drop 2): a file opens in Read with the lock and a one-button bar; in Read a drag neither selects nor moves, Delete does nothing, a tool key switches to Edit and arms the tool with "Edit mode. …" and creates nothing, a field click shows the notice and its Edit button fills; `0` then a tab click lands in the document's last mode (e2e `modes.spec.ts`); the bar walks five groups and the page menu by keyboard (e2e `tools.spec.ts`, `a11y.spec.ts`); a closed file is remembered across a reload, opened again and cleared (e2e `home.spec.ts`) |
| Edit-mode interaction policy: only the armed tool creates; double-click on page text opens the paragraph editor (mouse or pen-as-pointer only); idle hover outline with a one-time hint; the pen never hit-tests text; one hit order across layers | own | ADR-0019 §5–§6; `viewer/hit-order.ts` | done (drop 1): a double-click opens the paragraph editor in Edit and selects a word in Read; a pen stroke over text writes ink and never opens the editor, Select stays armed (e2e `modes.spec.ts`); the outline after 400 ms, never from touch or within 300 ms of a pen lift; eraser end, barrel lasso and Space pan (`viewer/edit-policy.test.tsx`) |
| Pen smoothness: measurement harness, constant-width mouse, one smoothed stroke model for preview and commit, own prediction, round joins, bake-once stable layer, dot cursor, no debounce on edit repaints | own | targets: ≤ 1 frame pointer-to-preview, committed stroke visible ≤ 50 ms after pen-up with no change of shape, no long task in a 64-path burst | done (drop 1): the committed outline lies within 0.5 device px of the last preview frame for a recorded mouse stroke (`apps/web/src/annotations/pen/ink-input.test.ts`); preview draw p95 0.3–1.0 ms, flat to 5,000 points; the release redraw of a 5,000-sample stroke 19 → 2–11 ms; mouse committed visible p50 231 → 77–140 ms before the dry layer (next row). Not met on this machine: event-to-draw p95 11–18 ms against ≤ 4 ms (the draw waits for the next frame) |
| Dry ink layer with deferred page re-render; cheaper bursts (cached outlines, fewer worker round trips); clip repaints; `pointerrawupdate` and the Windows Ink API where the harness shows presentation latency | own + P | research 12 §5–§7 | done (drop 2) except `pointerrawupdate` and the Ink API (P14, not started: the harness did not show presentation latency as the bottleneck): committed stroke visible p95 26–34 ms for mouse strokes and 21–39 ms in a 64-stroke pen burst (target ≤ 50 ms; baseline 520–640 ms and 1.8–3.9 s); long entries over 50 ms in the burst 15–51 → 4–5 (target none); `listAnnotations` per 12-stroke burst 34 → 1; an append at 64 paths 25–32 → 6–7 ms; the stroke's box re-renders in 0.3 ms instead of 16.5–19 ms for the page; page bitmap settled p95 162–163 ms (burst) and 120–177 ms (mouse) |
| One Highlighter (constant width, Multiply, snaps to text as a Highlight annotation, Alt for free ink); lasso for every annotation kind with mixed selection and group edits; partial eraser | P + own | ADR-0021; group resize and rotate (P12) and hold to straighten (P13) | done (drop 1; partial eraser drop 2): H, then a stroke along a line gives one Highlight and "Highlighted 1 line on page 1", a stroke on paper a `#FFEA00` Multiply ink (e2e `pen.spec.ts`, `a11y.spec.ts`; the matrix row "Ink, Multiply (free highlighter)" ok in PDFium and pdf.js); a stroke, an arrow and a note recoloured, moved or deleted in one history entry (`lasso/edits.test.ts`); a corner handle grows two lassoed strokes about the opposite corner; a Partial erase through a stroke leaves two pieces and one undo restores; a pause while drawing commits a two-point line (e2e `pen.spec.ts`) |
| One palette for presets and swatches (eight inks in two lightness bands, four Multiply highlighter tints), contrast asserted; accent unchanged, vividness through content colour and state alphas | own | ADR-0021 §3–§4 | done (drop 1) except two parts: one module (`annotations/palette.ts`) with every ratio asserted (`palette.test.ts`); presets and tool styles migrate `v1` → `v2`; a default colour never shows as "custom". Tag dots at full chroma and the raised accent alphas were not done |
| Text editing speed-ups: analysis cached per page, pure maths per keystroke, dry run on pause and commit, caret at the click, free space bounded by the column, no render-priority slot held | raw | audit items 1, 2, 10, 12, 13 | done (drop 1): engine calls while typing five keys 5 → 0, then one dry run after a 300 ms pause; per-keystroke arithmetic about 0.002 ms; the analysis about 66 ms once per run and revision (`text-edit/TextEditor.test.tsx`, `packages/engine/src/text-edit/analysis.test.ts`) |
| Paragraph editor (Tier B): structure tree first, geometry fallback, style spans, rewrap from the edit point, original font with per-glyph bundled substitutes and one honesty line, overflow policy (grow into the gap, tighten spacing within floors, run over with a warning), glyph-path canvas overlay with a deferred exact preview, corpus with golden read-backs | raw + own | ADR-0020; Tier C (same-page push-down) and Tier D (cross-page reflow) declined by the owner; Noto Sans Regular bundled | done (drop 2): corpus goldens on six fixtures (`packages/engine/src/text-edit/corpus-goldens.test.ts`, 13 tests): exact read-back, untouched glyphs within 0.01 pt, zero pixels changed outside the paragraph, keystroke layout median 0.0–0.4 ms (budget 4 ms); replay byte-identical; e2e: type into a paragraph, preview, one history entry, export and re-open, and ‘ğ’ named as Noto Sans (`paragraph-edit.spec.ts`, `text-edit.spec.ts`). The corpus has no real Word or LibreOffice export |
| Glass spike S2 and the "Glass panels" setting: stage full-bleed under the chrome, three glass tiers, docked tier composites to `--surface-1` over the canvas, in-app Reduce transparency; fps, GPU memory and contrast measured | own | DESIGN §2 changes only if S2 passes and the owner likes the live build | built behind the setting, default off (drop 1); S2 pending: contrast final for the three tiers over white, the canvas, `#808080` and black (`styles/tokens.test.ts`); frame rate, GPU memory and legibility wait for the owner's machine (`docs/research/14-glass-spike.md`); a headless CPU trend shows the blur costing two to four times the median frame |

Accessibility (craft §9): one keyboard target per paragraph with Edit text armed, lasso
handles with 24 px hit areas, the Highlighter's line count announced, mode announcements only
on change; axe passes on every new state in English and Turkish, with Glass panels on and
with Reduce transparency (e2e `a11y.spec.ts`). Tests on the final M8 tree (`45e7a35`): the full
Chromium end-to-end suite passed 129 with 9 skipped by their own gates, the engine unit suite
809 and the web unit suite 1,388; CI runs Firefox and WebKit as well.

Known behaviours and follow-ups from the workstreams:

- Latency: no quiet-machine or CI baseline yet; event-to-draw p95 (11–18 ms) and 4–5 long
  entries per 64-stroke burst miss their targets on the loaded container; a 5,000-sample
  stroke shows its committed shape after 165–229 ms (the release task's smoothing); at
  tiled zoom, tiles re-render on every revision instead of waiting with the dry layer.
- Paragraph editor: the plate under rewritten lines is page white, so a coloured box shows
  white until the preview settles (about 300 ms); "Join with next" and "Split here" are
  shown but unavailable; the IME candidate window opens at the hidden mirror, not at the
  drawn caret; an arrow typed into a serif paragraph is refused although Inter has it; a
  full (non-subset) embedded font can get a false honesty line; a shortening edit after a
  hyphenated line end in a TeX-justified paragraph can leave the previous line ragged;
  ligatures are written as two glyphs; rotated pages are covered by one e2e test only.
- Policy: in Select a plain press on a markup over a form field reaches the field (the hit
  order decides double-click and hover only); annotations are not dimmed under Edit text;
  a pen's very first press, before any hover, acts as a pointer once; with the Highlighter
  armed, a pen in Select draws with the first pen; the Forms panel's Add field and Clear
  buttons still show in Read, doing nothing; a note click in Read opens no read-only popover;
  the one-line editor's header can sit under the title bar near the top of the free
  rectangle.
- Lasso and eraser: stamps keep their orientation under rotation (needs an appearance
  `/Matrix`); line and shape stroke widths do not scale with a resize; no erase filter for
  highlighter strokes (they erase whole) and no live cut preview while erasing.
- Palette: tag dots and accent alphas unchanged (above); the redaction mark outline
  (`#E53935`) and the signature ink (`#1A237E`) sit outside the palette, and a redaction
  mark's black fill shows as "custom".
- Glass: the 80 px gate opens at fit width, so with Glass panels on all four surfaces blur
  whenever pages are beside them; gating on "a page under the surface" is the first lever if
  S2 fails narrowly.
- `4` still announces when pressed in Compare; Compare's second file is not recorded in
  Recents; `text-edit/TextEditor.test.tsx`'s timing test fails under heavy load and passes
  alone.

Exit: met in the repository: the corpus passes its golden read-backs; the interaction-policy
table of craft §3.5 is covered by e2e (`modes.spec.ts`, `tools.spec.ts`, `a11y.spec.ts`)
and component tests; contrast tests pass for the palette and the three glass tiers; the
committed-stroke and preview targets are met on the container, the event-to-draw and
long-task targets are not. Waiting for the owner: the latency check on their laptop and the
pen try-out with a mouse and a tablet; the S2 glass measurements and an opinion on Glass
panels; the independent review on the live build, which has still to run. Drop 1 and drop 2
built; tagging waits for the owner.

## M9 — Ecosystem  (→ 2.0)

- Light theme on the same tokens (moved from M6 on 2026-10-01).
- Plugin API for tools.
- Optional Tauri desktop shell with file associations.
- Browser extension "open with".
- Annotation set export/import as files.

## M10 — Tablet and phone

After the desktop experience is excellent (owner decision, 2026-10-03). Touch targets ≥ 44 px
under `pointer: coarse`, safe-area insets and `viewport-fit=cover`, breakpoints for the
navigator and the bar (docked at the bottom), touch drag-and-drop on Home and Arrange, the
pen and finger policy on every layer, gestures in place of single-letter shortcuts, and
the burst defaults confirmed on a real tablet.

## Explicitly deferred or declined

- Office ↔ PDF conversion (fidelity), PDF/A claims (no validator), cloud collaboration,
  any hosted or metered service, any telemetry.
