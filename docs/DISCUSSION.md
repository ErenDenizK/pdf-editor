# Open decisions

**Status:** living document. Items are ordered by how much downstream work they block.
Each item states the options, a recommendation, and what changes if the owner disagrees.
When an item is settled it moves into the relevant ADR and is struck from here.

## 1. License: Apache-2.0 (recommended) or AGPL-3.0

- **Apache-2.0** keeps the whole permissive stack (ADR-0001/0002), maximizes adoption, and
  matches the "free open-source alternative" positioning. Costs: more of our own code for
  reconciliation and appearance edge cases; companies may fork without contributing back.
- **AGPL-3.0** unlocks MuPDF.js (single engine with redaction, appearance generation,
  journaling, repair, encryption) and blocks closed forks. Costs: many organizations will
  not run AGPL code in the browser; 10 MB WASM; the two biggest OSS PDF projects took
  community damage on license politics.
- If AGPL is chosen, ADR-0002 is rewritten around MuPDF.js + tesseract.js and the
  architecture becomes simpler (one engine, no pdf-lib assembly step).

## 2. Rendering: PDFium only (recommended) or pdf.js viewer + PDFium editor

- **PDFium only**: one engine, WYSIWYG for everything the engine writes, Chrome-grade
  fidelity, 2.15 MB gzip first-open download (cached afterwards). We build the text layer
  from glyph geometry.
- **pdf.js + PDFium**: 0.5 MB for a plain viewer, best-in-class DOM text layer and
  accessibility, but two renderers that can disagree and two sets of text-geometry code.
- Reversible later thanks to the interface layer, but it shapes M1/M2 effort.

## 3. Frontend: React 19 (recommended) or Svelte 5

Ecosystem and contributor pool vs raw update performance and bundle size. Neither is on
the hot path (canvases and workers are). Choose once; this is not cheap to reverse.

## 4. Product name and domain

The repository is `pdf-editor`. A product name is needed for the manifest, wordmark, tab
title and a custom domain (recommended before v1.0 to avoid shared-origin storage clashes
on `github.io`). Constraints: short, pronounceable, not "PDF-something-tools", trademark
searchable. Candidates to discuss: to be proposed in a separate note.

## 5. Scope of v1.0

The roadmap puts light table + export correctness (M1), viewer + annotations (M2), and
forms/numbering/watermark/metadata/passwords/compression (M3) before v1.0. Alternatives:
ship v1.0 after M1 (a superb merge/arrange tool, nothing else) and grow, or hold v1.0
until redaction and text editing (M4). Recommendation: v1.0 after M3; redaction and text
editing are v1.x because they carry the highest correctness risk and deserve their own
release cycle.

## 6. Text editing ambition

Tiers (see research 04 §5): (1) cover and remove glyphs, (2) verified in-place edits when
the embedded font has the glyphs, (3) paragraph re-typesetting with substitute fonts. Every
competitor that claims (3) breaks layouts silently. Recommendation: ship (1) and (2) with
explicit honesty states in v1.x; treat (3) as research for v2. Owner may want (3) earlier
because it is the most requested feature; then it needs dedicated time and a font strategy
(bundled open fonts plus Local Font Access where available).

## 7. Browser floor and mobile

Proposed: Chromium 125+, Firefox current + ESR, Safari 18+; desktop-first, tablet layouts
must not break, touch interaction optimized in M6. Alternative: touch-first from day one
(costlier light table).

## 8. Theme

Dark-only for v1 (recommended: focus, the design language is built for it) vs dark + light
at launch (more design work, doubles visual test surface). Light theme proposed for v1.x.

## 9. Language of the UI at launch

English first; Turkish as the second locale in M3 via Paraglide. Alternative: both from
M1 (small cost, forces i18n discipline early). Recommendation: both from M1.

## 10. Headless primitive library

Radix Primitives (mature, widely used) vs Base UI (newer, from the same authors plus MUI).
Evaluate both during M0 with a menu, dialog, tooltip and popover; pick one; record ADR-0007.

## 11. qpdf build strategy

Depend on an existing single-maintainer npm WASM wrapper (fast start, risk of staleness)
or build qpdf from source in CI (a day of work, full control, reproducible). Recommendation:
build in CI, in M0.

## 12. Analytics

None. Confirm that the project will never add telemetry, even opt-in, so the privacy
indicator can be a hard guarantee rather than a setting.
