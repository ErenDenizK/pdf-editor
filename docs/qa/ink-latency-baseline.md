# Ink latency baseline (M8, before the pen work)

Date: 2026-10-03. Build: `develop` at `44f5268` plus the measurement harness only (no
behaviour change). Machine: development container, 4 vCPU, headless Chromium 1194
(Playwright 1.63), viewport 1440 × 900, device pixel ratio 1. **The machine was heavily
loaded** by other jobs (1-minute load average 11–20 on 4 cores) during every run, so the
figures below are an upper bound; the harness's own dispatch fell behind its 240 Hz schedule
by 5–200 ms at p95. Rerun on a quiet machine or in CI (one worker) for a clean baseline.

| §5.1 target | Value | Measured today (range over three runs) |
|---|---|---|
| Preview draw | ≤ 1 ms per frame, flat to 5,000 points | p50 0.2–0.3 ms, p95 0.3–0.7 ms; frames at ≥ 4,000 samples p95 0.4–0.5 ms (flat); max 3.7–22 ms (load spikes) |
| Pointer to preview | event-to-draw p95 ≤ 4 ms | pen line p50 4.9–27 ms, p95 12–190 ms; pen burst p50 6.3–33 ms, p95 37–188 ms; mouse p50 7.8–8.7 ms, p95 20–36 ms |
| Committed stroke visible | ≤ 50 ms after pointer-up | mouse strokes p50 315–335 ms, p95 520–640 ms; 64-stroke burst p50 0.65–2.8 s, p95 1.8–3.9 s; one 5,000-sample stroke 520–940 ms |
| Long tasks in a 64-path burst | none > 50 ms | 15–51 long entries, 36–64 of 64 strokes overlap one, longest 160–240 ms |

In the first two runs the harness stamped each event with its scheduled time, so its own
lateness counted as event-to-draw; the third (final harness) stamps the moment of sending.
Timer resolution is 0.1 ms (the page is not cross-origin isolated), so draw times are
quantised to 0.1 ms.

## How it is measured

- `apps/web/src/annotations/pen/ink-stats.ts`: an opt-in collector, on in development
  builds, with `localStorage['pdf-editor:dev:ink-stats'] = '1'`, or with `?inkstats=1`.
  `window.__inkStats.summary()` gives p50, p95 and max of: samples per stroke; the preview
  draw per animation frame (`performance.now()` around `InkPreview.draw`, also bucketed by
  stroke length); event-to-draw (the newest drawn sample's `event.timeStamp` to the end of
  that draw); the full redraw at release; pointer-up to the settling preview's release (the
  page has painted the committed stroke); and long tasks or long animation frames over
  50 ms overlapping a stroke from its press to its committed stroke being visible.
- `apps/web/e2e/ink-latency.spec.ts` (Chromium): CDP `Input.dispatchMouseEvent` with
  `pointerType`, `force`, tilt and explicit timestamps, paced in real time on the demo report
  (`demo/demo-report-v1.pdf`): a cursive pen line of 5,000 samples at 240 Hz, 64 short pen
  strokes at 240 Hz on one line (one burst), and 12 mouse strokes at 125 Hz. The page clock
  matched the sent timestamps within 0.1 ms in every run, so event times are honoured. The
  expectations are soft and generous; the pen work tightens them to the targets.

```sh
pnpm --filter @pdf-editor/web build
E2E_SKIP_BUILD=1 pnpm --filter @pdf-editor/web exec playwright test e2e/ink-latency.spec.ts --project=chromium
```

## What the numbers say

- The preview draw is cheap and flat in stroke length, as the audit found; the frame budget
  is not the problem.
- Event-to-draw is one to two frames even for a mouse: input waits for the next animation
  frame, then the draw. Nothing draws before that frame (§5.2 items 3 and 5, §5.3 item 10).
- Committed visibility is the largest gap. Isolated strokes take about 320 ms (the 160 ms
  repaint debounce, the engine round trips and a full-page render). In a fast burst each
  stroke bumps the page revision, which restarts the debounce, so strokes become visible
  only in a pause, seconds later (§5.2 item 6, §5.3 items 7–9).
- Long tasks over 50 ms occur during bursts and around the commit of a long stroke
  (smoothing 5,000 samples and repainting); on this loaded machine they hit most strokes.

## After P7 (craft spec §5.2 items 1–6)

Date: 2026-10-03. Build: `develop` at `7d8fd52` plus the P7 changes, in the shared checkout
(other work packages' uncommitted changes included). Same harness, machine and command
(`E2E_PORT=4403`). "Before" is a fresh run of the same harness at `7d8fd52` without P7 on a
quiet machine (1-minute load average 2.3–2.6); "after" is three runs with P7 on a loaded
machine (load average 9.8–16.6 on 4 cores), so the improvement is understated.

| Run | Measure | Before P7 (quiet) | After P7 (loaded, range over 3 runs) |
|---|---|---|---|
| Mouse, 125 Hz, 12 strokes | committed visible p50 / p95 | 231 / 245 ms | 77–140 / 120–294 ms |
| | event-to-draw p50 / p95 | 5.9 / 10.0 ms | 5.9–8.2 / 11–27 ms |
| | preview draw p95 | 0.3 ms | 0.4–1.0 ms |
| 64 pen strokes, 240 Hz (one burst) | committed visible p50 / p95 | 398 / 898 ms | 84–715 / 222–1,154 ms |
| | event-to-draw p50 / p95 | 4.0 / 5.9 ms | 5.2–17 / 13–84 ms |
| | long entries > 50 ms (strokes hit) | 0 (0) | 6–37 (8–57) |
| Pen line, 5,000 samples, 240 Hz | committed visible | 350 ms | 425–772 ms |
| | full redraw at release | 19.1 ms | 2.4–11 ms |
| | preview draw p95 (frames ≥ 4,000 samples flat) | 0.5 ms | 0.6–1.4 ms |

What changed and what it shows:

- **Committed stroke visible** drops by about 150 ms for isolated strokes and bursts: an
  annotation edit now requests its repaint at once instead of behind the 160 ms zoom
  debounce, and a burst no longer restarts that debounce per stroke (item 6). The rest is the
  engine round trips and the full-page render, which §5.3 (dry ink layer, cheaper bursts,
  clip repaint) removes; the 50 ms target is not met yet. The 5,000-sample stroke is
  dominated by the commit (simplification, write, full repaint) and by load.
- **Release redraw**: the last frame now outlines only the stroke's end (the stable part is
  already baked), 19 ms → 2–11 ms for 5,000 samples (items 2 and 5).
- **Event-to-draw** and preview draw times are no better on this loaded machine; drawing still
  waits for the next animation frame (§5.3 item 10). Our own prediction (item 3) closes the
  visible gap between cursor and ink by up to one frame, which this measure does not count.
- **Constant mouse width, one smoothed stroke model, round joins and the pen cursor**
  (items 1, 2, 4, 5) are shape changes covered by unit tests rather than this harness: the
  committed outline lies within 0.5 device px of the last preview frame for a recorded
  mouse stroke (`ink-input.test.ts`).
- The spec's soft ceilings for committed visible p95 are tightened to 1.5 s (line), 3 s
  (burst) and 600 ms (mouse), about 2.5 times the worst value seen loaded.
