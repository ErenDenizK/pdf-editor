/**
 * The live ink preview (experience-redesign spec §6.6, P3): a `<canvas>` over the page,
 * drawn by the outline function the engine writes (`@pdf-editor/engine/ink-outline`,
 * ADR-0018), so the preview is the shape the stroke will have. No React: the input
 * pipeline (`ink-input.ts`) calls `draw` once per animation frame while points arrive.
 *
 * - **Device-pixel exact.** The canvas is sized in whole device pixels (CSS size ×
 *   `devicePixelRatio`, like the page canvas) and covers only the part of the page that is
 *   on screen, so a page at high zoom does not allocate a page-sized bitmap.
 * - **Incremental.** The outline of the points whose joins can no longer change (all but
 *   the last two) is appended to a cached `Path2D` piece by piece; each frame outlines only
 *   the new piece and the tail (the last points plus the predicted ones), and repaints only
 *   the box they touch. Pieces overlap by one point and end in round caps, so they join
 *   without seams; every outline has the same orientation, so the nonzero fill is a union.
 * - **Predicted points** (`getPredictedEvents`) are part of the tail of one frame only.
 * - **Opacity** is the canvas's CSS opacity: the outline is filled opaque, so overlapping
 *   pieces do not darken a translucent ink.
 * - **Settling.** `settle` moves the finished stroke to its own small canvas, marked
 *   `data-settling`, drawn from the final (simplified) centre line and widths when given:
 *   the shape the engine commits. The caller removes it with `release` once the page shows
 *   the committed annotation (P1's `whenPainted`); the live canvas is free for the next
 *   stroke at once.
 */
import { inkOutlineOps } from '@pdf-editor/engine/ink-outline';

import { inkStats } from './ink-stats';

/** A stroke as the preview reads it: CSS pixels of the page, full width per point. */
export interface PreviewPath {
  readonly length: number;
  x(index: number): number;
  y(index: number): number;
  /** Full width at the point, CSS pixels. */
  w(index: number): number;
}

export interface PreviewPoint {
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

export interface InkPreviewStyle {
  /** `#rrggbb`. */
  readonly color: string;
  readonly opacity: number;
}

/** A finished stroke waiting for the page to show it. */
export interface SettlingInk {
  readonly element: HTMLCanvasElement;
  /** Removes the settling preview (idempotent). */
  readonly release: () => void;
}

/** Counters for tests: how much outline work the frames did. */
export interface InkPreviewStats {
  frames: number;
  /** Points passed to the outline function, over all frames. */
  outlinedPoints: number;
  /** Pieces appended to the cached outline. */
  pieces: number;
}

/** A box in device pixels of the live canvas. */
interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A `PreviewPath` over plain arrays. */
export function previewPath(
  points: readonly { readonly x: number; readonly y: number }[],
  widths: readonly number[],
): PreviewPath {
  return {
    length: points.length,
    x: (i) => points[i]?.x ?? 0,
    y: (i) => points[i]?.y ?? 0,
    w: (i) => widths[i] ?? widths[widths.length - 1] ?? 1,
  };
}

/**
 * Appends PDF path-construction operators (`m`, `l`, `c`, `h`, as `inkOutlineOps` writes
 * them) to a `Path2D`.
 */
export function outlinePath(ops: string, path: Path2D = new Path2D()): Path2D {
  const args: number[] = [];
  for (const token of ops.split(/\s+/)) {
    if (token === '') continue;
    switch (token) {
      case 'm':
        path.moveTo(args[0] ?? 0, args[1] ?? 0);
        break;
      case 'l':
        path.lineTo(args[0] ?? 0, args[1] ?? 0);
        break;
      case 'c':
        path.bezierCurveTo(
          args[0] ?? 0,
          args[1] ?? 0,
          args[2] ?? 0,
          args[3] ?? 0,
          args[4] ?? 0,
          args[5] ?? 0,
        );
        break;
      case 'h':
        path.closePath();
        break;
      default:
        args.push(Number(token));
        continue;
    }
    args.length = 0;
  }
  return path;
}

function union(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return {
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
    x2: Math.max(a.x2, b.x2),
    y2: Math.max(a.y2, b.y2),
  };
}

/** Device-pixel points and widths of `path[from, to)` plus `extra`, shifted by the origin. */
function devicePoints(
  path: PreviewPath,
  from: number,
  to: number,
  extra: readonly PreviewPoint[],
  scale: number,
  originX: number,
  originY: number,
): { points: { x: number; y: number }[]; widths: number[]; box: Box | null } {
  const points: { x: number; y: number }[] = [];
  const widths: number[] = [];
  let box: Box | null = null;
  const add = (x: number, y: number, w: number) => {
    const p = { x: x * scale - originX, y: y * scale - originY };
    const width = w * scale;
    points.push(p);
    widths.push(width);
    // A miter reaches at most one full width from the centre (limit 2 × half width).
    const r = width + 2;
    box = union(box, { x1: p.x - r, y1: p.y - r, x2: p.x + r, y2: p.y + r });
  };
  for (let i = from; i < to; i++) add(path.x(i), path.y(i), path.w(i));
  for (const p of extra) add(p.x, p.y, p.w);
  return { points, widths, box };
}

function outline(points: readonly { x: number; y: number }[], widths: readonly number[]): Path2D {
  return outlinePath(inkOutlineOps(points, widths));
}

function placeCanvas(
  canvas: HTMLCanvasElement,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  const s = canvas.style;
  s.position = 'absolute';
  s.left = `${left}px`;
  s.top = `${top}px`;
  s.width = `${width}px`;
  s.height = `${height}px`;
  s.pointerEvents = 'none';
}

export class InkPreview {
  readonly stats: InkPreviewStats = { frames: 0, outlinedPoints: 0, pieces: 0 };
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  /** Device pixels per CSS pixel. */
  private scale = 1;
  /** The live canvas's top-left in device pixels of the host. */
  private originX = 0;
  private originY = 0;
  private style: InkPreviewStyle = { color: '#000000', opacity: 1 };
  private stable = new Path2D();
  /** Points [0, stableCount) are in `stable`. */
  private stableCount = 0;
  private tailBox: Box | null = null;
  /** Everything drawn since `begin`, for `settle` without a final shape. */
  private drawnBox: Box | null = null;

  constructor(readonly host: HTMLElement) {}

  /** The live canvas (tests). */
  get liveCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  /** Readies the live canvas for a stroke: sized to the visible part of the host, cleared. */
  begin(style: InkPreviewStyle): void {
    this.style = style;
    const dpr = window.devicePixelRatio || 1;
    const rect = this.host.getBoundingClientRect();
    const viewWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewHeight = document.documentElement.clientHeight || window.innerHeight;
    // The visible part of the host, in whole device pixels.
    let left = Math.max(0, -rect.left);
    let top = Math.max(0, -rect.top);
    let right = Math.min(rect.width, viewWidth - rect.left);
    let bottom = Math.min(rect.height, viewHeight - rect.top);
    if (right <= left || bottom <= top) {
      left = 0;
      top = 0;
      right = rect.width;
      bottom = rect.height;
    }
    const x1 = Math.floor(left * dpr);
    const y1 = Math.floor(top * dpr);
    const width = Math.max(1, Math.ceil(right * dpr) - x1);
    const height = Math.max(1, Math.ceil(bottom * dpr) - y1);
    let canvas = this.canvas;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.setAttribute('data-ink-preview', 'live');
      canvas.setAttribute('aria-hidden', 'true');
      this.host.appendChild(canvas);
      this.canvas = canvas;
      this.context = null;
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    placeCanvas(canvas, x1 / dpr, y1 / dpr, width / dpr, height / dpr);
    canvas.style.opacity = String(style.opacity);
    this.context ??= canvas.getContext('2d', { desynchronized: true });
    this.scale = dpr;
    this.originX = x1;
    this.originY = y1;
    this.reset();
    this.context?.clearRect(0, 0, width, height);
  }

  /**
   * Draws the stroke so far. `restart` when the points changed other than by appending
   * (Shift straightened the stroke, widths were recomputed): the outline is rebuilt.
   */
  draw(path: PreviewPath, predicted: readonly PreviewPoint[] = [], restart = false): void {
    const ctx = this.context;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    this.stats.frames++;
    let dirty: Box | null = this.tailBox;
    if (restart) {
      this.reset();
      dirty = { x1: 0, y1: 0, x2: canvas.width, y2: canvas.height };
    }
    const n = path.length;
    if (n === 0) return;
    const at = (from: number, to: number, extra: readonly PreviewPoint[] = []) =>
      devicePoints(path, from, to, extra, this.scale, this.originX, this.originY);
    // Points whose joins are final: all but the last two.
    const settled = n - 2;
    const pieceFrom = Math.max(0, this.stableCount - 1);
    if (settled > this.stableCount && settled - pieceFrom >= 2) {
      const piece = at(pieceFrom, settled);
      outlinePath(inkOutlineOps(piece.points, piece.widths), this.stable);
      this.stats.pieces++;
      this.stats.outlinedPoints += piece.points.length;
      this.stableCount = settled;
      dirty = union(dirty, piece.box);
      this.drawnBox = union(this.drawnBox, piece.box);
    }
    const tail = at(Math.max(0, this.stableCount - 1), n, predicted);
    const tailPath = outline(tail.points, tail.widths);
    this.stats.outlinedPoints += tail.points.length;
    dirty = union(dirty, tail.box);
    this.tailBox = tail.box;
    this.drawnBox = union(this.drawnBox, tail.box);
    if (!dirty) return;
    const x1 = Math.max(0, Math.floor(dirty.x1));
    const y1 = Math.max(0, Math.floor(dirty.y1));
    const x2 = Math.min(canvas.width, Math.ceil(dirty.x2));
    const y2 = Math.min(canvas.height, Math.ceil(dirty.y2));
    if (x2 <= x1 || y2 <= y1) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x1, y1, x2 - x1, y2 - y1);
    ctx.clip();
    ctx.clearRect(x1, y1, x2 - x1, y2 - y1);
    ctx.fillStyle = this.style.color;
    ctx.fill(this.stable);
    ctx.fill(tailPath);
    ctx.restore();
  }

  /**
   * Ends the live stroke: it moves to a settling canvas of its own (drawn from `final`, the
   * committed centre line and widths in CSS pixels, when given; else copied from the live
   * canvas) and the live canvas is cleared for the next stroke.
   */
  settle(final?: PreviewPath): SettlingInk {
    const element = document.createElement('canvas');
    element.setAttribute('data-testid', 'annotation-preview');
    element.setAttribute('data-settling', '');
    element.setAttribute('data-ink-preview', 'settling');
    element.setAttribute('aria-hidden', 'true');
    const scale = this.scale;
    let box: Box | null = null;
    let draw: ((ctx: CanvasRenderingContext2D) => void) | undefined;
    if (final && final.length > 0) {
      // Host coordinates: the final shape may reach outside the live canvas.
      const shape = devicePoints(final, 0, final.length, [], scale, 0, 0);
      box = shape.box;
      draw = (ctx) => {
        ctx.fillStyle = this.style.color;
        ctx.fill(outline(shape.points, shape.widths));
      };
    } else if (this.drawnBox && this.canvas) {
      const live = this.canvas;
      const b = this.drawnBox;
      box = {
        x1: b.x1 + this.originX,
        y1: b.y1 + this.originY,
        x2: b.x2 + this.originX,
        y2: b.y2 + this.originY,
      };
      draw = (ctx) => {
        ctx.drawImage(live, this.originX, this.originY);
      };
    }
    const x1 = Math.floor(box?.x1 ?? 0);
    const y1 = Math.floor(box?.y1 ?? 0);
    const width = Math.max(1, Math.ceil(box?.x2 ?? 1) - x1);
    const height = Math.max(1, Math.ceil(box?.y2 ?? 1) - y1);
    element.width = width;
    element.height = height;
    placeCanvas(element, x1 / scale, y1 / scale, width / scale, height / scale);
    element.style.opacity = String(this.style.opacity);
    const ctx = element.getContext('2d');
    if (ctx && draw) {
      ctx.translate(-x1, -y1);
      draw(ctx);
    }
    this.host.appendChild(element);
    this.clear();
    // Ink statistics: pointer-up to committed stroke visible ends when this is released.
    const stats = inkStats();
    const ended = stats?.takeEnded() ?? null;
    return {
      element,
      release: () => {
        element.remove();
        if (stats && ended) stats.visible(ended);
      },
    };
  }

  /** Drops the live stroke without keeping it. */
  cancel(): void {
    this.clear();
  }

  /** Removes the live canvas (settling previews stay until released). */
  destroy(): void {
    this.canvas?.remove();
    this.canvas = null;
    this.context = null;
    this.reset();
  }

  private clear(): void {
    const canvas = this.canvas;
    this.context?.clearRect(0, 0, canvas?.width ?? 0, canvas?.height ?? 0);
    this.reset();
  }

  private reset(): void {
    this.stable = new Path2D();
    this.stableCount = 0;
    this.tailBox = null;
    this.drawnBox = null;
  }
}
