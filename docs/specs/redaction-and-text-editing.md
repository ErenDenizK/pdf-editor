# Spec: Redaction and text editing (M4)

**Status:** draft (2026-09-27) · **Milestone:** M4 (v1.x) · **Owner:** project lead

These two features carry the highest correctness risk in the product. A redaction that
leaves text recoverable, or a text edit that silently reflows a page, is worse than not
having the feature. Both ship behind explicit honesty states and a forensic self-check.

## 1. Redaction

### 1.1 Marking

- Tool: Redact (X). Mark by text selection (quads), by dragging a rectangle (area), or by
  search ("Mark all matches" from the Search panel, with a review list). Marks are
  standard `/Redact` annotations (`/QuadPoints`, `/IC`, optional `/OverlayText`) so the
  document can be saved with pending marks and reviewed in any viewer.
- Marks are listed in a **Redactions panel** with page, snippet of the covered text (from
  the text layer), and a checkbox; keyboard review (J/K) jumps between marks.
- Pattern helpers (offline, no network): e-mail addresses, phone numbers, IBAN, Turkish
  national id (TCKN, with checksum), credit-card numbers (Luhn), dates. Each helper shows
  its matches for review; nothing is applied automatically.

### 1.2 Applying

"Apply redactions" is a destructive engine operation on the source (PDFium
`redactTextInQuads` / `applyAllRedactions` in the EmbedPDF fork) followed by our own
pass, and it forces a **full rewrite with garbage collection** at export:

1. Text glyphs under the area removed from page content streams and Form XObjects
   (TJ runs split); vector paths clipped or removed; image pixels under the area
   overwritten (image re-encoded) or the image removed when it is fully covered; inline
   images handled the same way.
2. Annotations intersecting the area deleted (including popups and their parents);
   form field values inside the area cleared; link annotations removed.
3. Document-level scrub of the covered text: outline titles, `/ActualText` and `/Alt` in
   the structure tree, `/Dests` names, XMP and Info fields, page `/Thumb`.
4. Fill drawn in the area (black by default, configurable; optional overlay text such as
   "REDACTED").
5. **Forensic self-check** before download: re-open the output, extract text within every
   applied area (must be empty), search the whole output for every redacted string
   (must be absent, including in metadata and attachments), raw-byte grep after
   inflating all streams, and confirm no incremental update chain remains (`/Prev`
   absent). Any hit blocks the export with a precise message.
6. Export summary lists applied redactions per page and the self-check results.

Honesty: the panel states that redaction is irreversible after export, that pending marks
are only marks, and lists what the self-check verified.

### 1.3 Tests

Fixture corpus additions: text spanning multiple TJ arrays under one area, text inside a
Form XObject, an image partially and fully covered, an inline image, a link and a note
inside the area, a bookmark whose title contains the redacted word, `/ActualText` with
the word, and a file with an incremental-update history containing the word. Golden
tests assert every channel is clean.

### 1.4 Decisions after the spike (`docs/research/06-redaction-spike.md`)

- **Engine scope.** EmbedPDF 2.15.1 removes text (whole glyphs, across TJ arrays and
  text objects, inside Form XObjects, invisible text), inline images and image pixels
  under the area. Everything else is ours: vector paths, annotations and widgets in the
  area, form values, outline titles, Info, XMP, named destinations, attachments,
  `/ActualText` and `/Alt` outside the redacted element, and garbage collection (a second
  apply leaves an unreachable stream with the old text; `dropUnreachable` is mandatory).
- **Vector paths: remove if touched.** Any path object whose bounds intersect an area is
  removed (MuPDF's `REMOVE_IF_TOUCHED`), because a clipped stroke can still leak shape.
  The pre-apply review renders the page with the doomed graphics tinted so the user sees
  what a large table border or signature stroke will cost before applying. Clipping with
  an even-odd clip path is a follow-up if PDFium's clip API allows it.
- **Tagged PDF: prune, do not untag.** Structure elements whose marked content was removed
  lose `/ActualText`, `/Alt` and their dangling `/K` references; the tree stays. If the
  pruned tree fails our own validation, the whole structure tree is removed and the export
  summary says the file is no longer tagged.
- **Attachments: removed by default.** Embedded files and FileAttachment annotations
  cannot be searched reliably (binary, compressed), so applying redactions removes them
  all unless the user unticks "Remove attachments"; keeping them is listed in the export
  summary as unverified.
- **Fill and overlay text are drawn by us** (pdf-lib pass) since the engine ignores
  `drawBlackBoxes` and `/OverlayText`; the engine applies with no fill.
- **Rotated pages.** Areas are converted to unrotated user space before the engine call
  (`coords.userToDeviceRect`); a test per rotation guards it.
- **Self-check** is exactly the list in §1.2 step 5 plus: no unreachable objects, no
  annotation left in any area, area pixels equal the fill colour, and hex-encoded string
  variants in the byte grep (PDFium writes text as hex).

## 2. Text editing

### 2.1 Tiers (docs/research/04 §5)

- **Tier 1 — Cover and replace, honestly.** Select a text run; the original glyphs are
  removed from the content stream (not painted over), the area is filled with the page
  background colour sampled from the render, and the new text is typeset with an
  embedded bundled font (or the original font when Tier 2 applies). The result is
  labelled in the history and the export summary as "text replaced (font substituted)".
- **Tier 2 — In-place edit with verification.** When the run's font is embedded and
  contains glyphs and widths for every new character, edit the run in place (PDFium
  text object edit), then read back the glyphs, widths and Unicode mapping and compare;
  on any mismatch fall back to Tier 1 automatically and tell the user.
- **Tier 3 (research, M6)** — paragraph re-typesetting.

### 2.2 Interaction

- Tool: Edit text (E). Hover highlights editable runs (per line); click opens an inline
  editor sized to the run, showing the font name, whether it is embedded, and the
  honesty state ("same font", "font substituted: Inter"). Enter commits, Esc cancels.
- Only single lines are editable in M4; the editor prevents overflow beyond the line box
  and warns when the new text is wider than the original (option: shrink to fit down to
  90%, or allow overflow).
- Rotated pages and text inside Form XObjects are supported for Tier 1; text drawn as
  paths and Type3 fonts are marked not editable.
- Every edit is one history entry through the edit runner with an exact inverse
  (original content stream segment restored).

### 2.3 Fonts

Bundled Inter, JetBrains Mono and Noto Serif subsets (from M3) plus Noto Sans for wider
Unicode coverage; family matched by name heuristics (serif/sans/mono, weight, italic);
Local Font Access (Chromium) offered as an opt-in to use an installed font that matches
the original name, with the file embedded as a subset.

### 2.4 Tests

Golden tests per tier on fixtures with WinAnsi, Identity-H CID fonts with and without
missing glyphs, subset fonts, rotated pages, and text in Form XObjects: the original text
must not be extractable after a Tier 1 edit, the new text must be extractable, glyph
boxes must lie within the original line box, and undo must restore the original bytes
of the content stream segment.

### 2.5 Decisions after the spike (`docs/research/05-text-editing-spike.md`, ADR-0011)

- **Mechanism.** Both tiers split the text object around the selected characters and
  keep the untouched glyphs in place (drift under 1e-4 pt). Whole-object
  `FPDFText_SetText` is never used: it drops kerning and accepts missing glyphs silently.
- **Tier 2 verification.** Every non-space character needs a glyph path in the original
  font before the edit; after it, a fresh text page must read back the exact replacement
  with widths from the font. Any miss falls back to tier 1 and the history label says so.
  Tier 2 is allowed for non-embedded standard-14 fonts within WinAnsi (verified the same
  way; honesty state "same font, not embedded").
- **Tier 1 font.** A fontkit subset of the bundled face (Inter, JetBrains Mono, Noto Serif,
  Noto Sans) loaded with `FPDFText_LoadCidType2Font` (about 2 KB per edit). The export
  post-pass renames the font from `/Untitled` to a tagged subset name.
- **Not editable in M4:** Type3 fonts, text drawn as paths, invisible (render mode 3) text
  such as OCR layers, vertical writing. **Forms:** tier 1 only; the replacement is written
  at page level, and the honesty state says "moved out of form".
- **Fit.** Default keeps the font size and lets the new text use free space up to the
  next glyph on the line; beyond that the editor offers shrink to fit (floor 75%, not
  90%) or overflow with a warning. Width is measured with the real font metrics.
- **Undo** is reopen + replay of the edit list (no API restores a content stream);
  `text.edit` is recorded as a non-invertible `EngineEdit` and replay re-checks the run's
  text before applying.
- **Export** garbage-collects sources with text edits (ADR-0011 §5) and repairs tagged
  content: split runs get fresh MCIDs registered under the original structure element.
- **Cache.** After every raw edit the page is regenerated and dropped from the executor's
  cache; reads after an edit always use a fresh text page.

## 3. Also in M4

Image objects (move, resize, replace, extract), crop with "crop and discard content" via
redaction, page resize with annotation transforms, form field creation, outline editor.

## 4. Out of scope

OCR (M5), paragraph reflow (M6), redaction of audio/video/3D content.

## 5. Implementation plan

Started 2026-09-27. Two spikes run first because both features depend on engine
capabilities that EmbedPDF 2.15.1 only partly exposes:

- `docs/research/05-text-editing-spike.md`: whether a PDFium engine hosted in our own
  worker (direct `PdfiumEngine` + the raw wrapped module from `@embedpdf/pdfium`) gives us
  `FPDFText_GetTextObject` / `FPDFText_SetText` / `FPDFText_SetCharcodes` /
  `FPDFPage_GenerateContent` reliably enough for tiers 1 and 2, and what
  `GenerateContent` costs.
- `docs/research/06-redaction-spike.md`: which leak channels EmbedPDF's
  `redactTextInRects` / `applyRedaction` actually close, and what the pdf-lib post-pass
  and the forensic self-check must cover.

Their conclusions become ADR-0011 (engine hosting for M4) before implementation starts.

### 5.1 Workstreams and ownership

| # | Workstream | Owns | Depends on |
|---|---|---|---|
| E1 | Engine hosting: own PDFium worker, raw-module access, `PdfTextEditor` and `PdfRedactor` interfaces in `types.ts` | `packages/engine/src/pdfium/host/**`, `worker/**`, `types.ts` (additive) | spike 05 |
| E2 | Redaction pipeline: marks as `/Redact` annotations, apply (engine + pdf-lib scrub), forced full rewrite, forensic self-check, export summary data | `packages/engine/src/redaction/**`, `export-plan.ts` (additive), `pdflib/inspect.ts` (additive) | E1, spike 06, fixtures |
| E3 | Text editing engine: run location and editability report, tier 2 with read-back, tier 1 with glyph removal and bundled-font typesetting, inverse edits | `packages/engine/src/text-edit/**`, `fonts/**` (Noto Sans addition) | E1, spike 05, fixtures |
| F | Fixture corpus additions for §1.3 and §2.4 | `test/fixtures/**` | — |
| U1 | Redact tool, Redactions panel, pattern helpers, search integration, apply flow with honesty states | `apps/web/src/redaction/**`, `viewer/tool-store.ts` (additive), `shell/panels` (new panel), `messages/*.json` (new keys) | E2 API shape (can start on the mark side first) |
| U2 | Edit-text tool and inline editor with the honesty badge, overflow handling | `apps/web/src/text-edit/**`, `viewer/tool-store.ts` (additive), `messages/*.json` | E3 API shape |
| U3 | §3 items: image objects, crop and discard, page resize with annotation transforms, form field creation, outline editor | `apps/web/src/document/**`, `stage/**`, model ops as needed | E1 for image objects; rest independent |
| R | Independent correctness review of E2/E3/U1/U2, with the forensic corpus | read-only, findings as issues | all |

Rules as in earlier milestones: one agent per workstream, no edits outside the owned
paths, the lead integrates and commits, every finding of R is fixed with a regression
test before the milestone closes.

### 5.2 Order

1. Spikes 05 and 06, fixtures F (parallel; done before any product code).
2. ADR-0011; E1.
3. E2 and E3 in parallel with the mark-side of U1 (marks, panel, helpers) and the
   editability side of U2 (hover, run detection, badge).
4. Apply flows (U1 apply, U2 commit) once E2/E3 land; U3 in parallel.
5. R, fixes, docs, ROADMAP status, changeset (`minor`).

### 5.3 Acceptance (in addition to §1.3 and §2.4)

- Every fixture in F passes the forensic self-check after redaction, and the self-check
  catches a deliberately broken redaction (a test that skips the scrub must fail).
- A tier 2 edit that changes glyph widths or drops a character is detected by read-back
  and falls back to tier 1; the fallback is visible in the history label and the export
  summary.
- Export of a document with applied redactions never takes the incremental or
  byte-preserving path; the output has no `/Prev` and no unreferenced objects.
- e2e: mark by selection, by area and by pattern; apply; export; re-open the export in the
  app and search for the redacted string (must find nothing).
