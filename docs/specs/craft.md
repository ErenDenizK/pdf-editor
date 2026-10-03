# Spec: Craft (M8): modes, paragraph editing, ink, colour and glass

**Status:** approved by the owner on 2026-10-03 (§14 answered; the overall approach and the
changes accepted, questions 1–4 left to the lead, Tier C dropped) · **Milestone:** M8 (two
drops; a drop is tagged `1.0.0-beta.N` only when the owner says so) · **Owner:** project lead

**Inputs:** the project lead's decision brief of 2026-10-03 (binding where it differs from
the research); three code audits of 2026-10-03 at `411015d` (text editing; pen, lasso and
markup; shell, modes and glass), whose evidence is in §1.2; research 11, 12 and 13
(`docs/research/11-paragraph-text-editing.md`, `12-low-latency-ink.md`,
`13-glass-and-modes.md`); `docs/DESIGN.md`; `docs/ROADMAP.md` M6–M10;
`docs/specs/experience-redesign.md` ("spec M6"); ADR-0018 to ADR-0021.

M6 made Recto simpler; the owner's verdict on the beta is that everything works and nothing
feels native yet. This spec is the plan: a locked Read mode and an Edit mode, a paragraph
editor that rewraps text in the page's own font, a pen that keeps up with the hand, one
highlighter, a lasso that takes everything, one clean palette, and a measured trial of
wider glass. The former M8 is now M9, and M10 "Tablet and phone" follows. Paths are under
`apps/web/src/` unless they start with a top-level directory.

## 0. Decisions this spec builds on

| Topic | Decision | Where decided |
|---|---|---|
| Milestone | M8 Craft ships as 1.0.0-beta.1 (beta.2 if needed); 1.0.0 keeps its exit criteria | brief; ROADMAP M8 |
| Home | A view of the open files (`0`, app glyph), not a mode | ADR-0019 §1 |
| Document modes | Read (locked) ⇄ Edit, Arrange a view; per-document `documentMode` flag | ADR-0019 §2–§3 |
| Edit bar | Five groups: Select · Write · Text · Fill & sign · Redact | ADR-0019 §4 |
| Interaction policy | Research 13 §6.2 plus double-click on page text opens the paragraph editor | ADR-0019 §5–§6 |
| Text editing | Tier B in M8; Tier C and Tier D declined | ADR-0020 §1; owner, 2026-10-03 |
| Fonts | Original font; per-glyph bundled substitute; one honesty line; no user choice | ADR-0020 §5 |
| Overflow | Grow into the gap; tighten word spacing ≤ 15 %, then leading ≤ 5 %; run over with a warning; never to the next page; no shrink | ADR-0020 §6 (lead's correction, 2026-10-03) |
| Variable-width ink | Kept | ADR-0018 |
| Highlighter, lasso, palette | One Highlighter; lasso for every kind; one palette | ADR-0021 §1–§3 |
| Accent | `#7c8cff` stays | ADR-0021 §4 |
| Glass | Spike S2; "Glass panels" setting, default off | brief; §7 |
| Tablet and phone | M10 | brief; ROADMAP M10 |
| About pages | Each app keeps its own; the portfolio is a hub; not in this spec | `docs/DISCUSSION.md` #28 |

## 1. Problem

### 1.1 The owner's feedback (2026-10-03, `DISCUSSION.md` #28; in translation, condensed)

"It works, but it doesn't feel fluid or native yet." · "Text editing feels like a patch,
and it hides under Pages." · "Why are there two highlighters?" · "The pen is slightly laggy
and sticky, also with a mouse." · "The colours don't look clean." · "The lasso doesn't take
arrows." · "Home · Read · Arrange is wrong: I want Read, where nothing can change, and
Edit, with protection against editing text by accident." · "Simpler, like Notability." ·
"Try glass more widely, but never opaque." · "Tablets later."

### 1.2 Audit evidence

Headless Chromium on a fast container; timings are lower bounds.

| # | Finding | Evidence |
|---|---|---|
| 1 | The editable unit is one text object on one line; a click selects the clicked glyph in a one-line `<input>`; newlines are stripped | `text-edit/TextEditLayer.tsx:157-168`, `text-edit/model.ts:133-165` |
| 2 | Kept glyphs are pinned; free space is the replaced word's width, so growth needs "Shrink" (floor 75 %) or "Overflow" over the next word, asked on every such edit; a deletion leaves a gap | `packages/engine/src/text-edit/apply.ts:351-379`, `editability.ts:172-174`, `types.ts:1074`, `text-edit/model.ts:365-391` |
| 3 | The overlay is opaque white Helvetica, black, `line-height: 1`, on the union of ink boxes; spacing, colour and skew ignored | `text-edit/TextEdit.module.css:83-101`, `text-edit/TextEditor.tsx:220-265` |
| 4 | Each keystroke (200 ms debounce) runs a full dry run: 5–7 text-page loads, 3 page reloads, a page save and parse, 256 probe codes for simple fonts, holding the render-priority slot | `text-edit/TextEditor.tsx:45`, `packages/engine/src/text-edit/editor.ts:194-298`, `analysis.ts:117-123` |
| 5 | Edit text sits in Pages; its layer covers the page at z-index 2 | `annotations/tools.ts:117-125`, `text-edit/TextEdit.module.css:10-15` |
| 6 | Paragraph detection exists only for Markdown export; the structure tree is unused | `packages/engine/src/convert/layout.ts:324`, `:423` |
| 7 | Mouse width follows speed (0.75–1.25×, 40 ms lag): a 1.5 pt pen draws 1.82 pt at starts, 1.31 cruising, 1.86 after stops | `annotations/pen/ink-input.ts:31-37`, `:116-123` |
| 8 | The preview outlines raw samples with miter joins: 22 % of edge vertices exceed 1.4× the half width; the commit is smoothed, so the shape snaps at release | `annotations/pen/ink-preview.ts:133-157`, `packages/engine/src/annotations/ink-outline.ts:125-131`, `annotations/ink.ts:180-192` |
| 9 | Pointer-up to committed stroke: 209–237 ms, about 160 ms of it the zoom debounce applied to edits | `stage/ReadView.tsx:58`, `pages/PageCanvas.tsx:235-238` |
| 10 | A 12-stroke burst: 1 create, 11 updates, 34 `listAnnotations`; each append rewrites every path; thumbnails are dropped each time | `annotations/actions.ts:154-199`, `annotations/annotation-store.ts:611-617`, `engine/engine-service.ts:739-760` |
| 11 | Prediction only from `getPredictedEvents()`, empty for mouse in headless Chromium | `annotations/pen/ink-input.ts:533` |
| 12 | Two highlighters: the yellow preset is `/Ink` at `/CA 0.4` with normal blend (black text turns olive, 14.7:1 → 6.3:1); Highlight (H) is `/Highlight` with quads, Multiply, opacity 1 (17.2:1), not movable, erasable or lassoable, nothing off text, and its preview is paler than the result | `annotations/pen/presets.ts:43-48`, `packages/engine/src/pdfium/annotation-mapping.ts:475`, `annotations/geometry.ts:81-83`, `annotations/AnnotationLayer.module.css:146-149` |
| 13 | The lasso takes ink only, by design | `annotations/lasso/geometry.ts:114`; spec M6 §6.5 |
| 14 | Two palettes disagree (a default pen colour shows as "custom"); on white `#1E88E5` 3.68:1, `#E53935` 4.23, `#43A047` 3.30, `#FB8C00` 2.37, `#FFD400` 1.43, `#FFEB3B` 1.22 | `annotations/annotation-store.ts:54-63`, `annotations/StyleControls.tsx:128-129` |
| 15 | Home is always a segment (DESIGN §2 says otherwise); a tab click on Home stays on Home | `shell/Stage.tsx:136-138`, `shell/TabBar.tsx:145` |
| 16 | No central hit testing; Edit text and Image roots cover the page; Read is not locked (annotations move, fields take input) | `image-objects/ImageObjects.module.css:7-11`, `annotations/AnnotationLayer.tsx:393-478`, `forms/FormLayer.tsx:62` |
| 17 | Glass only on floating chrome; docked panels are opaque grid tracks over flat `--surface-0`; the test pins `brightness(0.45)` and one elevation | `shell/AppShell.module.css:1-14`, `styles/global.css:140-177`, `styles/tokens.test.ts:355`, `:384-418` |
| 18 | `ToolId`, `tool`, `setTool` are dead | `state/ui-store.ts:33`, `:211`, `:261` |

## 2. Principles kept and amended

Kept: the document is the only bright thing; one accent; one elevation token; creating
never selects; a keyboard path and palette entry for every action; undo, not confirmation;
inline honesty; chrome never tinted; no marketing surface. Amendments (WP D1; A15 only after
S2 and the owner's approval):

| # | Rule | Was | Becomes |
|---|---|---|---|
| A8 | DESIGN §2 views | Four views, keys `0`–`3`; Home in the switch | Home is a view without a mode control; a document is in Read (locked), Edit or Arrange, one control, Compare only while open; keys `1`–`4` |
| A9 | DESIGN §2 tool bar | Six groups | Five groups in Edit; one Edit button in Read |
| A10 | DESIGN §4.2, new §4.8 | "Esc always clears tool and selection" | …and never leaves Edit. §4.8: Read is locked; in Edit only the armed tool creates and page text changes only through the paragraph editor |
| A11 | DESIGN §3 on the page | In-place editors are opaque page white | The paragraph editor draws the page's own glyphs on a transparent canvas; text box and note editors stay opaque |
| A12 | DESIGN §4.1 presets, width | Yellow highlighter at 40 %; speed width for mouse and finger; one outline function | Three pens and the Highlighter; constant mouse width; finger ±10 %; one smoothed stroke model |
| A13 | DESIGN §4.1 lasso | Ink only | Every kind (§5.5) |
| A14 | DESIGN §3 dots, swatches, tags | Translucent preset as a capsule; tags desaturated | The Highlighter is a capsule of its tint; one palette; tag dots at full chroma |
| A15 | DESIGN §2–§3 glass | Everything docked is opaque | With Glass panels on, the docked frame is a denser glass equal to `--surface-1` over the canvas |

`docs/specs/viewer-annotations.md` (Ink row) follows A12;
`docs/specs/redaction-and-text-editing.md` §2.2 follows §4.

## 3. Home and modes (ADR-0019)

### 3.1 Home

`0`, the app glyph and "Show Home" open the library of open files (the M6 cards, Combine,
drag to merge), with no mode control. `'home'` leaves `ViewMode` for a shell flag
`destination`, so the 33 `viewMode === 'read'` sites in 24 files keep meaning "the page
view shows". A tab click on Home opens that document in its last mode; on Home the glyph is
`aria-current` and no tab is selected. After the last document closes, the next file opens
in Read. **Recents** (WP M5, P2): names, and reopen through a `FileSystemFileHandle` where
the browser keeps one (`files/open-files.ts:52-80` drops it today), local only, with "Clear
recents"; it moves to M9 (ROADMAP) if it misses M8.

### 3.2 The control and the keys

| Segment | Key | Shows |
|---|---|---|
| Read (lock glyph) | `1` | The document, locked; the bar is one Edit button |
| Edit | `2` | Same canvas and scroll position, the five-group bar |
| Arrange | `3` | The light table, in either mode |
| Compare | `4` | Only while open; with none open, `4` starts one |

The control stays in `shell/Stage.tsx` (`ModeSwitch`, an APG radio group) with the
view-switch "on" look; chrome is never tinted by mode. `2` and `3` change meaning once. A
file opens in Read; a new blank document, or Fill & sign from the palette, opens in Edit;
the last mode is remembered per document for the session.

### 3.3 Read

Allowed: scroll, zoom, layout, Find, select and copy, links, notes and comments read-only,
form values, Review, History, Undo and Redo (§13 #6). Blocked, behind one store guard
`canEdit(documentId)` that fails closed:

1. annotation select, move, resize, delete and inline editing;
2. form input: a click shows the focus ring and "Switch to Edit to fill" with an **Edit**
   button, never an implicit switch;
3. arming: a tool shortcut switches to Edit and arms the tool, visibly; nothing changes
   until the first stroke;
4. select-then-markup: the selection bar offers Copy and "Mark up…"; H, U or S switch to
   Edit keeping the selection, and marking needs a second press;
5. the paragraph editor (double-click selects a word).

The **Document menu** keeps every item: page numbers, watermark, OCR apply, Apply
redactions, Compress and Export are dialogs with preview and undo. Arrange's page
operations stay. A signed document entering Edit shows the existing re-export notice.

### 3.4 Edit bar

| Group | Tools (key) |
|---|---|
| Select | Select (V), the idle tool |
| Write | Three pen presets and the Highlighter (P last pen, H), Eraser (Shift+E), Lasso (Q), Shapes ▾ (R, O, L, A) |
| Text | Edit text (E), Text box (T), Note (N), Image (I) |
| Fill & sign, Redact | As today |

Gone: the Read group (Find, layout and fit stay in the title bar and palette); the Pages
group (Crop, Rotate, Delete page and Arrange move to Arrange, a new page context menu and
the Document menu); the Mark up group (Underline U, Strikeout S, Squiggly and Highlight
from a selection move to the Select selection's contextual bar, keeping shortcuts and
palette entries). `BAR_GROUP_IDS` becomes `select · write · text · fill · redact`.

### 3.5 Interaction policy in Edit

Only the armed tool creates; creating never selects; page text changes only through the
paragraph editor; the pen never hit-tests text while a drawing tool is armed or "Pen draws
in Edit" is on; touch never shows hover affordances.

| Tool | Click on text | Click on annotation | Click on paper | Double-click | Drag | Pen | Long press |
|---|---|---|---|---|---|---|---|
| **Read** (contrast) | Caret | Note read-only; link follows | — | Word | Selects | Never marks | Word; Copy, "Mark up…" |
| **Select** (V) | Starts a selection (markups, Comment in its bar) | Selects it | Clears | **On page text: paragraph editor, caret at the point** (mouse or pen-as-pointer; never touch or a drawing pen); on a text box or note: edits it | Text: selects; annotation: moves; paper: marquee | As mouse unless "Pen draws in Edit" | Word; menu |
| **U, S, Squiggly** | Marks the word | Passes through | — | Marks the word | Marks the run | As drag | After 300 ms |
| **Edit text** (E) | Paragraph editor, caret at the point | Ignored, dimmed | — | Word in the editor | Selects in it | Clicks; never draws | Opens the editor |
| **Pens, Highlighter** | Draws | Draws over it | Draws | — | Draws | Pressure | Fingers never draw once a pen is seen |
| **Eraser** | — | Erases it | — | — | Erases along | Eraser end: temporary eraser in any tool | — |
| **Lasso** (Q) | — | — | — | — | Lasso | Barrel button: temporary lasso | — |
| **Shapes, Text box, Note** | Creates (on text too) | Shapes: on top; T, N: selects it | Creates | — | Sizes | Same | Same |
| **Image** (I) | — | Ignored | Selects an image | — | Moves it | Same | Same |
| **Fill & sign, Redact** | Field: type; Redact: marks the run | Selects a field or mark | Places, or area mark | — | Moves, or area | Same | Same |

**Hover hint.** After 400 ms of idle mouse or pen hover (`buttons === 0`) over page text
with Select or Edit text armed, a faint run outline (1 px `--accent-line`) appears from the
viewer's text model (no engine call), never within 300 ms of a stroke
(`TOUCH_AFTER_PEN_MS`); once per device a hint says "Double-click to edit text".

**One hit order**, annotation → form widget → image → text run → text selection, in
`viewer/hit-order.ts`; layer roots become `pointer-events: none` with only targets live.

**Pen, touch, keys.** The eraser end (`buttons & 32`) is a temporary eraser, the barrel
button a temporary lasso. "Pen draws in Edit" turns on when a pen is first seen (`penSeen`,
`annotations/pen/ink-input.ts:453`); then a pen with Select armed draws with the last
preset, while Edit text always takes the pen as a pointer. Space pans in both modes; once a
pen is seen, fingers pan and zoom and a long press is the only touch selection. Esc clears
tool and selection, then returns the bar to its group row; it never leaves Edit.

**Strings** (`apps/web/messages/{en,tr}.json`, parity by `i18n/i18n.test.tsx:44`): the mode,
group and Home keys (`mode_read*`, `cmd_mode_*`, `bar_group_*`, `cmd_view_home`,
`empty_body_combine`, `tool_edit_text_tooltip`) change; new `mode_edit`, `mode_edit_long`,
`cmd_mode_edit`, `bar_group_select`, `bar_group_write`, `bar_group_text`,
`read_locked_announce`, `form_switch_to_edit`, `edit_text_hint`, `pen_draws_in_edit`,
`glass_panels`, `reduce_transparency`, `recents_*` and the editor strings.

## 4. Text: the paragraph editor (ADR-0020, Tier B)

### 4.1 Detection

Analysis runs once per page on open or first use and is cached by revision.

1. **Structure tree first** (`FPDF_StructTree_GetForPage`, `FPDF_StructElement_GetType`,
   `…GetMarkedContentIdAtIndex`): objects whose MCIDs belong to one `/P`, `/LI` or
   `/H1`–`/H6` form a paragraph; a group with non-contiguous lines falls back.
2. **Geometry**, horizontal text, in text space, porting `toLines` / `toBlocks` with
   research 11 §3.3's thresholds:
   - lines: baselines within 0.2 × size, gaps under 1.5 × median space; a gap over 3 ×
     space breaks the line; columns first, from channels ≥ 2 × space wide and ≥ 3 lines tall;
   - line n+1 joins line n when family and size match (±0.5 pt); the baseline gap is within
     ±15 % of the running leading (≤ 1.6 × size); left edges align within one space, or it is
     a first-line or hanging indent; line n reaches ≥ 85 % of the measure unless centred or
     right-aligned; line n+1 starts with no list marker;
   - `toBlocks`' breaks also apply: size or bold change, a gap above
     `max(0.6·size, min(1.5·leading + 1, 1.3·size))`, an indent change above one size;
     `suspectedTables` give one box per cell; justified when line edges vary under 0.5 pt.
3. **Correction**: "Join with next" and "Split here" on the box (Alt+J, Alt+S). A drop cap
   refuses paragraph mode with its reason.

### 4.2 Model, caret and style

A paragraph holds lines of spans: slices of text objects with font, size, matrix, fill,
render mode, marks and Tc/Tw/Tz measured by probes (PDFium cannot read them). Its text is
de-hyphenated: a line-end hyphen flagged by `FPDFText_IsHyphen` before a lowercase start
joins the word; compounds keep theirs (`convert/markdown.ts`). The editor opens with a
caret at the click, never a glyph selection; arrows cross lines, Enter inserts a line
break, Mod+A selects the paragraph. Leaving (Esc, a click outside) commits a change as one
history entry (§13 #9); with no change nothing happens. The caret inherits the span before
it; there are no font, size or colour controls.

### 4.3 Rewrap, justification, kerning, hyphens

- **Greedy first-fit from the edited line.** Earlier lines stay byte-identical. The rewrap
  stops when a new line ends at the same word as an old one with the rest unchanged; later
  lines are reused, shifted by the line-count change × leading. Widths come from codes
  (`plain` and `spaced` advances probed once per font, `packages/engine/src/text-edit/probe.ts`), never
  `FPDFFont_GetGlyphWidth` alone; substitutes use `fontkit.layout()`; break opportunities
  from `linebreak` 1.1.0 (MIT, UAX #14).
- **Justified** paragraphs stay justified: slack on word gaps only, at most 1.5 × the
  natural space, else the line stays ragged and the editor says so. `Tw` does nothing for
  two-byte fonts and PDFium cannot write `TJ`, so rewrapped justified lines are one object
  per word.
- **Kerning**: `content.ts` keeps `TJ` numbers (dropped at `:548-551`); pair offsets are
  harvested from the paragraph and reapplied; subset ligatures are reused.
- **Hyphens**: kept at unchanged line ends; none inserted in M8 (§13 #10).

### 4.4 The writer

`applyParagraphEdit` generalises `performEdit` (`packages/engine/src/text-edit/apply.ts`).
Rewritten lines reuse the original objects as line containers (`SetCharcodes` +
`SetMatrix`: colour space, Tc/Tw/Tz, clip and marks survive); extra lines are new objects
in the same `FPDF_FONT` with explicit glyph origins, at the first object's z-order, under
the original `/P` (`finalize.ts`); links, markup quads and widgets over moved words move
too. Verification on a fresh text page: exact read-back, glyphs within 0.01 pt and boxes
within 0.05 pt of plan, nothing outside the clip or the paragraph changed; then one
`GenerateContent`. One `EngineEdit` (`text.editParagraph`) records run refs, texts and the
planned layout, so reopen-and-replay undo stays byte-identical: one history entry.

### 4.5 Fonts and honesty

The original font sets every glyph it has. A missing character is set per glyph in a
bundled substitute of its class, scaled to the x-height: Inter, Noto Serif, JetBrains Mono,
and Noto Sans, added to `packages/engine/assets/fonts/` (the code names it; it does not
ship). One honesty line names the characters: "‘ğ’ and ‘ş’ use Noto Serif because the
original font in this file does not include them." Uncovered scripts stay refused. Later:
Local Font Access, uploaded fonts.

### 4.6 Overflow

1. Same or fewer lines: commit.
2. Growth that fits the empty space below (plus the original gap to the next block): grow.
3. Else, in order: word spacing up to −15 %, then leading up to −5 % (floor 95 %), on the
   rewritten lines; never the glyph size. The editor says "Spacing tightened by N %".
4. Else run over with a warning and the overlap highlighted.

The next page is never offered; "Shrink to N %" leaves the editor.

### 4.7 Overlay

A canvas at device pixel ratio draws the rewritten lines from `FPDFFont_GetGlyphPath`
outlines (cached per font and code) on the real baselines with the full text matrix, in the
span's colour; lines before the edit are the page itself. Under rewritten lines it paints a
plate rendered once at open without the paragraph's text, so coloured boxes and rules
survive (page white without one; §13 #8). Caret, selection and composition underline are
ours; a hidden `contenteditable` mirror takes keys, IME, clipboard and assistive
technology. After a 300 ms pause one dry run renders the paragraph's clip over the canvas,
so what settles is what will be saved. `FontFace` from the embedded font is rejected:
browsers refuse incomplete fonts, and fontkit cannot read bare CFF or Type 1.

### 4.8 Performance

| Step | Budget |
|---|---|
| Analysis (tree, runs, blocks, probes once per font) | Once per page, cached; `withRawTask` at lower priority, never the render-priority slot |
| Click to caret | The next frame, from cached geometry |
| Keystroke | ≤ 4 ms of arithmetic on the main thread, no worker round trip |
| Pause, commit | One dry run each |

**Beta.1 speed-ups** (WP T1) on today's editor: this split, the caret at the click, free
space bounded by the column instead of the page edge (`editability.ts:187-193`).

### 4.9 Refusals, Tier C, Tier D

Refused with their reason, as today: Type 3, text as paths, invisible or vertical text,
nested or shared forms, broken clips, unreadable encodings, unsupported characters; new:
drop caps. Text in a form XObject stays tier 1 only. **Tier C**, pushing later blocks of the
same page into free space, is declined by the owner (2026-10-03: too far from the core for
its 4–6 weeks); research 11 §5 keeps the design should it ever be wanted. **Tier D**,
cross-page reflow, is declined: the file has no flow record and its furniture is ordinary
content. The user sentence in §4.10 therefore says that other content on the page never
moves.

### 4.10 What users read

In the editor's info popover and the help page, verbatim from research 11 §7.4:

> "Recto rewraps the text inside this paragraph using the paragraph's own font, size, colour
> and spacing. Lines you did not change keep their exact spacing, and move up or down only if
> the paragraph gains or loses a line. Recto never moves other content on the page and never
> moves text to another page: a PDF stores finished pages, not a flowing document. If you
> type a character that the font in this file does not contain, Recto shows it in a
> different font and tells you which one."

(Research 11 §7.4's wording, with its push-down clause removed because Tier C is declined.)

## 5. Pen (ADR-0018 kept; ADR-0021)

### 5.1 Measurement first

Before any pen change: `window.__inkStats` (draw time per frame, event-to-draw from the
newest sample's `timeStamp`), Long Animation Frames during strokes in development builds,
and `e2e/ink-latency.spec.ts` driving CDP `Input.dispatchMouseEvent` (`pointerType: 'pen'`,
`force`, tilt, explicit timestamps) on scripted 240 Hz paths plus a 125 Hz mouse run. A
240 fps camera check on the owner's laptop runs before and after.

| Target | Value | Today |
|---|---|---|
| Preview draw | ≤ 1 ms per frame, flat to 5,000 points | 0.1–0.3 ms, growing |
| Pointer to preview | ≤ 1 frame (event-to-draw p95 ≤ 4 ms) | about 2 frames |
| Committed stroke visible | ≤ 50 ms after pointer-up, edges move ≤ 0.5 device px | 209–237 ms, visible snap |
| Long tasks in a 64-path burst | none > 50 ms | unmeasured |

### 5.2 Input and preview, in order

1. **Constant width for a mouse** (`speedPressure` off); touch ±10 % at most, τ ≤ 20 ms;
   pens keep pressure.
2. **One smoothed stroke model**: `smoothPiece` beside `finishInkStroke`
   (`annotations/ink.ts`) applies the commit's dedupe (0.5 pt; ≥ 1.5 CSS px for a mouse) and
   centripetal Catmull-Rom (4 steps) to all but the last two points; the tip is raw plus
   prediction. Release adds only Douglas–Peucker (0.3 pt centre, 0.1 pt outline).
3. **Own linear prediction** when `getPredictedEvents()` is empty: from the last 3–4
   samples, horizon ≤ 16 ms (browser predictions capped too), ≤ 12 px or 4× width, off below
   0.05 px/ms, tapered to 0.8× width; never committed.
4. **Round joins** in `inkOutlineOps` above 45° instead of the clamped miter; old strokes
   change only when regenerated after an edit.
5. **Bake once, cache, cursor**: stable pieces fill once into an off-DOM canvas, frames copy
   the dirty box and fill the tip; the layer rect comes from pointer-down, a
   `ResizeObserver` and a passive scroll listener; `select(null)` is skipped when empty;
   opaque inks carry no CSS opacity. The cursor is a dot of the preset's colour and
   on-screen width (3–32 px) with a 1 px ring, a CSS `url()` SVG with a centred hot spot.
6. **No 160 ms debounce on edit repaints** (only scale changes debounce); thumbnails stay
   cached and repaint when idle. Expected: about 60 ms from pointer-up to pixels.

### 5.3 Dry ink and cheaper bursts

7. **Dry ink layer** per page: a synchronised canvas between page bitmap and wet canvas
   holding committed strokes drawn by us, tagged with the revision that will contain them,
   replacing the per-stroke settling canvas. The PDFium re-render waits for burst close,
   `requestIdleCallback` (2,000 ms timeout) with no pointer down, or a zoom or scroll beyond
   the layer; when revision *r* paints, strokes ≤ *r* clear in the same task. Thumbnail and
   neighbour renders pause while a pen is down.
8. **Cheaper bursts**: cached per-path outline operators (9–12 ms → under 1 ms per append at
   64 paths); paths and widths appended through raw host helpers instead of
   `updateAnnotation` with `regenerateAppearance` (13–21 ms saved); the open burst kept on
   the web side, the store patched instead of reloaded. Target ≤ 2 `listAnnotations` per
   burst.
9. **Clip repaint**: only the stroke's box re-renders (`renderPage` clip,
   `packages/engine/src/pdfium/pdfium-adapter.ts:538-547`).
10. **`pointerrawupdate` and the Ink API** (delegated ink trail, Windows 11 Chromium),
    feature-detected, only if the harness shows the remaining latency is presentation.

### 5.4 One Highlighter

The yellow preset becomes the Highlighter: constant width (12 pt), a tint at full opacity,
Multiply, no per-point widths; the wet canvas uses `mix-blend-mode: multiply`, not
desynchronised, so the preview is the result. On release a glyph counts as hit when the
stroke's band covers ≥ 50 % of its height; when hit glyphs cover **≥ 70 % of the stroke
along the reading direction** on each line crossed, it becomes a **Highlight** with quads
from first to last hit glyph per line (`annotations/quads.ts`), `/CA 1`, Multiply.
Otherwise it is **free ink with Multiply** (`blendMode` passed to EmbedPDF's
`EPDFAnnot_GenerateAppearanceWithBlend`, constant `/BS /W`, no widths). **Alt** forces free
ink; pages without text always give it. Free strokes join bursts.

**Highlight (H)** arms the Highlighter; a selection plus H still highlights it
(`annotations/selection-markup.ts`). Highlights become movable, erasable and lassoable; a
moved one keeps translated quads and its Review row says it no longer follows the text. The
matrix gains "Ink, Multiply (free highlighter)".

### 5.5 Lasso for every kind

| Kind | Taken when |
|---|---|
| Ink path | A point inside or a segment crossing (today) |
| Line, arrow, polyline, polygon | Vertices and segments as a path |
| Rectangle / ellipse | Its edges / 32 sampled points |
| Free text, stamp, signature image | A corner inside or an edge crossing |
| Note | Its icon rect |
| Text markups | Any quad touched |
| Links, redaction marks, widgets | Never |

Locked and hidden are skipped. The selection becomes `{ paths, whole }` with one bounding
box; the bar names the mix ("3 strokes, 1 arrow"). Move, delete, recolour, opacity and width
act across kinds in one history entry; `annotations/lasso/split.ts` is unchanged. **Group
resize and rotate** (P12): scale is affine for ink, line, polyline and polygon (ink widths ×
√(sx·sy)); rectangles and ellipses scale their rect, stamps keep aspect, free text scales
its font only under uniform scale, notes and markups move. Rotation is affine for ink,
line, arrow, polyline and polygon; rectangle, ellipse, free text and note orbit the centre
unrotated (PDF gives them no rotation); rotated stamps need an appearance `/Matrix` and are
deferred.

### 5.6 Eraser and delight

The eraser gains **Partial** beside **Stroke** (today): it splits ink paths where its
circle crosses them, interpolating widths, by the lasso split rule, one entry per drag. After
the core: hold to straighten (within 3 px for 500 ms → a straight line to the pointer),
Shift for straight Highlighter lines, an erase filter for highlighter strokes.

### 5.7 Corrections to spec M6

§6.5's ink-only lasso gives way to §5.5. §6.6: the outline is our own
`packages/engine/src/annotations/ink-outline.ts` (ADR-0018 §3); `perfect-freehand` is not
used, and mouse width follows §5.2 item 1. "The shape does not move at commit" (§6.6, §13
decision 7) held for the outline, not its input; §5.2 item 2 makes it true. §6.2's 40 %
yellow preset becomes the Highlighter.

## 6. Colour (ADR-0021)

One module, `annotations/palette.ts`, feeds presets, the preset editor, the contextual bar,
the inspector and the options tier.

| Role | Name | Hex | On white | Replaces |
|---|---|---|---|---|
| Writing ink (≥ 4.5:1) | Black | `#1a1a1a` | 17.40 | `#1F1F1F` |
| | Blue | `#1760ee` | 5.32 | `#1E5BD8`, `#1E88E5` (3.68) |
| | Red | `#db1c22` | 5.00 | `#E53935` (4.23) |
| | Green | `#02853c` | 4.75 | `#43A047` (3.30) |
| | Purple | `#8036d3` | 6.20 | `#8E24AA` |
| Accent ink (≥ 3:1) | Orange | `#e46910` | 3.32 | `#FB8C00` (2.37) |
| | Pink | `#e02c8a` | 4.29 | `#D81B60` |
| | Cyan | `#0891c9` | 3.56 | `#FFD400` as ink (1.43) |

| Highlighter tint (Multiply, opacity 1) | Hex | Black `#000` on it | Our black ink on it |
|---|---|---|---|
| Yellow | `#FFEA00` | 17.02 | 14.11 |
| Green | `#8CF26B` | 15.03 | 12.46 |
| Blue | `#8FD3FF` | 12.93 | 10.72 |
| Pink | `#FF9AD5` | 10.84 | 8.98 |

Multiply at full opacity keeps black text black in every viewer, as today's Highlight
annotations do.

- **Presets**: black 1.5 pt, blue 1.5 pt, red 2 pt, Highlighter yellow 12 pt; the editor
  offers the eight inks for pens and the four tints for the Highlighter, plus custom.
  Underline blue, strikeout red, squiggly green, shapes red, text black; stamps
  (`annotations/stamps.ts`) use the palette.
- **Migration** (`pdf-editor:ui:pen-presets:v1`, `pdf-editor:ui:tool-styles:v1` → `v2`): an
  old default becomes the new default of its role; custom colours stay; a translucent preset
  becomes the Highlighter with the nearest tint.
- **Swatches** keep the `--border-swatch` ring on dark chrome (black 1.09:1, purple 2.57:1
  on `--surface-2`).
- **Accent** `#7c8cff` stays (`oklch(0.681 0.169 275)`, the sRGB maximum chroma there is
  0.170; armed fill 3.03:1 on tier-1 glass over white). Vividness comes from content colour
  (presets; tag dots at full chroma, six palette hues ≥ 3:1 on `--surface-1`) and state
  alphas (`--accent-muted` 0.16 → 0.22, `--accent-line` 0.45 → 0.55 as starting values,
  kept only while current-row text stays AA). Owner A/B: `#7584fe` with glass brightness
  0.40 (armed fill 3.01:1).
- **Test**: `annotations/palette.test.ts` asserts every ratio above, Multiply at opacity 1,
  and that presets and swatches use the module; `styles/tokens.test.ts` covers alphas and
  tags.

## 7. Glass: spike S2 and the "Glass panels" setting

**Full-bleed stage.** Glass is worth it only where something moves behind it. The stage
runs under the title bar, navigator, inspector and status bar; fit, centring and
scroll-into-view use the unobscured rectangle (`stage/ReadView.tsx:53-55`, `:232`) in Read,
Arrange, Home, Compare and the drop overlay, re-fitting on panel resize. One layout serves
both settings.

| Tier | Surfaces | Tint | Filter | Over canvas | Over white |
|---|---|---|---|---|---|
| 1 Floating (unchanged) | Bar and tier, contextual bars, palette, mode control | `rgb(48 51 58 / 0.66)` | `blur(28px) saturate(1.8) brightness(0.45)` | `#212328` | `#47494d` |
| 2 Docked frame (setting) | Title bar, navigator, inspector, status bar | `rgb(29 31 37 / 0.80)` | `blur(40px) saturate(1.4) brightness(0.6)` | `#181a1f` = `--surface-1` | `#36373c` |
| 3 Menus, popovers | Menus, preset editor, popovers | `rgb(40 43 50 / 0.80)` | `blur(32px) saturate(1.6) brightness(0.5)` | `#212329` | `#393c42` |

Tokens `--glass-frame`, `--glass-frame-filter`, `--glass-frame-solid`, `--glass-menu`,
`--glass-menu-filter`, `--glass-menu-solid`. Worst case over white (tiers 1 / 2 / 3):
primary 7.29 / 9.60 / 8.94, `--glass-text-secondary` 4.94 / 6.50 / 6.05, `--glass-danger`
4.63 / 6.10 / 5.68, accent 3.03 / 3.99 / 3.71. Tier 2 equals `--surface-1` over the canvas,
so nothing changes at rest; its alpha never drops below 0.78. Tier 3 replaces tier 1 for
menus in beta.1; the setting switches tier 2 only.

- Blur is geometry-gated: with no page within 80 px, tier 2 paints its solid token unfiltered,
  pixel-identical. One filtered element per region; no glass inside glass; filters never
  animate.
- **Opaque**: text inputs, in-place editors, dialogs and scrim, tooltips, toasts, Home cards,
  thumbnails.
- **No shadow on docked glass**: a 1 px inner top highlight in `.glass-frame`, the one inset
  rule `tokens.test.ts` allows beside `--elevation-float`.
- **Reduce transparency**, an in-app switch (Safari lacks the media query):
  `[data-transparency='reduced']` on `:root` matches the reduced-transparency block, so every
  tier is solid with ring and shadow kept.

**S2 measures**, on a 50-page document with text and image pages and both panels open over
pages, on a 2020-class integrated GPU at DPR 2 in Chromium and Safari: frame rate while
scrolling and zooming, GPU memory with the setting off and on, and contrast of the three
tiers over white, the canvas, `#808080` and black in the `tokens.test.ts` model (axe cannot
see through `backdrop-filter`). **Pass**: under 1 % of frames over 16.7 ms, GPU memory up by
less than half, every glass text token AA and the accent ≥ 3:1 on all four backdrops, labels
legible over a page edge on the owner's screen. Report: `docs/research/14-glass-spike.md`.
**If S2 passes and the owner likes the live build**, A15 changes DESIGN §2's "everything
docked is opaque" and §3 gains tiers 2 and 3; if it fails, the setting goes and the layout
stays.

## 8. Model and engine changes

Additive; persisted keys versioned and validated field by field.

```ts
// state/ui-store.ts
export type ViewMode = 'read' | 'arrange' | 'compare';     // 'home' leaves
destination: 'home' | 'document';
documentMode: Readonly<Record<DocumentId, 'read' | 'edit'>>;  // session only
lastView: Readonly<Record<DocumentId, ViewMode>>;          // session only
canEdit(id: DocumentId): boolean;                          // guard behind every mutation
penDrawsInEdit: 'auto' | boolean; glassPanels: boolean;    // persisted in 'pdf-editor:ui:v2'
reduceTransparency: boolean; editTextHintShown: boolean;   // ToolId, tool, setTool removed
// viewer/tool-store.ts
export const BAR_GROUP_IDS = ['select', 'write', 'text', 'fill', 'redact'] as const;
eraserMode: 'stroke' | 'partial';                          // 'highlight' arms the Highlighter
// annotations/annotation-store.ts
interface LassoSelection { readonly paths: Readonly<Record<string, readonly number[]>>;
  readonly whole: readonly string[] }
// files/recents.ts (P2): IndexedDB 'pdf-editor:recents:v1' { name, size, openedAt, handle? }
// packages/engine/src/types.ts
interface LocatedRun { /* … */ readonly ascent: number; readonly descent: number;
  readonly fill: Rgba; readonly looseLineBox: Rect; readonly fontId: number }
interface ParagraphBlock { readonly ref: ParagraphRef; readonly lines: readonly Line[];
  readonly align: 'left' | 'right' | 'center' | 'justify'; readonly leading: number;
  readonly source: 'tags' | 'geometry' }
// EngineEdit gains { kind: 'text.editParagraph'; ref; text; layout; tier }
interface InkAnnotation { /* … */ readonly blendMode?: 'multiply' }
```

**Raw host wrappers** (`packages/engine/src/text-edit/raw.ts`, all in `@embedpdf/pdfium`
2.15.1): `FPDFFont_GetAscent`, `FPDFFont_GetDescent`, `FPDFText_GetLooseCharBox`,
`FPDFText_GetFillColor`, `FPDFText_GetMatrix`, `FPDFText_IsHyphen`,
`FPDFPageObj_GetBounds`; `FPDF_StructTree_GetForPage` / `_Close` / `_CountChildren` /
`_GetChildAtIndex` and `FPDF_StructElement_GetType` / `_GetMarkedContentIdCount` /
`_GetMarkedContentIdAtIndex` / `_GetActualText` / `_GetLang`; for the overlay
`FPDFGlyphPath_CountGlyphSegments`, `FPDFGlyphPath_GetGlyphPathSegment`,
`FPDFPathSegment_GetPoint`. Engine API: `analyzeParagraphs`, `applyParagraphEdit(edit,
{ commit })`, `renderParagraphPreview`. Ink: `blendMode` in `pdfium/annotation-mapping.ts`,
raw path append in `pdfium/host/annot-appearance.ts`.

## 9. Accessibility

| Surface | Keyboard | Semantics and announcements |
|---|---|---|
| Mode control | `1`–`4`; arrows in the radio group | "Read, locked"; "Edit mode" on change; a tool key in Read: "Edit mode. Blue pen" |
| Read bar, form notice | Tab to the Edit button (`aria-keyshortcuts="2"`), and from a field to its button | The notice is a polite status |
| Paragraph editor | With Edit text armed, Tab moves between paragraphs, Enter opens; Alt+J / Alt+S | The mirror is a multi-line `textbox`, "Paragraph on page 3"; honesty and overflow lines describe it |
| Hover outline and hint | The editor row is their keyboard equivalent | Never the only cue |
| Highlighter, lasso | Lasso edits via Review rows and the bar | "Highlighted 2 lines"; "3 strokes and 1 arrow selected" |

Targets ≥ 24 × 24; reduced motion and Reduce transparency respected; the lock glyph and
label carry the mode without colour; axe reports no violation on any new state.

## 10. Tests and acceptance

| Feature | Unit | Component | e2e |
|---|---|---|---|
| Modes, policy | destination, `documentMode`, `canEdit`, hit order, pointer roles | Read bar, form notice, hover after 400 ms | `modes.spec.ts`: tab click leaves Home; `1`–`4`; nothing moves, fills or arms in Read; each §3.5 row, including "a pen stroke over text never opens the editor" |
| Paragraph editor | detection, breaker, justification, overflow, kerning | caret, IME via the mirror | `paragraph-edit.spec.ts`: type, rewrap, one undo; honesty line |
| Pen, Highlighter, lasso | preview equals commit; mouse width; prediction cap; snap rule; per-kind hits | dry-layer swap; Multiply preview | `ink-latency.spec.ts` meets §5.1; snapped vs free highlights; arrow, note and strokes recoloured in one entry |
| Colour, glass | `palette.test.ts`, migration; `tokens.test.ts` three tiers × four backdrops | presets never "custom" | S2 |

**Text-edit corpus** (`test/fixtures/text-edit-corpus/`, fictional text): Word,
LibreOffice and Chrome "Save as PDF" exports (tagged), a LaTeX export (untagged, justified,
hyphenated, ligatures), an untagged two-column page, lists and captions, plus `tagged.pdf`,
`text-edit-fonts.pdf` and `text-edit-rotated.pdf`. Goldens: detected paragraphs and, for
scripted edits, the read-back, untouched glyphs within 0.01 pt, no pixel changed outside the
paragraph box, ≤ 4 ms per keystroke.

**Specs that change**: `e2e/tools.spec.ts:112-160` (five groups), `e2e/a11y.spec.ts:261`,
`:529` (group loops; Read and Edit axe states), `e2e/text-edit.spec.ts` (arming with `e`
at `:82`, `:146`, `:190`, `:242`), `e2e/home.spec.ts` (Home radio at `:123`, `:147`, `:249`,
`:278`), `e2e/compare.spec.ts:49-62`, `:146`, `:172`, and the seven specs pressing `0`–`3`
(light-table, viewer, resize, compare, export, crop, a11y).

**Exit** (ROADMAP M8): §5.1 met on CI and the owner's laptop; the corpus passes; §3.5
covered by e2e; contrast tests pass; the independent review finds no blocker; the owner's
pen try-out is recorded.

## 11. Work packages

Sizes: **S** ≤ 2 days · **M** ≤ 1–2 weeks · **L** > 2 weeks.

| Id | Scope | Files | Size | Depends on | Parallel |
|---|---|---|---|---|---|
| M1 | Home as a view, control, keys, tab click | `state/ui-store.ts`, `shell/Stage.tsx`, `shell/TabBar.tsx`, `home/home-actions.ts`, `commands/app-commands.ts`, `compare/compare-commands.ts` | M | — | yes |
| M2 | Read lock, `canEdit`, form notice, Read bar | `annotations/AnnotationLayer.tsx`, `annotations/commands.ts`, `forms/FormLayer.tsx`, `shell/FloatingToolbar.tsx` | M | M1 | after M1 |
| M3 | Five groups, page context menu, selection bar, strings | `viewer/tool-store.ts`, `shell/FloatingToolbar.groups.ts`, `annotations/tools.ts`, `stage/PageContextMenu.tsx` (new), `apps/web/messages/*.json` | M | M2 | after M2 |
| M4 | Policy, hit order, double-click, hover hint | `viewer/hit-order.ts` (new), `text-edit/TextEditLayer.tsx`, `image-objects/ImageLayer.tsx`, `viewer/TextLayer.tsx` | L | M3, T1 | after M3 |
| M5 | Recents (P2) | `files/recents.ts` (new), `files/open-files.ts`, `home/HomeView.tsx` | M | M1 | yes |
| T1 | Editor speed-ups (§4.8) | `packages/engine/src/text-edit/editor.ts`, `analysis.ts`, `editability.ts`, `text-edit/TextEditor.tsx` | M | — | yes |
| T2 | Wrappers, enriched runs, structure tree, `TJ` | `packages/engine/src/text-edit/raw.ts`, `locate.ts`, `content.ts`, `struct-tree.ts` (new) | S | — | yes |
| T3 | Detection | `packages/engine/src/text-edit/blocks.ts` (new), `convert/layout.ts` | M | T2 | after T2 |
| T4 | Rewrap, justification, overflow | `packages/engine/src/text-edit/linebreak.ts` (new), `NOTICE` | M | T2 | yes |
| T5 | Writer, verification, replay | `packages/engine/src/text-edit/apply.ts`, `finalize.ts`, `packages/engine/src/edits/text-edit.ts` | L | T3, T4 | after T3 |
| T6 | Overlay, plate, mirror, preview | `text-edit/ParagraphEditor.tsx` (new), `text-edit/glyph-canvas.ts` (new) | L | T2 | yes |
| T7 | Fonts, honesty line | `packages/engine/assets/fonts/`, `packages/engine/src/fonts/bundled-fonts.ts`, `packages/engine/src/text-edit/fonts.ts` | M | T5 | after T5 |
| T8 | Corpus, goldens | `test/fixtures/text-edit-corpus/**` (new), `apps/web/e2e/paragraph-edit.spec.ts` (new) | M | T3, T5 | partly |
| P6 | Latency harness | `annotations/pen/ink-stats.ts` (new), `apps/web/e2e/ink-latency.spec.ts` (new) | M | — | yes |
| P7 | §5.2 items 1–6 | `annotations/pen/ink-input.ts`, `ink-preview.ts`, `annotations/ink.ts`, `packages/engine/src/annotations/ink-outline.ts`, `pages/PageCanvas.tsx` | M | P6 | after P6 starts |
| P8 | Dry ink layer | `annotations/pen/dry-ink.ts` (new), `viewer/read-controller.ts` | M | P7 | after P7 |
| P9 | Cheaper bursts, clip repaint | `annotations/pen/bursts.ts`, `annotations/actions.ts`, `packages/engine/src/pdfium/host/annot-appearance.ts` | M | P6, P8 | yes |
| P10 | Highlighter | `annotations/pen/highlighter.ts` (new), `annotations/quads.ts`, `packages/engine/src/pdfium/annotation-mapping.ts` | M | C1, M3 | after C1 |
| P11 | Lasso for every kind | `annotations/lasso/geometry.ts`, `lasso/edits.ts`, `annotations/annotation-store.ts` | M | — | yes |
| P12 | Group resize and rotate | `annotations/lasso/transform.ts` (new), `annotations/geometry.ts` | L | P11 | after P11 |
| P13 | Partial eraser, delight items | `annotations/pen/eraser.ts` (new), `annotations/lasso/split.ts` | M | P11 | after P11 |
| P14 | `pointerrawupdate`, Ink API | `annotations/pen/ink-presenter.ts` (new) | S | P6 result | conditional |
| C1 | Palette, migration, tags, alphas | `annotations/palette.ts` (new), `annotations/pen/presets.ts`, `annotations/annotation-store.ts`, `styles/tokens.css` | S | — | yes |
| G1 | Full-bleed stage, tiers, setting | `shell/AppShell.module.css`, `stage/ReadView.tsx`, `styles/global.css`, `styles/tokens.test.ts` | L | — | yes |
| S2 | Glass measurements, report | `docs/research/14-glass-spike.md` (new), `apps/web/e2e/glass-perf.spec.ts` (new) | S | G1 | after G1 |
| A11 | Accessibility (§9) | `shell/announcer.ts`; fixes by each owner | S | M2–M4, T6, P10, P11 | no |
| QA | e2e and rewritten specs (§10) | `apps/web/e2e/*.spec.ts` | M | each feature | partly |
| D1 | A8–A15, specs, screenshots, ROADMAP, changeset | `docs/DESIGN.md`, `docs/specs/*.md`, `docs/ROADMAP.md`, `.changeset/*` | S | all | no |
| R | Independent review; correctness of T5 and P9 | read-only | — | all | no |

**Order.** (1) P6, T1, T2, C1, P11, M1, G1 in parallel, P6 first. (2) P7, M2, T3, T4, P10.
(3) M3 then M4; P8, P9; T5, T6; P12, S2. (4) T7, T8, P13; P14 only if P6 says so; M5 when
there is room. (5) A11 and QA as features land; D1, R and fixes.

Rules as in M4–M6: one implementer per package, no edits outside owned paths (shared stores
take additive edits, merged by the lead), the lead commits, every R finding gets a test.

## 12. Two drops

**Drop 1** (tagged `1.0.0-beta.1` when the owner says so): modes (M1–M4), the pen harness and smoothness batch (P6, P7), the palette
(C1), the Highlighter (P10), lasso for every kind (P11; P12 if ready), the text-edit
speed-ups (T1, T2) and glass behind the setting (G1, S2). Exit: §5.1's preview targets, the
committed stroke within 60 ms, §3.5 covered, contrast tests green, no blocker in review.

**Drop 2** (`1.0.0-beta.2` likewise): the paragraph editor (T3–T8), the dry ink layer (P8), the remaining pen
items (P9, P13, P14 if warranted, P12 if it slipped), Recents (M5) if it fits. Exit: §10.

## 13. Decisions

| # | Decision | Reason |
|---|---|---|
| 1 | Home leaves `ViewMode`; the lock is a per-document flag | "Which view" and "may it change" are separate; 33 sites stay valid |
| 2 | Double-click with Select opens the paragraph editor; never touch or a drawing pen | "Click a text and type", in the Word habit, without single-click slips |
| 3 | Five groups; Pages and Mark up dissolve | Each tool has one home |
| 4 | Keys `1`–`4` follow the control | Keys match what is seen |
| 5 | Document menu and Arrange stay usable in Read | Deliberate dialogs with undo; the lock guards against slips |
| 6 | Undo and Redo work in Read | What Read allows must be undoable there |
| 7 | Tier B now; C and D never | Research 11's ceiling; the owner dropped C on 2026-10-03 |
| 8 | A background plate under rewritten lines | Hides old glyphs, keeps coloured boxes |
| 9 | Leaving the editor commits | Losing typed text is worse than one undo |
| 10 | No new hyphenation in M8 | Needs a library and language data |
| 11 | Tighten spacing within floors, never shrink | Invisible beside untouched text |
| 12 | One stroke model; constant mouse width | No snap, no swelling |
| 13 | Dry ink with deferred renders | The next stroke never waits for PDFium |
| 14 | Highlighter snaps at 70 %; Alt for free ink | One tool; the stroke decides |
| 15 | Lasso takes every kind, within PDF's geometry | The notes-app habit, honest limits |
| 16 | One palette; yellow only as a tint | Inks ≥ 4.5:1; no "custom" surprise |
| 17 | Glass panels behind a setting, one layout | Measured before it becomes the design |

## 14. Open questions for the owner (answered 2026-10-03)

The owner left 1–4 to the lead, accepted the approach and the changes, and dropped 5. The
lead's answers:

1. **Double-click** on page text in Edit stays, with the Edit text tool (E) as the one-click
   path; the policy in §3.5 is final.
2. **Document menu in Read** keeps its file-rewriting operations: they are dialogs with a
   preview and undo, and Read guards against slips, not against intent.
3. **Recents** keep a file handle where the browser hands one out (Chromium's
   `showOpenFilePicker`), names only elsewhere; "Clear recents" always.
4. **Accent** `#7c8cff` stays; no A/B.
5. **Tier C** is dropped (owner). ADR-0020 §1 and §4.6 updated.

Versioning: the two drops of §12 are planning units; a drop becomes `1.0.0-beta.1` or
`beta.2` only when the owner says so.
