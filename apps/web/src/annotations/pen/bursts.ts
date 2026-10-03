/**
 * Pen bursts (experience-redesign spec §6.4): many strokes, one annotation. A word or a line
 * written in one go becomes one Ink annotation with many paths, one Review row and one undo
 * step, instead of one annotation per stroke.
 *
 * **Joining.** A stroke joins the open burst when (1) it is on the same page of the same
 * document, with the same preset; (2) the pause from the burst's last pointer-up to this
 * stroke's pointer-down is at most `INK_BURST_PAUSE_MS`; (3) the horizontal gap between this
 * stroke's bounds and the burst's bounds (centre lines, page space, so zoom does not change
 * it) is at most `INK_BURST_GAP_PT`; (4) it is on the line of the burst's last stroke
 * (`onBurstLine`): their vertical bands overlap by at least `INK_BURST_LINE_OVERLAP` of the
 * smaller band, or, when they do not overlap at all, the gap between them is at most
 * `INK_BURST_LINE_GAP` times the burst's median stroke height (a dot or a bar just above or
 * below joins; the next line of writing does not); and (5) the burst has fewer than
 * `INK_BURST_MAX_PATHS` paths. The pause and the gap can be overridden in the stored pen
 * settings (`burstPauseMs`, `burstGapPt`, no UI). The first stroke creates the Ink; each
 * joining stroke appends a path (with its widths) through `annotation.update`
 * (`appendInkPath`).
 *
 * **One undo step.** The create and every append carry the burst's `coalesceKey`
 * (`ink-burst:<uuid>`), so the history replaces its present entry instead of pushing a new
 * one, and the label follows the count ("Pen on page 1 · 5 strokes"). The history's own
 * 800 ms window would split a burst whose strokes are seconds apart, so the burst passes its
 * own window (`BURST_HISTORY_WINDOW_MS`, unbounded): the join rule above decides, and a key
 * is never reused, so nothing else can join the entry.
 *
 * **Undo inside a burst.** While a burst of several strokes is open and its entry is the
 * present one, Mod+Z removes its last stroke only (`undoBurstStroke`, `removeLastInkPath`):
 * the entry shrinks by one path and keeps its key, so the burst stays open and a rewritten
 * stroke joins it again. With one stroke left Mod+Z is the ordinary undo, which removes the
 * Ink and closes the burst.
 *
 * **Closing.** A burst closes when the pause passes (a timer from the last pointer-up,
 * stopped by the next press), on a tool or group change, Esc, a selection, a preset arm or
 * edit, a document change, window blur, and whenever the present history entry is no longer
 * the burst's (undo, redo, any other edit). A stroke on another page, after the pause, too far
 * away or past the path limit starts a new burst. Closing a burst of several strokes says so
 * once ("Pen: 5 strokes on page 1", spec §10); single strokes are announced by their create.
 * A stroke whose append was still queued when the history moved (an undo right after it) is
 * not saved and does not start a burst of its own: the layer says "Stroke not saved".
 */
import type { Rect } from '@pdf-editor/document-model';
import type { NewAnnotation } from '@pdf-editor/engine';

import { currentPlatform, matchShortcut, parseShortcut } from '../../commands/shortcuts';
import { isEditableTarget } from '../../commands/use-shortcuts';
import { m } from '../../i18n';
import { announce } from '../../shell/announcer';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useToolStore } from '../../viewer/tool-store';
import { appendInkPath, createAnnotations, removeLastInkPath } from '../actions';
import { type PageTarget, type ToolStyle, useAnnotationStore } from '../annotation-store';
import { roundRect } from '../geometry';
import { boundsOf, type Point } from '../ink';
import { burstClosedLabel, burstLabel } from '../labels';
import { type PenPreset, type PenSettings, type PresetIndex, samePreset } from './presets';

/** Longest pause between strokes of one burst, ms (spec §13 decision 6). */
export const INK_BURST_PAUSE_MS = 1500;
/** Largest gap between a stroke and its burst, points in page space. */
export const INK_BURST_GAP_PT = 36;
/** Most paths in one burst. */
export const INK_BURST_MAX_PATHS = 64;
/** Least vertical overlap with the last stroke's band, as a share of the smaller band. */
export const INK_BURST_LINE_OVERLAP = 0.3;
/** Largest vertical gap to the last stroke's band, times the burst's median stroke height. */
export const INK_BURST_LINE_GAP = 0.6;
/** A stroke's band is at least this tall (points), so dots and flat bars have one. */
export const INK_BURST_MIN_BAND_PT = 4;
/** The burst's history coalescing window: the join rule decides, not the clock. */
export const BURST_HISTORY_WINDOW_MS = Number.POSITIVE_INFINITY;

export interface BurstLimits {
  readonly pauseMs: number;
  readonly gapPt: number;
  readonly maxPaths: number;
}

export const DEFAULT_BURST_LIMITS: BurstLimits = {
  pauseMs: INK_BURST_PAUSE_MS,
  gapPt: INK_BURST_GAP_PT,
  maxPaths: INK_BURST_MAX_PATHS,
};

/** The limits with the stored overrides (already clamped by `parsePenSettings`). */
export function burstLimits(
  settings: Pick<PenSettings, 'burstPauseMs' | 'burstGapPt'>,
): BurstLimits {
  return {
    pauseMs: settings.burstPauseMs ?? INK_BURST_PAUSE_MS,
    gapPt: settings.burstGapPt ?? INK_BURST_GAP_PT,
    maxPaths: INK_BURST_MAX_PATHS,
  };
}

export interface InkBurst {
  readonly target: PageTarget;
  readonly presetIndex: PresetIndex;
  readonly preset: PenPreset;
  /** Union of the centre lines' bounds, user space. */
  readonly bounds: Rect;
  /** Each path's centre-line bounds, user space, in path order (the last is the newest). */
  readonly strokes: readonly Rect[];
  /** The last stroke's pointer-up (`performance.now()` clock). */
  readonly lastUpAt: number;
  readonly paths: number;
  /** `ink-burst:<uuid>`: the history entry the burst's edits join. */
  readonly coalesceKey: string;
}

/** What the join rule knows of a new stroke. */
export interface BurstStroke {
  readonly target: PageTarget;
  readonly presetIndex: PresetIndex;
  readonly preset: PenPreset;
  /** The centre line's bounds, user space. */
  readonly bounds: Rect;
  /** Its pointer-down (`performance.now()` clock). */
  readonly downAt: number;
}

/** Horizontal distance between two rectangles (0 when their x ranges touch or overlap). */
export function horizontalGap(a: Rect, b: Rect): number {
  return Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
}

/** A stroke's vertical band: its y range, grown to `INK_BURST_MIN_BAND_PT` about its middle. */
function band(r: Rect): { readonly lo: number; readonly hi: number } {
  const grow = Math.max(0, INK_BURST_MIN_BAND_PT - r.height) / 2;
  return { lo: r.y - grow, hi: r.y + r.height + grow };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Whether `next` is on the line of the burst's last stroke (spec §6.4, condition 4): the
 * bands overlap by at least `INK_BURST_LINE_OVERLAP` of the smaller one, or they are apart
 * by at most `INK_BURST_LINE_GAP` times the median band height of `strokes`.
 */
export function onBurstLine(strokes: readonly Rect[], next: Rect): boolean {
  const last = strokes[strokes.length - 1];
  if (!last) return true;
  const a = band(last);
  const b = band(next);
  const overlap = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
  if (overlap > 0) {
    return overlap >= INK_BURST_LINE_OVERLAP * Math.min(a.hi - a.lo, b.hi - b.lo) - 1e-9;
  }
  const heights = strokes.map((r) => {
    const s = band(r);
    return s.hi - s.lo;
  });
  return -overlap <= INK_BURST_LINE_GAP * median(heights) + 1e-9;
}

function samePage(a: PageTarget, b: PageTarget): boolean {
  return a.source === b.source && a.pageIndex === b.pageIndex && a.pageId === b.pageId;
}

/** Whether `stroke` joins `burst` (spec §6.4, conditions 1–5). */
export function joinsBurst(
  burst: InkBurst | null,
  stroke: BurstStroke,
  limits: BurstLimits = DEFAULT_BURST_LIMITS,
): boolean {
  if (!burst) return false;
  if (!samePage(burst.target, stroke.target)) return false;
  if (burst.presetIndex !== stroke.presetIndex || !samePreset(burst.preset, stroke.preset)) {
    return false;
  }
  // A press before the last release (a second pointer) counts as no pause.
  if (stroke.downAt - burst.lastUpAt > limits.pauseMs) return false;
  if (horizontalGap(burst.bounds, stroke.bounds) > limits.gapPt) return false;
  if (!onBurstLine(burst.strokes, stroke.bounds)) return false;
  return burst.paths < limits.maxPaths;
}

function unionAll(rects: readonly Rect[]): Rect {
  return rects.reduce(union);
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

// ---------------------------------------------------------------------------
// The open burst
// ---------------------------------------------------------------------------

interface OpenBurst {
  burst: InkBurst;
  /** The Ink's id once its create has run (undefined when it failed). */
  readonly id: Promise<string | undefined>;
  /** The present history entry has been the burst's (its create committed). */
  committed: boolean;
  /** The burst closed because the history moved away from its entry (undo, another edit). */
  moved: boolean;
  /** Widths of the paths as sent, parallel to the Ink's paths. */
  readonly widths: (readonly number[])[];
}

let open: OpenBurst | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function stopTimer(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

/** The open burst, if any (tests and the layer). */
export function currentBurst(): InkBurst | null {
  return open?.burst ?? null;
}

/** Closes the open burst; one of several strokes is announced once (spec §10). */
export function closeBurst(): void {
  const closing = open;
  stopTimer();
  if (!closing) return;
  open = null;
  const { paths, target } = closing.burst;
  if (paths > 1) announce(burstClosedLabel(target.position, paths));
}

/** A pen press: the pause timer stops, so a stroke begun in time can still join. */
export function noteBurstPress(): void {
  stopTimer();
}

function startTimer(entry: OpenBurst, pauseMs: number): void {
  stopTimer();
  timer = setTimeout(() => {
    timer = undefined;
    if (open === entry) closeBurst();
  }, pauseMs);
}

/** A finished pen stroke as the layer commits it. */
export interface PenStroke {
  readonly target: PageTarget;
  /** User-space centre line. */
  readonly path: readonly Point[];
  /** Full width at each point, points. */
  readonly widths: readonly number[];
  /** The pen's style (the armed preset's). */
  readonly style: ToolStyle;
  /** The free Highlighter's blend (`highlighter.ts`); its widths are not written. */
  readonly blendMode?: 'multiply';
  readonly downAt: number;
  readonly upAt: number;
}

function inkDraft(stroke: PenStroke): NewAnnotation {
  const { style, path, widths, target } = stroke;
  const widest = Math.max(style.strokeWidth, ...widths);
  return {
    kind: 'ink',
    pageIndex: target.pageIndex,
    opacity: style.opacity,
    paths: [path.map((p) => ({ x: p.x, y: p.y }))],
    widths: [[...widths]],
    rect: roundRect(boundsOf([path], widest / 2 + 1)),
    color: style.color,
    strokeWidth: style.strokeWidth,
    ...(stroke.blendMode ? { blendMode: stroke.blendMode } : {}),
  };
}

/** Starts a burst with `stroke`: one Ink with one path, its history entry keyed. */
async function startBurst(stroke: PenStroke, candidate: BurstStroke, pauseMs: number) {
  const coalesceKey = `ink-burst:${globalThis.crypto.randomUUID()}`;
  const creating = createAnnotations(stroke.target, [inkDraft(stroke)], {
    select: false,
    coalesceKey,
    coalesceWindowMs: BURST_HISTORY_WINDOW_MS,
  });
  const entry: OpenBurst = {
    burst: {
      target: stroke.target,
      presetIndex: candidate.presetIndex,
      preset: candidate.preset,
      bounds: candidate.bounds,
      strokes: [candidate.bounds],
      lastUpAt: stroke.upAt,
      paths: 1,
      coalesceKey,
    },
    id: creating.then(
      (created) => created?.[0]?.id,
      () => undefined,
    ),
    committed: false,
    moved: false,
    widths: [stroke.widths],
  };
  open = entry;
  startTimer(entry, pauseMs);
  let id: string | undefined;
  try {
    id = (await creating)?.[0]?.id;
  } catch (error) {
    console.warn('Creating the annotation failed', error);
  }
  if (id === undefined && open === entry) {
    open = null;
    stopTimer();
  }
  return id !== undefined;
}

/**
 * Commits a finished pen stroke: appended to the open burst when it joins (spec §6.4), else
 * the first stroke of a new one. Resolves to whether the stroke was saved.
 */
export async function commitPenStroke(stroke: PenStroke): Promise<boolean> {
  const pen = useAnnotationStore.getState().pen;
  const limits = burstLimits(pen);
  const candidate: BurstStroke = {
    target: stroke.target,
    presetIndex: pen.active,
    preset: pen.presets[pen.active],
    bounds: boundsOf([stroke.path]),
    downAt: stroke.downAt,
  };
  const entry = open;
  if (entry && joinsBurst(entry.burst, candidate, limits)) {
    const knownWidths = [...entry.widths];
    entry.widths.push(stroke.widths);
    entry.burst = {
      ...entry.burst,
      bounds: union(entry.burst.bounds, candidate.bounds),
      strokes: [...entry.burst.strokes, candidate.bounds],
      lastUpAt: stroke.upAt,
      paths: entry.burst.paths + 1,
    };
    startTimer(entry, limits.pauseMs);
    const { position } = stroke.target;
    let appended = false;
    try {
      appended =
        (await appendInkPath(
          stroke.target,
          () => entry.id,
          { path: stroke.path, widths: stroke.widths },
          {
            label: (paths) => burstLabel(position, paths),
            coalesceKey: entry.burst.coalesceKey,
            coalesceWindowMs: BURST_HISTORY_WINDOW_MS,
            knownWidths,
          },
        )) !== undefined;
    } catch (error) {
      console.warn('Adding the stroke failed', error);
    }
    if (appended) return true;
    // The history moved under the burst (an undo before this append ran): the stroke
    // belonged to what was undone, so it is not saved rather than coming back on its own.
    if (entry.moved) return false;
    // Nothing to append to (the Ink was deleted or locked): a new burst.
    if (open === entry) {
      open = null;
      stopTimer();
    }
    return startBurst(stroke, candidate, limits.pauseMs);
  }
  closeBurst();
  return startBurst(stroke, candidate, limits.pauseMs);
}

/**
 * Undo inside an open burst (spec §6.4): removes the burst's last stroke when it has several
 * and its history entry is the present one; the entry shrinks by one path and the burst stays
 * open. Returns false when this is not the case (the ordinary undo applies).
 */
export function undoBurstStroke(): boolean {
  const entry = open;
  if (!entry?.committed || entry.burst.paths < 2) return false;
  const { history } = useWorkspaceStore.getState();
  if (history.present.coalesceKey !== entry.burst.coalesceKey || history.future.length > 0) {
    return false;
  }
  const strokes = entry.burst.strokes.slice(0, -1);
  entry.widths.pop();
  entry.burst = {
    ...entry.burst,
    strokes,
    bounds: unionAll(strokes),
    paths: entry.burst.paths - 1,
  };
  startTimer(entry, burstLimits(useAnnotationStore.getState().pen).pauseMs);
  const { position } = entry.burst.target;
  void removeLastInkPath(entry.burst.target, () => entry.id, {
    label: (paths) => burstLabel(position, paths),
    coalesceKey: entry.burst.coalesceKey,
    coalesceWindowMs: BURST_HISTORY_WINDOW_MS,
  })
    .catch((error: unknown) => {
      console.warn('Removing the stroke failed', error);
      return undefined;
    })
    .then((done) => {
      // Not removed (the ink changed meanwhile): the burst no longer matches it.
      if (done === undefined && open === entry) closeBurst();
    });
  announce(m.announce_undid({ label: m.lasso_strokes({ count: 1 }) }));
  return true;
}

const UNDO = parseShortcut('Mod+Z');

/** Tests: forget the open burst without announcing it. */
export function resetBursts(): void {
  stopTimer();
  open = null;
}

// ---------------------------------------------------------------------------
// What closes a burst
// ---------------------------------------------------------------------------

let installed = false;

/** Installs the closing rules once (on import). */
export function installBurstRules(): void {
  if (installed) return;
  installed = true;
  useToolStore.subscribe((state, previous) => {
    if (state.mode !== previous.mode || state.barGroup !== previous.barGroup) closeBurst();
  });
  useAnnotationStore.subscribe((state, previous) => {
    if (state.selection !== null && state.selection !== previous.selection) closeBurst();
    else if (state.pen !== previous.pen) closeBurst();
  });
  useWorkspaceStore.subscribe((state, previous) => {
    if (state.workspace.activeDocument !== previous.workspace.activeDocument) {
      closeBurst();
      return;
    }
    const entry = open;
    if (!entry || state.history === previous.history) return;
    if (state.history.present.coalesceKey === entry.burst.coalesceKey) entry.committed = true;
    else if (entry.committed) {
      entry.moved = true;
      closeBurst();
    }
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('blur', closeBurst);
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') {
          closeBurst();
          return;
        }
        // Before the shortcut listener (bubble phase), which skips a handled key.
        if (
          !event.defaultPrevented &&
          !isEditableTarget(event.target) &&
          matchShortcut(event, UNDO, currentPlatform) &&
          undoBurstStroke()
        ) {
          event.preventDefault();
        }
      },
      { capture: true },
    );
  }
}

installBurstRules();
