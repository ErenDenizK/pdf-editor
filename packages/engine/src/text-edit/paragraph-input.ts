/**
 * The paragraph editor's input (craft spec §4.2–§4.3, §4.6; ADR-0020 §3): a detected
 * `ParagraphBlock` mapped onto the rewrap's `LayoutInput`, with the measurements the layout
 * and the writer need, taken once per call on the page they will be used on.
 *
 * - **Styles.** Spans with the same font, size, linear matrix, render mode, fill and MCID are
 *   one style (`s0`, `s1`…). The first run of a style is its representative object.
 * - **Codes.** Per font, the code each character is written with comes from the tier-2 code
 *   machinery (`tier2Candidates`, probe objects, `chooseTier2Codes`), as for single-line edits:
 *   one probe pass per font. A character the font cannot take (no outline, outside WinAnsi for
 *   a standard-14 font, ambiguous codes) gets the style's bundled substitute.
 * - **Advances.** `measure` lays every chosen code out once in the style's representative
 *   object (its Tc/Tw/Tz apply: `spaced`) and in a new object (`plain`), with the glyph boxes
 *   the verification compares against; one pass per style (32-code passes when it fails).
 * - **Kerning** is harvested from the paragraph's own glyph positions: for each pair of
 *   adjacent characters inside a word, the distance between their origins minus the first
 *   one's advance; a pair that recurs keeps its most frequent value. This reads `TJ` numbers
 *   and `Td`-positioned glyphs (one object per glyph, as Chromium writes) alike.
 * - **Word gap.** The space glyph's advance when the paragraph draws spaces; otherwise
 *   (pdfTeX) the median gap between words on its lines that are not justified.
 * - **Substitutes** (craft §4.5): each character the font cannot set goes to the first bundled
 *   face, in the order `substituteCandidates` gives for the font's class (serif, monospaced or
 *   sans, from the flags, the name and the program's PANOSE) and weight, that has it. Each
 *   face is sized so its x-height matches the original's: the AFM value of a standard-14 font,
 *   else the outline of "x" (or z, v, w; the cap height of H, E, I, T without one), read only
 *   for letters the font was shown to set (factor 0.8–1.25, `substituteScale`).
 * - **Measure.** A left-aligned paragraph may extend to the right edge of its column (the
 *   furthest right edge of the blocks that share its horizontal extent): its own longest line
 *   is not where the producer wrapped. Justified, centred and right-aligned paragraphs keep
 *   theirs.
 * - **Overflow facts.** `gapBelow`: the empty space below the paragraph's ink down to the
 *   nearest block or graphic below it that overlaps it horizontally, else down to the bottom
 *   margin (taken equal to the top margin, at least 36 pt). `paragraphGap`: with a block
 *   below, the page's typical gap between vertically adjacent blocks of a column (at most
 *   `gapBelow`), so growth keeps it; 0 at the margin.
 */
import type { Font } from '@cantoo/fontkit';
import type { Rect, SourceId } from '@pdf-editor/document-model';

import type { BundledFace } from '../fonts/font-catalog';
import {
  bundledFamilyOfFont,
  CAP_HEIGHT_LETTERS,
  classFamilies,
  standardFontMetrics,
  substituteCandidates,
  substituteClass,
  substituteScale,
  X_HEIGHT_LETTERS,
} from '../fonts/substitutes';
import type { RawAccess } from '../pdfium/host/hosted-engine';
import type {
  LocatedRun,
  ParagraphBlock,
  ParagraphEditRefusal,
  ParagraphRef,
  ParagraphSpan,
  ParagraphStyleInfo,
  TextRunRef,
} from '../types';
import { analyzeObject, type ObjectAnalysis, type ObjectFacts } from './analysis';
import { type Entry, measure, type Metrics, type Sequence } from './apply';
import { analyzePageParagraphs, type ParagraphCache } from './blocks';
import { blockerOf, tier2Precheck } from './editability';
import { textEditError } from './errors';
import { type FaceCache, faceAdvance, familyName, missingInFace, readPanose } from './fonts';
import type { LayoutInput, LayoutSpan, LayoutStyle } from './linebreak';
import {
  charsByObject,
  fontIds,
  lineRanges,
  objectInfo,
  objectTree,
  type ResolvedRun,
  resolveRun,
  toLocatedRun,
} from './locate';
import { probeCodes } from './probe';
import { type Point, RawText } from './raw';
import { chooseTier2Codes, tier2Candidates } from './tier2-codes';

/** Codes measured per `measure` pass when the single pass fails (as `analyzeRun`). */
const MEASURE_CHUNK = 32;
/**
 * Kerning below this fraction of the size is noise: rounded positions, or advances the
 * producer took from the font program while the PDF's /W rounds them (Chromium).
 */
const KERN_NOISE = 0.005;
/** Smallest bottom margin assumed when the page gives no hint, points. */
const MIN_MARGIN = 36;
/** `FPDF_PAGEOBJ_*` of graphics that can sit below a paragraph. */
const PAGEOBJ_PATH = 2;
const PAGEOBJ_IMAGE = 3;
const PAGEOBJ_SHADING = 4;

/** The page an edit works on: the source's own, or a private copy (dry run). */
export interface PageTarget {
  /** Raw access to the document holding the page (the source, or the copy). */
  readonly access: RawAccess;
  /** Index of the page in that document. */
  readonly pageIndex: number;
  /** The source and page the paragraph refs name. */
  readonly source: SourceId;
  readonly sourcePageIndex: number;
}

/** A character of the original paragraph as drawn. */
export interface OldChar {
  /** Offset in `ParagraphBlock.text`; -1 for a line-end hyphen the text joins (dropped). */
  readonly offset: number;
  readonly text: string;
  readonly origin: Point;
  readonly box: Rect;
  readonly generated: boolean;
  readonly line: number;
  readonly style: string;
  /** Index of its text object among the page's objects. */
  readonly object: number;
}

/** One style of the paragraph (see the module comment). */
export interface StyleModel {
  readonly id: string;
  readonly key: string;
  readonly span: ParagraphSpan;
  /** Representative run and object (the style's first). */
  readonly run: TextRunRef;
  readonly object: number;
}

export interface ParagraphModel {
  readonly block: ParagraphBlock;
  /** Every block of the page (shared-object checks, overflow facts). */
  readonly blocks: readonly ParagraphBlock[];
  readonly styles: readonly StyleModel[];
  /** Style id of each UTF-16 unit of `block.text`. */
  readonly charStyles: readonly string[];
  /** Characters in line order, visual order inside a line. */
  readonly chars: readonly OldChar[];
  /** Per original line: its text objects (page object indices, ascending). */
  readonly lineObjects: readonly (readonly number[])[];
  /** Style id of each object of the paragraph. */
  readonly objectStyle: ReadonlyMap<number, string>;
  /** Objects some other block draws text with. */
  readonly sharedObjects: ReadonlySet<number>;
  /** Unit writing direction and its normal (text space y), unrotated user space. */
  readonly u: Point;
  readonly n: Point;
  /** Page box and graphics (bounds of path, image and shading objects), user space. */
  readonly pageBox: Rect;
  readonly graphics: readonly Rect[];
  /** Why paragraph mode is refused, when it is (found while building the model). */
  readonly refusal?: ParagraphEditRefusal;
}

/** A character's code and layout in one style. */
export interface CharMetrics {
  readonly code: number;
  /** Advance inside the style's object (Tc/Tw/Tz applied) and in a new object, points. */
  readonly spaced: number;
  readonly plain: number;
  /** Glyph box relative to its origin, page space. */
  readonly box: Rect;
}

/** A bundled face as one style uses it. */
export interface SubstituteFace {
  readonly face: BundledFace;
  readonly font: Font;
  /** Size factor matching the x-heights. */
  readonly scale: number;
}

export interface SubstituteMetrics extends SubstituteFace {
  /** Synthetic italic (the original is italic, the bundled faces are upright). */
  readonly italic: boolean;
  /** Advances of the characters the original font cannot set, points (in their face). */
  readonly advances: ReadonlyMap<string, number>;
  /** Face key of each character in `advances`. */
  readonly faceOf: ReadonlyMap<string, string>;
  /** Every face loaded for the style by key, the first candidate (`face`) included. */
  readonly faces: ReadonlyMap<string, SubstituteFace>;
  /** Keys of the faces tried, in order (the overlay's fallback chain). */
  readonly candidates: readonly string[];
  /** The original's x-height and cap height (fractions of the size) the scales match. */
  readonly heights: { readonly xHeight?: number; readonly capHeight?: number };
}

/**
 * Characters a loaded face also gets advances for beyond the ones asked for, so the overlay can
 * lay out what the user types next (a Greek or Cyrillic letter) without another analysis:
 * single code points that are letters, numbers, punctuation, symbols or spaces. Combining marks
 * need positioning the writer does not do.
 */
const EXTRA_CHAR = /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}]$/u;

export interface StyleMetrics {
  readonly chars: ReadonlyMap<string, CharMetrics>;
  readonly substitute: SubstituteMetrics;
  readonly wordGap: number;
  readonly kerning: Readonly<Record<string, number>>;
  /** Font size (Tf) of the representative object. */
  readonly fontSize: number;
  /** The object is painted in a colour space other than DeviceRGB or DeviceGray. */
  readonly otherColorSpace: boolean;
  readonly embedded: boolean;
}

export interface PreparedParagraph {
  readonly model: ParagraphModel;
  readonly metrics: ReadonlyMap<string, StyleMetrics>;
  readonly input: LayoutInput;
  readonly infos: Readonly<Record<string, ParagraphStyleInfo>>;
  readonly gapBelow: number;
  readonly paragraphGap: number;
  readonly refusal?: ParagraphEditRefusal;
}

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

function along(u: Point, from: Point, to: Point): number {
  return (to.x - from.x) * u.x + (to.y - from.y) * u.y;
}

/** Text-space extent of a user-space rect: `[x0, x1, y0, y1]`. */
export function textSpaceExtent(
  rect: Rect,
  u: Point,
): { x0: number; x1: number; y0: number; y1: number } {
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ] as const;
  const xs = corners.map(([x, y]) => x * u.x + y * u.y);
  const ys = corners.map(([x, y]) => -x * u.y + y * u.x);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** A text-space point in user space. */
export function userPoint(u: Point, x: number, y: number): Point {
  return { x: x * u.x - y * u.y, y: x * u.y + y * u.x };
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function sameRef(a: TextRunRef, b: TextRunRef): boolean {
  return (
    a.charStart === b.charStart &&
    a.charCount === b.charCount &&
    a.text === b.text &&
    a.objectPath.length === b.objectPath.length &&
    a.objectPath.every((v, i) => v === b.objectPath[i])
  );
}

/** A refusal as the error `applyParagraphEdit` fails with. */
export function paragraphRefusalError(refusal: ParagraphEditRefusal, detail = ''): Error {
  return textEditError(
    refusal === 'unsupported-chars' ? 'unsupported-chars' : 'not-editable',
    `(paragraph:${refusal}) This paragraph cannot be edited as a paragraph${detail ? `: ${detail}` : ''}`,
  );
}

const REFUSAL_PATTERN = /\(paragraph:([a-z0-9-]+)\)/;

/** The `ParagraphEditRefusal` of a failed paragraph edit (also across the worker), or undefined. */
export function paragraphRefusalReason(error: unknown): ParagraphEditRefusal | undefined {
  if (!(error instanceof Error)) return undefined;
  return REFUSAL_PATTERN.exec(error.message)?.[1] as ParagraphEditRefusal | undefined;
}

// ---------------------------------------------------------------------------
// Block and model
// ---------------------------------------------------------------------------

function styleKey(span: ParagraphSpan, mcid: number | undefined): string {
  const m = span.matrix.slice(0, 4).map((v) => v.toFixed(4));
  return [
    span.fontId ?? span.font.baseName,
    span.fontSize.toFixed(3),
    ...m,
    span.renderMode,
    (span.fill ?? []).join(','),
    mcid ?? '',
  ].join('|');
}

function runKey(ref: Pick<TextRunRef, 'objectPath' | 'charStart'>): string {
  return `${ref.objectPath.join('/')}:${ref.charStart}`;
}

/**
 * The paragraph `ref` names on the target page, every block of the page, and the located runs
 * of the paragraph's objects; fails with `stale-run` when the page no longer has it.
 */
function findBlock(
  target: PageTarget,
  raw: RawText,
  ref: ParagraphRef,
  cache: ParagraphCache | undefined,
): {
  block: ParagraphBlock;
  blocks: readonly ParagraphBlock[];
  runs: Map<string, LocatedRun>;
  generated: Set<number>;
} {
  const { access, pageIndex } = target;
  const page = access.doc.acquirePage(pageIndex);
  try {
    const blocks = analyzePageParagraphs(
      raw,
      page.pagePtr,
      target.source,
      target.sourcePageIndex,
      cache,
    );
    const block = blocks[ref.index];
    if (
      block?.ref.runs.length !== ref.runs.length ||
      !block.ref.runs.every((r, i) => {
        const other = ref.runs[i];
        return other !== undefined && sameRef(r, other);
      })
    ) {
      throw textEditError(
        'stale-run',
        `Page ${target.sourcePageIndex + 1} changed: paragraph ${ref.index + 1} is not where it was`,
      );
    }
    // Located runs of the paragraph's objects only (not the whole page).
    const generated = new Set<number>();
    const runs = raw.withTextPage(page.pagePtr, (textPage) => {
      const tree = objectTree(raw, page.pagePtr);
      const ids = fontIds(raw, tree);
      const byObject = charsByObject(raw, textPage);
      const wanted = new Set(block.ref.runs.map((r) => r.objectPath.join('/')));
      const out = new Map<string, LocatedRun>();
      for (const [obj, indices] of byObject) {
        const place = tree.get(obj);
        if (!place || !wanted.has(place.path.join('/'))) continue;
        const info = objectInfo(raw, textPage, obj, place, indices, ids);
        for (const c of info.chars) if (c.generated) generated.add(c.index);
        for (const [from, to] of lineRanges(info)) {
          const run = toLocatedRun(target.source, target.sourcePageIndex, info, from, to);
          out.set(runKey(run), run);
        }
      }
      return out;
    });
    return { block, blocks, runs, generated };
  } finally {
    page.release();
  }
}

/** The paragraph's characters, styles and objects (see `ParagraphModel`). */
function buildModel(
  raw: RawText,
  target: PageTarget,
  block: ParagraphBlock,
  blocks: readonly ParagraphBlock[],
  runs: ReadonlyMap<string, LocatedRun>,
  generated: ReadonlySet<number>,
): ParagraphModel {
  const u = block.direction;
  const n = { x: -u.y, y: u.x };
  const styles: StyleModel[] = [];
  const styleByKey = new Map<string, StyleModel>();
  const chars: OldChar[] = [];
  const lineObjects: number[][] = [];
  const objectStyle = new Map<number, string>();
  let refusal: ParagraphEditRefusal | undefined = block.refusal;

  block.lines.forEach((line, li) => {
    const objects = new Set<number>();
    const shown = line.end === 'joined' ? line.text.length - 1 : line.text.length;
    let cursor = 0;
    line.spans.forEach((span, si) => {
      const ref = block.ref.runs[span.run];
      if (!ref) return;
      if (ref.objectPath.length > 1) refusal ??= 'in-form';
      const run = runs.get(runKey(ref));
      const object = ref.objectPath[0] ?? 0;
      objects.add(object);
      const key = styleKey(span, run?.mcid);
      let style = styleByKey.get(key);
      if (!style) {
        style = { id: `s${styles.length}`, key, span, run: ref, object };
        styles.push(style);
        styleByKey.set(key, style);
      }
      objectStyle.set(object, objectStyle.get(object) ?? style.id);
      const glyphs = run?.glyphs.slice(span.glyphStart, span.glyphEnd) ?? [];
      const found = line.text.indexOf(span.text, cursor);
      const at = found >= 0 ? found : cursor;
      let k = at;
      const lastSpan = si === line.spans.length - 1;
      glyphs.forEach((g, gi) => {
        const text = g.text === '\u0002' ? '-' : g.text;
        const joinedHyphen = lastSpan && gi === glyphs.length - 1 && line.end === 'joined';
        const offset = joinedHyphen || k >= shown ? -1 : line.start + k;
        chars.push({
          offset,
          text,
          origin: g.origin,
          box: g.rect,
          generated: generated.has(g.charIndex),
          line: li,
          style: style.id,
          object,
        });
        k += text.length;
      });
      cursor = at + span.text.length;
    });
    lineObjects.push([...objects].sort((a, b) => a - b));
  });

  // Style of every unit of the text: its glyph's, else the one before (spaces between spans
  // and lines), else the first.
  const text = block.text;
  const charStyles = new Array<string>(text.length).fill('');
  for (const c of chars) {
    if (c.offset < 0) continue;
    for (let i = c.offset; i < Math.min(text.length, c.offset + c.text.length); i++) {
      charStyles[i] = c.style;
    }
  }
  let previous = styles[0]?.id ?? 's0';
  for (let i = 0; i < charStyles.length; i++) {
    if (charStyles[i] === '') charStyles[i] = previous;
    else previous = charStyles[i] ?? previous;
  }

  // Objects other blocks draw text with.
  const mine = new Set(block.ref.runs.map((r) => r.objectPath[0] ?? -1));
  const sharedObjects = new Set<number>();
  for (const other of blocks) {
    if (other.ref.index === block.ref.index) continue;
    for (const r of other.ref.runs) {
      const object = r.objectPath[0] ?? -1;
      if (mine.has(object)) sharedObjects.add(object);
    }
  }

  const page = target.access.doc.acquirePage(target.pageIndex);
  let pageBox: Rect;
  const graphics: Rect[] = [];
  try {
    pageBox = raw.pageBox(page.pagePtr);
    for (const obj of raw.pageObjects(page.pagePtr)) {
      const type = raw.objectType(obj);
      if (type !== PAGEOBJ_PATH && type !== PAGEOBJ_IMAGE && type !== PAGEOBJ_SHADING) continue;
      const b = raw.bounds(obj);
      if (b) graphics.push(b);
    }
  } finally {
    page.release();
  }

  return {
    block,
    blocks,
    styles,
    charStyles,
    chars,
    lineObjects,
    objectStyle,
    sharedObjects,
    u,
    n,
    pageBox,
    graphics,
    ...(refusal ? { refusal } : {}),
  };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function analysisStub(facts: ObjectFacts): ObjectAnalysis {
  const { decodings: _decodings, ...rest } = facts;
  return { ...rest, glyphs: [], glyphOfChar: [] };
}

/** Resolves `ref` on a freshly acquired page; the caller owns the page reference. */
function resolveOn(
  target: PageTarget,
  raw: RawText,
  ref: TextRunRef,
): { run: ResolvedRun; pagePtr: number; release: () => void } {
  const page = target.access.doc.acquirePage(target.pageIndex);
  try {
    const run = raw.withTextPage(page.pagePtr, (textPage) =>
      resolveRun(raw, page.pagePtr, textPage, ref),
    );
    return { run, pagePtr: page.pagePtr, release: () => page.release() };
  } catch (error) {
    page.release();
    throw error;
  }
}

/**
 * Top of the first of `letters` the font sets (it has a code for it), over the font size,
 * from its outline; undefined without one.
 */
function letterTop(
  raw: RawText,
  font: number,
  codes: ReadonlyMap<string, number>,
  letters: readonly string[],
): number | undefined {
  for (const letter of letters) {
    if (!codes.has(letter)) continue;
    const path = raw.glyphPath(font, letter, 1);
    if (!path || path.length === 0) continue;
    const top = Math.max(...path.map((s) => s.y));
    if (top > 0) return top;
  }
  return undefined;
}

interface FontCodes {
  readonly codes: ReadonlyMap<string, number>;
  readonly facts: ObjectFacts;
  readonly xHeight?: number;
  readonly capHeight?: number;
  readonly panose?: readonly number[];
}

/** The tier-2 code of each wanted character in the font of `ref`'s object (one probe pass). */
async function fontCodes(
  target: PageTarget,
  raw: RawText,
  ref: TextRunRef,
  wanted: ReadonlySet<string>,
): Promise<FontCodes | { refusal: ParagraphEditRefusal }> {
  const { access, pageIndex } = target;
  const { run, pagePtr, release } = resolveOn(target, raw, ref);
  try {
    const { info } = run;
    const blocker = blockerOf(info);
    if (blocker) return { refusal: blocker };
    const facts = await analyzeObject(access, raw, pagePtr, pageIndex, info);
    if (facts.blocker) return { refusal: facts.blocker };
    const chars = [...wanted].filter((c) => !/[\n\r]/.test(c));
    const allowed = chars.filter((c) => tier2Precheck(raw, info, c).ok);
    const candidates = tier2Candidates(facts, allowed.join(''));
    const codes = new Map<string, number>();
    if (candidates && candidates.length > 0) {
      const probes = probeCodes(access, raw, pagePtr, info.font, candidates);
      try {
        const stub = analysisStub(facts);
        for (const ch of allowed) {
          const choice = chooseTier2Codes(probes, stub, ch);
          if (choice.ok && choice.codes.length === 1 && choice.codes[0] !== undefined) {
            codes.set(ch, choice.codes[0]);
          }
        }
      } finally {
        probes.dispose();
      }
    }
    const xHeight = letterTop(raw, info.font, codes, X_HEIGHT_LETTERS);
    const capHeight = letterTop(raw, info.font, codes, CAP_HEIGHT_LETTERS);
    const fontFacts = raw.fontFacts(info.font);
    const panose = fontFacts.embedded ? readPanose(raw, info.font, fontFacts.dataBytes) : undefined;
    return {
      codes,
      facts,
      ...(xHeight === undefined ? {} : { xHeight }),
      ...(capHeight === undefined ? {} : { capHeight }),
      ...(panose === undefined ? {} : { panose }),
    };
  } finally {
    release();
  }
}

/**
 * `measure` of `codes` in the style's object, in one pass. `measure` times every code against
 * a marker glyph (the first entry that shows one character other than a space), so a letter
 * or digit leads every pass (a hyphen or a space makes a poor marker: the text page treats
 * them specially). A pass that fails is halved, the marker kept in both halves, until the
 * characters that cannot be read back are alone.
 */
function measureCodes(
  target: PageTarget,
  raw: RawText,
  ref: TextRunRef,
  facts: ObjectFacts,
  codes: readonly (readonly [string, number])[],
): Map<string, CharMetrics> {
  const out = new Map<string, CharMetrics>();
  const markerAt = codes.findIndex(([text]) => /^[\p{L}\p{N}]$/u.test(text));
  if (markerAt < 0) return out;
  const marker = codes[markerAt] as readonly [string, number];
  const rest = codes.filter((_, i) => i !== markerAt);
  const pass = (chunk: readonly (readonly [string, number])[]): boolean => {
    const entries = [marker, ...chunk];
    const sequence: Sequence = {
      entries: entries.map(([text, code]): Entry => ({ kind: 'new', code, text })),
      replacementAt: 0,
      suffixAt: entries.length,
    };
    let metrics: Metrics;
    const { run, pagePtr } = resolveOn(target, raw, ref);
    try {
      // `measure` closes the page (also when it throws).
      metrics = measure(
        target.access,
        raw,
        { pageIndex: target.pageIndex, pagePtr, run, analysis: analysisStub(facts) },
        sequence,
      );
    } catch {
      return false;
    }
    entries.forEach(([text, code], k) => {
      out.set(text, {
        code,
        spaced: metrics.spaced[k] ?? 0,
        plain: metrics.plain[k] ?? 0,
        box: metrics.boxes[k] ?? { x: 0, y: 0, width: 0, height: 0 },
      });
    });
    return true;
  };
  const split = (chunk: readonly (readonly [string, number])[]): void => {
    if (pass(chunk) || chunk.length <= 1) return;
    const mid = chunk.length >> 1;
    split(chunk.slice(0, mid));
    split(chunk.slice(mid));
  };
  if (!pass(rest)) {
    for (let i = 0; i < rest.length; i += MEASURE_CHUNK) split(rest.slice(i, i + MEASURE_CHUNK));
  }
  return out;
}

/**
 * Kerning pairs of a style from the paragraph's glyph positions (see the module comment), in
 * points along the baseline, negative = closer.
 */
function harvestPairs(
  model: ParagraphModel,
  style: string,
  chars: ReadonlyMap<string, CharMetrics>,
): Record<string, number> {
  const counts = new Map<string, Map<number, number>>();
  for (let i = 0; i + 1 < model.chars.length; i++) {
    const a = model.chars[i];
    const b = model.chars[i + 1];
    if (!a || b?.line !== a.line || a.style !== style || b.style !== style) continue;
    if (a.offset < 0 || b.offset !== a.offset + a.text.length) continue;
    if (/\s/u.test(a.text) || /\s/u.test(b.text)) continue;
    const advance = chars.get(a.text)?.spaced;
    if (advance === undefined || !chars.has(b.text)) continue;
    const distance = along(model.u, a.origin, b.origin);
    // Two characters of one glyph (a ligature) share an origin.
    if (distance < 0.2 * advance) continue;
    // `a` is the second character of a ligature: the distance to `b` spans the whole glyph.
    const prev = model.chars[i - 1];
    if (prev?.line === a.line && Math.abs(along(model.u, prev.origin, a.origin)) < 0.2 * advance) {
      continue;
    }
    const value = Math.round((distance - advance) * 1000) / 1000;
    if (Math.abs(value) < KERN_NOISE * model.block.size) continue;
    const pair = a.text + b.text;
    const byValue = counts.get(pair) ?? new Map<number, number>();
    byValue.set(value, (byValue.get(value) ?? 0) + 1);
    counts.set(pair, byValue);
  }
  const out: Record<string, number> = {};
  for (const [pair, byValue] of counts) {
    let best = 0;
    let bestCount = 0;
    for (const [value, count] of byValue) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    out[pair] = best;
  }
  return out;
}

/** The natural word gap of a style (see the module comment). */
function wordGapOf(
  model: ParagraphModel,
  style: string,
  chars: ReadonlyMap<string, CharMetrics>,
  size: number,
): number {
  const space = chars.get(' ')?.spaced;
  const drawsSpaces = model.chars.some((c) => c.style === style && c.text === ' ' && !c.generated);
  if (space !== undefined && drawsSpaces) return space;
  const { block } = model;
  const gaps: number[] = [];
  block.lines.forEach((_line, li) => {
    const natural = block.align !== 'justify' || li === block.lines.length - 1;
    if (!natural) return;
    const own = model.chars.filter((c) => c.line === li && c.offset >= 0 && !/\s/u.test(c.text));
    for (let i = 0; i + 1 < own.length; i++) {
      const a = own[i];
      const b = own[i + 1];
      if (!a || !b || a.style !== style || /\s/u.test(a.text) || /\s/u.test(b.text)) continue;
      // A gap in the text between them (a space the text page made up, not drawn).
      if (b.offset <= a.offset + a.text.length) continue;
      const advance = chars.get(a.text)?.spaced;
      if (advance === undefined) continue;
      const gap = along(model.u, a.origin, b.origin) - advance;
      if (gap > 0) gaps.push(gap);
    }
  });
  return median(gaps) ?? space ?? 0.25 * size;
}

/**
 * The bundled faces a style's missing characters are set in (see the module comment): the
 * class's candidates in order. One face of each family of the class is always loaded (the
 * first candidate is the one the overlay draws with); faces of other classes only while some
 * character asked for is still unplaced. Every other character a loaded
 * face has (`EXTRA_CHAR`) gets an advance too, in the first loaded face that has it: the layout
 * still prefers the original font's advance, and a layout made by the overlay before the
 * character was probed can be written as it is.
 */
async function substitutesOf(
  span: ParagraphSpan,
  codes: FontCodes,
  chars: ReadonlyMap<string, CharMetrics>,
  wanted: ReadonlySet<string>,
  faces: FaceCache,
): Promise<SubstituteMetrics> {
  const { font: runFont } = span;
  const cls = substituteClass({
    baseName: runFont.baseName,
    flags: runFont.flags,
    ...(codes.panose ? { panose: codes.panose } : {}),
  });
  const same = bundledFamilyOfFont(runFont.baseName);
  const candidates = substituteCandidates(cls, runFont.bold, undefined, same);
  const standard =
    runFont.kind === 'standard14' ? standardFontMetrics(runFont.baseName) : undefined;
  const original = standard ?? {
    ...(codes.xHeight === undefined ? {} : { xHeight: codes.xHeight }),
    ...(codes.capHeight === undefined ? {} : { capHeight: codes.capHeight }),
  };
  const linear = Math.hypot(span.matrix[0], span.matrix[1]) || 1;
  const loaded = new Map<string, SubstituteFace>();
  const advances = new Map<string, number>();
  const faceOf = new Map<string, string>();
  const place = (ch: string, entry: SubstituteFace) => {
    advances.set(ch, faceAdvance(entry.font, ch) * span.fontSize * linear * entry.scale);
    faceOf.set(ch, entry.face.key);
  };
  let pending = [...wanted].filter((ch) => !chars.has(ch) && !/[\n\r]/.test(ch));
  const own = same ? [same, ...classFamilies(cls)] : classFamilies(cls);
  const families = new Set<string>();
  for (const face of candidates) {
    // Another face is loaded for a character still unplaced, or as the first face of a family
    // of the class (its extra characters let the overlay lay out what is typed next).
    const wantedForClass = own.includes(face.family) && !families.has(face.family);
    if (loaded.size > 0 && pending.length === 0 && !wantedForClass) continue;
    let font: Font;
    try {
      font = await faces.get(face);
    } catch {
      // A face that cannot load is skipped (the next one of the class takes its place).
      continue;
    }
    const entry: SubstituteFace = { face, font, scale: substituteScale(original, face) };
    loaded.set(face.key, entry);
    families.add(face.family);
    const rest: string[] = [];
    for (const ch of pending) {
      if (missingInFace(font, ch).length > 0) rest.push(ch);
      else place(ch, entry);
    }
    pending = rest;
    for (const cp of font.characterSet) {
      const ch = String.fromCodePoint(cp);
      if (!advances.has(ch) && EXTRA_CHAR.test(ch)) place(ch, entry);
    }
  }
  const first = candidates.map((f) => loaded.get(f.key)).find((f) => f !== undefined);
  if (!first) throw new Error('No bundled face could be loaded');
  return {
    ...first,
    italic: runFont.italic,
    advances,
    faceOf,
    faces: loaded,
    candidates: candidates.map((f) => f.key),
    heights: original,
  };
}

/** Measures every style (see the module comment); a refusal when a font cannot be read. */
async function measureStyles(
  target: PageTarget,
  raw: RawText,
  model: ParagraphModel,
  wanted: ReadonlySet<string>,
  faces: FaceCache,
): Promise<{ metrics: Map<string, StyleMetrics>; refusal?: ParagraphEditRefusal }> {
  const metrics = new Map<string, StyleMetrics>();
  const byFont = new Map<string, FontCodes>();
  for (const style of model.styles) {
    const fontKey = String(style.span.fontId ?? style.span.font.baseName);
    let codes = byFont.get(fontKey);
    if (!codes) {
      const read = await fontCodes(target, raw, style.run, wanted);
      if ('refusal' in read) return { metrics, refusal: read.refusal };
      codes = read;
      byFont.set(fontKey, codes);
    }
    const chars = measureCodes(target, raw, style.run, codes.facts, [...codes.codes]);
    const substitute = await substitutesOf(style.span, codes, chars, wanted, faces);
    const plain = (space: string) => space === 'DeviceRGB' || space === 'DeviceGray';
    metrics.set(style.id, {
      chars,
      substitute,
      wordGap: wordGapOf(model, style.id, chars, style.span.size),
      kerning: harvestPairs(model, style.id, chars),
      fontSize: style.span.fontSize,
      otherColorSpace: !plain(codes.facts.fill) || !plain(codes.facts.stroke),
      embedded: style.span.font.kind === 'embedded',
    });
  }
  return { metrics };
}

// ---------------------------------------------------------------------------
// Layout input and overflow facts
// ---------------------------------------------------------------------------

/** The right edge of the column a left-aligned paragraph sits in (see the module comment). */
function columnRight(model: ParagraphModel): number {
  const { block, blocks, u } = model;
  let right = block.measure.right;
  if (block.align !== 'left') return right;
  for (const other of blocks) {
    if (other.ref.index === block.ref.index || other.refusal) continue;
    if (Math.abs(other.direction.x - u.x) > 1e-6 || Math.abs(other.direction.y - u.y) > 1e-6) {
      continue;
    }
    const overlap =
      Math.min(other.measure.right, block.measure.right) -
      Math.max(other.measure.left, block.measure.left);
    if (overlap <= 0) continue;
    right = Math.max(right, other.measure.right);
  }
  const page = textSpaceExtent(model.pageBox, u);
  return Math.min(right, page.x1);
}

function layoutInputOf(
  model: ParagraphModel,
  metrics: ReadonlyMap<string, StyleMetrics>,
): LayoutInput {
  const { block } = model;
  const styles: Record<string, LayoutStyle> = {};
  for (const style of model.styles) {
    const m = metrics.get(style.id);
    if (!m) continue;
    const advances: Record<string, { spaced: number; plain: number }> = {};
    for (const [ch, c] of m.chars) advances[ch] = { spaced: c.spaced, plain: c.plain };
    // Characters of the original text never fall back to a substitute: when the font cannot
    // take one, the layout reports it unsupported and the writer refuses.
    const own = new Set(model.chars.filter((c) => c.style === style.id).map((c) => c.text));
    const substitute: Record<string, number> = {};
    const fonts: Record<string, string> = {};
    for (const [ch, w] of m.substitute.advances) {
      if (own.has(ch)) continue;
      substitute[ch] = w;
      const face = m.substitute.faceOf.get(ch);
      if (face !== undefined && face !== m.substitute.face.key) fonts[ch] = face;
    }
    styles[style.id] = {
      advances,
      wordGap: m.wordGap,
      kerning: m.kerning,
      substitute: {
        font: m.substitute.face.key,
        advances: substitute,
        ...(Object.keys(fonts).length > 0 ? { fonts } : {}),
      },
    };
  }
  const spans: LayoutSpan[] = [];
  model.charStyles.forEach((style, i) => {
    const last = spans[spans.length - 1];
    if (last?.style === style && last.end === i) spans[spans.length - 1] = { ...last, end: i + 1 };
    else spans.push({ start: i, end: i + 1, style });
  });
  const top = block.lines[0]?.baseline ?? 0;
  return {
    text: block.text,
    spans,
    lines: block.lines.map((line) => ({
      start: line.start,
      y: top - line.baseline,
      ...(line.end === 'joined' ? { hyphenated: true } : {}),
    })),
    styles,
    measure: {
      left: block.measure.left,
      right: columnRight(model),
      ...(block.indent !== 0 ? { firstIndent: block.indent } : {}),
    },
    align: block.align,
    leading: block.leading,
  };
}

/** `gapBelow` and `paragraphGap` (see the module comment). */
export function overflowFacts(model: ParagraphModel): { gapBelow: number; paragraphGap: number } {
  const { block, blocks, u } = model;
  const sameFrame = (b: ParagraphBlock) =>
    Math.abs(b.direction.x - u.x) < 1e-6 && Math.abs(b.direction.y - u.y) < 1e-6;
  const extent = (b: ParagraphBlock) => textSpaceExtent(b.box, u);
  const mine = extent(block);
  const left = block.measure.left;
  const right = Math.max(block.measure.right, columnRight(model));
  const overlaps = (x0: number, x1: number, l: number, r: number) =>
    Math.min(x1, r) - Math.max(x0, l) > 1;

  let nearest: number | undefined;
  for (const other of blocks) {
    if (other.ref.index === block.ref.index || !sameFrame(other)) continue;
    const e = extent(other);
    if (e.y1 > mine.y0 + 0.5 || !overlaps(e.x0, e.x1, left, right)) continue;
    nearest = Math.max(nearest ?? Number.NEGATIVE_INFINITY, e.y1);
  }
  const center = userPoint(u, (mine.x0 + mine.x1) / 2, (mine.y0 + mine.y1) / 2);
  for (const g of model.graphics) {
    const contains =
      center.x >= g.x && center.x <= g.x + g.width && center.y >= g.y && center.y <= g.y + g.height;
    if (contains) continue;
    const e = textSpaceExtent(g, u);
    if (e.y1 > mine.y0 + 0.5 || !overlaps(e.x0, e.x1, left, right)) continue;
    nearest = Math.max(nearest ?? Number.NEGATIVE_INFINITY, e.y1);
  }

  if (nearest !== undefined) {
    // The page's typical gap between vertically adjacent blocks of a column.
    const gaps: number[] = [];
    for (const a of blocks) {
      if (!sameFrame(a)) continue;
      const ea = extent(a);
      let below: number | undefined;
      for (const b of blocks) {
        if (b === a || !sameFrame(b)) continue;
        const eb = extent(b);
        if (eb.y1 > ea.y0 + 0.5 || !overlaps(eb.x0, eb.x1, ea.x0, ea.x1)) continue;
        below = Math.max(below ?? Number.NEGATIVE_INFINITY, eb.y1);
      }
      if (below !== undefined) gaps.push(ea.y0 - below);
    }
    const gapBelow = Math.max(0, mine.y0 - nearest);
    const typical = median(gaps) ?? Math.max(0, block.leading - block.size);
    return { gapBelow, paragraphGap: Math.min(gapBelow, Math.max(0, typical)) };
  }
  const page = textSpaceExtent(model.pageBox, u);
  const contentTop = Math.max(...blocks.filter(sameFrame).map((b) => extent(b).y1), mine.y1);
  const margin = Math.max(MIN_MARGIN, page.y1 - contentTop);
  return { gapBelow: Math.max(0, mine.y0 - (page.y0 + margin)), paragraphGap: 0 };
}

function styleInfos(
  model: ParagraphModel,
  metrics: ReadonlyMap<string, StyleMetrics>,
): Record<string, ParagraphStyleInfo> {
  const out: Record<string, ParagraphStyleInfo> = {};
  for (const style of model.styles) {
    const { span } = style;
    const m = metrics.get(style.id);
    const face =
      m?.substitute.face ??
      substituteCandidates(
        substituteClass({ baseName: span.font.baseName, flags: span.font.flags }),
        span.font.bold,
      )[0];
    if (!face) continue;
    out[style.id] = {
      ...(span.fontId === undefined ? {} : { fontId: span.fontId }),
      font: span.font,
      fontSize: span.fontSize,
      size: span.size,
      matrix: span.matrix,
      ...(span.fill ? { fill: span.fill } : {}),
      renderMode: span.renderMode,
      substitute: {
        face: face.key,
        family: familyName(face),
        scale: m?.substitute.scale ?? 1,
        ...(m ? { faces: m.substitute.candidates } : {}),
      },
    };
  }
  return out;
}

/**
 * Everything an edit of `ref` needs on `target`'s page: the model, the metrics of the
 * characters in `wanted` (plus the paragraph's own), the layout input and the overflow facts.
 * Measuring changes the page in memory and drops it from the cache; nothing survives.
 */
export async function prepareParagraph(
  target: PageTarget,
  ref: ParagraphRef,
  wanted: Iterable<string>,
  faces: FaceCache,
  cache: ParagraphCache | undefined,
): Promise<PreparedParagraph> {
  const raw = new RawText(target.access.module, target.access.memory);
  const { block, blocks, runs, generated } = findBlock(target, raw, ref, cache);
  const model = buildModel(raw, target, block, blocks, runs, generated);
  // The letters the x-height and cap height are read from, so the size of a substitute does
  // not depend on the text typed.
  const chars = new Set<string>([' ', '-', ...X_HEIGHT_LETTERS, ...CAP_HEIGHT_LETTERS]);
  for (const ch of block.text) chars.add(ch);
  for (const ch of wanted) chars.add(ch);
  let metrics = new Map<string, StyleMetrics>();
  let refusal = model.refusal;
  if (!refusal) {
    const measured = await measureStyles(target, raw, model, chars, faces);
    metrics = measured.metrics;
    refusal = measured.refusal;
  }
  const input = layoutInputOf(model, metrics);
  const { gapBelow, paragraphGap } = overflowFacts(model);
  return {
    model,
    metrics,
    input,
    infos: styleInfos(model, metrics),
    gapBelow,
    paragraphGap,
    ...(refusal ? { refusal } : {}),
  };
}
