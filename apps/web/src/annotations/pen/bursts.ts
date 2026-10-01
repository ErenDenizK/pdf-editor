/**
 * Pen bursts (experience-redesign spec §6.4): many strokes, one annotation. A word or a line
 * written in one go becomes one Ink annotation with many paths, one Review row and one undo
 * step, instead of one annotation per stroke.
 *
 * **Joining.** A stroke joins the open burst when (1) it is on the same page of the same
 * document, with the same preset; (2) the pause from the burst's last pointer-up to this
 * stroke's pointer-down is at most `INK_BURST_PAUSE_MS`; (3) the gap between this stroke's
 * bounds and the burst's bounds (centre lines, page space, so zoom does not change it) is at
 * most `INK_BURST_GAP_PT`; and (4) the burst has fewer than `INK_BURST_MAX_PATHS` paths. The
 * pause and the gap can be overridden in the stored pen settings (`burstPauseMs`,
 * `burstGapPt`, no UI). The first stroke creates the Ink; each joining stroke appends a path
 * (with its widths) through `annotation.update` (`appendInkPath`).
 *
 * **One undo step.** The create and every append carry the burst's `coalesceKey`
 * (`ink-burst:<uuid>`), so the history replaces its present entry instead of pushing a new
 * one, and the label follows the count ("Pen on page 1 · 5 strokes"). The history's own
 * 800 ms window would split a burst whose strokes are seconds apart, so the burst passes its
 * own window (`BURST_HISTORY_WINDOW_MS`, unbounded): the join rule above decides, and a key
 * is never reused, so nothing else can join the entry.
 *
 * **Closing.** A burst closes when the pause passes (a timer from the last pointer-up,
 * stopped by the next press), on a tool or group change, Esc, a selection, a preset arm or
 * edit, a document change, window blur, and whenever the present history entry is no longer
 * the burst's (undo, redo, any other edit). A stroke on another page, after the pause, too far
 * away or past the path limit starts a new burst. Closing a burst of several strokes says so
 * once ("Pen: 5 strokes on page 1", spec §10); single strokes are announced by their create.
 */
import type { Rect } from '@pdf-editor/document-model';
import type { NewAnnotation } from '@pdf-editor/engine';

import { announce } from '../../shell/announcer';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useToolStore } from '../../viewer/tool-store';
import { appendInkPath, createAnnotations } from '../actions';
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

/** Distance between two rectangles (0 when they touch or overlap). */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
  const dy = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
  return Math.hypot(dx, dy);
}

function samePage(a: PageTarget, b: PageTarget): boolean {
  return a.source === b.source && a.pageIndex === b.pageIndex && a.pageId === b.pageId;
}

/** Whether `stroke` joins `burst` (spec §6.4, conditions 1–4). */
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
  if (rectGap(burst.bounds, stroke.bounds) > limits.gapPt) return false;
  return burst.paths < limits.maxPaths;
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
      lastUpAt: stroke.upAt,
      paths: 1,
      coalesceKey,
    },
    id: creating.then(
      (created) => created?.[0]?.id,
      () => undefined,
    ),
    committed: false,
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
    // Nothing to append to (the Ink is gone or the history moved): a new burst.
    if (open === entry) {
      open = null;
      stopTimer();
    }
    return startBurst(stroke, candidate, limits.pauseMs);
  }
  closeBurst();
  return startBurst(stroke, candidate, limits.pauseMs);
}

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
    else if (entry.committed) closeBurst();
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('blur', closeBurst);
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') closeBurst();
      },
      { capture: true },
    );
  }
}

installBurstRules();
