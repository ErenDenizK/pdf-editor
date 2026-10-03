# ADR-0021: One Highlighter, a lasso for every kind, one ink palette

**Status:** proposed · **Date:** 2026-10-03 · **Deciders:** project lead (technical
decisions delegated by the owner) · **Amends:** `docs/specs/experience-redesign.md` §6.2,
§6.5; DESIGN §3 swatches

## Context

Three findings of the pen audit (`docs/specs/craft.md` §1.2) and the owner's notes
(`docs/DISCUSSION.md` #28):

- **Two highlighters.** The Draw group's yellow preset writes an Ink annotation at 40 %
  opacity with normal blending (`#FFD400`, width from speed or pressure), which turns black
  text olive and pastel; the Mark up group's Highlight (H) writes a Highlight annotation
  with `QuadPoints` at full opacity with Multiply (`#FFEB3B`), which cannot be moved,
  erased or lassoed and creates nothing on pages without text. Notability, GoodNotes and
  Apple Markup have one highlighter that snaps to text when drawn over text.
- **The lasso ignores shapes by design** (`annotations/lasso/geometry.ts` skips everything
  that is not ink, as spec §6.5 says); the owner expected arrows and shapes to come along.
- **Two palettes disagree** (pen presets vs style swatches), so a default blue or black
  stroke shows as "custom" in the contextual bar; yellow (1.2–1.4:1), orange (2.4:1), green
  (3.3:1), blue `#1E88E5` (3.7:1) and red (4.2:1) fail 4.5:1 on white paper; the inks'
  lightness ranges 0.49–0.88 in OKLCH, which reads as muddy (research 13 §8).

## Decision

1. **One Highlighter.** The yellow preset becomes the Highlighter: constant width, light
   tints at full opacity with **Multiply** (EmbedPDF blends any annotation with
   `blendMode`; no per-point widths). On release, a stroke that runs along text lines
   (glyph coverage ≥ 70 % along the reading direction) becomes a **Highlight annotation
   with `QuadPoints`**, built with the existing `quads.ts`; otherwise it stays **free ink
   with Multiply**. Alt while drawing forces free ink. Highlight (H) arms the Highlighter;
   the Mark up group's Highlight tool goes (ADR-0019). Highlight annotations become
   movable, erasable and lassoable through the same selection as ink.
2. **Lasso for every kind.** Hit tests per kind: line, arrow and polygon by their vertices
   and segments; rectangle and ellipse by their outline; free text, stamp and image by
   their rect; note by its icon; text markup by its quads. A lasso selection mixes ink
   paths and whole annotations; move, delete and recolour act across kinds as one history
   entry; resize and rotate of a group are affine for ink, line and polygon, while
   rectangle, ellipse, free text and note move about the group centre (PDF gives them no
   rotation); rotated stamps need engine work and are deferred.
3. **One palette** for pen presets and swatches, two lightness bands near the sRGB gamut
   edge (research 13 §8): writing inks that pass 4.5:1 on white, black `#1a1a1a`, blue
   `#1760ee`, red `#db1c22`, green `#02853c`, purple `#8036d3`; accent inks that pass 3:1,
   orange `#e46910`, pink `#e02c8a`, cyan `#0891c9`. Yellow is no longer an ink.
   Highlighter tints, drawn with Multiply at full opacity: yellow `#FFEA00`, green
   `#8CF26B`, blue `#8FD3FF`, pink `#FF9AD5`; black text on them stays ≥ 10:1. Default
   presets: black 1.5 pt, blue 1.5 pt, red 2 pt, Highlighter yellow 12 pt. A test asserts
   every ratio, as `tokens.test.ts` does for the chrome.
4. **The accent `#7c8cff` stays.** It is already at the sRGB gamut edge for its lightness
   and hue; a more saturated colour of the hue must be darker and would break the armed
   tool's 3:1 against the glass. Vividness in the chrome comes from content colour at full
   chroma (presets, tag dots) and higher accent alphas for selected and current states.

## Consequences

- Highlighter strokes drawn freehand over text become text markups: they follow the text
  in the Review list, flatten like markups and survive viewers that redraw ink. A user who
  wants a free yellow stroke over text holds Alt.
- Highlight annotations gain move and delete through the lasso and Select; a moved
  highlight keeps its `QuadPoints` translated (it becomes a free markup, said so in the
  Review row).
- Stored presets (`pdf-editor:ui:tool-styles:v1`, pen presets) migrate once: colours equal
  to an old default map to the new default of the same role; custom colours stay.
- Tests that hard-code today's values (presets, swatches, the pen e2e screenshot) change
  with the feature; the matrix gains a row for free ink with Multiply.

## Alternatives considered

- **Keeping both highlighters with distinct names ("Marker" vs "Highlight"):** two tools
  for one intent; the snapping rule removes the choice without removing either result.
- **Snapping by a toggle instead of by coverage:** one more control for a decision the
  stroke already makes; Alt covers the exception.
- **Translucent normal-blend highlighter (today):** tints the text itself and differs from
  the markup highlighter's look; Multiply keeps black text black in every viewer.
- **Ink-only lasso (M6):** simpler selection model, but "the lasso takes what it circles"
  is the habit from every notes app.
- **Per-swatch opacity to make yellow usable as ink:** yellow on white cannot reach 3:1 at
  any opacity; it belongs to the highlighters.
