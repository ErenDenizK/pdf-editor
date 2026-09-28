# Effect inventory (design refinement pass, DESIGN.md §7)

**Status:** for owner review, 2026-09-28. Nothing in `apps/web` has been changed; this is the
list the §7 pass works from. Verdicts are proposals. The owner decides the open items listed in
[README.md](README.md).

**Method.** Every CSS file under `apps/web/src` was read line by line: 61 CSS modules plus
`styles/tokens.css`, `global.css`, `reset.css` and `fonts.css`, about 8,000 lines in all. No TSX
file sets a visual effect inline; the only inline styles are annotation colours and opacities,
which are document content. Screenshots come from the production build of `9b46d12`, served on a
private port. They were taken at 1440×900 with DPR 2: full frames are saved at 1440×900 and crops
at 2× (see [README.md](README.md#how-the-screenshots-were-made)).

**Judged against** DESIGN.md §1 ("Nothing glows. Hierarchy comes from tonal steps and hairline
borders, not from shadows or saturated color"), the §3 rules and §7. Remove or tone down anything
that draws the eye to the chrome instead of the document.

**Verdict key:** **keep** · **tone down** (with how) · **remove** · **fix** (a defect, not a
matter of taste) · **retune** (kept but with the new tokens from `translucency.md`).

---

## Counts

| Category | Effects | keep | tone down / retune | remove | fix |
| --- | ---: | ---: | ---: | ---: | ---: |
| A. Glass and backdrop blur | 7 | 1 | 6 | 0 | 0 |
| B. Scrims and overlay washes | 5 | 4 | 1 | 0 | 0 |
| C. Shadows (`box-shadow`: rings, halos, stripes) | 13 | 6 | 4 | 3 | 0 |
| D. Gradients and hatching | 4 | 4 | 0 | 0 | 0 |
| E. Transitions and animations | 15 | 12 | 2 | 1 | 0 |
| F. Hover states | 14 | 9 | 5 | 0 | 0 |
| G. Selected, pressed and current states | 10 | 7 | 3 | 0 | 0 |
| H. Focus indicators | 9 | 6 | 1 | 0 | 2 |
| I. Opacity (non-transition) | 13 | 9 | 3 | 1 | 0 |
| J. Borders, radii and side stripes | 8 | 2 | 6 | 0 | 0 |
| K. Hard-coded colours outside tokens | 9 | 3 | 5 | 0 | 1 |
| L. Scrollbars | 2 | 2 | 0 | 0 | 0 |
| M. Blend modes | 3 | 3 | 0 | 0 | 0 |
| N. On-page chrome (selections, handles, marks) | 10 | 8 | 1 | 0 | 1 |
| **Total** | **122** | **76** | **37** | **5** | **4** |

Grep totals for cross-checking: 25 `box-shadow` declarations (plus 2 that name it inside a
`transition`), 17 `backdrop-filter` declarations (with prefixes and tokens), 3 gradients plus
1 `repeating-linear-gradient`, 1 `@keyframes`, 3 `mix-blend-mode`, 32 `opacity:` declarations
and 42 `transition:` declarations. The table groups
identical rules that repeat across components (for example, the `.secondary` button hover defined
in 9 modules) as one effect.

---

## A. Glass and backdrop blur

All the glass surfaces share `--glass: rgb(16 18 21 / 0.86)`, `--glass-blur: 16px`,
`--glass-solid: #16181c` and `--border-glass: rgb(255 255 255 / 0.12)`. Each module repeats its
own `@supports` block.

| # | Where | What it looks like | Verdict |
| --- | --- | --- | --- |
| A1 | `shell/FloatingToolbar` `.toolbar` | Glass at 0.86 with `blur(16px) saturate(1.2)`, 1px `--border-glass`, radius 10. Over a white page it reads as a flat #323336 slab ([02-read-toolbar-crop](02-read-toolbar-crop.png)). | **retune**: see translucency.md |
| A2 | `annotations/AnnotationLayer` `.bar` (contextual annotation bar) | Same recipe, 40px tall ([03-annotation-bar-crop](03-annotation-bar-crop.png)) | **retune** |
| A3 | `image-objects/ImageObjects` `.bar` (image bar) | Same recipe ([08-image-bar-crop](08-image-bar-crop.png)) | **retune** |
| A4 | `stage/ArrangeView` `.contextBar` | Same recipe ([10-arrange-contextbar-crop](10-arrange-contextbar-crop.png)) | **retune** |
| A5 | `shell/CommandPalette` `.popup` | Same recipe, on top of `--scrim` ([05-palette-crop](05-palette-crop.png)) | **retune** |
| A6 | `crop/Crop` `.banner` (the "draw crop area" hint) | Glass **without** `saturate()` and **without** `-webkit-backdrop-filter`. Its `@supports` test has no `-webkit-` branch, so Safari ≤ 17 gets the solid fallback. | **retune** and unify: all six should compose one shared rule |
| A7 | `styles/tokens.css` media fallbacks | `prefers-reduced-transparency` and `prefers-contrast: more` swap in `--glass-solid` and set blur to 0. | **keep** and extend to `forced-colors` |

## B. Scrims and overlay washes

| # | Where | What | Verdict |
| --- | --- | --- | --- |
| B1 | `--scrim` rgb(5 6 8 / 0.56): `ShortcutOverlay` `.backdrop` (all dialogs), `CommandPalette` `.backdrop` | Dims the app under modal surfaces; fades in 180ms. | keep |
| B2 | `furniture/FurnitureDialogs` `.backdrop` | Transparent backdrop: the document is the live preview. | keep |
| B3 | `shell/Stage` `.dropOverlay` | `rgb(10 11 13 / 0.72)` wash plus a 1px accent border (radius 10) and a label chip when files are dragged over the stage. | **tone down**: use `--scrim` rather than a second literal dark wash |
| B4 | `crop/Crop` `.shade` | `--scrim` over the part of the preview page that the crop hides. | keep |
| B5 | `stage/ArrangeView` `.backgroundOutline`, `.section[data-drop-outline]::after` | 1px **dashed** accent outline, radius 10; the section variant adds an `--accent-subtle` wash. | keep |

## C. Shadows (`box-shadow`)

No drop shadows exist anywhere, which is good. Every `box-shadow` is a ring, a halo or a
stripe.

| # | Where | Value / look | Verdict |
| --- | --- | --- | --- |
| C1 | `--page-shadow` on `Stage .page`, `Stage .thumbSheet`, `LeftRail .pageSheet`, `ArrangeView .thumbSheet`, `ResizeDialog .previewSheet`, `Crop .previewSheet` | `0 0 0 1px rgb(255 255 255 / 0.06)`: a hairline outside the white page. It is almost invisible against the canvas (#191a1c on #0a0b0d). | keep; move to the single border alpha (J) |
| C2 | `Stage .segment[aria-checked]`, `LayoutSwitch .segment[aria-checked]` | `inset 0 0 0 1px --border-hairline` on the selected segment | keep |
| C3 | `CommandPalette .option[aria-selected]`, `SearchPanel .hit[aria-current]` | `inset 2px 0 0 --accent`: a left accent stripe drawn inside a **6px-rounded** row, so it bends into a bracket shape ([05-palette-selected-row](05-palette-selected-row.png), [16-search-current-hit-crop](16-search-current-hit-crop.png)) | **remove** the stripe. The palette already marks the row with `--surface-active` and brighter text; the search hit can use `--accent-muted`, as Comments, Forms and Redactions do (G6). |
| C4 | `SearchPanel .toggle[aria-pressed]` | `accent-muted` plus `inset 0 0 0 1px rgb(124 140 255 / 0.4)` | **tone down**: drop the ring and match the other pressed toggles (G2) |
| C5 | `LinkLayer .hotspot:hover` | `--accent-subtle` fill plus an inset 1px accent ring at 0.5 | keep; tokenise the 0.5 |
| C6 | `FormLayer` `[data-highlight] .target` / disabled / `:hover` | Inset rings at accent 0.45, at `rgb(107 112 120 / 0.6)` (the *old* tertiary colour) and at accent 0.7 on hover | **tone down**: one accent line token, and `--text-tertiary` for the disabled ring |
| C7 | `FormLayer .editor` | 1px accent border **plus** `0 0 0 2px rgb(124 140 255 / 0.35)`: a soft blue halo around the white field ([17-form-editor-halo-crop](17-form-editor-halo-crop.png)) | **remove** the halo. The border, or the standard focus ring, is enough; "nothing glows". |
| C8 | `ImageObjects .layer:hover .target`, `TextEdit .layer:hover .run[data-editable]` | While the pointer is anywhere on the page, **every** target gets `0 0 0 1px` accent at 35% ([12-text-edit-hover-crop](12-text-edit-hover-crop.png)) | **tone down**: keep for discoverability, but at the line alpha. Options are to show it only while the tool has just been armed, or only for the hovered target. Owner decision D6. |
| C9 | `ImageObjects .target:hover`, `TextEdit .run:hover` | `--accent-muted` fill plus a 1px accent ring. On an image the fill tints the picture lavender ([08-image-hover-crop](08-image-hover-crop.png)). | **tone down**: ring only for images, because the page is never tinted; keep the fill on text runs |
| C10 | `ImageObjects .selection:focus-visible` | `0 0 0 3px --accent-muted`: a soft halo **instead of** the standard focus ring | **remove**; use `--focus-ring` like every other element |
| C11 | `TextEdit .run[data-blocked]` (with C8) | A 1px ring in tertiary at 45% around hatched runs | keep (an honesty signal) |
| C12 | `AnnotationLayer .lockBadge` | `0 0 0 1px --border-strong` around a 20px disc | keep; write it as a `border` |
| C13 | `OutlinePanel .row[data-drop='into']` | `accent-muted` plus an inset 1px accent ring | keep |
| (C1b) | `dnd .previewSheet/.previewFace` | `0 0 0 1px rgb(0 0 0 / 0.18)` on the native drag ghost. Not captured, because the browser snapshots it. | keep (must read over any background) |

Distinct `box-shadow` values: `0 0 0 1px rgb(255 255 255/.06)` · `inset 0 0 0 1px var(--border-hairline)` ·
`inset 2px 0 0 var(--accent)` · `inset 0 0 0 1px rgb(124 140 255/.4)` · `…/.45` · `…/.5` · `…/.7` ·
`inset 0 0 0 1px rgb(107 112 120/.6)` · `0 0 0 1px color-mix(accent 35%)` · `0 0 0 1px var(--accent)` ·
`0 0 0 1px color-mix(tertiary 45%)` · `0 0 0 2px rgb(124 140 255/.35)` · `0 0 0 3px var(--accent-muted)` ·
`0 0 0 1px var(--border-strong)` · `inset 0 0 0 1px var(--accent)` · `0 0 0 1px rgb(0 0 0/.18)`: **16 values**.

## D. Gradients and hatching

| # | Where | What | Verdict |
| --- | --- | --- | --- |
| D1 | `StyleControls .custom` | A conic rainbow disc for "custom colour" (the only saturated decoration in the chrome) | keep: it signals the colour picker, and it sits among colour swatches |
| D2 | `CreatedFields .swatch[data-none]` | A white swatch with a diagonal `--danger` strike for "no colour" | keep |
| D3 | `TextEdit .run[data-blocked]` | `repeating-linear-gradient(135deg, tertiary 30% …)` hatching over runs that cannot be edited | keep (honesty); see C8 about when it appears |
| D4 | `EmptyState .card[data-dragging]` | `color-mix(surface-1, accent 6%)` wash while a file is dragged over | keep |

## E. Transitions and animations

There is one curve everywhere, `--ease-out: cubic-bezier(0.2, 0, 0, 1)`, which is good. There
are two durations, `--duration-fast` (120ms) and `--duration-base` (180ms), plus one literal.

| # | Where | Property / duration / curve | Verdict |
| --- | --- | --- | --- |
| E1 | `IconButton .button` | background-color, color · 120ms · ease-out | keep |
| E2 | `Menu .popup`, `Popover .popup`, `Tooltip .popup` | opacity + `scale(0.98)` on enter and exit · 120ms. Tooltip has `[data-instant]` with no transition. | keep |
| E3 | `CommandPalette .popup`, `ShortcutOverlay .popup` (every dialog) | opacity + `scale(0.985)` · 120ms; backdrop opacity 180ms | **tone down**: use the same 0.98 as E2 (one enter scale) |
| E4 | `FurnitureDialogs .side` | opacity + `translateX(8px)` · 120ms (side-docked dialogs) | keep |
| E5 | `UpdateToast .toast` | `@keyframes enter` (opacity 0, translateY 4px) · 180ms (the only keyframe animation) | keep |
| E6 | `TabBar .tabWrap` / `.close` / `.search` | bg + border 120ms; the close button fades 0→1 on hover, focus or selection; the search border fades 120ms | keep |
| E7 | `EmptyState .card` / `.glyph` / `.hint` | border + background 180ms on drag-over; glyph colour 180ms; hint rows 120ms | keep |
| E8 | `ResizeHandle ::after` | background 120ms (hairline → strong on hover, accent while active) | keep |
| E9 | `OutlinePanel .toggle svg`, `ArrangeView .headerButton svg` | chevron `rotate()` 120ms | keep |
| E10 | `ArrangeView .insertionBar` | transform **60ms** (a literal, not a token) | **tone down**: add `--duration-instant: 60ms` or use `--duration-fast` |
| E11 | `ExportDialog .progress::-webkit-progress-value` | width 180ms. The same bar in `ToolDialog` has no transition, and Firefox gets none either. | keep; apply the same to ToolDialog |
| E12 | `ImageObjects .target`, `TextEdit .run` | background + box-shadow 120ms | keep |
| E13 | Panel buttons: `MarkMatchesButton`, `Outline .toolButton`, `FormsPanel .button`, `RedactionsPanel .button/.apply`, `PrivacyIndicator .trigger`, `StatusBar .zoomValue`, `Stage/LayoutSwitch .segment` | background/color 120ms on hover | keep |
| E14 | `.primary` buttons in 8 modules (Export, Password, GoToPage, LinkLayer, UpdateToast, OutlinePanel, ToolDialog, DocumentTools) | `transition: background-color 120ms`, but `.primary` **has no hover or active state**, so the transition never runs | **remove** the dead transition, or add a primary hover (decision D8) |
| E15 | Reduced motion | tokens set both durations to 0; `global.css` forces 0.01ms on everything; 5 modules repeat `@media (prefers-reduced-motion)` overrides | keep; the per-module overrides are redundant |

Distinct **durations**: 120ms (`--duration-fast`, 35 uses), 180ms (`--duration-base`, 7 uses),
60ms (1 literal), 0.01ms (global reduced-motion override). Distinct **curves**: 1
(`--ease-out`). Distinct **enter transforms**: `scale(0.98)`, `scale(0.985)`, `translateX(8px)`,
`translateY(4px)`.

## F. Hover states

| # | Where | What | Verdict |
| --- | --- | --- | --- |
| F1 | The common pattern (≈40 selectors): rows, secondary buttons, icon buttons | `--surface-hover` (white 0.045) + text to `--text-primary`, gated by `@media (hover: hover)` | keep |
| F2 | `TabBar .close:hover`, `ArrangeView .hoverAction:hover`, `OutlinePanel .toggle:hover` | **`--surface-active`** (0.075) on *hover*, one step brighter than every other hover | **tone down** to `--surface-hover` |
| F3 | `TabBar .search:hover` | border `hairline → strong` + text tertiary → secondary | keep |
| F4 | `DocumentTools .input:hover` | border `hairline → strong`: the **only** input with a hover state | **tone down**: remove, or give every input the same (consistency) |
| F5 | `ImageObjects .action:hover`, `TextEdit .choice:hover` | Hover **not** gated by `@media (hover: hover)`, so it sticks after a tap on touch | **tone down**: gate like the rest |
| F6 | `AnnotationLayer .secondary`, `SignatureDialog .secondary` | **No** hover, while the same-looking `.secondary` in 9 other modules has one | **tone down** (add the shared hover) |
| F7 | `ArrangeView .cell:hover .hoverActions` | Rotate/delete icons appear under the thumbnail (space reserved, no shift) ([10-arrange-cell-hover](10-arrange-cell-hover.png)) | keep |
| F8 | `RedactionsPanel .row:hover .delete` | The delete button fades from opacity 0 → 1 ([11-redactions-row-hover](11-redactions-row-hover.png)) | keep |
| F9 | `TabBar .tabWrap:hover` | `--surface-hover` + the close button revealed ([21-tab-hover](21-tab-hover.png)) | keep |
| F10 | `AnnotationLayer .hit:hover` | `rgb(124 140 255 / 0.1)` fill; strokes get `/0.25` | keep; tokenise (accent-subtle) |
| F11 | `LinkLayer .hotspot:hover` | see C5 | keep |
| F12 | `ResizeHandle:hover::after` | hairline → strong | keep |
| F13 | `ImageObjects`/`TextEdit` layer hover | see C8/C9 | tone down (C8, C9) |
| F14 | `Stage .segment:hover`, `LayoutSwitch .segment:hover` | text colour only | keep |

## G. Selected, pressed and current states

| # | Where | What | Verdict |
| --- | --- | --- | --- |
| G1 | `IconButton[aria-pressed]` (chrome) | `--surface-active`, neutral | keep |
| G2 | `IconButton[data-size=toolbar][aria-pressed]` (active tool) | `--accent-muted` square ([02-read-toolbar-crop](02-read-toolbar-crop.png)) | keep |
| G3 | `Menu .item[data-highlighted]` / `[data-checked]` | `--surface-active` / a 6px accent dot | keep |
| G4 | Segmented controls: `Stage`, `LayoutSwitch` (surface-3 + inset hairline); `SignatureDialog .tab` (surface-3, **no** inset); `ResizeDialog .segment` (accent-muted); `FurnitureDialogs .segment` (accent border + accent-muted); `CreatedFields .segment` (accent 0.45 border + muted); `FormsPanel .button[aria-pressed]` (same) | Four different looks for "this option is on" | **tone down**: two patterns only, neutral (surface-3 + hairline) for view switches and accent-muted (no border) for option choices |
| G5 | `ToolDialog .preset:has(:checked)` | accent **border** + surface-2 | tone down to the G4 option pattern |
| G6 | "Current row": `CommentsPanel`, `FormsPanel`, `RedactionsPanel` use `--accent-muted`; `RightPanel .historyRow`, `LeftRail .fileRow` and `SearchPanel .hit` use `--surface-2` (+ stripe, C3) | Two treatments for the same meaning | **tone down**: one ("current" = accent-muted) |
| G7 | Thumbnails selected: `LeftRail`, `Stage`, `ArrangeView` | 2px accent outline, offset 3 ([10-arrange-selection](10-arrange-selection.png)) | keep |
| G8 | `TabBar .tabWrap[data-selected]` | surface-2 + hairline border | keep |
| G9 | `SearchHighlights .hit` / `[data-current]` | accent 0.28 multiply; current 0.55 + a 2px accent outline | keep |
| G10 | `Keycaps` default / `quiet` / `onGlass` | surface-2 + hairline; transparent; **white 0.06 bg + 0.1 border literals** | keep; tokenise onGlass |

## H. Focus indicators

Global: `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` (DESIGN §5).

| # | Where | What | Verdict |
| --- | --- | --- | --- |
| H1 | Global ring | 2px accent, offset 2 ([15-focus-ring-toolbar-crop](15-focus-ring-toolbar-crop.png), [15-focus-ring-segmented-crop](15-focus-ring-segmented-crop.png)) | keep |
| H2 | Offset overrides | −2px (rows inside scrollers), 0 (inputs, items), 1px (segments, hotspots, swatches), 3px (thumbnails via `outline`), 4px (grid cells), `-var(--focus-offset)` (page layers) | keep; they are all deliberate. Document them in §5. |
| H3 | **`ToolDialog .preset:has(input:focus-visible)`** | `outline: 2px solid var(--focus-ring, var(--accent))`. `--focus-ring` is itself `2px solid …`, so the value is invalid and **no ring is drawn** (the computed `outline-style` is `none`, measured). In the Compress dialog, keyboard focus on a preset looks the same as "checked" ([19-compress-preset-focus-crop](19-compress-preset-focus-crop.png)). | **fix**: `outline: var(--focus-ring); outline-offset: 1px` |
| H4 | `DocumentTools .input:focus-visible` | border turns accent and the outline is removed. Every other input shows the ring at offset 0. | **tone down** to the shared input focus |
| H5 | `TextEdit .input`, `AnnotationLayer .freeText`, `InlineTitleEditor`, `Outline .renameInput` | outline none; the dashed accent border turns solid (in-place editors) | keep |
| H6 | `ImageObjects .selection:focus-visible` | 3px accent-muted halo (C10) | **fix** (use the ring) |
| H7 | `ResizeHandle:focus-visible` | outline none; the 1px line turns accent | keep (a 1px line is weak but on-axis) |
| H8 | `CommandPalette .input` | outline none (the dialog is the focus context) | keep |
| H9 | Radio/checkbox fakes: `ResizeDialog .segment`, `FurnitureDialogs .segment/.anchor`, `StyleControls .custom:focus-within` | an explicit 2px accent outline on the wrapper | keep (after the H3 fix, the same recipe everywhere) |

## I. Opacity (outside enter/exit transitions)

Seven enter/exit `opacity: 0` rules (E2 to E5) and five `opacity: 0` hidden native inputs are
not listed.

| # | Where | Value | Verdict |
| --- | --- | --- | --- |
| I1 | Disabled primary: `ExportDialog`, `SignatureDialog`, `DocumentTools`, `ToolDialog` (also `.secondary`), `RedactionsPanel .primary` | `opacity: 0.5`: the accent turns a muddy slate and the label drops to about 2.5:1 ([18-crop-dialog-crop](18-crop-dialog-crop.png), "Crop") | **tone down**: use `GoToPageDialog`'s treatment (surface-3 bg + `--text-disabled`) everywhere |
| I2 | `StyleControls .swatch:disabled` | 0.4 | keep |
| I3 | `ArrangeView .cell[data-dragging]` | 0.35 (the source cell while dragging) | keep |
| I4 | `ArrangeView .cell[data-cut] .thumbSheet` | 0.5 (cut, awaiting paste) | keep |
| I5 | `OutlinePanel .row[data-dragging]` | 0.5 | keep |
| I6 | `dnd .preview` | 0.9 + `scale(0.96)` drag ghost (§3 "slightly scaled and translucent") | keep |
| I7 | `TextEdit .input[readonly]` | 0.7 | keep |
| I8 | `AnnotationLayer .previewMarkup` | 0.45 + multiply (markup preview while dragging) | keep |
| I9 | `FloatingToolbar .menuTrigger .chevron` | 0.7 on the corner chevron of menu tools | **tone down**: use `--text-tertiary` so the opacity doesn't stack over the glass |
| I10 | `TabBar .close` | 0 → 1 reveal (E6) | keep |
| I11 | `RedactionsPanel .delete` | 0 → 1 reveal (F8) | keep |
| I12 | `SignatureDialog .notice` | warning **background** `rgb(245 196 81 / 0.08)`: the only tinted notice box in the app | **tone down** (drop the tint like the other honesty notices, or decide on one tinted style) |
| I13 | `.primary:disabled` duplicated in `.secondary:disabled` (`ToolDialog`) | 0.5 on a hairline button | **remove** (use `--text-disabled`) |

## J. Borders, radii and side stripes

| # | Where | What | Verdict |
| --- | --- | --- | --- |
| J1 | Radius scale in use | 4 (r1) ×43, 6 (r2) ×78, 10 (r3) ×16, **2px ×15, 1px ×8, 3px ×1, 11px ×1, 0 ×1**, 50% ×17 | **tone down** to one scale (see "Distinct values") |
| J2 | `Crop .warning` | `border-left: 2px solid --warning` on a 6px-rounded box: a curved side stripe (shown only when the crop hides annotations; code only) | **tone down**: a full hairline border in the warning line colour, like `RedactionsPanel .honesty` |
| J3 | `OperationDialogs .chip` | `border-left: 3px solid --tag-color` on a 4px-rounded chip (merge/interleave lists) | tone down: use a 6px tag dot like everywhere else (`.tag`) |
| J4 | Honesty notices: `RedactionsPanel .honesty`, `FormsPanel .warning`, `ApplyRedactions .warning` (border warning 0.3); `SignatureDialog .notice` (0.35 + bg); `FormLayer .badge`, `FormsPanel .badge` (0.4); `Outline .dead`, `Crop .warning`, `DocumentTools .notice` (neutral border) | Three warning alphas and two notice styles | **tone down**: one `--warning-line` (0.35) and one notice recipe |
| J5 | Menus, popovers and tooltips | `--border-strong` (0.14), the heaviest border in the app, on the floating surfaces ([04-menu-zoom-crop](04-menu-zoom-crop.png)) | **retune**: `--border-glass` on frosted surfaces (translucency.md) |
| J6 | `Stage .dropOverlay`, `ArrangeView .backgroundOutline` | a solid accent border vs a dashed accent border for the same "drop files here" meaning | keep dashed only |
| J7 | Dashed borders: `SignatureDialog .pad`, `ArrangeView .emptyRow`, `StyleControls .custom`, in-place editors | 1px dashed | keep |
| J8 | Hairline dividers (≈60 uses) | `--border-hairline` 0.08 | keep |

## K. Hard-coded colours outside tokens

| # | Where | Literal | Verdict |
| --- | --- | --- | --- |
| K1 | `dnd .previewBadge` | `#7c8cff` bg, `#0a0b0d` text, 11px pill radius, `font` shorthand with a hard-coded family | keep literals (the native drag image snapshot cannot read custom properties reliably), but mirror the token values in a comment |
| K2 | `AnnotationLayer .eraseTrail` | `rgb(229 57 53 / 0.5)`: a Material red, **not** `--danger` | **tone down**: `color-mix(--danger 50%)` |
| K3 | `FormLayer` disabled ring, `select.editor option:disabled` | `#6b7078` / `rgb(107 112 120)`: the pre-AA tertiary | **fix**: use `--text-tertiary` |
| K4 | Accent literals: `rgb(124 140 255 / .08 .1 .25 .28 .35 .4 .45 .5 .55 .7)` across 9 modules | Ten alphas of the accent | **tone down** to 4 tokens (see "Distinct values") |
| K5 | Warning literals `rgb(245 196 81 / .08 .3 .35 .4)` | see J4 | tone down |
| K6 | `Stage .dropOverlay` `rgb(10 11 13 / 0.72)` | a second scrim (B3) | tone down |
| K7 | `Keycaps [data-tone=onGlass]` `white .06 / .1` | (G10) | tone down → tokens |
| K8 | Page-white content: `#ffffff` handles, `.freeText` `white/.85`, `TextEdit .input` `page 94%`, `FormLayer .editor` `#fff/#111`, `CreatedFields` `#000/#fff/rgb(153 193 218)`, `SignatureDialog .typed` `#1a237e` | document-side colours (the page is never themed) | keep, but see N6/N7 |
| K9 | `StyleControls .custom` conic stops (Material palette) | D1 | keep |

## L. Scrollbars

| # | Where | What | Verdict |
| --- | --- | --- | --- |
| L1 | `global.css *` | `scrollbar-width: thin; scrollbar-color: rgb(255 255 255 / 0.14) transparent` | keep; write it with `--border-strong` |
| L2 | `TabBar .tablist` | scrollbar hidden (`scrollbar-width: none` + `::-webkit-scrollbar`) | keep |

## M. Blend modes

| # | Where | What | Verdict |
| --- | --- | --- | --- |
| M1 | `SearchHighlights .hit` | multiply, so the highlight doesn't grey the glyphs | keep |
| M2 | `FurnitureLayer .behind` | multiply (for "behind page content" furniture) | keep |
| M3 | `AnnotationLayer .previewMarkup` | multiply + 0.45 | keep |

## N. On-page chrome (drawn over the document)

| # | Where | What | Verdict |
| --- | --- | --- | --- |
| N1 | Annotation selection `.selection .outline` / image `.selection` | 1.5px dashed accent, 4 3 | keep |
| N2 | Handles: annotations (SVG, white + 1.5px accent), images (white + 1.5px accent, r1), created fields (8px white + 1px accent) | white squares | keep; one size and stroke |
| N3 | **Crop handles** (`Crop .handle`) | 12px squares filled `--surface-0` (near-black) with an accent border. On the white preview they read as notches cut into the page ([18-crop-dialog-crop](18-crop-dialog-crop.png)). | **tone down**: white like N2 |
| N4 | `ArrangeView .marquee`, `Crop .drawn`, `CreatedFields .preview`, `AnnotationLayer .previewBox` | 1px accent + accent-subtle/muted fill | keep; one fill token |
| N5 | `ArrangeView .insertionBar` (+ the "+" duplicate disc), `OutlinePanel` drop lines | 2px accent bar | keep |
| N6 | `TextEdit .input` | `color-mix(page 94%, transparent)` background: 6% of the original glyphs **show through** the edited text ([12-text-edit-open-crop](12-text-edit-open-crop.png)) | **fix**: an opaque `--page-background` |
| N7 | `AnnotationLayer .freeText` | `rgb(255 255 255 / 0.85)` (same issue, lighter) | keep, or make it opaque with N6 |
| N8 | Redaction marks (`RedactionLayer`) | `--danger` 16% fill + 1.5px stroke; excluded: 6% + dashed; current 2.5px; preview 22% dashed ([11-redaction-marks-on-page](11-redaction-marks-on-page.png)) | keep |
| N9 | `SearchHighlights` (G9), `LinkLayer` (C5), `FormLayer` highlight (C6) | | see those rows |
| N10 | `FurnitureLayer .selected` | 3 2 dashed accent, non-scaling | keep |

---

## Layout defect found while capturing (not an effect, but it breaks §2)

**The status bar jumps 8px left when the privacy popover opens and stays there.**
`PrivacyIndicator .trigger` uses `margin: 0 calc(var(--space-2) * -1)` so that its hover fill
bleeds into the gutter. At the right end, that bleed overflows `StatusBar .left` (which has
`overflow: hidden`) by 8px. Focusing the trigger scrolls `.left` to reveal it: its `scrollLeft`
goes 0 → 8, and it stays 8 after the popover closes, so "Page 1 of 3" loses its "P"
([20-statusbar-before](20-statusbar-before.png) → [20-statusbar-popup-open](20-statusbar-popup-open.png)).
This breaks DESIGN §2, "Hover states never shift layout". **Fix:** give `.left` `overflow: clip`,
or pad it by `--space-2`, or drop the negative margins.

---

## Distinct values (data for the §7 consistency step)

### Radius, in use → proposed

| In use | Where | Proposed token |
| --- | --- | --- |
| 1px | on-page hits, handles, image targets, created fields | `--radius-page: 2px` |
| 2px | page sheets, thumbs, search marks, form targets/editors, crop handles, marquee | `--radius-page: 2px` |
| 3px | `ApplyRedactions .swatch` | `--radius-1` |
| 4px `--radius-1` | small controls, keycaps, menu items, badges, inputs in panels | `--radius-1: 4px` |
| 6px `--radius-2` | buttons, rows, inputs, menus, popovers, tooltips | `--radius-2: 6px` |
| 10px `--radius-3` | floating bars, palette, dialogs, cards, toast, text-edit panel, note popup | `--radius-3: 10px` |
| 11px | dnd badge (pill) | `--radius-round: 999px` |
| 50% | dots, swatches, lock badge | `--radius-round` |
| 0 | image selection frame | keep 0 (a frame on the page, like N1's SVG outline) |

That gives one scale: **2 (page) · 4 · 6 · 10 · round**. Floating surfaces take 10 when they are
bars or panels and 6 when they are menus, popovers or tooltips. The text-edit panel and the note
popup currently use 10; as popovers they should use 6.

### Border alpha (white on dark), in use → proposed

| In use | Token / literal | Uses |
| --- | --- | --- |
| 0.06 | `--page-shadow` hairline; keycap onGlass bg | 6 + 1 |
| 0.08 | `--border-hairline` | ≈60 |
| 0.10 | keycap onGlass border | 1 |
| 0.12 | `--border-glass` | 6 |
| 0.14 | `--border-strong`; scrollbar thumb | ≈45 + 1 |
| 0.28 | `StyleControls .swatch` ring | 1 |
| 0.22 / 0.36 | `prefers-contrast: more` | tokens |

Proposal: **one border alpha, `--border: rgb(255 255 255 / 0.10)`**, for dividers, surfaces,
glass, keycaps and the page hairline. Keep **one control step, `--border-strong` at 0.16**, for
input fields and focusable control outlines, because WCAG 1.4.11 asks inputs to stay
identifiable. If the owner wants literally one value, inputs rely on their surface-2 fill
(decision D4). The swatch ring (0.28) stays, because it has to separate colours from the bar.

### Accent alphas → 4 tokens

In use: 0.08, 0.10, 0.16, 0.25, 0.28, 0.35 (×3, including `color-mix 35%`), 0.40, 0.45 (×3),
0.50, 0.55, 0.70 (×2). Proposed: `--accent-subtle` 0.08 (washes, hover fills, previews) ·
`--accent-muted` 0.16 (selected/current fills) · `--accent-line` 0.45 (1px rings and borders on
non-focus states, replacing 0.25 to 0.7) · `--accent-highlight` 0.30 (multiply highlights on the
page: search hits 0.28 and text selection 0.35). The current search hit keeps 0.55 plus the
outline, as `--accent-highlight-strong`.

### Motion

One curve (`cubic-bezier(0.2, 0, 0, 1)`), already consistent. Durations: 120 / 180 plus one 60ms
literal → `--duration-instant: 60ms` (drag feedback only) · `--duration-fast: 120ms` (state
changes, enter/exit of popups) · `--duration-base: 180ms` (scrims, drag-over). Enter transform:
one `scale(0.98)` for every popup and dialog. The side dialog (8px) and the toast (4px) keep
their translate, because they enter from an edge.

### Shadow values

16 distinct values (listed under C). After the pass: `--page-hairline` (the C1 ring at the
border alpha), `inset 0 0 0 1px var(--border)` (selected segment), and `inset 0 0 0 1px
var(--accent-line)` (on-page rings). There are no halos and no stripes.
