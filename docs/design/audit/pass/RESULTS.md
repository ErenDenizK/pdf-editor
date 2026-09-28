# Design refinement pass: steps 2 to 5 (results)

**Date:** 2026-09-28. **Base:** `f641f55` (the audit build plus the two bug fixes). Steps from
[../README.md](../README.md#proposed-order): **2**, tokens and consolidation (no intended visual
change); **3**, translucency ([../translucency.md](../translucency.md)); **4**, the tone-downs,
removals and fixes; **5**, DESIGN.md and the design screenshots. The owner decisions D1 to
D16 were taken as recommended.

| Files | What they are |
| --- | --- |
| `step2-NN-*.png` | The audit's capture set after step 2 (tokens only). |
| `step3-NN-*.png` | The same set after step 3 (glass). |
| `step4-NN-*.png` | The frames that show step 4 best (the full diff table is in the step 4 section). |

The step 2 "before" is the same capture of `f641f55` (not committed; it matches the audit's
`NN-*.png` apart from the two fixed bugs). Full frames are 1440×900 at CSS scale, crops are at
2×; every PNG is under 500 KB.

## How it was measured

Each build was written to a private output directory and served with `vite preview` on a
private port. The audit's capture script drove Chromium 1194 with
`--use-gl=angle --use-angle=swiftshader` (correct `backdrop-filter`), a 1440×900 viewport,
DPR 2 and reduced motion, with the clock pinned so timestamps match. The diff counts pixels whose
largest channel difference is above 0 ("any Δ") and above 8 levels ("Δ > 8", about the smallest
step that shows on a dark UI). **Noise floor:** two captures of the same build differ by at most
0.012% of pixels, all by 1 level.

## Step 2: tokens and consolidation

New tokens: `--radius-page` (2) and `--radius-round`; `--border-hairline` 0.08 → **0.10** (the
single border alpha, also the page hairline and `--border-glass`), `--border-strong` 0.14 →
**0.16** (inputs and control outlines only), `--border-swatch` (0.28, unchanged);
`--accent-line` 0.45, `--accent-highlight` 0.30 and `--accent-highlight-strong` 0.55 next to
`--accent-subtle` 0.08 and `--accent-muted` 0.16; `--warning-line` 0.35;
`--duration-instant` 60 ms; `--enter-scale` 0.98. Every colour literal listed in effects.md is
now a token, except those effects.md keeps: the native drag ghost (K1), document ink and page
content colours (K8) and the rainbow disc (K9).

**Reading the table.** Nothing moves and no shape changes except the two intended radius steps.
Almost every frame differs somewhere, because the hairline alpha is everywhere, but only by the
token rounding: hairlines move 5 to 6 levels (0.08 → 0.10), surface borders on menus, popovers,
tooltips and dialogs about 10 (0.14 → 0.10), inputs about 4 (0.14 → 0.16), and the page hairline
about 10 (0.06 → 0.10). The larger local deltas are the D13 radius on the text-edit header (10 →
6), the on-page radius step 1 → 2 px (image handles, search hits) and the accent rings that moved
to `--accent-line` (0.35 → 0.45). No Δ > 8 area is anything other than those.

Changes the capture set does not show (states that are not captured):

- Honesty notices use one recipe, a `--warning-line` hairline with no fill (D14): the signature
  notice loses its 8% warning tint, the crop warning's 2px curved side stripe becomes the full
  warning hairline, and the forms and redaction notices and badges move from 0.30 / 0.40 to 0.35.
- The file drag-over wash on the stage uses `--scrim` instead of a second dark literal (B3).
- The eraser trail uses `--danger` at 50% instead of a Material red (K2).
- Form fields: the disabled ring uses `--text-tertiary` instead of the pre-AA tertiary (K3); the
  highlight ring is `--accent-line`; the hover ring, 0.70 before, is the solid accent (the same
  hover ring as image and text targets) so that hover stays visible over the 0.45 ring. The
  created-field design outline goes 0.70 → 0.45.
- The annotation hover fill 0.10 → 0.08 (`--accent-subtle`), the stroke-hit hover 0.25 → 0.30
  (`--accent-highlight`), the link hotspot ring 0.50 → 0.45, the text selection 0.35 → 0.30.
- The palette and dialogs enter from `scale(0.98)` instead of 0.985 (D15); the Arrange insertion
  bar uses `--duration-instant`.

| Screenshot | any Δ % | Δ > 8 % | max Δ | Why |
| --- | ---: | ---: | ---: | --- |
| 01-empty-card | 1.370 | 0.000 | 6 | hairline 0.08 → 0.10 (card border) |
| 01-empty | 0.618 | 0.000 | 6 | hairlines 0.08 → 0.10 |
| 02-read-toolbar-crop | 3.241 | 0.311 | 11 | glass border 0.12 → 0.10, tool bar dividers 0.14 → 0.10, page hairline |
| 02-read-toolbar | 1.294 | 0.333 | 11 | hairlines; page and thumbnail hairline 0.06 → 0.10; tool bar border and dividers |
| 03-annotation-bar-crop | 2.324 | 0.204 | 11 | bar border 0.12 → 0.10, bar divider 0.14 → 0.10 |
| 03-read-annotation-bar | 1.297 | 0.336 | 11 | hairlines, page hairline, bar border and dividers |
| 04-menu-document | 1.335 | 0.407 | 11 | menu border 0.14 → 0.10; hairlines |
| 04-menu-shapes-crop | 2.199 | 1.535 | 9 | menu border 0.14 → 0.10 |
| 04-menu-shapes-over-page | 1.344 | 0.377 | 11 | menu border 0.14 → 0.10; hairlines |
| 04-menu-zoom-crop | 2.351 | 1.331 | 9 | menu border 0.14 → 0.10; input borders in the inspector 0.14 → 0.16 |
| 04-menu-zoom | 1.283 | 0.370 | 11 | menu border; hairlines |
| 05-palette-crop | 1.590 | 0.000 | 6 | glass border 0.12 → 0.10, dividers 0.08 → 0.10, keycap borders |
| 05-palette-selected-row | 0.417 | 0.000 | 5 | row hairlines (Δ ≤ 5) |
| 05-palette | 1.724 | 0.000 | 21 | as the crop; max Δ21 is 4 anti-aliased pixels at the corners of the accent stripe (removed in step 4, D5) |
| 06-dialog-export-crop | 1.654 | 0.619 | 10 | dialog border 0.14 → 0.10; input borders 0.14 → 0.16 |
| 06-dialog-export | 1.748 | 0.168 | 10 | dialog border; hairlines |
| 07-popover-privacy-crop | 1.929 | 1.020 | 11 | popover border 0.14 → 0.10; dividers 0.08 → 0.10 |
| 07-popover-privacy | 1.529 | 0.242 | 11 | popover border; hairlines |
| 08-image-bar-crop | 0.526 | 0.036 | 94 | image handles radius 1 → 2 px (max Δ94 at handle corners); bar border and dividers |
| 08-image-bar | 1.401 | 0.344 | 54 | as the crop; hairlines |
| 08-image-hover-crop | 0.713 | 0.708 | 26 | layer-hover ring accent 0.35 → --accent-line 0.45 |
| 08-image-hover | 1.418 | 0.455 | 13 | layer-hover ring; hairlines |
| 09-right-inspector | 1.040 | 0.000 | 6 | hairlines 0.08 → 0.10; input borders 0.14 → 0.16 |
| 10-arrange-cell-hover | 1.900 | 1.511 | 11 | thumbnail hairline 0.06 → 0.10 |
| 10-arrange-context-menu-crop | 1.478 | 0.971 | 11 | menu border 0.14 → 0.10 |
| 10-arrange-context-menu | 1.723 | 0.680 | 11 | menu border; thumbnail hairlines |
| 10-arrange-contextbar-crop | 2.761 | 1.661 | 11 | bar border and dividers; thumbnail hairlines 0.06 → 0.10 |
| 10-arrange-selection | 1.623 | 0.598 | 11 | thumbnail hairlines; bar border and dividers |
| 11-redaction-marks-on-page | 0.388 | 0.010 | 9 | page hairline 0.06 → 0.10 |
| 11-redactions-panel-crop | 0.825 | 0.365 | 11 | honesty notice warning line 0.30 → 0.35; hairlines |
| 11-redactions-panel | 1.274 | 0.232 | 11 | as the crop; hairlines |
| 11-redactions-row-hover | 0.000 | 0.000 | 0 | — |
| 12-text-edit-hover-crop | 1.292 | 1.281 | 13 | layer-hover ring accent 0.35 → --accent-line 0.45 |
| 12-text-edit-hover | 1.510 | 0.541 | 13 | layer-hover ring; hairlines |
| 12-text-edit-open-crop | 1.452 | 1.436 | 227 | text-edit header radius 10 → 6 (D13; max Δ227 at its four corners), border 0.14 → 0.10 |
| 12-text-edit-open | 1.241 | 0.278 | 215 | as the crop; hairlines |
| 13-tooltip-and-hover | 1.341 | 0.349 | 11 | tooltip border 0.14 → 0.10; hairlines |
| 13-tooltip-crop | 5.234 | 0.882 | 9 | tooltip border 0.14 → 0.10; keycap fill 0.06 → 0.075 |
| 14-toolbar-hover-crop | 4.293 | 0.652 | 9 | tool bar border 0.12 → 0.10, dividers 0.14 → 0.10 |
| 15-focus-ring-segmented-crop | 5.965 | 1.176 | 9 | segment hairlines 0.08 → 0.10 |
| 15-focus-ring-toolbar-crop | 5.050 | 1.667 | 9 | tool bar border and dividers |
| 15-focus-ring-toolbar | 1.389 | 0.401 | 11 | hairlines; tool bar |
| 16-search-current-hit-crop | 0.000 | 0.000 | 0 | — |
| 16-search-panel | 1.298 | 0.182 | 54 | search hits 0.28 → --accent-highlight 0.30 and radius 1 → 2 px (max Δ54 at corners); search input 0.14 → 0.16 |
| 17-form-editor-halo-crop | 4.214 | 4.177 | 21 | editor halo accent 0.35 → --accent-line 0.45 (the halo goes in step 4, D9) |
| 17-form-editor | 1.357 | 0.361 | 14 | as the crop; hairlines |
| 18-crop-dialog-crop | 1.757 | 0.806 | 11 | dialog border 0.14 → 0.10; page hairline |
| 18-crop-dialog | 1.826 | 0.240 | 11 | dialog border; hairlines |
| 19-compress-preset-focus-crop | 1.509 | 0.000 | 6 | preset card hairlines 0.08 → 0.10 (Δ ≤ 6) |
| 19-compress-preset-focus | 1.979 | 0.230 | 10 | dialog border; hairlines |
| 20-statusbar-before | 3.571 | 0.000 | 6 | status bar hairlines (Δ ≤ 6) |
| 20-statusbar-popup-open | 3.590 | 0.000 | 6 | status bar hairlines (Δ ≤ 6) |
| 21-tab-hover | 4.256 | 0.000 | 6 | tab bar hairlines (Δ ≤ 6) |

## Step 3: translucency

`--glass` rgb(24 26 31 / 0.5), `--glass-filter` blur(24px) saturate(1.8) brightness(0.4)
(`--glass-blur` removed), `--glass-text-secondary` #b4b8bf, `--glass-text-disabled` #6f737b,
`--glass-danger` #ff8a8a. One global rule, `.glass` in `styles/global.css`, which every
floating surface composes (`composes: glass from global;`): the floating tool bar, the annotation,
image and Arrange contextual bars, the crop banner, the command palette, all menus, the privacy
and link popovers, and (D3) the text-edit header, the note popup and the form notice. Docked
panels, dialogs, tooltips, the created-field popover and the update toast stay opaque.

| Screenshot | any Δ % | Δ > 8 % | max Δ | What changed |
| --- | ---: | ---: | ---: | --- |
| 01-empty-card | 0.000 | 0.000 | 0 | no glass in view |
| 01-empty | 0.000 | 0.000 | 0 | no glass in view |
| 02-read-toolbar-crop | 41.731 | 41.534 | 38 | frosted surface |
| 02-read-toolbar | 2.572 | 2.528 | 76 | frosted surface |
| 03-annotation-bar-crop | 32.763 | 32.251 | 26 | frosted surface |
| 03-read-annotation-bar | 4.232 | 4.160 | 76 | frosted surface |
| 04-menu-document | 10.646 | 10.401 | 76 | frosted surface |
| 04-menu-shapes-crop | 68.888 | 52.593 | 47 | frosted surface |
| 04-menu-shapes-over-page | 4.266 | 3.717 | 76 | frosted surface |
| 04-menu-zoom-crop | 70.685 | 70.139 | 26 | frosted surface |
| 04-menu-zoom | 5.958 | 5.863 | 107 | frosted surface |
| 05-palette-crop | 80.095 | 10.875 | 47 | palette glass (on the scrim: small change) |
| 05-palette-selected-row | 98.067 | 0.000 | 8 | glass under the row, Δ ≤ 8 |
| 05-palette | 23.786 | 3.030 | 47 | palette glass (on the scrim: small change) |
| 06-dialog-export-crop | 0.000 | 0.000 | 0 | no glass in view |
| 06-dialog-export | 2.572 | 0.122 | 33 | only the tool bar under the dialog scrim |
| 07-popover-privacy-crop | 81.463 | 69.639 | 47 | frosted surface |
| 07-popover-privacy | 12.502 | 11.032 | 173 | frosted surface |
| 08-image-bar-crop | 8.725 | 8.595 | 150 | frosted surface |
| 08-image-bar | 4.128 | 4.069 | 150 | frosted surface |
| 08-image-hover-crop | 0.000 | 0.000 | 0 | no glass in view |
| 08-image-hover | 2.571 | 2.557 | 75 | the floating tool bar only |
| 09-right-inspector | 0.000 | 0.000 | 0 | no glass in view |
| 10-arrange-cell-hover | 0.000 | 0.000 | 0 | no glass in view |
| 10-arrange-context-menu-crop | 82.486 | 76.639 | 47 | frosted surface |
| 10-arrange-context-menu | 12.361 | 10.596 | 47 | frosted surface |
| 10-arrange-contextbar-crop | 11.907 | 0.586 | 26 | frosted surface |
| 10-arrange-selection | 1.416 | 0.083 | 38 | the floating tool bar only |
| 11-redaction-marks-on-page | 5.417 | 5.409 | 38 | the tool bar overlaps the page crop |
| 11-redactions-panel-crop | 0.000 | 0.000 | 0 | no glass in view |
| 11-redactions-panel | 2.582 | 2.563 | 75 | the floating tool bar only |
| 11-redactions-row-hover | 0.000 | 0.000 | 0 | no glass in view |
| 12-text-edit-hover-crop | 0.000 | 0.000 | 0 | no glass in view |
| 12-text-edit-hover | 2.572 | 2.562 | 75 | the floating tool bar only |
| 12-text-edit-open-crop | 22.618 | 22.439 | 47 | frosted surface |
| 12-text-edit-open | 3.899 | 3.867 | 75 | frosted surface |
| 13-tooltip-and-hover | 2.572 | 2.522 | 76 | frosted surface |
| 13-tooltip-crop | 54.502 | 54.328 | 26 | the tool bar around the tooltip (the tooltip stays opaque) |
| 14-toolbar-hover-crop | 81.870 | 78.917 | 26 | frosted surface |
| 15-focus-ring-segmented-crop | 0.000 | 0.000 | 0 | no glass in view |
| 15-focus-ring-toolbar-crop | 68.779 | 68.336 | 26 | frosted surface |
| 15-focus-ring-toolbar | 2.573 | 2.498 | 76 | frosted surface |
| 16-search-current-hit-crop | 0.000 | 0.000 | 0 | no glass in view |
| 16-search-panel | 2.575 | 2.563 | 75 | the floating tool bar only |
| 17-form-editor-halo-crop | 0.000 | 0.000 | 0 | no glass in view |
| 17-form-editor | 2.582 | 2.563 | 75 | the floating tool bar only |
| 18-crop-dialog-crop | 0.000 | 0.000 | 0 | no glass in view |
| 18-crop-dialog | 2.572 | 0.122 | 33 | only the tool bar under the dialog scrim |
| 19-compress-preset-focus-crop | 0.000 | 0.000 | 0 | no glass in view |
| 19-compress-preset-focus | 2.572 | 0.122 | 33 | only the tool bar under the dialog scrim |
| 20-statusbar-before | 0.000 | 0.000 | 0 | no glass in view |
| 20-statusbar-popup-open | 0.019 | 0.000 | 2 | the popover edge inside the status-bar crop |
| 21-tab-hover | 0.000 | 0.000 | 0 | no glass in view |

## Contrast on the running app (step 3)

`backdrop.pdf` (the audit's page) at 500% zoom, scrolled so that the floating tool bar sits over
each region; every region is several blur radii larger than the bar. The glass colour is sampled
along the bar's top and bottom padding (102 to 234 samples), and the ratio uses the **lightest**
sample, the worst case for light text. "Page pixel" is the page 90 px above the bar.

| Backdrop under the tool bar | Page pixel | Glass (lightest sample) | primary | glass-secondary | glass-danger | warning | success | accent (non-text, ≥ 3) | glass-disabled (exempt) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| white page | #ffffff | #3f4043 | 8.38 | 5.21 | 4.57 | 6.37 | 5.56 | 3.48 | 2.18 |
| black band | #000000 | #101114 | 15.27 | 9.48 | 8.32 | 11.60 | 10.13 | 6.34 | 3.97 |
| red bar | #d93333 | #3f1114 | 13.05 | 8.10 | 7.11 | 9.91 | 8.66 | 5.42 | 3.39 |
| orange bar | #f2991a | #3f2a10 | 10.96 | 6.81 | 5.97 | 8.32 | 7.27 | 4.55 | 2.85 |
| yellow bar | #f2d933 | #3f3910 | 9.41 | 5.85 | 5.13 | 7.15 | 6.25 | 3.91 | 2.45 |
| green bar | #33a64d | #0c3316 | 11.32 | 7.03 | 6.17 | 8.59 | 7.51 | 4.70 | 2.94 |
| blue bar | #2673d9 | #0c2543 | 12.48 | 7.75 | 6.80 | 9.47 | 8.28 | 5.18 | 3.24 |
| purple bar | #8040b3 | #2c1642 | 13.06 | 8.11 | 7.12 | 9.92 | 8.67 | 5.42 | 3.39 |

The white-page row matches the translucency.md model and its swatch measurement exactly
(#3f4043). The lowest text ratio on the glass is **4.57:1** (glass-danger over a white page);
primary is at least 8.38, glass-secondary 5.21, warning 6.37, success 5.56. The accent (focus ring,
active tool, slider thumbs, checked dot; never text on glass) is at least **3.48:1**.

**Fallbacks**, emulated with the DevTools protocol on the same build (computed on the tool bar):

| Media | Glass background | Backdrop filter | `--text-secondary` | `--text-tertiary` | `--danger` | Border | Sampled over the page |
| --- | --- | --- | --- | --- | --- | --- | --- |
| default | rgba(24, 26, 31, 0.5) | blur(24px) saturate(1.8) brightness(0.4) | #b4b8bf | #b4b8bf | #ff8a8a | rgba(255, 255, 255, 0.1) | (see table above) |
| prefers-reduced-transparency: reduce | rgb(22, 24, 28) | none | #9a9ea6 | #858a92 | #ff6b6b | rgba(255, 255, 255, 0.1) | #16181c |
| prefers-contrast: more | rgb(22, 24, 28) | none | #c2c5cb | #a9adb4 | #ff6b6b | rgba(255, 255, 255, 0.36) | #16181c |
| forced-colors: active | rgb(255, 255, 255) | none | #9a9ea6 | #858a92 | #ff6b6b | rgb(0, 0, 0) | #ffffff |

Browsers without `backdrop-filter` get the base `.glass` rule, which is the opaque
`--glass-solid` with the normal text ladder (the remap lives inside the `@supports` block).

## Step 4: tone-downs, removals and fixes

Every remaining "tone down", "remove" and "fix" verdict in [../effects.md](../effects.md), with
the owner decisions taken as recommended. CSS only, apart from one new global rule
(`.primary-button` in `styles/global.css`) and two tokens (`--accent-hover`, `--accent-pressed`).
No TSX changed: the text runs and image targets are real elements under the pointer, so
"only the hovered one" (D6) needed no new state.

### What changed, per decision

- **D5** (C3): the 2px accent stripe is gone from the palette's selected row (it keeps
  `--surface-active` and primary text) and from the current search hit (now `--accent-muted`,
  G6). The merge/interleave chips lose their curved 3px tag stripe for a 6px tag dot (J3).
- **D6** (C8, F13): with Edit text or Image armed, the page-wide `.layer:hover` rings are
  gone. Only the run or image under the pointer (or with keyboard focus) is marked; a
  blocked run is hatched only under the pointer or on focus. Hover is gated by
  `(hover: hover)`.
- **D7** (C9): an image under the pointer gets a 1px accent ring and no fill; text runs keep
  the `--accent-muted` fill.
- **D8** (I1, I13, E14): primary buttons in all eleven modules compose `.primary-button`:
  `--accent-hover` #8f9dff on hover, `--accent-pressed` #6f7ff5 while pressed,
  `--surface-3` + `--text-disabled` when disabled (no 50% opacity). The disabled
  secondary button of the Compress and image-export dialogs uses `--text-disabled` instead
  of opacity. The primary `background-color` transition now runs.
- **D9** (C7): the 2px halo around the form field editor is gone; its 1px accent border stays.
- **D10** (N3): crop handles are page white with a 1.5px accent stroke, like the annotation
  and image handles. The preview sheet no longer clips them (they, and their focus ring, used
  to be cut in half at the page edge). Created-field handles move from a 1px to the same
  1.5px stroke (N2).
- **D11** (G4, G5, G6, C4): option choices are `--accent-muted` with no accent border
  (furniture segments, created-field segments, the Forms panel toggles, the Compress presets,
  the text-edit fit choices, the search toggles, which also lose their ring). View switches
  are `--surface-3` + inset hairline (the signature dialog tabs gain the hairline). Current
  rows are `--accent-muted` everywhere (the History step and the current file join
  Comments, Forms, Redactions and the search hit). Inside a current row or a checked preset,
  `--text-tertiary` steps up to `--text-secondary`: tertiary on the muted fill is 4.3:1.
- **D12** (N6): the inline text editor is opaque page white.
- **D14** (J4): the dead-links notice in the Outline panel and the restricted-permissions
  notice (Document tools) take the one notice recipe, a `--warning-line` hairline with no
  fill. The merge chip stripe is J3 above.
- **D15**: confirmed; Menu, Popover, Tooltip, the palette and every dialog enter from
  `scale(var(--enter-scale))`.
- **D16** (F2): the tab close button, the Arrange cell actions and the outline chevrons hover
  with `--surface-hover`.

### Other verdicts

- **C10 / H6**: the focused image selection shows the standard focus ring instead of a 3px
  `--accent-muted` halo.
- **E11**: the tool dialogs' progress bar animates its width like the export dialog's.
- **F4 / H4**: the Document tools inputs take the shared input look: `--border-strong`, no
  hover, the focus ring at offset 0 (they had a hairline, a hover border and an accent border
  instead of the ring).
- **F5**: the image bar actions and the text-edit fit choices gate their hover by
  `(hover: hover)`.
- **F6**: the note popup's and the signature dialog's secondary buttons get the shared hover.
- **H9**: the remaining `2px solid var(--accent)` outlines on radio wrappers and form targets
  are written as `var(--focus-ring)` (same pixels).
- **I9**: the corner chevrons on the Shapes and Stamp tools use `--text-tertiary` (which
  resolves to `--glass-text-secondary` on the glass) instead of 0.7 opacity.
- **J6**: the stage's file drag-over outline is dashed, like the light table's.
- **N4**: the created-field placement preview uses `--accent-subtle`, the one preview fill.
- Already done in step 2 and re-checked: B3, C1, C5, C6, E3, E10, F10, G10, I12, J1, J2, J5,
  K1 to K7, L1.
- Kept as they are (verdict "keep"): C12 (the lock badge ring stays a `box-shadow`; as a
  border it would shrink the disc by 2px), E15 (per-module reduced-motion overrides) and N7
  (the free-text editor keeps its 85% white field).

**A defect found on the way.** The global `::selection` colour is chrome text (#e6e7ea), so
selected glyphs inside the page-white editors (text edit, form field, free text) were
near-white on white and disappeared. They now keep their ink (`color: currentcolor`) on an
`--accent-highlight` fill ([step4-23](step4-23-text-edit-selection.png)).

### Screenshots

Same method as steps 2 and 3, on the step 3 capture as the "before". The base set was
re-captured once more for 06 and 07: in the first run the page canvas of those two frames
rendered at a different moment (1.7% of pixels on the page heading, not CSS), and a second
capture matched step 3 there exactly. Rows 22 to 24 come from an extra script that captures
states the base set does not (primary hover and pressed in the export dialog, a selection
inside the inline editor, a blocked run under the pointer), on both builds.

| Screenshot | any Δ % | Δ > 8 % | max Δ | Why |
| --- | ---: | ---: | ---: | --- |
| 02-read-toolbar-crop | 0.053 | 0.052 | 39 | I9: the Shapes and Stamp corner chevrons use the tertiary text step instead of 0.7 opacity |
| 02-read-toolbar | 0.744 | 0.722 | 31 | G6: the current History row is accent-muted; I9 chevrons |
| 03-read-annotation-bar | 0.568 | 0.553 | 38 | G6 current History row; I9 chevrons |
| 04-menu-document | 2.073 | 0.328 | 31 | G6 current History row; F4 metadata inputs take the control border (0.10 → 0.16) |
| 04-menu-shapes-over-page | 0.754 | 0.721 | 38 | G6 current History row; I9 chevrons |
| 04-menu-zoom-crop | 17.373 | 0.315 | 13 | F4 metadata inputs and G6 current row, seen blurred through the menu glass (Δ ≤ 13) |
| 04-menu-zoom | 1.577 | 0.594 | 31 | G6 current History row; F4 metadata inputs |
| 05-palette-crop | 0.024 | 0.024 | 212 | D5: the accent stripe on the selected row is gone |
| [05-palette-selected-row](step4-05-palette-selected-row.png) | 0.612 | 0.597 | 209 | D5: the accent stripe is gone; the row keeps surface-active and primary text |
| 05-palette | 0.752 | 0.544 | 212 | D5 stripe; the current History row under the scrim |
| 06-dialog-export | 0.743 | 0.536 | 14 | G6 current History row and F4 inputs under the dialog scrim |
| 07-popover-privacy | 0.754 | 0.721 | 31 | G6 current History row; F4 metadata inputs |
| [08-image-bar-crop](step4-08-image-bar-crop.png) | 2.685 | 2.680 | 131 | C10/H6: the focused image selection shows the standard 2px focus ring instead of a 3px accent-muted halo |
| 08-image-bar | 1.221 | 1.199 | 131 | C10 focus ring; G6 current History row |
| [08-image-hover-crop](step4-08-image-hover-crop.png) | 69.510 | 59.329 | 72 | D6/D7: no lavender wash over the picture; only the hovered image gets a 1px accent ring |
| 08-image-hover | 12.751 | 10.974 | 72 | D6/D7 as the crop; G6 current row |
| [09-right-inspector](step4-09-right-inspector.png) | 3.089 | 3.044 | 31 | G6: the current History row is accent-muted instead of surface-2 |
| 10-arrange-context-menu | 0.741 | 0.721 | 31 | G6 current History row |
| 10-arrange-selection | 0.741 | 0.721 | 31 | G6 current History row |
| 11-redaction-marks-on-page | 0.007 | 0.007 | 37 | I9: a tool bar chevron at the edge of the crop |
| 11-redactions-panel | 0.743 | 0.720 | 31 | G6 current History row |
| [12-text-edit-hover-crop](step4-12-text-edit-hover-crop.png) | 1.465 | 1.458 | 72 | D6: only the line under the pointer is marked; the other lines lose their 0.45 ring |
| 12-text-edit-hover | 1.403 | 1.368 | 72 | D6 as the crop; G6 current row |
| [12-text-edit-open-crop](step4-12-text-edit-open-crop.png) | 10.566 | 1.456 | 234 | D12/N6: the editor is opaque page white (no ghost glyphs); the selected glyph keeps its ink (new fix, see below) |
| 12-text-edit-open | 1.378 | 0.795 | 234 | D12 as the crop; G6 current row |
| 13-tooltip-and-hover | 0.744 | 0.722 | 31 | G6 current History row; I9 chevrons |
| 15-focus-ring-toolbar | 0.744 | 0.722 | 31 | G6 current History row; I9 chevrons |
| [16-search-current-hit-crop](step4-16-search-current-hit-crop.png) | 37.858 | 37.065 | 196 | D5: the bent stripe is gone; the current hit is accent-muted like the other current rows (G6) |
| 16-search-panel | 1.483 | 1.431 | 197 | D5/G6 as the crop; the current History row |
| [17-form-editor-halo-crop](step4-17-form-editor-halo-crop.png) | 4.214 | 4.204 | 92 | D9/C7: the 2px halo around the field editor is gone |
| 17-form-editor | 0.859 | 0.828 | 62 | D9 as the crop; G6 current row |
| [18-crop-dialog-crop](step4-18-crop-dialog-crop.png) | 0.829 | 0.829 | 245 | D10/N3: white crop handles, no longer clipped by the preview; D8: the disabled Crop button is surface-3 with disabled text |
| 18-crop-dialog | 0.994 | 0.786 | 245 | D10 and D8 as the crop; G6 current row under the scrim |
| [19-compress-preset-focus-crop](step4-19-compress-preset-focus-crop.png) | 25.120 | 25.030 | 176 | D11/G5: the checked preset is accent-muted with its hairline (no accent border); its hint steps up to secondary |
| 19-compress-preset-focus | 1.694 | 1.486 | 176 | D11/G5 as the crop; G6 current row under the scrim |
| 20-statusbar-popup-open | 0.019 | 0.000 | 2 | noise (the popover edge; the same 0.019% as step 3, Δ ≤ 2) |
| [22-primary-hover](step4-22-primary-hover.png) | 4.043 | 3.918 | 19 | D8: the primary button is one step lighter on hover (#8f9dff); before, hover did nothing |
| [22-primary-pressed](step4-22-primary-pressed.png) | 4.043 | 3.863 | 13 | D8: one step darker while pressed (#6f7ff5) |
| [23-text-edit-selection](step4-23-text-edit-selection.png) | 33.678 | 31.804 | 234 | Selected glyphs in the inline editor keep the page ink on an accent-highlight fill; before they were near-white on white (invisible) |
| [24-text-edit-blocked-hover](step4-24-text-edit-blocked-hover.png) | 0.637 | 0.634 | 59 | D6: the blocked run is hatched only under the pointer; the other lines are no longer ringed |

Unchanged (0 pixels): 01-empty-card, 01-empty, 03-annotation-bar-crop, 04-menu-shapes-crop,
06-dialog-export-crop, 07-popover-privacy-crop, 10-arrange-cell-hover, 10-arrange-context-menu-
crop, 10-arrange-contextbar-crop, 11-redactions-panel-crop, 11-redactions-row-hover, 13-tooltip-
crop, 14-toolbar-hover-crop, 15-focus-ring-segmented-crop, 15-focus-ring-toolbar-crop,
20-statusbar-before, 21-tab-hover.

Almost every full frame shows the same 0.74% (Δ 31): the current History row in the right
panel, now `--accent-muted` instead of `--surface-2`.

### Contrast of the changed states

Computed with the WCAG formula from the token values; the sampled column is the most common
colour in that region of the step 4 capture.

| State | Colours | Ratio | Sampled |
| --- | --- | ---: | --- |
| Current row / option choice, text | `--text-primary` on accent-muted over surface-1 (#21263a) | 12.1 | #21263b (History row, search hit, preset) |
| same, secondary text | `--text-secondary` on #21263a / over surface-3 (#2b3047) | 5.57 / 4.83 | |
| same, tertiary text (stepped up to secondary) | `--text-tertiary` on #21263a would be | 4.31 | #9a9ea6 in the checked preset's hint |
| Search mark inside the current hit | primary on accent-muted twice (#30365a) | 9.43 | #30375a |
| Text-edit fit choice pressed, on glass over a white page | primary on #494c61 | 6.82 | |
| Primary button label (#0a0b0d): rest / hover / pressed | on #7c8cff / #8f9dff / #6f7ff5 | 6.61 / 7.91 / 5.65 | #8f9dff, #6f7ff5 |
| Primary button fill vs dialog (surface-1): rest / hover / pressed | | 6.30 / 7.54 / 5.39 | |
| Disabled primary | `--text-disabled` on surface-3 (exempt, WCAG 1.4.3); fill vs surface-1 | 1.98; 1.14 | #1c1f24 / #4a4e55 |
| Image and text-run hover ring (1px accent) on a white page | #7c8cff on #ffffff | 2.98 | |
| Text-run hover fill under black page ink | #000 on accent-muted over white (#eaedff) | 18.1 | |
| Crop handle: white face vs the dark preview frame; accent stroke vs the white page | | 19.7; 2.98 | |
| Selected glyphs in page editors | #000 on accent-highlight over white (#d8dcff) | 15.6 | #d7dcff / #000000 |
| Merge chip tag dots on surface-2 | tag-0 … tag-5 | 6.39 to 7.85 | |
| Notice border | `--warning-line` over surface-1 (#60502a), decorative | 2.39 | |
| Input border (F4) | `--border-strong` over surface-2 | 1.63 | |
| Tool bar corner chevron on glass over a white page | #b4b8bf on #3f4043 (was 0.7 × primary, 5.06) | 5.21 | |

Every changed text state is AA. Two non-text notes: the 1px accent ring (hover on images and
text runs, and the crop handle stroke on a white page) is 2.98:1, a hair under 3:1; it is the
same ring and stroke the annotation and image handles already use, and hover is not the only
way to reach a target (Tab and arrows focus it with the 2px focus ring). The input border
(1.63:1) and the disabled button are unchanged in kind from step 2 and the audit (inputs are
also identified by their surface-2 fill and label; disabled controls are exempt).

## Step 5: DESIGN.md and the design screenshots

DESIGN.md §2 now says which surfaces are glass (floating chrome, including menus and
popovers) and which stay opaque; §3 carries the token scale as shipped (radii, border
alphas, accent alphas and the two button steps, glass tokens and text colours, the warning
line, motion and the enter scale) and the state rules; §5 lists the focus-offset overrides
(effects H2); §7 is marked done with a pointer here.

`docs/design/screenshots/` was re-captured with the app's own opt-in capture
(`CAPTURE_SCREENSHOTS=1`) on the production build, in Chromium with the SwiftShader
compositor so the glass is drawn correctly: the light-table, annotations, tools, redaction,
text-edit and document-tools specs (17 files, 88 to 297 KB each). The two Turkish light-table
frames (`m1-light-table-tr`, `m1-split-dialog-tr`) were written by a one-off copy of that step,
because the spec still looks for the old Turkish label "Düzenleme’de göster" (the string is
now "Sıralama’da göster"), so the spec's capture test cannot reach them. The M0, M2 search
and two-up, and M3 forms, page-numbers and watermark frames have no spec that writes them any
more and still show the pre-pass look.
