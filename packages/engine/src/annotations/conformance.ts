/**
 * Annotation conformance checks (docs/research/04-feature-feasibility.md §3, spec
 * viewer-annotations.md §3/§7): what an annotation needs to render the same in Acrobat,
 * Chrome, Firefox, Preview and Edge. Parses the bytes with pdf-lib; never mutates them.
 *
 * Rules, per annotation (widgets are out of scope until M3):
 * - `ap`: /AP /N is a form XObject (or a dictionary of them selected by /AS). Popups and
 *   links are exempt (their appearance is optional).
 * - `rect`: /Rect is four numbers and encloses the /N BBox after its /Matrix. The §12.5.5
 *   algorithm maps the transformed BBox onto /Rect with a translation and a scale, so
 *   "encloses" is checked up to translation: the transformed BBox is not larger than /Rect
 *   (larger means the viewer shrinks the appearance to fit).
 * - `quad-points`: text markup has /QuadPoints (8n numbers), each quad in the order
 *   upper-left, upper-right, lower-left, lower-right of the text run (top edge first, left
 *   to right in reading direction), inside /Rect.
 * - `page`: /P references the page whose /Annots holds the annotation.
 * - `nm`: /NM present (popups exempt) and unique in the document.
 * - `print`: /F has the Print flag (popups exempt).
 * - `modified`: /M present (popups exempt).
 * - `opacity`: with /CA < 1, the appearance resources hold an ExtGState whose CA/ca equals
 *   it (`/CA` alone is not honoured by all viewers).
 * - `blend`: highlight appearances use a Multiply blend mode.
 * - `popup`: a popup has /Parent (an annotation on the same page) whose /Popup is this
 *   popup; an annotation's /Popup is a popup on the same page whose /Parent is it.
 * - `font`: a FreeText /DA font resource exists in the appearance resources.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFString,
} from '@cantoo/pdf-lib';

import type {
  AnnotationConformanceProblem,
  AnnotationConformanceReport,
  AnnotationConformanceRule,
} from '../types';
import { ANNOT_FLAG } from './finalize';

export type ConformanceRule = AnnotationConformanceRule;
export type ConformanceProblem = AnnotationConformanceProblem;
export type ConformanceReport = AnnotationConformanceReport;

export interface ConformanceOptions {
  /**
   * Check only annotations with these /NM values (popups follow their parent); others are
   * counted but not judged. Default: all annotations.
   */
  readonly ids?: Iterable<string>;
  readonly password?: string;
}

const TEXT_MARKUP = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']);
const AP_EXEMPT = new Set(['Popup', 'Link']);
/** Geometry tolerance in points (coordinates are stored as 32-bit floats by PDFium). */
const EPSILON = 0.05;
const MAX_FORM_DEPTH = 4;

const N = {
  Annots: PDFName.of('Annots'),
  AP: PDFName.of('AP'),
  AS: PDFName.of('AS'),
  BBox: PDFName.of('BBox'),
  BM: PDFName.of('BM'),
  CA: PDFName.of('CA'),
  ca: PDFName.of('ca'),
  DA: PDFName.of('DA'),
  ExtGState: PDFName.of('ExtGState'),
  F: PDFName.of('F'),
  Font: PDFName.of('Font'),
  M: PDFName.of('M'),
  Matrix: PDFName.of('Matrix'),
  N: PDFName.of('N'),
  NM: PDFName.of('NM'),
  P: PDFName.of('P'),
  Parent: PDFName.of('Parent'),
  Popup: PDFName.of('Popup'),
  QuadPoints: PDFName.of('QuadPoints'),
  Rect: PDFName.of('Rect'),
  Resources: PDFName.of('Resources'),
  Subtype: PDFName.of('Subtype'),
  XObject: PDFName.of('XObject'),
};

function text(value: PDFObject | undefined): string | undefined {
  return value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : undefined;
}

function numbers(doc: PDFDocument, value: PDFObject | undefined): number[] | undefined {
  const array = doc.context.lookupMaybe(value, PDFArray);
  if (!array) return undefined;
  const out: number[] = [];
  for (let i = 0; i < array.size(); i++) {
    const n = doc.context.lookup(array.get(i));
    if (!(n instanceof PDFNumber)) return undefined;
    out.push(n.asNumber());
  }
  return out;
}

interface Box {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

function boxOf(values: number[] | undefined): Box | undefined {
  if (values?.length !== 4) return undefined;
  const [a = 0, b = 0, c = 0, d = 0] = values;
  return { x1: Math.min(a, c), y1: Math.min(b, d), x2: Math.max(a, c), y2: Math.max(b, d) };
}

function transformBox(box: Box, m: number[]): Box {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  const pts = [
    [box.x1, box.y1],
    [box.x2, box.y1],
    [box.x1, box.y2],
    [box.x2, box.y2],
  ].map(([x = 0, y = 0]) => [a * x + c * y + e, b * x + d * y + f] as const);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

/** The /N appearance stream(s) to judge: the stream, or the /AS state (else every state). */
function normalAppearances(doc: PDFDocument, annot: PDFDict): PDFRawStream[] | undefined {
  const { context } = doc;
  const ap = context.lookupMaybe(annot.get(N.AP), PDFDict);
  const normal = ap ? context.lookup(ap.get(N.N)) : undefined;
  if (normal instanceof PDFRawStream) return [normal];
  if (normal instanceof PDFDict) {
    const state = context.lookup(annot.get(N.AS));
    if (state instanceof PDFName) {
      const chosen = context.lookup(normal.get(state));
      return chosen instanceof PDFRawStream
        ? [chosen]
        : state.decodeText() === 'Off'
          ? []
          : undefined;
    }
    const all = [...normal.entries()]
      .map(([, v]) => context.lookup(v))
      .filter((v): v is PDFRawStream => v instanceof PDFRawStream);
    return all.length > 0 ? all : undefined;
  }
  return undefined;
}

/** Every ExtGState dict reachable from a form's resources (nested forms included). */
function extGStates(doc: PDFDocument, form: PDFRawStream, depth = 0, seen = new Set<object>()) {
  const { context } = doc;
  const out: PDFDict[] = [];
  if (depth > MAX_FORM_DEPTH || seen.has(form)) return out;
  seen.add(form);
  const resources = context.lookupMaybe(form.dict.get(N.Resources), PDFDict);
  const states = context.lookupMaybe(resources?.get(N.ExtGState), PDFDict);
  for (const [, value] of states?.entries() ?? []) {
    const gs = context.lookupMaybe(value, PDFDict);
    if (gs) out.push(gs);
  }
  const xobjects = context.lookupMaybe(resources?.get(N.XObject), PDFDict);
  for (const [, value] of xobjects?.entries() ?? []) {
    const inner = context.lookup(value);
    if (inner instanceof PDFRawStream) out.push(...extGStates(doc, inner, depth + 1, seen));
  }
  return out;
}

function fontNames(doc: PDFDocument, form: PDFRawStream): Set<string> {
  const { context } = doc;
  const resources = context.lookupMaybe(form.dict.get(N.Resources), PDFDict);
  const fonts = context.lookupMaybe(resources?.get(N.Font), PDFDict);
  return new Set([...(fonts?.entries() ?? [])].map(([key]) => key.decodeText()));
}

function num(doc: PDFDocument, value: PDFObject | undefined): number | undefined {
  const n = doc.context.lookup(value);
  return n instanceof PDFNumber ? n.asNumber() : undefined;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/** Problems with one quad [x1 y1 x2 y2 x3 y3 x4 y4] (UL, UR, LL, LR), or undefined. */
function quadProblem(q: number[], rect: Box | undefined): string | undefined {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0, x4 = 0, y4 = 0] = q;
  const top = [x2 - x1, y2 - y1] as const;
  const bottom = [x4 - x3, y4 - y3] as const;
  const down = [x3 - x1, y3 - y1] as const;
  // Top edge and bottom edge run the same way; LL lies clockwise from the top edge (below
  // it for horizontal text): the common reversed orders fail one of the two tests.
  if (
    top[0] * bottom[0] + top[1] * bottom[1] <= 0 ||
    cross(top[0], top[1], down[0], down[1]) >= 0
  ) {
    return `quad [${q.map((v) => Number(v.toFixed(2))).join(' ')}] is not in UL, UR, LL, LR order`;
  }
  if (
    rect &&
    [
      [x1, y1],
      [x2, y2],
      [x3, y3],
      [x4, y4],
    ].some(
      ([x = 0, y = 0]) =>
        x < rect.x1 - EPSILON ||
        x > rect.x2 + EPSILON ||
        y < rect.y1 - EPSILON ||
        y > rect.y2 + EPSILON,
    )
  ) {
    return `quad [${q.map((v) => Number(v.toFixed(2))).join(' ')}] lies outside /Rect`;
  }
  return undefined;
}

/** Checks every annotation in `bytes`. Unparseable input yields one `ap` problem. */
export async function checkAnnotationConformance(
  bytes: ArrayBuffer | Uint8Array,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: false,
      ...(options.password === undefined ? {} : { password: options.password }),
    });
  } catch (error) {
    return {
      ok: false,
      counts: [],
      problems: [
        {
          pageIndex: -1,
          index: -1,
          subtype: '',
          rule: 'ap',
          message: `not parseable: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  return checkDocument(doc, options.ids === undefined ? undefined : new Set(options.ids));
}

/** Same checks on an already parsed document. */
export function checkDocument(doc: PDFDocument, scope?: ReadonlySet<string>): ConformanceReport {
  const { context } = doc;
  const problems: ConformanceProblem[] = [];
  const counts: number[] = [];
  const nmSeen = new Map<string, number>();

  doc.getPages().forEach((page, pageIndex) => {
    const annots = context.lookupMaybe(page.node.get(N.Annots), PDFArray);
    let count = 0;
    const onPage = new Set<PDFObject>();
    for (let i = 0; annots && i < annots.size(); i++) {
      const raw = annots.get(i);
      onPage.add(raw);
      const dict = context.lookupMaybe(raw, PDFDict);
      if (dict) onPage.add(dict);
    }
    for (let index = 0; annots && index < annots.size(); index++) {
      const raw = annots.get(index);
      const annot = context.lookupMaybe(raw, PDFDict);
      if (!annot) continue;
      const subtypeObj = context.lookup(annot.get(N.Subtype));
      const subtype = subtypeObj instanceof PDFName ? subtypeObj.decodeText() : '';
      if (subtype === 'Widget') continue;
      const nm = text(context.lookup(annot.get(N.NM)));
      if (nm !== undefined) nmSeen.set(nm, (nmSeen.get(nm) ?? 0) + 1);
      if (subtype !== 'Popup') count++;

      let judged = scope === undefined || (nm !== undefined && scope.has(nm));
      if (subtype === 'Popup' && scope !== undefined) {
        const parent = context.lookupMaybe(annot.get(N.Parent), PDFDict);
        const parentNm = parent ? text(context.lookup(parent.get(N.NM))) : undefined;
        judged = parentNm !== undefined && scope.has(parentNm);
      }
      if (!judged) continue;
      const report = (rule: ConformanceRule, message: string) =>
        problems.push({
          pageIndex,
          index,
          subtype,
          ...(nm === undefined ? {} : { nm }),
          rule,
          message,
        });

      // /Rect
      const rect = boxOf(numbers(doc, annot.get(N.Rect)));
      if (!rect) report('rect', '/Rect is missing or not four numbers');

      // /AP /N and its BBox after /Matrix
      const appearances = normalAppearances(doc, annot);
      if (!AP_EXEMPT.has(subtype) && !appearances) {
        report('ap', 'no /AP /N appearance stream');
      }
      for (const form of appearances ?? []) {
        const bbox = boxOf(numbers(doc, form.dict.get(N.BBox)));
        if (!bbox) {
          report('ap', 'appearance stream has no /BBox');
          continue;
        }
        const mapped = transformBox(
          bbox,
          numbers(doc, form.dict.get(N.Matrix)) ?? [1, 0, 0, 1, 0, 0],
        );
        if (
          rect &&
          (mapped.x2 - mapped.x1 > rect.x2 - rect.x1 + EPSILON ||
            mapped.y2 - mapped.y1 > rect.y2 - rect.y1 + EPSILON)
        ) {
          report(
            'rect',
            `appearance (${(mapped.x2 - mapped.x1).toFixed(2)}x${(mapped.y2 - mapped.y1).toFixed(2)}) does not fit /Rect (${(rect.x2 - rect.x1).toFixed(2)}x${(rect.y2 - rect.y1).toFixed(2)})`,
          );
        }
      }

      // QuadPoints
      if (TEXT_MARKUP.has(subtype)) {
        const quads = numbers(doc, annot.get(N.QuadPoints));
        if (!quads || quads.length === 0 || quads.length % 8 !== 0) {
          report('quad-points', '/QuadPoints missing or not a multiple of 8 numbers');
        } else {
          for (let q = 0; q < quads.length; q += 8) {
            const problem = quadProblem(quads.slice(q, q + 8), rect);
            if (problem) report('quad-points', problem);
          }
        }
      }

      // /P
      const p = annot.get(N.P);
      if (!(p instanceof PDFRef) || p !== page.ref) {
        report('page', p === undefined ? '/P is missing' : '/P does not reference its page');
      }

      if (subtype !== 'Popup') {
        if (nm === undefined) report('nm', '/NM is missing');
        const flags = num(doc, annot.get(N.F)) ?? 0;
        if ((flags & ANNOT_FLAG.Print) === 0) report('print', '/F lacks the Print flag');
        if (text(context.lookup(annot.get(N.M))) === undefined) report('modified', '/M is missing');
      }

      // Opacity through an ExtGState
      const alpha = num(doc, annot.get(N.CA));
      const states = (appearances ?? []).flatMap((form) => extGStates(doc, form));
      if (alpha !== undefined && alpha < 1 && appearances && appearances.length > 0) {
        const matches = states.some((gs) =>
          [N.CA, N.ca].some((key) => {
            const v = num(doc, gs.get(key));
            return v !== undefined && Math.abs(v - alpha) <= 0.01;
          }),
        );
        if (!matches) {
          report('opacity', `/CA ${alpha} has no matching ExtGState CA/ca in the appearance`);
        }
      }

      // Highlight blend mode
      if (subtype === 'Highlight' && appearances && appearances.length > 0) {
        const multiply = states.some((gs) => {
          const bm = context.lookup(gs.get(N.BM));
          if (bm instanceof PDFName) return bm.decodeText() === 'Multiply';
          if (bm instanceof PDFArray) {
            return bm.asArray().some((v) => context.lookup(v) === PDFName.of('Multiply'));
          }
          return false;
        });
        if (!multiply) report('blend', 'highlight appearance does not use a Multiply blend');
      }

      // Popups, both directions
      if (subtype === 'Popup') {
        const parentRef = annot.get(N.Parent);
        const parent = context.lookupMaybe(parentRef, PDFDict);
        if (!parent) report('popup', 'popup has no /Parent');
        else if (!onPage.has(parentRef as PDFObject)) {
          report('popup', 'popup /Parent is not an annotation of the same page');
        } else if (parent.get(N.Popup) !== raw) {
          report('popup', 'popup /Parent does not point back through /Popup');
        }
      } else if (annot.has(N.Popup)) {
        const popupRef = annot.get(N.Popup);
        const popup = context.lookupMaybe(popupRef, PDFDict);
        if (!popup || !onPage.has(popupRef as PDFObject)) {
          report('popup', '/Popup is not an annotation of the same page');
        } else if (popup.get(N.Parent) !== raw) {
          report('popup', '/Popup does not point back through /Parent');
        }
      }

      // FreeText /DA font resource
      if (subtype === 'FreeText') {
        const da = text(context.lookup(annot.get(N.DA))) ?? '';
        const font = /\/([^\s/]+)\s+[\d.]+\s+Tf/.exec(da)?.[1];
        if (font === undefined) report('font', '/DA has no font');
        else if (!(appearances ?? []).some((form) => fontNames(doc, form).has(font))) {
          report('font', `/DA font /${font} is not in the appearance resources`);
        }
      }
    }
    counts.push(count);
  });

  for (const [nm, times] of nmSeen) {
    if (times > 1 && (scope === undefined || scope.has(nm))) {
      problems.push({
        pageIndex: -1,
        index: -1,
        subtype: '',
        nm,
        rule: 'nm',
        message: `/NM ${nm} is used by ${times} annotations`,
      });
    }
  }
  return { ok: problems.length === 0, counts, problems };
}

/** One-line English summaries, for verification reports. */
export function describeProblems(problems: readonly ConformanceProblem[], limit = 10): string[] {
  const lines = problems.slice(0, limit).map((p) => {
    const where = p.pageIndex < 0 ? 'Document' : `Page ${p.pageIndex + 1}`;
    const what = `${p.subtype || 'annotation'}${p.nm ? ` ${p.nm}` : ''}`;
    return `${where}: ${what}: ${p.message} (${p.rule})`;
  });
  if (problems.length > limit) lines.push(`… and ${problems.length - limit} more`);
  return lines;
}
