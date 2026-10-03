/**
 * The paragraph writer (craft spec §4.4–§4.6, ADR-0020 §3–§6): `applyParagraphEdit`
 * generalises `performEdit` from one line to a paragraph.
 *
 * 1. **Input.** The paragraph is found again on the page (`stale-run` when it moved), mapped
 *    onto the rewrap's input and measured (`paragraph-input.ts`).
 * 2. **Layout.** `layoutParagraph` from the edit, then the overflow policy (`decideOverflow`):
 *    commit, grow, tighten or run over. A layout passed in (the overlay's, or the one recorded
 *    for replay) is written as it is.
 * 3. **Plan.** Each original line is kept, reused (moved by the rewrap's `dy`) or rewritten.
 *    Rewritten lines are cut into segments: stretches of glyphs that advance naturally in one
 *    style and font (a kerning offset, a justified word gap or a font change starts a new one;
 *    justified lines are therefore one object per word). Segment k of a rewritten line goes
 *    into the next unused text object of the original line it replaces that has its style, in
 *    page order (`FPDFText_SetCharcodes` + `FPDFPageObj_SetMatrix`: the object keeps its colour
 *    space, Tc/Tw/Tz, clip and marked content); without one, into a new object in the same
 *    `FPDF_FONT` and size, styled and marked like the style's first object, inserted in page
 *    order next to the line's other objects (lines the paragraph did not have follow the line
 *    before them: the paragraph's z-order, under its marked-content sequence). Characters the
 *    font lacks go into a new object in a subset of the style's bundled face (tier 1,
 *    `FPDFText_LoadCidType2Font`). Objects of replaced lines that end up empty are removed.
 * 4. **Refusals** come before any change: `detectParagraphs`' own, text in a form XObject,
 *    an object that also draws text the edit must keep (`shared-object`), glyphs that would
 *    leave the clip of the object that draws them or, in a new object, of the style's object
 *    (`clipped`), fonts whose codes cannot be read, characters no font has.
 * 5. **Verification** on a fresh text page: every written object reads back exactly its
 *    planned text, every glyph origin within 0.01 pt and every glyph box within 0.05 pt of the
 *    plan, moved lines exactly where they should be, and (scale 2) no pixel changed outside
 *    the paragraph's old and new extent. A container whose glyphs all sit off the plan by one
 *    vector (a text rise) is moved back once and checked again.
 * 6. **Commit.** Links, markup quads and widgets lying on words that moved are moved with
 *    them, then one `GenerateContent`. A dry run (`commit: false`) does all of the above on a
 *    private copy of the page (`FPDF_ImportPagesByIndex` into a scratch document) and closes
 *    it: the source never changes, and fonts loaded for substitutes go with the copy.
 *
 * Replay (ADR-0011): the `text.editParagraph` edit records the layout; applying it again on
 * the reopened bytes runs the same raw calls in the same order and writes the same bytes.
 */
import type { Rect, SourceId } from '@pdf-editor/document-model';

import type { RawAccess } from '../pdfium/host/hosted-engine';
import type { RawDocContext, RawPageContext } from '../pdfium/host/doc-context';
import { type PageGeometry, userToDeviceRect } from '../pdfium/coords';
import type {
  LayoutLine,
  OverflowDecision,
  ParagraphEdit,
  ParagraphEditResult,
  ParagraphEditVerification,
  ParagraphLayout,
  ParagraphLayoutAnalysis,
  ParagraphMovedAnnotation,
  ParagraphRef,
  TextMatrix,
} from '../types';
import { analysisChars } from './analysis';
import { matchGlyphs, type ReadChar, readChars } from './apply';
import type { ParagraphCache } from './blocks';
import { type ClipRegion, clipOf, clipsContain } from './clip';
import { textEditError } from './errors';
import { buildSubset, type FaceCache, faceByKey, familyName, ITALIC_SKEW } from './fonts';
import { type LayoutEdit, layoutParagraph } from './linebreak';
import { decideOverflow } from './overflow';
import {
  type PageTarget,
  paragraphRefusalError,
  type PreparedParagraph,
  prepareParagraph,
  userPoint,
} from './paragraph-input';
import { multiply, PAGEOBJ_TEXT, type Point, RawText } from './raw';

/** Glyph origins may differ from the plan by this much (points). */
export const PARAGRAPH_ORIGIN_TOLERANCE = 0.01;
/** Glyph boxes may differ from the plan by this much (points). */
export const PARAGRAPH_BOX_TOLERANCE = 0.05;
/** Scale of the pixel comparison outside the paragraph. */
const PIXEL_SCALE = 2;
/** Margin around the paragraph's extent the pixel comparison leaves out (points). */
const PIXEL_MARGIN = 1;
/** A displacement smaller than this needs no split of a segment (points). */
const SPLIT_EPSILON = 0.001;
/** `FPDF_ANNOT` and `FPDF_REVERSE_BYTE_ORDER` render flags. */
const RENDER_ANNOT = 0x01;
const RENDER_RGBA = 0x10;
/** `FPDF_ANNOT_*` subtypes moved with their words. */
const ANNOT_SUBTYPES: Readonly<Record<number, ParagraphMovedAnnotation['subtype']>> = {
  2: 'link',
  9: 'highlight',
  10: 'underline',
  11: 'squiggly',
  12: 'strikeout',
  20: 'widget',
};

/** An RGBA rendering. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

interface PlannedGlyph {
  readonly text: string;
  /** Offset in `layout.text` (-1 for a kept line-end hyphen). */
  readonly offset: number;
  /** Code in the original font; substitutes get theirs from the subset. */
  readonly code: number;
  readonly origin: Point;
  /** Distance to the next glyph's origin as planned (advance plus kerning). */
  readonly step: number;
  /** Advance inside a reused object (Tc/Tw/Tz) and in a new object. */
  readonly spaced: number;
  readonly plain: number;
  /** Glyph box relative to the origin (original font only). */
  readonly box?: Rect;
}

interface Segment {
  /** Index in `layout.lines`. */
  readonly line: number;
  readonly style: string;
  /** Bundled face key of a substitute segment. */
  readonly face?: string;
  readonly glyphs: readonly PlannedGlyph[];
}

type Fate =
  | { readonly kind: 'kept' }
  | { readonly kind: 'reused'; readonly dy: number }
  | { readonly kind: 'rewritten' };

interface Placement {
  readonly segment: Segment;
  /** The original object reused as the segment's container (page object index). */
  readonly container?: number;
  /** The object whose style, font and marks a new object copies. */
  readonly template: number;
  /** Rewritten line ordinal (for the insertion order). */
  readonly ordinal: number;
}

interface WritePlan {
  readonly fates: readonly Fate[];
  readonly placements: readonly Placement[];
  /** Objects removed (replaced lines left without text). */
  readonly removed: readonly number[];
  /** Objects moved and their shift (reused lines). */
  readonly moved: ReadonlyMap<number, Point>;
  /** Planned origin of each character of `layout.text` written on a rewritten line. */
  readonly originAt: ReadonlyMap<number, Point>;
  /** Per original line its container objects in page order (rewritten lines). */
  readonly containers: readonly (readonly number[])[];
}

function plus(p: Point, q: Point): Point {
  return { x: p.x + q.x, y: p.y + q.y };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function unionRect(rects: readonly Rect[]): Rect {
  const solid = rects.filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y));
  if (solid.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x0 = Math.min(...solid.map((r) => r.x));
  const y0 = Math.min(...solid.map((r) => r.y));
  const x1 = Math.max(...solid.map((r) => r.x + r.width));
  const y1 = Math.max(...solid.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function expand(rect: Rect, by: number): Rect {
  return {
    x: rect.x - by,
    y: rect.y - by,
    width: rect.width + 2 * by,
    height: rect.height + 2 * by,
  };
}

/** The `LayoutEdit` of `edit` on the original text (or `invalid-range`). */
export function layoutEditOf(old: string, edit: ParagraphEdit): LayoutEdit {
  const { start, end } = edit.caretSpan;
  const inserted = edit.text.length - (old.length - (end - start));
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > old.length ||
    inserted < 0 ||
    !edit.text.startsWith(old.slice(0, start)) ||
    !edit.text.endsWith(old.slice(end))
  ) {
    throw textEditError(
      'invalid-range',
      `The paragraph text does not match the edit at ${start}..${end}`,
    );
  }
  return {
    start,
    end,
    text: edit.text.slice(start, start + inserted),
    ...(edit.style === undefined ? {} : { style: edit.style }),
  };
}

/** The overflow verdict on a layout made elsewhere (its factors already applied). */
export function classifyLayout(
  layout: ParagraphLayout,
  gapBelow: number,
  paragraphGap: number,
): OverflowDecision {
  const growth = layout.height - layout.originalHeight;
  if (layout.lineDelta <= 0 && growth <= 1e-6) return { kind: 'commit', layout };
  if (layout.wordSpacing < 1 || layout.leading < 1) {
    const reduction = Math.max(1 - layout.wordSpacing, 1 - layout.leading);
    return {
      kind: 'tighten',
      layout,
      wordSpacing: layout.wordSpacing,
      leading: layout.leading,
      percent: Math.max(1, Math.round(reduction * 100)),
      growth,
    };
  }
  const room = Math.max(0, gapBelow - paragraphGap);
  if (growth <= room + 1e-6) return { kind: 'grow', layout, growth };
  return {
    kind: 'overflow',
    layout,
    growth,
    excess: growth - room,
    overlap: Math.max(0, growth - gapBelow),
  };
}

/** The glyphs of a rewritten line, cut into segments (see the module comment). */
function planLine(
  prepared: PreparedParagraph,
  layout: ParagraphLayout,
  lineIndex: number,
  originAt: Map<number, Point>,
): Segment[] {
  const { model, metrics } = prepared;
  const line = layout.lines[lineIndex] as LayoutLine;
  const top = model.block.lines[0]?.baseline ?? 0;
  const baseline = top - line.y;
  const segments: Segment[] = [];
  let current: { style: string; face?: string; glyphs: PlannedGlyph[] } | undefined;
  const close = () => {
    if (current && current.glyphs.length > 0) segments.push({ line: lineIndex, ...current });
    current = undefined;
  };
  const glyphFor = (style: string, ch: string, face: string | undefined) => {
    const m = metrics.get(style);
    if (!m) throw textEditError('verification-failed', `No metrics for style ${style}`);
    if (face !== undefined) {
      const width = m.substitute.advances.get(ch);
      if (width === undefined) throw paragraphRefusalError('unsupported-chars', ch);
      return { code: 0, spaced: width, plain: width };
    }
    const c = m.chars.get(ch);
    if (!c) throw paragraphRefusalError('unsupported-chars', ch);
    return { code: c.code, spaced: c.spaced, plain: c.plain, box: c.box };
  };
  for (const run of line.runs) {
    close();
    current = {
      style: run.style,
      ...(run.font === undefined ? {} : { face: run.font }),
      glyphs: [],
    };
    let x = run.x;
    let offset = run.start;
    const chars = Array.from(run.text);
    chars.forEach((ch, k) => {
      const kern = run.kerning[k] ?? 0;
      const g = glyphFor(run.style, ch, run.font);
      const origin = userPoint(model.u, x, baseline);
      const step = g.spaced + kern;
      current?.glyphs.push({ text: ch, offset, origin, step, ...g });
      originAt.set(offset, origin);
      x += step;
      offset += ch.length;
      // A displacement after this glyph: the next one starts a new segment.
      if (Math.abs(kern) > SPLIT_EPSILON && k < chars.length - 1) {
        const style = current?.style ?? run.style;
        close();
        current = { style, ...(run.font === undefined ? {} : { face: run.font }), glyphs: [] };
      }
    });
  }
  close();
  if (line.hyphen) {
    const style = line.hyphen.style;
    const g = glyphFor(style, '-', undefined);
    const glyph: PlannedGlyph = {
      text: '-',
      offset: -1,
      origin: userPoint(model.u, line.hyphen.x, baseline),
      step: g.spaced,
      ...g,
    };
    const last = segments[segments.length - 1];
    const prev = last?.glyphs[last.glyphs.length - 1];
    if (
      last &&
      prev &&
      last.style === style &&
      last.face === undefined &&
      distance(plus(prev.origin, scaleVec(model.u, prev.step)), glyph.origin) <= SPLIT_EPSILON
    ) {
      segments[segments.length - 1] = { ...last, glyphs: [...last.glyphs, glyph] };
    } else {
      segments.push({ line: lineIndex, style, glyphs: [glyph] });
    }
  }
  return segments;
}

function scaleVec(u: Point, d: number): Point {
  return { x: u.x * d, y: u.y * d };
}

/** Line fates, segments, containers, removals and moves (see the module comment). */
function planWrite(prepared: PreparedParagraph, layout: ParagraphLayout): WritePlan {
  const { model } = prepared;
  const count = model.block.lines.length;
  const fates: Fate[] = Array.from({ length: count }, () => ({ kind: 'rewritten' as const }));
  layout.lines.forEach((line) => {
    if (line.source === undefined) return;
    if (line.status === 'kept') fates[line.source] = { kind: 'kept' };
    else if (line.status === 'reused') fates[line.source] = { kind: 'reused', dy: line.dy };
  });

  // Every object has one fate; one the edit changes must not draw text the edit keeps.
  const objectFate = new Map<number, Fate>();
  model.lineObjects.forEach((objects, li) => {
    const fate = fates[li] ?? { kind: 'rewritten' };
    for (const object of objects) {
      const known = objectFate.get(object);
      if (known) {
        const same =
          known.kind === fate.kind &&
          (known.kind !== 'reused' || (fate.kind === 'reused' && known.dy === fate.dy));
        if (!same) throw paragraphRefusalError('shared-object', `object ${object} spans lines`);
      }
      objectFate.set(object, fate);
      if (fate.kind !== 'kept' && model.sharedObjects.has(object)) {
        throw paragraphRefusalError('shared-object', `object ${object} draws another paragraph`);
      }
    }
  });

  const moved = new Map<number, Point>();
  for (const [object, fate] of objectFate) {
    if (fate.kind === 'reused' && Math.abs(fate.dy) > 1e-9) {
      moved.set(object, scaleVec(model.n, -fate.dy));
    }
  }

  const replaced = fates.flatMap((f, li) => (f.kind === 'rewritten' ? [li] : []));
  const rewritten = layout.lines.flatMap((l, i) => (l.status === 'rewritten' ? [i] : []));
  const originAt = new Map<number, Point>();
  const placements: Placement[] = [];
  const used = new Set<number>();
  const containers: number[][] = [];
  const firstOfStyle = new Map<string, number>();
  for (const [object, style] of [...model.objectStyle].sort((a, b) => a[0] - b[0])) {
    if (!firstOfStyle.has(style)) firstOfStyle.set(style, object);
  }
  rewritten.forEach((lineIndex, ordinal) => {
    const source = replaced[ordinal];
    const pool =
      source === undefined ? [] : (model.lineObjects[source] ?? []).filter((o) => !used.has(o));
    containers.push(pool);
    let next = 0;
    for (const segment of planLine(prepared, layout, lineIndex, originAt)) {
      const template = firstOfStyle.get(segment.style);
      if (template === undefined) {
        throw textEditError('verification-failed', `No object has style ${segment.style}`);
      }
      let container: number | undefined;
      if (segment.face === undefined) {
        for (let k = next; k < pool.length; k++) {
          const candidate = pool[k] as number;
          if (model.objectStyle.get(candidate) === segment.style) {
            container = candidate;
            next = k + 1;
            used.add(candidate);
            break;
          }
        }
      }
      placements.push({
        segment,
        template: container ?? template,
        ordinal,
        ...(container === undefined ? {} : { container }),
      });
    }
  });
  const removed: number[] = [];
  for (const li of replaced) {
    for (const object of model.lineObjects[li] ?? []) {
      if (!used.has(object) && !removed.includes(object)) removed.push(object);
    }
  }
  return { fates, placements, removed, moved, originAt, containers };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function geometryOf(raw: RawText, pagePtr: number): PageGeometry {
  const box = raw.pageBox(pagePtr);
  return {
    quarterTurns: (raw.m.FPDFPage_GetRotation(pagePtr) & 3) as 0 | 1 | 2 | 3,
    displayWidth: raw.m.FPDF_GetPageWidthF(pagePtr),
    displayHeight: raw.m.FPDF_GetPageHeightF(pagePtr),
    originX: box.x,
    originY: box.y,
  };
}

/** Device pixel rectangle of a user-space rect at `scale` (outward rounded). */
function devicePixels(
  g: PageGeometry,
  rect: Rect,
  scale: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const d = userToDeviceRect(g, rect);
  return {
    x0: Math.floor(d.origin.x * scale),
    y0: Math.floor(d.origin.y * scale),
    x1: Math.ceil((d.origin.x + d.size.width) * scale),
    y1: Math.ceil((d.origin.y + d.size.height) * scale),
  };
}

/**
 * The page (or `clip`, user space) rendered at `scale` as `renderPage` orients it (the
 * page's /Rotate applied), on white, RGBA.
 */
export function renderArea(
  raw: RawText,
  pagePtr: number,
  scale: number,
  clip?: Rect,
  annotations = false,
): RgbaImage {
  const { m, mem } = raw;
  const g = geometryOf(raw, pagePtr);
  const full = {
    x0: 0,
    y0: 0,
    x1: Math.round(g.displayWidth * scale),
    y1: Math.round(g.displayHeight * scale),
  };
  const area = clip ? devicePixels(g, clip, scale) : full;
  const width = Math.max(1, area.x1 - area.x0);
  const height = Math.max(1, area.y1 - area.y0);
  const stride = width * 4;
  const buffer = mem.malloc(stride * height);
  let bitmap = 0;
  try {
    bitmap = m.FPDFBitmap_CreateEx(width, height, 4, buffer, stride);
    if (!bitmap) throw new Error('FPDFBitmap_CreateEx failed');
    m.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
    m.FPDF_RenderPageBitmap(
      bitmap,
      pagePtr,
      -area.x0,
      -area.y0,
      full.x1,
      full.y1,
      0,
      RENDER_RGBA | (annotations ? RENDER_ANNOT : 0),
    );
    const data = new Uint8ClampedArray(stride * height);
    data.set(mem.readBytes(buffer, stride * height));
    return { width, height, data };
  } finally {
    if (bitmap) m.FPDFBitmap_Destroy(bitmap);
    mem.free(buffer);
  }
}

/** Pixels that differ between two full-page renderings outside `allowed` (user space). */
function changedOutside(
  raw: RawText,
  pagePtr: number,
  before: RgbaImage,
  after: RgbaImage,
  allowed: Rect,
): number {
  if (before.width !== after.width || before.height !== after.height) {
    return before.width * before.height;
  }
  const d = devicePixels(geometryOf(raw, pagePtr), allowed, PIXEL_SCALE);
  let changed = 0;
  const { width, height } = before;
  for (let y = 0; y < height; y++) {
    const insideRow = y >= d.y0 && y < d.y1;
    for (let x = 0; x < width; x++) {
      if (insideRow && x >= d.x0 && x < d.x1) continue;
      const i = (y * width + x) * 4;
      if (
        before.data[i] !== after.data[i] ||
        before.data[i + 1] !== after.data[i + 1] ||
        before.data[i + 2] !== after.data[i + 2]
      ) {
        changed++;
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

interface PageAnnotation {
  readonly index: number;
  readonly subtype: ParagraphMovedAnnotation['subtype'];
  readonly rect: Rect;
  readonly quads: readonly (readonly number[])[];
  readonly id?: string;
}

/** FS_RECTF (`left, top, right, bottom`) at `p`. */
function readRectF(raw: RawText, p: number): Rect {
  const { mem } = raw;
  const left = mem.f32(p);
  const top = mem.f32(p + 4);
  const right = mem.f32(p + 8);
  const bottom = mem.f32(p + 12);
  return {
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    width: Math.abs(right - left),
    height: Math.abs(top - bottom),
  };
}

function readAnnotations(raw: RawText, pagePtr: number): PageAnnotation[] {
  const { m, mem } = raw;
  const out: PageAnnotation[] = [];
  const count = m.FPDFPage_GetAnnotCount(pagePtr);
  for (let index = 0; index < count; index++) {
    const annot = m.FPDFPage_GetAnnot(pagePtr, index);
    if (!annot) continue;
    try {
      const subtype = ANNOT_SUBTYPES[m.FPDFAnnot_GetSubtype(annot)];
      if (!subtype) continue;
      const rect = mem.withMem(16, (p) =>
        m.FPDFAnnot_GetRect(annot, p) ? readRectF(raw, p) : undefined,
      );
      if (!rect) continue;
      const quads: number[][] = [];
      const quadCount = m.FPDFAnnot_HasAttachmentPoints(annot)
        ? m.FPDFAnnot_CountAttachmentPoints(annot)
        : 0;
      for (let k = 0; k < quadCount; k++) {
        const quad = mem.withMem(32, (p) =>
          m.FPDFAnnot_GetAttachmentPoints(annot, k, p)
            ? Array.from({ length: 8 }, (_, j) => mem.f32(p + 4 * j))
            : undefined,
        );
        if (quad) quads.push(quad);
      }
      const id = mem.readUtf16Result((buf, len) =>
        m.FPDFAnnot_GetStringValue(annot, 'NM', buf, len),
      );
      out.push({ index, subtype, rect, quads, ...(id ? { id } : {}) });
    } finally {
      m.FPDFPage_CloseAnnot(annot);
    }
  }
  return out;
}

interface AnnotationMove {
  readonly annotation: PageAnnotation;
  readonly shift: Point;
}

/** Annotations whose centre lies on a word that moves, and how far (see the module comment). */
function annotationMoves(
  prepared: PreparedParagraph,
  plan: WritePlan,
  edit: { readonly start: number; readonly end: number; readonly delta: number },
  annotations: readonly PageAnnotation[],
): AnnotationMove[] {
  const { model } = prepared;
  interface Word {
    readonly line: number;
    readonly start: number;
    readonly end: number;
    readonly origin: Point;
    readonly box: Rect;
  }
  const words: Word[] = [];
  let current:
    | { line: number; start: number; end: number; origin: Point; boxes: Rect[] }
    | undefined;
  const flush = () => {
    if (current) words.push({ ...current, box: unionRect(current.boxes) });
    current = undefined;
  };
  for (const c of model.chars) {
    if (/\s/u.test(c.text) || c.offset < 0 || (current && current.line !== c.line)) {
      flush();
      if (/\s/u.test(c.text) || c.offset < 0) continue;
    }
    if (current && c.offset !== current.end) flush();
    current ??= { line: c.line, start: c.offset, end: c.offset, origin: c.origin, boxes: [] };
    current.end = c.offset + c.text.length;
    current.boxes.push(c.box);
  }
  flush();
  const out: AnnotationMove[] = [];
  for (const annotation of annotations) {
    const q = annotation.quads[0];
    const center = q
      ? {
          x: ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4,
          y: ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4,
        }
      : {
          x: annotation.rect.x + annotation.rect.width / 2,
          y: annotation.rect.y + annotation.rect.height / 2,
        };
    const word = words.find((w) => {
      const b = expand(w.box, 1);
      return (
        center.x >= b.x &&
        center.x <= b.x + b.width &&
        center.y >= b.y &&
        center.y <= b.y + b.height
      );
    });
    if (!word) continue;
    const fate = plan.fates[word.line];
    let shift: Point | undefined;
    if (fate?.kind === 'reused') shift = scaleVec(model.n, -fate.dy);
    else if (fate?.kind === 'rewritten') {
      const at =
        word.end <= edit.start
          ? word.start
          : word.start >= edit.end
            ? word.start + edit.delta
            : undefined;
      const target = at === undefined ? undefined : plan.originAt.get(at);
      if (target) shift = { x: target.x - word.origin.x, y: target.y - word.origin.y };
    }
    if (shift && Math.hypot(shift.x, shift.y) > SPLIT_EPSILON) out.push({ annotation, shift });
  }
  return out;
}

function shiftedRect(rect: Rect, shift: Point): Rect {
  return { ...rect, x: rect.x + shift.x, y: rect.y + shift.y };
}

function applyAnnotationMoves(
  raw: RawText,
  pagePtr: number,
  moves: readonly AnnotationMove[],
): void {
  const { m, mem } = raw;
  for (const { annotation, shift } of moves) {
    const annot = m.FPDFPage_GetAnnot(pagePtr, annotation.index);
    if (!annot) continue;
    try {
      const r = shiftedRect(annotation.rect, shift);
      mem.withMem(16, (p) => {
        const f32 = mem.heap().HEAPF32;
        f32.set([r.x, r.y + r.height, r.x + r.width, r.y], p >> 2);
        m.FPDFAnnot_SetRect(annot, p);
      });
      annotation.quads.forEach((quad, k) => {
        mem.withMem(32, (p) => {
          const f32 = mem.heap().HEAPF32;
          f32.set(
            quad.map((v, j) => v + (j % 2 === 0 ? shift.x : shift.y)),
            p >> 2,
          );
          m.FPDFAnnot_SetAttachmentPoints(annot, k, p);
        });
      });
    } finally {
      m.FPDFPage_CloseAnnot(annot);
    }
  }
}

// ---------------------------------------------------------------------------
// The scratch copy (dry runs)
// ---------------------------------------------------------------------------

/** A private copy of one page of the source, with a `RawAccess` onto it. */
function openScratch(access: RawAccess, pageIndex: number): { access: RawAccess; close(): void } {
  const m = access.module;
  const docPtr = m.FPDF_CreateNewDocument();
  if (!docPtr) throw new Error('FPDF_CreateNewDocument failed');
  const imported = access.memory.withMem(4, (ptr) => {
    access.memory.heap().HEAP32[ptr >> 2] = pageIndex;
    return m.FPDF_ImportPagesByIndex(docPtr, access.docPtr, ptr, 1, 0);
  });
  if (!imported) {
    m.FPDF_CloseDocument(docPtr);
    throw new Error('FPDF_ImportPagesByIndex failed');
  }
  let page = 0;
  const closePage = () => {
    if (page) m.FPDF_ClosePage(page);
    page = 0;
  };
  const doc: RawDocContext = {
    docPtr,
    acquirePage(): RawPageContext {
      if (!page) page = m.FPDF_LoadPage(docPtr, 0);
      if (!page) throw new Error('FPDF_LoadPage failed on the scratch copy');
      const pagePtr = page;
      return {
        pagePtr,
        getTextPage: () => {
          throw new Error('The scratch copy has no cached text page');
        },
        release: () => undefined,
        disposeImmediate: closePage,
      };
    },
  };
  return {
    access: {
      module: m,
      memory: access.memory,
      native: access.native,
      sourceId: `${access.sourceId}#scratch`,
      doc,
      docPtr,
      dropPageCache: closePage,
    },
    close: () => {
      closePage();
      m.FPDF_CloseDocument(docPtr);
    },
  };
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

interface Written {
  readonly obj: number;
  readonly placement: Placement;
  /** Created by the edit (not a reused container). */
  readonly created: boolean;
}

interface Outcome {
  readonly result: ParagraphEditResult;
  readonly image?: RgbaImage;
}

/** `applyParagraphEdit`, its dry run and `analyzeParagraphLayout` inside raw tasks. */
export class ParagraphWriter {
  constructor(
    private readonly faces: FaceCache,
    private readonly cache: ParagraphCache,
  ) {}

  async analyze(access: RawAccess, ref: ParagraphRef): Promise<ParagraphLayoutAnalysis> {
    const target: PageTarget = {
      access,
      pageIndex: ref.pageIndex,
      source: ref.source,
      sourcePageIndex: ref.pageIndex,
    };
    const prepared = await prepareParagraph(target, ref, analysisChars(''), this.faces, this.cache);
    return {
      ref,
      text: prepared.model.block.text,
      input: prepared.input,
      styles: prepared.infos,
      gapBelow: prepared.gapBelow,
      paragraphGap: prepared.paragraphGap,
      ...(prepared.refusal ? { refusal: prepared.refusal } : {}),
    };
  }

  /** The edit on a private copy of the page; `previewScale` also renders the paragraph area. */
  async dryRun(
    access: RawAccess,
    pageIndex: number,
    edit: ParagraphEdit,
    previewScale?: number,
  ): Promise<Outcome> {
    const scratch = openScratch(access, pageIndex);
    try {
      return await this.run(
        {
          access: scratch.access,
          pageIndex: 0,
          source: edit.ref.source,
          sourcePageIndex: pageIndex,
        },
        edit,
        false,
        previewScale,
      );
    } finally {
      scratch.close();
    }
  }

  async commit(
    access: RawAccess,
    pageIndex: number,
    edit: ParagraphEdit,
  ): Promise<ParagraphEditResult> {
    const target: PageTarget = {
      access,
      pageIndex,
      source: access.sourceId as SourceId,
      sourcePageIndex: pageIndex,
    };
    return (await this.run(target, edit, true)).result;
  }

  private async run(
    target: PageTarget,
    edit: ParagraphEdit,
    commit: boolean,
    previewScale?: number,
  ): Promise<Outcome> {
    if (edit.ref.source !== target.source || edit.ref.pageIndex !== target.sourcePageIndex) {
      throw textEditError('stale-run', 'The paragraph belongs to another page');
    }
    const { access } = target;
    const raw = new RawText(access.module, access.memory);
    const prepared = await prepareParagraph(target, edit.ref, edit.text, this.faces, this.cache);
    if (prepared.refusal) throw paragraphRefusalError(prepared.refusal);
    const { model, metrics } = prepared;
    const layoutEdit = layoutEditOf(model.block.text, edit);
    let layout: ParagraphLayout;
    let decision: OverflowDecision;
    if (edit.layout) {
      if (edit.layout.text !== edit.text) {
        throw textEditError('invalid-range', 'The layout was made for another text');
      }
      layout = edit.layout;
      decision = classifyLayout(layout, prepared.gapBelow, prepared.paragraphGap);
    } else {
      const base = layoutParagraph(prepared.input, layoutEdit);
      decision = decideOverflow(
        base,
        { input: prepared.input, edit: layoutEdit, paragraphGap: prepared.paragraphGap },
        prepared.gapBelow,
      );
      layout = decision.layout;
    }
    if (layout.unsupported.length > 0) {
      const own = new Set(model.chars.map((c) => c.text));
      const unreadable = layout.unsupported.some((c) => own.has(c));
      throw paragraphRefusalError(
        unreadable ? 'unreadable-encoding' : 'unsupported-chars',
        layout.unsupported.join(' '),
      );
    }
    const plan = planWrite(prepared, layout);

    const { m } = raw;
    const page = access.doc.acquirePage(target.pageIndex);
    const pagePtr = page.pagePtr;
    const order = raw.pageObjects(pagePtr);
    const original = [...order];
    const ptr = (index: number): number => {
      const obj = original[index];
      if (!obj || raw.objectType(obj) !== PAGEOBJ_TEXT) {
        throw textEditError(
          'stale-run',
          `No text object at ${index} on page ${target.sourcePageIndex + 1}`,
        );
      }
      return obj;
    };
    const written: Written[] = [];
    const removed: number[] = [];
    const created: number[] = [];
    const fonts: number[] = [];
    try {
      // Refusals that need the page: clips.
      this.checkClips(raw, prepared, plan, ptr);

      const before = renderArea(raw, pagePtr, PIXEL_SCALE);
      const annotations = readAnnotations(raw, pagePtr);

      // Reused lines move.
      for (const [index, shift] of plan.moved) {
        const obj = ptr(index);
        const mx = raw.matrix(obj);
        raw.setMatrix(obj, [mx[0], mx[1], mx[2], mx[3], mx[4] + shift.x, mx[5] + shift.y]);
      }

      // Substitute fonts: one subset per face for every character it sets.
      const subsetCodes = new Map<string, { font: number; codes: Map<string, number> }>();
      for (const placement of plan.placements) {
        const { face } = placement.segment;
        if (face === undefined || subsetCodes.has(face)) continue;
        const bundled = faceByKey(face);
        const style = metrics.get(placement.segment.style);
        if (!bundled || !style) throw paragraphRefusalError('unsupported-chars', face);
        const text = plan.placements
          .filter((p) => p.segment.face === face)
          .flatMap((p) => p.segment.glyphs.map((g) => g.text))
          .join('');
        const subset = buildSubset(style.substitute.font, text);
        const font = raw.loadCidType2Font(
          access.docPtr,
          subset.program,
          subset.toUnicode,
          subset.cidToGid,
        );
        if (!font) throw new Error('FPDFText_LoadCidType2Font failed');
        fonts.push(font);
        const codes = new Map<string, number>();
        Array.from(text).forEach((ch, k) => {
          if (!codes.has(ch)) codes.set(ch, subset.codes[k] ?? 0);
        });
        subsetCodes.set(face, { font, codes });
      }

      // Rewritten lines: containers in place, new objects inserted in page order: before the
      // line's next container, else after the last object written.
      const containersOf = new Map<number, number[]>();
      for (const p of plan.placements) {
        if (p.container === undefined) continue;
        const list = containersOf.get(p.ordinal) ?? [];
        list.push(ptr(p.container));
        containersOf.set(p.ordinal, list);
      }
      const done = new Set<number>();
      let lastPlaced: number | undefined;
      const firstObject = ptr(Math.min(...model.lineObjects.flat()));
      for (const placement of plan.placements) {
        const { segment } = placement;
        const codes = segment.glyphs.map((g) =>
          segment.face === undefined
            ? g.code
            : (subsetCodes.get(segment.face)?.codes.get(g.text) ?? 0),
        );
        const first = segment.glyphs[0] as PlannedGlyph;
        if (placement.container !== undefined) {
          const obj = ptr(placement.container);
          if (!raw.setCharcodes(obj, codes)) throw new Error('FPDFText_SetCharcodes failed');
          const mx = raw.matrix(obj);
          raw.setMatrix(obj, [mx[0], mx[1], mx[2], mx[3], first.origin.x, first.origin.y]);
          written.push({ obj, placement, created: false });
          done.add(obj);
          lastPlaced = obj;
          continue;
        }
        // New objects: split again where the plan does not follow the plain advances.
        const template = ptr(placement.template);
        const style = metrics.get(segment.style);
        if (!style) throw new Error(`No metrics for ${segment.style}`);
        const pieces: { glyphs: PlannedGlyph[]; codes: number[] }[] = [];
        segment.glyphs.forEach((g, k) => {
          const prev = segment.glyphs[k - 1];
          const natural = prev !== undefined && Math.abs(prev.step - prev.plain) <= SPLIT_EPSILON;
          const piece = pieces[pieces.length - 1];
          if (piece && natural) {
            piece.glyphs.push(g);
            piece.codes.push(codes[k] ?? 0);
          } else {
            pieces.push({ glyphs: [g], codes: [codes[k] ?? 0] });
          }
        });
        for (const piece of pieces) {
          const head = piece.glyphs[0] as PlannedGlyph;
          const linear = raw.matrix(template);
          let obj: number;
          let matrix: TextMatrix;
          if (segment.face !== undefined) {
            const font = subsetCodes.get(segment.face)?.font ?? 0;
            obj = raw.createCharcodes(
              access.docPtr,
              font,
              style.fontSize * style.substitute.scale,
              piece.codes,
            );
            const base: TextMatrix = [linear[0], linear[1], linear[2], linear[3], 0, 0];
            const skewed = style.substitute.italic
              ? multiply([1, 0, ITALIC_SKEW, 1, 0, 0], base)
              : base;
            matrix = [skewed[0], skewed[1], skewed[2], skewed[3], head.origin.x, head.origin.y];
          } else {
            obj = raw.createCharcodes(
              access.docPtr,
              raw.font(template),
              raw.fontSize(template),
              piece.codes,
            );
            matrix = [linear[0], linear[1], linear[2], linear[3], head.origin.x, head.origin.y];
          }
          created.push(obj);
          raw.copyStyle(template, obj);
          raw.setMatrix(obj, matrix);
          raw.applyMarks(access.docPtr, obj, raw.marks(template));
          const next = (containersOf.get(placement.ordinal) ?? []).find((o) => !done.has(o));
          const at =
            next !== undefined
              ? order.indexOf(next)
              : lastPlaced !== undefined
                ? order.indexOf(lastPlaced) + 1
                : order.indexOf(firstObject);
          if (!m.FPDFPage_InsertObjectAtIndex(pagePtr, obj, at)) {
            throw new Error('FPDFPage_InsertObjectAtIndex failed');
          }
          order.splice(at, 0, obj);
          written.push({
            obj,
            placement: { ...placement, segment: { ...segment, glyphs: piece.glyphs } },
            created: true,
          });
          lastPlaced = obj;
        }
      }

      // Objects of replaced lines left without text.
      for (const index of plan.removed) {
        const obj = ptr(index);
        if (!m.FPDFPage_RemoveObject(pagePtr, obj)) throw new Error('FPDFPage_RemoveObject failed');
        removed.push(obj);
        order.splice(order.indexOf(obj), 1);
      }

      let verification = this.verify(raw, pagePtr, prepared, plan, layout, written, ptr);
      if (verification.settle.length > 0) {
        for (const { obj, shift } of verification.settle) {
          const mx = raw.matrix(obj);
          raw.setMatrix(obj, [mx[0], mx[1], mx[2], mx[3], mx[4] - shift.x, mx[5] - shift.y]);
        }
        verification = this.verify(raw, pagePtr, prepared, plan, layout, written, ptr);
      }

      // Nothing may change outside the paragraph's old and new extent.
      const extent = unionRect([model.block.box, ...verification.boxes]);
      const allowed = expand(extent, PIXEL_MARGIN);
      const after = renderArea(raw, pagePtr, PIXEL_SCALE);
      const changedPixelsOutside = changedOutside(raw, pagePtr, before, after, allowed);
      const report: ParagraphEditVerification = {
        ...verification.report,
        changedPixelsOutside,
        objectsWritten: written.length,
        objectsMoved: plan.moved.size,
      };
      const failure =
        verification.failure ??
        (changedPixelsOutside > 0
          ? `${changedPixelsOutside} pixels changed outside the paragraph`
          : undefined);
      if (failure) throw textEditError('verification-failed', `Paragraph check failed: ${failure}`);

      const delta = layoutEdit.text.length - (layoutEdit.end - layoutEdit.start);
      const moves = annotationMoves(
        prepared,
        plan,
        { start: layoutEdit.start, end: layoutEdit.end, delta },
        annotations,
      );
      let image: RgbaImage | undefined;
      // An edit that changes nothing (the same text) writes nothing.
      const changes = plan.placements.length > 0 || plan.removed.length > 0 || plan.moved.size > 0;
      if (commit && changes) {
        applyAnnotationMoves(raw, pagePtr, moves);
        if (!m.FPDFPage_GenerateContent(pagePtr))
          throw new Error('FPDFPage_GenerateContent failed');
      } else if (previewScale !== undefined) {
        applyAnnotationMoves(raw, pagePtr, moves);
        image = renderArea(raw, pagePtr, previewScale, extent, true);
      }

      const substitutions = layout.substituted.map((s) => {
        const face = faceByKey(s.font);
        return { ...s, family: face ? familyName(face) : s.font };
      });
      const tier = substitutions.length > 0 ? 1 : 2;
      const embedded = [...metrics.values()].every((s) => s.embedded);
      const colorSpaceChanged = written.some(
        (w) => w.created && metrics.get(w.placement.segment.style)?.otherColorSpace === true,
      );
      const result: ParagraphEditResult = {
        committed: commit && changes,
        layout,
        decision,
        tier,
        honesty:
          tier === 1 ? 'font-substituted' : embedded ? 'same-font' : 'same-font-not-embedded',
        substitutions,
        moved: moves.map(({ annotation, shift }) => ({
          index: annotation.index,
          ...(annotation.id ? { id: annotation.id } : {}),
          subtype: annotation.subtype,
          from: annotation.rect,
          to: shiftedRect(annotation.rect, shift),
        })),
        ...(colorSpaceChanged ? { colorSpaceChanged: true } : {}),
        verification: report,
        box: extent,
      };
      return { result, ...(image ? { image } : {}) };
    } finally {
      // Committed: the cached page is stale. Not committed: closing it drops every change.
      access.dropPageCache(target.pageIndex);
      for (const obj of created) {
        if (!written.some((w) => w.obj === obj)) m.FPDFPageObj_Destroy(obj);
      }
      for (const obj of removed) m.FPDFPageObj_Destroy(obj);
      for (const font of fonts) m.FPDFFont_Close(font);
    }
  }

  /** Refuses (`clipped`) when a planned glyph would leave the clip it is drawn under. */
  private checkClips(
    raw: RawText,
    prepared: PreparedParagraph,
    plan: WritePlan,
    ptr: (index: number) => number,
  ): void {
    const clips = new Map<number, ClipRegion | undefined>();
    const clipOfIndex = (index: number) => {
      if (!clips.has(index)) clips.set(index, clipOf(raw, ptr(index)));
      return clips.get(index);
    };
    for (const placement of plan.placements) {
      const clip = clipOfIndex(placement.template);
      if (!clip) continue;
      const size = prepared.metrics.get(placement.segment.style)?.fontSize ?? 10;
      for (const g of placement.segment.glyphs) {
        const box = g.box
          ? {
              x: g.origin.x + g.box.x,
              y: g.origin.y + g.box.y,
              width: g.box.width,
              height: g.box.height,
            }
          : {
              x: g.origin.x,
              y: g.origin.y - 0.2 * size,
              width: Math.max(g.step, 0),
              height: 0.9 * size,
            };
        if (box.width <= 0 && box.height <= 0) continue;
        if (!clipsContain([clip], box)) throw paragraphRefusalError('clipped');
      }
    }
    for (const [index, shift] of plan.moved) {
      const clip = clipOfIndex(index);
      if (!clip) continue;
      for (const c of prepared.model.chars) {
        if (c.object !== index || c.box.width * c.box.height === 0) continue;
        if (!clipsContain([clip], shiftedRect(c.box, shift)))
          throw paragraphRefusalError('clipped');
      }
    }
  }

  /** Reads the paragraph back (see the module comment). */
  private verify(
    raw: RawText,
    pagePtr: number,
    prepared: PreparedParagraph,
    plan: WritePlan,
    layout: ParagraphLayout,
    written: readonly Written[],
    ptr: (index: number) => number,
  ): {
    report: Omit<
      ParagraphEditVerification,
      'changedPixelsOutside' | 'objectsWritten' | 'objectsMoved'
    >;
    failure?: string;
    settle: { obj: number; shift: Point }[];
    boxes: Rect[];
  } {
    const { model } = prepared;
    const keptObjects = new Map<number, number>(); // pointer → page object index
    model.lineObjects.forEach((objects, li) => {
      if (plan.fates[li]?.kind === 'rewritten') return;
      for (const index of objects) keptObjects.set(ptr(index), index);
    });
    const objects = new Set<number>([...written.map((w) => w.obj), ...keptObjects.keys()]);
    // The text page reads a line-end hyphen as U+0002.
    const chars = raw
      .withTextPage(pagePtr, (textPage) => readChars(raw, textPage, objects))
      .map((c) => (c.text === '\u0002' ? { ...c, text: '-' } : c));
    const byObject = new Map<number, ReadChar[]>();
    for (const c of chars) {
      const list = byObject.get(c.obj);
      if (list) list.push(c);
      else byObject.set(c.obj, [c]);
    }
    let maxDrift = 0;
    let maxBoxError = 0;
    let failure: string | undefined;
    const settle: { obj: number; shift: Point }[] = [];
    const boxes: Rect[] = [];
    const readOfLine = new Map<number, string[]>();
    const expectedOfLine = new Map<number, string[]>();
    const push = (map: Map<number, string[]>, line: number, text: string) => {
      const list = map.get(line);
      if (list) list.push(text);
      else map.set(line, [text]);
    };

    for (const w of written) {
      const mine = byObject.get(w.obj) ?? [];
      const { glyphs } = w.placement.segment;
      const texts = glyphs.map((g) => g.text);
      push(readOfLine, w.placement.segment.line, mine.map((c) => c.text).join(''));
      push(expectedOfLine, w.placement.segment.line, texts.join(''));
      const matched = matchGlyphs(mine, texts);
      if (!matched) {
        failure ??= `an object reads "${mine.map((c) => c.text).join('')}", planned "${texts.join('')}"`;
        continue;
      }
      let drift = 0;
      const offsets: Point[] = [];
      matched.forEach((c, k) => {
        const g = glyphs[k];
        if (!c || !g) return;
        offsets.push({ x: c.origin.x - g.origin.x, y: c.origin.y - g.origin.y });
        drift = Math.max(drift, distance(c.origin, g.origin));
        if (c.box.width > 0 || c.box.height > 0) boxes.push(c.box);
        if (g.box && (g.box.width > 0 || g.box.height > 0)) {
          const error = Math.max(
            Math.abs(c.box.x - c.origin.x - g.box.x),
            Math.abs(c.box.y - c.origin.y - g.box.y),
            Math.abs(c.box.width - g.box.width),
            Math.abs(c.box.height - g.box.height),
          );
          maxBoxError = Math.max(maxBoxError, error);
        }
      });
      if (drift > PARAGRAPH_ORIGIN_TOLERANCE && !w.created && offsets.length > 0) {
        // One vector for every glyph (a rise or a TJ lead the codes dropped): move it back.
        const v = offsets[0] as Point;
        if (offsets.every((o) => distance(o, v) <= PARAGRAPH_ORIGIN_TOLERANCE)) {
          settle.push({ obj: w.obj, shift: v });
        }
      }
      maxDrift = Math.max(maxDrift, drift);
    }

    // Kept and reused lines: every glyph where it was, or moved by its line's shift.
    for (const [obj, index] of keptObjects) {
      const shift = plan.moved.get(index) ?? { x: 0, y: 0 };
      const mine = byObject.get(obj) ?? [];
      const old = model.chars.filter((c) => c.object === index);
      const line = layout.lines.findIndex((l) => l.source === old[0]?.line);
      push(readOfLine, line, mine.map((c) => c.text).join(''));
      push(expectedOfLine, line, old.map((c) => c.text).join(''));
      const matched = matchGlyphs(
        mine,
        old.map((c) => c.text),
      );
      if (!matched) {
        failure ??= `a moved object reads "${mine.map((c) => c.text).join('')}"`;
        continue;
      }
      matched.forEach((c, k) => {
        const o = old[k];
        if (!c || !o) return;
        maxDrift = Math.max(maxDrift, distance(c.origin, plus(o.origin, shift)));
        if (plan.moved.has(index) && (c.box.width > 0 || c.box.height > 0)) boxes.push(c.box);
      });
    }

    // Chars were read with U+0002 already mapped to a hyphen.
    const normal = (s: string) => s.replace(/\s+/gu, '');
    const lines = layout.lines.map((_, i) => ({
      read: (readOfLine.get(i) ?? []).join(''),
      expected: (expectedOfLine.get(i) ?? []).join(''),
    }));
    const readback = lines.map((l) => l.read).join('\n');
    const expected = lines.map((l) => l.expected).join('\n');
    if (lines.some((l) => normal(l.read) !== normal(l.expected))) {
      failure ??= `read back "${readback}", expected "${expected}"`;
    }
    if (maxDrift > PARAGRAPH_ORIGIN_TOLERANCE) {
      failure ??= `glyphs are ${maxDrift.toFixed(3)} pt off their planned origins`;
    }
    if (maxBoxError > PARAGRAPH_BOX_TOLERANCE) {
      failure ??= `glyph boxes differ from the plan by ${maxBoxError.toFixed(3)} pt`;
    }
    // Extent of the written glyphs that have no box (spaces) does not matter for pixels.
    return {
      report: { readback, expected, maxDrift, maxBoxError },
      ...(failure ? { failure } : {}),
      settle,
      boxes,
    };
  }
}
