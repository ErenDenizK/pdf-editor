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
- **Geometry gate.** The Read view lists the frame surfaces that have a laid-out page within
  80 px in the shell's `data-glass-near`; only those surfaces get the backdrop filter, the
  rest paint the solid token, which is the same pixels over the canvas. The list is
  recomputed from the layout on scroll (once per animation frame) and on zoom, and written
  only when it changes.
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
- Glass panels off, then on (Document menu → Appearance, or the palette: "Toggle glass
  panels"). Reload between runs.

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

### 4.4 Legibility (H4)

Pending the owner.

## 5. Decision rule

- **Pass** (H1–H4 hold on the owner's machine, and the owner likes the live build): A15
  applies; DESIGN §2's "everything docked is opaque" changes and §3 gains tiers 2 and 3 (WP
  D1).
- **Fail:** the setting goes; the full-bleed layout and tier 3 stay.

## 6. Notes for the measurement

- **The gate opens more often than research 13 §4.2 expected.** At fit width the pages keep
  48 px (`PAD_X`) from the navigator and the inspector, and the first page starts 64 px below
  the title bar, all inside the 80 px reach, so at fit width the title bar, both panels and
  the status bar blur whenever a page is beside them (the headless runs list all four). The
  pixels are the same either way, since a backdrop filter reads only what lies under its
  element; the 80 px margin is the spec's safety for engines that sample further. If H1 fails
  narrowly, gating on "a page lies under the surface" (0 px) is the first lever to measure.
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
