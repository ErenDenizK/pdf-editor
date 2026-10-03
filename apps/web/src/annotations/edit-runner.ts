/**
 * Executes annotation edits through the engine and keeps the engine in step with the
 * workspace history (spec §5).
 *
 * Edits are the engine's `EngineEdit` records (packages/engine/src/edits): JSON payloads
 * applied by `applyEngineEditWithResult`, which also computes each edit's inverse (delete
 * for a create, create-with-the-same-/NM for a delete, the previous annotation for an
 * update). Stamp images, which the engine inlines as base64, are kept once per content in
 * the workspace store (`editBlobs`) and the log refers to them as
 * `annotation.image = { blob, type }`; they are inlined again on the way to the engine.
 * The engine package is imported lazily (its own chunk), like the export pipeline does.
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
 * Text edits (`text.edit`, spec redaction-and-text-editing §2.5) share the queue, the log and
 * the replay, but have no inverse the engine can apply: PDFium cannot restore a content
 * stream, so their recorded inverse says "replay required" (`isReplayRequired`). Whenever
 * such an edit must be undone (a history move, or reverting a dropped action), the source
 * is reopened from its original bytes (`EngineService.reopenSource`) and the edits that
 * remain are replayed in order; redo simply applies the forward edit again. Replay
 * reproduces the same bytes (the applied payload records tier, face and size). The recorded
 * payload also carries the result's `honesty` and `fellBack` (`RecordedTextEditOutcome`),
 * which the editor ignores on replay and the export summary reports per source (spec §2.1,
 * §5.3). A recorded `redaction.apply` carries the captured strings too short to search
 * document-wide (`areaOnlyStrings`, `RedactionCapture.skipped`) for the same summary. OCR
 * runs (`ocr.apply`, spec recognize-and-compare §1.3) are replay-required too: their payload
 * holds the recognised words, so a replay rebuilds the same layer without recognising again.
 *
 * When a replay fails, the engine holds a prefix of the workspace's edits. User actions still
 * run (the next one tries the replay again), but `runExclusive` (export) refuses to run its
 * task on such an engine: it rejects with `EditsNotAppliedError` instead, so an export never
 * offers bytes that lack edits the history shows.
 *
 * Ids: the edit log records annotation ids as first created (the /NM the user saw). The
 * PDFium adapter writes a requested /NM, so a redone create keeps its id. Should an engine
 * answer with another id, `annotationIds` maps original → current and edits are
 * translated on their way to the engine, so the log and the UI keep the original id.
 */
import type { EngineEdit, SourceId, Workspace } from '@pdf-editor/document-model';
import type { Annotation, AppliedEdit, PdfEditor, TextEditResult } from '@pdf-editor/engine';

import { getEngineService } from '../engine/engine-service';
import { announce } from '../shell/announcer';
import { m } from '../i18n';
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

  /** Drops the ids of one source. */
  forgetSource(source: SourceId): void {
    const prefix = `${source}\u0000`;
    for (const map of [this.toEngine, this.toOriginal]) {
      for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
    }
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

// ---------------------------------------------------------------------------
// Stamp images: inline base64 (engine) <-> content-addressed blobs (log)
// ---------------------------------------------------------------------------

interface InlineImage {
  readonly type: string;
  readonly base64?: string;
  readonly blob?: string;
}

function payloadImage(edit: EngineEdit): InlineImage | undefined {
  const payload = edit.payload as { annotation?: { image?: InlineImage } } | null | undefined;
  return payload?.annotation?.image;
}

function withImage(edit: EngineEdit, image: InlineImage): EngineEdit {
  const payload = edit.payload as { annotation: Record<string, unknown> };
  return { ...edit, payload: { ...payload, annotation: { ...payload.annotation, image } } };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Blobs this runner stored during the running action (re-stored after its commit). */
let storedDuringAction: Map<string, Blob> | undefined;

/** Replaces inline base64 images by content-addressed blob references (edit and inverse). */
async function dehydrate(edit: EngineEdit): Promise<EngineEdit> {
  const inverse = edit.inverse ? await dehydrate(edit.inverse) : undefined;
  let out: EngineEdit =
    inverse === edit.inverse ? edit : { ...edit, ...(inverse ? { inverse } : {}) };
  const image = payloadImage(edit);
  if (image?.base64 !== undefined) {
    const bytes = Uint8Array.from(atob(image.base64), (c) => c.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const id = `edit-${Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')}`;
    const blob = new Blob([bytes], { type: image.type });
    useWorkspaceStore.getState().putEditBlob(id, blob);
    storedDuringAction?.set(id, blob);
    out = withImage(out, { type: image.type, blob: id });
  }
  return out;
}

/** Inlines blob-referenced images again for the engine (edit and inverse). */
async function hydrate(edit: EngineEdit): Promise<EngineEdit> {
  const inverse = edit.inverse ? await hydrate(edit.inverse) : undefined;
  let out: EngineEdit =
    inverse === edit.inverse ? edit : { ...edit, ...(inverse ? { inverse } : {}) };
  const image = payloadImage(edit);
  if (image?.blob !== undefined) {
    const blob = useWorkspaceStore.getState().editBlobs[image.blob];
    if (!blob) throw new Error(`Image ${image.blob} of edit ${edit.id} is no longer stored`);
    const base64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
    out = withImage(out, { type: image.type, base64 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Executing edits
// ---------------------------------------------------------------------------

/** What a recorded `text.edit` payload adds to `TextEditPayload`: the editor's outcome. */
export interface RecordedTextEditOutcome {
  readonly honesty: TextEditResult['honesty'];
  readonly fellBack: boolean;
}

/** What a recorded `redaction.apply` payload adds: captured strings kept to the areas. */
export interface RecordedRedactionOutcome {
  /** `RedactionCapture.skipped`: too short to search document-wide, removed in the areas only. */
  readonly areaOnlyStrings?: readonly string[];
}

/**
 * The recorded edit with what the engine's result says about it (see the module comment);
 * the engine reads only the fields it knows, so replay is unaffected.
 */
function withOutcome(edit: EngineEdit, result: AppliedEdit): EngineEdit {
  const payload = edit.payload as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== 'object') return edit;
  if (edit.kind === 'text.edit' && result.textEdit) {
    const outcome: RecordedTextEditOutcome = {
      honesty: result.textEdit.honesty,
      fellBack: result.textEdit.fellBack,
    };
    return { ...edit, payload: { ...payload, ...outcome } };
  }
  const skipped = result.redaction?.captured.skipped ?? [];
  if (edit.kind === 'redaction.apply' && skipped.length > 0) {
    const outcome: RecordedRedactionOutcome = { areaOnlyStrings: [...skipped] };
    return { ...edit, payload: { ...payload, ...outcome } };
  }
  return edit;
}

/** Result of executing an edit: the edit to record (with its inverse) and the annotation. */
export interface ExecutedEdit {
  readonly recorded: EngineEdit;
  readonly annotation?: Annotation;
  /** `text.edit`: the editor's result (tier, honesty, verification). */
  readonly textEdit?: TextEditResult;
}

/** Edits executed by the running action (reverted if it fails or is dropped). */
let executedDuringAction: EngineEdit[] | undefined;

/**
 * Executes one annotation edit through the engine. Returns the edit as applied (ids as
 * the log uses them) with its inverse, and the annotation as it now is (creates, updates).
 */
export async function executeEdit(ctx: EngineContext, edit: EngineEdit): Promise<ExecutedEdit> {
  const { applyEngineEditWithResult } = await import('@pdf-editor/engine');
  const source = edit.source;
  const toEngine = (id: string) => annotationIds.engineId(source, id);
  let result: Awaited<ReturnType<typeof applyEngineEditWithResult>> | undefined;
  try {
    result = await applyEngineEditWithResult(ctx.editor, mapIds(await hydrate(edit), toEngine));
  } finally {
    // Also after a refusal: the engine may have changed any part of the document then.
    if (changesContent(edit)) bumpRevision(source, result ? contentPagesOf(edit) : undefined);
  }
  const wanted = editAnnotationId(edit);
  if (edit.kind === 'annotation.create' && result.annotation) {
    // A create without an id takes the engine's; one with an id keeps it (or is mapped).
    annotationIds.set(source, wanted ?? result.annotation.id, result.annotation.id);
  }
  const toOriginal = (id: string) => annotationIds.originalId(source, id);
  const recorded = await dehydrate({
    ...withOutcome(mapIds(result.applied, toOriginal), result),
    inverse: mapIds(result.inverse, toOriginal),
  });
  executedDuringAction?.push(recorded);
  return {
    recorded,
    ...(result.annotation ? { annotation: toUi(source, result.annotation, ctx.fix) } : {}),
    ...(result.textEdit ? { textEdit: result.textEdit } : {}),
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

/**
 * The pages an edit changed: an OCR layer's pages and a redaction's area pages (their payloads
 * list them), the edit's page otherwise.
 */
function pagesOf(edit: EngineEdit): number[] {
  const payload = edit.payload as
    | { readonly pages?: unknown; readonly plan?: { readonly areas?: unknown } }
    | null
    | undefined;
  const list =
    edit.kind === 'ocr.apply'
      ? payload?.pages
      : edit.kind === 'redaction.apply'
        ? payload?.plan?.areas
        : undefined;
  const pages = new Set([edit.pageIndex]);
  for (const item of Array.isArray(list) ? (list as unknown[]) : []) {
    const pageIndex = (item as { readonly pageIndex?: unknown } | null)?.pageIndex;
    if (Number.isInteger(pageIndex)) pages.add(pageIndex as number);
  }
  return [...pages];
}

function pagesChanged(edits: readonly EngineEdit[]): void {
  const seen = new Map<string, { source: SourceId; pageIndex: number }>();
  const textChanged = new Set<string>();
  for (const edit of edits) {
    for (const pageIndex of pagesOf(edit)) {
      const key = `${edit.source}:${pageIndex}`;
      seen.set(key, { source: edit.source, pageIndex });
      // Content edits change the page's text (an OCR layer adds its words).
      if (changesContent(edit)) textChanged.add(key);
    }
  }
  if (seen.size === 0) return;
  const pages = [...seen.values()];
  const service = getEngineService();
  for (const page of pages) {
    // Drop the memoized text runs before views re-read.
    if (textChanged.has(`${page.source}:${page.pageIndex}`)) {
      service.invalidatePageText(page.source, page.pageIndex);
    }
    service.invalidatePage(page.source, page.pageIndex);
  }
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

/**
 * Content revisions: counters bumped once an engine mutation of page content has finished (an
 * executed content edit, refused or not, a reopen, the source closing). Annotations and form
 * values do not count: they are drawn apart from the page content. A mutation bumps the
 * counter of each page it changed when those pages are known (`contentPagesOf`), its source's
 * counter otherwise. Never reset, so a revision read before some work and compared later
 * (`contentChanged`) tells whether the engine's content of that page changed between.
 */
const sourceRevisions = new Map<SourceId, number>();
const pageRevisions = new Map<SourceId, Map<number, number>>();

function changesContent(edit: EngineEdit): boolean {
  return !(
    edit.kind.startsWith('annotation.') ||
    edit.kind === 'form.set-value' ||
    edit.kind === 'redaction.mark'
  );
}

/**
 * The source pages a content edit that the engine executed changed, or undefined when it may
 * have changed others too (the whole source then counts as changed):
 * - `text.edit`: its page (text in a Form XObject drawn more than once is refused, text-edit
 *   analysis `shared-form`);
 * - `image.*`: its page for an image the page draws itself; one inside a Form XObject changes
 *   the form, which other pages may draw;
 * - `ocr.apply`: the pages of the layer (invisible text on each page's own resources);
 * - `redaction.apply`: none known: image pixels under an area are whitened in the image
 *   XObject itself and paths are removed inside Form XObjects in place, and other pages may
 *   draw both (research 06 §2 (e), engine redaction/engine-pass.ts).
 */
function contentPagesOf(edit: EngineEdit): readonly number[] | undefined {
  switch (edit.kind) {
    case 'text.edit':
    case 'text.editParagraph':
      return [edit.pageIndex];
    case 'image.transform':
    case 'image.remove':
    case 'image.replace': {
      const payload = edit.payload as { readonly image?: { readonly objectPath?: unknown } } | null;
      const path = payload?.image?.objectPath;
      return Array.isArray(path) && path.length === 1 ? [edit.pageIndex] : undefined;
    }
    case 'ocr.apply':
      return pagesOf(edit);
    default:
      return undefined;
  }
}

/** Bumps the revision of `pages` of `source`, or the source's own without them. */
function bumpRevision(source: SourceId, pages?: readonly number[]): void {
  if (pages === undefined) {
    sourceRevisions.set(source, (sourceRevisions.get(source) ?? 0) + 1);
    return;
  }
  let perPage = pageRevisions.get(source);
  if (!perPage) {
    perPage = new Map();
    pageRevisions.set(source, perPage);
  }
  for (const pageIndex of pages) perPage.set(pageIndex, (perPage.get(pageIndex) ?? 0) + 1);
}

/** A source page's content revision: its source's counter and the page's own. */
export interface ContentRevision {
  readonly source: number;
  readonly page: number;
}

/**
 * The content revision of a source page (see `sourceRevisions`). Work reading the engine
 * outside the queue (OCR renders pages while edits go on, ocr/ocr-run.ts) reads it before it
 * starts; inside a `runAction` action, `contentChanged` false means the engine's content of
 * the page is still the one that work read: every mutation queued before the first read had
 * finished by then, or its bump came after it and changed one of the counters.
 */
export function contentRevision(source: SourceId, pageIndex: number): ContentRevision {
  return {
    source: sourceRevisions.get(source) ?? 0,
    page: pageRevisions.get(source)?.get(pageIndex) ?? 0,
  };
}

/** Whether the page's content changed since `revision` (the whole source or the page). */
export function contentChanged(
  source: SourceId,
  pageIndex: number,
  revision: ContentRevision,
): boolean {
  const now = contentRevision(source, pageIndex);
  return now.source !== revision.source || now.page !== revision.page;
}

function annotationEdits(ws: Workspace): Map<SourceId, EngineEdit[]> {
  const bySource = new Map<SourceId, EngineEdit[]>();
  for (const edit of ws.engineEdits) {
    // Form fills (forms/actions.ts) and text edits (text-edit/actions.ts) share the queue
    // and the replay.
    if (
      !edit.kind.startsWith('annotation.') &&
      edit.kind !== 'form.set-value' &&
      edit.kind !== 'text.edit' &&
      // Paragraph edits (text-edit/actions.ts, craft spec §4.4): replay-required likewise.
      edit.kind !== 'text.editParagraph' &&
      // Applied redactions (redaction/apply.ts): replay-required like text edits.
      edit.kind !== 'redaction.apply' &&
      // Image objects (image-objects/actions.ts): removal and replacement are replay-required.
      !edit.kind.startsWith('image.') &&
      // OCR runs (ocr/ocr-run.ts): replay-required like redactions.
      edit.kind !== 'ocr.apply'
    ) {
      continue;
    }
    const list = bySource.get(edit.source);
    if (list) list.push(edit);
    else bySource.set(edit.source, [edit]);
  }
  return bySource;
}

/** Runs `edit` through the engine; false (after a warning) when the engine refused it. */
async function tryEdit(ctx: EngineContext, edit: EngineEdit | undefined): Promise<boolean> {
  if (!edit) return false;
  try {
    await executeEdit(ctx, edit);
    return true;
  } catch (error) {
    console.warn(`Replaying ${edit.kind} ${edit.id} failed`, error);
    return false;
  }
}

/** Whether undoing `edits` needs a reopen: one of them has a replay-required inverse. */
async function needsReopen(edits: readonly EngineEdit[]): Promise<boolean> {
  const replayKinds = [
    'text.edit',
    'text.editParagraph',
    'redaction.apply',
    'image.remove',
    'image.replace',
    'ocr.apply',
  ];
  if (!edits.some((edit) => replayKinds.includes(edit.kind))) {
    return false;
  }
  const { isReplayRequired } = await import('@pdf-editor/engine');
  return edits.some((edit) => edit.inverse === undefined || isReplayRequired(edit.inverse));
}

/**
 * Reopens `source` from its original bytes and replays `edits` in order (spec §2.5 undo).
 * Resolves to the edits the engine now holds; `ok` is false when the reopen or a replayed
 * edit failed (the engine then holds the prefix that did apply, or, when the reopen
 * failed, an unknown state that the next reconcile treats as the original).
 */
async function rebuild(
  ctx: EngineContext,
  source: SourceId,
  edits: readonly EngineEdit[],
): Promise<{ readonly state: readonly EngineEdit[]; readonly ok: boolean }> {
  const reopened = await getEngineService().reopenSource(source);
  bumpRevision(source);
  // The reopened document knows none of the ids the engine answered before.
  annotationIds.forgetSource(source);
  if (!reopened.ok) {
    console.warn(`Reopening ${source} for undo failed`, reopened.error);
    return { state: [], ok: false };
  }
  let state: readonly EngineEdit[] = [];
  for (const edit of edits) {
    if (!(await tryEdit(ctx, edit))) return { state, ok: false };
    state = [...state, edit];
  }
  return { state, ok: true };
}

/** Keeps the store's `dirtySources` equal to the sources the engine holds edits for. */
function syncDirtySources(): void {
  const dirty = new Set<SourceId>();
  for (const [source, edits] of applied) if (edits.length > 0) dirty.add(source);
  const current = useWorkspaceStore.getState().dirtySources;
  if (current.size === dirty.size && [...dirty].every((id) => current.has(id))) return;
  useWorkspaceStore.setState({ dirtySources: dirty });
}

/**
 * Brings the engine to the workspace's edits (see the module comment). When the engine
 * refuses a step, `applied` records exactly what it did apply and the user is told; the
 * next action, history move or export tries again. Resolves to whether the engine now holds
 * exactly the workspace's edits for every source of the workspace (false after a refused
 * step, or when the history moved while the replay ran).
 */
async function reconcileNow(ctx: EngineContext): Promise<boolean> {
  const ws = useWorkspaceStore.getState().workspace;
  const target = annotationEdits(ws);
  const touched: EngineEdit[] = [];
  let failed = false;
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
    let state: readonly EngineEdit[] = current;
    let ok = true;
    if (await needsReopen(current.slice(common))) {
      // A text edit must go: reopen the original bytes and replay what remains.
      touched.push(...current);
      const rebuilt = await rebuild(ctx, source, wanted);
      touched.push(...rebuilt.state);
      applied.set(source, rebuilt.state);
      if (!rebuilt.ok) failed = true;
      continue;
    }
    for (let i = current.length - 1; i >= common && ok; i--) {
      const edit = current[i] as EngineEdit;
      touched.push(edit);
      ok = await tryEdit(ctx, edit.inverse);
      if (ok) state = current.slice(0, i);
    }
    for (let i = common; i < wanted.length && ok; i++) {
      const edit = wanted[i] as EngineEdit;
      touched.push(edit);
      ok = await tryEdit(ctx, edit);
      if (ok) state = wanted.slice(0, i + 1);
    }
    if (!ok) failed = true;
    applied.set(source, state);
  }
  syncDirtySources();
  pagesChanged(touched);
  if (failed) {
    announce(m.annot_replay_failed());
    return false;
  }
  return sameAsApplied(useWorkspaceStore.getState().workspace);
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
  /** Replaces the history's 800 ms coalescing window (a pen burst decides on joining itself). */
  readonly coalesceWindowMs?: number;
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

/** Identity of the history position (not of the present snapshot, which tab changes replace). */
function historyPosition(): string {
  const { history } = useWorkspaceStore.getState();
  return `${history.past.length}:${history.future.length}:${history.present.at}:${history.present.label}`;
}

/**
 * Undoes executed edits (newest first) and reports the pages they touched. A source whose
 * executed edits include a text edit is reopened and brought back to the edits the engine
 * held before the action (`applied`).
 */
async function revert(ctx: EngineContext, edits: readonly EngineEdit[]): Promise<void> {
  const reopen = new Set<SourceId>();
  for (const source of new Set(edits.map((edit) => edit.source))) {
    if (await needsReopen(edits.filter((edit) => edit.source === source))) reopen.add(source);
  }
  const touched: EngineEdit[] = [...edits];
  for (const edit of [...edits].reverse()) {
    if (!reopen.has(edit.source)) await tryEdit(ctx, edit.inverse);
  }
  for (const source of reopen) {
    const before = applied.get(source) ?? [];
    const rebuilt = await rebuild(ctx, source, before);
    touched.push(...before);
    applied.set(source, rebuilt.state);
    if (!rebuilt.ok) announce(m.annot_replay_failed());
  }
  if (reopen.size > 0) syncDirtySources();
  pagesChanged(touched);
}

/**
 * Runs a user action in the queue: the engine first catches up with the history, then
 * `action` executes its edits through the engine and returns them; they are committed as
 * one history entry. The edits are reverted in the engine, and nothing is committed, when
 * the action throws (the error is passed on), when the commit fails, or when the history
 * moved while the action ran (e.g. Mod+Z during a drag): committing then would land on
 * the wrong history. Resolves to the action's value, or undefined when nothing was
 * committed.
 */
export function runAction<T>(
  action: (ctx: EngineContext) => Promise<ActionResult<T> | undefined>,
): Promise<T | undefined> {
  return enqueue(async () => {
    const ctx = await engineContext();
    await reconcileNow(ctx);
    const position = historyPosition();
    const executed: EngineEdit[] = [];
    const stored = new Map<string, Blob>();
    executedDuringAction = executed;
    storedDuringAction = stored;
    let result: ActionResult<T> | undefined;
    try {
      result = await action(ctx);
    } catch (error) {
      executedDuringAction = undefined;
      storedDuringAction = undefined;
      await revert(ctx, executed);
      announce(m.annot_action_failed());
      throw error;
    } finally {
      executedDuringAction = undefined;
      storedDuringAction = undefined;
    }
    if (!result || result.edits.length === 0) {
      if (executed.length > 0) await revert(ctx, executed);
      return undefined;
    }
    if (historyPosition() !== position) {
      await revert(ctx, executed);
      return undefined;
    }
    // Blobs stored meanwhile may have been collected by another operation's commit.
    for (const [id, blob] of stored) useWorkspaceStore.getState().putEditBlob(id, blob);
    let mergedFrom: EngineEdit | undefined;
    committing = true;
    let ok: boolean;
    try {
      ok = useWorkspaceStore.getState().applyEngineEdit(result.edits, result.label, {
        ...(result.coalesceKey === undefined ? {} : { coalesceKey: result.coalesceKey }),
        ...(result.coalesceWindowMs === undefined
          ? {}
          : { coalesceWindowMs: result.coalesceWindowMs }),
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
      await revert(ctx, executed);
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
    syncDirtySources();
    pagesChanged(result.edits);
    const ws = useWorkspaceStore.getState().workspace;
    if (!sameAsApplied(ws)) void scheduleReconcile();
    return result.value;
  });
}

/** The engine could not be brought to the workspace's edits: an exclusive task did not run. */
export class EditsNotAppliedError extends Error {
  override readonly name = 'EditsNotAppliedError';

  constructor() {
    super(m.export_error_edits_not_applied());
  }
}

/**
 * Runs `task` with the engine in step with the workspace and no annotation edit able to
 * run meanwhile: export reads annotation counts and saves sources inside it. Rejects with
 * `EditsNotAppliedError`, without running `task`, when the replay failed and the engine
 * does not hold every edit of the workspace (a task reading the engine would see a state
 * the history does not show). The replay is tried again on every call, so a transient
 * failure heals.
 */
export function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  return enqueue(async () => {
    const ctx = await engineContext();
    // A history move while the replay ran leaves the engine behind without any failure:
    // catch up (bounded); a refused step fails at once.
    for (let attempt = 0; ; attempt++) {
      const edits = useWorkspaceStore.getState().workspace.engineEdits;
      if (await reconcileNow(ctx)) break;
      const moved = useWorkspaceStore.getState().workspace.engineEdits !== edits;
      if (!moved || attempt >= 2) throw new EditsNotAppliedError();
    }
    return task();
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

/** Forgets a closed source: its edit state and id map (the engine document is gone). */
function forgetSource(source: SourceId): void {
  bumpRevision(source);
  applied.delete(source);
  annotationIds.forgetSource(source);
  syncDirtySources();
}

getEngineService().onSourceClosed(forgetSource);

/** Ids of the edits the engine holds for a source (diagnostics and tests). */
export function appliedEditIds(source: SourceId): string[] {
  return (applied.get(source) ?? []).map((edit) => edit.id);
}

/**
 * The edits the engine holds for a source, oldest first, as recorded (export: the summary
 * counts what the saved bytes contain, not what the history lists).
 */
export function appliedEdits(source: SourceId): readonly EngineEdit[] {
  return applied.get(source) ?? [];
}

/** Tests: forget everything the engine was told (after `resetWorkspace`). */
export function resetEditRunner(): void {
  applied.clear();
  annotationIds.clear();
  context = undefined;
}
