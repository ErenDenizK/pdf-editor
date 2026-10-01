---
title: "Research: media spike (M7 WP2): 2x screencast, GIF encoders, still compression"
date: 2026-10-01
status: snapshot
---

> Spike WP2 of `docs/specs/presentation.md` §2.3–2.4, run on 2026-10-01 with `tools/media/`
> (`pnpm --filter @pdf-editor/media-tool all`) on clip 1 ("Open many PDFs at once", 6.1 s) and
> the hero still, both with corpus fixtures (`forms-a`, `images`, `many-pages`) until the demo
> fixtures land. Playwright 1.63.0 with **Chromium 141** (`chromium-1194`, the build available
> here; 1.63 expects a newer one, so CI should confirm the frame sizes), ffmpeg 6.1.1. Machine:
> 4 vCPU Xeon @ 2.8 GHz, software rendering, load average 4–5 from other jobs; rates are
> indicative.

# Media spike: 2x frames, GIF encoders, PNG compression

## Decision

1. **Stills** come from `page.screenshot` at 2x (2880 × 1800, lossless) and are framed to
   1800 px. ffmpeg writes the PNG (`-compression_level 9 -pred mixed`); no oxipng.
2. **Clips** keep the emulated 2x context (the app renders at 2x) and record Playwright's
   `page.screencast` frames, which arrive at **1440 × 900, not 2x**, at 32–47 fps. That is
   enough for a 1200 px GIF and a 1440 px video. Real 2x frames are possible (a forced-scale
   window) but arrive at 14–16 fps, too few for a moving pointer. 1.5x gives 20 fps, so the
   spec's 1.5x fallback is not taken. `MEDIA_WINDOW_SCALE=2` keeps the option for a faster
   runner.
3. **GIF**: ffmpeg's two-pass palette, **`stats_mode=full`** instead of the spec's `diff`, and
   **square corners** with the hairline. No gifski.
4. **Animated WebP** is 4.5x smaller than the GIF and keeps real rounded corners. It is the
   candidate for the branch-README render test (§2.4) before any switch. That test needs a
   pushed branch and was not run here.

## Do frames arrive at 2x?

Same scene each time; "motion" covers frame intervals ≤ 100 ms (Chromium sends frames only
on change), with its rate, median, p95 and standard deviation.

| Capture | Frame size | Motion fps | Median / p95 / sd (ms) | Mean frame |
|---|---|---|---|---|
| Emulated 2x, `page.screencast` JPEG q90 (5 runs) | 1440 × 900 | 32–50 | 18–28 / 30–55 / 8–14 | 63 KB |
| Emulated 2x, CDP `Page.startScreencast` JPEG | 1440 × 900 | 40 | 23 / 49 / 10 | 65 KB |
| Emulated 2x, CDP PNG | 1440 × 900 | 44 | 20 / 39 / 11 | 88 KB |
| Emulated 2x, headless shell | 1440 × 900 | 37 | 25 / 44 / 11 | 63 KB |
| Real window, `--force-device-scale-factor=2` (4 runs) | 2880 × 1800 | 13–16 | 56–75 / 84–99 / 11–20 | 155 KB |
| Real window at 1.5, headless shell | 2160 × 1350 | 20 | 46 / 84 / 16 | 110 KB |

- `page.screencast.start({ onFrame, size, quality })` exists in 1.63 and is a thin wrapper over
  CDP `Page.startScreencast` (JPEG only), so the recorder uses it and falls back to CDP only
  for PNG frames or an older Playwright. With an emulated scale factor, Chromium sizes frames
  in CSS pixels whatever `maxWidth` asks for. A real window at a forced scale sends device
  pixels. The full Chromium binary reserves 87 px of its window, and the harness resizes it
  over CDP until the page is exactly 1440 × 900 (at 1.5x this lands on 901 with the full
  binary, but works with the headless shell).
- At 2x, fps falls with pixel count (software raster plus JPEG encoding of 4x the pixels).
  Cursor moves are timed by the clock, not by step count, so a slow capture keeps its length.

## GIF size and quality (clip 1, 1200 × 750, 15 fps, 6.1 s)

| Encoder | From 1x frames | From 2x frames | Time (1x) |
|---|---|---|---|
| ffmpeg palette, `stats_mode=diff` | 542 KB | 359 KB | 2.2 s |
| ffmpeg palette, `stats_mode=full` (chosen) | 504–582 KB | 335 KB | 2.2 s |
| gifski 1.7.1 `--quality 90` | 726 KB | 582 KB | 3.6–5.5 s |
| gifski 1.7.1 `--quality 70` | 365 KB | 300 KB | 4.4 s |
| ffmpeg, rounded **transparent** corners | 8.5–10.3 MB | | |
| animated WebP q80 (libwebp), rounded transparent corners | 129 KB | | |

- **gifski** installs without root as npm's `gifski` (a prebuilt 2022 binary, AGPL-3.0). Watch
  its default width: it caps at 800 px unless given `--width`. At equal width, q90 was larger
  than ffmpeg and q70 smaller. It brings no visible gain on flat dark UI, so the extra binary
  and the licence are not worth it.
- **Transparent corners** make ffmpeg's GIF encoder write every frame whole, about 18x the size.
  GIFs keep square corners and the hairline. Stills, posters and WebP keep the radius.
- **`stats_mode=diff`** spent the palette on the greys under the moving pointer. Colours that
  appear once, such as the rendered thumbnails, lost out: the poster frame's checkerboard
  went blue-grey and the tag dots grey. `full` kept them and was smaller.
- **Glyph edges**: 13 px UI text is clean in every variant at 1200 px. The flat dark UI
  quantises exactly, so Bayer dithering does not show on glyphs. Tiny text inside page
  thumbnails is visibly crisper from 2x frames (one Lanczos pass) than from 1x frames
  (Chromium's downsample, then ours). This is the one place 2x capture would pay off. JPEG q90
  against PNG frames was not compared by eye.

## Still and web clip

- Hero, framed at 1800 × 1125: Playwright's PNG is 127.4 KB and ffmpeg's re-encode
  125.7 KB. oxipng through wasm (`@jsquash/oxipng` 2.3.0) gives 115.1 KB at level 2 (3.0 s)
  and 111.7 KB at levels 4–6 (7–17 s). A further 11% on a file at 21% of its 600 KB budget
  does not justify a dependency. WebP q90 with alpha is 39.9 KB.
- Web clip at 1440 × 900, 30 fps: MP4 (`-crf 20 -preset slow`) 139–146 KB, WebM (VP9 CRF 34)
  135–138 KB, poster 27 KB. All budgets have wide margins.

## Privacy run

Every request of the run went to the preview origin (`out/requests.log`, 228 entries). The
app's CSP stops a cross-origin `fetch` before a request exists. A probe from a page without
CSP showed that the detector fails the scene. The full Chromium binary made its own
background connections (`www.google.com`, `android.clients.google.com`) that the page-level
log does not see. The harness launches every browser with `--no-proxy-server` and a resolver
rule that maps everything except localhost to nothing, and afterwards the proxy saw no
connection.
