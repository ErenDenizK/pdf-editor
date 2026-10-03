# ADR-0020: Paragraph text editing: Tier B now, Tier C later, no cross-page reflow

**Status:** proposed · **Date:** 2026-10-03 · **Deciders:** project lead (technical
decisions delegated by the owner); supersedes the "tier 3" line of ROADMAP M8 (2026-10-01)

## Context

The owner (`docs/DISCUSSION.md` #28) wants text editing that feels like owning the
document: enter Edit, click a text, the whole paragraph opens, type freely with no font or
size choices, the text rewraps as in Word and, ideally, later content and pages move. They
asked how far this is possible in a PDF.

What exists (M4, `docs/specs/redaction-and-text-editing.md` §2, audit in
`docs/specs/craft.md` §1.2): a "run" is one text object's glyphs on one line; a click
selects the clicked glyph in a one-line `<input>`; the change is widened to whole words
and every other glyph stays pinned at its original position, so a longer word needs
"Shrink to 75 %" or "Let it run over", and a deleted word leaves a gap; the overlay is an
opaque white box in Helvetica regardless of the page's font, sitting on the union of ink
boxes rather than the baseline; every keystroke runs a full engine dry run (a page save,
a pdf-lib parse, up to 256 probe objects, several text-page loads) while holding the
render-priority slot. The engine side is sound: tier 2 re-encodes in the original font,
tier 1 writes a fontkit subset of a bundled face, both verified by read-back with glyph
drift ≤ 0.01 pt (research 05).

Research 11 (`docs/research/11-paragraph-text-editing.md`) established the ceiling. A PDF
is a finished print: positioned glyph runs, no paragraph model, subsetted fonts, kerning
baked into `TJ`, headers, footers and figures painted onto each page as ordinary content.
No general editor reflows across pages; Acrobat's own documentation says edited text does
not push other boxes or flow to the next page; Foxit and Infix offer only user-linked
boxes. Paragraphs are a guess from geometry, exact only where the file is tagged
(`/P` structure elements, which PDFium's structure-tree API exposes through EmbedPDF
2.15.1). PDFium gives glyph advances per character code through probe objects (not through
`FPDFFont_GetGlyphWidth`, which takes Unicode and may answer from a fallback font), `Tw`
does nothing for two-byte fonts, and embedded subsets usually drop kerning tables. Loading
the embedded font into the page with `FontFace` is unreliable (browsers reject incomplete
fonts; fontkit cannot read bare CFF or Type 1).

## Decision

1. **Tiers.** Tier A (one line, same font, verified) is what exists. **Tier B, the
   paragraph editor, is built in M8.** **Tier C, pushing later blocks on the same page down
   into free space, is a candidate for M9**, decided after B is measured on the corpus.
   **Tier D, reflow across pages, is declined** and the UI never offers it; the help text
   says why in plain words (research 11 §7.4).
2. **Paragraph detection:** the structure tree first where the file is tagged; otherwise
   geometry on the page's lines (leading, left edge and indent, style breaks, list markers,
   columns), ported from the Markdown converter's `toLines` / `toBlocks`
   (`packages/engine/src/convert/layout.ts`) into text space. The analysis runs once per
   page and is cached; a wrong guess is corrected by one gesture (extend or split the box).
3. **Editing model:** style spans (font, size, colour, spacing from probes) inside the
   paragraph; the caret inherits the span under it; the paragraph is rewrapped greedily
   from the edit point and the rewrap stops as soon as a new line matches an old one, so
   lines before the edit never move and a typo fix changes one or two lines. Justified
   paragraphs stay justified through `TJ` offsets or per-word objects; kerning pairs are
   reused from the paragraph; hyphen flags come from `FPDFText_IsHyphen`.
4. **Writer:** original text objects are reused as line containers (they keep `Tc`, `Tw`,
   `Tz`, colour space, clip and marked content), one object per word on justified lines;
   the result is verified by read-back before commit as today and is one history entry;
   undo stays reopen-and-replay (ADR-0011).
5. **Font policy, no user choice:** the original font. A typed character the embedded font
   lacks is set per glyph in a bundled substitute matched by class (Inter for sans, Noto
   Serif for serif, JetBrains Mono for monospaced; Noto Sans is bundled too), and the
   editor shows one honesty line naming the substituted characters. Local Font Access and
   user-uploaded fonts are later options.
6. **Overflow policy, in order:** (1) a paragraph that keeps or loses lines commits as is;
   (2) one that grows expands into the empty space below it when the gap allows;
   (3) otherwise word spacing is tightened up to −15 % and then leading up to −5 %, never
   the glyph size, and the editor says "spacing tightened by N %"; (4) with Tier C, a
   preview of the push-down on the same page, committed on confirmation; (5) otherwise the
   text runs over with a visible warning and the overlap highlighted. Moving text to the
   next page is never offered. "Shrink to N %" disappears from the editor.
7. **Overlay:** a transparent canvas drawn from PDFium glyph paths on the real baselines
   with the full text matrix, so the paragraph looks like the page while typing; a hidden
   `contenteditable` mirror carries IME input and accessibility; after a 300 ms pause a
   PDFium render of the dry-run page replaces the canvas and shows exactly what will be
   saved. Per keystroke only width and line-break arithmetic runs on the main thread; the
   engine dry run happens on the pause and on commit, and never holds the render-priority
   slot.
8. **Refusals stay** with their shown reasons (Type 3, text drawn as paths, invisible or
   vertical text, nested or shared forms, text whose clip an edit would break). Text in a
   form XObject stays tier 1 only.

## Consequences

- The result is hard to tell from the original for small and medium edits in the original
  font; with a substituted font it is an honest, visible patch, said so in one line.
- A corpus of Word, Google Docs, LibreOffice, Chrome and LaTeX exports, tagged and untagged,
  one- and two-column, with lists and captions, gets golden read-back tests for detection
  and rewrap; the known failure modes (two columns, captions, drop caps, hanging indents)
  are listed with the behaviour the user sees.
- Links, markup `QuadPoints` and form widgets inside a rewrapped paragraph move with their
  words; a signed document still shows the re-export notice.
- New raw host wrappers: `FPDFFont_GetAscent` / `GetDescent`, `FPDFText_GetLooseCharBox`,
  `FPDFText_GetFillColor`, `FPDFText_GetMatrix`, `FPDFText_IsHyphen`,
  `FPDFPageObj_GetBounds`, and the structure-tree calls.
- Effort (research 11 §0): Tier B 10–14 engineer-weeks including the overlay and corpus;
  Tier C 4–6 weeks more. With agents in parallel the calendar is shorter, the review load
  is not.

## Alternatives considered

- **Whole-object `FPDFText_SetText`:** flattens `TJ` kerning and moves glyphs (research 05);
  rejected in M4 and still rejected.
- **`FontFace` from the embedded font program for a DOM editor:** unreliable for subsetted
  and CFF/Type 1 fonts; a canvas drawn from glyph paths matches the page by construction.
- **Rendering the PDFium page on every keystroke:** exact but 40 ms or more per frame on a
  dense page; it is used after the pause instead.
- **Shrinking the glyph size to fit:** visible beside untouched paragraphs and the opposite
  of "as if I had created the file"; spacing tightening within floors is invisible.
- **Linked text boxes across pages (Foxit, Infix):** possible, rarely wanted, and it would
  present as a feature what is a manual workaround; not now.
- **Convert to Word and back:** a different product with large fidelity losses; declined
  in `docs/ROADMAP.md`.
