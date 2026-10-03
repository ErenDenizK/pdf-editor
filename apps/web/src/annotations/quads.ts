/**
 * Text markup geometry (spec §3): which glyphs a selection covers and the quads written to
 * /QuadPoints. Everything is in absolute, unrotated PDF user space, like the engine's glyph
 * boxes, so rotated pages need no special case here.
 *
 * One quad per line: the boxes of the selected glyphs of a run are united, then runs that
 * sit on the same line and touch are merged (the engine may split one printed line into
 * several runs). The engine writes each quad as QuadPoints in the order upper-left,
 * upper-right, lower-left, lower-right (see `quadPoints`).
 */
import type { Rect } from '@pdf-editor/document-model';
import type { TextRun } from '@pdf-editor/engine';

import type { Point } from './ink';

export interface GlyphRef {
  readonly run: number;
  readonly glyph: number;
}

function hasArea(r: Rect): boolean {
  return r.width > 0 && r.height > 0;
}

function union(a: Rect | undefined, b: Rect): Rect {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** A run's reading direction: horizontal unless its glyphs advance mostly vertically. */
export function runDirection(run: Pick<TextRun, 'glyphs'>): 'h' | 'v' {
  const first = run.glyphs[0];
  const last = run.glyphs[run.glyphs.length - 1];
  if (!first || !last || first === last) return 'h';
  return Math.abs(last.rect.x - first.rect.x) >= Math.abs(last.rect.y - first.rect.y) ? 'h' : 'v';
}

function distanceToRect(p: Point, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/** Flattened glyph order: runs in engine (reading) order, glyphs in run order. */
function flatten(runs: readonly TextRun[]): GlyphRef[] {
  const out: GlyphRef[] = [];
  runs.forEach((run, r) => {
    run.glyphs.forEach((_, g) => out.push({ run: r, glyph: g }));
  });
  return out;
}

/**
 * The glyph under (or nearest to) `point`, as an index into the flattened glyph order, or
 * -1 when the page has no text within `maxDistance` points.
 */
export function glyphIndexAt(runs: readonly TextRun[], point: Point, maxDistance = 24): number {
  let best = -1;
  let bestDistance = maxDistance;
  let i = 0;
  for (const run of runs) {
    for (const glyph of run.glyphs) {
      const d = distanceToRect(point, glyph.rect);
      if (d < bestDistance || (d === 0 && bestDistance === 0 && best < 0)) {
        best = i;
        bestDistance = d;
      }
      i += 1;
    }
  }
  return best;
}

/** Merges quads of one line: same reading axis, overlapping bands, touching extents. */
export function mergeLineQuads(
  quads: readonly { readonly rect: Rect; readonly dir: 'h' | 'v' }[],
): Rect[] {
  const merged: { rect: Rect; dir: 'h' | 'v' }[] = [];
  for (const quad of quads) {
    const last = merged[merged.length - 1];
    if (last?.dir === quad.dir) {
      const a = last.rect;
      const b = quad.rect;
      const [a0, a1, b0, b1] =
        quad.dir === 'h'
          ? [a.y, a.y + a.height, b.y, b.y + b.height]
          : [a.x, a.x + a.width, b.x, b.x + b.width];
      const overlap = Math.min(a1, b1) - Math.max(a0, b0);
      const band = Math.min(a1 - a0, b1 - b0);
      const thickness = Math.max(a1 - a0, b1 - b0);
      const gap =
        quad.dir === 'h'
          ? Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width))
          : Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
      if (band > 0 && overlap / band >= 0.5 && gap <= thickness) {
        last.rect = union(a, b);
        continue;
      }
    }
    merged.push({ rect: quad.rect, dir: quad.dir });
  }
  return merged.map((q) => q.rect);
}

/** A printed line: runs of one reading direction whose bands overlap, however far apart. */
export interface TextLine {
  readonly dir: 'h' | 'v';
  /** Indices of its runs, in engine (reading) order. */
  readonly runs: readonly number[];
  /** The union of its glyph boxes. */
  readonly box: Rect;
}

/**
 * The page's lines (the Highlighter's snapping, craft spec §5.4): every run with glyphs
 * joins the first line of its direction whose band (y range for horizontal text, x range
 * for vertical) overlaps its own by at least half the smaller one, else starts a line. Runs
 * side by side in two columns share a line; a superscript joins its line.
 */
export function textLines(runs: readonly TextRun[]): TextLine[] {
  const lines: { dir: 'h' | 'v'; runs: number[]; box: Rect }[] = [];
  runs.forEach((run, r) => {
    let box: Rect | undefined;
    for (const glyph of run.glyphs) if (hasArea(glyph.rect)) box = union(box, glyph.rect);
    if (!box) return;
    const dir = runDirection(run);
    const band = (b: Rect): [number, number] =>
      dir === 'h' ? [b.y, b.y + b.height] : [b.x, b.x + b.width];
    const [lo, hi] = band(box);
    const line = lines.find((l) => {
      if (l.dir !== dir) return false;
      const [a0, a1] = band(l.box);
      const overlap = Math.min(a1, hi) - Math.max(a0, lo);
      return overlap > 0 && overlap >= 0.5 * Math.min(a1 - a0, hi - lo);
    });
    if (line) {
      line.runs.push(r);
      line.box = union(line.box, box);
    } else {
      lines.push({ dir, runs: [r], box });
    }
  });
  return lines;
}

/** Quads (one per line) for a set of selected glyphs, in reading order. */
export function quadsForGlyphs(runs: readonly TextRun[], selected: readonly GlyphRef[]): Rect[] {
  const perRun = new Map<number, Rect>();
  for (const ref of selected) {
    const rect = runs[ref.run]?.glyphs[ref.glyph]?.rect;
    if (!rect || !hasArea(rect)) continue;
    perRun.set(ref.run, union(perRun.get(ref.run), rect));
  }
  const ordered = [...perRun.entries()]
    .sort(([a], [b]) => a - b)
    .map(([run, rect]) => ({ rect, dir: runDirection(runs[run] as TextRun) }));
  return mergeLineQuads(ordered);
}

/** Quads for the glyphs between two flattened indices (inclusive, either order). */
export function quadsForRange(runs: readonly TextRun[], from: number, to: number): Rect[] {
  if (from < 0 || to < 0) return [];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return quadsForGlyphs(runs, flatten(runs).slice(lo, hi + 1));
}

/** Text of the glyphs between two flattened indices (for the markup's /Contents). */
export function textForRange(runs: readonly TextRun[], from: number, to: number): string {
  if (from < 0 || to < 0) return '';
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  let text = '';
  let lastRun = -1;
  for (const ref of flatten(runs).slice(lo, hi + 1)) {
    if (lastRun >= 0 && ref.run !== lastRun && !/\s$/.test(text)) text += ' ';
    text += runs[ref.run]?.glyphs[ref.glyph]?.text ?? '';
    lastRun = ref.run;
  }
  return text.trim();
}

/**
 * Glyphs whose centre lies inside any of `rects` (user space), e.g. the client rects of a
 * DOM text selection mapped onto the page.
 */
export function glyphsInRects(runs: readonly TextRun[], rects: readonly Rect[]): GlyphRef[] {
  const out: GlyphRef[] = [];
  runs.forEach((run, r) => {
    run.glyphs.forEach((glyph, g) => {
      const cx = glyph.rect.x + glyph.rect.width / 2;
      const cy = glyph.rect.y + glyph.rect.height / 2;
      if (
        rects.some((q) => cx >= q.x && cx <= q.x + q.width && cy >= q.y && cy <= q.y + q.height)
      ) {
        out.push({ run: r, glyph: g });
      }
    });
  });
  return out;
}

/** Selected text of glyph refs, runs separated by spaces. */
export function textForGlyphs(runs: readonly TextRun[], selected: readonly GlyphRef[]): string {
  let text = '';
  let lastRun = -1;
  for (const ref of selected) {
    if (lastRun >= 0 && ref.run !== lastRun && !/\s$/.test(text)) text += ' ';
    text += runs[ref.run]?.glyphs[ref.glyph]?.text ?? '';
    lastRun = ref.run;
  }
  return text.trim();
}

/**
 * The /QuadPoints entry for one quad: x/y pairs in the order upper-left, upper-right,
 * lower-left, lower-right (ISO 32000-2 §12.5.6.10, as Acrobat writes them).
 */
export function quadPoints(
  rect: Rect,
): [number, number, number, number, number, number, number, number] {
  const x1 = rect.x;
  const x2 = rect.x + rect.width;
  const y1 = rect.y;
  const y2 = rect.y + rect.height;
  return [x1, y2, x2, y2, x1, y1, x2, y1];
}
