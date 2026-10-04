/**
 * The `text.edit` and `text.editParagraph` engine edits (spec redaction-and-text-editing §2.5,
 * craft §4.4, research 05 §4).
 *
 * | kind                 | payload                                                     | inverse         |
 * | -------------------- | ----------------------------------------------------------- | --------------- |
 * | `text.edit`          | `TextEditPayload`: the run (object path, char start/count,  | replay required |
 * |                      | text) + start/end + replacement + tier + face + fit + size  |                 |
 * | `text.editParagraph` | `TextEditParagraphPayload`: the paragraph (index, runs) +   | replay required |
 * |                      | new text + caret span + style spans + the layout written +  |                 |
 * |                      | tier                                                        |                 |
 *
 * PDFium cannot restore a content stream, so a text edit has no exact inverse: undo is
 * "reopen the source's original bytes and replay the remaining edits". The inverse recorded
 * for history is a `text.edit` whose payload is `{ replayRequired: true, of }`; applying it
 * throws `[text-edit:replay-required]`, and `isReplayRequired` lets the history layer see it
 * before trying. Replay re-checks the run's expected text (`stale-run` when the page
 * differs) and reuses the tier, face and size of the first application, so it reproduces
 * the same bytes.
 */
import type { EngineEdit } from '@pdf-editor/document-model';

import { textEditError } from '../text-edit/errors';
import {
  type EngineCallOptions,
  EngineError,
  type ParagraphEdit,
  type ParagraphEditResult,
  type ParagraphEditSpan,
  type ParagraphLayout,
  type PdfParagraphEditor,
  type PdfTextEditor,
  type TextEditRequest,
  type TextEditResult,
} from '../types';

/** The run as recorded: `TextRunRef` minus source and page (they are the edit's own). */
export interface TextEditRunJson {
  readonly objectPath: readonly number[];
  readonly charStart: number;
  readonly charCount: number;
  readonly text: string;
}

export interface TextEditPayload {
  readonly run: TextEditRunJson;
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  /** Requested tier; once applied, the tier used (1 or 2). */
  readonly tier: 'auto' | 1 | 2;
  readonly fit: 'keep' | 'shrink' | 'overflow';
  /** Tier 1: the bundled face used. */
  readonly face?: string;
  /** Once applied: the replacement's font size. */
  readonly fontSize?: number;
}

/** Payload of the inverse of an applied text edit. */
export interface TextEditReplayPayload {
  readonly replayRequired: true;
  /** Id of the edit this undoes. */
  readonly of: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `edit` is the inverse of a text edit, of an applied redaction
 * (edits/redaction-apply.ts), of an image removal or replacement (edits/image-edit.ts) or of
 * an OCR run (ocr/edit.ts): undo needs reopen + replay.
 */
export function isReplayRequired(edit: EngineEdit): boolean {
  return (
    (edit.kind === 'text.edit' ||
      edit.kind === 'text.editParagraph' ||
      edit.kind === 'redaction.apply' ||
      edit.kind === 'image.remove' ||
      edit.kind === 'image.replace' ||
      edit.kind === 'ocr.apply') &&
    isObject(edit.payload) &&
    edit.payload.replayRequired === true
  );
}

function invalid(why: string): EngineError {
  return new EngineError('internal', `Invalid text.edit payload: ${why}`);
}

export function readTextEditPayload(payload: unknown): TextEditPayload {
  if (!isObject(payload) || !isObject(payload.run)) throw invalid('expected { run, … }');
  const run = payload.run;
  const path = run.objectPath;
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    !path.every((n) => Number.isInteger(n) && (n as number) >= 0) ||
    !Number.isInteger(run.charStart) ||
    !Number.isInteger(run.charCount) ||
    typeof run.text !== 'string'
  ) {
    throw invalid('run needs objectPath, charStart, charCount and text');
  }
  const { start, end, replacement, tier, fit, face, fontSize } = payload;
  if (!Number.isInteger(start) || !Number.isInteger(end) || typeof replacement !== 'string') {
    throw invalid('start, end and replacement are required');
  }
  if (tier !== 'auto' && tier !== 1 && tier !== 2) throw invalid('tier must be auto, 1 or 2');
  if (fit !== 'keep' && fit !== 'shrink' && fit !== 'overflow') throw invalid('bad fit');
  if (face !== undefined && typeof face !== 'string') throw invalid('face must be a string');
  if (fontSize !== undefined && (typeof fontSize !== 'number' || !(fontSize > 0))) {
    throw invalid('fontSize must be a positive number');
  }
  return {
    run: {
      objectPath: path as number[],
      charStart: run.charStart as number,
      charCount: run.charCount as number,
      text: run.text,
    },
    start: start as number,
    end: end as number,
    replacement,
    tier,
    fit,
    ...(face === undefined ? {} : { face }),
    ...(fontSize === undefined ? {} : { fontSize }),
  };
}

/** The editor request for a recorded edit. */
export function textEditRequestOf(edit: EngineEdit, payload: TextEditPayload): TextEditRequest {
  return {
    run: { ...payload.run, source: edit.source, pageIndex: edit.pageIndex },
    start: payload.start,
    end: payload.end,
    replacement: payload.replacement,
    tier: payload.tier,
    fit: payload.fit,
    ...(payload.face === undefined ? {} : { face: payload.face }),
    ...(payload.fontSize === undefined ? {} : { fontSize: payload.fontSize }),
  };
}

/** The payload to record for a request that was applied with `result`. */
export function appliedTextEditPayload(
  payload: TextEditPayload,
  result: TextEditResult,
): TextEditPayload {
  const { face: _face, ...rest } = payload;
  return {
    ...rest,
    tier: result.tier,
    ...(result.substitute === undefined ? {} : { face: result.substitute }),
    fontSize: result.fontSize,
  };
}

/** Builds a `text.edit` from an editor request (the UI records what it applied). */
export function textEditPayloadOf(request: TextEditRequest): TextEditPayload {
  const { run } = request;
  return {
    run: {
      objectPath: [...run.objectPath],
      charStart: run.charStart,
      charCount: run.charCount,
      text: run.text,
    },
    start: request.start ?? 0,
    end: request.end ?? run.text.length,
    replacement: request.replacement,
    tier: request.tier,
    fit: request.fit,
    ...(request.face === undefined ? {} : { face: request.face }),
    ...(request.fontSize === undefined ? {} : { fontSize: request.fontSize }),
  };
}

/** Runs a `text.edit` through `editor` (throws `replay-required` for an inverse). */
export async function applyTextEditEdit(
  editor: Partial<Pick<PdfTextEditor, 'applyTextEdit'>>,
  edit: EngineEdit,
  options: EngineCallOptions,
): Promise<{ payload: TextEditPayload; result: TextEditResult }> {
  if (isReplayRequired(edit)) {
    throw textEditError(
      'replay-required',
      `Edit ${edit.id} undoes a text edit: reopen the source and replay its remaining edits`,
    );
  }
  if (!editor.applyTextEdit) {
    throw textEditError('not-editable', 'This engine has no text editor');
  }
  const payload = readTextEditPayload(edit.payload);
  const result = await editor.applyTextEdit(textEditRequestOf(edit, payload), options);
  return { payload: appliedTextEditPayload(payload, result), result };
}

// ---------------------------------------------------------------------------
// text.editParagraph (craft spec §4.4)
// ---------------------------------------------------------------------------

/** Payload of a `text.editParagraph`: what `PdfParagraphEditor.applyParagraphEdit` takes. */
export interface TextEditParagraphPayload {
  /** The paragraph as detected: its index on the page and its runs (re-checked on replay). */
  readonly paragraph: { readonly index: number; readonly runs: readonly TextEditRunJson[] };
  /** The paragraph's text after the edit, and the replaced range of the original text. */
  readonly text: string;
  readonly caretSpan: { readonly start: number; readonly end: number };
  /** Style id of the inserted text (where `spans` gives none). */
  readonly style?: string;
  /**
   * Per-character styles of the inserted text (`ParagraphEdit.spans`): typed stretches and the
   * untouched original characters between separate changes, with their source offset.
   * Payloads recorded before it existed have none and replay as they were written.
   */
  readonly spans?: readonly ParagraphEditSpan[];
  /** The layout written; recorded by the first application, written again on replay. */
  readonly layout?: ParagraphLayout;
  /** Once applied: 2 (original font only) or 1 (some characters in a bundled substitute). */
  readonly tier?: 1 | 2;
}

function invalidParagraph(why: string): EngineError {
  return new EngineError('internal', `Invalid text.editParagraph payload: ${why}`);
}

function readRun(run: unknown): TextEditRunJson {
  if (!isObject(run)) throw invalidParagraph('a run must be an object');
  const path = run.objectPath;
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    !path.every((n) => Number.isInteger(n) && (n as number) >= 0) ||
    !Number.isInteger(run.charStart) ||
    !Number.isInteger(run.charCount) ||
    typeof run.text !== 'string'
  ) {
    throw invalidParagraph('runs need objectPath, charStart, charCount and text');
  }
  return {
    objectPath: path as number[],
    charStart: run.charStart as number,
    charCount: run.charCount as number,
    text: run.text,
  };
}

export function readParagraphEditPayload(payload: unknown): TextEditParagraphPayload {
  if (!isObject(payload) || !isObject(payload.paragraph) || !isObject(payload.caretSpan)) {
    throw invalidParagraph('expected { paragraph, text, caretSpan, … }');
  }
  const { paragraph, text, caretSpan, style, spans, layout, tier } = payload;
  if (!Number.isInteger(paragraph.index) || (paragraph.index as number) < 0) {
    throw invalidParagraph('paragraph.index must be a non-negative integer');
  }
  if (!Array.isArray(paragraph.runs) || paragraph.runs.length === 0) {
    throw invalidParagraph('paragraph.runs must be a non-empty array');
  }
  if (typeof text !== 'string') throw invalidParagraph('text must be a string');
  if (!Number.isInteger(caretSpan.start) || !Number.isInteger(caretSpan.end)) {
    throw invalidParagraph('caretSpan needs integer start and end');
  }
  if (style !== undefined && typeof style !== 'string') throw invalidParagraph('bad style');
  const readSpans = spans === undefined ? undefined : readEditSpans(spans);
  if (
    layout !== undefined &&
    (!isObject(layout) || layout.text !== text || !Array.isArray(layout.lines))
  ) {
    throw invalidParagraph('layout must be a layout of the text');
  }
  if (tier !== undefined && tier !== 1 && tier !== 2) throw invalidParagraph('tier must be 1 or 2');
  return {
    paragraph: { index: paragraph.index as number, runs: paragraph.runs.map(readRun) },
    text,
    caretSpan: { start: caretSpan.start as number, end: caretSpan.end as number },
    ...(style === undefined ? {} : { style }),
    ...(readSpans === undefined ? {} : { spans: readSpans }),
    ...(layout === undefined ? {} : { layout: layout as unknown as ParagraphLayout }),
    ...(tier === undefined ? {} : { tier }),
  };
}

/** The recorded style spans: sorted, non-empty stretches with a style and an optional source. */
function readEditSpans(spans: unknown): ParagraphEditSpan[] {
  if (!Array.isArray(spans)) throw invalidParagraph('spans must be an array');
  let at = 0;
  return spans.map((span: unknown) => {
    if (
      !isObject(span) ||
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      (span.start as number) < at ||
      (span.end as number) <= (span.start as number) ||
      typeof span.style !== 'string' ||
      span.style === '' ||
      (span.source !== undefined && (!Number.isInteger(span.source) || (span.source as number) < 0))
    ) {
      throw invalidParagraph(
        'spans need sorted integer start < end, a style and an optional source',
      );
    }
    at = span.end as number;
    return {
      start: span.start as number,
      end: span.end as number,
      style: span.style,
      ...(span.source === undefined ? {} : { source: span.source as number }),
    };
  });
}

/** The paragraph edit a recorded payload stands for (on the edit's source and page). */
export function paragraphEditOf(
  edit: EngineEdit,
  payload: TextEditParagraphPayload,
): ParagraphEdit {
  return {
    ref: {
      source: edit.source,
      pageIndex: edit.pageIndex,
      index: payload.paragraph.index,
      runs: payload.paragraph.runs.map((r) => ({
        ...r,
        source: edit.source,
        pageIndex: edit.pageIndex,
      })),
    },
    text: payload.text,
    caretSpan: payload.caretSpan,
    ...(payload.style === undefined ? {} : { style: payload.style }),
    ...(payload.spans === undefined ? {} : { spans: payload.spans }),
    ...(payload.layout === undefined ? {} : { layout: payload.layout }),
  };
}

/**
 * The payload to record for a paragraph edit, with the layout and tier of `result` when it
 * was applied (so replay writes the same layout).
 */
export function paragraphEditPayloadOf(
  edit: ParagraphEdit,
  result?: ParagraphEditResult,
): TextEditParagraphPayload {
  const layout = result?.layout ?? edit.layout;
  return {
    paragraph: {
      index: edit.ref.index,
      runs: edit.ref.runs.map((r) => ({
        objectPath: [...r.objectPath],
        charStart: r.charStart,
        charCount: r.charCount,
        text: r.text,
      })),
    },
    text: edit.text,
    caretSpan: { start: edit.caretSpan.start, end: edit.caretSpan.end },
    ...(edit.style === undefined ? {} : { style: edit.style }),
    ...(edit.spans === undefined ? {} : { spans: edit.spans.map((span) => ({ ...span })) }),
    ...(layout === undefined ? {} : { layout }),
    ...(result ? { tier: result.tier } : {}),
  };
}

/** Runs a `text.editParagraph` through `editor` (throws `replay-required` for an inverse). */
export async function applyParagraphEditEdit(
  editor: Partial<Pick<PdfParagraphEditor, 'applyParagraphEdit'>>,
  edit: EngineEdit,
  options: EngineCallOptions,
): Promise<{ payload: TextEditParagraphPayload; result: ParagraphEditResult }> {
  if (isReplayRequired(edit)) {
    throw textEditError(
      'replay-required',
      `Edit ${edit.id} undoes a paragraph edit: reopen the source and replay its remaining edits`,
    );
  }
  if (!editor.applyParagraphEdit) {
    throw textEditError('not-editable', 'This engine has no paragraph editor');
  }
  const payload = readParagraphEditPayload(edit.payload);
  const paragraph = paragraphEditOf(edit, payload);
  const result = await editor.applyParagraphEdit(edit.source, edit.pageIndex, paragraph, {
    ...options,
    commit: true,
  });
  return { payload: paragraphEditPayloadOf(paragraph, result), result };
}
