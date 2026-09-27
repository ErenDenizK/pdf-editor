# Annotation cross-viewer matrix (M2)

Spec: [viewer-annotations.md §7](../specs/viewer-annotations.md). M2 exits only when every
kind renders in all five viewers **and** the note text is visible in each viewer's comment
UI. Every cell starts as `untested`; record results with the procedure below.

Sample: [`samples/annotations-sample.pdf`](samples/annotations-sample.pdf), written by the
app's own PDFium adapter (`createAnnotation` + `save()`, the path export uses) and checked
with `checkAnnotationConformance` before it is written. Page 1 has one annotation of each
kind with a printed label next to it; page 2 has `/Rotate 90` with a highlight, a note and a
square.

## Results

Cell values: `ok`, `untested`, or `fail: <what is wrong>` (e.g. `fail: no appearance`,
`fail: opacity ignored`, `fail: popup text missing`). Add the viewer version in the header
when you test.

| Kind (page 1 label) | Acrobat Reader | Chrome (PDFium) | Firefox (pdf.js) | Preview (macOS) | Edge |
| --- | --- | --- | --- | --- | --- |
| Highlight (Multiply blend, comment popup) | untested | untested | untested | untested | untested |
| Underline | untested | untested | untested | untested | untested |
| Strikeout | untested | untested | untested | untested | untested |
| Squiggly | untested | untested | untested | untested | untested |
| Ink | untested | untested | untested | untested | untested |
| Square (50% opacity, interior color) | untested | untested | untested | untested | untested |
| Circle | untested | untested | untested | untested | untested |
| Line with open arrow | untested | untested | untested | untested | untested |
| Polygon (interior color) | untested | untested | untested | untested | untested |
| Polyline | untested | untested | untested | untested | untested |
| Free text (14 pt, red) | untested | untested | untested | untested | untested |
| Note: icon renders | untested | untested | untested | untested | untested |
| Note: text visible in the comment UI | untested | untested | untested | untested | untested |
| Note: popup opens by default (`/Open true`) | untested | untested | untested | untested | untested |
| Stamp, named (`Approved`, generated appearance) | untested | untested | untested | untested | untested |
| Stamp, image (PNG) | untested | untested | untested | untested | untested |
| Link (URI) opens https://example.org/ | untested | untested | untested | untested | untested |
| Page 2 (`/Rotate 90`): highlight, note, square placed correctly | untested | untested | untested | untested | untested |
| Printing (File → Print, all kinds appear) | untested | untested | untested | untested | untested |

## Procedure

1. Regenerate the sample when the engine changed (it is committed, so testers without a
   toolchain can use it as is):

   ```sh
   pnpm --filter @pdf-editor/qa-tool sample
   ```

   This runs `tools/qa/make-annotation-sample.ts` in Vitest browser mode (headless
   Chromium: the adapter needs EmbedPDF's worker and WASM), asserts conformance and writes
   `docs/qa/samples/annotations-sample.pdf` through Vitest's `commands.writeFile`. /NM
   values and dates change on every run.
2. Open the sample in each viewer, at 100 % and at 200 % zoom:
   - **Acrobat Reader** (latest, Windows or macOS): open the file; open the Comments pane.
   - **Chrome**: drag the file into a tab (built-in PDFium viewer).
   - **Firefox**: drag the file into a tab (pdf.js); use the sidebar if needed.
   - **Preview** (macOS): open the file; View → Show Markup Toolbar / Highlights and Notes.
   - **Edge**: drag the file into a tab.
3. For each row, compare with the label printed on the page:
   - The annotation is drawn where its label says, with its color, and nothing else on
     the page is covered (highlights darken the text, they do not hide it).
   - Opacity: the square is visibly translucent (the label text shows through its fill).
   - Notes: the icon is drawn; clicking it (or the Comments pane) shows "This note text
     must appear in the comment UI." Record whether the popup is open on load.
   - Markup comments: the highlight shows "highlight comment" in the viewer's comment UI.
   - Page 2: the page is displayed landscape; the highlight covers its text line and the
     note icon stays upright.
4. Print to PDF or paper from each viewer and check the Printing row (all annotations have
   the Print flag).
5. Write the result into the table (with the viewer version) and file an issue for every
   `fail`, linking this file.

## What the engine guarantees (checked in CI)

`checkAnnotationConformance` (packages/engine/src/annotations/conformance.ts) runs on every
saved document in the engine tests and during export verification when annotations were
edited: `/AP /N` present (links and popups exempt), `/Rect` large enough for the appearance
after its `/Matrix`, QuadPoints in upper-left, upper-right, lower-left, lower-right order and
inside `/Rect`, `/P` pointing at the page, unique `/NM`, Print flag, `/M`, an ExtGState
matching `/CA` when opacity < 1, Multiply blend for highlights, and popups linked both ways
(`/Parent` and `/Popup`). What only a human can judge is how each viewer draws and exposes
them, which is what this matrix records.
