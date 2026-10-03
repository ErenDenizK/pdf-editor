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
 * - **Joins** (outline version 2, craft spec §5.2 item 4): a turn of up to 45° is mitred
 *   (the edge point moves at most 8 % past the half width); a sharper turn gets a round join:
 *   an arc of the half width round the outer side, and the inner side passes through the
 *   centre point, so the outline is the union of the segments and the arc and never spikes.
 *   Version 1 clamped every join to a miter of twice the half width.
 * - `inkAppearanceContent`: the content of the annotation's normal appearance (user space,
 *   as `FPDFAnnot_SetAP` expects: its /BBox is the annotation's /Rect, no /Matrix).
 * - `encodeInkWidths` / `decodeInkWidths`: the private `/PdfEditorInkWidths` value (per-point
 *   widths parallel to `/InkList`) as a PDF text string, so a later session can regenerate
 *   the appearance after an edit. Widths that do not match the paths decode to `undefined`
 *   (spec §9: the stroke is then constant width).
 *
 * The outline is a function of the centre line and the widths only, so the same input
 * always gives the same appearance (preview = commit = regeneration). It is versioned
 * (`INK_OUTLINE_VERSION`) through the prefix of `/PdfEditorInkWidths`: an appearance in a
 * file is never rewritten on its own, so a stroke written by an older outline keeps its
 * stream until an edit (move, recolour, width change, split) regenerates it with this one,
 * and the widths of every known version decode.
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
/**
 * The outline generation, written as the prefix of `/PdfEditorInkWidths`. 1: miter joins
 * clamped at twice the half width; 2: round joins above `ROUND_JOIN_DEG`. The widths format
 * is the same in both.
 */
export const INK_OUTLINE_VERSION = 2;
/** Prefixes of `/PdfEditorInkWidths` whose widths decode (every outline version so far). */
const WIDTHS_VERSIONS: ReadonlySet<string> = new Set(['1', '2']);
/** Bézier control distance for a quarter circle. */
const KAPPA = 0.5522847498;
/** Turns sharper than this (degrees) get a round join; gentler ones a miter. */
export const ROUND_JOIN_DEG = 45;
const ROUND_JOIN_COS = Math.cos((ROUND_JOIN_DEG * Math.PI) / 180);

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

/** One edge point, or a round join: an arc of radius `r` round `c` from `from` to `to`. */
type EdgeStep =
  | { readonly kind: 'point'; readonly p: InkPoint }
  | {
      readonly kind: 'arc';
      readonly c: InkPoint;
      readonly r: number;
      readonly from: InkPoint;
      readonly to: InkPoint;
      /** Signed sweep, radians (positive: counter-clockwise in user space). */
      readonly sweep: number;
    };

interface OutlineGeometry {
  readonly points: readonly InkPoint[];
  readonly widths: readonly number[];
  /** Unit direction of each segment. */
  readonly dirs: readonly InkPoint[];
  /** The left edge, start to end. */
  readonly left: readonly EdgeStep[];
  /** The right edge, end to start (the order the outline walks it). */
  readonly right: readonly EdgeStep[];
}

const point = (p: InkPoint): EdgeStep => ({ kind: 'point', p });

function arc(c: InkPoint, r: number, from: InkPoint, to: InkPoint, sweep: number): EdgeStep {
  return { kind: 'arc', c, r, from, to, sweep };
}

function outlineGeometry(path: readonly InkPoint[], widths: readonly number[]): OutlineGeometry {
  const { points, widths: w } = distinct(path, widths);
  const n = points.length;
  const dirs: InkPoint[] = [];
  for (let i = 0; i + 1 < n; i++) {
    dirs.push(unit(sub(points[i + 1] as InkPoint, points[i] as InkPoint)) ?? { x: 1, y: 0 });
  }
  const left: EdgeStep[] = [];
  /** Built start to end, then reversed. */
  const right: EdgeStep[][] = [];
  for (let i = 0; i < n && n > 1; i++) {
    const before = dirs[i - 1];
    const after = dirs[i];
    const p = points[i] as InkPoint;
    const r = (w[i] ?? 1) / 2;
    if (before && after) {
      const cos = before.x * after.x + before.y * after.y;
      if (cos < ROUND_JOIN_COS) {
        // Round join: the arc on the outer side, the centre point on the inner side (the
        // segments overlap there; the nonzero fill makes it a union).
        const n0 = { x: -before.y, y: before.x };
        const n1 = { x: -after.y, y: after.x };
        const turn = Math.acos(Math.max(-1, Math.min(1, cos)));
        const turnsLeft = before.x * after.y - before.y * after.x > 0;
        const l0 = at(p, n0, r);
        const l1 = at(p, n1, r);
        const r0 = at(p, n0, -r);
        const r1 = at(p, n1, -r);
        if (turnsLeft) {
          // Outer side on the right, walked from the later segment back to the earlier.
          left.push(point(l0), point(p), point(l1));
          right.push([arc(p, r, r1, r0, -turn)]);
        } else {
          left.push(arc(p, r, l0, l1, -turn));
          right.push([point(r1), point(p), point(r0)]);
        }
        continue;
      }
      // Miter join: the offset along the averaged tangent's normal, lengthened so the edge
      // stays parallel to both segments (at most 1 / cos 22.5°, 8 %, at a 45° turn).
      const tangent = unit({ x: before.x + after.x, y: before.y + after.y }) ?? after;
      const scale = 1 / Math.max(tangent.x * after.x + tangent.y * after.y, 1e-6);
      const normal = { x: -tangent.y, y: tangent.x };
      left.push(point(at(p, normal, r * scale)));
      right.push([point(at(p, normal, -r * scale))]);
      continue;
    }
    const tangent = after ?? before ?? { x: 1, y: 0 };
    const normal = { x: -tangent.y, y: tangent.x };
    left.push(point(at(p, normal, r)));
    right.push([point(at(p, normal, -r))]);
  }
  return { points, widths: w, dirs, left, right: right.reverse().flat() };
}

/** Where an edge starts (its first point). */
function stepStart(step: EdgeStep): InkPoint {
  return step.kind === 'point' ? step.p : step.from;
}

/** Appends an edge as operators; the first step is a `l` (or `m` with `move`). */
function edgeOps(
  steps: readonly EdgeStep[],
  out: string[],
  fmt: (p: InkPoint) => string,
  move: boolean,
): void {
  for (const [k, step] of steps.entries()) {
    const start = stepStart(step);
    out.push(`${fmt(start)} ${move && k === 0 ? 'm' : 'l'}`);
    if (step.kind === 'arc') arcOps(step, out, fmt);
  }
}

/** The arc of a round join as Bézier pieces of at most 90°, from `from` to `to`. */
function arcOps(
  step: Extract<EdgeStep, { kind: 'arc' }>,
  out: string[],
  fmt: (p: InkPoint) => string,
): void {
  const { c, r, sweep } = step;
  const parts = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const phi = sweep / parts;
  const k = (4 / 3) * Math.tan(phi / 4) * r;
  let angle = Math.atan2(step.from.y - c.y, step.from.x - c.x);
  for (let i = 0; i < parts; i++) {
    const a0 = angle;
    const a1 = angle + phi;
    const p0 = { x: c.x + r * Math.cos(a0), y: c.y + r * Math.sin(a0) };
    const p1 = i === parts - 1 ? step.to : { x: c.x + r * Math.cos(a1), y: c.y + r * Math.sin(a1) };
    // Tangents in the direction of travel (counter-clockwise for a positive sweep).
    const t0 = { x: -Math.sin(a0), y: Math.cos(a0) };
    const t1 = { x: -Math.sin(a1), y: Math.cos(a1) };
    out.push(`${fmt(at(p0, t0, k))} ${fmt(at(p1, t1, -k))} ${fmt(p1)} c`);
    angle = a1;
  }
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
  edgeOps(left, out, fmt, true);
  // End cap: a half circle from the left edge round the tip to the right edge.
  capOps(points[n - 1] as InkPoint, dirs[n - 2] as InkPoint, (w[n - 1] ?? 1) / 2, out, fmt);
  edgeOps(right, out, fmt, false);
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

/** The box every outline stays inside (edges, miters, joins and round caps), grown by `pad`. */
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
  const growStep = (step: EdgeStep) => {
    if (step.kind === 'point') {
      grow(step.p);
      return;
    }
    // An arc: its ends and the axis extremes it passes.
    grow(step.from);
    grow(step.to);
    const start = Math.atan2(step.from.y - step.c.y, step.from.x - step.c.x);
    for (let q = 0; q < 4; q++) {
      const axis = (q * Math.PI) / 2;
      // How far along the sweep the axis direction lies (0 at the start).
      let d = (axis - start) * Math.sign(step.sweep);
      d = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (d <= Math.abs(step.sweep)) {
        grow({ x: step.c.x + step.r * Math.cos(axis), y: step.c.y + step.r * Math.sin(axis) });
      }
    }
  };
  paths.forEach((path, k) => {
    const g = outlineGeometry(path, widths[k] ?? []);
    g.left.forEach(growStep);
    g.right.forEach(growStep);
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

/**
 * `/PdfEditorInkWidths`: `2;w w w;w w` (the outline version, then one group per path, 2
 * decimals).
 */
export function encodeInkWidths(widths: readonly (readonly number[])[]): string {
  return [String(INK_OUTLINE_VERSION), ...widths.map((ws) => ws.map(pdfNumber).join(' '))].join(
    ';',
  );
}

/**
 * The widths stored in `/PdfEditorInkWidths`, or `undefined` when the value is missing, of
 * an unknown version, or does not match `paths` point for point (edited elsewhere). Every
 * outline version so far stores the widths the same way.
 */
export function decodeInkWidths(
  value: string | undefined,
  paths: readonly (readonly InkPoint[])[],
): number[][] | undefined {
  if (!value) return undefined;
  const [version, ...groups] = value.split(';');
  if (!WIDTHS_VERSIONS.has(version ?? '') || groups.length !== paths.length) return undefined;
  const widths: number[][] = [];
  for (const [k, group] of groups.entries()) {
    const ws = group.trim() === '' ? [] : group.trim().split(/\s+/).map(Number);
    if (ws.length !== paths[k]?.length) return undefined;
    if (ws.some((w) => !Number.isFinite(w) || w <= 0)) return undefined;
    widths.push(ws);
  }
  return widths;
}
