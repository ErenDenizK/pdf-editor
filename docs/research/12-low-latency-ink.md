---
title: "Research: low-latency ink (input, rendering, smoothing, commit) for a Notability-grade pen"
date: 2026-10-03
status: snapshot
---

> Research snapshot gathered on 2026-10-03. Browser support comes from MDN `browser-compat-data`
> (`main`, read that day); Chromium behaviour from its source (`chromium/chromium` mirror,
> `main`); perfect-freehand, tldraw, Excalidraw and Paper.js settings from their source on
> GitHub. developer.mozilla.org, developer.chrome.com, webkit.org, groups.google.com and
> several blogs were blocked by this session's egress proxy, so MDN facts were read from the
> `mdn/content` mirror and some claims rest on search-result abstracts or established
> knowledge; those are marked as such. Code references are to the tree at this date.

# Low-latency ink: making the pen feel like butter

## 0. Verdict

Recto's pipeline is already shaped the right way: native handlers, coalesced samples in a
`Float32Array`, a `desynchronized` canvas, an incremental outline, predicted points never
committed. The "slightly laggy and sticky" feel comes from five specific things:

1. **Mouse and touch width follows speed** (`speedPressure`: 0.75×–1.25× nominal, smoothed
   over 40 ms), so the stroke swells just after every slow-down. Mouse strokes should be
   constant width.
2. **The preview is the raw polyline; the commit is a Catmull-Rom curve**, so the shape
   changes at pen-up.
3. **Main-thread work lands during the next stroke**: each stroke triggers an engine write
   (25–40 ms in the worker at 64 paths, spike 09 §3), a full page re-render (~40 ms at 2×), a
   bitmap upload, and store and React updates, while fluent handwriting starts the next stroke
   within a few hundred milliseconds.
4. **Per-frame cost grows with stroke length** (`InkPreview.draw` refills the whole cached
   `Path2D`), and every move calls `getBoundingClientRect()`, which forces layout if anything
   is dirty.
5. **The OS cursor runs ahead of the ink**, which with a mouse is the most visible latency cue.

Fix these first (constant-width mouse, preview smoothed like the commit, a "dry ink" layer with
deferred page re-renders, bake-once stable layer, cached layout, dot cursor); then add the
Chromium enhancements (Ink API on Windows, `pointerrawupdate` drawing in the handler). WebGL,
WebGPU and a worker canvas are not needed for ink this thin. **Measure first (§8).** Note: the
spec (§6.6) names `perfect-freehand`, but the code uses our own outline
(`packages/engine/src/annotations/ink-outline.ts`); §4 explains why perfect-freehand's
`streamline` should not be adopted for the preview.

## 1. What the code does today

| Area | Today (file) | Effect on feel |
|---|---|---|
| Input | Window listeners during a stroke, pointer capture, `touch-action: none`, coalesced samples, predicted points for one frame (`ink-input.ts`) | Correct |
| Per move | `element.getBoundingClientRect()` on every `pointermove` (and `measure` for zoom) | Forced layout if the DOM is dirty |
| Width, pen | Linear, 0.5×–1.5× nominal | Light writing is thin; no curve |
| Width, mouse/touch | Speed → 1.25×–0.75× (fast at ≥ 2 px/ms), 40 ms one-pole | Swells after slow-downs |
| Paint | One rAF per frame; `desynchronized` 2D canvas over the visible page area (`ink-preview.ts`) | Fine (§2.1); desynchronized gains little when transparent (§3.1) |
| Incremental | Stable points (all but the last two) appended to one `Path2D`; each frame clears the dirty box and fills **the whole stable path** plus the tail | O(stroke length) per frame |
| Commit | `finishInkStroke`: dedupe 0.5 pt, uniform Catmull-Rom (4 steps), Douglas–Peucker 0.3 pt (outline 0.1 pt) (`ink.ts`) | The settle shape differs from the live shape |
| Hand-over | Settling canvas until `whenPainted` (a PDFium page re-render) (`AnnotationLayer.tsx`) | Costly for every stroke |
| Bursts | Each stroke `appendInkPath` → EmbedPDF update + our appearance rewrite of **all** paths (`bursts.ts`; spike 09: 25–40 ms at 64 paths) | O(n²) work per burst; delays the page paint |
| Mid-stroke scroll | The preview canvas is sized to the area visible at `begin` and scrolls with the page | Ink outside that area is clipped until pen-up |

## 2. Input

### 2.1 Event delivery and latency budget

- **`pointermove` is rAF-aligned in Chromium** (since Chrome 60: dispatched just before rAF
  callbacks, half a frame of added latency on average;
  https://developer.chrome.com/blog/aligning-input-events, via abstract). Drawing in the handler
  instead of rAF therefore changes nothing.
- **`pointerrawupdate`** fires "as soon and as frequently as the browser can produce them";
  an app that cannot keep up "will feel less responsive rather than more"
  (https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/element/pointerrawupdate_event/index.md).
  Chrome 77 (secure contexts since 142), Firefox 148, not Safari (BCD). It pays only with a
  desynchronized canvas, where a mid-frame draw can reach the screen a frame earlier
  (MSEdgeExplainers, line 30: https://github.com/MicrosoftEdge/MSEdgeExplainers/blob/main/WebInkEnhancement/explainer.md).
  Cost: one handler per hardware report (up to 1 kHz on gaming mice); it must be allocation-free.
- **Coalesced events** (Chrome 58, Firefox 59, Safari 18.2; BCD) recover Apple Pencil's 240 Hz
  samples (https://webkit.org/blog/16301/webkit-features-in-safari-18-2/, via abstract).
- **End-to-end numbers.** Chromium has had a two-frame input pipeline: 33 ms at 60 Hz
  (https://issues.chromium.org/issues/41158934, via search abstract). Windows' compositor adds
  a frame, which the Ink API removes (MSEdgeExplainers, line 44). Perception thresholds while
  inking: ~30–80 ms drawing, 60–105 ms writing, against ~2–7 ms for dragging (Annett et al.,
  https://webdocs.cs.ualberta.ca/~wfb/publications/C-2014-GI-Latency.pdf, via abstract).
  PencilKit cut Apple Pencil latency from 20 to 9 ms (iPadOS 13: Metal, prediction, mid-frame
  event processing
  (https://www.macstories.net/stories/ios-and-ipados-13-the-macstories-review/23/,
  https://www.idownloadblog.com/2019/06/06/ipados-13-overview-apple-pencil/)). The 2017 Surface
  Pro reached 21 ms minimum digitiser-to-screen, with apps adding up to 50 ms
  (https://www.windowscentral.com/new-surface-pen-improvements,
  https://dancharblog.wordpress.com/2017/05/29/surface-pen-compatibility-interoperability-faq/).
  Apple's WWDC 2019 advice: a few milliseconds of rendering per frame, consistently; predicted
  touches; no transparent layers or blurs over the drawing layer
  (https://developer.apple.com/videos/play/wwdc2019/221/, transcript).
- **Safari on ProMotion iPads caps rAF at 60 Hz by default**
  (https://www.macrumors.com/how-to/enable-smoother-120hz-browsing-in-safari/), so a web pen on
  an iPad is a 60 Hz pen.

### 2.2 Predicted events

Chrome 77, Firefox 89, Safari 18.2 (BCD). Chromium's default predictor is Kalman; it emits
points at the observed event interval (default 8 ms, minimum 2.5 ms) up to **25 ms** past the
last real event (`kMaxPredictionTime`), mice included
(https://raw.githubusercontent.com/chromium/chromium/main/ui/base/prediction/input_predictor.h,
`third_party/blink/renderer/platform/widget/input/input_event_prediction.cc`); the launch
reported good predictions 95 % of the time
(https://groups.google.com/a/chromium.org/g/blink-dev/c/emvtXAXtqWs/m/ohZ_ZkYSEAAJ, via
abstract). Predicted points stay in the tail, never baked or committed (as today). Two
refinements:

- **Cap the horizon at ~16 ms** (overshoot "whips" at sharp turns and pen-up) and drop
  prediction below ~0.05 px/ms, where it only adds jitter.
- **Taper predicted widths** towards 0.8× so a wrong guess is a thin flick. With the Ink API
  active, do not predict: the two predictions "fork" (MSEdgeExplainers, line 69).

### 2.3 Pressure, tilt, twist, altitude by platform

| Platform | `pressure` | tilt / `altitudeAngle`, `azimuthAngle` | `twist` | Notes |
|---|---|---|---|---|
| Safari, iPadOS + Apple Pencil | Yes (Safari 13+) | `altitudeAngle`/`azimuthAngle` from Safari 18.2 | Not documented for Pencil Pro barrel roll | Coalesced/predicted from 18.2; rAF 60 Hz by default |
| Chromium, Windows + Surface Pen / Wacom (Windows Ink) | Yes | tiltX/Y; `altitudeAngle` from Chrome 86 | Wacom Art Pen-class pens only (established knowledge) | Ink API on Windows 11 |
| Chromium, macOS + Wacom | Yes | Yes | Device-dependent | No desynchronized effect on macOS |
| Chromium, Android + Samsung S Pen | Yes, `pointerType: 'pen'` (established knowledge) | Tilt device-dependent | No | desynchronized honoured on Android (BCD) |
| Firefox, Windows | Yes on current builds; earlier builds reported the default 0.5 (https://bugzilla.mozilla.org/show_bug.cgi?id=1031362) | tilt; `altitudeAngle` from 131 | Device-dependent | No desynchronized |
| Firefox, Linux/GTK | Pens long reported as mice (https://bugzilla.mozilla.org/show_bug.cgi?id=1501744) | Unreliable | — | Treat as mouse |
| Any mouse | 0.5 while a button is down | 0 | 0 | Recto's `isDefaultPressure` handles this |

BCD: `pressure`/`tilt` Chrome 55, Firefox 59, Safari 13. Pressure is the only signal worth
acting on now; tilt (a broad-nib highlighter) is a later nicety.

### 2.4 Hygiene (most already in place)

- Passive flags do not matter for pointer events once `touch-action` is `none`. On iPadOS
  set `-webkit-user-select: none` and `-webkit-touch-callout: none` on the layer, so a long press does not start a selection or
  open the loupe (established knowledge).
- **No layout reads in the move path.** Cache the layer rect at `pointerdown`, then update it
  from a `ResizeObserver` (zoom) and a passive `scroll` listener on the scroll container. Today
  `getBoundingClientRect()` runs on every move.
- **No React or store writes between `pointerdown` and the next idle.** `beginDrawingPress`
  calls `store.select(null)` at every press. Skip it when nothing is selected, so no subscriber
  re-renders before the first frame of ink.

## 3. Rendering

### 3.1 `desynchronized` and its limits

BCD: Chrome desktop 81 "ChromeOS and Windows", Chrome Android 75, Safari 15 (accepted, no
documented effect), Firefox no; macOS and Linux Chrome get no benefit. The canvas presents
without syncing with the page, through a hardware overlay where possible. Two documented limits
hit Recto (MSEdgeExplainers, lines 33–41):

- **Overlays cannot alpha-blend** on Windows and ChromeOS, so "inking on top of a document will
  not benefit" from the overlay path. Our live canvas is transparent and sits over the page.
- **Drying is unsynchronised:** clearing the wet stroke and showing the dry one may land in
  different frames, giving a frame without ink or "a flash of darker for non-opaque strokes".

Consequences:
(a) keep `desynchronized` on the live (wet) canvas only, and never on the dry layer of §5;
(b) at pen-up, clear the wet canvas one frame *after* the dry layer has drawn the stroke (two
rAFs), and accept a frame of overlap for opaque ink. For translucent ink (the highlighter) the
wet canvas should not be desynchronized at all;
(c) worth a one-day experiment: an **opaque** wet canvas (`alpha: false`) with the page bitmap
copied under it at `begin`, eligible for an overlay (opaque presets only).

### 3.2 The Ink API (delegated ink trail)

`navigator.ink.requestPresenter({presentationArea})` returns a `DelegatedInkTrailPresenter`.
After drawing each frame, the app calls `updateInkTrailStartPoint(lastTrustedEvent, {color,
diameter})`, and the OS compositor draws the last few pixels ahead of the app until the next
event (https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/ink_api/index.md).
Support: Chrome 94 and Edge 93, experimental. It uses a Windows 11 compositor API; elsewhere the
browser's own path gives a smaller gain. Microsoft claimed "up to 240 %" better latency
(https://mspoweruser.com/microsoft-says-edge-ink-api-improves-ink-latency-on-the-web-by-up-to-240/).
GoodNotes for Windows (a PWA with its Swift engine in WebAssembly) uses it
(https://blog.pwabuilder.com/posts/how-goodnotes-uses-web-apis-to-create-a-great-pwa-for-windows/,
via abstract). The trail is a round solid brush: pass width × zoom as the diameter. About 30
lines behind a feature check; the first Windows enhancement.

### 3.3 Incremental drawing with a variable-width outline

The last joins of a variable-width outline change as points arrive, so "draw only the new
segment" needs care:

| Approach | How | Fit for Recto |
|---|---|---|
| Recompute everything each frame (perfect-freehand style) | Outline all points, fill | O(n) per frame; fine below ~500 points, poor for long strokes at 240 Hz |
| Stamping / round-join segments | Each segment is a trapezoid between two circles (radius wᵢ/2, wᵢ₊₁/2), filled opaque; segments are final at once | Simplest and exact for round joins; needs opaque fill plus group opacity; the output differs slightly from our miter outline |
| **Two layers: baked stable part + recomputed tail** | Points whose joins are final are outlined once and baked; the last k points plus predicted ones are outlined each frame | **What Recto does**, except that it refills the baked `Path2D` every frame |

Fix: fill each stable piece **once** into a backing canvas (off-DOM, wet-canvas size); each
frame `drawImage` only the dirty box from it, then fill the tail. Cost becomes O(dirty area +
tail). Two stacked canvases also work if one wrapper carries the CSS `opacity` (group opacity,
so the overlap does not darken).

### 3.4 Other rendering choices

- **rAF or the handler.** With rAF-aligned `pointermove`, rAF is right; it already batches. Once
  `pointerrawupdate` and a desynchronized canvas are in use, draw synchronously in the handler,
  limited to the tail (a few dozen points).
- **2D, WebGL or WebGPU.** For solid fills Canvas 2D is not the bottleneck; main-thread
  contention is. WebGL/WebGPU (WebGPU: Chrome 144, Safari 26, Firefox 141 on Windows; BCD) pays
  off for textured brushes or thousands of live strokes: later, not now.
- **OffscreenCanvas in a worker** (Chrome 69, Firefox 105, Safari 16.4; BCD). Input still
  arrives on the main thread, so it only helps against main-thread work that §5 removes at the
  source. Revisit if LoAF (§8) shows unavoidable work during strokes.
- **DPR and sizing.** Whole-device-pixel sizing is right; add growth on mid-stroke scroll and a
  DPR-change listener (`matchMedia('(resolution: …dppx)')`).
- **Compositing.** `will-change: transform` on the wet canvas (own layer), `contain: layout
  paint` on the page layer, and no DOM changes in the page while the pen is down.

## 4. Smoothing and width

### 4.1 Where stickiness comes from

| Cause | Mechanism | Size |
|---|---|---|
| Exponential positional filter (perfect-freehand `streamline`) | Each point = previous + t·(input − previous), with t = 0.15 + 0.85·(1 − streamline) (`constants.ts`, `getStrokePoints.ts` in https://github.com/steveruizok/perfect-freehand) | Steady lag ≈ (1 − t)/t samples: 0.74 samples at the default 0.5, 1.1 at tldraw's 0.62. That is 3–5 ms at 240 Hz but 12–19 ms with one sample per 60 Hz frame. With `last: false` the end is also drawn "slightly behind" the last point (README) |
| Speed-driven width (Recto's `speedPressure`, perfect-freehand `simulatePressure`) | Width rises when the hand slows (corners, starts, ends), smoothed with a time constant | Recto: ±25 % of nominal, 40 ms lag. The swell trails the slowdown |
| Live end taper | The tail is a moving taper | A "rubber band" tip |
| Commit smoothing different from the preview | Raw polyline live, Catmull-Rom plus DP at commit | A visible change at pen-up |
| Stabilisers (Krita) | The line deliberately trails the cursor | Right for illustration, wrong for handwriting (https://docs.krita.org/en/reference_manual/tools/freehand_brush.html) |

**Recto has no positional filter in the preview**, which is right for handwriting: Notability
and GoodNotes feel immediate because the tip is never filtered. Jitter is handled at commit.

### 4.2 Filters compared

| Filter | Lag | Jitter removal | Incremental | Use |
|---|---|---|---|---|
| None plus raw coalesced samples | 0 | None | Yes | Live tip, pen and mouse |
| Uniform Catmull-Rom (today, at commit) | 0 at the points; a segment is final once 2 more points arrive | Interpolates, does not denoise | Yes, which matches the "all but the last two" rule | **Also use live** (§4.3) |
| 1€ filter (Casiez et al., CHI 2012) | Low at speed (cutoff rises with speed) | Strong when slow | Yes | Touch and low-rate digitisers. Tune by setting β = 0, lowering `mincutoff` until slow-motion jitter goes, then raising β until fast-motion lag goes (https://gery.casiez.net/1euro/) |
| Schneider curve fitting (Paper.js `simplify`, default tolerance 2.5; Potrace-style) | Whole stroke | Strong | No (fits after the fact) | Post-commit compaction only; changes the shape (https://github.com/paperjs/paper.js/blob/develop/src/path/PathFitter.js) |
| Douglas–Peucker (today: 0.3 pt centre, 0.1 pt outline) | — | Decimation only | No | Keep; 0.3 pt is ~0.4 CSS px at 100 % and invisible below ~300 % zoom |

### 4.3 Make the preview the commit

Run the commit's dedupe (0.5 pt) and Catmull-Rom (4 steps) **in the preview** on stable
pieces. A segment pᵢ→pᵢ₊₁ depends only on pᵢ₋₁…pᵢ₊₂, so it is final exactly when `InkPreview`
already treats points as stable; the tail stays a polyline for one frame. At pen-up only
Douglas–Peucker (0.3/0.1 pt) and rounding differ, so the settle becomes invisible. Export one
`smoothPiece` next to `finishInkStroke` in `ink.ts` so the two cannot drift.

### 4.4 Recommended parameters

In Recto's terms, with tldraw (`packages/tldraw/src/lib/shapes/draw/getPath.ts`) and
Excalidraw (`packages/element/src/shape.ts`) perfect-freehand settings for comparison.

| Device | Width model | Position filter (live) | Commit | Reference points |
|---|---|---|---|---|
| **Pen with pressure** | `w = nominal × (0.6 + 0.8 × ease(p))`, `ease(t) = 0.65t + 0.35·sin(tπ/2)` (tldraw's `PEN_EASING`); one-pole on pressure, τ ≈ 8 ms; ignore the first 1–2 samples' pressure if lower than the third (touch-down ramp) | None | Catmull-Rom plus DP (today) | tldraw real pressure: thinning 0.62, streamline 0.62, smoothing 0.62. Excalidraw: thinning 0.6, smoothing 0.5, streamline 0.5 |
| **Mouse** | **Constant nominal width** (thinning 0) | None | Catmull-Rom plus DP | tldraw "solid": thinning 0; its "draw" style simulates pressure (thinning 0.5), which we reject |
| **Touch (before a pen is seen)** | Constant, or speed at most ±10 % with τ ≤ 20 ms | 1€ starting point: `mincutoff` 1–2 Hz, β tuned in px/ms units (start at 0.001–0.01 per Casiez) | Catmull-Rom plus DP | tldraw simulated pressure: thinning 0.5, streamline 0.64–0.74 |
| **Highlighter preset** | Constant (any device), flat or chisel cap | None | Straight-line snap optional (§7) | tldraw highlight: thinning 0, streamline 0.5, smoothing 0.5 |

No live tapers; an optional short end taper for the pen at commit only.

## 5. Commit path: hiding the hand-over

Native note apps keep ink as vector strokes over a cached page image and do not re-rasterise
the page under the pen (established knowledge). Recto re-renders the page in PDFium after
every stroke and waits for it. Proposal:

1. **A dry-ink layer per page**: a synchronised canvas between the page bitmap and the wet
   canvas holding settled strokes not yet in the bitmap, each tagged with the page revision
   that will contain it. It replaces the settling canvas created per stroke. Group strokes by
   opacity (wrapper opacity per preset).
2. **Defer the page re-render** to burst close, `requestIdleCallback({timeout: 2000})` with no
   pointer down, or a zoom/scroll beyond the layer; never while a pen is down.
3. **Swap atomically**: when revision *r* arrives, in one task draw the bitmap and clear the
   dry strokes tagged ≤ *r*. Both canvases are synchronised, so there is no flash (hence no
   `desynchronized` on the dry layer, §3.1).
4. **Pause other worker renders** (thumbnails, neighbouring pages) while a pen is down.
5. **Batch store and React work** for burst appends to the next idle, and check that hit
   targets of an open burst do not re-render per stroke.

A cheaper 64-path burst (spike 09: update 13–21 ms, re-apply 9–20 ms, outline 9–12 ms):

| Change | Saves |
|---|---|
| Cache each path's outline operators; the appearance is their concatenation | ~9–12 ms → < 1 ms per append |
| Append `/InkList` and widths through the raw host helpers instead of `updateAnnotation` with `regenerateAppearance` (which we then overwrite) | 13–21 ms per append |
| Write an open burst only at burst close (strokes held in the dry layer and a draft) | O(n²) → O(n); changes undo-in-burst and crash safety, so wait for data |

## 6. Mouse specifics

- **Constant width, no positional filter** (§4.4): the biggest single fix for the mouse.
- **Cursor.** While armed, replace `cursor: crosshair` with a dot of the preset's colour and
  on-screen width (width × zoom, clamped to 3–32 px), a 1 px contrasting ring and a centred
  hot spot: `cursor: url(data:image/png;base64,…) 8 8, crosshair`. Chromium and Firefox cap
  cursor images at 128×128; MDN recommends ≤ 32×32
  (https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/css/cursor/index.md).
  Draw the PNG with a canvas; regenerate on preset, zoom and DPR changes.
- **During a stroke** keep the hardware cursor. Hiding it and drawing the dot in the wet canvas
  makes cursor and ink coincide, but the dot then lags like the ink; decide with M6 (§8).
- **Wheel while drawing:** allow scrolling (the stroke continues in page space); re-measure on
  `scroll` and grow the wet canvas over newly revealed areas. Mouse prediction stays on, capped
  at one frame.

## 7. Feature map for a Notability-grade pen

| Feature | Standard / delight | Reference behaviour | Recto |
|---|---|---|---|
| Stroke eraser (whole stroke) | Standard | GoodNotes "Stroke Eraser", Notability "Whole Eraser" (https://support.goodnotes.com/hc/en-us/articles/7353718249231, https://support.gingerlabs.com/hc/en-us/articles/360029432891-Eraser) | Have: the eraser removes the path under it |
| Partial / standard eraser (splits a stroke) | Standard | GoodNotes "Standard" removes a segment; Notability's partial eraser leaves segments that stay editable | Missing: split at the eraser circle, interpolate widths, write the pieces as paths (lasso split rule, `lasso/split.ts`) |
| Precision eraser (pixel) | Delight | GoodNotes "Precision" | Skip: pixels do not map to Ink; use a small partial eraser |
| Erase filter (highlighter only) | Delight | GoodNotes filter; Notability erases highlighter first | Cheap once presets carry a kind |
| Auto-deselect eraser (back to pen on lift) | Delight | GoodNotes and Notability | Small |
| Highlighter behind text | Standard | Notability: the highlighter sits behind the text | ExtGState `/BM /Multiply` in the appearance; `mix-blend-mode: multiply` on the wet canvas |
| Highlighter straight-line snap | Standard | Hold or straight-line mode in both apps | Have Shift; add hold-to-straighten |
| Snap highlighter to text lines | Delight | — | Snap y and height to PDFium text rects under the stroke |
| Hold to straighten / shape recognition | Standard | Apple Notes (iPadOS 14+): draw, pause, it snaps; Notability: hold a second (https://www.cultofmac.com/how-to/how-to-draw-with-shape-recognition-in-ipados-14) | Line first: within 3 px for 500 ms while down → straight line from the first point that follows the pointer until up; shapes later |
| Ruler | Delight | PencilKit, GoodNotes | Later; low value on PDFs |

## 8. Measurement plan

Event Timing reports `pointerdown`/`pointerup` (to next paint, 8 ms granularity) but **not**
`pointermove` or `pointerrawupdate`
(https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/performanceeventtiming/index.md).
Long Animation Frames (LoAF, Chrome 123) attribute long frames to scripts.

| # | Measurement | How | Target |
|---|---|---|---|
| M1 | Press to first ink | Event Timing, `durationThreshold: 16`, `pointerdown` while armed | p95 ≤ 24 ms (one frame plus slack) |
| M2 | Event to draw | In `paint`: `performance.now()` minus the newest drawn sample's `timeStamp` | p95 ≤ 4 ms after the next rAF; ≤ 2 ms in the `pointerrawupdate` path |
| M3 | Frame cost | `InkPreview.draw` time against stroke length (add to `InkPreviewStats`) | Flat in stroke length; ≤ 1 ms at 5,000 points |
| M4 | Long frames during strokes | LoAF from `pointerdown` to `pointerup`, previous stroke's commit included | Zero frames > 50 ms; frames > 16.7 ms < 1 % |
| M5 | True pipeline per event | Perfetto/Chrome trace (`input`, `latencyInfo`, `cc`, `viz`); `EventLatency` slices stage each event to presentation (established knowledge) | Generation to presentation ≤ 2 frames at 60 Hz (≤ 33 ms) |
| M6 | Photon latency | 240 fps camera on fast circles, pen and mouse; count frames tip/cursor to ink; WALT rig if available (https://github.com/google/walt) | Pen on Windows Chromium ≤ 35 ms (≤ 25 ms with the Ink API); mouse ink ≤ 2 frames behind the hardware cursor; iPad Safari ≤ 40 ms |
| M7 | Settle invisibility | Wet canvas before pen-up against dry layer after | Max edge displacement ≤ 0.5 device px at 100 % |

**Playwright harness** (Chromium, CI): CDP `Input.dispatchMouseEvent` with `pointerType:
'pen'`, `force`, `tiltX`/`tiltY` and explicit `timestamp`s along scripted 240 Hz paths. The page exposes `window.__inkStats` (draw-time and event-to-draw
percentiles) and a LoAF log; assertions use M2–M4. A second test records `browser.startTracing` and parses `EventLatency`
as a trend, not a gate (headless timing is noisy). Never `getImageData` during the run (the
read-back serialises the GPU); sample once after the stroke (M7).

## 9. Recommendations for Recto

| # | Change | Expected effect | Effort | Risk |
|---|---|---|---|---|
| 1 | Constant width for mouse; touch constant or ±10 % with τ ≤ 20 ms (`StrokeWidths`, `speedPressure`) | No swelling; main mouse fix | S | Low |
| 2 | Pen pressure curve (`0.6 + 0.8 × ease(p)`), 8 ms pressure smoothing, touch-down ramp guard | Fuller light writing; no touch-down blobs | S | Low |
| 3 | Preview uses the commit's dedupe and Catmull-Rom on stable pieces (shared `smoothPiece` in `ink.ts`) | Invisible settle; smoother live curves | M | Low |
| 4 | Bake stable pieces once into a backing canvas; per frame copy the dirty box and fill the tail (`ink-preview.ts`) | Frame cost independent of stroke length | S | Low |
| 5 | Cache the layer rect (ResizeObserver plus scroll); no `getBoundingClientRect` per move; skip `select(null)` when empty | No forced layouts or re-renders in the input path | S | Low |
| 6 | Dry-ink layer per page; defer the page re-render to burst close or idle; atomic swap by revision; pause thumbnails while the pen is down (`AnnotationLayer.tsx`, `read-controller.ts`, `PageCanvas.tsx`) | Next stroke never competes with PDFium output | M | Medium: revision bookkeeping |
| 7 | Burst appends: cached per-path outline operators; raw `/InkList` append instead of `regenerateAppearance` | 25–40 → ~10 ms per append at 64 paths | M | Medium: engine host change |
| 8 | Preset-coloured dot cursor (PNG data URI, hot spot at centre) | Smaller visible gap; tool feedback | S | Low |
| 9 | Prediction capped at ~16 ms, tapered, off at very low speed | Less overshoot at turns and pen-up | S | Low |
| 10 | Grow or re-`begin` the wet canvas on scroll mid-stroke; DPR-change listener | No clipped ink | S | Low |
| 11 | Ink API (`navigator.ink`) on Chromium/Windows for pen and mouse, prediction off when active | ~1 frame less on Windows 11 | S | Low (feature-detected) |
| 12 | `pointerrawupdate` plus draw-in-handler when the canvas reports `desynchronized` | Up to 1 frame less where overlays apply | M | Medium |
| 13 | Opaque wet canvas (page underlay) for opaque presets, for overlay eligibility | Lowest Chromium latency (Windows, ChromeOS) | M | Medium: experimental |
| 14 | Highlighter: Multiply blend in the appearance and the preview; hold-to-straighten (500 ms, 3 px) | Highlight behind text; straight marks without Shift | M | Low |
| 15 | Partial (segment) eraser through the lasso split rule | Parity with Notability/GoodNotes | M | Medium |
| 16 | Measurement harness M1–M4 in Playwright plus LoAF in development builds; M6 camera protocol before and after | Evidence for all of the above | M | Low |

Order: 16 (baseline); 1, 2, 4, 5, 8, 9 (one small batch); 3, 6, 7; 11, 14, 15; 12 and 13 only
if M6 shows the remaining latency is in presentation, not our code.
