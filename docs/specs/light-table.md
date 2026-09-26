# Spec: Light table (Arrange mode)

**Status:** draft (2026-09-26) · **Milestone:** M1 · **Owner:** project lead

The light table is the view where pages are physical objects. It is the answer to the
single most requested capability (merge many PDFs with drag-and-drop reordering) and the
mental model for every structural operation: reorder, rotate, delete, duplicate, split,
merge, interleave, insert.

## 1. Model

- The light table shows **one or more documents** from the workspace. Default: the active
  document. The user can pin additional documents into the table ("Show in Arrange" from a
  tab's menu, or drag a tab onto the table). Each shown document is a **section** with a
  header (title, page count, color tag, collapse toggle, section menu).
- Every page thumbnail carries its **source color tag** (a thin 2px bar at the bottom or a
  corner dot) so pages that came from different files remain distinguishable after merging.
  Colors come from a fixed desaturated palette of 8, assigned per source in order.
- Thumbnails render from the engine at the current cell size (cached by source, index,
  rotation, scale); placeholders (page-shaped, tonal) appear instantly.
- Cell size: slider or Mod+Scroll, 5 stops (S 96px, M 144px, L 200px, XL 280px, XXL 400px
  cell width). Rows virtualized (TanStack Virtual, lanes = columns).

## 2. Selection

- Click selects one page. Shift+Click extends a range within a section. Mod+Click toggles.
- Marquee: press on empty space and drag; additive with Shift. Marquee auto-scrolls near
  edges.
- Keyboard: arrows move focus (grid semantics, wraps at row ends), Shift+Arrows extend,
  Space toggles selection, Mod+A selects all in the focused section, Esc clears.
- Selection may span sections. The status bar shows "N selected in M documents".
- Selection persists when switching to Read mode (the current page is the first selected).

## 3. Drag and drop

- Drag one or many selected pages. The drag preview is a stack: the first page thumbnail
  with a count badge when more than one, slightly scaled (0.96) and translucent (0.9).
- **Drop target is an insertion gap**, never "onto" a page. An accent-colored 2px
  insertion bar appears between cells, including at row ends and at the end of a section.
  The bar is shown with a 2px reserved gutter so nothing shifts.
- Dragging into another section moves pages across documents (they keep their source
  reference and color tag). Alt while dropping = copy (duplicate) instead of move.
- Auto-scroll near the top/bottom edges of the table; sections auto-expand on hover after
  600 ms when collapsed.
- **Files** dragged from the OS onto a section drop as new pages at the insertion point;
  dropped onto the table background they open as a new document section; dropped onto the
  tab bar they open as new tabs. A dashed accent outline on the target communicates which.
- Keyboard alternative (required, no mouse): with pages selected, Alt+Arrow moves the
  selection one slot in that direction; Alt+Shift+Arrow moves to the start/end of the row
  or section; Mod+X / Mod+V cut and paste pages at the focused cell (also across
  documents); Mod+Shift+V pastes as duplicate. Every move announces in the live region:
  "Moved 3 pages to position 7 in Invoice.pdf".
- Escape cancels a drag. Undo (Mod+Z) reverts a move as one step; consecutive keyboard
  moves within 800 ms coalesce into one history entry.

## 4. Per-page and per-selection actions

Contextual floating bar above the selection (appears on selection, hides on drag):
Rotate left / right, Delete, Duplicate, Extract to new document, Insert blank after,
Move to… (menu of documents), Properties (right panel). Shortcuts: R / Shift+R rotate,
Delete / Backspace delete, Mod+D duplicate, Mod+Shift+E extract.

Hover on a single cell reveals a small quiet action row (rotate, delete) in the reserved
gutter under the thumbnail; nothing moves on hover.

Right-click context menu mirrors the bar and adds "Select all from this source",
"Select odd / even pages", "Reverse selection order".

## 5. Section actions

Section header menu: Reverse pages, Interleave with… (choose another shown document; mode
alternate or duplex where the second document is reversed), Split (every N pages, by
outline level, by selection), Merge into… (append to another document), Rename, Close.
Duplicate pages that carry form widgets follow the document's form merge policy and show a
warning badge when a field would be unified.

## 6. Honesty and state

- A section badge shows engine-reported facts for its source: "repaired", "encrypted",
  "has form", "XFA", "signed", "tagged". Hovering explains what the export will do
  (e.g., "Signed: exporting will invalidate the signature unless saved incrementally").
- Cells whose pages are referenced by outline nodes show a tiny bookmark glyph; deleting
  them marks those nodes unresolved (shown in the Outline panel with a warning).
- The status bar summarizes: pages, selected, documents shown.

## 7. Performance targets

- 1,000 pages shown: scroll at 60 fps on a mid-range laptop; thumbnail queue prioritizes
  the visible range ± 1 screen, low priority for the rest; cancelled when scrolled away.
- Drag start latency < 50 ms; drop applies the model change synchronously and re-renders
  only the affected cells.
- Memory: thumbnails stored as `ImageBitmap` keyed in an LRU capped at ~150 MB, evicting
  by distance from the viewport.

## 8. Accessibility

- `role="grid"` per section with `aria-rowcount`/`aria-colcount`; cells
  `role="gridcell"` with `aria-selected`, labelled "Page 3 of 12, from report.pdf,
  rotated 90 degrees".
- Roving tabindex; visible focus ring; drag handle not required for keyboard users.
- Live region for moves, rotations, deletions, and long operations.
- Reduced motion: no drag scaling animation, instant insertion bar.

## 9. Out of scope for M1

Touch gestures (M6), N-up/booklet preview (M3+), page thumbnails with annotation overlays
(M2), cropping handles (M4).
