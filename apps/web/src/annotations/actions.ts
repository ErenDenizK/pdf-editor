/**
 * Annotation edits as history entries (spec §5). Each function queues one user action in
 * the edit runner: read the current state from the engine, execute the change as engine
 * edits (packages/engine/src/edits payloads), and commit one labelled history entry of
 * the recorded edits with their inverses.
 */
import type { EngineEdit, SourceId } from '@pdf-editor/document-model';
import type { Annotation, NewAnnotation } from '@pdf-editor/engine';

import { announce } from '../shell/announcer';
import { type PageTarget, useAnnotationStore } from './annotation-store';
import {
  type ActionResult,
  type EngineContext,
  type ExecutedEdit,
  executeEdit,
  readAnnotations,
  runAction,
} from './edit-runner';
import { type DisplayKind, displayKind } from './geometry';
import { createLabel, deleteLabel, type UpdateAction, updateLabel } from './labels';
import { builtinStampImage } from './stamps';

/** The engine's JSON form of an annotation (engine chunk, loaded on first use). */
async function serializeAnnotation(a: NewAnnotation | Annotation) {
  const engine = await import('@pdf-editor/engine');
  return engine.serializeAnnotation(a);
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function edit(
  kind: EngineEdit['kind'],
  source: SourceId,
  pageIndex: number,
  payload: unknown,
): EngineEdit {
  return { id: newId(), source, pageIndex, kind, payload };
}

function stamped<T extends { author?: string; modified?: string }>(draft: T): T {
  const author = useAnnotationStore.getState().author.trim();
  return {
    ...draft,
    modified: new Date().toISOString(),
    ...(draft.author === undefined && author !== '' ? { author } : {}),
  };
}

async function create(
  ctx: EngineContext,
  source: SourceId,
  draft: NewAnnotation,
): Promise<ExecutedEdit> {
  const run = async (d: NewAnnotation) =>
    executeEdit(
      ctx,
      edit('annotation.create', source, d.pageIndex, {
        annotation: await serializeAnnotation(d),
      }),
    );
  try {
    return await run(draft);
  } catch (error) {
    // An engine without generated named-stamp appearances: draw the stamp as an image.
    if (draft.kind !== 'stamp' || draft.imageBlob !== undefined || draft.name === undefined) {
      throw error;
    }
    return run({ ...draft, imageBlob: await builtinStampImage(draft.name) });
  }
}

export interface CreateOptions {
  /** Kind named in the history label (arrow, signature) when it differs from the engine's. */
  readonly labelKind?: DisplayKind;
  /**
   * Select the new annotations (default false). Creating does not select (experience-redesign
   * spec §6.1, amendment A2): a selection opens the contextual bar and the inspector, which
   * must not interrupt writing. Only callers that want the new annotation adjusted at once
   * pass true (a placed stamp or signature, AnnotationLayer `finishDraw`).
   */
  readonly select?: boolean;
}

/** Creates annotations on one page as one history entry. Resolves to what was created. */
export function createAnnotations(
  target: PageTarget,
  drafts: readonly NewAnnotation[],
  options: CreateOptions = {},
): Promise<readonly Annotation[] | undefined> {
  return runAction(async (ctx): Promise<ActionResult<readonly Annotation[]> | undefined> => {
    const created: Annotation[] = [];
    const edits: EngineEdit[] = [];
    for (const draft of drafts) {
      const done = await create(ctx, target.source, stamped(draft));
      edits.push(done.recorded);
      if (done.annotation) created.push(done.annotation);
    }
    const first = created[0];
    if (!first) return undefined;
    const label = createLabel(options.labelKind ?? displayKind(first), target.position);
    announce(label);
    if (options.select === true) {
      useAnnotationStore.getState().select({ ...target, ids: created.map((a) => a.id) });
    }
    return { edits, label, value: created };
  });
}

/** JSON of an annotation without the fields the engine fills itself. */
function comparable(a: Annotation): string {
  const { modified: _modified, ...rest } = a as Annotation & { imageBlob?: Blob };
  return JSON.stringify({ ...rest, imageBlob: undefined });
}

export interface UpdateOptions {
  readonly action: UpdateAction;
  /** Consecutive updates with the same key within 800 ms are one history entry. */
  readonly coalesceKey?: string;
}

/**
 * Updates annotations of one page as one history entry. `change` receives each current
 * annotation (as the engine has it now) and returns the new one, or undefined to skip it.
 * Locked annotations are never changed.
 */
export function updateAnnotations(
  target: PageTarget,
  ids: readonly string[],
  change: (current: Annotation) => Annotation | undefined,
  options: UpdateOptions,
): Promise<readonly Annotation[] | undefined> {
  return runAction(async (ctx): Promise<ActionResult<readonly Annotation[]> | undefined> => {
    const list = await readAnnotations(target.source, target.pageIndex, ctx);
    const edits: EngineEdit[] = [];
    const updated: Annotation[] = [];
    let kind: DisplayKind | undefined;
    for (const id of ids) {
      const current = list.find((a) => a.id === id);
      if (!current || current.flags?.locked) continue;
      const next = change(current);
      if (!next || comparable(next) === comparable(current)) continue;
      const annotation = await serializeAnnotation(stamped({ ...next, id: current.id }));
      const done = await executeEdit(
        ctx,
        edit('annotation.update', target.source, current.pageIndex, { annotation }),
      );
      edits.push(done.recorded);
      if (done.annotation) updated.push(done.annotation);
      kind ??= displayKind(current);
    }
    if (edits.length === 0 || kind === undefined) return undefined;
    const label = updateLabel(options.action, kind);
    return {
      edits,
      label,
      value: updated,
      ...(options.coalesceKey === undefined ? {} : { coalesceKey: options.coalesceKey }),
    };
  });
}

/**
 * Deletes annotations of one page as one history entry ("Delete 2 annotations"). A stamp
 * whose appearance the engine cannot export for undo (and that has no name to redraw it
 * from) is hidden instead, which undo reverses exactly.
 */
export function deleteAnnotations(
  target: PageTarget,
  ids: readonly string[],
): Promise<number | undefined> {
  return runAction(async (ctx): Promise<ActionResult<number> | undefined> => {
    const list = await readAnnotations(target.source, target.pageIndex, ctx);
    const edits: EngineEdit[] = [];
    const removed: Annotation[] = [];
    for (const id of ids) {
      const current = list.find((a) => a.id === id);
      if (!current || current.flags?.locked) continue;
      const restorable =
        current.kind !== 'stamp' ||
        ctx.editor.getAnnotationAppearance !== undefined ||
        current.name !== undefined;
      const e = restorable
        ? edit('annotation.delete', target.source, current.pageIndex, { annotationId: id })
        : edit('annotation.update', target.source, current.pageIndex, {
            annotation: await serializeAnnotation({
              ...current,
              flags: { ...current.flags, hidden: true },
            }),
          });
      const done = await executeEdit(ctx, e);
      edits.push(done.recorded);
      removed.push(current);
    }
    if (edits.length === 0) return undefined;
    const label = deleteLabel(removed);
    announce(label);
    const store = useAnnotationStore.getState();
    if (store.selection?.source === target.source) store.select(null);
    return { edits, label, value: removed.length };
  });
}
