# ADR-0019: Home as a view, documents in Read or Edit, Arrange as a view

**Status:** accepted (owner, 2026-10-03) · **Date:** 2026-10-03 · **Deciders:** project lead
(technical decisions delegated by the owner)

## Context

The owner's review of 2026-10-03 (`docs/DISCUSSION.md` #28) found the top-level switch
Home · Read · Arrange wrong: Home is a landing for every file and belongs outside any
document, while Read and Arrange only make sense once a file is open. The owner asked for
a plain model instead of six tool groups: a Read mode in which nothing can change, and a
mode in which text is clickable and the pen writes, with protection against a pen or a
stray click editing page text by accident. Text editing, a core feature, sat in the "Pages"
group.

The shell audit (`docs/specs/craft.md` §1.2) confirmed the code behind the complaint: the
view is one global value `viewMode: 'home' | 'read' | 'arrange' | 'compare'`
(`apps/web/src/state/ui-store.ts`); Home is always a segment of the control in
`shell/Stage.tsx`; clicking a document tab while Home is shown only changes the active
document and stays on Home; and there is no central hit-testing: each layer checks the
armed tool itself, the Edit text and Image layers take the whole page at the annotation
layer's z-index while armed, and 33 sites in 24 files compare `viewMode === 'read'`.

Research 13 (`docs/research/13-glass-and-modes.md` §5–§6) surveyed the mode models of
Word (Read Mode vs Editing), Google Docs (Editing / Suggesting / Viewing), Acrobat (View
vs the explicit Edit PDF tool), PDF Expert (Read as the default, Annotate / Edit tabs),
GoodNotes and Notability (read-only toggles, pen-first tools, "finger scrolls, pen writes")
and Figma (Space pans). Every one of them makes editing an explicit state that the user
enters, and none lets a pen reach page text.

## Decision

1. **Home is a view, not a mode.** Key `0` and the app glyph show the library of open files
   (cards, Combine, later Recents). The mode control is hidden on Home. Choosing a document
   tab leaves Home for that document in its last mode. `'home'` leaves `ViewMode`.
2. **A document is shown in Read or Edit; Arrange is a view beside them.** One segmented
   control, **Read · Edit · Arrange**, sits where the view switch sits today, with a lock
   glyph in the Read segment; Compare appears as a fourth segment only while a comparison
   is open. Keys: `1` Read, `2` Edit, `3` Arrange, `4` Compare (a one-time shift of today's
   `2` and `3`). The mode is a **per-document flag** (`documentMode: 'read' | 'edit'`)
   beside the existing view model, remembered for the session, not a new `viewMode` value.
   A file opens in Read; a new blank document opens in Edit. Read and Edit share the canvas
   and the scroll position, so switching never moves the page.
3. **Read is locked.** Scroll, zoom, find, select and copy text, follow links, read notes
   and comments, see form values. No tool can be armed, nothing on the page can move, and
   the floating bar collapses to one **Edit** button. A click on a form field shows
   "Switch to Edit to fill" with an Edit button, never an implicit switch. A tool shortcut
   pressed in Read switches to Edit and arms the tool, visibly, and changes nothing until
   the first stroke. Whole-document operations with their own dialog, preview and undo
   (page numbers, watermark, OCR, Apply redactions, Compress, Export) stay in the Document
   menu in both modes; Arrange's page operations stay in Arrange.
4. **Edit has five groups**, not six: **Select** (V, the idle tool) · **Write** (pen presets,
   Highlighter, Eraser, Lasso, Shapes ▾) · **Text** (Edit text E, Text box T, Note N, Image I)
   · **Fill & sign** · **Redact**. The "Read" group goes (Find, layout and fit stay in the
   title bar and palette; Select is the idle tool); the "Pages" group goes (Crop, Rotate,
   Delete page and Arrange live in Arrange, the page context menu and the Document menu);
   the "Mark up" group goes (Underline, Strikeout and Squiggly are offered by the contextual
   bar of a text selection made with Select and keep their shortcuts and palette entries;
   Highlight (H) arms the unified Highlighter of ADR-0021).
5. **Edit-mode interaction policy.** Only the armed tool creates; creating never selects;
   page text changes only through the paragraph editor (ADR-0020). With Select armed, a
   **double-click on page text** with a mouse, or with a pen used as a pointer, opens the
   paragraph editor; it never fires from touch, never from a pen while "Pen draws in Edit"
   is on, and changes nothing until a key is typed (Esc leaves without a change). After
   400 ms of an idle mouse or pen hover over page text with Select or Edit text armed, a
   faint run outline appears, with a one-time hint "Double-click to edit text". The pen
   never hit-tests text while a drawing tool is armed or "Pen draws in Edit" is on (that
   setting turns on the first time a pen is seen); the pen's eraser end is a temporary
   eraser and its barrel button a temporary lasso; holding Space pans; once a pen has been
   seen, fingers pan and zoom and a long press is the only touch selection gesture; touch
   never shows hover affordances. Chrome is never tinted by mode (DESIGN §3).
6. **One hit order** shared by the layers: annotation → form widget → image → text run →
   text selection. The Edit text and Image layers stop covering the whole page while armed.

## Consequences

- Shortcut keys `2` and `3` change meaning once; the e2e specs that press `0`–`3` and the
  specs that hard-code the six group labels (`apps/web/e2e/tools.spec.ts`, `a11y.spec.ts`)
  are rewritten with the feature.
- "Read" now names the locked mode only; the former "Read" group's label is retired, so
  the word means one thing in the UI and in both catalogs.
- Text markup from a selection needs the contextual bar on a Select-tool text selection to
  carry Highlight, Underline, Strikeout, Squiggly and Comment (it carries highlight,
  underline and comment today).
- The per-document flag means the Read lock has to be enforced in each place that mutates
  the document from the Select tool today (annotation select, move, resize and delete;
  form filling; tool shortcuts; select-then-markup); a store-level guard
  (`canEdit(documentId)`) backs the UI checks so a missed site fails closed.
- Recents on Home needs a small IndexedDB store of names and, where the browser keeps
  them, file handles; `files/open-files.ts` discards the handle today. It is a P2 package.
- Dead `ToolId` / `tool` / `setTool` in `ui-store.ts` are removed.

## Alternatives considered

- **A new `viewMode` value `'edit'`:** touches 33 comparison sites and conflates "which
  view" with "may the document change"; the flag keeps the two questions apart.
- **Single click on text edits (PDF Expert's Edit tab):** fast, but a slip while scrolling
  or selecting text opens an editor; the owner asked for protection against exactly that.
  The double-click is the mouse habit of Word and Acrobat, and Edit text (E) stays as the
  one-click tool for those who want it.
- **Tool-only text editing (Acrobat):** safest, but "click a text and type" was the
  owner's core ask; the double-click plus the idle hover hint gives it without a tool.
- **Tinting the bar or title bar by mode (GoodNotes):** rejected by DESIGN §3, the accent
  stays the only colour; the lock glyph, the control's label and the collapsed bar carry
  the state without colour.
- **The mode control in the title bar:** the tabs and the palette already fill it, and the
  control would drift from the stage it describes.
- **No Read mode, tools only (Notability):** Notability's notes are the user's own; a PDF
  from someone else is read far more often than edited, and the owner asked for a locked
  state.

## Discussion summary

Owner, 2026-10-03: the approach and the changes are accepted; the open questions on the
double-click habit, the Document menu in Read and Recents are left to the lead (answers in
`docs/specs/craft.md` §14: double-click stays, the menu stays available in Read, Recents
keep file handles where the browser gives them).
