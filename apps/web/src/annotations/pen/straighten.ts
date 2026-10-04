/**
 * Straight pen lines (craft spec §5.6; research 12 §7): hold to straighten, and Shift.
 *
 * - **Hold to straighten.** While a stroke is drawn, a pointer that stays within
 *   `HOLD_STRAIGHTEN_PX` of one spot for `HOLD_STRAIGHTEN_MS` turns the stroke into a straight
 *   line from its first point to the pointer; the line follows the pointer until release and
 *   is handed over as two points. A press held still before the pointer has moved does not
 *   count (there is no stroke to straighten yet). `HoldStill` is the timing rule; the input
 *   pipeline (`ink-input.ts`) feeds it samples and asks it when the hold is due.
 * - **The cue.** When the line snaps it is drawn 1 px thicker for 120 ms, a visual cue in
 *   place of a haptic one; none under reduced motion.
 * - **Shift.** A straight line whose end snaps to the nearest multiple of 45° (horizontal,
 *   vertical or diagonal), in the preview as in the commit (`snapAngle`). With the
 *   Highlighter such a line over text becomes a Highlight by the usual rule (`highlighter.ts`).
 */
import { type Point, snapAngle } from '../ink';

/** How long the pointer must stay still (ms). */
export const HOLD_STRAIGHTEN_MS = 500;
/** How far the pointer may wander and still be still (CSS px). */
export const HOLD_STRAIGHTEN_PX = 3;
/** How long the snapped line is drawn thicker (ms). */
export const STRAIGHTEN_CUE_MS = 120;
/** How much thicker (CSS px). */
export const STRAIGHTEN_CUE_PX = 1;

/**
 * The hold rule over a stroke's samples (CSS px, event time in ms): the hold starts at the
 * newest sample that left the tolerance circle of the previous anchor.
 */
export class HoldStill {
  private startX = 0;
  private startY = 0;
  private anchorX = 0;
  private anchorY = 0;
  private anchorT = 0;
  /** The pointer has left the press's tolerance circle: there is a stroke to straighten. */
  private moved = false;

  constructor(
    readonly ms = HOLD_STRAIGHTEN_MS,
    readonly px = HOLD_STRAIGHTEN_PX,
  ) {}

  /** The press. */
  begin(x: number, y: number, t: number): void {
    this.startX = x;
    this.startY = y;
    this.anchorX = x;
    this.anchorY = y;
    this.anchorT = t;
    this.moved = false;
  }

  /** A sample; one beyond the tolerance of the anchor becomes the new anchor. */
  add(x: number, y: number, t: number): void {
    if (Math.hypot(x - this.anchorX, y - this.anchorY) <= this.px) return;
    this.anchorX = x;
    this.anchorY = y;
    this.anchorT = t;
    if (Math.hypot(x - this.startX, y - this.startY) > this.px) this.moved = true;
  }

  /** Milliseconds until the hold is due at time `t` (≤ 0: due; Infinity: nothing to hold). */
  remaining(t: number): number {
    return this.moved ? this.anchorT + this.ms - t : Number.POSITIVE_INFINITY;
  }
}

/** The end of a straight line from `start` towards `end`: snapped to 45° steps with Shift. */
export function straightEnd(start: Point, end: Point, snap: boolean): Point {
  return snap ? snapAngle(start, end) : end;
}

/** Whether the person asked for reduced motion (no straighten cue then). */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
