/**
 * Everything the editor must know about a text object beyond what PDFium reports (review
 * M2, M3, m4): its original character codes, the colour spaces it is painted in, and for text
 * in a Form XObject the form's /BBox and whether the document draws the form more than once
 * (`shared-form`). Read from a snapshot of the document as PDFium holds it (content.ts);
 * nothing on the page changes. `withGlyphs` then matches the codes to the characters of the
 * text page, using what each code reads as (probe.ts); codes that do not match block the
 * edit (`unreadable-encoding`) rather than being guessed from Unicode.
 */
import type { PDFDict } from '@cantoo/pdf-lib';

import type { RawAccess } from '../pdfium/host/hosted-engine';
import type { TextMatrix } from '../types';
import {
  alignGlyphs,
  codesOf,
  type GlyphInfo,
  isIdentityType0,
  isType0,
  toUnicodeOf,
} from './codes';
import {
  formData,
  formBBox,
  formResources,
  formUseCount,
  interpret,
  loadSnapshot,
  pageContent,
  pageResources,
  savePagesBytes,
  type SpaceKind,
  type TextOp,
} from './content';
import type { ObjectInfo } from './locate';
import { PAGEOBJ_FORM, PAGEOBJ_TEXT, type RawText } from './raw';

/** Why the analysis blocks the edit. */
export type AnalysisBlocker = 'shared-form' | 'unreadable-encoding';

/** What the content stream says about the object (before its codes meet the text page). */
export interface ObjectFacts {
  /** Candidate decodings of the object's codes (usually one). */
  readonly decodings: readonly (readonly number[])[];
  readonly blocker?: AnalysisBlocker;
  /** Colour spaces the object is filled and stroked in. */
  readonly fill: SpaceKind;
  readonly stroke: SpaceKind;
  /** The font is composite (Type0); `identity` for Identity-H/V. */
  readonly type0: boolean;
  readonly identity: boolean;
  /** Type0: the font's /ToUnicode map (tier-2 code candidates). */
  readonly toUnicode?: ReadonlyMap<number, string>;
  /** Text in a form: the form's /BBox (form space) and the form object's matrix. */
  readonly form?: {
    readonly bbox?: readonly [number, number, number, number];
    readonly toPage: TextMatrix;
  };
}

export interface ObjectAnalysis extends Omit<ObjectFacts, 'decodings'> {
  /** The object's glyphs in drawing order. */
  readonly glyphs: readonly GlyphInfo[];
  /** Glyph index of each of `info.chars`. */
  readonly glyphOfChar: readonly number[];
}

/**
 * Matches the facts' codes to the object's text-page characters, using what each code reads
 * as (`textOf`, probe.ts); `unreadable-encoding` when no decoding matches.
 */
export function withGlyphs(
  info: ObjectInfo,
  facts: ObjectFacts,
  textOf: (code: number) => string | undefined,
): ObjectAnalysis {
  const { decodings, ...rest } = facts;
  for (const codes of decodings) {
    const glyphs = alignGlyphs(info.chars, codes, textOf);
    if (!glyphs) continue;
    const glyphOfChar: number[] = info.chars.map(() => -1);
    glyphs.forEach((g, k) => {
      for (let i = 0; i < g.count; i++) glyphOfChar[g.first + i] = k;
    });
    return { ...rest, glyphs, glyphOfChar };
  }
  return { ...rest, blocker: 'unreadable-encoding', glyphs: [], glyphOfChar: [] };
}

function countBefore(raw: RawText, objects: readonly number[], index: number, type: number) {
  let count = 0;
  for (let i = 0; i < index; i++) if (raw.objectType(objects[i] ?? 0) === type) count++;
  return count;
}

function blocked(blocker: AnalysisBlocker, rest: Partial<ObjectFacts> = {}): ObjectFacts {
  return {
    decodings: [],
    blocker,
    fill: 'other',
    stroke: 'other',
    type0: false,
    identity: false,
    ...rest,
  };
}

/** Reads the object's codes, colour spaces and form facts from a snapshot. */
export async function analyzeObject(
  access: RawAccess,
  raw: RawText,
  pagePtr: number,
  pageIndex: number,
  info: ObjectInfo,
): Promise<ObjectFacts> {
  const inForm = info.place.forms.length > 0;
  const bytes = savePagesBytes(
    access.module,
    access.memory,
    access.docPtr,
    inForm ? 'all' : pageIndex,
  );
  const snapshot = await loadSnapshot(bytes, inForm ? pageIndex : 0);
  const { doc } = snapshot;
  const page = doc.getPage(snapshot.pageIndex).node;
  const resources = pageResources(doc, page);
  const top = interpret(doc, pageContent(doc, page), resources);
  const pageObjects = raw.pageObjects(pagePtr);
  const topIndex = info.place.path[0] ?? 0;

  let op: TextOp | undefined;
  let form: ObjectAnalysis['form'];
  if (!inForm) {
    op = top.texts[countBefore(raw, pageObjects, topIndex, PAGEOBJ_TEXT)];
  } else {
    const use = top.forms[countBefore(raw, pageObjects, topIndex, PAGEOBJ_FORM)];
    const formObj = info.place.forms[0] ?? 0;
    const toPage = raw.matrix(formObj);
    if (!use) return blocked('unreadable-encoding');
    const bbox = formBBox(doc, use.stream);
    form = { toPage, ...(bbox ? { bbox } : {}) };
    if (!use.ref || formUseCount(doc, use.ref) > 1) {
      return blocked('shared-form', { form });
    }
    const data = formData(use.stream);
    if (!data) return blocked('unreadable-encoding', { form });
    const inner = interpret(doc, data, formResources(doc, use.stream, resources), use.state);
    const children = raw.formObjects(formObj);
    op = inner.texts[countBefore(raw, children, info.place.path[1] ?? 0, PAGEOBJ_TEXT)];
  }
  if (!op) return blocked('unreadable-encoding', form ? { form } : {});

  const font: PDFDict | undefined = op.font;
  const type0 = isType0(font);
  const toUnicode = type0 ? toUnicodeOf(doc, font) : undefined;
  const decodings = codesOf(doc, font, op.strings);
  return {
    decodings,
    ...(decodings.length === 0 ? { blocker: 'unreadable-encoding' as const } : {}),
    fill: op.fill,
    stroke: op.stroke,
    type0,
    identity: isIdentityType0(doc, font),
    ...(toUnicode ? { toUnicode } : {}),
    ...(form ? { form } : {}),
  };
}

/**
 * Characters the editor's analysis measures besides the run's own (craft spec §4.8): what a
 * Latin keyboard types (ASCII, Latin-1, Latin Extended-A, the WinAnsi punctuation). A
 * character outside them is left to the engine's check.
 */
const TYPED_CHARS: readonly string[] = (() => {
  const out: string[] = [];
  const range = (from: number, to: number) => {
    for (let cp = from; cp <= to; cp++) out.push(String.fromCodePoint(cp));
  };
  range(0x20, 0x7e);
  range(0xa0, 0xac);
  range(0xae, 0x17f);
  out.push(...Array.from('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'));
  return out;
})();

/** Characters a measured advance can be read for: one code point, printable, not a soft hyphen. */
export function measurableChar(ch: string): boolean {
  return Array.from(ch).length === 1 && ch !== '­' && !/[\p{C}]/u.test(ch);
}

/** The characters to analyse for a run: its own and `TYPED_CHARS`. */
export function analysisChars(runText: string): Set<string> {
  const out = new Set(TYPED_CHARS);
  for (const ch of runText) if (measurableChar(ch)) out.add(ch);
  return out;
}
