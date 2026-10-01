# Experience audit (2026-10)

**For:** the owner and the M6 work packages. **Date:** 2026-10-01. **Build:** `develop` @
`b66d45d` (M5 done), production build served by `vite preview`, driven by Playwright
(Chromium 1194 with SwiftShader so `backdrop-filter` renders), 1440×900,
`prefers-reduced-motion: reduce`, English UI unless noted. Measurements come from
screenshot pixels and `getComputedStyle`. Nothing in the app was changed.

Prompted by the owner's review after M5 (`DISCUSSION.md` #23): "the features are good, but
the app is too complicated". The plan that answers it is
[`docs/specs/experience-redesign.md`](../specs/experience-redesign.md).

**Screenshots.** The full set (67 captures) stays in the audit archive and is referred to
by file name. The eight below are copied into [`audit-2026-10/`](audit-2026-10/) with their
names unchanged, each under 400 KB.

| File | Shows |
|---|---|
| [02-read-default](audit-2026-10/02-read-default.png) | Read with three documents: five regions, 7-icon rail, 18-icon bar, inspector open on a metadata form |
| [03-rail-05-redactions](audit-2026-10/03-rail-05-redactions.png) | A panel that opens with a seven-line warning and a disabled button before any content |
| [11-document-menu](audit-2026-10/11-document-menu.png) | The unlabelled Document menu: 21 flat items, 7 disabled "Remove" twins, no Merge |
| [27-toolbar-2x-crop](audit-2026-10/27-toolbar-2x-crop.png) | The tool bar at 2×: equal-weight icons, the armed tool at 1.24:1, disabled page actions |
| [33-pen-three-strokes](audit-2026-10/33-pen-three-strokes.png) | The style bar of the last stroke covering the line written before it |
| [34-pen-colour-not-remembered](audit-2026-10/34-pen-colour-not-remembered.png) | A stroke recoloured blue, the next one red again |
| [43-rail-comments-with-annotations](audit-2026-10/43-rail-comments-with-annotations.png) | Each pen stroke as its own "Ink · No author · No comment text" row and history entry |
| [50-arrange-default-one-doc](audit-2026-10/50-arrange-default-one-doc.png) | Arrange with three documents open, showing one |

## 1. Friction, ranked (impact × frequency)

| # | Friction | Evidence |
|---|---|---|
| 1 | Every pen stroke selects itself and opens a 576 px style bar 86 ms after pointer-up; the bar sits 52 px above the stroke and covers the previous line; the inspector switches to Properties | `32-pen-after-stroke-1s`, `33-pen-three-strokes` |
| 2 | Tool colour and width cannot be set before drawing, and a change is not remembered | `21-tool-ink-armed`, `34-pen-colour-not-remembered` |
| 3 | Merge is invisible: not on screen, not in the Document menu, and Arrange shows one document | `11-document-menu`, `50-arrange-default-one-doc` |
| 4 | One stroke = one annotation = one Comments row = one undo step | `43-rail-comments-with-annotations` |
| 5 | 18 unlabelled, equally weighted tool bar icons; armed state 1.24:1; 3 disabled page actions, one "coming soon" | `27-toolbar-2x-crop` |
| 6 | Too much at once: 7 rail tabs, inspector and metadata form open by default; panels lead with settings and warnings | `02-read-default`, `03-rail-*` |
| 7 | Everything else is behind an unlabelled icon, a right-click or the palette | `11-document-menu`, `53-tab-context-menu` |
| 8 | Vocabulary: "pen" and "draw" do not find Ink; "sign" means an image tool and a certificate signature | `57-palette-search-sign` |
| 9 | Duplicate controls: annotation bar and inspector; Pages panel and Arrange; two bars in Arrange | `40-annotation-selected-bar-and-inspector`, `52-arrange-selection-contextbar` |
| 10 | Flat chrome: canvas vs panels 1.05:1, glass reads as a grey slab, no elevation | `02-read-default`, `27-toolbar-2x-crop` |
| 11 | Pen engineering: blink at commit, unsmoothed preview, no pressure or coalesced events, fingers draw, a press while an editor is open is lost | `35a-pen-frame-0ms-after-up`, `35b-pen-frame-30ms-after-up` |
| 12 | Smaller: image selection not shown in the inspector, Compare segment hidden until first use, signatures not saved, no light theme behind the `[data-theme]` hook | `24-tool-image-selected`, `70-prefers-light-no-light-theme` |

## 2. Information architecture

Totals: 7 rail tabs (+1 in Compare) · 19 tool modes plus 3 page actions · 21 Document-menu
items · 136 palette commands in 11 groups · 6+ inspector sections · 11 tab-menu items ·
8 Arrange selection actions.

| Surface | Contains | Friction |
|---|---|---|
| Rail: Pages | Thumbnails of the active document | Duplicates Arrange for one document |
| Rail: Outline | Add bookmark, tree, rename | Empty for most PDFs |
| Rail: Search | Field, toggles, results by page, "Mark all N matches for redaction" | A redaction action inside search |
| Rail: Comments | Author-name field first, then one row per annotation | A handwritten word adds 3–5 rows |
| Rail: Redactions | 7-line warning, Find sensitive data, Apply, list | Warning shown with zero marks |
| Rail: Forms | Add field, Edit, Highlight, Clear all, Flatten on export | 5 controls when there are no fields |
| Rail: Files | Open files, tag, size | Overlaps the tab bar; where a Home belongs |
| Rail: Changes (Compare) | Summary and list | Added at the top; shifts every icon |
| Tool bar | 15 tool buttons (2 menus) + Rotate, Delete, Extract | No labels; options only after creating something |
| Document menu (`FileCog`) | 21 items, no sections, 7 disabled twins | No Merge, Split, Compare or Rotate |
| Palette | Tools 38, View 21, Pages 23, Document 21, … | Literal search: "draw" finds only "Add bookmark…" |
| Keyboard | One letter per tool, 1/2/3 modes, J/K and R reused by context | Taught only by tooltips and the `?` overlay |

Merge today, after both files are open: palette (Ctrl+K, "merge", Enter, reorder, Merge);
tab right-click → Merge into…; Arrange → "Show in Arrange" on each other tab → drag or
section ⋯ → Merge into…. None is on screen. From an empty app to a merged file on disk the
first-run walk took 9–12 interactions with two dead ends.

## 3. The pen today

Code: `annotations/AnnotationLayer.tsx` (`onRootPointerDown`, `finishDraw`),
`annotations/ink.ts`, `annotations/actions.ts`, `annotations/AnnotationBar.tsx`,
`annotations/annotation-store.ts`.

1. **Arm** (P): crosshair cursor, no style UI; red `#E53935`, 2 pt, fixed.
2. **Down**: clears the previous selection. With an inline editor open the press only
   commits the editor and the stroke is lost.
3. **Move**: one point per event copied into a new array and `setState` per move (the
   whole layer re-renders); no `getCoalescedEvents()`; a raw constant-width `<polyline>`;
   `pressure` and `pointerType` ignored; fingers draw; `touch-action: none` blocks
   scrolling.
4. **Up**: the preview is removed before the committed stroke has rendered, so the stroke
   vanishes for about 30 ms (frames 35a, 35b). The committed curve (dedupe 0.5 pt →
   Catmull-Rom → Douglas–Peucker 0.3 pt) shifts slightly from the unsmoothed preview.
5. **Commit**: one `/Ink` annotation per stroke, one history entry, one Comments row.
6. **After**: the stroke is selected, the bar appears 86 ms later, the inspector shows it.
7. **Edit later**: Select (V), click or shift-click strokes; no lasso; the eraser removes
   whole strokes; undo is per stroke.

**Bug 1: the stroke selects itself.** `createAnnotations(target, drafts, options)` defaults
to `select: true`, and `finishDraw` does not pass `false`. `AnnotationLayer` renders
`<AnnotationBar>` whenever something is selected and no gesture runs, so the bar opens
after every stroke. The rule "a contextual bar appears above a selection" (DESIGN §2,
annotations spec §2) was meant for selections the user makes, and was applied to creation.

**Bug 2: `setStyle` is never called.** `useAnnotationStore` holds per-group tool styles
(`styles`, ink `#E53935` 2 pt) and a `setStyle` action, but nothing in `src/` calls it.
The bar edits the selected annotation through `updateAnnotations`, never the tool, so
defaults cannot change during a session and nothing persists across sessions.

## 4. Visual measurements

| Measure | Value |
|---|---|
| Canvas `#0a0b0d` vs panels `#101215` | 1.05:1 |
| Tool bar glass over a white page | flat `#3f4043` |
| Active tool fill vs bar | 1.24:1 (`#494d61` on `#3f4043`) |
| Disabled icon on glass | 2.18:1 |
| Shadows on floating chrome | none, by DESIGN §3 |
| Bar shape | 725×46, 10 px corners, 36 px buttons |

## 5. References used

Notability (pen bar with favourite presets as dots; tapping the armed pen opens its
options; lasso to edit), Apple Preview (style menus act on the selection, otherwise set
the default for the next object; selection never opens on its own), Figma UI3 (bottom pill
with about seven tools, the active tool as a solid accent fill, one soft shadow), Linear and
Arc (stepped near-black surfaces, a 1 px top highlight and a hairline ring on menus).

## 6. After M6

Build `develop` @ `c18dea5`, same setup (Chromium with SwiftShader, 1440×900, reduced
motion, English). The frames are in [`screenshots/`](screenshots/) and are rewritten by the
end-to-end specs with `CAPTURE_SCREENSHOTS=1`; V1's before/after pairs of the visual
refresh are in [`audit-2026-10/`](audit-2026-10/V1-RESULTS.md). The accessibility pass
(A11) and the independent review (R) were still running when this was written.

| # | Friction | What changed | Frames |
|---|---|---|---|
| 1 | A stroke selects itself and opens a style bar | Creating never selects (ink, markup, shapes, stamps); the preview stays until the committed stroke is painted. An end-to-end test watches the page from the first stroke on and sees no bar and no selection | `m6-draw-presets-1440` |
| 2 | Colour and width cannot be set before drawing | A tool's options live in a tier attached to the bar; the pen has four presets as ink dots with an editor on the armed one. Styles and presets persist (`applyStyle` sets the tool when nothing is selected) | `m6-draw-presets-1440`, `m2-annotations-1440` |
| 3 | Merge is invisible | Home shows every open file as a card with "Combine all N files"; merging two dropped files takes 3 actions in the e2e count (drop, Combine, Merge). The Document menu's first section is Combine and split; Arrange shows every open document | `m6-home-three-files-1440`, `m6-document-menu-1440`, `m0-shell-arrange-1440` |
| 4 | One stroke = one annotation, row and undo | Strokes within 1.5 s and 36 pt form a burst: one Ink annotation, one Review row ("Pen · 3 strokes"), one history entry, one undo. The lasso takes paths across bursts and splits them out when edited | `m6-navigator-review-1440`, `m6-lasso-1440` |
| 5 | 18 unlabelled equal icons; armed state 1.24:1 | Six labelled task groups; a group morphs the capsule in place to show its 3–6 tools. The armed tool is a solid accent fill, 3.43:1 against the bar over a white page (worst case) and 5.28:1 over the canvas. Extract pages ("coming soon") left the bar; Rotate and Delete page act on the selected pages, else the current one | `m0-shell-read-1440`, `m0-shell-tooltip-1440` |
| 6 | Too much at once | Four labelled navigator tabs with counts (Pages, Find, Review, Files); the inspector is closed by default; metadata, password and diagnostics moved to the Document info sheet; Review leads with content, with the author asked once inline | `m6-navigator-review-1440`, `m6-document-info-1440`, `m3-forms-1440` |
| 7 | Everything behind an icon, a right-click or the palette | The Document menu is a labelled button with five sections and no disabled twins; Combine, Arrange pages and Compare are buttons on Home | `m6-document-menu-1440`, `m6-home-three-files-1440` |
| 8 | Vocabulary | Ink is "Pen", the image tool is "Signature image", the certificate flow "Sign with certificate…"; the palette matches keywords of both languages without diacritics ("draw", "kalem", "ciz", "birlestir") | `m0-shell-palette-query-1440` |
| 9 | Duplicate controls | The inspector no longer opens on its own, so the contextual bar is the one place a selection is edited; opened, its Properties section still carries the style controls. Arrange shows only its own bar | `m2-annotations-1440` |
| 10 | Flat chrome | Canvas → panel 1.05:1 → 1.14:1; the glass over the canvas 1.03:1 → 1.27:1 with one elevation token; text on glass stays AA (glass-danger 4.51:1 over a white page, the minimum) | `m0-shell-read-1440`, `audit-2026-10/m6-v1-after-*` |
| 11 | Pen engineering | Native pointer input with coalesced and predicted points, one outline function for preview and commit (no shift, no blink), width from pressure or speed written into the appearance (ADR-0018), fingers pan once a pen has been seen, a press while an editor is open commits it and starts the stroke | `m6-draw-presets-1440` |
| 12 | Smaller items | The Compare segment still appears only while a comparison is open (by design); the light theme moved to M8; image selection in the inspector and saved signatures were not part of M6 | — |

First run now: from an empty app to two merged files in Read, 3 actions with no dead end
(`apps/web/e2e/home.spec.ts`). Still open after M6: Home has no per-card menu, no
reordering by drag and no recent files; burst limits N and D are to be tried on a real
tablet with the owner (`docs/ROADMAP.md`, M6 known behaviours).
