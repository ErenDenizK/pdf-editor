# ADR-0018: Variable-width ink as a standard Ink annotation with our appearance

**Status:** accepted · **Date:** 2026-10-01 · **Deciders:** project lead (technical
decisions delegated by the owner)

## Context

The pen redesign (`docs/specs/experience-redesign.md` §6) draws strokes whose width follows
pressure or speed. PDF's Ink annotation has no per-point width: `/InkList` holds centre
lines and `/BS /W` one width. Research 09 (`docs/research/09-ink-appearance-spike.md`)
measured whether our own appearance stream carries the varying width through our PDFium,
pdf.js, save, flatten and export verification. It does: widths drawn within 0.1 pt of the
plan in both renderers, `/Rotate 90` included, byte-identical after save, baked by flatten,
export verification green on 18 corpus pages.

## Decision

1. A variable-width ink is a **standard Ink annotation**: `/InkList` centre lines, `/BS /W`
   the nominal width, `/AP /N` our filled outline (one nonzero fill in user space, `/BBox`
   equal to `/Rect`), and the private text string `/PdfEditorInkWidths` (`1;w w …;…`, two
   decimals, one group per path, parallel to `/InkList`). A text string, not an array:
   PDFium's public API reads and writes only string and number values of arbitrary keys,
   and an array would need pdf-lib at save and at open.
2. The engine writes it through the PDFium host inside the adapter's create and update
   (`pdfium/host/annot-appearance.ts`: `FPDFAnnot_SetRect`, `FPDFAnnot_SetAP`,
   `FPDFAnnot_SetStringValue`, under `withRawAccess` per ADR-0011), after EmbedPDF's own
   write; P4 verifies passing `regenerateAppearance: false` for inks with widths so the
   constant-width step and half of the replaced streams disappear.
3. The outline is a **pure, versioned function** of centre line and widths
   (`packages/engine/src/annotations/ink-outline.ts`), shared by the live preview and the
   engine, so the shape never moves at commit and a later session regenerates the
   appearance after a move, recolour or width change. Point-moving smoothers such as
   `perfect-freehand` are not used in the engine: their outline cannot be rebuilt from
   `/InkList`.
4. Widths whose counts do not match `/InkList` are dropped and the ink renders at the
   nominal width; ink without the key is unchanged.
5. Export keeps collecting garbage (ADR-0011 §5), which removes the streams replaced by
   in-session rewrites.

## Consequences

- Pressure and speed reach every viewer that draws `/AP` (our PDFium, pdf.js, and the
  mainstream viewers that honour appearance streams). Viewers that redraw from `/InkList`
  show the nominal width; the UI says so in the pen's honesty note.
- Cost per full 64-path burst: about 23 KB compressed appearance plus 13 KB widths, and
  25–40 ms per update on a mid-range machine; page render time unchanged.
- Two conformance matrix rows are added by P4: "Ink, variable width (appearance)" and
  "Ink `/BS /W` equals the nominal width".
- Acrobat, Preview and Edge were not measured; the matrix's manual spot check covers them.
  No PDF/A validator was available to confirm that the private key is tolerated.

## Alternatives considered

- A real array for the widths: needs pdf-lib on both save and open paths.
- `EPDFAnnot_SetAppearanceFromPage` from a one-page PDF, as stamps do: heavier, and PDFium
  already compresses on save.
- One annotation per segment: floods the Review list and the undo history.
- Constant width only: the spec's failure path, kept as the fallback when widths are
  missing or inconsistent.
