---
title: "Research: glass spike S2 (the \"Glass panels\" setting) for M8 §7"
date: 2026-10-03
status: skeleton (measured values pending the owner's machine)
---

> Spike S2 of `docs/specs/craft.md` §7, prepared on 2026-10-03 against the G1 implementation
> (full-bleed Read stage, three glass tiers, the "Glass panels" and "Reduce transparency"
> settings). The contrast results are final: they are computed by
> `apps/web/src/styles/tokens.test.ts` from the real `tokens.css`. The performance results
> that decide S2 need a 2020-class integrated GPU at DPR 2 in Chromium and Safari and are
> **pending the owner's machine**. The only numbers measured so far come from headless
> Chromium on a shared 4-core Linux container that renders on the CPU (SwiftShader, DPR 1),
> through `apps/web/e2e/glass-perf.spec.ts`; they show a direction, not a verdict. No file
> other than this report was written for it.

# Glass spike S2: measured values pending the owner's machine

## 0. Verdict

**Pending.** Contrast passes on every tier and backdrop (§4.3). On a CPU renderer, Glass
panels on roughly doubles to quadruples the median frame interval while scrolling (§4.2);
that says the blur is not free, not whether a real GPU keeps 60 fps. Fill §4.1 on the
owner's machine and apply §5.

## 1. Hypotheses (the pass criteria of spec §7)

| # | Hypothesis | Measured by |
|---|---|---|
| H1 | Under 1 % of frames take longer than 16.7 ms while scrolling and while zooming a 50-page document, both panels open over pages, with Glass panels on | Frame timings, §3.2 |
| H2 | GPU memory with Glass panels on is less than 1.5 × the memory with it off, same document and view | GPU process memory, §3.3 |
| H3 | Every glass text token is AA and the accent ≥ 3:1 on tiers 1, 2 and 3 over white, the canvas, `#808080` and black | `tokens.test.ts` (axe cannot see through `backdrop-filter`) |
| H4 | Panel labels stay legible where a page edge runs under them, on the owner's screen | The owner's eyes, §3.4 |

## 2. What is under test

- **Full-bleed stage.** In Read, the page viewport covers the whole app shell, under the
  title bar, navigator, inspector and status bar; pages are fitted, centred, counted as
  current and scrolled into view in the rectangle the frame leaves free, measured from the
  panels' real sizes and re-fitted on every panel resize (`stage/stage-bleed.ts`,
  `stage/ReadView.tsx`). Its own scroll bars would sit under the frame, so native stand-ins
  are drawn where the old bars were (`stage/ScrollProxies.tsx`). Arrange, Home, Compare and
  the drop overlay keep the stage's own box, which already is the free rectangle.
- **Tier 2, the docked frame**, only with Glass panels on: `rgb(29 31 37 / 0.80)`,
  `blur(40px) saturate(1.4) brightness(0.6)`; `--surface-1` over the bare canvas, `#36373c`
  over white. No shadow; a 1 px inner top highlight. Text on it uses the glass steps.
- **No geometry gate (since 2026-10-04).** The first build gated the blur: only frame
  surfaces with a laid-out page within 80 px blurred, the rest painted the solid token. The
  experience review (finding 7) found that Glass panels then showed no visible change where
  the owner looks, so the gate is gone: with the setting on, all four frame surfaces are the
  tier-2 glass in every view, and whatever passes under them shows through. Pages pass under
  the title bar and the status bar at fit width as well: the top and bottom insets are scroll
  padding of the full-bleed viewport, so at rest the first page sits clear of the title bar
  and, scrolled, its edge runs under it (`stage/read-bleed.test.tsx`).
- **Tier 3, menus and popovers**, always: `rgb(40 43 50 / 0.80)`,
  `blur(32px) saturate(1.6) brightness(0.5)`.
- **Reduce transparency** (`data-transparency="reduced"` on the root) and
  `prefers-reduced-transparency` make every tier solid, rings and shadows kept.

## 3. Method

### 3.1 Set-up

- Build: `pnpm --filter @pdf-editor/web build`, then `pnpm --filter @pdf-editor/web preview`.
- Document: the 50-page file `glass-perf.spec.ts` writes (alternating text pages, 49 lines of
  Helvetica, and image pages, a 640 × 420 noisy gradient), saved by the spec as
  `apps/web/test-results/…/glass-spike-50-pages.pdf`; or any 50-page report with text and
  photographs.
- Window 1440 × 900 CSS px at DPR 2 (a Retina display at its default scaling). Navigator open
  on Pages, inspector open (Mod+Alt+B). Two views: fit width (the pages beside the panels)
  and zoomed in until a page runs under both panels (150 % at 1440 px).
- Glass panels off, then on (Document menu → Appearance, or the palette: "Glass panels:
  off"). Reload between runs.

### 3.2 Frame times (H1)

- **Chromium:** DevTools → Performance → record 5 s of steady scrolling (trackpad, or hold
  ↓ in the page viewport), then 5 s of pinch zoom. Read the frames track; count frames over
  16.7 ms (the summary's "Frames" histogram, or export the trace). Cross-check with
  Rendering → Frame Rendering Stats.
- **Safari:** Web Inspector → Timelines → Rendering Frames, same two gestures.
- Headless trend (no GPU): `E2E_SKIP_BUILD=1 pnpm --filter @pdf-editor/web exec playwright
  test e2e/glass-perf.spec.ts --project=chromium`. It scrolls 240 frames of 24 px per run and
  prints the frame intervals; it never fails on them.

### 3.3 GPU memory (H2)

- **Chromium:** the browser's Task Manager (Shift+Esc), "GPU memory" column of the GPU
  process, read after 10 s of scrolling in each setting; `chrome://gpu` for the renderer.
- **Safari:** Activity Monitor → the "Safari Graphics and Media" / WebContent processes'
  memory, same procedure.

### 3.4 Legibility (H4)

On the owner's screen, with Glass panels on: scroll a page with dark images and one with
black text under the navigator's thumbnails and labels and the inspector's History rows;
check the title bar's tabs over a page edge (white beside the canvas).

## 4. Results

### 4.1 The owner's machine (decides S2)

| Browser | View | Setting | Frames > 16.7 ms | p95 frame (ms) | GPU memory (MB) |
|---|---|---|---|---|---|
| Chromium | Fit width, scrolling | off | pending | pending | pending |
| Chromium | Fit width, scrolling | on | pending | pending | pending |
| Chromium | Zoomed in, scrolling | off | pending | pending | pending |
| Chromium | Zoomed in, scrolling | on | pending | pending | pending |
| Chromium | Pinch zoom | off | pending | pending | — |
| Chromium | Pinch zoom | on | pending | pending | — |
| Safari | Fit width, scrolling | off | pending | pending | pending |
| Safari | Fit width, scrolling | on | pending | pending | pending |
| Safari | Zoomed in, scrolling | off | pending | pending | pending |
| Safari | Zoomed in, scrolling | on | pending | pending | pending |
| Safari | Pinch zoom | off | pending | pending | — |
| Safari | Pinch zoom | on | pending | pending | — |

Machine, GPU, OS and browser versions: pending.

### 4.2 Headless trend (this container, 2026-10-03)

Headless Chromium 141 on Linux, SwiftShader (CPU rendering), DPR 1, 1440 × 900, load average
about 8 on 4 cores from parallel test runs. Two runs of `glass-perf.spec.ts`, 240 frame
intervals each; the frame clock is vsync-quantised (16.7 ms steps).

| View | Setting | Surfaces blurred | p50 (ms) | p95 (ms) | Frames > 16.7 ms |
|---|---|---|---|---|---|
| Fit width | off | none | 16.7 / 33.3 | 33.4 / 66.7 | 42 % / 73 % |
| Fit width | on | title, navigator, inspector, status | 66.6 / 50.0 | 133.4 / 83.3 | 95 % / 98 % |
| Zoomed in (150 %) | off | none | 16.7 / 16.7 | 50.0 / 49.9 | 63 % / 59 % |
| Zoomed in (150 %) | on | title, navigator, inspector, status | 66.6 / 50.1 | 116.6 / 83.4 | 97 % / 98 % |

Reading: on a CPU renderer the four blurred surfaces cost two to four times the median frame;
the container already misses 16.7 ms without glass, so neither row says anything about H1 on
a GPU. GPU memory cannot be read from a headless page.

**Without the gate (2026-10-04).** Same container and method, two runs of the updated
`glass-perf.spec.ts`, which adds a run that scrolls the light table in Arrange (nothing passes
under the frame there, so with the gate it stayed solid; now it blurs). Load average 11–12 on
4 cores, so the absolute numbers are worse than on 2026-10-03; compare within a run.

| View | Setting | Surfaces blurred | p50 (ms) | p95 (ms) | Frames > 16.7 ms |
|---|---|---|---|---|---|
| Fit width | off | none | 16.7 / 16.8 | 33.4 / 50.0 | 38 % / 60 % |
| Fit width | on | title, navigator, inspector, status | 50.0 / 66.7 | 99.9 / 149.9 | 96 % / 95 % |
| Zoomed in (150 %) | off | none | 16.7 / 33.3 | 33.4 / 66.6 | 57 % / 70 % |
| Zoomed in (150 %) | on | title, navigator, inspector, status | 50.0 / 66.7 | 100.0 / 133.4 | 94 % / 95 % |
| Arrange (light table) | off | none | 16.7 / 16.7 | 33.3 / 16.8 | 58 % / 51 % |
| Arrange (light table) | on | title, navigator, inspector, status | 16.7 / 16.7 | 66.6 / 100.0 | 54 % / 56 % |

Reading: in Read the gate was already open at fit width and zoomed in (all four surfaces
blurred in the first runs too), so removing it changes nothing there. Its cost shows where
nothing moves under the frame: in Arrange the median frame is unchanged, but the slow tail
grows (p95 from 17–33 ms to 67–100 ms), since the compositor still re-filters the docked
surfaces on every frame. If H1 fails on the owner's machine, gating the blur to the Read view
(where something passes under the frame) is the cheapest lever, before any per-surface gate.

### 4.3 Contrast (H3, final)

`tokens.test.ts`, the compositing model of research 13 §3 (blurred uniform backdrop ×
saturate × brightness, the tint over it, rounded to 8 bits); every case passes.

| Tier | Over white | Over the canvas | Over `#808080` | Over black |
|---|---|---|---|---|
| 1 floating | `#47494d` | `#212328` | `#33353a` | `#202226` |
| 2 docked frame | `#36373c` | `#181a1f` (= `--surface-1`) | `#27282d` | `#17191e` |
| 3 menus | `#393c42` | `#212329` | `#2d2f35` | `#202228` |

Worst case (white), tiers 1 / 2 / 3: `--text-primary` 7.30 / 9.60 / 8.94,
`--glass-text-secondary` 4.94 / 6.50 / 6.05, `--glass-danger` 4.63 / 6.10 / 5.68, `--warning`
5.54 / 7.29 / 6.79, the accent 3.03 / 3.99 / 3.71.

**Tier 1 at a lower tint alpha (2026-10-04, review finding 7).** The review found the floating
bar near-opaque over a white page and asked for a lower tint alpha with brightness 0.55–0.6, so
content reads through as colour. Swept in the same model, the accent fill against the bar over
a white page (the binding case, today 3.03:1) fails for every candidate with today's tint
`rgb(48 51 58)`:

| Brightness | Tint alpha | Over white | Accent | `--glass-text-secondary` | `--glass-danger` | Bar vs canvas |
|---|---|---|---|---|---|---|
| 0.45 (today) | 0.66 | `#47494d` | 3.03 | 4.94 | 4.63 | 1.27 |
| 0.55 | 0.66 | `#4f5156` | 2.67 | 4.35 | 4.08 | 1.27 |
| 0.55 | 0.55 | `#5a5b5f` | 2.28 | 3.71 | 3.48 | 1.20 |
| 0.55 | 0.45 | `#636467` | 1.99 | 3.24 | 3.04 | 1.14 |
| 0.60 | 0.66 | `#54565a` | 2.47 | 4.02 | 3.78 | 1.28 |
| 0.60 | 0.55 | `#5f6165` | 2.08 | 3.40 | 3.19 | 1.20 |
| 0.60 | 0.45 | `#6a6b6e` | 1.79 | 2.92 | 2.74 | 1.14 |

A darker tint can keep AA text and a 3:1 accent at a lower alpha (the lowest: alpha 0.49 with a
black tint at brightness 0.55, alpha 0.53 at 0.6), but then the bar over the canvas separates
by 1.03:1 (the best passing darker tint reaches 1.14:1), below the 1.265:1 that
`tokens.test.ts` keeps so the bar reads over the canvas (M6 review A4). No value passes every
contrast test, so tier 1 stays as it is.

### 4.4 Legibility (H4)

Pending the owner.

## 5. Decision rule

- **Pass** (H1–H4 hold on the owner's machine, and the owner likes the live build): A15
  applies; DESIGN §2's "everything docked is opaque" changes and §3 gains tiers 2 and 3 (WP
  D1).
- **Fail:** the setting goes; the full-bleed layout and tier 3 stay.

## 6. Notes for the measurement

- **The gate is gone (2026-10-04, review finding 7).** It already opened at fit width (the
  pages keep 48 px from the panels and start 64 px below the title bar, inside its 80 px
  reach), so in Read nothing changed; elsewhere the frame now blurs over the bare canvas,
  which paints the solid token's colour (`tokens.test.ts`: tier 2 over the canvas is
  `--surface-1`). §4.2 has the cost.
- **Full bleed with the setting off.** At rest the Read view is pixel-identical: the page
  positions, the fit, the scroll range and the scroll bar positions are the old ones (the
  stand-in bars are native scrollers with the old range). While scrolling, pages now pass
  under the stage header (around the mode control) and disappear under the opaque title bar,
  where before they were clipped at the header's lower edge. Where scroll bars overlay the
  content (macOS trackpads, Playwright's headless Chromium), the vertical stand-in is a 12 px
  strip at the free rectangle's right edge that takes the pointer.
- **Text on the frame.** With Glass panels on, the frame's secondary and tertiary text use
  `--glass-text-secondary` at once (not only while it blurs), so nothing changes colour when a
  page arrives; the panel's tertiary step merges into secondary. Current-row washes
  (`--accent-muted`), hover washes and badges over the glass are not modelled by the test.
- **Tiles.** `TiledPage` sizes its visible region from the viewport, which now includes the
  area under the frame, so high-zoom tiles also render under opaque panels with the setting
  off; measure memory with that in mind.
