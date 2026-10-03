/**
 * Annotation edits as history entries (spec §5). Each function queues one user action in
 * the edit runner: read the current state from the engine, execute the change as engine
 * edits (packages/engine/src/edits payloads), and commit one labelled history entry of
 * the recorded edits with their inverses.
 */
import type { EngineEdit, SourceId } from '@pdf-editor/document-model';
import type { Annotation, InkAnnotation, NewAnnotation } from '@pdf-editor/engine';

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
import { type DisplayKind, displayKind, roundRect } from './geometry';
import { boundsOf, type Point } from './ink';
import {
  createLabel,
  deleteLabel,
  type KindCounts,
  kindCounts,
  type UpdateAction,
  updateLabel,
} from './labels';
import { type LassoPicks, lassoable } from './lasso/geometry';
import { type PathEdit, splitInk } from './lasso/split';
import { editWhole, patchTouchesInk } from './lasso/whole';
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
  /** Label of the history entry instead of "Highlight on page 3". */
  readonly label?: string;
  /** Later updates with the same key join this entry (a pen burst, spec §6.4). */
  readonly coalesceKey?: string;
  /** The window for `coalesceKey` (default 800 ms). */
  readonly coalesceWindowMs?: number;
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
    const label =
      options.label ?? createLabel(options.labelKind ?? displayKind(first), target.position);
    announce(label);
    if (options.select === true) {
      useAnnotationStore.getState().select({ ...target, ids: created.map((a) => a.id) });
    }
    return {
      edits,
      label,
      value: created,
      ...(options.coalesceKey === undefined ? {} : { coalesceKey: options.coalesceKey }),
      ...(options.coalesceWindowMs === undefined
        ? {}
        : { coalesceWindowMs: options.coalesceWindowMs }),
    };
  });
}

/** A pen stroke as committed: user-space centre line and the full width at each point. */
export interface InkPathInput {
  readonly path: readonly Point[];
  readonly widths: readonly number[];
}

export interface AppendInkOptions {
  /** The history label for the ink once it holds `paths` paths. */
  readonly label: (paths: number) => string;
  readonly coalesceKey: string;
  readonly coalesceWindowMs?: number;
  /**
   * Widths of the ink's paths as they were sent, used when the engine does not give them
   * back (an engine without per-point widths); else the old paths keep a constant width.
   */
  readonly knownWidths?: readonly (readonly number[])[];
}

/**
 * Appends a path to an Ink annotation (a pen burst, spec §6.4) through `annotation.update`,
 * with its per-point widths kept parallel to the paths (ADR-0018). The id is resolved when
 * the queued action runs, so a burst can append to an ink whose create is still queued.
 * Resolves to the updated ink, or undefined when there was nothing to append to (the ink was
 * deleted, locked or never created): the caller then creates a new one.
 */
export function appendInkPath(
  target: PageTarget,
  id: () => Promise<string | undefined>,
  input: InkPathInput,
  options: AppendInkOptions,
): Promise<InkAnnotation | undefined> {
  return runAction(async (ctx): Promise<ActionResult<InkAnnotation> | undefined> => {
    const annotationId = await id();
    if (annotationId === undefined) return undefined;
    const list = await readAnnotations(target.source, target.pageIndex, ctx);
    const current = list.find((a) => a.id === annotationId);
    if (current?.kind !== 'ink' || current.flags?.locked || current.flags?.hidden) return undefined;
    const aligned = (w: readonly (readonly number[])[] | undefined) =>
      w?.length === current.paths.length &&
      w.every((pathWidths, i) => pathWidths.length === current.paths[i]?.length);
    const oldWidths = aligned(current.widths)
      ? (current.widths ?? [])
      : aligned(options.knownWidths)
        ? (options.knownWidths ?? [])
        : current.paths.map((path) => path.map(() => current.strokeWidth));
    const paths = [...current.paths, input.path];
    const widths = [...oldWidths, input.widths];
    const widest = Math.max(current.strokeWidth, ...widths.flat());
    const next: InkAnnotation = {
      ...current,
      paths: paths.map((path) => path.map((p) => ({ x: p.x, y: p.y }))),
      widths: widths.map((w) => [...w]),
      rect: roundRect(boundsOf(paths, widest / 2 + 1)),
    };
    const annotation = await serializeAnnotation(stamped(next));
    const done = await executeEdit(
      ctx,
      edit('annotation.update', target.source, current.pageIndex, { annotation }),
    );
    const updated = done.annotation?.kind === 'ink' ? done.annotation : next;
    return {
      edits: [done.recorded],
      label: options.label(paths.length),
      value: updated,
      coalesceKey: options.coalesceKey,
      ...(options.coalesceWindowMs === undefined
        ? {}
        : { coalesceWindowMs: options.coalesceWindowMs }),
    };
  });
}

/**
 * Removes the last path of an Ink annotation and its widths (undo of one stroke inside an
 * open pen burst, spec §6.4) through `annotation.update`, joining the burst's history entry
 * (`coalesceKey`), which then holds one path fewer. Resolves to the updated ink, or undefined
 * when there was nothing to remove (the ink is gone, locked, or down to one path).
 */
export function removeLastInkPath(
  target: PageTarget,
  id: () => Promise<string | undefined>,
  options: Omit<AppendInkOptions, 'knownWidths'>,
): Promise<InkAnnotation | undefined> {
  return runAction(async (ctx): Promise<ActionResult<InkAnnotation> | undefined> => {
    const annotationId = await id();
    if (annotationId === undefined) return undefined;
    const list = await readAnnotations(target.source, target.pageIndex, ctx);
    const current = list.find((a) => a.id === annotationId);
    if (current?.kind !== 'ink' || current.flags?.locked || current.paths.length < 2) {
      return undefined;
    }
    const paths = current.paths.slice(0, -1);
    const widths =
      current.widths?.length === current.paths.length ? current.widths.slice(0, -1) : undefined;
    const widest = Math.max(current.strokeWidth, ...(widths?.flat() ?? []));
    const { widths: _old, ...base } = current;
    const next: InkAnnotation = {
      ...base,
      paths,
      ...(widths ? { widths } : {}),
      rect: roundRect(boundsOf(paths, widest / 2 + 1)),
    };
    const annotation = await serializeAnnotation(stamped(next));
    const done = await executeEdit(
      ctx,
      edit('annotation.update', target.source, current.pageIndex, { annotation }),
    );
    return {
      edits: [done.recorded],
      label: options.label(paths.length),
      value: done.annotation?.kind === 'ink' ? done.annotation : next,
      coalesceKey: options.coalesceKey,
      ...(options.coalesceWindowMs === undefined
        ? {}
        : { coalesceWindowMs: options.coalesceWindowMs }),
    };
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
 * The edit that deletes `current`: a stamp whose appearance the engine cannot export for
 * undo (and that has no name to redraw it from) is hidden instead, which undo reverses
 * exactly.
 */
async function deletion(
  ctx: EngineContext,
  target: PageTarget,
  current: Annotation,
): Promise<EngineEdit> {
  const restorable =
    current.kind !== 'stamp' ||
    ctx.editor.getAnnotationAppearance !== undefined ||
    current.name !== undefined;
  return restorable
    ? edit('annotation.delete', target.source, current.pageIndex, { annotationId: current.id })
    : edit('annotation.update', target.source, current.pageIndex, {
        annotation: await serializeAnnotation({
          ...current,
          flags: { ...current.flags, hidden: true },
        }),
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
      const done = await executeEdit(ctx, await deletion(ctx, target, current));
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

export interface InkPathEditOptions {
  /** The history label for an edit of `count` paths ("Recolour 3 strokes"). */
  readonly label: (count: number) => string;
  /** Later edits with the same key within 800 ms join this entry (slider drags, nudges). */
  readonly coalesceKey?: string;
  /**
   * Called inside the queued action, once the engine has the edit and before the next
   * queued action runs, with where the taken paths are now (annotation id → path indices).
   */
  readonly onEdited?: (picks: Readonly<Record<string, readonly number[]>>) => void;
}

/**
 * Edits some paths of Ink annotations on one page (the lasso, experience-redesign spec §6.5)
 * as one history entry: `picks` maps ids to path indices; it and `change` are read when the
 * queued action runs (so a later value can replace a queued one).
 * An Ink whose paths are all taken is edited in place (or deleted); one with only some taken
 * is split by the rule of `lasso/split.ts`: the rest keeps the id, the taken paths become a
 * new Ink with the edit, both in this entry. Locked and missing annotations are skipped.
 * Resolves to where the taken paths are afterwards, or undefined when nothing changed.
 * `editLassoSelection` does the same for a selection that also holds whole annotations.
 */
export function editInkPaths(
  target: PageTarget,
  picks: () => Readonly<Record<string, readonly number[]>>,
  change: () => PathEdit,
  options: InkPathEditOptions,
): Promise<Readonly<Record<string, readonly number[]>> | undefined> {
  return editLassoSelection(target, () => ({ paths: picks(), whole: [] }), change, {
    ...options,
    label: (counts) => options.label(counts.ink ?? 0),
  });
}

export interface LassoEditOptions extends Omit<InkPathEditOptions, 'label'> {
  /** The history label for an edit of what `counts` holds ("Recolor 3 strokes, 1 arrow"). */
  readonly label: (counts: KindCounts) => string;
}

/**
 * Edits what the lasso took on one page (craft spec §5.5) as one history entry: ink paths by
 * the rule of `editInkPaths` (`lasso/split.ts`), and annotations taken whole by
 * `lasso/whole.ts` (moved, recoloured, restyled or deleted in place; a change that does not
 * apply to a kind, such as a width for a note, leaves it out). `picks` and `change` are read
 * when the queued action runs. Locked, hidden, missing and never-lassoed annotations (links,
 * redaction marks) are skipped. Undo restores everything in one step. Resolves to where the
 * taken paths are afterwards (whole annotations keep their ids), or undefined when nothing
 * changed.
 */
export function editLassoSelection(
  target: PageTarget,
  picks: () => LassoPicks,
  change: () => PathEdit,
  options: LassoEditOptions,
): Promise<Readonly<Record<string, readonly number[]>> | undefined> {
  return runAction(
    async (ctx): Promise<ActionResult<Readonly<Record<string, readonly number[]>>> | undefined> => {
      const list = await readAnnotations(target.source, target.pageIndex, ctx);
      const edits: EngineEdit[] = [];
      const after: Record<string, readonly number[]> = {};
      const changed: Annotation[] = [];
      let strokes = 0;
      const pathEdit = change();
      const { paths, whole } = picks();
      for (const [id, indices] of patchTouchesInk(pathEdit) ? Object.entries(paths) : []) {
        const current = list.find((a) => a.id === id);
        if (current?.kind !== 'ink' || current.flags?.locked || current.flags?.hidden) continue;
        const outcome = splitInk(current, indices, pathEdit, newId());
        if (outcome.count === 0) continue;
        if (outcome.remove) {
          const done = await executeEdit(
            ctx,
            edit('annotation.delete', target.source, current.pageIndex, { annotationId: id }),
          );
          edits.push(done.recorded);
        }
        if (outcome.update && comparable(outcome.update) !== comparable(current)) {
          const annotation = await serializeAnnotation(stamped(outcome.update));
          const done = await executeEdit(
            ctx,
            edit('annotation.update', target.source, current.pageIndex, { annotation }),
          );
          edits.push(done.recorded);
        }
        if (outcome.create) {
          const done = await create(ctx, target.source, stamped(outcome.create));
          edits.push(done.recorded);
        }
        Object.assign(after, outcome.picks);
        strokes += outcome.count;
      }
      for (const id of whole) {
        const current = list.find((a) => a.id === id);
        if (!current || current.kind === 'ink' || !lassoable(current)) continue;
        if (pathEdit.kind === 'delete') {
          const done = await executeEdit(ctx, await deletion(ctx, target, current));
          edits.push(done.recorded);
          changed.push(current);
          continue;
        }
        const next = editWhole(current, pathEdit);
        if (!next || comparable(next) === comparable(current)) continue;
        const annotation = await serializeAnnotation(stamped({ ...next, id: current.id }));
        const done = await executeEdit(
          ctx,
          edit('annotation.update', target.source, current.pageIndex, { annotation }),
        );
        edits.push(done.recorded);
        changed.push(current);
      }
      if (edits.length === 0) return undefined;
      const label = options.label(kindCounts(strokes, changed));
      if (pathEdit.kind === 'delete') announce(label);
      options.onEdited?.(after);
      return {
        edits,
        label,
        value: after,
        ...(options.coalesceKey === undefined ? {} : { coalesceKey: options.coalesceKey }),
      };
    },
  );
}
