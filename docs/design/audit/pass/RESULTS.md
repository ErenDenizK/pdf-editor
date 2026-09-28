# Design refinement pass: steps 2 and 3 (results)

**Date:** 2026-09-28. **Base:** `f641f55` (the audit build plus the two bug fixes). Steps from
[../README.md](../README.md#proposed-order): **2**, tokens and consolidation (no intended visual
change); **3**, translucency ([../translucency.md](../translucency.md)). The owner decisions D1 to
D16 were taken as recommended.

| Files | What they are |
| --- | --- |
| `step2-NN-*.png` | The audit's capture set after step 2 (tokens only). |
| `step3-NN-*.png` | The same set after step 3 (glass). |

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
