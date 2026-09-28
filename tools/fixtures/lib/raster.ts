/**
 * Deterministic greyscale rasteriser for the scan fixtures (M5 OCR): glyph
 * outlines from fontkit, flattened with a fixed number of segments per curve,
 * filled with the non-zero winding rule, anti-aliased with 16 sub-scanlines
 * and exact horizontal coverage. Plain arithmetic only, so the same input
 * gives the same pixels on every machine; no renderer is involved.
 */

export interface PathCommand {
  command: 'moveTo' | 'lineTo' | 'quadraticCurveTo' | 'bezierCurveTo' | 'closePath';
  args: number[];
}

/** A point transform from glyph space (font units) to pixel space. */
export type Transform = (x: number, y: number) => [number, number];

const SUBSAMPLES = 16;
const CURVE_STEPS = 12;

/** Greyscale canvas: `coverage` accumulates ink (0 = paper, >= 1 = full ink). */
export class Canvas {
  readonly width: number;
  readonly height: number;
  readonly coverage: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.coverage = new Float32Array(width * height);
  }

  /** Fills the outline `commands` (non-zero winding) after mapping each point with `t`. */
  fillPath(commands: readonly PathCommand[], t: Transform): void {
    const polys: [number, number][][] = [];
    let poly: [number, number][] = [];
    let [cx, cy, sx, sy] = [0, 0, 0, 0];
    const close = () => {
      if (poly.length > 2) polys.push(poly);
      poly = [];
    };
    for (const { command, args } of commands) {
      const [a = 0, b = 0, c = 0, d = 0, e = 0, g = 0] = args;
      if (command === 'moveTo') {
        close();
        poly.push(t(a, b));
        [cx, cy, sx, sy] = [a, b, a, b];
      } else if (command === 'lineTo') {
        poly.push(t(a, b));
        [cx, cy] = [a, b];
      } else if (command === 'quadraticCurveTo') {
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const s = i / CURVE_STEPS;
          const u = 1 - s;
          poly.push(
            t(u * u * cx + 2 * u * s * a + s * s * c, u * u * cy + 2 * u * s * b + s * s * d),
          );
        }
        [cx, cy] = [c, d];
      } else if (command === 'bezierCurveTo') {
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const s = i / CURVE_STEPS;
          const u = 1 - s;
          const k0 = u * u * u;
          const k1 = 3 * u * u * s;
          const k2 = 3 * u * s * s;
          const k3 = s * s * s;
          poly.push(t(k0 * cx + k1 * a + k2 * c + k3 * e, k0 * cy + k1 * b + k2 * d + k3 * g));
        }
        [cx, cy] = [e, g];
      } else {
        [cx, cy] = [sx, sy];
        close();
      }
    }
    close();
    this.fillPolygons(polys);
  }

  /** Non-zero fill of closed polygons given in pixel space (y down). */
  fillPolygons(polys: readonly (readonly [number, number])[][]): void {
    interface Edge {
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      dir: number;
    }
    const edges: Edge[] = [];
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const poly of polys) {
      poly.forEach((p, i) => {
        const q = poly[(i + 1) % poly.length];
        if (!q || p[1] === q[1]) return;
        const down = p[1] < q[1];
        const [a, b] = down ? [p, q] : [q, p];
        edges.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1], dir: down ? 1 : -1 });
        minY = Math.min(minY, a[1]);
        maxY = Math.max(maxY, b[1]);
      });
    }
    if (!edges.length) return;
    const rowStart = Math.max(0, Math.floor(minY));
    const rowEnd = Math.min(this.height - 1, Math.ceil(maxY));
    const weight = 1 / SUBSAMPLES;
    const row = new Float32Array(this.width + 1);
    for (let y = rowStart; y <= rowEnd; y++) {
      row.fill(0);
      let touched = false;
      for (let s = 0; s < SUBSAMPLES; s++) {
        const sy = y + (s + 0.5) / SUBSAMPLES;
        const hits: [number, number][] = [];
        for (const e of edges) {
          if (sy < e.y0 || sy >= e.y1) continue;
          hits.push([e.x0 + ((sy - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0), e.dir]);
        }
        if (hits.length < 2) continue;
        hits.sort((m, n) => m[0] - n[0] || m[1] - n[1]);
        let winding = 0;
        for (let i = 0; i < hits.length - 1; i++) {
          const hit = hits[i];
          const next = hits[i + 1];
          if (!hit || !next) break;
          winding += hit[1];
          if (winding !== 0) {
            this.span(row, hit[0], next[0], weight);
            touched = true;
          }
        }
      }
      if (!touched) continue;
      const base = y * this.width;
      for (let x = 0; x < this.width; x++) {
        const v = row[x] ?? 0;
        if (v) this.coverage[base + x] = (this.coverage[base + x] ?? 0) + v;
      }
    }
  }

  /** Adds `weight` times the horizontal overlap of [xa, xb) with each pixel. */
  private span(row: Float32Array, xa: number, xb: number, weight: number): void {
    const a = Math.max(0, xa);
    const b = Math.min(this.width, xb);
    if (b <= a) return;
    const ia = Math.floor(a);
    const ib = Math.floor(b);
    if (ia === ib) {
      row[ia] = (row[ia] ?? 0) + (b - a) * weight;
      return;
    }
    row[ia] = (row[ia] ?? 0) + (ia + 1 - a) * weight;
    for (let x = ia + 1; x < ib; x++) row[x] = (row[x] ?? 0) + weight;
    if (ib < this.width) row[ib] = (row[ib] ?? 0) + (b - ib) * weight;
  }

  /** 8-bit grey pixels (255 = paper), top row first. */
  toGrey(): Uint8Array {
    const out = new Uint8Array(this.width * this.height);
    for (let i = 0; i < out.length; i++) {
      const c = Math.min(1, this.coverage[i] ?? 0);
      out[i] = Math.round(255 * (1 - c));
    }
    return out;
  }
}
