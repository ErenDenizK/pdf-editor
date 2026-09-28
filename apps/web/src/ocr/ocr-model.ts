/**
 * OCR in the app, the pure parts (spec recognize-and-compare §1.2, §1.3, §1.5): which pages a
 * run covers, the default languages and their names, pack sizes, the "Replace existing
 * invisible text" mode, and the results as the model stores them.
 *
 * Results are read from the `ocr.apply` edits of the workspace (their payload holds the
 * recognised words per page, `OcrApplyPayload` in packages/engine/src/ocr/edit.ts), never
 * from a side store: undo, redo and replay change what the panel shows exactly as they change
 * the document. The latest edit of a page wins (a re-run replaces the earlier layer).
 *
 * Kept free of engine runtime imports (types only): the right panel reads this module from
 * the entry chunk, where the engine is not loaded.
 */
import type {
  EngineEdit,
  PageId,
  Rect,
  Rotation,
  SourceId,
  VirtualDocument,
} from '@pdf-editor/document-model';
import type { OcrLayerPlan, OcrPageFacts, OcrQuality } from '@pdf-editor/engine';

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** A document page a run can recognise: a page of a source PDF. */
export interface OcrTarget {
  readonly pageId: PageId;
  /** Position in the document (0-based). */
  readonly docIndex: number;
  readonly source: SourceId;
  /** Page index in the source. */
  readonly index: number;
  /** The model's rotation on top of /Rotate (rendered upright, spec §1.2). */
  readonly rotation: Rotation;
}

/**
 * The pages of `doc` a run can recognise, in document order. Blank and image pages are left
 * out (they carry no PDF page to write a layer on); a source page shown twice counts once
 * (its layer is one).
 */
export function documentTargets(doc: VirtualDocument): OcrTarget[] {
  const seen = new Set<string>();
  const out: OcrTarget[] = [];
  doc.pages.forEach((page, docIndex) => {
    if (page.ref.kind !== 'source') return;
    const key = `${page.ref.source}:${page.ref.index}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      pageId: page.id,
      docIndex,
      source: page.ref.source,
      index: page.ref.index,
      rotation: page.rotation,
    });
  });
  return out;
}

export type OcrScope = 'without-text' | 'all' | 'current' | 'range';

/** `ocrPageFacts` per source. */
export type FactsBySource = ReadonlyMap<SourceId, readonly OcrPageFacts[]>;

export function factsOf(facts: FactsBySource, target: OcrTarget): OcrPageFacts | undefined {
  return facts.get(target.source)?.[target.index];
}

/** A page without visible text (a scan, or a page whose only text is invisible). */
export function lacksVisibleText(facts: FactsBySource, target: OcrTarget): boolean {
  return factsOf(facts, target)?.visibleText === false;
}

/**
 * The default scope (spec §1.2): the pages without visible text; when every page has some,
 * all pages (the user opened OCR on purpose).
 */
export function defaultScope(targets: readonly OcrTarget[], facts: FactsBySource): OcrScope {
  return targets.some((t) => lacksVisibleText(facts, t)) ? 'without-text' : 'all';
}

/**
 * The pages a scope covers. `range` is the parsed page range (0-based document indices) or
 * null when it does not parse; `currentPage` is Read mode's page. Null for an invalid range.
 */
export function scopeTargets(
  targets: readonly OcrTarget[],
  scope: OcrScope,
  options: {
    readonly facts: FactsBySource;
    readonly currentPage: number;
    readonly range: readonly number[] | null;
  },
): OcrTarget[] | null {
  switch (scope) {
    case 'without-text':
      return targets.filter((t) => lacksVisibleText(options.facts, t));
    case 'all':
      return [...targets];
    case 'current':
      return targets.filter((t) => t.docIndex === options.currentPage);
    case 'range': {
      if (options.range === null) return null;
      const wanted = new Set(options.range);
      return targets.filter((t) => wanted.has(t.docIndex));
    }
  }
}

/** Invisible text on the pages of a run, by whose it is (the replace option, spec §1.2). */
export interface InvisibleText {
  /** Pages carrying this app's earlier layer. */
  readonly ours: number;
  /** Pages carrying invisible text of another tool. */
  readonly foreign: number;
}

export function invisibleTextOf(
  targets: readonly OcrTarget[],
  facts: FactsBySource,
): InvisibleText {
  let ours = 0;
  let foreign = 0;
  for (const target of targets) {
    const f = factsOf(facts, target);
    if (!f) continue;
    if (f.invisibleText === 'foreign') foreign += 1;
    else if (f.ourLayer || f.invisibleText === 'ours') ours += 1;
  }
  return { ours, foreign };
}

/**
 * Whether "Replace existing invisible text" starts ticked: for a re-run over this app's own
 * layer (keeping it would put the words in twice), never over another tool's text (spec §1.2:
 * kept unless chosen).
 */
export function defaultReplace(invisible: InvisibleText): boolean {
  return invisible.ours > 0 && invisible.foreign === 0;
}

/**
 * The plan's `replace` for one source's pages: kept (`none`) unless the user chose to
 * replace; then this app's layer only (`ours`), or every invisible text object when another
 * tool's is there (`all-invisible`).
 */
export function replaceModeFor(
  replace: boolean,
  targets: readonly OcrTarget[],
  facts: FactsBySource,
): OcrLayerPlan['replace'] {
  if (!replace) return 'none';
  return invisibleTextOf(targets, facts).foreign > 0 ? 'all-invisible' : 'ours';
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/**
 * Tesseract codes (ISO 639-2/T, plus script suffixes) → BCP 47, for names and /Lang. Mirrors
 * `languageTag` in packages/engine/src/ocr/geometry.ts, which this chunk cannot import.
 */
const BCP47: Readonly<Record<string, string>> = {
  eng: 'en',
  tur: 'tr',
  deu: 'de',
  fra: 'fr',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  nld: 'nl',
  rus: 'ru',
  pol: 'pl',
  ces: 'cs',
  swe: 'sv',
  dan: 'da',
  nor: 'no',
  fin: 'fi',
  ell: 'el',
  ukr: 'uk',
  ara: 'ar',
  heb: 'he',
  jpn: 'ja',
  kor: 'ko',
  chi_sim: 'zh-Hans',
  chi_tra: 'zh-Hant',
};

/** BCP 47 tag of a Tesseract language code. */
export function tagOfCode(code: string): string {
  return BCP47[code] ?? code.split('_')[0] ?? code;
}

/** Tesseract code of a UI locale (`tr-TR` → `tur`), when the app has a pack for it. */
export function codeOfLocale(locale: string): string | undefined {
  const base = locale.toLowerCase().split(/[-_]/)[0] ?? '';
  return Object.entries(BCP47).find(([, tag]) => tag === base)?.[0];
}

/**
 * The default languages (spec §1.1): the UI language, then English, of those available.
 * Tesseract takes the first as the primary one, so the UI language leads ("tur+eng").
 */
export function defaultLanguages(locale: string, available: readonly string[]): string[] {
  const out: string[] = [];
  for (const code of [codeOfLocale(locale), 'eng']) {
    if (code !== undefined && available.includes(code) && !out.includes(code)) out.push(code);
  }
  if (out.length === 0 && available[0] !== undefined) out.push(available[0]);
  return out;
}

/** "Turkish" (English UI) / "Türkçe" (Turkish UI); the code itself when unknown. */
export function languageName(code: string, locale: string): string {
  const tag = tagOfCode(code);
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' }).of(tag);
    if (name) return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    // An unusual code (an imported pack): shown as it is.
  }
  return code;
}

/** Languages as the history label and Tesseract write them: "tur+eng". */
export function languagesKey(codes: readonly string[]): string {
  return codes.join('+');
}

/** A pack size as the dialog shows it: decimal megabytes, one decimal ("2.0 MB", "2,0 MB"). */
export function formatMegabytes(bytes: number, locale: string): string {
  const value = Math.max(0.1, Math.round(bytes / 100_000) / 10);
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'megabyte',
    unitDisplay: 'short',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

// ---------------------------------------------------------------------------
// Results in the model
// ---------------------------------------------------------------------------

/**
 * The engine's confidence thresholds (packages/engine/src/types.ts, from spike S1): kept words
 * below `lowConfidence` are listed for review (`OCR_LOW_CONFIDENCE`); a page's mean decides
 * Good / Review / Poor (`OCR_QUALITY_THRESHOLDS`). Passed in, never repeated here: this module
 * cannot import the engine (see the module comment), the callers read them from its chunk
 * (ocr-thresholds.ts).
 */
export interface OcrThresholds {
  readonly lowConfidence: number;
  readonly good: number;
  readonly review: number;
}

/** The thresholds from the engine's constants. */
export function thresholdsOf(engine: {
  readonly OCR_LOW_CONFIDENCE: number;
  readonly OCR_QUALITY_THRESHOLDS: { readonly good: number; readonly review: number };
}): OcrThresholds {
  return {
    lowConfidence: engine.OCR_LOW_CONFIDENCE,
    good: engine.OCR_QUALITY_THRESHOLDS.good,
    review: engine.OCR_QUALITY_THRESHOLDS.review,
  };
}

/** One stored word: text, origin x and y, width, font size, angle, confidence (edit.ts). */
export type StoredWord = readonly [string, number, number, number, number, number, number];

/** The recognised text of one source page, as the latest `ocr.apply` edit recorded it. */
export interface OcrPageRecord {
  readonly source: SourceId;
  readonly pageIndex: number;
  readonly editId: string;
  readonly languages: readonly string[];
  readonly words: readonly StoredWord[];
  readonly quality: OcrQuality;
  readonly meanConfidence: number;
  readonly dpi?: number;
}

function isStoredWord(value: unknown): value is StoredWord {
  return (
    Array.isArray(value) &&
    value.length === 7 &&
    typeof value[0] === 'string' &&
    value.slice(1).every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/** A page's quality from its mean confidence, as the engine's `ocrQuality` decides it. */
function qualityOf(mean: number, words: number, t: OcrThresholds): OcrQuality {
  if (words === 0) return 'no-text';
  if (mean >= t.good) return 'good';
  if (mean >= t.review) return 'review';
  return 'poor';
}

const QUALITIES: readonly string[] = ['good', 'review', 'poor', 'no-text'];

/** The pages an `ocr.apply` edit recorded (tolerant: malformed pages are skipped). */
export function recordsOfEdit(edit: EngineEdit, t: OcrThresholds): OcrPageRecord[] {
  if (edit.kind !== 'ocr.apply') return [];
  const payload = edit.payload as { readonly pages?: unknown } | null | undefined;
  if (!payload || !Array.isArray(payload.pages)) return [];
  const out: OcrPageRecord[] = [];
  for (const raw of payload.pages as unknown[]) {
    const page = raw as Record<string, unknown> | null;
    if (!page || !Number.isInteger(page.pageIndex) || !Array.isArray(page.words)) continue;
    const words = (page.words as unknown[]).filter(isStoredWord);
    const mean =
      typeof page.meanConfidence === 'number'
        ? page.meanConfidence
        : words.length === 0
          ? 0
          : words.reduce((sum, w) => sum + w[6], 0) / words.length;
    const quality =
      typeof page.quality === 'string' && QUALITIES.includes(page.quality)
        ? (page.quality as OcrQuality)
        : qualityOf(mean, words.length, t);
    const languages = Array.isArray(page.languages)
      ? (page.languages as unknown[]).filter((l): l is string => typeof l === 'string')
      : [];
    out.push({
      source: edit.source,
      pageIndex: page.pageIndex as number,
      editId: edit.id,
      languages,
      words,
      quality,
      meanConfidence: mean,
      ...(typeof page.dpi === 'number' ? { dpi: page.dpi } : {}),
    });
  }
  return out;
}

export const recordKey = (source: SourceId, pageIndex: number) => `${source}:${pageIndex}`;

/** Every recognised page of the workspace by `recordKey`, the latest edit winning. */
export function ocrRecords(
  edits: readonly EngineEdit[],
  t: OcrThresholds,
): Map<string, OcrPageRecord> {
  const out = new Map<string, OcrPageRecord>();
  for (const edit of edits) {
    for (const record of recordsOfEdit(edit, t)) {
      out.set(recordKey(record.source, record.pageIndex), record);
    }
  }
  return out;
}

/** Whether any `ocr.apply` edit touches a source of `doc`. */
export function documentHasOcr(edits: readonly EngineEdit[], doc: VirtualDocument): boolean {
  const sources = new Set(
    doc.pages.flatMap((p) => (p.ref.kind === 'source' ? [p.ref.source] : [])),
  );
  return edits.some((edit) => edit.kind === 'ocr.apply' && sources.has(edit.source));
}

/**
 * A stored word's box in unrotated user space: from its origin on the descender line along
 * the baseline (`width`) and one row height up (`fontSize`), turned by `angle`; the axis-
 * aligned bounds (as `layerWordRect` in packages/engine/src/ocr/verify.ts).
 */
export function storedWordRect(word: StoredWord): Rect {
  const [, x, y, width, fontSize, angle] = word;
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const xs = [x, x + dx * width, x - dy * fontSize, x + dx * width - dy * fontSize];
  const ys = [y, y + dy * width, y + dx * fontSize, y + dy * width + dx * fontSize];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** A low-confidence word of a page (a row of the OCR section). */
export interface OcrWordRow {
  /** Index of the word in the page's stored words. */
  readonly index: number;
  readonly text: string;
  readonly confidence: number;
  readonly rect: Rect;
}

/** The words of a page below the low-confidence threshold, in reading order. */
export function lowConfidenceRows(record: OcrPageRecord, t: OcrThresholds): OcrWordRow[] {
  const rows: OcrWordRow[] = [];
  record.words.forEach((word, index) => {
    if (word[6] >= t.lowConfidence) return;
    rows.push({ index, text: word[0], confidence: word[6], rect: storedWordRect(word) });
  });
  return rows;
}

/** Quality order for the document list: what needs a look first. */
export const QUALITY_ORDER: readonly OcrQuality[] = ['poor', 'no-text', 'review', 'good'];

/** A recognised page of a document (the document-level list). */
export interface OcrPageRow {
  readonly pageId: PageId;
  readonly docIndex: number;
  readonly record: OcrPageRecord;
}

/**
 * The document's recognised pages, worst quality first, then in page order (a source page
 * shown twice is listed at its first position).
 */
export function documentQualityRows(
  doc: VirtualDocument,
  records: ReadonlyMap<string, OcrPageRecord>,
): OcrPageRow[] {
  const rows: OcrPageRow[] = [];
  for (const target of documentTargets(doc)) {
    const record = records.get(recordKey(target.source, target.index));
    if (record) rows.push({ pageId: target.pageId, docIndex: target.docIndex, record });
  }
  return rows.sort(
    (a, b) =>
      QUALITY_ORDER.indexOf(a.record.quality) - QUALITY_ORDER.indexOf(b.record.quality) ||
      a.docIndex - b.docIndex,
  );
}

/** Pages per quality. */
export function countByQuality(rows: readonly OcrPageRow[]): Record<OcrQuality, number> {
  const counts: Record<OcrQuality, number> = { good: 0, review: 0, poor: 0, 'no-text': 0 };
  for (const row of rows) counts[row.record.quality] += 1;
  return counts;
}

/** What the export summary says about OCR (spec §1.3): pages recognised and languages. */
export interface OcrExportSummary {
  readonly pages: number;
  readonly languages: readonly string[];
}

/**
 * The OCR line of an export: recognised pages the document shows (latest edit per page) and
 * their languages in first-seen order; undefined without any.
 */
export function ocrExportSummaryOf(
  doc: VirtualDocument,
  edits: readonly EngineEdit[],
  t: OcrThresholds,
): OcrExportSummary | undefined {
  const records = ocrRecords(edits, t);
  const rows = documentQualityRows(doc, records);
  if (rows.length === 0) return undefined;
  const languages: string[] = [];
  for (const row of [...rows].sort((a, b) => a.docIndex - b.docIndex)) {
    for (const code of row.record.languages) if (!languages.includes(code)) languages.push(code);
  }
  return { pages: rows.length, languages };
}

/**
 * The row J (`+1`) or K (`-1`) moves to from `current` (-1 for none): the first or last row
 * when none is current, wrapping at the ends; -1 without rows.
 */
export function stepRow(length: number, current: number, delta: 1 | -1): number {
  if (length <= 0) return -1;
  if (current < 0 || current >= length) return delta > 0 ? 0 : length - 1;
  return (current + delta + length) % length;
}
