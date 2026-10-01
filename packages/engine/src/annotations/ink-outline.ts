/**
 * Variable-width ink outlines (spike S1, docs/research/09-ink-appearance-spike.md;
 * spec experience-redesign.md §6.7). Pure functions, no PDFium:
 *
 * - `inkOutlineOps`: the filled outline of one centre line with a width per point, as PDF
 *   path-construction operators (`m`/`l`/`c`/`h`): the left edge forward, a round end cap,
 *   the right edge back, a round start cap. Every outline is built with the same
 *   orientation, so all paths of an annotation fill as one nonzero `f` (a union: a stroke
 *   crossing itself or another stroke is not punched out, and a translucent ink does not
 *   darken where strokes overlap).
 * - `inkAppearanceContent`: the content of the annotation's normal appearance (user space,
 *   as `FPDFAnnot_SetAP` expects: its /BBox is the annotation's /Rect, no /Matrix).
 * - `encodeInkWidths` / `decodeInkWidths`: the private `/PdfEditorInkWidths` value (per-point
 *   widths parallel to `/InkList`) as a PDF text string, so a later session can regenerate
 *   the appearance after an edit. Widths that do not match the paths decode to `undefined`
 *   (spec §9: the stroke is then constant width).
 *
 * The outline is a function of the centre line and the widths only, so the same input
 * always gives the same appearance (preview = commit = regeneration). Exported for P4; the
 * app does not use it yet.
 */

export interface InkPoint {
  readonly x: number;
  readonly y: number;
}

export interface InkBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The private annotation key that carries the widths (a PDF text string). */
export const INK_WIDTHS_KEY = 'PdfEditorInkWidths';
/** Version prefix of the `/PdfEditorInkWidths` value. */
const WIDTHS_VERSION = '1';
/** Bézier control distance for a quarter circle. */
const KAPPA = 0.5522847498;
/** Longest miter, as a multiple of the half width, at a sharp join. */
const MITER_LIMIT = 2;

/** A number for a content stream: 2 decimals, no trailing zeros, no `-0`. */
export function pdfNumber(v: number): string {
  if (Math.abs(v) < 0.005) return '0';
  return v.toFixed(2).replace(/\.?0+$/, '');
}

function sub(a: InkPoint, b: InkPoint): InkPoint {
  return { x: a.x - b.x, y: a.y - b.y };
}

function unit(v: InkPoint): InkPoint | undefined {
  const length = Math.hypot(v.x, v.y);
  return length > 1e-9 ? { x: v.x / length, y: v.y / length } : undefined;
}

function at(p: InkPoint, d: InkPoint, k: number): InkPoint {
  return { x: p.x + d.x * k, y: p.y + d.y * k };
}

/** Drops points closer than 1e-3 pt to the previous kept one, keeping their widths aligned. */
function distinct(
  path: readonly InkPoint[],
  widths: readonly number[],
): { points: InkPoint[]; widths: number[] } {
  const points: InkPoint[] = [];
  const kept: number[] = [];
  path.forEach((p, i) => {
    const last = points[points.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-3) return;
    points.push(p);
    kept.push(Math.max(widths[i] ?? widths[widths.length - 1] ?? 1, 0.01));
  });
  return { points, widths: kept };
}

function circleOps(c: InkPoint, r: number, out: string[]): void {
  const k = r * KAPPA;
  const n = (x: number, y: number) => `${pdfNumber(x)} ${pdfNumber(y)}`;
  out.push(
    `${n(c.x + r, c.y)} m`,
    `${n(c.x + r, c.y + k)} ${n(c.x + k, c.y + r)} ${n(c.x, c.y + r)} c`,
    `${n(c.x - k, c.y + r)} ${n(c.x - r, c.y + k)} ${n(c.x - r, c.y)} c`,
    `${n(c.x - r, c.y - k)} ${n(c.x - k, c.y - r)} ${n(c.x, c.y - r)} c`,
    `${n(c.x + k, c.y - r)} ${n(c.x + r, c.y - k)} ${n(c.x + r, c.y)} c`,
    'h',
  );
}

/**
 * The outline of one stroke as path-construction operators. `widths[i]` is the full width
 * at `path[i]` (points). A single point (or a path whose points coincide) is a dot.
 */
export function inkOutlineOps(path: readonly InkPoint[], widths: readonly number[]): string {
  const out: string[] = [];
  appendOutline(path, widths, out);
  return out.join('\n');
}

interface OutlineGeometry {
  readonly points: readonly InkPoint[];
  readonly widths: readonly number[];
  /** Unit direction of each segment. */
  readonly dirs: readonly InkPoint[];
  readonly left: readonly InkPoint[];
  readonly right: readonly InkPoint[];
}

function outlineGeometry(path: readonly InkPoint[], widths: readonly number[]): OutlineGeometry {
  const { points, widths: w } = distinct(path, widths);
  const n = points.length;
  const dirs: InkPoint[] = [];
  for (let i = 0; i + 1 < n; i++) {
    dirs.push(unit(sub(points[i + 1] as InkPoint, points[i] as InkPoint)) ?? { x: 1, y: 0 });
  }
  const left: InkPoint[] = [];
  const right: InkPoint[] = [];
  for (let i = 0; i < n && n > 1; i++) {
    const before = dirs[i - 1];
    const after = dirs[i];
    let tangent = after ?? before ?? { x: 1, y: 0 };
    let scale = 1;
    if (before && after) {
      // Miter join: the offset along the averaged tangent's normal, lengthened so the edge
      // stays parallel to both segments, up to MITER_LIMIT.
      tangent = unit({ x: before.x + after.x, y: before.y + after.y }) ?? after;
      const cos = tangent.x * after.x + tangent.y * after.y;
      scale = Math.min(1 / Math.max(cos, 1e-6), MITER_LIMIT);
    }
    const normal = { x: -tangent.y, y: tangent.x };
    const r = ((w[i] ?? 1) / 2) * scale;
    const p = points[i] as InkPoint;
    left.push(at(p, normal, r));
    right.push(at(p, normal, -r));
  }
  return { points, widths: w, dirs, left, right };
}

function appendOutline(path: readonly InkPoint[], widths: readonly number[], out: string[]): void {
  const { points, widths: w, dirs, left, right } = outlineGeometry(path, widths);
  const first = points[0];
  if (!first) return;
  if (points.length === 1) {
    circleOps(first, (w[0] ?? 1) / 2, out);
    return;
  }
  const n = points.length;
  const fmt = (p: InkPoint) => `${pdfNumber(p.x)} ${pdfNumber(p.y)}`;
  out.push(`${fmt(left[0] as InkPoint)} m`);
  for (let i = 1; i < n; i++) out.push(`${fmt(left[i] as InkPoint)} l`);
  // End cap: a half circle from the left edge round the tip to the right edge.
  capOps(points[n - 1] as InkPoint, dirs[n - 2] as InkPoint, (w[n - 1] ?? 1) / 2, out, fmt);
  for (let i = n - 1; i >= 0; i--) out.push(`${fmt(right[i] as InkPoint)} l`);
  // Start cap: the same, walking backwards.
  const back = dirs[0] as InkPoint;
  capOps(first, { x: -back.x, y: -back.y }, (w[0] ?? 1) / 2, out, fmt);
  out.push('h');
}

/** A half circle centred on `c`, from `c + n·r` through `c + t·r` to `c − n·r`. */
function capOps(
  c: InkPoint,
  t: InkPoint,
  r: number,
  out: string[],
  fmt: (p: InkPoint) => string,
): void {
  const nrm = { x: -t.y, y: t.x };
  const a = at(c, nrm, r);
  const tip = at(c, t, r);
  const b = at(c, nrm, -r);
  const k = r * KAPPA;
  out.push(`${fmt(at(a, t, k))} ${fmt(at(tip, nrm, k))} ${fmt(tip)} c`);
  out.push(`${fmt(at(tip, nrm, -k))} ${fmt(at(b, t, k))} ${fmt(b)} c`);
}

/** The box every outline stays inside (edges, miters and round caps), grown by `pad`. */
export function inkOutlineBounds(
  paths: readonly (readonly InkPoint[])[],
  widths: readonly (readonly number[])[],
  pad = 0.5,
): InkBounds {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  const grow = (p: InkPoint, r = 0) => {
    x1 = Math.min(x1, p.x - r);
    y1 = Math.min(y1, p.y - r);
    x2 = Math.max(x2, p.x + r);
    y2 = Math.max(y2, p.y + r);
  };
  paths.forEach((path, k) => {
    const g = outlineGeometry(path, widths[k] ?? []);
    g.left.forEach((p) => grow(p));
    g.right.forEach((p) => grow(p));
    // Caps and dots: a circle of the end widths around the end points.
    const ends = [0, g.points.length - 1];
    for (const i of ends) {
      const p = g.points[i];
      if (p) grow(p, (g.widths[i] ?? 1) / 2);
    }
  });
  if (!Number.isFinite(x1)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x1 - pad, y: y1 - pad, width: x2 - x1 + 2 * pad, height: y2 - y1 + 2 * pad };
}

function rgb(color: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return [0, 0, 0];
  return [m[1], m[2], m[3]].map((h) => Number.parseInt(h as string, 16) / 255) as [
    number,
    number,
    number,
  ];
}

export interface InkAppearanceInput {
  readonly paths: readonly (readonly InkPoint[])[];
  readonly widths: readonly (readonly number[])[];
  /** `#RRGGBB`. */
  readonly color: string;
  /**
   * The annotation's /CA. Below 1 the content selects `/GS`, the ExtGState PDFium's
   * `FPDFAnnot_SetAP` puts in the appearance resources when the annotation has /CA < 1.
   */
  readonly opacity?: number;
}

/** The normal appearance content: every outline in one nonzero fill. */
export function inkAppearanceContent(input: InkAppearanceInput): string {
  const out: string[] = ['q'];
  if ((input.opacity ?? 1) < 1) out.push('/GS gs');
  const [r, g, b] = rgb(input.color);
  const c = (v: number) => (Math.round(v * 1000) / 1000).toString();
  out.push(`${c(r)} ${c(g)} ${c(b)} rg`);
  input.paths.forEach((path, k) => {
    appendOutline(path, input.widths[k] ?? [], out);
  });
  out.push('f', 'Q');
  return out.join('\n');
}

/** `/PdfEditorInkWidths`: `1;w w w;w w` (version, then one group per path, 2 decimals). */
export function encodeInkWidths(widths: readonly (readonly number[])[]): string {
  return [WIDTHS_VERSION, ...widths.map((ws) => ws.map(pdfNumber).join(' '))].join(';');
}

/**
 * The widths stored in `/PdfEditorInkWidths`, or `undefined` when the value is missing, of
 * another version, or does not match `paths` point for point (edited elsewhere).
 */
export function decodeInkWidths(
  value: string | undefined,
  paths: readonly (readonly InkPoint[])[],
): number[][] | undefined {
  if (!value) return undefined;
  const [version, ...groups] = value.split(';');
  if (version !== WIDTHS_VERSION || groups.length !== paths.length) return undefined;
  const widths: number[][] = [];
  for (const [k, group] of groups.entries()) {
    const ws = group.trim() === '' ? [] : group.trim().split(/\s+/).map(Number);
    if (ws.length !== paths[k]?.length) return undefined;
    if (ws.some((w) => !Number.isFinite(w) || w <= 0)) return undefined;
    widths.push(ws);
  }
  return widths;
}
