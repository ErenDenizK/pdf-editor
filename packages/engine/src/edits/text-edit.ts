/**
 * The `text.edit` engine edit (spec redaction-and-text-editing §2.5, research 05 §4).
 *
 * | kind        | payload                                                          | inverse          |
 * | ----------- | ---------------------------------------------------------------- | ---------------- |
 * | `text.edit` | `TextEditPayload`: the run (object path, char start/count, text) | replay required  |
 * |             | + start/end + replacement + tier + face + fit + fontSize        |                  |
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
 * (edits/redaction-apply.ts) or of an image removal or replacement (edits/image-edit.ts):
 * undo needs reopen + replay.
 */
export function isReplayRequired(edit: EngineEdit): boolean {
  return (
    (edit.kind === 'text.edit' ||
      edit.kind === 'redaction.apply' ||
      edit.kind === 'image.remove' ||
      edit.kind === 'image.replace') &&
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
