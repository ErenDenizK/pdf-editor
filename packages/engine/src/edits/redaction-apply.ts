/**
 * The `redaction.apply` engine edit (spec redaction-and-text-editing §1.2, ADR-0011 §3).
 *
 * | kind              | payload                                                | inverse         |
 * | ----------------- | ------------------------------------------------------ | --------------- |
 * | `redaction.apply` | `RedactionApplyEditPayload`: the plan (source pages),  | replay required |
 * |                   | + whether to capture strings and remove covered images |                 |
 *
 * Applying runs `PdfRedactor.applyRedactionPlan` on the open source, which replaces the
 * source's document with the verified redacted bytes. Nothing restores the removed content,
 * so, as for `text.edit`, the recorded inverse says "replay required": undo reopens the
 * source's original bytes and replays the edits that remain, redo applies the forward edit
 * again. The recorded payload is `{ plan: result.plan }` (the plan as applied, captured
 * strings included, `RedactionApplyPayload`, which the export plan reads), with capture off,
 * so a replay reproduces the same removal.
 */
import type { EngineEdit } from '@pdf-editor/document-model';

import {
  type ApplyRedactionsResult,
  type EngineCallOptions,
  EngineError,
  type PdfRedactor,
  type RedactionApplyPayload,
  type RedactionPlan,
} from '../types';

/** Payload of a `redaction.apply` edit as the UI first executes it. */
export interface RedactionApplyEditPayload extends RedactionApplyPayload {
  /** Capture the text under the areas into the plan's strings (default false). */
  readonly captureStrings?: boolean;
  /** Remove image objects lying entirely inside an area (default true). */
  readonly removeCoveredImages?: boolean;
}

/** Payload of the inverse of an applied redaction. */
export interface RedactionReplayPayload {
  readonly replayRequired: true;
  /** Id of the edit this undoes. */
  readonly of: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(why: string): EngineError {
  return new EngineError('internal', `Invalid redaction.apply payload: ${why}`);
}

export function readRedactionApplyPayload(payload: unknown): RedactionApplyEditPayload {
  if (!isObject(payload) || !isObject(payload.plan)) throw invalid('expected { plan, … }');
  const plan = payload.plan as Partial<RedactionPlan>;
  if (!Array.isArray(plan.areas) || plan.areas.length === 0) throw invalid('plan has no areas');
  if (!Array.isArray(plan.strings) || !plan.strings.every((s) => typeof s === 'string')) {
    throw invalid('plan.strings must be strings');
  }
  for (const area of plan.areas as unknown[]) {
    const a = area as { pageIndex?: unknown; rect?: Record<string, unknown> } | null;
    const r = a?.rect;
    if (
      !Number.isInteger(a?.pageIndex) ||
      !r ||
      ![r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      throw invalid('every area needs pageIndex and rect');
    }
  }
  const { captureStrings, removeCoveredImages } = payload;
  if (captureStrings !== undefined && typeof captureStrings !== 'boolean') {
    throw invalid('captureStrings must be a boolean');
  }
  if (removeCoveredImages !== undefined && typeof removeCoveredImages !== 'boolean') {
    throw invalid('removeCoveredImages must be a boolean');
  }
  return {
    plan: plan as RedactionPlan,
    ...(captureStrings === undefined ? {} : { captureStrings }),
    ...(removeCoveredImages === undefined ? {} : { removeCoveredImages }),
  };
}

/** Runs a `redaction.apply` through `editor` (throws for a replay-required inverse). */
export async function applyRedactionEdit(
  editor: Partial<Pick<PdfRedactor, 'applyRedactionPlan'>>,
  edit: EngineEdit,
  options: EngineCallOptions,
): Promise<{ payload: RedactionApplyEditPayload; result: ApplyRedactionsResult }> {
  if (isObject(edit.payload) && edit.payload.replayRequired === true) {
    throw new EngineError(
      'unsupported',
      `Edit ${edit.id} undoes a redaction: reopen the source and replay its remaining edits`,
    );
  }
  if (!editor.applyRedactionPlan) {
    throw new EngineError('unsupported', 'This engine cannot apply redactions');
  }
  const payload = readRedactionApplyPayload(edit.payload);
  const result = await editor.applyRedactionPlan(edit.source, payload.plan, {
    ...options,
    captureStrings: payload.captureStrings ?? false,
    ...(payload.removeCoveredImages === undefined
      ? {}
      : { removeCoveredImages: payload.removeCoveredImages }),
  });
  return {
    payload: {
      plan: result.plan,
      ...(payload.removeCoveredImages === undefined
        ? {}
        : { removeCoveredImages: payload.removeCoveredImages }),
    },
    result,
  };
}
