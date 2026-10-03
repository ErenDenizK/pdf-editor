/**
 * One hit order for the page layers (craft spec §3.5, ADR-0019 §6): annotation → form
 * widget → image → text run → text selection.
 *
 * Every page layer's root is `pointer-events: none`; only its targets are live, and only
 * for the tools that use them (`liveHitKinds`). What a point on the page means is resolved
 * here, not by which layer happens to cover the page: `hitAt` takes the elements under the
 * point (`document.elementsFromPoint`) and returns the target that comes first in the
 * order, whatever their stacking. The double-click entry to the text editor and the idle
 * hover outline use it, so a double-click on a text box edits the text box and an outline
 * never shows over an annotation.
 *
 * The pointer rules of the Edit policy live here too, as pure functions: which pointers
 * may open the text editor by double-click, when an idle hover may show its outline, and
 * what a pen's eraser end and barrel button do.
 */
import { TOUCH_AFTER_PEN_MS } from '../annotations/pen/ink-input';
import { TEXT_LAYER_ATTR } from './text-model';
import type { ToolMode } from './tool-store';

/** The kinds of page target, first to last. */
export const HIT_ORDER = [
  'annotation',
  'form-widget',
  'image',
  'text-run',
  'text-selection',
] as const;
export type HitKind = (typeof HIT_ORDER)[number];

/** How each kind's targets are marked in the page overlays. */
export const HIT_SELECTORS: Readonly<Record<HitKind, string>> = {
  annotation: '[data-annotation-id]',
  'form-widget': '[data-field-name], [data-created-design]',
  image: '[data-image-object], [data-testid="image-selection"]',
  'text-run': '[data-text-run]',
  'text-selection': `[${TEXT_LAYER_ATTR}] > span`,
};

/**
 * Stacking of the layer roots that follow the order (CSS `z-index` inside a page's
 * overlays). The text layer stays in flow (auto). The edit text layer sits above the
 * annotation layer's targets so its editor is never covered; the order between them is
 * kept by `liveHitKinds`, which never makes both live at once.
 */
export const HIT_LAYER_Z = {
  image: 2,
  textRun: 2,
} as const;

/** The kind of target `element` belongs to, if any. */
export function hitKindOf(element: Element | null | undefined): HitKind | undefined {
  if (!element) return undefined;
  for (const kind of HIT_ORDER) if (element.closest(HIT_SELECTORS[kind])) return kind;
  return undefined;
}

export interface Hit {
  readonly kind: HitKind;
  readonly element: Element;
}

/**
 * The target that wins among `elements` (top-most first, as `elementsFromPoint` lists
 * them): the earliest kind in the order; within a kind, the top-most element.
 */
export function topHit(elements: Iterable<Element>): Hit | undefined {
  let best: Hit | undefined;
  let rank: number = HIT_ORDER.length;
  for (const element of elements) {
    const kind = hitKindOf(element);
    if (kind === undefined) continue;
    const r = HIT_ORDER.indexOf(kind);
    if (r < rank) {
      best = { kind, element };
      rank = r;
    }
  }
  return best;
}

/** The winning target at a viewport point (live targets only: roots let the pointer through). */
export function hitAt(x: number, y: number, root: Document = document): Hit | undefined {
  return topHit(root.elementsFromPoint(x, y));
}

/**
 * Which targets are live for the armed tool (craft spec §3.5). In Read only text
 * selection; with Select annotations, form widgets and text selection (page text opens
 * the editor by double-click, through the text layer); Edit text takes text runs only
 * (annotations ignored); Image takes images only. A drawing tool captures the page itself,
 * so none of these is live.
 */
export function liveHitKinds(mode: ToolMode, editable: boolean): ReadonlySet<HitKind> {
  if (!editable) return READ_KINDS;
  switch (mode) {
    case 'select':
      return SELECT_KINDS;
    case 'edit-text':
      return EDIT_TEXT_KINDS;
    case 'image':
      return IMAGE_KINDS;
    default:
      return NO_KINDS;
  }
}

const READ_KINDS: ReadonlySet<HitKind> = new Set<HitKind>(['text-selection']);
const SELECT_KINDS: ReadonlySet<HitKind> = new Set<HitKind>([
  'annotation',
  'form-widget',
  'text-selection',
]);
const EDIT_TEXT_KINDS: ReadonlySet<HitKind> = new Set<HitKind>(['text-run']);
const IMAGE_KINDS: ReadonlySet<HitKind> = new Set<HitKind>(['image']);
const NO_KINDS: ReadonlySet<HitKind> = new Set<HitKind>();

/** Whether targets of `kind` are live for `mode`. */
export function isLive(kind: HitKind, mode: ToolMode, editable: boolean): boolean {
  return liveHitKinds(mode, editable).has(kind);
}

// ---------------------------------------------------------------------------
// Pointer rules
// ---------------------------------------------------------------------------

/** Idle hover before the run outline shows (ms). */
export const HOVER_DELAY_MS = 400;
/** No hover outline this long after a pen left the surface (ms): `TOUCH_AFTER_PEN_MS`. */
export const HOVER_AFTER_PEN_MS = TOUCH_AFTER_PEN_MS;

/**
 * Whether a double-click from `pointerType` may open the text editor: a mouse, or a pen
 * used as a pointer; never touch, never a pen while "Pen draws in Edit" is on. An unknown
 * type (synthetic events, old browsers) counts as a mouse.
 */
export function opensTextOnDoubleClick(pointerType: string, penDraws: boolean): boolean {
  if (pointerType === 'touch') return false;
  if (pointerType === 'pen') return !penDraws;
  return true;
}

export interface HoverFacts {
  readonly pointerType: string;
  readonly buttons: number;
}

/**
 * Whether a move may start (or keep) the idle hover outline: a mouse or a hovering pen
 * with no button down, not within `HOVER_AFTER_PEN_MS` of a pen stroke; never touch.
 */
export function hoverAllowed(facts: HoverFacts, now: number, lastPenUpAt: number): boolean {
  if (facts.pointerType !== 'mouse' && facts.pointerType !== 'pen') return false;
  if (facts.buttons !== 0) return false;
  return now - lastPenUpAt >= HOVER_AFTER_PEN_MS;
}

/** What a pen press means beyond its tip: the eraser end and the barrel button. */
export type PenButton = 'tip' | 'eraser' | 'barrel';

export interface PenPressFacts {
  readonly pointerType: string;
  readonly button: number;
  readonly buttons: number;
}

/**
 * The pen part of a press (Pointer Events: the eraser reports `buttons & 32`, button 5;
 * the barrel `buttons & 2`, button 2). Undefined for anything but a pen.
 */
export function penButtonOf(press: PenPressFacts): PenButton | undefined {
  if (press.pointerType !== 'pen') return undefined;
  if ((press.buttons & 32) !== 0 || press.button === 5) return 'eraser';
  if ((press.buttons & 2) !== 0 || press.button === 2) return 'barrel';
  return 'tip';
}

// ---------------------------------------------------------------------------
// Pointer log
// ---------------------------------------------------------------------------

/** What the page knows about recent pointers (session only). */
export interface PointerLog {
  /** Type of the last press anywhere (`dblclick` events do not carry one). */
  lastDownType: string;
  /** When a pen last left the surface (`performance.now()` clock). */
  lastPenUpAt: number;
}

export function createPointerLog(): PointerLog {
  return { lastDownType: '', lastPenUpAt: Number.NEGATIVE_INFINITY };
}

/**
 * Keeps `log` current from `target`'s pointer events (capture phase, so no layer can hide
 * them); `onPen` runs for every pen event (hover included). Returns the disposer.
 */
export function watchPointers(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  log: PointerLog,
  onPen: () => void,
  now: () => number = () => performance.now(),
): () => void {
  const onDown = (event: PointerEvent) => {
    log.lastDownType = event.pointerType;
    if (event.pointerType === 'pen') onPen();
  };
  const onUp = (event: PointerEvent) => {
    if (event.pointerType !== 'pen') return;
    log.lastPenUpAt = now();
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerType === 'pen') onPen();
  };
  const options = { capture: true, passive: true } as const;
  target.addEventListener('pointerdown', onDown, options);
  target.addEventListener('pointerup', onUp, options);
  target.addEventListener('pointercancel', onUp, options);
  target.addEventListener('pointermove', onMove, options);
  return () => {
    target.removeEventListener('pointerdown', onDown, options);
    target.removeEventListener('pointerup', onUp, options);
    target.removeEventListener('pointercancel', onUp, options);
    target.removeEventListener('pointermove', onMove, options);
  };
}
