/**
 * Committing a text edit (spec §2.2, §2.5): one `text.edit` engine edit, executed through
 * the edit runner (serialised with annotation edits and export) and recorded with its
 * replay-required inverse as one history entry labelled from the result. The runner then
 * invalidates the page (render, text) so the run references are located again.
 *
 * A paragraph edit (craft spec §4.4, §13 #9) is the same: one `text.editParagraph` engine
 * edit carrying the paragraph reference, its new text, the replaced range and the layout the
 * editor showed, written as it is; leaving the editor commits it, and leaving it unchanged
 * discards nothing because nothing was made.
 */
import type { EngineEdit } from '@pdf-editor/document-model';
import type {
  LocatedRun,
  ParagraphBlock,
  ParagraphEdit,
  ParagraphEditResult,
  ParagraphLayout,
  TextEditFailure,
  TextEditRequest,
  TextEditResult,
} from '@pdf-editor/engine';

import type { PageTarget } from '../annotations/annotation-store';
import { executeEdit, runAction } from '../annotations/edit-runner';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { type EditRange, failureMessage, type FitChoice, historyLabel } from './model';

export interface TextEditCommit extends EditRange {
  readonly target: PageTarget;
  readonly run: LocatedRun;
  readonly fit: FitChoice;
}

export type TextEditOutcome =
  | { readonly ok: true; readonly result: TextEditResult; readonly label: string }
  | { readonly ok: false; readonly reason?: TextEditFailure; readonly message: string };

/** Applies one text edit as a history entry. Never rejects. */
export async function commitTextEdit(commit: TextEditCommit): Promise<TextEditOutcome> {
  const engine = await import('@pdf-editor/engine');
  const request: TextEditRequest = {
    run: commit.run,
    start: commit.start,
    end: commit.end,
    replacement: commit.replacement,
    tier: 'auto',
    fit: commit.fit,
  };
  const edit: EngineEdit = {
    id: globalThis.crypto.randomUUID(),
    source: commit.target.source,
    pageIndex: commit.target.pageIndex,
    kind: 'text.edit',
    payload: engine.textEditPayloadOf(request),
  };
  let failure: unknown;
  let value: { result: TextEditResult; label: string } | undefined;
  try {
    value = await runAction(async (ctx) => {
      let done: Awaited<ReturnType<typeof executeEdit>>;
      try {
        done = await executeEdit(ctx, edit);
      } catch (error) {
        // Nothing was executed (the editor verifies before it commits): no history entry.
        failure = error;
        return undefined;
      }
      if (!done.textEdit) throw new Error('The engine returned no text edit result');
      const label = historyLabel(done.textEdit);
      return { edits: [done.recorded], label, value: { result: done.textEdit, label } };
    });
  } catch (error) {
    failure = error;
  }
  if (value) {
    announce(value.label);
    return { ok: true, ...value };
  }
  if (failure !== undefined) console.warn('Text edit failed', failure);
  const reason = engine.textEditFailureReason(failure);
  return {
    ok: false,
    ...(reason === undefined ? {} : { reason }),
    message: failureMessage(reason),
  };
}

// ---------------------------------------------------------------------------
// Paragraph edits
// ---------------------------------------------------------------------------

export interface ParagraphCommit {
  readonly target: PageTarget;
  readonly block: ParagraphBlock;
  /** The paragraph's whole text after the edit. */
  readonly text: string;
  /** The replaced range of the original text (`block.text`). */
  readonly caretSpan: { readonly start: number; readonly end: number };
  /** Style id of the inserted text. */
  readonly style?: string;
  /** The layout the editor showed; omitted, the engine lays the paragraph out. */
  readonly layout?: ParagraphLayout;
  /** What the editor told the user about it (the last dry run, else the layout): the label. */
  readonly honesty?: Pick<ParagraphEditResult, 'honesty' | 'substitutions'>;
}

export type ParagraphOutcome =
  | { readonly ok: true; readonly label: string }
  | { readonly ok: false; readonly reason?: TextEditFailure; readonly message: string };

/** The history entry's label: the honesty of the written paragraph. */
export function paragraphHistoryLabel(
  result: Pick<ParagraphEditResult, 'honesty' | 'substitutions'> | undefined,
): string {
  const family = result?.substitutions[0]?.family;
  if (result?.honesty === 'font-substituted' && family) {
    return m.history_paragraph_edit_substituted({ family });
  }
  if (result?.honesty === 'same-font-not-embedded') {
    return m.history_paragraph_edit_same_font_not_embedded();
  }
  return m.history_paragraph_edit_same_font();
}

/** The engine's paragraph edit for a commit (also what the history records for replay). */
export function paragraphEditFor(commit: ParagraphCommit): ParagraphEdit {
  return {
    ref: commit.block.ref,
    text: commit.text,
    caretSpan: commit.caretSpan,
    ...(commit.style === undefined ? {} : { style: commit.style }),
    ...(commit.layout === undefined ? {} : { layout: commit.layout }),
  };
}

/** Applies one paragraph edit as a history entry. Never rejects. */
export async function commitParagraphEdit(commit: ParagraphCommit): Promise<ParagraphOutcome> {
  const engine = await import('@pdf-editor/engine');
  const edit: EngineEdit = {
    id: globalThis.crypto.randomUUID(),
    source: commit.target.source,
    pageIndex: commit.target.pageIndex,
    kind: 'text.editParagraph',
    payload: engine.paragraphEditPayloadOf(paragraphEditFor(commit)),
  };
  let failure: unknown;
  let label: string | undefined;
  try {
    label = await runAction(async (ctx) => {
      let done: Awaited<ReturnType<typeof executeEdit>>;
      try {
        done = await executeEdit(ctx, edit);
      } catch (error) {
        // Nothing was executed (the writer verifies before it commits): no history entry.
        failure = error;
        return undefined;
      }
      const written = paragraphHistoryLabel(commit.honesty);
      return { edits: [done.recorded], label: written, value: written };
    });
  } catch (error) {
    failure = error;
  }
  if (label !== undefined) {
    announce(label);
    return { ok: true, label };
  }
  if (failure !== undefined) console.warn('Paragraph edit failed', failure);
  const reason = engine.textEditFailureReason(failure);
  return {
    ok: false,
    ...(reason === undefined ? {} : { reason }),
    message: failureMessage(reason),
  };
}
