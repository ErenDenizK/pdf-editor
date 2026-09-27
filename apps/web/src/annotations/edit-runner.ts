/**
 * Executes annotation edits through the engine and keeps the engine in step with the
 * workspace history (spec §5).
 *
 * Edits are the engine's `EngineEdit` records (packages/engine/src/edits): JSON payloads
 * (stamp images inline as base64) applied by `applyEngineEditWithResult`, which also
 * computes each edit's inverse (delete for a create, create-with-the-same-/NM for a
 * delete, the previous annotation for an update).
 *
 * The workspace history is a stack of model snapshots and `Workspace.engineEdits` lists
 * the content edits of each snapshot, but the PDFium document has exactly one state. This
 * module tracks which edits the engine has executed per source (`applied`) and, whenever
 * the workspace's edits differ (undo, redo, jump, closing a document), replays the
 * difference: the inverses of the edits only the engine has (newest first), then the
 * edits only the workspace has.
 *
 * Every engine mutation runs in one serial queue, so a user action (read the current
 * annotation, change it, commit one history entry) never interleaves with a replay.
 *
 * Ids: the edit log records annotation ids as first created (the /NM the user saw). The
 * PDFium adapter writes a requested /NM, so a redone create keeps its id. Should an engine
 * answer with another id, `annotationIds` maps original → current and edits are
 * translated on their way to the engine, so the log and the UI keep the original id.
 */
import type { EngineEdit, SourceId, Workspace } from '@pdf-editor/document-model';
import { type Annotation, applyEngineEditWithResult, type PdfEditor } from '@pdf-editor/engine';

import { getEngineService } from '../engine/engine-service';
import { useWorkspaceStore } from '../state/workspace-store';
import { type RectFix, rotatedRectFix } from './engine-quirks';

/** The annotation id an edit addresses (create / update payload id, delete id). */
export function editAnnotationId(edit: EngineEdit): string | undefined {
  const payload = edit.payload as
    | { annotation?: { id?: unknown }; annotationId?: unknown }
    | null
    | undefined;
  const id = payload?.annotation?.id ?? payload?.annotationId;
  return typeof id === 'string' ? id : undefined;
}

/** The edit (and its inverse) with annotation ids rewritten by `map`. */
function mapIds(edit: EngineEdit, map: (id: string) => string): EngineEdit {
  const payload = edit.payload as
    | { annotation?: { id?: unknown }; annotationId?: unknown }
    | null
    | undefined;
  let next: unknown = payload;
  if (payload && typeof payload.annotation?.id === 'string') {
    const id = map(payload.annotation.id);
    if (id !== payload.annotation.id)
      next = { ...payload, annotation: { ...payload.annotation, id } };
  } else if (payload && typeof payload.annotationId === 'string') {
    const id = map(payload.annotationId);
    if (id !== payload.annotationId) next = { ...payload, annotationId: id };
  }
  const inverse = edit.inverse ? mapIds(edit.inverse, map) : undefined;
  if (next === payload && inverse === edit.inverse) return edit;
  return { ...edit, payload: next, ...(inverse ? { inverse } : {}) };
}

/** Original id ↔ current engine id, per source (identity while the engine keeps ids). */
export class AnnotationIdMap {
  private readonly toEngine = new Map<string, string>();
  private readonly toOriginal = new Map<string, string>();

  private key(source: SourceId, id: string): string {
    return `${source}\u0000${id}`;
  }

  /** The id the engine currently knows for an original id. */
  engineId(source: SourceId, original: string): string {
    return this.toEngine.get(this.key(source, original)) ?? original;
  }

  /** The original id of an engine id (the id the UI and the edit log use). */
  originalId(source: SourceId, engine: string): string {
    return this.toOriginal.get(this.key(source, engine)) ?? engine;
  }

  /** Records that the annotation first created as `original` now has `engine` as its id. */
  set(source: SourceId, original: string, engine: string): void {
    const previous = this.toEngine.get(this.key(source, original));
    if (previous !== undefined) this.toOriginal.delete(this.key(source, previous));
    if (original === engine) {
      this.toEngine.delete(this.key(source, original));
      return;
    }
    this.toEngine.set(this.key(source, original), engine);
    this.toOriginal.set(this.key(source, engine), original);
  }

  /** Number of remapped ids (diagnostics and tests). */
  get size(): number {
    return this.toEngine.size;
  }

  clear(): void {
    this.toEngine.clear();
    this.toOriginal.clear();
  }
}

export const annotationIds = new AnnotationIdMap();

// ---------------------------------------------------------------------------
// Engine access with the page facts the mapping needs
// ---------------------------------------------------------------------------

function quarterTurns(source: SourceId, pageIndex: number): number {
  const rotation =
    useWorkspaceStore.getState().workspace.sources[source]?.pages[pageIndex]?.rotation;
  return ((rotation ?? 0) / 90) & 3;
}

/** The engine's annotation as the UI sees it: original id, rect corrected if needed. */
export function toUi(source: SourceId, a: Annotation, fix: RectFix): Annotation {
  const turns = quarterTurns(source, a.pageIndex);
  const rect = turns === 0 ? a.rect : fix(a.rect, turns);
  const id = annotationIds.originalId(source, a.id);
  return rect === a.rect && id === a.id ? a : { ...a, id, rect };
}

export interface EngineContext {
  readonly editor: PdfEditor;
  readonly fix: RectFix;
}

let context: Promise<EngineContext> | undefined;

/** The editor plus probed quirks; created once. */
export function engineContext(): Promise<EngineContext> {
  context ??= (async () => {
    const editor = await getEngineService().editor();
    return { editor, fix: await rotatedRectFix(editor) };
  })();
  context.catch(() => {
    context = undefined;
  });
  return context;
}

/** Annotations of one source page, with original ids. */
export async function readAnnotations(
  source: SourceId,
  pageIndex: number,
  ctx?: EngineContext,
): Promise<readonly Annotation[]> {
  const { editor, fix } = ctx ?? (await engineContext());
  const list = await editor.listAnnotations(source, pageIndex);
  return list.map((a) => toUi(source, a, fix));
}

/** Result of executing an edit: the edit to record (with its inverse) and the annotation. */
export interface ExecutedEdit {
  readonly recorded: EngineEdit;
  readonly annotation?: Annotation;
}

/**
 * Executes one annotation edit through the engine. Returns the edit as applied (ids as
 * the log uses them) with its inverse, and the annotation as it now is (creates, updates).
 */
export async function executeEdit(ctx: EngineContext, edit: EngineEdit): Promise<ExecutedEdit> {
  const source = edit.source;
  const toEngine = (id: string) => annotationIds.engineId(source, id);
  const result = await applyEngineEditWithResult(ctx.editor, mapIds(edit, toEngine));
  const wanted = editAnnotationId(edit);
  if (edit.kind === 'annotation.create' && result.annotation) {
    // A create without an id takes the engine's; one with an id keeps it (or is mapped).
    annotationIds.set(source, wanted ?? result.annotation.id, result.annotation.id);
  }
  const toOriginal = (id: string) => annotationIds.originalId(source, id);
  const recorded: EngineEdit = {
    ...mapIds(result.applied, toOriginal),
    inverse: mapIds(result.inverse, toOriginal),
  };
  return {
    recorded,
    ...(result.annotation ? { annotation: toUi(source, result.annotation, ctx.fix) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Page change notifications
// ---------------------------------------------------------------------------

type PagesListener = (pages: readonly { source: SourceId; pageIndex: number }[]) => void;
const pageListeners = new Set<PagesListener>();

/** Called after engine edits changed pages (created, replayed or undone). */
export function onPagesChanged(listener: PagesListener): () => void {
  pageListeners.add(listener);
  return () => {
    pageListeners.delete(listener);
  };
}

function pagesChanged(edits: readonly EngineEdit[]): void {
  const seen = new Map<string, { source: SourceId; pageIndex: number }>();
  for (const edit of edits) {
    seen.set(`${edit.source}:${edit.pageIndex}`, {
      source: edit.source,
      pageIndex: edit.pageIndex,
    });
  }
  if (seen.size === 0) return;
  const pages = [...seen.values()];
  const service = getEngineService();
  for (const page of pages) service.invalidatePage(page.source, page.pageIndex);
  for (const listener of pageListeners) listener(pages);
}

// ---------------------------------------------------------------------------
// Queue and reconciliation
// ---------------------------------------------------------------------------

let queue: Promise<unknown> = Promise.resolve();

/** Runs `task` after every engine mutation queued before it. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** Edits the engine has executed, per source, oldest first. */
const applied = new Map<SourceId, readonly EngineEdit[]>();

function annotationEdits(ws: Workspace): Map<SourceId, EngineEdit[]> {
  const bySource = new Map<SourceId, EngineEdit[]>();
  for (const edit of ws.engineEdits) {
    if (!edit.kind.startsWith('annotation.')) continue;
    const list = bySource.get(edit.source);
    if (list) list.push(edit);
    else bySource.set(edit.source, [edit]);
  }
  return bySource;
}

async function runLogged(ctx: EngineContext, edit: EngineEdit | undefined, touched: EngineEdit[]) {
  if (!edit) return;
  touched.push(edit);
  try {
    await executeEdit(ctx, edit);
  } catch (error) {
    console.warn(`Replaying ${edit.kind} ${edit.id} failed`, error);
  }
}

/** Brings the engine to the workspace's edits (see the module comment). */
async function reconcileNow(ctx: EngineContext): Promise<void> {
  const ws = useWorkspaceStore.getState().workspace;
  const target = annotationEdits(ws);
  const touched: EngineEdit[] = [];
  for (const source of new Set([...applied.keys(), ...target.keys()])) {
    // A source out of the workspace (its document closed) keeps its engine state: undo
    // may bring it back, and then nothing needs replaying.
    if (ws.sources[source] === undefined) continue;
    const current = applied.get(source) ?? [];
    const wanted = target.get(source) ?? [];
    let common = 0;
    while (
      common < current.length &&
      common < wanted.length &&
      current[common]?.id === wanted[common]?.id
    ) {
      common += 1;
    }
    for (let i = current.length - 1; i >= common; i--) {
      const edit = current[i];
      if (edit && !edit.inverse) console.warn(`Edit ${edit.id} has no inverse`);
      await runLogged(ctx, edit?.inverse, touched);
    }
    for (let i = common; i < wanted.length; i++) await runLogged(ctx, wanted[i], touched);
    applied.set(source, wanted);
  }
  pagesChanged(touched);
}

let reconcileQueued = false;

/** Schedules a replay after the queued work (coalesces bursts of history moves). */
export function scheduleReconcile(): Promise<void> {
  if (reconcileQueued) return queue.then(() => undefined);
  reconcileQueued = true;
  return enqueue(async () => {
    reconcileQueued = false;
    await reconcileNow(await engineContext());
  });
}

/** Resolves once every queued engine edit and replay has finished (tests, export). */
export function whenIdle(): Promise<void> {
  return queue.then(() => undefined);
}

let committing = false;

export interface ActionResult<T> {
  /** Edits the engine has executed, in order. */
  readonly edits: readonly EngineEdit[];
  readonly label: string;
  readonly coalesceKey?: string;
  readonly value: T;
}

/** Merges consecutive updates of one annotation (coalesced drags and sliders). */
export function mergeUpdates(previous: EngineEdit, next: EngineEdit): EngineEdit | undefined {
  if (
    previous.kind !== 'annotation.update' ||
    next.kind !== 'annotation.update' ||
    previous.source !== next.source ||
    editAnnotationId(previous) !== editAnnotationId(next) ||
    previous.inverse === undefined
  ) {
    return undefined;
  }
  return { ...next, inverse: previous.inverse };
}

/**
 * Runs a user action in the queue: the engine first catches up with the history, then
 * `action` executes its edits through the engine and returns them; they are committed as
 * one history entry. If the commit fails, the edits are reverted in the engine. Resolves
 * to the action's value, or undefined when nothing was committed.
 */
export function runAction<T>(
  action: (ctx: EngineContext) => Promise<ActionResult<T> | undefined>,
): Promise<T | undefined> {
  return enqueue(async () => {
    const ctx = await engineContext();
    await reconcileNow(ctx);
    const result = await action(ctx);
    if (!result || result.edits.length === 0) return undefined;
    let mergedFrom: EngineEdit | undefined;
    committing = true;
    let ok: boolean;
    try {
      ok = useWorkspaceStore.getState().applyEngineEdit(result.edits, result.label, {
        ...(result.coalesceKey === undefined ? {} : { coalesceKey: result.coalesceKey }),
        merge: (previous, next) => {
          const merged = mergeUpdates(previous, next);
          if (merged) mergedFrom = previous;
          return merged;
        },
      });
    } finally {
      committing = false;
    }
    if (!ok) {
      const touched: EngineEdit[] = [];
      for (const edit of [...result.edits].reverse()) await runLogged(ctx, edit.inverse, touched);
      pagesChanged(touched);
      return undefined;
    }
    // Record what the engine now has. A merged update replaces the edit it merged with
    // when that edit is the engine's last one (the state is the same either way).
    for (const edit of result.edits) {
      const list = applied.get(edit.source) ?? [];
      const last = list[list.length - 1];
      const final =
        mergedFrom !== undefined && last?.id === mergedFrom.id
          ? [...list.slice(0, -1), ...mergeWith(mergedFrom, edit)]
          : [...list, edit];
      applied.set(edit.source, final);
    }
    pagesChanged(result.edits);
    // The history may have moved while the engine worked (undo during a drag).
    const ws = useWorkspaceStore.getState().workspace;
    if (!sameAsApplied(ws)) void scheduleReconcile();
    return result.value;
  });
}

function mergeWith(previous: EngineEdit, edit: EngineEdit): EngineEdit[] {
  const merged = mergeUpdates(previous, edit);
  return merged ? [merged] : [previous, edit];
}

function sameAsApplied(ws: Workspace): boolean {
  const target = annotationEdits(ws);
  for (const source of new Set([...applied.keys(), ...target.keys()])) {
    if (ws.sources[source] === undefined) continue;
    const a = applied.get(source) ?? [];
    const b = target.get(source) ?? [];
    if (a.length !== b.length || a.some((edit, i) => edit.id !== b[i]?.id)) return false;
  }
  return true;
}

// Undo, redo, history jumps and closing documents change the workspace's edits.
useWorkspaceStore.subscribe((state, previous) => {
  if (committing || state.workspace.engineEdits === previous.workspace.engineEdits) return;
  if (!sameAsApplied(state.workspace)) void scheduleReconcile();
});

/** Tests: forget everything the engine was told (after `resetWorkspace`). */
export function resetEditRunner(): void {
  applied.clear();
  annotationIds.clear();
  context = undefined;
}
