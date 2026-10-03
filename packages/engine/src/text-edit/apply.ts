/**
 * Applying a text edit (research 05 §3, spec §2.5, review M3/M4/m3/m4).
 *
 * The text object is split around the selected glyphs. Every kept glyph is written with its
 * ORIGINAL character code (read from the content stream, analysis.ts), never re-encoded from
 * Unicode. The original object itself keeps the longest stretch of glyphs that PDFium lays
 * out exactly where they were (`FPDFText_SetCharcodes` truncates it in place): that stretch
 * keeps everything the raw API cannot give a new object (colour space, Tc/Tw/Tz/Ts, clip
 * path, graphics state, marks). By default the stretch starts at the first glyph (the kept
 * prefix, and in tier 2 the replacement and suffix too when they follow naturally); when the
 * glyphs that would be re-created leave the object's clip, the stretch starting at the kept
 * suffix is tried instead, and when every choice leaves the clip the edit is refused
 * (`clipped`). Glyphs outside the stretch go into new objects in the same font, one per run
 * of naturally advancing glyphs, placed at their measured origins.
 *
 * Tier 2 writes the replacement with codes that read back as exactly one glyph per character
 * (tier2-codes.ts) and spaces it like the original: its advances are measured in the
 * original object (its own Tc/Tw apply), so where the replacement needs a new object it is
 * placed glyph run by glyph run at those advances. Tier 1 writes it in a fontkit subset of a
 * bundled face (`FPDFText_LoadCidType2Font`, `SetCharcodes`).
 *
 * Text in a Form XObject (drawn once; shared forms are refused by the analysis): the original
 * object moves out of the form to the page, right after the form object, with its page-space
 * matrix and clip; the form stream is rewritten without it.
 *
 * Nothing is committed before a fresh text page reads back exactly the expected text, with
 * every kept glyph at its origin with its own glyph box (a different code shows a different
 * box), the replacement where it was placed, and nothing re-created outside the clip. A
 * failed check closes the page without `GenerateContent`, which drops every object change.
 *
 * The text page folds a run of spaces on a line into its first space (and drops a space next
 * to one it generates); a kept space with no character is only counted.
 */
import type { Font } from '@cantoo/fontkit';
import type { Rect } from '@pdf-editor/document-model';

import type { RawAccess } from '../pdfium/host/hosted-engine';
import type { TextEditVerification, TextMatrix } from '../types';
import type { ObjectAnalysis } from './analysis';
import { type ClipRegion, clipOf, clipsContain, rectClip } from './clip';
import type { GlyphInfo } from './codes';
import { type FreeSpace, POSITION_TOLERANCE } from './editability';
import { buildSubset, ITALIC_SKEW } from './fonts';
import { axis, type ResolvedRun } from './locate';
import { multiply, type Point, type RawText } from './raw';

/** How far a kept glyph's box may differ from its original box, points. */
const BOX_TOLERANCE = 0.05;

const ORIGIN: Point = { x: 0, y: 0 };
const EMPTY_BOX: Rect = { x: 0, y: 0, width: 0, height: 0 };

/** `[g0, g1)`: the selected glyphs of the object (indices into `analysis.glyphs`). */
export interface GlyphSelection {
  readonly g0: number;
  readonly g1: number;
}

/** One glyph of the edited object as it will be written. */
export type Entry =
  | {
      readonly kind: 'kept';
      readonly code: number;
      readonly text: string;
      readonly glyph: GlyphInfo;
    }
  | { readonly kind: 'new'; readonly code: number; readonly text: string };

/** The glyph sequence after the edit: kept prefix, tier-2 replacement, kept suffix. */
export interface Sequence {
  readonly entries: readonly Entry[];
  /** Index of the first replacement entry (tier 2), or where tier 1's replacement goes. */
  readonly replacementAt: number;
  /** Index of the first kept suffix entry (`entries.length` when there is none). */
  readonly suffixAt: number;
}

/** The sequence of an edit; tier 2 passes the replacement's codes and what each reads as. */
export function sequenceOf(
  analysis: ObjectAnalysis,
  selection: GlyphSelection,
  replacementCodes: readonly number[] = [],
  replacementTexts: readonly string[] = [],
): Sequence {
  const kept = (glyph: GlyphInfo): Entry => ({
    kind: 'kept',
    code: glyph.code,
    text: glyph.text,
    glyph,
  });
  const prefix = analysis.glyphs.slice(0, selection.g0).map(kept);
  const middle: Entry[] = replacementCodes.map((code, k) => ({
    kind: 'new',
    code,
    text: replacementTexts[k] ?? '',
  }));
  const suffix = analysis.glyphs.slice(selection.g1).map(kept);
  return {
    entries: [...prefix, ...middle, ...suffix],
    replacementAt: prefix.length,
    suffixAt: prefix.length + middle.length,
  };
}

/** Measured layout of a sequence's codes in the original font (see `measure`). */
export interface Metrics {
  /** Origin of the object's first glyph once its codes are replaced (page space). */
  readonly firstOrigin: Point;
  /** Advance of each entry inside the original object (its Tc/Tw/Tz applied), points. */
  readonly spaced: readonly number[];
  /** Advance of each entry in a new object of the run's size (no Tc/Tw), points. */
  readonly plain: readonly number[];
  /** Glyph box of each entry relative to its origin, in a new object. */
  readonly boxes: readonly Rect[];
}

/** What `performEdit` does. */
export interface EditPlan {
  readonly pageIndex: number;
  readonly pagePtr: number;
  readonly run: ResolvedRun;
  readonly analysis: ObjectAnalysis;
  readonly sequence: Sequence;
  readonly metrics: Metrics;
  readonly replacement: string;
  readonly tier: 1 | 2;
  /** Font size of the replacement. */
  readonly size: number;
  /** Tier 1: the bundled face, whether to skew it (synthetic italic), and its width. */
  readonly face?: { readonly font: Font; readonly italic: boolean; readonly width: number };
  readonly space: FreeSpace;
}

export interface EditOutcome {
  readonly ok: boolean;
  readonly committed: boolean;
  readonly verification: TextEditVerification;
  /** The replacement as read back (tier-2 missing-glyph report). */
  readonly replacementReadback: string;
  readonly failure?: string;
  /** The edit cannot keep the text inside its clip path. */
  readonly refusal?: 'clipped';
  /** Some glyphs are re-created in DeviceRGB although the original is painted otherwise. */
  readonly colorSpaceChanged: boolean;
}

function along(u: Point, from: Point, to: Point): number {
  return (to.x - from.x) * u.x + (to.y - from.y) * u.y;
}

function plus(p: Point, u: Point, d: number): Point {
  return { x: p.x + u.x * d, y: p.y + u.y * d };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Text without its spaces. The text page folds a run of spaces into one, drops a space
 * next to one it generated for a gap, and may drop one at the end of a line, so spaces are
 * compared per object (each kept space glyph keeps its code and position), not here.
 */
function withoutSpaces(text: string): string {
  return text.replace(/ /g, '');
}

/** Whether an entry is a kept space the text page folded (no character, no origin). */
function folded(entry: Entry | undefined): boolean {
  return entry?.kind === 'kept' && entry.glyph.origin === undefined;
}

/** A character read back from a fresh text page. */
export interface ReadChar {
  readonly text: string;
  readonly origin: Point;
  readonly box: Rect;
  readonly obj: number;
}

/** The characters of `objects` on a text page, generated spaces left out. */
export function readChars(
  raw: RawText,
  textPage: number,
  objects: ReadonlySet<number>,
): ReadChar[] {
  const out: ReadChar[] = [];
  const count = raw.charCount(textPage);
  for (let i = 0; i < count; i++) {
    const obj = raw.charObject(textPage, i);
    if (!objects.has(obj) || raw.isGenerated(textPage, i)) continue;
    out.push({
      text: raw.charText(textPage, i),
      origin: raw.charOrigin(textPage, i),
      box: raw.charBox(textPage, i),
      obj,
    });
  }
  return out;
}

/**
 * Matches `texts` (one per glyph, in order) to an object's characters; a space may be
 * folded (undefined). Undefined when they do not match.
 */
export function matchGlyphs(
  chars: readonly ReadChar[],
  texts: readonly string[],
): (ReadChar | undefined)[] | undefined {
  const out: (ReadChar | undefined)[] = [];
  let j = 0;
  for (const text of texts) {
    let k = j;
    let shown = '';
    while (k < chars.length && shown.length < text.length) {
      shown += chars[k]?.text ?? '';
      k++;
    }
    if (text.length > 0 && shown === text) {
      out.push(chars[j]);
      j = k;
    } else if (text === ' ') {
      out.push(undefined);
    } else {
      return undefined;
    }
  }
  return j === chars.length ? out : undefined;
}

/**
 * Measures how the original font lays out the sequence's codes: inside the original object
 * (its codes replaced, so its own Tc/Tw/Tz apply) and in a new object of the same font and
 * size (no spacing). Each code is drawn between two copies of a marker glyph (a kept or new
 * glyph that is not a space), so folded spaces cannot hide an advance: the advance of a code
 * is the distance between the markers around it less the marker's own advance. Changes the
 * page in memory and drops it from the cache before returning; the caller resolves the run
 * again on a clean page.
 */
export function measure(
  access: RawAccess,
  raw: RawText,
  plan: Pick<EditPlan, 'pageIndex' | 'pagePtr' | 'run' | 'analysis'>,
  sequence: Sequence,
): Metrics {
  const { info } = plan.run;
  const { m } = raw;
  const { entries } = sequence;
  let probe = 0;
  try {
    if (entries.length === 0) return { firstOrigin: ORIGIN, spaced: [], plain: [], boxes: [] };
    // Any glyph of the object that shows one character other than a space will do.
    const marker = [...entries, ...plan.analysis.glyphs].find(
      (e) => e.text !== '\0' && Array.from(e.text).length === 1 && !/\s/u.test(e.text),
    );
    if (!marker) throw new Error('No glyph to measure the edited text against');
    const textOf = new Map<number, string>([[marker.code, marker.text]]);
    for (const e of entries) if (!textOf.has(e.code)) textOf.set(e.code, e.text);
    const distinct = [...textOf.keys()]; // the marker first
    const codes = [marker.code];
    for (const code of distinct) codes.push(code, marker.code);
    const texts = codes.map((c) => textOf.get(c) ?? '');
    if (!raw.setCharcodes(info.obj, codes)) throw new Error('FPDFText_SetCharcodes failed');
    probe = raw.createCharcodes(access.docPtr, info.font, info.size, codes);
    // Away from the original: the text page drops an object drawn over an identical one.
    const [a, b, c, d, e, f] = info.pageMatrix;
    const { u } = axis(info.pageMatrix);
    const away = 3 * Math.abs(info.size) * Math.hypot(c, d) + 10;
    raw.setMatrix(probe, [a, b, c, d, e - u.y * away, f + u.x * away]);
    m.FPDFPage_InsertObject(plan.pagePtr, probe);
    const { inObject, alone } = raw.withTextPage(plan.pagePtr, (textPage) => {
      const chars = readChars(raw, textPage, new Set([info.obj, probe]));
      return {
        inObject: matchGlyphs(
          chars.filter((ch) => ch.obj === info.obj),
          texts,
        ),
        alone: matchGlyphs(
          chars.filter((ch) => ch.obj === probe),
          texts,
        ),
      };
    });
    if (!inObject || !alone) throw new Error('The measuring pass did not read back every glyph');
    /** Advance of `distinct[k]` from the markers around it (`codes[2k+1]`). */
    const advances = (list: readonly (ReadChar | undefined)[]) => {
      const at = (i: number) => list[i]?.origin ?? ORIGIN;
      const markerAdvance = along(u, at(0), at(2)) / 2;
      return new Map(
        distinct.map((code, k) => [code, along(u, at(2 * k), at(2 * k + 2)) - markerAdvance]),
      );
    };
    const spaced = advances(inObject);
    const plain = advances(alone);
    const boxes = new Map(
      distinct.map((code, k): [number, Rect] => {
        const g = alone[2 * k + 1];
        return [
          code,
          g
            ? {
                x: g.box.x - g.origin.x,
                y: g.box.y - g.origin.y,
                width: g.box.width,
                height: g.box.height,
              }
            : EMPTY_BOX,
        ];
      }),
    );
    return {
      firstOrigin: inObject[0]?.origin ?? ORIGIN,
      spaced: entries.map((e) => spaced.get(e.code) ?? 0),
      plain: entries.map((e) => plain.get(e.code) ?? 0),
      boxes: entries.map((e) => boxes.get(e.code) ?? EMPTY_BOX),
    };
  } finally {
    if (probe && m.FPDFPage_RemoveObject(plan.pagePtr, probe)) m.FPDFPageObj_Destroy(probe);
    // The original object's codes changed in memory: reload the page.
    access.dropPageCache(plan.pageIndex);
  }
}

/** Width of the tier-2 replacement at the run's size, and its part from Tc/Tw. */
export function tier2Advance(
  sequence: Sequence,
  metrics: Metrics,
): { width: number; spacing: number } {
  let width = 0;
  let spacing = 0;
  for (let i = sequence.replacementAt; i < sequence.suffixAt; i++) {
    width += metrics.spaced[i] ?? 0;
    spacing += (metrics.spaced[i] ?? 0) - (metrics.plain[i] ?? 0);
  }
  return { width, spacing };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

type Piece =
  | { readonly kind: 'original'; readonly from: number; readonly to: number }
  | { readonly kind: 'glyphs'; readonly entries: readonly number[]; readonly origin: Point }
  | { readonly kind: 'substitute' };

interface Layout {
  readonly pieces: readonly Piece[];
  /** Where every entry goes (a folded space: where it would be in the original). */
  readonly positions: readonly Point[];
  /** Page-space shift of the original object (its first glyph back on its origin). */
  readonly shift: Point;
  readonly original?: { readonly from: number; readonly to: number };
}

/** Target origins: kept glyphs where they were, the replacement from the selection start. */
function positionsOf(plan: EditPlan): Point[] {
  const { entries, replacementAt, suffixAt } = plan.sequence;
  const { u } = axis(plan.run.info.pageMatrix);
  const ratio = plan.size / plan.run.info.size;
  const { spaced, plain } = plan.metrics;
  const out: (Point | undefined)[] = [];
  let pen = plan.space.start;
  entries.forEach((entry, i) => {
    if (entry.kind === 'kept') {
      out.push(entry.glyph.origin);
      return;
    }
    out.push(pen);
    if (i >= replacementAt && i < suffixAt) {
      const p = plain[i] ?? 0;
      pen = plus(pen, u, p * ratio + ((spaced[i] ?? 0) - p));
    }
  });
  // Folded spaces: after the glyph before them, else before the glyph after them.
  for (let i = 0; i < out.length; i++) {
    const prev = out[i - 1];
    if (!out[i] && prev) out[i] = plus(prev, u, spaced[i - 1] ?? 0);
  }
  for (let i = out.length - 1; i >= 0; i--) {
    const next = out[i + 1];
    if (!out[i] && next) out[i] = plus(next, u, -(spaced[i] ?? 0));
  }
  return out.map((p) => p ?? plan.space.start);
}

/** The stretch the original object lays out on target from `start`: `[start, end)`. */
function naturalStretch(plan: EditPlan, positions: readonly Point[], start: number): number {
  const { entries, replacementAt } = plan.sequence;
  const { u } = axis(plan.run.info.pageMatrix);
  const sameSize = plan.size === plan.run.info.size;
  // Tier 1's replacement is another object: the stretch cannot run across it.
  const limit =
    plan.tier === 1 && plan.replacement.length > 0 && start < replacementAt
      ? replacementAt
      : entries.length;
  if (entries[start]?.kind === 'new' && !sameSize) return start;
  let pen = positions[start] ?? ORIGIN;
  let end = start + 1;
  for (let i = start + 1; i < limit; i++) {
    pen = plus(pen, u, plan.metrics.spaced[i - 1] ?? 0);
    const entry = entries[i];
    if (entry?.kind === 'new' && !sameSize) break;
    if (!folded(entry) && distance(pen, positions[i] ?? ORIGIN) > POSITION_TOLERANCE) break;
    end = i + 1;
  }
  return end;
}

/** New-object runs among `indices`: consecutive entries that advance naturally (no Tc/Tw). */
function glyphRuns(
  plan: EditPlan,
  positions: readonly Point[],
  indices: readonly number[],
): { entries: number[]; origin: Point }[] {
  const { u } = axis(plan.run.info.pageMatrix);
  const ratio = plan.size / plan.run.info.size;
  const { entries } = plan.sequence;
  const out: { entries: number[]; origin: Point }[] = [];
  let pen = ORIGIN;
  let prev: number | undefined;
  for (const i of indices) {
    const entry = entries[i];
    const current = out[out.length - 1];
    const adjacent =
      current !== undefined &&
      prev !== undefined &&
      prev === i - 1 &&
      entries[prev]?.kind === entry?.kind;
    if (adjacent && prev !== undefined) {
      pen = plus(pen, u, (plan.metrics.plain[prev] ?? 0) * (entry?.kind === 'new' ? ratio : 1));
    }
    if (
      current &&
      adjacent &&
      (folded(entry) || distance(pen, positions[i] ?? ORIGIN) <= POSITION_TOLERANCE)
    ) {
      current.entries.push(i);
    } else {
      pen = positions[i] ?? ORIGIN;
      out.push({ entries: [i], origin: pen });
    }
    prev = i;
  }
  return out;
}

function layoutFrom(
  plan: EditPlan,
  positions: readonly Point[],
  start: number | undefined,
): Layout {
  const { entries, replacementAt } = plan.sequence;
  const end = start === undefined ? undefined : naturalStretch(plan, positions, start);
  const original =
    start !== undefined && end !== undefined && end > start ? { from: start, to: end } : undefined;
  const pieces: Piece[] = [];
  const pending: number[] = [];
  const flush = () => {
    for (const run of glyphRuns(plan, positions, pending)) {
      pieces.push({ kind: 'glyphs', ...run });
    }
    pending.length = 0;
  };
  for (let i = 0; i <= entries.length; i++) {
    if (plan.tier === 1 && i === replacementAt && plan.replacement.length > 0) {
      flush();
      pieces.push({ kind: 'substitute' });
    }
    if (i === entries.length) break;
    if (original?.from === i) {
      flush();
      pieces.push({ kind: 'original', from: original.from, to: original.to });
      i = original.to - 1;
      continue;
    }
    pending.push(i);
  }
  flush();
  const first = original ? positions[original.from] : undefined;
  const shift = first
    ? { x: first.x - plan.metrics.firstOrigin.x, y: first.y - plan.metrics.firstOrigin.y }
    : ORIGIN;
  return { pieces, positions, shift, ...(original ? { original } : {}) };
}

// ---------------------------------------------------------------------------
// Clip (review M4)
// ---------------------------------------------------------------------------

/** The clips the object is drawn under, in page space. */
function clipRegions(raw: RawText, plan: EditPlan): ClipRegion[] {
  const { info } = plan.run;
  const form = info.place.forms[0];
  const out: ClipRegion[] = [];
  if (!form) {
    const own = clipOf(raw, info.obj);
    if (own) out.push(own);
    return out;
  }
  const toPage = plan.analysis.form?.toPage ?? raw.matrix(form);
  const own = clipOf(raw, info.obj, toPage);
  if (own) out.push(own);
  const outer = clipOf(raw, form);
  if (outer) out.push(outer);
  const bbox = plan.analysis.form?.bbox;
  if (bbox) out.push(rectClip(bbox, toPage));
  return out;
}

function inkBox(box: Rect | undefined, origin: Point): Rect {
  return box && (box.width > 0 || box.height > 0) ? box : { ...origin, width: 0, height: 0 };
}

/** Page-space boxes of the glyphs that lose the object's clip under `layout`. */
function unclippedBoxes(plan: EditPlan, layout: Layout): Rect[] {
  const inForm = plan.run.info.place.forms.length > 0;
  const ratio = plan.size / plan.run.info.size;
  const out: Rect[] = [];
  const add = (i: number) => {
    const entry = plan.sequence.entries[i];
    if (!entry || folded(entry)) return;
    if (entry.kind === 'kept') {
      out.push(inkBox(entry.glyph.box, entry.glyph.origin ?? ORIGIN));
      return;
    }
    const p = layout.positions[i] ?? ORIGIN;
    const rel = plan.metrics.boxes[i] ?? EMPTY_BOX;
    out.push(
      inkBox(
        {
          x: p.x + rel.x * ratio,
          y: p.y + rel.y * ratio,
          width: rel.width * ratio,
          height: rel.height * ratio,
        },
        p,
      ),
    );
  };
  for (const piece of layout.pieces) {
    if (piece.kind === 'glyphs') piece.entries.forEach(add);
    else if (piece.kind === 'original' && inForm) {
      for (let i = piece.from; i < piece.to; i++) add(i);
    } else if (piece.kind === 'substitute') {
      out.push(substituteBox(plan));
    }
  }
  return out;
}

/** The tier-1 replacement's extent: its width along the baseline, the line box across. */
function substituteBox(plan: EditPlan): Rect {
  const { u } = axis(plan.run.info.pageMatrix);
  const start = plan.space.start;
  const width = plan.face?.width ?? 0;
  const line = plan.run.located.lineBox;
  const across = (x: number, y: number) => -(x - start.x) * u.y + (y - start.y) * u.x;
  const acrossValues = [
    across(line.x, line.y),
    across(line.x + line.width, line.y),
    across(line.x, line.y + line.height),
    across(line.x + line.width, line.y + line.height),
  ];
  const c0 = Math.min(...acrossValues);
  const c1 = Math.max(...acrossValues);
  const corners = [
    [0, c0],
    [width, c0],
    [0, c1],
    [width, c1],
  ].map(([a = 0, c = 0]) => ({ x: start.x + a * u.x - c * u.y, y: start.y + a * u.y + c * u.x }));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, width: Math.max(...xs) - x0, height: Math.max(...ys) - y0 };
}

/** The layout to use: glyphs kept in the original object, the prefix first, inside the clip. */
function chooseLayout(raw: RawText, plan: EditPlan): { layout: Layout; clipped: boolean } {
  const positions = positionsOf(plan);
  const { entries, suffixAt } = plan.sequence;
  const starts: (number | undefined)[] = entries.length > 0 ? [0] : [undefined];
  if (suffixAt > 0 && suffixAt < entries.length) starts.push(suffixAt);
  const regions = clipRegions(raw, plan);
  const layouts = starts.map((start) => layoutFrom(plan, positions, start));
  // Layouts that keep glyphs in the original object first, in the order above.
  layouts.sort((a, b) => Number(!a.original) - Number(!b.original));
  for (const layout of layouts) {
    if (regions.length === 0) return { layout, clipped: false };
    if (unclippedBoxes(plan, layout).every((box) => clipsContain(regions, box))) {
      return { layout, clipped: false };
    }
  }
  return { layout: layouts[0] ?? layoutFrom(plan, positions, undefined), clipped: true };
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

const FILLS = new Set([0, 2, 4, 6]);
const STROKES = new Set([1, 2, 5, 6]);

function recoloured(plan: EditPlan, layout: Layout): boolean {
  if (!layout.pieces.some((p) => p.kind !== 'original')) return false;
  const plain = (space: string) => space === 'DeviceRGB' || space === 'DeviceGray';
  const mode = plan.run.info.renderMode;
  return (
    (FILLS.has(mode) && !plain(plan.analysis.fill)) ||
    (STROKES.has(mode) && !plain(plan.analysis.stroke))
  );
}

function placed(linear: TextMatrix, origin: Point): TextMatrix {
  return [linear[0], linear[1], linear[2], linear[3], origin.x, origin.y];
}

/** An object the edit writes and the entries it holds (`substitute`: tier 1's text). */
interface Written {
  readonly obj: number;
  readonly entries: readonly number[] | 'substitute';
}

/**
 * Splits the object, verifies with a fresh text page and commits (`GenerateContent` and
 * dropping the cached page) when `commit` and the check pass; otherwise closes the page
 * without regenerating (no change survives, research 05 §4).
 */
export function performEdit(
  access: RawAccess,
  raw: RawText,
  plan: EditPlan,
  commit: boolean,
): EditOutcome {
  const { run, pagePtr } = plan;
  const { info } = run;
  const { m } = raw;
  const docPtr = access.docPtr;
  const form = info.place.forms[info.place.forms.length - 1];
  const marks = form ? [] : raw.marks(info.obj);
  const written: Written[] = [];
  const created: number[] = [];
  let detached = false;
  let cidFont = 0;

  try {
    const { layout, clipped } = chooseLayout(raw, plan);
    const colorSpaceChanged = recoloured(plan, layout);
    if (clipped) {
      return {
        ok: false,
        committed: false,
        verification: { readback: '', maxDrift: Number.NaN, insideLineBox: false },
        replacementReadback: '',
        failure: 'The re-created glyphs would leave the clip path of the original text',
        refusal: 'clipped',
        colorSpaceChanged,
      };
    }

    // The original object: truncated in place (moved out of its form), or removed.
    let anchor = info.place.path[0] ?? 0;
    const original = layout.original;
    if (original) {
      const codes = plan.sequence.entries.slice(original.from, original.to).map((e) => e.code);
      if (!raw.setCharcodes(info.obj, codes)) throw new Error('FPDFText_SetCharcodes failed');
      let matrix = raw.matrix(info.obj);
      if (form) {
        const toPage = plan.analysis.form?.toPage ?? raw.matrix(form);
        matrix = multiply(matrix, toPage);
        if (!m.FPDFFormObj_RemoveObject(form, info.obj)) {
          throw new Error('FPDFFormObj_RemoveObject failed');
        }
        detached = true;
        raw.transformClipPath(info.obj, toPage);
        // Marks of the form's content (MCIDs of the form) mean nothing on the page.
        raw.removeMarks(info.obj);
        anchor += 1;
      }
      raw.setMatrix(info.obj, [
        matrix[0],
        matrix[1],
        matrix[2],
        matrix[3],
        matrix[4] + layout.shift.x,
        matrix[5] + layout.shift.y,
      ]);
    } else {
      detached = form
        ? m.FPDFFormObj_RemoveObject(form, info.obj)
        : m.FPDFPage_RemoveObject(pagePtr, info.obj);
      if (!detached) throw new Error('Removing the original text object failed');
      if (form) anchor += 1;
    }

    let at = anchor;
    const insert = (obj: number, entries: Written['entries']): void => {
      if (!m.FPDFPage_InsertObjectAtIndex(pagePtr, obj, at)) {
        throw new Error('FPDFPage_InsertObjectAtIndex failed');
      }
      at += 1;
      written.push({ obj, entries });
    };
    const style = (obj: number, matrix: TextMatrix): void => {
      raw.copyStyle(info.obj, obj);
      raw.setMatrix(obj, matrix);
      raw.applyMarks(docPtr, obj, marks);
    };
    for (const piece of layout.pieces) {
      if (piece.kind === 'original') {
        const range = Array.from({ length: piece.to - piece.from }, (_, k) => piece.from + k);
        if (form) {
          insert(info.obj, range);
          detached = false;
        } else {
          at += 1; // the original object sits here
          written.push({ obj: info.obj, entries: range });
        }
        continue;
      }
      if (piece.kind === 'substitute') {
        const face = plan.face;
        if (!face) throw new Error('Tier 1 needs a face');
        const subset = buildSubset(face.font, plan.replacement);
        cidFont = raw.loadCidType2Font(docPtr, subset.program, subset.toUnicode, subset.cidToGid);
        if (!cidFont) throw new Error('FPDFText_LoadCidType2Font failed');
        const obj = raw.createCharcodes(docPtr, cidFont, plan.size, subset.codes);
        created.push(obj);
        const linear = face.italic
          ? multiply([1, 0, ITALIC_SKEW, 1, 0, 0], info.pageMatrix)
          : info.pageMatrix;
        style(obj, placed(linear, plan.space.start));
        insert(obj, 'substitute');
        continue;
      }
      const first = plan.sequence.entries[piece.entries[0] ?? 0];
      const obj = raw.createCharcodes(
        docPtr,
        info.font,
        first?.kind === 'new' ? plan.size : info.size,
        piece.entries.map((i) => plan.sequence.entries[i]?.code ?? 0),
      );
      created.push(obj);
      style(obj, placed(info.pageMatrix, piece.origin));
      insert(obj, piece.entries);
    }

    const check = verify(raw, plan, written);
    let committed = false;
    if (check.ok && commit) {
      if (!m.FPDFPage_GenerateContent(pagePtr)) throw new Error('FPDFPage_GenerateContent failed');
      committed = true;
    }
    return { ...check, committed, colorSpaceChanged };
  } finally {
    // Committed: the cached page is stale. Not committed: closing it drops every change.
    access.dropPageCache(plan.pageIndex);
    for (const obj of created) {
      if (!written.some((w) => w.obj === obj)) m.FPDFPageObj_Destroy(obj);
    }
    if (detached) m.FPDFPageObj_Destroy(info.obj);
    if (cidFont) m.FPDFFont_Close(cidFont);
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function sameBox(glyph: GlyphInfo, c: ReadChar): boolean {
  const box = glyph.box ?? EMPTY_BOX;
  const origin = glyph.origin ?? ORIGIN;
  if (box.width * box.height === 0 && c.box.width * c.box.height === 0) return true;
  return (
    Math.abs(box.x - origin.x - (c.box.x - c.origin.x)) <= BOX_TOLERANCE &&
    Math.abs(box.y - origin.y - (c.box.y - c.origin.y)) <= BOX_TOLERANCE &&
    Math.abs(box.width - c.box.width) <= BOX_TOLERANCE &&
    Math.abs(box.height - c.box.height) <= BOX_TOLERANCE
  );
}

function verify(
  raw: RawText,
  plan: EditPlan,
  written: readonly Written[],
): Omit<EditOutcome, 'committed' | 'colorSpaceChanged'> {
  const { info } = plan.run;
  const { entries, replacementAt, suffixAt } = plan.sequence;
  const objects = new Set(written.map((w) => w.obj));
  const chars = raw.withTextPage(plan.pagePtr, (textPage) => readChars(raw, textPage, objects));
  const text = (list: readonly Entry[]) => list.map((e) => e.text).join('');
  const prefixText = withoutSpaces(text(entries.slice(0, replacementAt)));
  const suffixText = withoutSpaces(text(entries.slice(suffixAt)));
  const readback = chars.map((c) => c.text).join('');
  const shown = withoutSpaces(readback);
  const expected = withoutSpaces(
    text(entries.slice(0, replacementAt)) + plan.replacement + text(entries.slice(suffixAt)),
  );
  const replacementReadback =
    shown.startsWith(prefixText) && shown.endsWith(suffixText)
      ? shown.slice(prefixText.length, shown.length - suffixText.length)
      : shown;
  const failed = (failure: string, maxDrift = Number.NaN, insideLineBox = false) => ({
    ok: false,
    verification: { readback, maxDrift, insideLineBox },
    replacementReadback,
    failure,
  });
  if (shown !== expected) return failed(`read back "${readback}", expected "${expected}"`);

  // Per object: every kept glyph on its origin with its own box, the replacement in place.
  const positions = positionsOf(plan);
  let maxDrift = 0;
  const replacementChars: ReadChar[] = [];
  for (const w of written) {
    const mine = chars.filter((c) => c.obj === w.obj);
    const texts =
      w.entries === 'substitute'
        ? Array.from(plan.replacement)
        : w.entries.map((i) => entries[i]?.text ?? '');
    const matched = matchGlyphs(mine, texts);
    if (!matched) return failed(`an object reads "${mine.map((c) => c.text).join('')}"`);
    if (w.entries === 'substitute') {
      const first = matched[0];
      if (first) maxDrift = Math.max(maxDrift, distance(first.origin, plan.space.start));
      for (const c of matched) if (c) replacementChars.push(c);
      continue;
    }
    for (const [k, i] of w.entries.entries()) {
      const c = matched[k];
      const entry = entries[i];
      if (!c || !entry) continue;
      if (entry.kind === 'kept') {
        if (!entry.glyph.origin) continue;
        maxDrift = Math.max(maxDrift, distance(entry.glyph.origin, c.origin));
        if (!sameBox(entry.glyph, c)) return failed(`"${entry.text}" changed its glyph`, maxDrift);
      } else {
        maxDrift = Math.max(maxDrift, distance(positions[i] ?? ORIGIN, c.origin));
        replacementChars.push(c);
      }
    }
  }
  if (maxDrift > POSITION_TOLERANCE) return failed(`glyphs moved by ${maxDrift} pt`, maxDrift);

  // Glyphs outside the original object must stay inside its clip (review M4).
  const regions = clipRegions(raw, plan);
  if (regions.length > 0) {
    const inForm = info.place.forms.length > 0;
    const outside = chars.find(
      (c) => (inForm || c.obj !== info.obj) && !clipsContain(regions, inkBox(c.box, c.origin)),
    );
    if (outside) return failed(`"${outside.text}" is outside the clip path`, maxDrift);
  }
  const insideLineBox = replacementChars.every((c) => insideAllowed(plan, c.box));
  return { ok: true, verification: { readback, maxDrift, insideLineBox }, replacementReadback };
}

/** Whether `box` lies within the run's line box extended along the baseline by the free space. */
function insideAllowed(plan: EditPlan, box: Rect): boolean {
  if (box.width <= 0 && box.height <= 0) return true;
  const { u } = axis(plan.run.info.pageMatrix);
  const s = plan.space.start;
  const project = (x: number, y: number) => ({
    along: (x - s.x) * u.x + (y - s.y) * u.y,
    across: -(x - s.x) * u.y + (y - s.y) * u.x,
  });
  const corners = (r: Rect) => [
    project(r.x, r.y),
    project(r.x + r.width, r.y),
    project(r.x, r.y + r.height),
    project(r.x + r.width, r.y + r.height),
  ];
  const line = corners(plan.run.located.lineBox);
  const a0 = Math.min(0, ...line.map((p) => p.along)) - 0.5;
  const a1 = Math.max(plan.space.available, ...line.map((p) => p.along)) + 0.5;
  const c0 = Math.min(...line.map((p) => p.across)) - 1;
  const c1 = Math.max(...line.map((p) => p.across)) + 1;
  return corners(box).every(
    (p) => p.along >= a0 && p.along <= a1 && p.across >= c0 && p.across <= c1,
  );
}

/** What `performEdit` would decide about the clip and the colour space, without editing. */
export function layoutVerdict(
  raw: RawText,
  plan: EditPlan,
): { clipped: boolean; colorSpaceChanged: boolean } {
  const { layout, clipped } = chooseLayout(raw, plan);
  return { clipped, colorSpaceChanged: recoloured(plan, layout) };
}
