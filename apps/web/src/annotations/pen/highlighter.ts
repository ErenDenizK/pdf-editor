/**
 * The Highlighter (craft spec §5.4, ADR-0021 §1): one tool for marking text and paper. It is
 * the pen preset of `kind: 'highlighter'` (`presets.ts`), drawn through the pen's pipeline
 * with its own profile:
 *
 * - **Profile.** Constant width (6–18 pt, 12 by default; no pressure or speed), a tint at
 *   full opacity, Multiply. The preview is drawn at that width and the page layer blends
 *   with Multiply while a highlighter stroke is live or settling (`HighlighterPreview`), so
 *   black text stays black under it as it will in the file. The blend sits on the layer
 *   because the layer is a stacking context (`z-index`): a blend on the canvas inside it
 *   would only blend with the layer's own transparent backdrop.
 * - **On release** (`snapHighlighter`): a glyph is hit when the stroke's band (centre line ±
 *   half the width) covers at least half its height at its centre, along the stroke's
 *   extent. Each part of the stroke belongs to the line whose band holds it, or to paper.
 *   The stroke snaps when, on every line it crosses, the parts that run along the reading
 *   direction (at most 35° off it) over hit glyphs make up at least 70 % of its length
 *   there, and of its whole length. It then becomes a **Highlight** whose quads run from the first to the last hit
 *   glyph of each line (`quads.ts`), in the tint, `/CA 1`, Multiply (the engine writes
 *   highlights with Multiply). Otherwise it is **free ink with Multiply**
 *   (`blendMode: 'multiply'`, constant `/BS /W`, no per-point widths) that joins pen bursts
 *   like any stroke. **Alt** at release forces free ink; a page without text always gives
 *   it. A snapped highlight never joins a burst. Each is one history entry ("Highlight on
 *   page 1", "Pen on page 1").
 * - **Highlight (H)** arms the Highlighter (`activateHighlighter`); a text selection plus H
 *   highlights the selection in the Highlighter's tint instead (`selection-markup.ts`).
 */
import type { PageId, Rect } from '@pdf-editor/document-model';
import type { TextRun } from '@pdf-editor/engine';

import { m } from '../../i18n';
import { announce } from '../../shell/announcer';
import { canEditActive } from '../../state/ui-store';
import { useToolStore } from '../../viewer/tool-store';
import { createAnnotations } from '../actions';
import { type PageTarget, useAnnotationStore } from '../annotation-store';
import { markupDraft } from '../drafts';
import { cssPointToUser, type PageFrame, userToCss } from '../geometry';
import { boundsOf, distanceToPolyline, finishInkStroke, type Point, snapAngle } from '../ink';
import { mountedLayers } from '../layer-registry';
import { pageText } from '../page-text';
import { type GlyphRef, quadsForGlyphs, type TextLine, textLines } from '../quads';
import { hasTextSelection, markupFromSelection } from '../selection-markup';
import { type ToolDefinition, toolDefinition } from '../tools';
import { closeBurst, commitPenStroke } from './bursts';
import { inkCommitted } from './dry-ink';
import type { InkStrokeInput, SettleInk } from './ink-input';
import {
  InkPreview,
  type InkPreviewStyle,
  type PreviewPath,
  type PreviewPoint,
  previewPath,
  type SettlingInk,
} from './ink-preview';
import {
  isHighlighter,
  type PenPreset,
  type PenSettings,
  type PresetIndex,
  PRESET_INDICES,
  presetLabel,
} from './presets';

/** Share of a glyph's height the band must cover for the glyph to be hit. */
export const GLYPH_HIT_SHARE = 0.5;
/** Share of the stroke, on each line it crosses and overall, that must run over hit glyphs. */
export const SNAP_COVERAGE = 0.7;
/**
 * A line holding less than this share of the stroke is not crossed (a wobble into the next
 * line); its part still counts in the whole stroke.
 */
export const LINE_MIN_SHARE = 0.1;
/** Gaps between hit glyphs up to this share of the line's thickness count as covered (spaces). */
const WORD_GAP_SHARE = 0.6;
/**
 * A part of the stroke runs along the reading direction when it is at most this steep
 * (radians): a stroke at 45° over dense text crosses it, it does not mark it.
 */
export const ALONG_MAX_ANGLE = (35 * Math.PI) / 180;
/** Points sampled across a glyph's height. */
const GLYPH_SAMPLES = 9;
/** The stroke is walked in steps of at most this length (points). */
const STEP_PT = 1;

// ---------------------------------------------------------------------------
// The snapping rule (pure)
// ---------------------------------------------------------------------------

export type HighlighterOutcome =
  | {
      readonly kind: 'highlight';
      /** One quad per line, user space, in reading order. */
      readonly quads: readonly Rect[];
      /** Lines the highlight covers. */
      readonly lines: number;
    }
  | {
      readonly kind: 'ink';
      /** Why the stroke stays free ink. */
      readonly reason: 'alt' | 'no-text' | 'off-text';
    };

export interface SnapOptions {
  /** Alt was held at release: free ink. */
  readonly alt?: boolean;
}

interface HitGlyph extends GlyphRef {
  /** Index in the flattened glyph order (runs in engine order, glyphs in run order). */
  readonly flat: number;
  /** Its extent along the line's reading axis. */
  readonly lo: number;
  readonly hi: number;
}

interface LineState {
  readonly line: TextLine;
  readonly hits: HitGlyph[];
  /** Merged extents of the hit glyphs along the reading axis. */
  covered: [number, number][];
  /** Stroke length inside the line's band, points. */
  arc: number;
  /** Of it, the length along the reading axis over hit glyphs. */
  along: number;
}

const reading = (dir: 'h' | 'v', p: Point) => (dir === 'h' ? p.x : p.y);
const across = (dir: 'h' | 'v', p: Point) => (dir === 'h' ? p.y : p.x);

function crossRange(line: TextLine): [number, number] {
  const b = line.box;
  return line.dir === 'h' ? [b.y, b.y + b.height] : [b.x, b.x + b.width];
}

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

/**
 * Whether the band of `path` (half width `hw`) covers at least `GLYPH_HIT_SHARE` of the
 * glyph's height, sampled across the glyph at its centre on the reading axis; the centre
 * must lie within the centre line's extent along that axis.
 */
export function glyphHit(rect: Rect, dir: 'h' | 'v', path: readonly Point[], hw: number): boolean {
  const extent = path.map((p) => reading(dir, p));
  const centre = dir === 'h' ? rect.x + rect.width / 2 : rect.y + rect.height / 2;
  if (centre < Math.min(...extent) || centre > Math.max(...extent)) return false;
  const [lo, size] = dir === 'h' ? [rect.y, rect.height] : [rect.x, rect.width];
  let inside = 0;
  for (let i = 0; i < GLYPH_SAMPLES; i++) {
    const c = lo + (size * (i + 0.5)) / GLYPH_SAMPLES;
    const p = dir === 'h' ? { x: centre, y: c } : { x: c, y: centre };
    if (distanceToPolyline(p, path) <= hw) inside++;
  }
  return inside / GLYPH_SAMPLES >= GLYPH_HIT_SHARE - 1e-9;
}

/** Sorted extents merged across gaps up to `gap`. */
function mergeExtents(extents: readonly [number, number][], gap: number): [number, number][] {
  const sorted = [...extents].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo - last[1] <= gap) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

function inExtents(extents: readonly [number, number][], x: number): boolean {
  return extents.some(([lo, hi]) => x >= lo && x <= hi);
}

/** The line whose band holds the cross coordinate of `p` (the nearest centre when several do). */
function lineAt(states: readonly LineState[], p: Point): LineState | undefined {
  let best: LineState | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const state of states) {
    const c = across(state.line.dir, p);
    const [lo, hi] = crossRange(state.line);
    if (c < lo || c > hi) continue;
    const distance = Math.abs(c - (lo + hi) / 2);
    if (distance < bestDistance) {
      best = state;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * What a released highlighter stroke becomes (the rule in the module header): `path` is the
 * committed centre line and `width` the full width, user space (points); `runs` the page's
 * text in the same space.
 */
export function snapHighlighter(
  runs: readonly TextRun[],
  path: readonly Point[],
  width: number,
  options: SnapOptions = {},
): HighlighterOutcome {
  if (options.alt) return { kind: 'ink', reason: 'alt' };
  const lines = textLines(runs);
  if (lines.length === 0) return { kind: 'ink', reason: 'no-text' };
  if (path.length < 2) return { kind: 'ink', reason: 'off-text' };
  const hw = width / 2;
  const reach = boundsOf([path], hw);
  // Flattened glyph indices: where each run starts.
  const offsets: number[] = [];
  let count = 0;
  for (const run of runs) {
    offsets.push(count);
    count += run.glyphs.length;
  }
  const states: LineState[] = [];
  for (const line of lines) {
    if (!intersects(line.box, reach)) continue;
    const hits: HitGlyph[] = [];
    for (const r of line.runs) {
      const run = runs[r] as TextRun;
      run.glyphs.forEach((glyph, g) => {
        const rect = glyph.rect;
        if (rect.width <= 0 || rect.height <= 0 || !intersects(rect, reach)) return;
        if (!glyphHit(rect, line.dir, path, hw)) return;
        const [lo, hi] =
          line.dir === 'h' ? [rect.x, rect.x + rect.width] : [rect.y, rect.y + rect.height];
        hits.push({ run: r, glyph: g, flat: (offsets[r] ?? 0) + g, lo, hi });
      });
    }
    const [c0, c1] = crossRange(line);
    states.push({
      line,
      hits,
      covered: mergeExtents(
        hits.map((h) => [h.lo, h.hi]),
        WORD_GAP_SHARE * (c1 - c0),
      ),
      arc: 0,
      along: 0,
    });
  }
  // Walk the stroke: each step belongs to the line whose band holds its middle, or to paper.
  let total = 0;
  let along = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point;
    const b = path[i] as Point;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(length / STEP_PT));
    const slope = Math.tan(ALONG_MAX_ANGLE);
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      const mid = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const ds = length / steps;
      total += ds;
      const state = lineAt(states, mid);
      if (!state) continue;
      state.arc += ds;
      const dir = state.line.dir;
      const dr = Math.abs(reading(dir, b) - reading(dir, a));
      const dc = Math.abs(across(dir, b) - across(dir, a));
      if (dc <= slope * dr && inExtents(state.covered, reading(dir, mid))) {
        const d = dr / steps;
        state.along += d;
        along += d;
      }
    }
  }
  if (total <= 0) return { kind: 'ink', reason: 'off-text' };
  const crossed = states.filter((s) => s.arc >= LINE_MIN_SHARE * total - 1e-9);
  const snaps =
    crossed.length > 0 &&
    along >= SNAP_COVERAGE * total - 1e-9 &&
    crossed.every((s) => s.hits.length > 0 && s.along >= SNAP_COVERAGE * s.arc - 1e-9);
  if (!snaps) return { kind: 'ink', reason: 'off-text' };
  // From the first to the last hit glyph of each line, in reading order.
  const selected: GlyphRef[] = [];
  for (const state of crossed) {
    const first = Math.min(...state.hits.map((h) => h.flat));
    const last = Math.max(...state.hits.map((h) => h.flat));
    for (const r of state.line.runs) {
      const run = runs[r] as TextRun;
      run.glyphs.forEach((_, g) => {
        const flat = (offsets[r] ?? 0) + g;
        if (flat >= first && flat <= last) selected.push({ run: r, glyph: g });
      });
    }
  }
  selected.sort((x, y) => (offsets[x.run] ?? 0) + x.glyph - ((offsets[y.run] ?? 0) + y.glyph));
  const quads = quadsForGlyphs(runs, selected);
  if (quads.length === 0) return { kind: 'ink', reason: 'off-text' };
  return { kind: 'highlight', quads, lines: crossed.length };
}

// ---------------------------------------------------------------------------
// The armed Highlighter
// ---------------------------------------------------------------------------

/** The first preset that is the Highlighter (the fourth by default). */
export function highlighterIndex(settings: PenSettings): PresetIndex | undefined {
  return PRESET_INDICES.find((i) => isHighlighter(settings.presets[i]));
}

/** The armed preset when the pen is armed with the Highlighter. */
export function armedHighlighter(): PenPreset | undefined {
  if (useToolStore.getState().mode !== 'ink') return undefined;
  const { pen } = useAnnotationStore.getState();
  const preset = pen.presets[pen.active];
  return isHighlighter(preset) ? preset : undefined;
}

/**
 * Highlight (H). Over a text selection: in Edit the selection is highlighted in the
 * Highlighter's tint; in Read the Highlight tool's own activation (`activate`) switches to
 * Edit and keeps the selection for a second press (ADR-0019 §3). Otherwise the pen tool is
 * activated and armed with the Highlighter preset, which is then said ("Yellow highlighter,
 * 12 pt"). `activate` is the tool bar's activation (`commands.ts`).
 */
export async function activateHighlighter(
  activate: (tool: ToolDefinition) => Promise<void>,
): Promise<void> {
  const { pen } = useAnnotationStore.getState();
  const index = highlighterIndex(pen);
  const preset = index === undefined ? undefined : pen.presets[index];
  if (hasTextSelection()) {
    if (!canEditActive()) {
      await activate(toolDefinition('highlight'));
      return;
    }
    const style = preset ? { color: preset.color, opacity: 1 } : undefined;
    if (await markupFromSelection('highlight', style)) return;
  }
  await activate(toolDefinition('ink'));
  if (index === undefined || useToolStore.getState().mode !== 'ink') return;
  useAnnotationStore.getState().armPreset(index);
  // Said instead of the generic "Pen tool" (same key).
  announce(presetLabel(index, useAnnotationStore.getState().pen.presets[index]), { key: 'tool' });
}

// ---------------------------------------------------------------------------
// Alt at release
// ---------------------------------------------------------------------------

let altAtRelease = false;

/** Whether Alt was held at the last pointer release (read while the stroke commits). */
export function altHeldAtRelease(): boolean {
  return altAtRelease;
}

if (typeof window !== 'undefined') {
  // Capture on the window runs before the pen's own window listener ends the stroke.
  window.addEventListener(
    'pointerup',
    (event) => {
      altAtRelease = event.altKey;
    },
    { capture: true },
  );
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** A path drawn at one width (CSS px). */
function constantWidth(path: PreviewPath, w: number): PreviewPath {
  return { length: path.length, x: (i) => path.x(i), y: (i) => path.y(i), w: () => w };
}

/**
 * The pen's preview with the Highlighter's profile: while the Highlighter is armed
 * (`widthCss` gives its width in CSS px at the press, else null), the stroke is drawn at
 * that constant width and opaque, and `layer` blends with Multiply until the stroke's
 * settling preview is released.
 */
export class HighlighterPreview extends InkPreview {
  /** The live highlighter stroke's width, CSS px; null for a pen stroke. */
  private width: number | null = null;
  /** Highlighter strokes live or settling. */
  private blending = 0;

  constructor(
    host: HTMLElement,
    private readonly layer: HTMLElement,
    private readonly widthCss: () => number | null,
  ) {
    super(host);
  }

  override begin(style: InkPreviewStyle): void {
    this.endLive();
    this.width = this.widthCss();
    if (this.width !== null) this.blend(1);
    super.begin(this.width === null ? style : { ...style, opacity: 1 });
  }

  override draw(
    path: PreviewPath,
    predicted: readonly PreviewPoint[] = [],
    restart = false,
    settled = path.length - 2,
  ): void {
    const w = this.width;
    if (w === null) {
      super.draw(path, predicted, restart, settled);
      return;
    }
    super.draw(
      constantWidth(path, w),
      predicted.map((p) => ({ ...p, w })),
      restart,
      settled,
    );
  }

  override settle(final?: PreviewPath): SettlingInk {
    const w = this.width;
    this.width = null;
    const settling = super.settle(final && w !== null ? constantWidth(final, w) : final);
    if (w === null) return settling;
    let released = false;
    return {
      element: settling.element,
      release: () => {
        settling.release();
        if (released) return;
        released = true;
        this.blend(-1);
      },
    };
  }

  override cancel(): void {
    super.cancel();
    this.endLive();
  }

  override destroy(): void {
    super.destroy();
    this.width = null;
    this.blending = 0;
    this.layer.style.mixBlendMode = '';
  }

  /** Whether the layer blends with Multiply now (tests). */
  get multiply(): boolean {
    return this.layer.style.mixBlendMode === 'multiply';
  }

  private endLive(): void {
    if (this.width === null) return;
    this.width = null;
    this.blend(-1);
  }

  private blend(change: number): void {
    this.blending = Math.max(0, this.blending + change);
    this.layer.style.mixBlendMode = this.blending > 0 ? 'multiply' : '';
  }
}

/** The pen's preview for page `pageId`'s layer `element`, with the Highlighter's profile. */
export function createPenPreview(
  host: HTMLElement,
  element: HTMLElement,
  pageId: PageId,
): HighlighterPreview {
  return new HighlighterPreview(host, element, () => {
    const preset = armedHighlighter();
    const layer = mountedLayers.get(pageId);
    return preset && layer ? preset.width * layer.frame.scale : null;
  });
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/**
 * The committed centre line of a highlighter stroke, user space: smoothed and simplified as
 * a pen stroke (`finishInkStroke`), Shift a straight line, a tap a short dot.
 */
export function highlighterPath(stroke: InkStrokeInput, frame: PageFrame, width: number): Point[] {
  const first = stroke.points[0];
  const last = stroke.points[stroke.points.length - 1];
  if (!first || !last) return [];
  let path: Point[];
  if (stroke.straight) {
    path = [cssPointToUser(frame, first), cssPointToUser(frame, snapAngle(first, last))];
  } else {
    path = finishInkStroke(
      stroke.points.map((p) => ({ ...cssPointToUser(frame, p), w: width })),
    ).points;
  }
  const bounds = boundsOf([path]);
  const start = path[0];
  if (start && (path.length < 2 || (bounds.width < 0.01 && bounds.height < 0.01))) {
    path = [start, { x: start.x + 0.5, y: start.y }];
  }
  return path;
}

/**
 * Commits a finished stroke when the pen is armed with the Highlighter: a Highlight or free
 * Multiply ink (module header). Settles the preview at once (so call it in the stroke's
 * task) and resolves once the page shows the result. Returns undefined, doing nothing, for
 * any other preset. `alt` defaults to Alt at the last pointer release.
 */
export function commitHighlighterStroke(
  stroke: InkStrokeInput,
  settle: SettleInk,
  frame: PageFrame,
  target: PageTarget,
  times: { readonly downAt: number; readonly upAt: number },
  alt = altHeldAtRelease(),
): Promise<void> | undefined {
  const preset = armedHighlighter();
  if (!preset) return undefined;
  const style = { ...useAnnotationStore.getState().styles.ink, opacity: 1 };
  const width = style.strokeWidth;
  const path = highlighterPath(stroke, frame, width);
  if (path.length === 0) return undefined;
  const release = settle(
    previewPath(
      path.map((p) => userToCss(frame, p)),
      path.map(() => width * frame.scale),
    ),
  );
  return (async () => {
    let committed = false;
    try {
      const runs = alt ? [] : await pageText(target.source, target.pageIndex);
      const outcome = snapHighlighter(runs, path, width, { alt });
      if (outcome.kind === 'highlight') {
        // A highlight is its own entry: the next free stroke starts a new burst.
        closeBurst();
        const draft = markupDraft('highlight', target.pageIndex, outcome.quads, style.color, 1);
        // Said, and listed in History, by the lines it covers (craft spec §9).
        const label = m.highlighter_highlighted_lines({
          count: outcome.lines,
          page: target.position,
        });
        committed =
          (await createAnnotations(target, [draft], { select: false, label })) !== undefined;
      } else {
        committed = await commitPenStroke({
          target,
          path,
          widths: path.map(() => width),
          style,
          blendMode: 'multiply',
          ...times,
        });
      }
    } catch (error) {
      console.warn('Saving the stroke failed', error);
    }
    if (committed) {
      // The dry ink layer hands the stroke to the page bitmap (craft spec §5.3 item 7).
      await inkCommitted(release, target.source, target.pageIndex);
    } else {
      // A loss the person did not see happen: said at once.
      announce(m.annot_stroke_not_saved(), { politeness: 'assertive' });
    }
    release();
  })();
}
