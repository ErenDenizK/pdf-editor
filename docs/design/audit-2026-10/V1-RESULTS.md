# V1 results: surface ladder, glass, elevation, capsule, active tool, rise-in

**Date:** 2026-10-01. **Package:** V1 of M6 ([spec](../../specs/experience-redesign.md) §7.1–§7.5,
§12). **Base:** `95c0ced`. DESIGN.md amendments A1, A5 and A6 are applied; A2–A4 and A7 wait for
their packages.

## How it was measured

The translucency audit's method ([../audit/translucency.md](../audit/translucency.md) §6), on both
sides: the real `tokens.css` and `global.css` of the base (before) and of this change (after) were
rendered in Chromium 1194 with `--use-gl=angle --use-angle=swiftshader` (correct
`backdrop-filter`), each glass surface 200×200 over a uniform 400×400 backdrop, and the centre of
the glass and of a 36 px active-tool square sampled. Uniform backdrops are the worst cases: blur
cannot lower the peak of a large white area. The same composite, `tint · a +
clamp(brightness · saturate(backdrop)) · (1 − a)` rounded to 8 bits, is what
`apps/web/src/styles/tokens.test.ts` computes from the token file; model and samples agree to the
level. App frames: both builds served with `vite preview`, 1440×900, reduced motion, the
`images.pdf` fixture; the bar sits over the white page, so its fill there is the worst case.

## Tokens

| Token | Before | After |
| --- | --- | --- |
| `--surface-0` canvas, Home | `#0a0b0d` (L* 3.0) | `#08090b` (L* 2.4) |
| `--surface-1` panels, title and status bar | `#101215` (L* 5.4) | `#181a1f` (L* 9.3) |
| `--surface-2` raised, `--glass-solid` | `#16181c` (L* 8.2) | `#1f2227` (L* 13.1) |
| `--surface-3` view switch on | `#1c1f24` (L* 11.6) | `#272a30` (L* 17.0) |
| `--text-tertiary` | `#858a92` | `#8f949c` |
| `--glass` | `rgb(24 26 31 / 0.5)` | `rgb(48 51 58 / 0.66)` |
| `--glass-filter` | `blur(24px) saturate(1.8) brightness(0.4)` | `blur(28px) saturate(1.8) brightness(0.36)` |
| `--elevation-float` (new) | — (no shadow) | inner top highlight white 0.08, ring black 0.5, `0 8px 24px -8px` black 0.55 |
| `--tool-active-fill` / `--tool-active-ink` (new) | armed tool `--accent-muted` | `--accent` / `--surface-0` |
| `--radius-capsule` (new) | bar `--radius-3` (10) | `--radius-round` |
| `--rise-distance`, `--motion-rise` (new) | popups `scale(0.98)` | `translateY(4px)`, 0 px under reduced motion |

No token was renamed or removed; `--enter-scale` stays for tooltips and dialogs.

## Docked surfaces (WCAG ratio)

| | Before | After |
| --- | ---: | ---: |
| canvas → panel | 1.05 (ΔL* 2.4) | **1.14** (ΔL* 6.9) |
| panel → raised | 1.06 | 1.09 |
| raised → overlay | 1.08 | 1.11 |
| white page vs canvas | 19.69 | 19.92 |

Text on `--surface-0` … `--surface-3`, before → after: primary 15.92–13.36 → 16.11–11.63, secondary
7.33–6.15 → 7.41–5.35, tertiary 5.67–4.76 → 6.53–4.71, accent 6.61–5.55 → 6.69–4.83, danger
7.09–5.95 → 7.18–5.18, warning ≥ 8.83, success ≥ 7.72. Tertiary on a hovered panel row 4.88 → 5.07,
on a current (active-wash) row 4.49 → 4.63.

## Glass (sampled)

| Backdrop | Glass before → after | vs canvas | primary | glass-secondary | glass-danger | warning | accent (non-text) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| white page | `#3f4043` → `#3f4145` | 1.90 → 1.95 | 8.38 → **8.27** | 5.21 → **5.14** | 4.57 → **4.51** | 6.37 → 6.28 | 3.48 → 3.43 |
| yellow figure `#f3d933` | `#3f3910` → `#3f3d26` | 1.69 → 1.81 | 9.41 → 8.91 | 5.85 → 5.53 | 5.13 → 4.85 | 7.15 → 6.76 | 3.91 → 3.70 |
| mid grey | `#252629` → `#303236` | 1.30 → 1.55 | 12.24 → 10.39 | 7.60 → 6.45 | 6.67 → 5.66 | 9.29 → 7.89 | 5.08 → 4.31 |
| saturated blue `#2a6fd6` | `#0c2443` → `#203045` | 1.26 → 1.49 | 12.59 → 10.82 | 7.82 → 6.72 | 6.86 → 5.89 | 9.56 → 8.21 | 5.23 → 4.49 |
| black page | `#0c0d10` → `#202226` | 1.01 → 1.25 | 15.72 → 12.88 | 9.76 → 8.00 | 8.56 → 7.02 | 11.93 → 9.78 | 6.53 → 5.35 |
| app canvas | `#0e0f13` → `#212328` | **1.03 → 1.27** | 15.49 → 12.71 | 9.62 → 7.90 | 8.44 → 6.93 | 11.76 → 9.66 | 6.43 → 5.28 |
| white page under the palette scrim | `#232427` → `#2e3034` | — | 12.55 → 10.69 | 7.80 → 6.64 | 6.84 → 5.83 | 9.53 → 8.12 | 5.21 → 4.44 |

Every text colour used on glass stays AA over every backdrop; the minimum is glass-danger over a
white page at 4.51:1. Over the canvas the bar now reads as a lighter object (L* 4.4 → 13.7), which
was the point: it floats instead of sinking into the field. The hairline ring of
`--elevation-float` holds its edge over a white page, the inner highlight its top edge over the
canvas.

## Armed tool

| | Before (`--accent-muted`) | After (solid `--accent`) |
| --- | ---: | ---: |
| fill vs bar over the canvas | 1.25 | **5.28** |
| fill vs bar over a white page | 1.24 | **3.43** |
| fill vs bar, worst of all backdrops | 1.24 | 3.43 |
| fill vs opaque bar (`--glass-solid`) | — | 5.36 |
| icon (`--surface-0`) on the fill | — | 6.69 (hover 8.00, pressed 5.72) |

In the app (Read, `images.pdf`, bar over the white page), sampled: canvas `#0a0b0d` → `#08090b`,
status bar `#101215` → `#181a1f`, bar fill `#3f4043` → `#3f4145`, armed Select tool `#494d61`
(1.24:1 to the bar) → `#7c8cff` (3.43:1).

Bar buttons are round inside the capsule (radius 18 = 23 − 1 border − 4 padding, concentric with
its ends), so the fill and the hover wash follow the bar's shape.

## Screenshots

Before and after, same scene, both builds (SwiftShader, so the blur is correct):

| Scene | Before | After |
| --- | --- | --- |
| Tool bar over the page (2×) | [before](../screenshots/m6-v1-before-toolbar-crop.png) | [after](../screenshots/m6-v1-after-toolbar-crop.png) |
| Shapes menu over the page (2×) | [before](../screenshots/m6-v1-before-menu-crop.png) | [after](../screenshots/m6-v1-after-menu-crop.png) |
| Read, full frame | [before](../screenshots/m6-v1-before-read.png) | [after](../screenshots/m6-v1-after-read.png) |
| Command palette | [before](../screenshots/m6-v1-before-palette.png) | [after](../screenshots/m6-v1-after-palette.png) |
| Empty app | [before](../screenshots/m6-v1-before-empty.png) | [after](../screenshots/m6-v1-after-empty.png) |

The milestone screenshots under `docs/design/screenshots/` (`m1-*` to `m4-*`) were re-captured
with `CAPTURE_SCREENSHOTS=1`; `git diff` on them shows the before and after of each.
`m4-redaction-applied-1440.png` is written by the same run and was not in the repository before.
The `m0-*`, `m2-search`, `m2-two-up`, `m3-forms`, `m3-page-numbers` and `m3-watermark` frames have no
capture script and were left as they were. The captures run against the working tree, so they also
show the wording and annotation changes other M6 packages had in progress at the time.

## Not in V1

- DESIGN.md §3 still lists the pre-M6 surface, glass and tertiary values in its token block and the
  translucency rule's numbers; they are §7.1–§7.2 values, not A1/A5/A6 text, and move with D1.
- `index.html` and `vite.config.ts` carry `#101215` / `#0a0b0d` as the browser theme colour; outside
  V1's files.
- Ink dots (§7.4) belong to the pen bar (P2); the bar's width transition on a group change (§7.5)
  to T1.
