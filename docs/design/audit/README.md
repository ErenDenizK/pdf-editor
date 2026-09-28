# Design refinement audit (DESIGN.md §7): read me first

**For:** the product owner. **Date:** 2026-09-28. **Build:** `9b46d12` (M4 done).
Nothing in the app has been changed yet. This folder is what you review before any visual change
lands.

| File | What it is |
| --- | --- |
| [effects.md](effects.md) | Every visual effect in the app (122 entries in 14 categories), with where it is used, what it looks like and a proposed verdict (keep / tone down / remove / fix). It ends with the value data for the consistency step: radii, border alphas, accent alphas, motion and shadows. |
| [translucency.md](translucency.md) | The frosted-glass proposal: which surfaces, the exact tokens, fallbacks, the AA contrast table and the before/after mock. |
| `NN-*.png` | Screenshots of the current app (1440×900; crops at 2×). |
| `mock-*.png` | Before/after pairs of the translucency mock; `mock-after-*.png` are the full frames. |
| [mock-glass.css](mock-glass.css) | The mock itself. Paste it into DevTools on the running app to try the glass in your own browser. |

## What the pass would change

1. **Translucency.** The floating tool bar, the contextual bars (annotation, image, Arrange),
   the crop banner, the command palette, **menus and popovers** become real frosted glass. The
   tint drops to 50% and the backdrop is blurred, colour-boosted and darkened, so every text
   colour stays AA even over a white page. Docked panels, dialogs and tooltips stay opaque.
   See [mock-03-annotation-bar](mock-03-annotation-bar.png),
   [mock-07-popover-privacy](mock-07-popover-privacy.png) and
   [mock-08-image-bar](mock-08-image-bar.png).
   Expect a **clear** change over colour, images and light page areas, and a **small** one over
   plain white text or dark content. AA puts a hard ceiling on it (translucency.md §5).
2. **Effects that look wrong.** The top ten are below. Most are removals or tone-downs, and two
   are outright bugs.
3. **Consistency.** One radius scale (2 · 4 · 6 · 10 · round), one border alpha (0.10, plus a
   control step for inputs), four accent alphas instead of ten, one warning-notice recipe, one
   enter scale, and one motion curve (already the case) with a `--duration-instant` for drag
   feedback. Colour literals move into tokens.
4. Nothing structural. Layout (§2) and interaction (§4) do not change.

## Proposed order

1. **Bugs first** (no taste involved, small): the keyboard focus ring missing on the Compress
   presets, and the status-bar jump when the privacy popover opens. Both are in the top ten.
2. **Tokens and consolidation**, with no intended visual change: add the radius, border, accent,
   warning and motion tokens and replace the literals. Screenshots before and after should be
   near-identical.
3. **Translucency**: the tokens.css values, the shared `Glass.module.css`, then each surface.
   Check in Chrome, Safari and Firefox.
4. **Tone-downs and removals**, in the order you approve them below.
5. Update DESIGN.md §2 and §3 (new tokens, "floating chrome" now includes menus and popovers),
   then re-capture `docs/design/screenshots/`.

## Top ten "looks wrong"

| # | What | Screenshot | Proposal |
| --- | --- | --- | --- |
| 1 | **No keyboard focus ring on the Compress presets.** The CSS value is invalid, so focus looks identical to "selected". (Bug; measured computed `outline: none`.) | [19-compress-preset-focus-crop](19-compress-preset-focus-crop.png) | fix (effects H3) |
| 2 | **The status bar jumps 8px left when the privacy popover opens and stays shifted** ("Page" loses its "P"). (Bug.) | [20-statusbar-before](20-statusbar-before.png) → [20-statusbar-popup-open](20-statusbar-popup-open.png) | fix (effects, "Layout defect") |
| 3 | **Form field editor glows**: a 2px soft accent halo around a 1px accent border. | [17-form-editor-halo-crop](17-form-editor-halo-crop.png) | remove the halo (C7) |
| 4 | **Accent stripe bent into a bracket** on the selected palette row and the current search hit (a 2px inset stripe inside a 6px-rounded row). | [05-palette-selected-row](05-palette-selected-row.png), [16-search-current-hit-crop](16-search-current-hit-crop.png) | remove the stripe (C3) |
| 5 | **Image tool tints the picture lavender on hover** (accent wash over the image) and rings every image on the page. The page is never supposed to be tinted. | [08-image-hover-crop](08-image-hover-crop.png) | ring only (C8, C9) |
| 6 | **Edit-text tool lights up the whole page**: moving the pointer anywhere on the page outlines every line and hatches every blocked run at once. | [12-text-edit-hover-crop](12-text-edit-hover-crop.png) | outline the hovered line only (C8) |
| 7 | **The "glass" reads as an opaque slab**: at 86% tint the tool bar is a flat #323336 over any white page. This is the owner's original point. | [02-read-toolbar-crop](02-read-toolbar-crop.png), [mock-02-read-toolbar](mock-02-read-toolbar.png) | translucency proposal |
| 8 | **Crop handles look like notches cut into the page**: near-black squares on the white preview, where every other handle set is white. | [18-crop-dialog-crop](18-crop-dialog-crop.png) | white handles (N3) |
| 9 | **Disabled primary buttons turn muddy** (the accent at 50% opacity, label about 2.5:1), and primary buttons have no hover or pressed feedback although secondary ones do. | [18-crop-dialog-crop](18-crop-dialog-crop.png) ("Crop"), [06-dialog-export-crop](06-dialog-export-crop.png) | surface-3 + disabled text; add a primary hover (I1, E14) |
| 10 | **The edited line ghosts**: the inline text editor is 94% white, so the original glyphs show through the new text. | [12-text-edit-open-crop](12-text-edit-open-crop.png) | opaque page white (N6) |

Close runners-up: menus and popovers carry the heaviest border in the app (0.14) while floating
over the document ([04-menu-zoom-crop](04-menu-zoom-crop.png)); four different "this option is
on" looks for segmented controls (effects G4); three warning-border alphas plus one tinted
notice (J4, I12); the image selection's focus is a soft halo instead of the ring (C10).

## Decisions needed (yes / no)

| # | Question | Look at | Recommendation |
| --- | --- | --- | --- |
| D1 | Adopt the translucency tokens and frost the tool bar, contextual bars, crop banner, palette, **menus and popovers**? | `mock-*.png`, [glass-contrast-swatches](glass-contrast-swatches.png) | yes |
| D2 | Keep **tooltips** opaque? | [13-tooltip-crop](13-tooltip-crop.png) | yes |
| D3 | Frost the page-anchored popovers too (text-edit header, note popup, form notice)? | [mock-12-text-edit-open](mock-12-text-edit-open.png) | yes |
| D4 | Border: **one alpha (0.10) plus a control step (0.16) for inputs**? (Choose "no" for a strict single alpha; inputs then rely on their fill, which is weaker for WCAG 1.4.11.) | [06-dialog-export-crop](06-dialog-export-crop.png), [04-menu-zoom-crop](04-menu-zoom-crop.png) | yes |
| D5 | Remove the accent left stripe from the palette's selected row and the current search hit? | [05-palette-selected-row](05-palette-selected-row.png), [16-search-current-hit-crop](16-search-current-hit-crop.png) | yes |
| D6 | With Edit text / Image armed, outline **only the hovered** line or image (rather than every target on the page)? | [12-text-edit-hover-crop](12-text-edit-hover-crop.png), [08-image-hover-crop](08-image-hover-crop.png) | yes |
| D7 | Image hover: ring only, no lavender wash over the picture? | [08-image-hover-crop](08-image-hover-crop.png) | yes |
| D8 | Give primary buttons a hover and pressed state (a slightly lighter or darker accent), and show disabled primaries as surface-3 + disabled text instead of 50% opacity? | [06-dialog-export-crop](06-dialog-export-crop.png), [18-crop-dialog-crop](18-crop-dialog-crop.png) | yes |
| D9 | Remove the glow halo on the form field editor? | [17-form-editor-halo-crop](17-form-editor-halo-crop.png) | yes |
| D10 | White crop handles, the same as annotation and image handles? | [18-crop-dialog-crop](18-crop-dialog-crop.png) | yes |
| D11 | Two "on" patterns only (neutral for view switches, accent-muted for option choices), and "current row" always accent-muted? | [15-focus-ring-segmented-crop](15-focus-ring-segmented-crop.png), [11-redactions-panel-crop](11-redactions-panel-crop.png), [16-search-panel](16-search-panel.png) | yes |
| D12 | Make the inline text editor opaque page white (no ghosting)? | [12-text-edit-open-crop](12-text-edit-open-crop.png) | yes |
| D13 | Radius scale 2 · 4 · 6 · 10 · round, with the text-edit header and note popup going from 10 to 6 like other popovers? | [12-text-edit-open-crop](12-text-edit-open-crop.png), [03-annotation-bar-crop](03-annotation-bar-crop.png) | yes |
| D14 | One honesty-notice recipe (warning hairline at 0.35, no tinted background), and no curved side stripes (crop warning, merge chips)? | [11-redactions-panel-crop](11-redactions-panel-crop.png) | yes |
| D15 | One enter scale (0.98) for popups, the palette and dialogs? (Barely visible; it is for consistency.) | [05-palette](05-palette.png) | yes |
| D16 | Hover on small icon buttons (tab close, thumbnail actions, outline chevrons) uses the normal hover step instead of the brighter "active" step? | [21-tab-hover](21-tab-hover.png), [10-arrange-cell-hover](10-arrange-cell-hover.png) | yes |

Kept as they are (no decision needed unless you disagree): the focus ring (2px accent, offset 2;
[15-focus-ring-toolbar-crop](15-focus-ring-toolbar-crop.png)), the page hairline, redaction marks
([11-redaction-marks-on-page](11-redaction-marks-on-page.png)), hover-revealed row actions, the
thin scrollbars, the single motion curve, the drag ghost, and the rainbow "custom colour" disc.

## Screenshot index

| State | Full frame | Crop |
| --- | --- | --- |
| Empty state | [01-empty](01-empty.png) | [01-empty-card](01-empty-card.png) |
| Read mode, floating tool bar | [02-read-toolbar](02-read-toolbar.png) | [02-read-toolbar-crop](02-read-toolbar-crop.png) |
| Read mode, annotation bar | [03-read-annotation-bar](03-read-annotation-bar.png) | [03-annotation-bar-crop](03-annotation-bar-crop.png) |
| Menus: zoom, Shapes (over the page), document | [04-menu-zoom](04-menu-zoom.png), [04-menu-shapes-over-page](04-menu-shapes-over-page.png), [04-menu-document](04-menu-document.png) | [04-menu-zoom-crop](04-menu-zoom-crop.png), [04-menu-shapes-crop](04-menu-shapes-crop.png) |
| Command palette | [05-palette](05-palette.png) | [05-palette-crop](05-palette-crop.png), [05-palette-selected-row](05-palette-selected-row.png) |
| Dialog (export) | [06-dialog-export](06-dialog-export.png) | [06-dialog-export-crop](06-dialog-export-crop.png) |
| Popover (privacy) | [07-popover-privacy](07-popover-privacy.png) | [07-popover-privacy-crop](07-popover-privacy-crop.png) |
| Image bar, image hover | [08-image-bar](08-image-bar.png) | [08-image-bar-crop](08-image-bar-crop.png), [08-image-hover-crop](08-image-hover-crop.png) |
| Right inspector (annotation selected) | (in 03) | [09-right-inspector](09-right-inspector.png) |
| Arrange: selection, contextual bar, context menu, cell hover | [10-arrange-selection](10-arrange-selection.png), [10-arrange-context-menu](10-arrange-context-menu.png) | [10-arrange-contextbar-crop](10-arrange-contextbar-crop.png), [10-arrange-context-menu-crop](10-arrange-context-menu-crop.png), [10-arrange-cell-hover](10-arrange-cell-hover.png) |
| Redactions panel with marks | [11-redactions-panel](11-redactions-panel.png) | [11-redactions-panel-crop](11-redactions-panel-crop.png), [11-redactions-row-hover](11-redactions-row-hover.png), [11-redaction-marks-on-page](11-redaction-marks-on-page.png) |
| Text editor open on a line; tool hover | [12-text-edit-open](12-text-edit-open.png) | [12-text-edit-open-crop](12-text-edit-open-crop.png), [12-text-edit-hover-crop](12-text-edit-hover-crop.png) |
| Tooltip; toolbar button hover | | [13-tooltip-crop](13-tooltip-crop.png), [14-toolbar-hover-crop](14-toolbar-hover-crop.png) |
| Keyboard focus ring (tool bar, segmented) | | [15-focus-ring-toolbar-crop](15-focus-ring-toolbar-crop.png), [15-focus-ring-segmented-crop](15-focus-ring-segmented-crop.png) |
| Search panel, current hit | [16-search-panel](16-search-panel.png) | [16-search-current-hit-crop](16-search-current-hit-crop.png) |
| Form field editor | [17-form-editor](17-form-editor.png) | [17-form-editor-halo-crop](17-form-editor-halo-crop.png) |
| Crop dialog | [18-crop-dialog](18-crop-dialog.png) | [18-crop-dialog-crop](18-crop-dialog-crop.png) |
| Compress presets, keyboard focus | | [19-compress-preset-focus-crop](19-compress-preset-focus-crop.png) |
| Status bar before / with popover open | | [20-statusbar-before](20-statusbar-before.png), [20-statusbar-popup-open](20-statusbar-popup-open.png) |
| Tab hover | | [21-tab-hover](21-tab-hover.png) |

Not captured: the native drag ghost (the browser snapshots it), the update toast (needs a
service-worker update), the file drag-over overlay and link hotspot hover. Their CSS is covered
in effects.md.

## How the screenshots were made

The production build (`vite build`) was written to a private output directory and served with
`vite preview` on a private port; the shared `apps/web/dist` was not touched. A standalone
Playwright script drove Chromium (build 1194) at a 1440×900 viewport with `deviceScaleFactor: 2`
and `prefers-reduced-motion: reduce`, like the existing `CAPTURE_SCREENSHOTS` pipeline. Full
frames are saved at CSS scale (1440×900) and crops at device scale (2×). Every PNG is under
500 KB.

Chromium ran with `--use-gl=angle --use-angle=swiftshader`. The default headless compositor draws
`backdrop-filter` wrongly (one-directional blur, ghost text at edges), and an early round of
captures was discarded for that reason. Documents: repository fixtures plus a generated
`backdrop.pdf` (a text block, a colour band, a black band and a blue disc) that is not committed.
