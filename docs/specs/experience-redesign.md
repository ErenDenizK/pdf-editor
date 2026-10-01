# Spec: Experience redesign (M6)

**Status:** draft (2026-10-01) · **Milestone:** M6 (beta with M7) · **Owner:** project lead

M1–M5 built the features; the owner's verdict after M5 is that the experience is not
right yet. This spec turns the experience audit (`docs/design/experience-audit-2026-10.md`)
into one plan: a Home view, a smaller navigator, a tool bar grouped by task, a pen that
writes without interruption, merging that can be found, and a visual refresh. The project
lead's decisions are specified, not reopened; §14 holds the two questions for the owner.

## 1. Problem

### 1.1 Owner feedback (2026-10-01, `DISCUSSION.md` #23; in translation, condensed)

"The features are good, but the app is too complicated." · "The tabs on the left carry too
much detail." · "There is no home page for several PDFs, and no way to merge the files I
have open." · "The pen opens a menu after every stroke. It should write like Notability,
with a lasso to edit afterwards." · "The glass and the floating chrome should have more
contrast, and look elegant and alive." · "Design how it feels: pick from a bottom menu,
click to edit."

### 1.2 Audit evidence

Build `b66d45d`, 1440×900, Chromium with SwiftShader. Screenshot names refer to the audit
archive; the eight marked † are copied to `docs/design/audit-2026-10/`.

| # | Finding | Evidence |
|---|---|---|
| 1 | Every pen stroke selects itself 86 ms after pointer-up: dashed box, 8 handles, a 576 px style bar over the line written before it, and the inspector switches to Properties | `33-pen-three-strokes.png` †, `32-pen-after-stroke-1s.png` |
| 2 | Tool colour and width cannot be set before drawing; a change applies to one stroke and is forgotten (`setStyle` is never called in `src/`) | `21-tool-ink-armed.png`, `34-pen-colour-not-remembered.png` † |
| 3 | Merge is not on screen, not in the Document menu, and Arrange shows only the active document of three | `11-document-menu.png` †, `50-arrange-default-one-doc.png` † |
| 4 | One stroke is one annotation, one Comments row ("Ink · No author · No comment text") and one undo step | `43-rail-comments-with-annotations.png` † |
| 5 | 18 unlabelled tool bar icons of equal weight; the armed tool contrasts at 1.24:1; three page actions are disabled, one permanently "coming soon" | `27-toolbar-2x-crop.png` † |
| 6 | Five regions at once: tabs, 7-tab rail, page, tool bar, inspector open on a metadata form. Panels lead with settings and warnings | `02-read-default.png` †, `03-rail-05-redactions.png` † |
| 7 | Canvas and panels differ by 1.05:1; the glass reads as a grey slab; nothing floats | `02-read-default.png`, `27-toolbar-2x-crop.png` |
| 8 | Vocabulary: "pen" and "draw" do not find the Ink tool; "sign" names two different features | `57-palette-search-sign.png`, `55-palette-search-merge.png` |
| 9 | The stroke blinks at commit (preview removed before the page redraws); the preview is unsmoothed; no pressure, no coalesced events; fingers draw and cannot scroll | `35a-pen-frame-0ms-after-up.png`, `35b-pen-frame-30ms-after-up.png` |

First run: 9–12 interactions from an empty app to a merged file on disk, two dead ends.

## 2. Principles kept and amended

Kept: the document is the only bright thing; one accent; glass only for floating chrome;
keyboard path and palette entry for every action; Esc clears tool and selection; undo, not
confirmation; inline honesty notices; no marketing surface. Amendments (WP D1; A4 waits
for §14 Q1):

| # | Rule | Current text | New text | Why |
|---|---|---|---|---|
| A1 | DESIGN §1, §3 "No drop shadows" | "No drop shadows on working surfaces; elevation is a tonal step plus a hairline … the only `box-shadow`s are the page hairline, the inset hairline of a view switch and 1px on-page rings." | "Docked surfaces are flat: elevation is a tonal step plus a hairline. Floating chrome carries exactly one elevation token, `--elevation-float` (hairline ring, 1 px inner top highlight, one soft shadow). No other shadow, glow or halo." | Over the canvas the bar's fill differs by 1.03:1 (§7.2); one token keeps "nothing glows" |
| A2 | DESIGN §2 contextual bar; annotations spec §2 | "a second, contextual bar appears above a selection" / "A contextual bar above the selection replaces property dialogs" | "Creating does not select. A tool's options live with the tool, attached to the tool bar while it is armed. A selection's options live with the selection, which exists only after an explicit select or lasso." | Friction 1 and 2: the selection rule was applied to creation |
| A3 | DESIGN §3 "Color is for state" | "Color is for state, never decoration" | "Chrome colour is for state. Colour enters through content: pen presets are dots of their real ink, files keep their tag dots. Chrome is never tinted; the accent stays its only colour." | The owner asks for more colour; content colour adds it without decorating |
| A4 | DESIGN §2 Layout | Left rail "Pages, Outline, Files"; right panel shows document info when nothing is selected; the tool bar "shows the tools of the current mode" | Home view (§3); navigator with four labelled tabs and counts (§4); inspector closed by default, metadata in a Document info sheet; tool bar grouped by task (§5). Diagram redrawn | §7 of DESIGN ruled out structural change for the last pass; this one is structural |
| A5 | DESIGN §3 state patterns | "an option choice is `--accent-muted` … (presets, segments, …, the active tool)" | "The active tool is a solid `--accent` fill with a `--surface-0` icon. Other option choices keep `--accent-muted`." | Armed state at 1.24:1 today; 3.43:1 worst case after (§7.3) |
| A6 | DESIGN §3 radius, motion | "10 bars, dialogs"; popups enter from `scale(var(--enter-scale))` | Floating tool bar and pen bar are capsules (`--radius-round`). Popovers attached to the bar rise 4 px with opacity over `--duration-fast`; reduced motion shows them at once | §7.3, §7.5 |
| A7 | Annotations spec §3, Ink row | "Freehand drag, pressure ignored, smoothing (Catmull-Rom → Bézier)" | "Freehand; width from pressure (pen) or speed (mouse, touch); `/InkList` centre lines with a constant `/BS /W`; the varying width lives only in our appearance stream (after S1). Strokes written in a burst share one annotation." | §6.4, §6.7 |

## 3. Home

**What it is.** A fourth stage view, `home`, beside Read, Arrange and Compare: the first
view after a drop of two or more files, and the empty state when no file is open. It is
reached by the app glyph (top left), `0` (1/2/3 stay Read/Arrange/Compare), "Show Home" in
the Files tab and the palette. A single dropped file still opens in Read.

**Cards.** One card per open document, in tab order, on `--surface-2`: first-page thumbnail
(160 px wide), name (middle-truncated), "12 pages · 2.8 MB" (current page count; size of the
file as opened), the tag dot, and an "edited" dot when there are unexported changes. Hover
or focus shows a checkbox, a close button and a ⋯ menu (Read, Arrange pages, Compare with…,
Combine with…, Document info…, Close); checkboxes stay while anything is selected. A last
card, "Open or drop PDFs", opens the file picker; the whole view is a drop target.

**Header row.** "3 files · 41 pages", then "Open…", "Arrange pages", "Compare" (exactly two
selected) and the primary **"Combine N files"**: none selected → "Combine all 3 files"; two
or more → "Combine 2 files"; one → not shown (no disabled state). It opens the existing
merge-all dialog (`stage/OperationDialogs.tsx`) in tab order, or selection order when there
is one. "Arrange pages" opens Arrange with the selection (all when none).

**Drag to merge.** A card dragged onto another marks it with the 1 px accent ring and
"Combine with report.pdf"; dropping opens the same dialog with [target, dragged]. Nothing
merges without the dialog. Dropping between cards reorders the documents and the tabs.

**Empty state.** The same view with no cards: the drop target, the text "Drop PDFs here or
open them. With two or more open you can combine them, arrange their pages together or
compare them.", and three shortcuts as keycaps (Open, Command palette, Keyboard map). No
tips, no promotion, no sample files (DESIGN §4.5).

**Out of scope.** Recent local files (File System Access handles in IndexedDB, with a
Safari fallback) are a later item.

## 4. Navigator

### 4.1 Four tabs

The left rail becomes a navigator of four labelled tabs: icon, an 11 px label under it, a
count badge on the icon (tabular numerals, hidden at 0, "99+" above 99). The rail widens
from 44 to 64 px.

| Tab | Content first | Count | Folded settings |
|---|---|---|---|
| Pages | Thumbnails of the active document; a "Pages · Bookmarks" switch at the top shows the outline instead | pages | "Add bookmark" sits in the Bookmarks view only |
| Find | Field, Aa / ab toggles, "1 of 7", ↑↓, results by page | matches | "Mark all N matches for redaction" moves to the panel's ⋯ menu and to the Redact group |
| Review | One list of Comments, Redaction marks and Form fields, grouped by page; filter chips All · Comments · Redaction marks · Form fields, each with a count, shown only for kinds present | items | see below |
| Files | The Home cards in compact form: 32 px thumbnail, name, pages, size, tag; same selection, same "Combine N files" button at the bottom; "Show Home" link | open files | none |

Review rows: kind icon, label, comment or covered text; author and date only when set ("No
author · No comment text" is never printed). A pen annotation is one row, "Pen · 5
strokes". Enter on a row selects the item on the page (an explicit select, §5.2).

Settings move out of the way:

- **Author name**: asked once, inline, at the first comment or note ("Name on your
  comments [______] Save · Skip"); either answer sets `authorAsked`. Editable later from
  the palette ("Set comment author name…").
- **Redaction**: one line, "Marks hide nothing until you apply them. Why?", expanding to
  today's text. "Find sensitive data" and "Apply redactions…" show in the Redaction marks
  filter only when marks exist, and always in the Redact group.
- **Forms**: Highlight fields, Edit fields, Clear all and Flatten on export show in the
  Form fields filter only when the document has fields; "Add field" is in Fill & sign.

Compare's Changes list stays a tab, shown only in the Compare view and placed last, so the
other four never move.

### 4.2 Inspector and Document info

The right inspector is closed by default, opens only from its title bar toggle (state
remembered), keeps Selection (author, dates, comment) and History, and loses the style
controls that duplicate the contextual bar. Name, size, pages, dates, metadata and security
move to a **Document info** side sheet (Document menu, card and row ⋯ menus, palette).

## 5. Tool bar and Document menu

### 5.1 Groups

The floating bar at rest shows six labelled groups (icon and text): Read · Mark up · Draw ·
Fill & sign · Pages · Redact. Picking a group swaps the bar to that group's tools; the
first item then names the group with a chevron and returns to the group row.

| Group | Tools (key) |
|---|---|
| Read | Select (V), Find (Mod+F), Page layout ▾, Fit ▾ |
| Mark up | Highlight (H), Underline (U), Strikeout (S), Squiggly, Note (N), Text box (T) |
| Draw | Pen (P) with its presets (§6.2), Eraser (Shift+E), Lasso (Q, new), Shapes ▾ (R, O, L, A) |
| Fill & sign | Highlight fields, Add field ▾, Signature image (G), Stamp ▾ (Shift+I), Sign with certificate… |
| Pages | Edit text (E), Image (I), Crop…, Rotate (R / Shift+R when pages are selected, as today), Delete page, Arrange (2) |
| Redact | Mark (X), Find sensitive data…, Mark search matches, Apply redactions… |

Rotate and Delete page act on the selected pages, else the current page, and say which
("Rotate page 3"). "Extract pages" leaves the bar until it exists. Every shortcut stays and
also shows its tool's group; the palette stays (§8 adds keywords).

### 5.2 Behaviour

- **Options with the tool.** While a tool is armed, its options sit in a second tier
  attached to the top of the bar (never floating over the page): colour swatches and
  opacity for text markup, colour, fill and width for shapes, font size and colour for the
  text box, presets for the pen (§6.2). Changing them changes the tool (§6.3).
- **Shape of the menu.** Picking a group does not open a radial menu, a drawer or a sheet:
  the capsule bar morphs in place. The chosen group's chip slides to the left end and the
  group's tools slide in beside it (one 160 ms movement, none under reduced motion); the
  bar keeps its height, its anchor and its glass. Options are a second tier that rises from
  the top edge of the bar and stays attached to it; popovers for pickers (shapes, stamps,
  the pen preset editor) rise from their button. Reasons: a radial menu hides labels and
  is slow with a mouse; a drawer covers the page; an in-place morph keeps the user's eye
  and pointer where they were and reads the same on a tablet.
- **Editing near a selection** happens only after an explicit select (Select tool click,
  a Review row, Tab to an annotation) or a lasso. Then the existing contextual bar appears
  above the selection and edits it.
- **One-shot tools** (stamp, signature image) return to the previous tool; the placed
  object is not selected.
- **Esc** disarms the tool and clears the selection; with nothing armed, Esc on the bar
  returns to the group row. The stage keeps bottom padding so a page's last lines can
  scroll above the bar. Arrange shows only its own selection bar, never two bars.

### 5.3 Document menu

The unlabelled `FileCog` button becomes "Document" (icon and text), with section headings
and no disabled twins: "Remove X" appears only when X exists.

| Section | Items |
|---|---|
| Combine and split | Merge files…, Split…, Compare with…, Rotate pages… (all four new to this menu) |
| Add to pages | Page numbers…, Header and footer…, Bates numbering…, Watermark…, and their "Remove" items when present |
| Protect and sign | Set password… / Change or remove password…, Sign with certificate…, Strip metadata… |
| Convert and export | Export…, Export pages as images…, Export as Markdown / text…, Recognize text (OCR)…, Compress…, Batch… |
| Document | Document info…, Add bookmark at current view, Remove dead bookmarks (when any), Save repaired copy (when repaired) |

## 6. Pen ("natural ink")

### 6.1 Writing is never interrupted

- Creating never selects and never opens a bar or the inspector: the default of
  `createAnnotations(..., { select })` becomes `false` (ink, text markup, shapes).
- The preview stays until the page has redrawn: it is cleared in the first animation frame
  after the page bitmap of the committing generation is painted (`whenPainted`, §9). A
  failed commit clears it and the live region says "Stroke not saved".
- A press while an inline editor is open commits the editor and starts the stroke in the
  same press (today the stroke is lost).

### 6.2 Pen bar and presets

The Draw group holds four presets as ink dots, then Eraser, Lasso and Shapes. Defaults:
black `#1f1f1f` 1.5 pt; blue `#1e5bd8` 1.5 pt; red `#e53935` 2 pt; yellow `#ffd400` 12 pt
at 40 % (highlighter). Tap a preset to arm it; tap the armed one again for its editor, a
popover rising from the bar: 8 swatches plus custom, width 0.25–24 pt (stops and slider),
opacity. Edits change that preset and persist per device. Nothing opens on its own.

### 6.3 One style rule

`applyStyle(patch)` replaces direct calls: with a selection it edits the selection
(`updateAnnotations`, coalesced as today); without one it calls `setStyle(group, patch)`
for the armed tool and, for the pen, updates the armed preset. Tool styles persist
(`pdf-editor:ui:tool-styles:v1`).

### 6.4 Bursts: many strokes, one annotation

A new stroke joins the open burst when (1) document, page and preset are the same; (2) the
pause from the previous pointer-up to this pointer-down is ≤ **N = 1,500 ms**; (3) the
horizontal gap between this stroke's bounds and the burst's bounds is ≤ **D = 36 pt** in page
space (zoom does not change it); (4) it is on the line of the burst's last stroke: their
vertical bands (centre-line y ranges, at least 4 pt tall) overlap by ≥ 30 % of the smaller
band, or, when they do not overlap at all, are ≤ 0.6 × the burst's median band height apart;
and (5) the burst has fewer than 64 paths. Rule (4) keeps the dot of an i, the bar of a t and
an underline in the word's burst, while the next line of writing (a 10 pt gap under 8 pt
letters, or an ascender reaching less than 30 % into the line above) starts a new one, though
it is within D. (As built after the M6 review: D was a distance in any direction, and at
normal line spacing two lines became one annotation.) The first stroke creates an Ink
annotation; each joining stroke appends a path through `annotation.update` with the burst's
`coalesceKey`, so a burst is one history entry ("Pen on page 1 · 5 strokes") and one Review
row. While a burst of several strokes is open and its entry is the present one, Mod+Z
removes only its last stroke: the entry keeps its key with one path fewer, the burst stays
open, and a rewritten stroke joins it; with one stroke left Mod+Z is the ordinary undo. A
stroke whose append was still queued when the history moved is not saved ("Stroke not
saved") rather than coming back as an annotation of its own. A burst closes on a tool or
group change, Esc, an undo or redo of the entry, a selection, a page or document change, a
preset edit, window blur, or when N passes. N and D are constants in `pen/bursts.ts`,
overridable in the stored pen settings (300–5,000 ms, 6–144 pt) with no UI; the line rule's
30 %, 0.6 and 4 pt are constants there too. The defaults assume word gaps well under a second
and 18–30 pt line spacing in normal handwriting; P2 confirms them with the owner on a tablet
before M6 exits. The eraser removes the path under it (`annotation.update`), and the
annotation with its last path.

### 6.5 Lasso

Lasso (Q) draws a closed freehand region with a 1 px accent line. On release it selects
every ink path it touches: a path with at least one point inside the region (even–odd
rule), or with a segment that crosses the lasso line. Locked and hidden inks are skipped;
other annotation kinds are left to the Select tool. (As built in P5: the draft rule, "at
least half of its points inside, and every other annotation whose rect lies wholly
inside", was replaced by this touch rule, so a lasso drawn across a stroke takes it.) Only
the taken paths are highlighted, in the accent at the highlight alpha, and the contextual
bar sits above them with colour, width, opacity, a move grip and delete; dragging inside
the selection bounds moves it; arrows nudge 1 pt (Shift: 10 pt); Delete removes the taken
paths; Esc clears the selection and keeps the Lasso armed; a press outside clears it. An
edit to some paths of a grouped annotation splits it: those paths become a new Ink
annotation (same author, new `/NM`, no comment) in the same history entry ("Recolour 3
strokes"), and the original keeps its id, comment and other paths; a delete removes the
taken paths from it. Per-point widths stay parallel to their paths on both sides; a width
change scales them with the nominal width, and a move translates points only. The rule is
in `annotations/lasso/split.ts`.

### 6.6 Input

- Native pointer handlers on the page layer while the pen is armed; no React state per
  move. Points (x, y, pressure, time in page space) go into a growable `Float32Array`,
  read from `getCoalescedEvents()` when present; `getPredictedEvents()` points are drawn
  for the current frame only, never committed.
- The preview is one `<canvas>` per page (device pixel ratio, `desynchronized: true` where
  supported), redrawn once per frame by the outline function used at commit.
- **Width**: `perfect-freehand` 1.2.3 (MIT, no dependencies) builds the outline from
  pressure for `pointerType === 'pen'` and from speed for mouse and touch; the preset width
  is the nominal width. `/InkList` keeps the centre line (dedupe 0.5 pt → Catmull-Rom →
  Douglas–Peucker 0.3 pt, as today); the outline is simplified at 0.1 pt.
- **Fingers and palms**: once a `pen` pointer has been seen in the session, touch never
  draws: one finger pans the stage, two zoom through the existing anchored zoom. Touch is
  ignored while a pen is down, for 300 ms after, and when its contact exceeds 40 CSS px.
  Before a pen is seen, touch draws (phones). The layer keeps `touch-action: none` while a
  drawing tool is armed (browsers apply it to pens too); our pan has no inertia in M6.

### 6.7 Variable width in the file: spike S1

Ink annotations have no standard per-point width. The format: `/InkList` holds centre
lines, `/BS /W` the nominal width, **our appearance stream** fills the variable-width
outline, and a private `/PdfEditorInkWidths` array (per-point widths parallel to `/InkList`,
like `/PdfEditorOCR`) lets a later session regenerate the appearance after an edit. Viewers
that redraw ink from `/InkList` show it at the nominal width.

**S1 — Ink appearance spike** (`docs/research/09-ink-appearance-spike.md`), on the corpus
and the matrix sample: (1) can the PDFium host (ADR-0011 raw module) set our appearance on
create and update (`FPDFAnnot_SetAP`), does our PDFium render it rather than generate one,
and does a later `regenerateAppearance` update overwrite it; (2) does pdf.js render it with
the right colour, opacity and placement, `/Rotate 90` included; (3) do `save()`, flattening
and export verification keep it, and what does a 64-path annotation cost in bytes and
update time; (4) two new matrix rows, "Ink, variable width (appearance)" (drawn width
varies along the stroke within tolerance in both renderers) and "Ink `/BS /W` equals the
nominal width" (data).

Exit: pass → ADR-0018 records the format and P4 builds it. Fail → committed strokes are
constant width, and so is the preview (what is drawn is what is saved); pressure becomes a
later item and A7 says so. With pressure on, the pen popover carries one honesty line:
"Width changes are stored in the stroke's appearance. Viewers that redraw ink themselves
show it at one width."

## 7. Visual system

### 7.1 Surface ladder

The canvas gets darker and docked surfaces step up, so page and bar sit in a near-black
field and the frame reads as a frame. Ratios are WCAG; L* (CIE) shows dark steps better.

| Token | Use | Current | New | L* now → new | Step to previous, now → new |
|---|---|---|---|---|---|
| `--surface-0` | canvas, Home background | `#0a0b0d` | `#08090b` | 3.0 → 2.4 | — |
| `--surface-1` | panels, title bar, status bar, navigator | `#101215` | `#181a1f` | 5.4 → 9.3 | 1.05 → 1.14 |
| `--surface-2` | raised: cards, inputs, `--glass-solid` | `#16181c` | `#1f2227` | 8.2 → 13.1 | 1.06 → 1.09 |
| `--surface-3` | view switch on, disabled primary | `#1c1f24` | `#272a30` | 11.6 → 17.0 | 1.08 → 1.11 |
| `--text-tertiary` | tertiary text | `#858a92` | `#8f949c` | — | 4.14 → 4.71 on new surface-3 |

Text stays AA on every new surface: primary 11.6–16.1, secondary 5.35–7.41, tertiary
4.71–6.53, accent 4.83–6.69, danger 5.18–7.18. The white page against the canvas is 19.9:1.

### 7.2 Glass and elevation

```css
--glass: rgb(48 51 58 / 0.66);                          /* was rgb(24 26 31 / 0.5) */
--glass-filter: blur(28px) saturate(1.8) brightness(0.36); /* was blur(24px) … (0.4) */
--glass-solid: var(--surface-2);
--elevation-float: inset 0 1px 0 rgb(255 255 255 / 0.08),  /* inner top highlight */
                   0 0 0 1px rgb(0 0 0 / 0.5),             /* hairline ring */
                   0 8px 24px -8px rgb(0 0 0 / 0.55);       /* the one soft shadow */
```

Computed for a flat backdrop (tint over the darkened backdrop, border excluded): over the
canvas the bar goes from `#0e0f12` (L* 4.3, 1.03:1 to the canvas) to `#212328` (L* 13.7,
1.27:1); over a white page the worst case stays `#3f4145` (today `#3f4043`), so glass text
keeps its margin: primary 8.27, `--glass-text-secondary` 5.14, `--glass-danger` 4.51,
warning 6.28. The token applies to the tool bar, contextual bars, palette, menus and
popovers; docked surfaces, dialogs and tooltips stay flat. Reduced transparency: solid
glass, ring and shadow kept. `prefers-contrast: more`: no shadow or highlight, border
`--border-strong`. Forced colours: `Canvas` with a `CanvasText` border.

### 7.3 Capsule bar and active state

Both bars are capsules (`--radius-round`, 44 px, 36 px targets). Group buttons have text
labels; the shown group uses the view-switch "on" look. The armed tool is a solid
`--accent` fill with a `--surface-0` icon: icon 6.69:1; fill against the bar 5.28:1 over the
canvas and 3.43:1 over a white page (worst case), against 1.24:1 today.

### 7.4 Ink dots

A preset is a dot of its real colour with the `--border-swatch` ring, 8, 11 or 14 px for
widths ≤ 1, ≤ 3 and > 3 pt, in a 28 px target; opacity below 1 draws a short capsule (a
highlighter mark). The armed preset gets a 2 px accent ring, not a fill, so its colour
shows. These dots and the tag dots are the only chrome colour besides the accent.

### 7.5 Motion

Bar popovers rise from `translateY(4px)`, opacity 0, over `--duration-fast` `--ease-out`;
the bar's width follows a group change over `--duration-base`. Reduced motion sets both to 0.

### 7.6 Light theme

WP L1: `[data-theme='light']` on the same tokens, a System · Dark · Light toggle, the same
contrast test plus white page vs light canvas ≥ 1.3:1. Moved to M8 by the owner on
2026-10-01 (§14 Q2); the tokens of §7.1 are written so that a light ladder can be added
without renaming anything.

## 8. Wording and discoverability

| Today | New | Where |
|---|---|---|
| Ink | **Pen** | tool, Review rows, history ("Pen on page 1 · 5 strokes"), messages |
| Signature (G) | **Signature image** | tool and palette; tooltip "A picture of your signature, not a digital signature" |
| Sign… | **Sign with certificate…** | Document menu, palette |
| Arrange (palette) | Arrange pages | palette and tooltip; the view switch keeps "Arrange" |
| Interleave, Bates numbering, Flatten | kept, with a one-line gloss in the dialog subtitle | dialogs |
| "Drop several to combine them" | the §3 empty-state text | Home |
| `FileCog` icon | "Document" | title bar |

Palette keywords move into the messages (`cmd_<id>_keywords`) and the palette matches the
keywords of **both** UI languages, case- and diacritic-insensitive with Turkish folding
(ç→c, ğ→g, ı/İ→i, ö→o, ş→s, ü→u). Minimum sets: Pen: draw, pencil, handwriting, scribble,
sketch, kalem, çiz, çizim, el yazısı · Merge: combine, join, append, birleştir ·
Split: separate, böl, ayır · Compare: diff, karşılaştır · Signature image: signature,
imza · Sign with certificate: digital signature, certificate, dijital imza, sertifika ·
Recognize text: OCR, scan, metin tanı · Redact: black out, karart · Rotate: döndür.

Arrange shows every open document by default ("Show in Arrange" becomes "Hide from
Arrange"). Merge is reachable from Home, the Files tab, the Document menu, tabs and palette.

## 9. Model and engine changes

All changes are additive; persisted settings get versioned keys with field-by-field
validation like `parseLayout`.

```ts
// annotations/pen/presets.ts — key 'pdf-editor:pen:v1' in safe-storage
export interface PenPreset { readonly color: string; readonly width: number; // #rrggbb, pt
  readonly opacity: number }                                               // 0.1–1
export interface PenSettings { readonly v: 1; readonly active: 0 | 1 | 2 | 3;
  readonly presets: readonly [PenPreset, PenPreset, PenPreset, PenPreset];
  readonly burstPauseMs?: number; readonly burstGapPt?: number;
  readonly authorAsked?: boolean }
// annotations/pen/ink-burst.ts
export const INK_BURST_PAUSE_MS = 1500, INK_BURST_GAP_PT = 36, INK_BURST_MAX_PATHS = 64;
export interface InkBurst { readonly annotationId: string; readonly target: PageTarget;
  readonly preset: PenPreset; readonly bounds: Rect; readonly lastUpAt: number;
  readonly paths: number; readonly coalesceKey: string }    // `ink-burst:${annotationId}`
export function joinsBurst(burst: InkBurst | null, stroke: { target: PageTarget;
  preset: PenPreset; bounds: Rect; downAt: number }): boolean;
// annotations/annotation-store.ts
interface AnnotationSelection { /* … */           // lasso: ink path indices per annotation
  readonly paths?: Readonly<Record<string, readonly number[]>> }
applyStyle: (patch: Partial<ToolStyle>) => void;     // selection if any, else tool + preset
// viewer/read-controller.ts
whenPainted(source: SourceId, pageIndex: number, generation: number): Promise<void>;
// state/ui-store.ts — key 'pdf-editor:ui:v2' (v1 migrated once); rightPanelOpen: false
export type ViewMode = 'home' | 'read' | 'arrange' | 'compare';
export type LeftPanelView = 'pages' | 'find' | 'review' | 'files' | 'changes';
export type ReviewFilter = 'all' | 'comments' | 'redactions' | 'fields';
// + pagesView: 'thumbnails' | 'bookmarks'; reviewFilter; arrangeHidden (was arrangePinned)
// viewer/tool-store.ts — ToolMode gains 'lasso'
export type ToolGroup = 'read' | 'markup' | 'draw' | 'fill-sign' | 'pages' | 'redact';
// packages/engine/src/types.ts — after S1 passes
export interface InkAnnotation { /* … */ readonly widths?: readonly (readonly number[])[] }
```

Migration from `ui:v1`: outline → pages (bookmarks); search → find; comments, redactions,
forms → review with that filter. No new `EngineEdit` kind: bursts and the eraser use
`annotation.update`; a lasso split is an update plus a create in one entry. With `widths`
the adapter writes the appearance (`annotations/ink-appearance.ts`) and reads
`/PdfEditorInkWidths` back; widths that no longer match `/InkList` (edited elsewhere) are
dropped, and the stroke is constant width. Existing ink is unchanged.

## 10. Accessibility

| Surface | Keyboard path | Semantics and announcements |
|---|---|---|
| Home | Arrows move between cards, Space toggles selection, Shift+arrows extend, Mod+A selects all, Enter opens in Read, Alt+Shift+arrows reorder, Menu key or Shift+F10 opens ⋯ (Combine with… replaces drag) | `role="listbox"` `aria-multiselectable`; roving tabindex; "2 files selected", "Combined 2 files into a new document" |
| Navigator | Arrows move between tabs, Enter or Space opens, focus moves into the panel with Tab | vertical `role="tablist"`; accessible name includes the count ("Review, 12 items"); filter chips are a radio group |
| Tool bar | Roving tabindex across groups and tools; Enter opens a group; the group button returns; Esc as §5.2 | `role="toolbar"`; "Draw tools" on group change; armed tool is `aria-pressed` |
| Pen bar | Arrows move between presets, Enter arms, Enter on the armed preset opens its editor | presets are a `radiogroup`; "Blue pen, 1.5 pt" on arming |
| Lasso and selections | The lasso has no keyboard form; the same edits are reached from a Review row (Enter selects) and the contextual bar | "3 strokes selected" |
| Regions | F6 / Shift+F6 cycle title bar, navigator, stage, tool bar, inspector | landmarks named |
| Bursts | — | one announcement when a burst closes ("Pen: 5 strokes on page 1"), never per stroke |

Targets stay ≥ 24×24; colour is never the only cue (presets have names, rows have icons);
axe reports no violations on the new surfaces (WP A11).

## 11. Tests and acceptance

| Feature | Unit | Component | e2e |
|---|---|---|---|
| Home | combine scope and label rules; tab-order sync on reorder | cards, selection, drag-target state, empty state text | **merge in under five actions**: from an empty app, open two files, "Combine all 2 files", "Combine" → one document with all pages in Read; the helper counts every user input and fails above 4; no right-click, no palette |
| Navigator | `ui:v1` → v2 migration table; counts | Review list grouping, filters, folded settings visible only when relevant, author asked once | four tabs with counts; Compare's tab is last; inspector closed on first run |
| Tool bar, menu | group of each tool; Document menu items by state | group swap, options tier, no disabled twins | each shortcut arms its tool and shows its group; Merge, Split, Compare, Rotate open from the Document menu |
| Pen | `joinsBurst` (each condition and each closing event), `applyStyle`, preset parsing, palm and pointer rules, outline equality preview vs commit | pen bar, preset editor, React render count ≤ 2 for a 200-move stroke | see below |
| Lasso | point-in-polygon, segment crossing, touch rule, split plan | contextual bar on lasso selection | lasso three strokes of a five-stroke burst, recolour: two annotations, one history entry |
| Wording | diacritic and Turkish folding; keywords of both languages | — | "draw", "kalem", "çiz", "combine", "birleştir" each list the right command first |
| Visual | `tokens.test.ts` parses `tokens.css` and asserts every ratio in §7.1–§7.3 | — | `visual.spec.ts`: `toHaveScreenshot` baselines in Chromium (SwiftShader, fixed fonts, reduced motion) for Home empty and with 3 files, Read with the navigator, each tool bar group, the Draw group with an armed preset, the Document menu; `maxDiffPixelRatio` 0.002; baselines change only in the PR that changes the look |

**Pen e2e** (`e2e/pen.spec.ts`, Chromium through CDP `Input.dispatchMouseEvent` with
`pointerType: 'pen'` and `force`; Firefox and WebKit run the mouse path): three strokes
inside N and D → one Ink annotation with three paths, one Review row "Pen · 3 strokes",
one undo removes all three; a MutationObserver installed before the first stroke records
no contextual bar and no selection at any time; sampling every animation frame from
pointer-up until the committed render, the stroke's pixels are never page white (no blink);
a stroke after N + 200 ms is a second annotation; changing a preset before drawing changes
the next stroke and survives a reload; with S1 passed, a stroke with force 0.2 → 1.0 is
measurably thinner at its start than its end in the rendered export; after a pen event, a
touch drag scrolls the stage and adds no annotation.

Exit: all of the above pass, the matrix is green with the new rows, DESIGN.md and the
screenshots are updated, and review R has no open blocker or major finding.

## 12. Work packages

Sizes: **S** ≤ 2 days · **M** ≤ 1–2 weeks · **L** > 2 weeks. Paths are under `apps/web/src/`
unless they start with a top-level directory or are root files (`NOTICE`, `.changeset/`).

| Id | Scope | Files | Size | Depends on | Parallel |
|---|---|---|---|---|---|
| S1 | Ink appearance spike (§6.7) | `packages/engine/src/pdfium/ink-appearance.spike.test.ts`, `docs/research/09-ink-appearance-spike.md` | M | — | yes |
| P1 | No selection on creation, preview until paint, editor press, `applyStyle`, `setStyle` wired and persisted | `annotations/AnnotationLayer.tsx`, `actions.ts`, `annotation-store.ts`, `StyleControls.tsx`, `viewer/read-controller.ts` | S | — | yes |
| V1 | Tokens: ladder, glass, `--elevation-float`, capsule, active state, rise-in; contrast test | `styles/tokens.css`, `styles/global.css`, `ui/*.module.css`, `shell/FloatingToolbar.module.css`, `styles/tokens.test.ts` | M | — | yes |
| W1 | Wording, bilingual keywords, folding, Arrange shows all | `apps/web/messages/*.json`, `commands/fuzzy.ts`, `commands/registry.ts`, `annotations/tools.ts`, `stage/arrange-data.ts`, `stage/TabArrangeMenu.tsx` | S | — | yes |
| H1 | Home view and empty state | `home/**` (new), `shell/AppShell.tsx`, `shell/EmptyState.tsx`, `shell/AppGlyph.tsx`, `stage/OperationDialogs.tsx` (pre-ordered open), `state/ui-store.ts` (`home`) | M | V1 for final styling | yes |
| N1 | Navigator, Review list, folded settings, `ui:v2`, inspector, Document info sheet | `shell/LeftRail.tsx`, `shell/*Panel.tsx`, `shell/panels/**`, `shell/review/**` (new), `shell/RightPanel.tsx`, `document/DocumentDialogs.tsx`, `document/MetadataEditor.tsx`, `state/ui-store.ts` | M | owner §14 Q1; H1 card component for Files | after Q1 |
| T1 | Task groups, options tier, group state, Document menu | `shell/FloatingToolbar.tsx`, `viewer/tool-store.ts`, `annotations/tools.ts`, `annotations/AnnotationBar.tsx`, `annotations/AnnotationProperties.tsx`, `tools/DocumentMenu.tsx` | M | owner §14 Q1, V1, P1 | after Q1 |
| P2 | Pen bar, presets, bursts, eraser on groups, Review row label | `annotations/pen/**` (new), `annotation-store.ts`, `labels.ts`, `shell/review/**` (row only) | M | P1; T1 bar slot (can stub) | yes |
| P3 | Input: native handlers, coalesced and predicted points, canvas preview, outline, pointer types, palms, touch pan | `annotations/pen/ink-input.ts`, `ink-preview.ts`, `annotations/ink.ts`, `AnnotationLayer.module.css`, `apps/web/package.json` (`perfect-freehand`), `NOTICE` | M | P1 | yes |
| P4 | Variable-width appearance, `widths`, matrix rows, A7 | `packages/engine/src/annotations/ink-appearance.ts` (new), `pdfium/annotation-mapping.ts`, `types.ts` (additive), `tools/qa/annotation-sample-plan.ts`, `docs/qa/annotations-matrix.md` | M | S1 pass, ADR-0018 | yes |
| P5 | Lasso: tool, path selection, move, width, colour, delete, split | `annotations/lasso/**` (new), `annotation-store.ts`, `AnnotationBar.tsx`, `actions.ts` | M | P2 | after P2 |
| A11 | Accessibility: F6 regions, roving tabindex, announcements, axe | `shell/AppShell.tsx`, `shell/announcer.ts`; fixes by each owner | S | H1, N1, T1, P2, P5 | no |
| QA | e2e and visual suites (§11) | `apps/web/e2e/home.spec.ts`, `pen.spec.ts`, `visual.spec.ts`, `helpers.ts` | M | each feature | partly |
| D1 | DESIGN.md A1–A7, screenshots, ROADMAP, changeset | `docs/DESIGN.md`, `docs/specs/viewer-annotations.md`, `docs/design/screenshots/**`, `docs/ROADMAP.md`, `.changeset/*` | S | all | no |
| L1 | Light theme (§7.6) | `styles/tokens.css`, `shell/TabBar.tsx` (toggle), `styles/tokens.test.ts` | M | moved to M8 | — |
| R | Independent experience review on the live build; correctness review of P4 | read-only, findings as issues | — | all | no |

Rules as in M4 and M5: one agent per package, no edits outside owned paths (shared stores
take additive edits, merged by the lead), the lead commits, every R finding gets a test.

**Order.** (1) P1, S1, V1 and W1 in parallel; P1 lands first, since it removes friction 1
and 2 within days and needs no approval. (2) The owner answers Q1; ADR-0018 after S1.
(3) H1, P2 and P3 in parallel; N1 and T1 once Q1 is answered; P4 once S1 passes. (4) P5
after P2; A11 and QA complete as features land. (5) D1, R and fixes; L1 last (it may move
to M8 without blocking the exit).

## 13. Decisions

| # | Decision | Reason |
|---|---|---|
| 1 | Home is a view (`0`, app glyph), not a tab; shown after a multi-file drop and as the empty state | One place for "several files" without a second tab model |
| 2 | Combining always goes through the existing merge dialog, including card drops | Order is visible and the merge stays undoable; nothing merges silently |
| 3 | Navigator: Pages (with Bookmarks), Find, Review, Files; Compare's Changes tab only in Compare, last | Content over settings; the rail never shifts |
| 4 | The inspector is closed by default and never opens by itself | It duplicated the contextual bar and showed a metadata form first |
| 5 | Six groups; Edit text and Image sit in Pages, as tools that change the page itself | Every tool has one home; no group exceeds six tools |
| 6 | Bursts: N = 1,500 ms, D = 36 pt, at most 64 paths, tunable | Groups a written word or line; a stroke elsewhere or after a pause is its own item |
| 7 | One outline function (`perfect-freehand` 1.2.3, MIT) for preview and commit | The shape does not move at commit |
| 8 | A pen seen once means fingers pan and zoom; our own pan handler | Browsers apply `touch-action` to pens as well |
| 9 | Variable width only in our appearance stream plus `/PdfEditorInkWidths`; constant `/BS /W` | Standard Ink has no per-point width; other viewers degrade to constant width, said in the UI |
| 10 | Darker canvas, lighter panels, lighter glass | Keeps the page the brightest thing and lets the bar float over the canvas |
| 11 | The palette matches keywords of both languages, diacritic-insensitive | Bilingual users type either; "ciz" should find "çiz" |
| 12 | Arrange shows all open documents by default | The light table is the headline feature and hid two of three documents |
| 13 | Group menu: the capsule morphs in place, options rise as a second tier; no radial menu, drawer or sheet | Labels stay readable, nothing covers the page, the pointer stays put, same on a tablet |

## 14. Open questions for the owner (answered 2026-10-01)

1. **Structural layout change.** Approved by the owner: four labelled navigator tabs, the
   inspector closed by default, the tool bar grouped by task. The owner left the shape of
   the group menu to the project lead: an in-place morph of the capsule bar (§5.2), not a
   radial menu, drawer or sheet.
2. **Light theme timing.** The owner's answer: much later, not needed now. L1 moves to M8.
