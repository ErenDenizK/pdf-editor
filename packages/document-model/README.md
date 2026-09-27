# @pdf-editor/document-model

The virtual document model (ADR-0005): what the user sees in tabs, as immutable data.
It has no runtime dependencies and no DOM or Node APIs (ADR-0007), so it runs in the
browser, in workers, in Node and in a future desktop shell.

## Model rules

- **Sources are immutable.** `addSource` registers what the engine reported about an
  opened file (sizes, rotation, authored labels, flags) and creates one document that shows
  every page in order. Bytes never enter the model; pages point at `{ source, index }`.
- **Pure operations.** Every operation takes a `Workspace` and returns a new one. Unchanged
  documents, pages and outline subtrees keep their identity; a no-op returns the input
  itself, so `pushHistory` records nothing. Misuse throws `DocumentModelError` with a `code`.
- **Stable page ids.** Moving a page keeps its `PageId`; duplicating mints a new one from the
  injected `IdGenerator` (sequential in tests, `crypto.randomUUID` in the app).
- **One home per page.** Every `PageId` lives in exactly one document. Interleave, split and
  merge therefore consume their inputs, and the result becomes the active document.
- **Drop indices are pre-removal.** `movePages` takes the gap index the user sees while
  dragging; moved pages keep their relative order (tab order, then page order).
- **Outlines follow pages.** Page destinations always target pages of the same document.
  When a page leaves, its nodes become `unresolved` (with `previous`) instead of vanishing,
  and are restored if the page comes back. `dropUnresolved` cleans up for export.
- **Labels are derived.** A page's label is the explicit range covering it, else the source
  page's authored label, else its 1-based position. Explicit ranges are anchored to their
  first page and shift with inserts and deletes. `deriveLabelRanges` compresses effective
  labels into a `/PageLabels`-ready range list (decimal, roman, alpha, prefixes, literals).
- **History is snapshots.** `pushHistory` coalesces pushes with the same `coalesceKey`
  inside an 800 ms window (drags, sliders); a new push discards the redo branch.
- **Persistence is JSON.** `serializeWorkspace` / `deserializeWorkspace` use a versioned
  format (`version: 1`), rebuild every object through hand-written guards, and check
  invariants on load.

## Invariants

`assertWorkspaceInvariants(ws)` checks tab order vs documents, unique page ownership, source
references and indices, rotations, sizes, outline targets, label ranges and engine edits.
Tests assert it after every operation, including randomized operation sequences.

## Layout

`ids` · `workspace` (lifecycle, tabs) · `pages` (structural operations) · `outline` ·
`labels` · `history` · `selectors` · `serialize` · `invariants` · `types` (the contract).
