/**
 * Applying a text edit (research 05 §3 recipe, spec §2.5). Both tiers split the text object:
 * the kept glyphs are re-created in the original `FPDF_FONT`, one object per run of naturally
 * advancing glyphs (so TJ kerning survives), and the replacement goes in between, in the
 * original font (tier 2, `SetText`) or in a fontkit subset of a bundled face loaded with
 * `FPDFText_LoadCidType2Font` (tier 1, `SetCharcodes`). The original object is removed
 * (from its form for text in a Form XObject: the new objects live at page level).
 *
 * Nothing is committed before a fresh text page reads back exactly the expected text with
 * the kept glyphs in place (and, in tier 2, advances equal to the font's widths). A failed
 * check closes the page without `GenerateContent`, which drops every object change.
 */
import type { Font } from '@cantoo/fontkit';

import type { RawAccess } from '../pdfium/host/hosted-engine';
import type { TextEditVerification, TextMatrix } from '../types';
import { POSITION_TOLERANCE, type FreeSpace, type GlyphRange } from './editability';
import { buildSubset, ITALIC_SKEW } from './fonts';
import { axis, type CharInfo, type ResolvedRun } from './locate';
import { multiply, type Point, type RawText } from './raw';

/** What `performEdit` does. */
export interface EditPlan {
  readonly pageIndex: number;
  readonly pagePtr: number;
  readonly run: ResolvedRun;
  readonly range: GlyphRange;
  readonly replacement: string;
  readonly tier: 1 | 2;
  /** Font size of the replacement. */
  readonly size: number;
  /** Tier 1: the bundled face and whether to skew it (synthetic italic). */
  readonly face?: { readonly font: Font; readonly italic: boolean };
  readonly space: FreeSpace;
}

export interface EditOutcome {
  readonly ok: boolean;
  readonly committed: boolean;
  readonly verification: TextEditVerification;
  /** The replacement as read back (tier-2 missing-glyph report). */
  readonly replacementReadback: string;
  readonly failure?: string;
}

interface Segment {
  readonly text: string;
  readonly origin: Point;
}

/**
 * Consecutive glyphs whose origin is the previous origin plus its advance form one segment
 * (one new object): kerning, Tc/Tw and TJ gaps start a new one, so positions stay exact.
 */
function segmentsOf(raw: RawText, run: ResolvedRun, chars: readonly CharInfo[]): Segment[] {
  const { info } = run;
  const m = info.pageMatrix;
  const out: { text: string; origin: Point }[] = [];
  let prev: { end: Point } | undefined;
  for (const c of chars) {
    const w = (raw.glyphWidth(info.font, c.text, 1) ?? 0) * info.size;
    const continues =
      prev !== undefined &&
      Math.hypot(prev.end.x - c.origin.x, prev.end.y - c.origin.y) < POSITION_TOLERANCE;
    const last = out[out.length - 1];
    if (continues && last) last.text += c.text;
    else out.push({ text: c.text, origin: c.origin });
    prev = { end: { x: c.origin.x + w * m[0], y: c.origin.y + w * m[1] } };
  }
  return out;
}

function placed(linear: TextMatrix, origin: Point): TextMatrix {
  return [linear[0], linear[1], linear[2], linear[3], origin.x, origin.y];
}

/**
 * Splits the run's object, inserts the replacement, verifies with a fresh text page and
 * commits (`GenerateContent` + dropping the cached page) when `commit` and the check pass;
 * otherwise closes the page without regenerating (no change survives, research 05 §4).
 */
export function performEdit(
  access: RawAccess,
  raw: RawText,
  plan: EditPlan,
  commit: boolean,
): EditOutcome {
  const { run, range, replacement, pagePtr } = plan;
  const { info, from } = run;
  const { m } = raw;
  const docPtr = access.docPtr;
  const prefixChars = info.chars.slice(0, from + range.g0);
  const suffixChars = info.chars.slice(from + range.g1);
  const inForm = info.place.forms.length > 0;
  const marks = inForm ? [] : raw.marks(info.obj);
  const created = new Set<number>();
  let removed = false;
  let cidFont = 0;
  let committed = false;

  const style = (obj: number, matrix: TextMatrix): void => {
    raw.copyStyle(info.obj, obj);
    raw.setMatrix(obj, matrix);
    raw.applyMarks(docPtr, obj, marks);
  };
  let at = inForm ? (info.place.path[0] ?? 0) + 1 : (info.place.path[0] ?? 0);
  const insert = (obj: number): void => {
    created.add(obj);
    if (!m.FPDFPage_InsertObjectAtIndex(pagePtr, obj, at)) {
      created.delete(obj);
      m.FPDFPageObj_Destroy(obj);
      throw new Error('FPDFPage_InsertObjectAtIndex failed');
    }
    at += 1;
  };

  try {
    for (const seg of segmentsOf(raw, run, prefixChars)) {
      const obj = raw.createText(docPtr, info.font, info.size, seg.text);
      style(obj, placed(info.pageMatrix, seg.origin));
      insert(obj);
    }
    if (replacement.length > 0) {
      let obj: number;
      let linear = info.pageMatrix;
      if (plan.tier === 2) {
        obj = raw.createText(docPtr, info.font, plan.size, replacement);
      } else {
        const face = plan.face;
        if (!face) throw new Error('Tier 1 needs a face');
        const subset = buildSubset(face.font, replacement);
        cidFont = raw.loadCidType2Font(docPtr, subset.program, subset.toUnicode, subset.cidToGid);
        if (!cidFont) throw new Error('FPDFText_LoadCidType2Font failed');
        obj = raw.createCharcodes(docPtr, cidFont, plan.size, subset.codes);
        if (face.italic) linear = multiply([1, 0, ITALIC_SKEW, 1, 0, 0], info.pageMatrix);
      }
      style(obj, placed(linear, plan.space.start));
      insert(obj);
    }
    for (const seg of segmentsOf(raw, run, suffixChars)) {
      const obj = raw.createText(docPtr, info.font, info.size, seg.text);
      style(obj, placed(info.pageMatrix, seg.origin));
      insert(obj);
    }
    const form = info.place.forms[info.place.forms.length - 1];
    removed = form
      ? m.FPDFFormObj_RemoveObject(form, info.obj)
      : m.FPDFPage_RemoveObject(pagePtr, info.obj);
    if (!removed) throw new Error('Removing the original text object failed');

    const check = verify(raw, plan, created, prefixChars, suffixChars);
    if (check.ok && commit) {
      if (!m.FPDFPage_GenerateContent(pagePtr)) throw new Error('FPDFPage_GenerateContent failed');
      committed = true;
    }
    return { ...check, committed };
  } finally {
    // Committed: the cached page is stale. Not committed: closing it drops every change.
    access.dropPageCache(plan.pageIndex);
    if (removed) m.FPDFPageObj_Destroy(info.obj);
    if (cidFont) m.FPDFFont_Close(cidFont);
  }
}

interface ReadChar {
  readonly text: string;
  readonly origin: Point;
  readonly box: { x: number; y: number; width: number; height: number };
}

function verify(
  raw: RawText,
  plan: EditPlan,
  created: ReadonlySet<number>,
  prefix: readonly CharInfo[],
  suffix: readonly CharInfo[],
): Omit<EditOutcome, 'committed'> {
  const { info } = plan.run;
  const chars = raw.withTextPage(plan.pagePtr, (textPage) => {
    const out: ReadChar[] = [];
    const count = raw.charCount(textPage);
    for (let i = 0; i < count; i++) {
      if (!created.has(raw.charObject(textPage, i))) continue;
      out.push({
        text: raw.charText(textPage, i),
        origin: raw.charOrigin(textPage, i),
        box: raw.charBox(textPage, i),
      });
    }
    return out;
  });
  const readback = chars.map((c) => c.text).join('');
  const prefixText = prefix.map((c) => c.text).join('');
  const suffixText = suffix.map((c) => c.text).join('');
  const expected = prefixText + plan.replacement + suffixText;
  const replacementCount = Array.from(plan.replacement).length;
  const replacementReadback =
    readback.startsWith(prefixText) && readback.endsWith(suffixText)
      ? readback.slice(prefixText.length, readback.length - suffixText.length)
      : readback;
  const failed = (failure: string, maxDrift = Number.NaN, insideLineBox = false) => ({
    ok: false,
    verification: { readback, maxDrift, insideLineBox },
    replacementReadback,
    failure,
  });
  if (readback !== expected || chars.length !== prefix.length + replacementCount + suffix.length) {
    return failed(`read back "${readback}", expected "${expected}"`);
  }
  // Kept glyphs must not move.
  let maxDrift = 0;
  const kept = [
    ...prefix.map((c, k) => [c, chars[k]] as const),
    ...suffix.map((c, k) => [c, chars[prefix.length + replacementCount + k]] as const),
  ];
  for (const [before, after] of kept) {
    if (!after) continue;
    maxDrift = Math.max(
      maxDrift,
      Math.hypot(before.origin.x - after.origin.x, before.origin.y - after.origin.y),
    );
  }
  const repl = chars.slice(prefix.length, prefix.length + replacementCount);
  const { u, scale } = axis(info.pageMatrix);
  const first = repl[0];
  if (first) {
    maxDrift = Math.max(
      maxDrift,
      Math.hypot(first.origin.x - plan.space.start.x, first.origin.y - plan.space.start.y),
    );
  }
  if (maxDrift > POSITION_TOLERANCE) return failed(`glyphs moved by ${maxDrift} pt`, maxDrift);
  // Tier 2: advances must be the font's widths (a wrong char code shows up here).
  if (plan.tier === 2) {
    for (let k = 0; k + 1 < repl.length; k++) {
      const a = repl[k];
      const b = repl[k + 1];
      if (!a || !b) continue;
      const measured = (b.origin.x - a.origin.x) * u.x + (b.origin.y - a.origin.y) * u.y;
      const metric = (raw.glyphWidth(info.font, a.text, plan.size) ?? Number.NaN) * scale;
      if (!(Math.abs(measured - metric) < POSITION_TOLERANCE)) {
        return failed(`advance of "${a.text}" is ${measured}, the font says ${metric}`, maxDrift);
      }
    }
  }
  const insideLineBox = repl.every((c) => insideAllowed(plan, c.box));
  return { ok: true, verification: { readback, maxDrift, insideLineBox }, replacementReadback };
}

/** Whether `box` lies within the run's line box extended along the baseline by the free space. */
function insideAllowed(
  plan: EditPlan,
  box: { x: number; y: number; width: number; height: number },
): boolean {
  if (box.width <= 0 && box.height <= 0) return true;
  const { u } = axis(plan.run.info.pageMatrix);
  const s = plan.space.start;
  const project = (x: number, y: number) => ({
    along: (x - s.x) * u.x + (y - s.y) * u.y,
    across: -(x - s.x) * u.y + (y - s.y) * u.x,
  });
  const corners = (r: { x: number; y: number; width: number; height: number }) => [
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
