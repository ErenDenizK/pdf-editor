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

## 3. Also in M4

Image objects (move, resize, replace, extract), crop with "crop and discard content" via
redaction, page resize with annotation transforms, form field creation, outline editor.

## 4. Out of scope

OCR (M5), paragraph reflow (M6), redaction of audio/video/3D content.
