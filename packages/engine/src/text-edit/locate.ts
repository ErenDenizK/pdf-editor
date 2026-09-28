/**
 * Run location (spec §2.2, research 05 §6): the editable runs of a page are its text
 * objects, split per line, with glyph boxes and origins in unrotated user space, the font's
 * kind and the facts editability depends on. `resolveRun` finds a run again from its
 * `TextRunRef` and fails with `stale-run` when the page no longer matches (replay re-check).
 */
import type { Rect, SourceId } from '@pdf-editor/document-model';

import type { LocatedGlyph, LocatedRun, TextMatrix, TextRunFont, TextRunRef } from '../types';
import { textEditError } from './errors';
import { classifyFont } from './fonts';
import {
  type FontFacts,
  multiply,
  PAGEOBJ_FORM,
  PAGEOBJ_TEXT,
  type Point,
  type RawText,
} from './raw';

/** Deepest form nesting walked (page → form → form → text). */
const MAX_FORM_DEPTH = 3;

/** Where a text object sits: its path and the form objects around it (outermost first). */
export interface ObjectPlace {
  readonly path: readonly number[];
  readonly forms: readonly number[];
}

export interface CharInfo {
  readonly index: number;
  readonly text: string;
  readonly origin: Point;
  readonly box: Rect;
}

/** Everything the editor reads about one text object. */
export interface ObjectInfo {
  readonly obj: number;
  readonly place: ObjectPlace;
  readonly font: number;
  readonly facts: FontFacts;
  readonly classified: TextRunFont;
  readonly size: number;
  /** The object's matrix in page space (enclosing forms applied). */
  readonly pageMatrix: TextMatrix;
  readonly renderMode: number;
  readonly mcid: number;
  /** Every character of the object, in text-page order. */
  readonly chars: readonly CharInfo[];
  readonly vertical: boolean;
}

/** A run: `info.chars.slice(from, to)`. */
export interface ResolvedRun {
  readonly info: ObjectInfo;
  readonly from: number;
  readonly to: number;
  readonly located: LocatedRun;
}

/** Every text object of the page (forms walked up to `MAX_FORM_DEPTH`). */
export function objectTree(raw: RawText, pagePtr: number): Map<number, ObjectPlace> {
  const out = new Map<number, ObjectPlace>();
  const walk = (objects: readonly number[], path: number[], forms: number[]): void => {
    objects.forEach((obj, i) => {
      const type = raw.objectType(obj);
      if (type === PAGEOBJ_TEXT) out.set(obj, { path: [...path, i], forms });
      else if (type === PAGEOBJ_FORM && forms.length < MAX_FORM_DEPTH) {
        walk(raw.formObjects(obj), [...path, i], [...forms, obj]);
      }
    });
  };
  walk(raw.pageObjects(pagePtr), [], []);
  return out;
}

/** Unit writing direction and scale of a matrix's x axis. */
export function axis(matrix: TextMatrix): { u: Point; scale: number } {
  const scale = Math.hypot(matrix[0], matrix[1]) || 1;
  return { u: { x: matrix[0] / scale, y: matrix[1] / scale }, scale };
}

function unionOf(rects: readonly Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Union of glyph boxes, ignoring empty ones (spaces) unless nothing else is left. */
export function boxOf(chars: readonly CharInfo[]): Rect {
  const solid = chars.map((c) => c.box).filter((r) => r.width > 0 && r.height > 0);
  if (solid.length > 0) return unionOf(solid);
  if (chars.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  return unionOf(chars.map((c) => ({ x: c.origin.x, y: c.origin.y, width: 0, height: 0 })));
}

/** Reads one text object and its characters (`indices`: its text-page indices). */
export function objectInfo(
  raw: RawText,
  textPage: number,
  obj: number,
  place: ObjectPlace,
  indices: readonly number[],
): ObjectInfo {
  const font = raw.font(obj);
  const facts: FontFacts = font
    ? raw.fontFacts(font)
    : {
        baseName: '',
        familyName: '',
        embedded: false,
        flags: 0,
        weight: 0,
        italicAngle: 0,
        dataBytes: 0,
      };
  let pageMatrix = raw.matrix(obj);
  for (let k = place.forms.length - 1; k >= 0; k--) {
    pageMatrix = multiply(pageMatrix, raw.matrix(place.forms[k] ?? 0));
  }
  const chars = indices.map((index) => ({
    index,
    text: raw.charText(textPage, index),
    origin: raw.charOrigin(textPage, index),
    box: raw.charBox(textPage, index),
  }));
  return {
    obj,
    place,
    font,
    facts,
    classified: classifyFont(facts),
    size: raw.fontSize(obj),
    pageMatrix,
    renderMode: raw.renderMode(obj),
    mcid: raw.markedContentId(obj),
    chars,
    vertical: isVertical(pageMatrix, chars),
  };
}

/** Glyphs advance along the text space's y axis (vertical writing). */
function isVertical(matrix: TextMatrix, chars: readonly CharInfo[]): boolean {
  const { u } = axis(matrix);
  let along = 0;
  let across = 0;
  for (let i = 1; i < chars.length; i++) {
    const a = chars[i - 1]?.origin;
    const b = chars[i]?.origin;
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    along += Math.abs(dx * u.x + dy * u.y);
    across += Math.abs(-dx * u.y + dy * u.x);
  }
  return across > along && across > 0;
}

/** Index ranges of `info.chars` that are one line each. */
export function lineRanges(info: ObjectInfo): [number, number][] {
  if (info.chars.length === 0) return [];
  if (info.vertical) return [[0, info.chars.length]];
  const { u } = axis(info.pageMatrix);
  const lineHeight = Math.abs(info.size) * Math.hypot(info.pageMatrix[2], info.pageMatrix[3]);
  const tolerance = Math.max(0.5 * lineHeight, 0.5);
  const ranges: [number, number][] = [];
  let start = 0;
  let base = info.chars[0]?.origin ?? { x: 0, y: 0 };
  info.chars.forEach((c, i) => {
    if (i === 0) return;
    const across = -(c.origin.x - base.x) * u.y + (c.origin.y - base.y) * u.x;
    if (Math.abs(across) > tolerance) {
      ranges.push([start, i]);
      start = i;
      base = c.origin;
    }
  });
  ranges.push([start, info.chars.length]);
  return ranges;
}

/** The public view of `info.chars.slice(from, to)`. */
export function toLocatedRun(
  source: SourceId,
  pageIndex: number,
  info: ObjectInfo,
  from: number,
  to: number,
): LocatedRun {
  const chars = info.chars.slice(from, to);
  const glyphs: LocatedGlyph[] = chars.map((c) => ({
    text: c.text,
    rect: c.box,
    fontSize: info.size,
    fontName: info.facts.baseName,
    charIndex: c.index,
    origin: c.origin,
  }));
  const { u } = axis(info.pageMatrix);
  return {
    source,
    pageIndex,
    objectPath: info.place.path,
    charStart: chars[0]?.index ?? -1,
    charCount: chars.length,
    text: chars.map((c) => c.text).join(''),
    lineBox: boxOf(chars),
    glyphs,
    fontSize: info.size,
    matrix: info.pageMatrix,
    direction: u,
    font: info.classified,
    renderMode: info.renderMode,
    ...(info.mcid >= 0 ? { mcid: info.mcid } : {}),
    inForm: info.place.forms.length > 0,
    vertical: info.vertical,
  };
}

/** Text-page indices per text object (generated characters, object 0, are skipped). */
export function charsByObject(raw: RawText, textPage: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const count = raw.charCount(textPage);
  for (let i = 0; i < count; i++) {
    const obj = raw.charObject(textPage, i);
    if (!obj) continue;
    const list = out.get(obj);
    if (list) list.push(i);
    else out.set(obj, [i]);
  }
  return out;
}

/** Every run of the page, in text-page order. */
export function locatePage(
  raw: RawText,
  pagePtr: number,
  textPage: number,
  source: SourceId,
  pageIndex: number,
): LocatedRun[] {
  const tree = objectTree(raw, pagePtr);
  const runs: LocatedRun[] = [];
  for (const [obj, indices] of charsByObject(raw, textPage)) {
    const place = tree.get(obj);
    if (!place) continue;
    const info = objectInfo(raw, textPage, obj, place, indices);
    for (const [from, to] of lineRanges(info)) {
      runs.push(toLocatedRun(source, pageIndex, info, from, to));
    }
  }
  return runs.sort((a, b) => a.charStart - b.charStart);
}

/** The text object at `path`, or 0. */
function objectAt(raw: RawText, pagePtr: number, path: readonly number[]): number {
  let objects = raw.pageObjects(pagePtr);
  let obj = 0;
  for (const [depth, index] of path.entries()) {
    obj = objects[index] ?? 0;
    if (!obj) return 0;
    if (depth < path.length - 1) {
      if (raw.objectType(obj) !== PAGEOBJ_FORM) return 0;
      objects = raw.formObjects(obj);
    }
  }
  return obj && raw.objectType(obj) === PAGEOBJ_TEXT ? obj : 0;
}

function stale(ref: TextRunRef, found: string): Error {
  return textEditError(
    'stale-run',
    `Page ${ref.pageIndex + 1} changed: expected "${ref.text}" at object ${ref.objectPath.join('/')}, char ${ref.charStart}; found ${found}`,
  );
}

/** Finds the run `ref` names on the current page, or throws `stale-run`. */
export function resolveRun(
  raw: RawText,
  pagePtr: number,
  textPage: number,
  ref: TextRunRef,
): ResolvedRun {
  const obj = objectAt(raw, pagePtr, ref.objectPath);
  if (!obj) throw stale(ref, 'no text object there');
  const tree = objectTree(raw, pagePtr);
  const place = tree.get(obj) ?? { path: ref.objectPath, forms: [] };
  const indices = charsByObject(raw, textPage).get(obj) ?? [];
  const info = objectInfo(raw, textPage, obj, place, indices);
  const from = info.chars.findIndex((c) => c.index === ref.charStart);
  if (from < 0) throw stale(ref, 'no such character in the object');
  const to = from + ref.charCount;
  const text = info.chars
    .slice(from, to)
    .map((c) => c.text)
    .join('');
  if (to > info.chars.length || text !== ref.text) throw stale(ref, `"${text}"`);
  return {
    info,
    from,
    to,
    located: toLocatedRun(ref.source, ref.pageIndex, info, from, to),
  };
}
