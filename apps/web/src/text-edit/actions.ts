/**
 * Committing a text edit (spec §2.2, §2.5): one `text.edit` engine edit, executed through
 * the edit runner (serialised with annotation edits and export) and recorded with its
 * replay-required inverse as one history entry labelled from the result. The runner then
 * invalidates the page (render, text) so the run references are located again.
 */
import type { EngineEdit } from '@pdf-editor/document-model';
import type {
  LocatedRun,
  TextEditFailure,
  TextEditRequest,
  TextEditResult,
} from '@pdf-editor/engine';

import type { PageTarget } from '../annotations/annotation-store';
import { executeEdit, runAction } from '../annotations/edit-runner';
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
