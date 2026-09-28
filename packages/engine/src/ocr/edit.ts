/**
 * The `ocr.apply` engine edit (spec §1.3).
 *
 * | kind        | payload                                              | inverse         |
 * | ----------- | ---------------------------------------------------- | --------------- |
 * | `ocr.apply` | `OcrApplyPayload`: the recognised words per page (a | replay required |
 * |             | compact tuple per word), `replace` and `/Lang`       |                 |
 *
 * The payload stores the words, so undo (reopen + replay) and crash recovery never run
 * recognition again: replay rebuilds the same layer from the stored words, byte for byte.
 * Coordinates are rounded to 0.01 pt, angles to 0.01°, confidences to integers (≈ 40 bytes
 * of JSON per word), and the first apply goes through the same rounding (`ocrLayerPlanOf`),
 * so the first result and every replay are identical. Applying runs
 * `PdfOcrLayer.applyOcrLayer`, which replaces the source's document with the verified bytes.
 */
import type { EngineEdit, SourceId } from '@pdf-editor/document-model';

import {
  type EngineCallOptions,
  EngineError,
  type OcrApplyResult,
  type OcrLayerPage,
  type OcrLayerPlan,
  type OcrQuality,
  type PdfOcrLayer,
} from '../types';

/** One stored word: text, origin x and y, width, font size (points), angle (°), confidence. */
export type OcrStoredWord = readonly [
  text: string,
  x: number,
  y: number,
  width: number,
  fontSize: number,
  angle: number,
  confidence: number,
];

export interface OcrStoredPage {
  readonly pageIndex: number;
  readonly languages: readonly string[];
  readonly words: readonly OcrStoredWord[];
  readonly dpi?: number;
  readonly quality?: OcrQuality;
  readonly meanConfidence?: number;
  readonly engine?: string;
}

/** Payload of an `ocr.apply` edit. */
export interface OcrApplyPayload {
  readonly version: 1;
  readonly replace: OcrLayerPlan['replace'];
  readonly lang?: string;
  readonly pages: readonly OcrStoredPage[];
}

/** Payload of the inverse of an applied OCR run. */
export interface OcrReplayPayload {
  readonly replayRequired: true;
  /** Id of the edit this undoes. */
  readonly of: string;
}

const round = (v: number, digits = 2): number => {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** The compact, rounded payload of a plan (what the edit records and replays). */
export function ocrApplyPayloadOf(plan: OcrLayerPlan): OcrApplyPayload {
  return {
    version: 1,
    replace: plan.replace,
    ...(plan.lang === undefined ? {} : { lang: plan.lang }),
    pages: plan.pages.map((page) => ({
      pageIndex: page.pageIndex,
      languages: [...page.languages],
      words: page.words.map(
        (w): OcrStoredWord => [
          w.text,
          round(w.origin.x),
          round(w.origin.y),
          round(w.width),
          round(w.fontSize),
          round(w.angle),
          Math.round(w.confidence ?? 0),
        ],
      ),
      ...(page.dpi === undefined ? {} : { dpi: page.dpi }),
      ...(page.quality === undefined ? {} : { quality: page.quality }),
      ...(page.meanConfidence === undefined
        ? {}
        : { meanConfidence: round(page.meanConfidence, 1) }),
      ...(page.engine === undefined ? {} : { engine: page.engine }),
    })),
  };
}

/** The layer plan a payload describes. */
export function ocrLayerPlanOf(payload: OcrApplyPayload): OcrLayerPlan {
  return {
    replace: payload.replace,
    ...(payload.lang === undefined ? {} : { lang: payload.lang }),
    pages: payload.pages.map(
      (page): OcrLayerPage => ({
        pageIndex: page.pageIndex,
        languages: page.languages,
        words: page.words.map(([text, x, y, width, fontSize, angle, confidence]) => ({
          text,
          origin: { x, y },
          width,
          fontSize,
          angle,
          confidence,
        })),
        ...(page.dpi === undefined ? {} : { dpi: page.dpi }),
        ...(page.quality === undefined ? {} : { quality: page.quality }),
        ...(page.meanConfidence === undefined ? {} : { meanConfidence: page.meanConfidence }),
        ...(page.engine === undefined ? {} : { engine: page.engine }),
      }),
    ),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(why: string): EngineError {
  return new EngineError('internal', `Invalid ocr.apply payload: ${why}`);
}

const REPLACE: readonly string[] = ['none', 'ours', 'all-invisible'];
const QUALITY: readonly string[] = ['good', 'review', 'poor', 'no-text'];
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function readOcrApplyPayload(payload: unknown): OcrApplyPayload {
  if (!isObject(payload) || payload.version !== 1) throw invalid('expected { version: 1, … }');
  const { replace, lang, pages } = payload;
  if (typeof replace !== 'string' || !REPLACE.includes(replace)) throw invalid('bad replace');
  if (lang !== undefined && typeof lang !== 'string') throw invalid('lang must be a string');
  if (!Array.isArray(pages) || pages.length === 0) throw invalid('no pages');
  const seen = new Set<number>();
  for (const page of pages as unknown[]) {
    if (!isObject(page)) throw invalid('every page must be an object');
    const { pageIndex, languages, words, dpi, quality, meanConfidence, engine } = page;
    if (!Number.isInteger(pageIndex) || (pageIndex as number) < 0) throw invalid('bad pageIndex');
    if (seen.has(pageIndex as number)) throw invalid(`page ${String(pageIndex)} twice`);
    seen.add(pageIndex as number);
    if (!Array.isArray(languages) || !languages.every((l) => typeof l === 'string')) {
      throw invalid('languages must be strings');
    }
    if (!Array.isArray(words)) throw invalid('words must be an array');
    for (const word of words as unknown[]) {
      if (
        !Array.isArray(word) ||
        word.length !== 7 ||
        typeof word[0] !== 'string' ||
        !word.slice(1).every(finite)
      ) {
        throw invalid('every word is [text, x, y, width, fontSize, angle, confidence]');
      }
    }
    if (dpi !== undefined && !finite(dpi)) throw invalid('dpi must be a number');
    if (quality !== undefined && (typeof quality !== 'string' || !QUALITY.includes(quality))) {
      throw invalid('bad quality');
    }
    if (meanConfidence !== undefined && !finite(meanConfidence)) {
      throw invalid('meanConfidence must be a number');
    }
    if (engine !== undefined && typeof engine !== 'string') throw invalid('engine must be text');
  }
  return payload as unknown as OcrApplyPayload;
}

/** The edit recording one finished run (the caller picks the id). */
export function ocrApplyEdit(id: string, source: SourceId, plan: OcrLayerPlan): EngineEdit {
  return {
    id,
    source,
    pageIndex: plan.pages[0]?.pageIndex ?? 0,
    kind: 'ocr.apply',
    payload: ocrApplyPayloadOf(plan),
  };
}

/** Runs an `ocr.apply` through `editor` (throws for a replay-required inverse). */
export async function applyOcrEdit(
  editor: Partial<Pick<PdfOcrLayer, 'applyOcrLayer'>>,
  edit: EngineEdit,
  options: EngineCallOptions,
): Promise<{ payload: OcrApplyPayload; result: OcrApplyResult }> {
  if (isObject(edit.payload) && edit.payload.replayRequired === true) {
    throw new EngineError(
      'unsupported',
      `Edit ${edit.id} undoes an OCR run: reopen the source and replay its remaining edits`,
    );
  }
  if (!editor.applyOcrLayer) {
    throw new EngineError('unsupported', 'This engine cannot write OCR layers');
  }
  // Round trip through the stored form: the first apply equals every replay.
  const payload = ocrApplyPayloadOf(ocrLayerPlanOf(readOcrApplyPayload(edit.payload)));
  const result = await editor.applyOcrLayer(edit.source, ocrLayerPlanOf(payload), options);
  return { payload, result };
}
