/**
 * "Crop pages…" bound to the stores (M4 §3): the crop is the model's per-page `cropBox`
 * (unrotated user space, `setPageCropBox`), written as /CropBox by the assembler. A crop
 * only hides content: any viewer can undo it. "Also remove the content outside the crop"
 * runs the redaction pipeline (redaction/apply.ts, `applyRedactionPlans`) on the bands
 * outside each crop, with its gate and forensic self-check, and joins the crop to the same
 * history entry (both are committed under one coalesce key: the engine edits first, the
 * model change right after). When the redaction is stopped the crop is not applied either.
 *
 * Also the Read-mode drawing lifecycle of the dialog's "Draw crop area" (crop-store.ts).
 */
import {
  type DocumentId,
  findPageLocation,
  type PageId,
  pageDisplaySize,
  pagesOfSize,
  pageTotalRotation,
  type Rect,
  type Size,
  type SourceId,
  type Workspace,
} from '@pdf-editor/document-model';

import { m } from '../i18n';
import {
  type ApplyOutcome,
  applyRedactionPlans,
  markInAreas,
  type PlannedRedaction,
} from '../redaction/apply';
import { collectMarks } from '../redaction/redaction-store';
import { announce } from '../shell/announcer';
import {
  closeOperationDialog,
  openOperationDialog,
  useOperationDialogStore,
} from '../stage/operation-dialogs-store';
import { isPageView, useUiStore } from '../state/ui-store';
import { pagesPhrase, useWorkspaceStore } from '../state/workspace-store';
import { goToPageIndex } from '../viewer/navigation';
import { type CropDraft, type CropScope, isCropWorking, useCropStore } from './crop-store';
import { pageBoxOf } from './display';
import {
  clampRect,
  discardBands,
  isNoCrop,
  type Margins,
  marginsFromCrop,
  roundMargins,
  unionRects,
} from './geometry';
import {
  type CropPlan,
  findPage,
  type PageCrop,
  planCrops as planCropsWith,
  withCrops,
} from './plan';

// The pure planning lives in plan.ts (shared with the batch runner); re-exported here.
export { type CropPlan, type PageCrop, withCrops } from './plan';

/**
 * What displayed `margins` do to each of `pageIds` (plan.ts `planCrops`), with the page
 * boxes of the open sources (`pageBoxOf`: the engine service's CropBoxes).
 */
export function planCrops(ws: Workspace, pageIds: readonly PageId[], margins: Margins): CropPlan {
  return planCropsWith(ws, pageIds, margins, pageBoxOf);
}

const model = () => useWorkspaceStore.getState();

/** Fill of the discarded bands: paper white, so they look like the page they were. */
export const DISCARD_FILL = '#ffffff';

/** The pages a scope covers, in document order (`reference`: the "same size" size). */
export function scopePages(
  ws: Workspace,
  documentId: DocumentId,
  scope: CropScope,
  selection: readonly PageId[],
  reference: Size | undefined,
): PageId[] {
  const doc = ws.documents[documentId];
  if (doc === undefined) return [];
  switch (scope) {
    case 'selection':
      return selection.filter((id) => findPage(ws, id) !== undefined);
    case 'document':
      return doc.pages.map((p) => p.id);
    case 'same-size':
      return reference === undefined ? [] : pagesOfSize(ws, documentId, reference);
  }
}

export interface DiscardPlan {
  readonly plans: readonly PlannedRedaction[];
  /**
   * Source pages where less is removed than the crop hides, because another page (a
   * duplicate, or the same page in another document) shows more of it.
   */
  readonly shared: number;
}

/**
 * The redaction plans that remove what the crops hide: per source page, the bands of its
 * page box outside what any page showing it keeps visible after the crops (the new crops
 * for the cropped pages, the current visible box for every other page). Areas are in the
 * source's page indices and unrotated user space; the fill is white; no overlay text and
 * no strings (area only: the same words may stand inside the crop).
 */
export function planDiscard(ws: Workspace, crops: readonly PageCrop[]): DiscardPlan {
  const next = new Map(crops.map((c) => [c.pageId, c.crop]));
  const key = (source: SourceId, index: number) => `${source}#${index}`;
  const wanted = new Map<string, { source: SourceId; index: number; box: Rect }>();
  for (const { pageId, crop } of crops) {
    if (crop === undefined) continue;
    const page = findPage(ws, pageId);
    if (page?.ref.kind !== 'source') continue;
    wanted.set(key(page.ref.source, page.ref.index), {
      source: page.ref.source,
      index: page.ref.index,
      box: pageBoxOf(page),
    });
  }
  // Everything shown of each wanted source page, by any page of the workspace.
  const kept = new Map<string, Rect[]>();
  const cropped = new Map<string, Rect[]>();
  for (const docId of ws.documentOrder) {
    for (const page of ws.documents[docId]?.pages ?? []) {
      if (page.ref.kind !== 'source') continue;
      const k = key(page.ref.source, page.ref.index);
      const target = wanted.get(k);
      if (target === undefined) continue;
      const shown = next.has(page.id) ? next.get(page.id) : page.cropBox;
      const visible = clampRect(shown ?? target.box, target.box) ?? target.box;
      kept.set(k, [...(kept.get(k) ?? []), visible]);
      if (next.get(page.id) !== undefined) {
        cropped.set(k, [...(cropped.get(k) ?? []), visible]);
      }
    }
  }
  const areas = new Map<SourceId, { pageIndex: number; rect: Rect }[]>();
  let shared = 0;
  for (const [k, target] of wanted) {
    const keep = unionRects(kept.get(k) ?? []) ?? target.box;
    const hidden = unionRects(cropped.get(k) ?? []);
    if (hidden !== undefined && !sameRect(keep, hidden)) shared++;
    const bands = discardBands(target.box, keep);
    if (bands.length === 0) continue;
    const list = areas.get(target.source) ?? [];
    for (const rect of bands) list.push({ pageIndex: target.index, rect });
    areas.set(target.source, list);
  }
  const plans: PlannedRedaction[] = [...areas].map(([source, list]) => ({
    source,
    plan: { areas: list, strings: [], fillColor: DISCARD_FILL },
  }));
  return { plans, shared };
}

/**
 * Redaction marks (listed ones, from the loaded pages) that reach into the areas `plans`
 * remove: the discard deletes them instead of creating them again (redaction/apply.ts),
 * so the dialog warns first. A source page shown twice counts its marks once.
 */
export function marksOutsideCrop(
  ws: Workspace,
  pages: Parameters<typeof collectMarks>[1],
  plans: readonly PlannedRedaction[],
): number {
  const found = new Set<string>();
  for (const entry of collectMarks(ws, pages).entries) {
    const plan = plans.find((p) => p.source === entry.source);
    if (plan !== undefined && markInAreas(entry.mark, plan.plan.areas)) found.add(entry.markKey);
  }
  return found.size;
}

function sameRect(a: Rect, b: Rect): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) < 0.01;
  return near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
}

export type CropOutcome =
  /** Crop only (or the discard found nothing to remove): whether the model changed. */
  | { readonly kind: 'cropped'; readonly committed: boolean }
  /** With discard: the redaction's outcome (the result sheet) and whether the crop landed. */
  | { readonly kind: 'discarded'; readonly outcome: ApplyOutcome; readonly committed: boolean };

/** History label of a crop of `count` pages. */
export function cropLabel(count: number, options: { clear: boolean; discard: boolean }): string {
  const pages = pagesPhrase(count);
  if (options.clear) return m.history_crop_reset({ pages });
  return options.discard ? m.history_crop_discard({ pages }) : m.history_crop({ pages });
}

/**
 * Crops `pageIds` by displayed `margins` as one history entry (see the module comment);
 * with `discard`, the content outside the crops is removed first. Never rejects.
 */
export async function cropPages(
  pageIds: readonly PageId[],
  margins: Margins,
  options: { readonly discard: boolean },
): Promise<CropOutcome> {
  const ws = model().workspace;
  const { crops } = planCrops(ws, pageIds, margins);
  if (crops.length === 0) return { kind: 'cropped', committed: false };
  const clear = isNoCrop(margins);
  // Nothing to remove (every page box is still shown in full somewhere): a plain crop.
  const plans = options.discard && !clear ? planDiscard(ws, crops).plans : [];
  const label = cropLabel(crops.length, { clear, discard: plans.length > 0 });
  const coalesceKey = `crop:${globalThis.crypto.randomUUID()}`;
  let outcome: ApplyOutcome | undefined;
  if (plans.length > 0) {
    outcome = await applyRedactionPlans(plans, { label, coalesceKey, captureStrings: false });
    if (outcome.kind === 'blocked' || outcome.kind === 'error') {
      return { kind: 'discarded', outcome, committed: false };
    }
  }
  // The pages may have changed while the redaction ran: plan against the workspace now.
  const now = planCrops(model().workspace, pageIds, margins).crops;
  const committed = model().applyOperation((current) => withCrops(current, now), label, {
    coalesceKey,
  });
  if (outcome?.kind === 'applied') return { kind: 'discarded', outcome, committed };
  if (committed) {
    const pages = pagesPhrase(now.length);
    announce(clear ? m.announce_crop_reset({ pages }) : m.announce_cropped({ pages }));
  }
  return { kind: 'cropped', committed };
}

/**
 * "Crop and remove" from the dialog: runs `cropPages` with the discard and keeps the
 * progress and the outcome in the crop store (crop-store.ts), so the dialog cannot close
 * while it works and shows the result sheet even when opened again. When there is no sheet
 * to show (a plain crop after all), the dialog closes. Never rejects.
 */
export async function cropAndDiscard(
  documentId: DocumentId,
  pageIds: readonly PageId[],
  margins: Margins,
): Promise<void> {
  if (isCropWorking()) return;
  useCropStore.setState({ run: { kind: 'working', documentId } });
  let result: CropOutcome;
  try {
    result = await cropPages(pageIds, margins, { discard: true });
  } catch (error) {
    // cropPages never rejects; this keeps the dialog out of "working" forever.
    const message = error instanceof Error ? error.message : String(error);
    result = { kind: 'discarded', outcome: { kind: 'error', message }, committed: false };
  }
  if (result.kind === 'discarded' && result.outcome.kind !== 'nothing') {
    useCropStore.setState({ run: { kind: 'done', documentId, outcome: result.outcome } });
    return;
  }
  useCropStore.setState({ run: { kind: 'idle' } });
  const open = useOperationDialogStore.getState().dialog;
  if (open?.kind === 'crop' && open.documentId === documentId) closeOperationDialog();
}

// ---------------------------------------------------------------------------
// Drawing a crop area in Read mode
// ---------------------------------------------------------------------------

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !useCropStore.getState().drawing) return;
  // Before the shell's Esc (clear tool and selection): Esc only ends the drawing.
  event.preventDefault();
  event.stopImmediatePropagation();
  cancelCropDrawing();
}

function listen(on: boolean): void {
  if (typeof window === 'undefined') return;
  if (on) window.addEventListener('keydown', onKeyDown, true);
  else window.removeEventListener('keydown', onKeyDown, true);
}

/**
 * "Draw crop area": closes the dialog, keeps its draft, shows the first page it would crop
 * in Read mode and lets the crop layer take the pages.
 */
export function startCropDrawing(draft: CropDraft, firstPage: PageId | undefined): void {
  closeOperationDialog();
  useCropStore.setState({ drawing: draft, resume: null });
  listen(true);
  const ws = model().workspace;
  if (ws.activeDocument !== draft.documentId) model().setActive(draft.documentId);
  const switching = !isPageView(useUiStore.getState());
  useUiStore.getState().setViewMode('read');
  const location = firstPage === undefined ? undefined : findPageLocation(ws, firstPage);
  const reveal = () => {
    const doc = model().workspace.documents[draft.documentId];
    if (useCropStore.getState().drawing === null) return;
    // Without a page to show, page 1 (a fresh Read view needs a scroll request, below).
    goToPageIndex(location?.document === draft.documentId ? location.index : 0, doc);
  };
  // Coming from Arrange, scroll once the Read view has mounted: its page column only
  // lays out rows after a render that sees the mounted viewport, and the scroll request
  // gives it that render.
  if (switching && typeof window !== 'undefined') window.requestAnimationFrame(reveal);
  else reveal();
  announce(m.crop_draw_started());
}

function resumeDialog(draft: CropDraft): void {
  listen(false);
  useCropStore.setState({ drawing: null, resume: draft });
  openOperationDialog({ kind: 'crop', documentId: draft.documentId, pageIds: draft.pageIds });
}

/** Esc (or the banner's Cancel): the dialog opens again as it was. */
export function cancelCropDrawing(): void {
  const { drawing } = useCropStore.getState();
  if (drawing === null) return;
  resumeDialog(drawing);
}

/**
 * A rectangle drawn on `pageId` (unrotated user space): its margins on that page become
 * the dialog's margins, and the dialog opens again.
 */
export function finishCropDrawing(pageId: PageId, rect: Rect): void {
  const { drawing } = useCropStore.getState();
  if (drawing === null) return;
  const ws = model().workspace;
  const page = findPage(ws, pageId);
  if (page === undefined) {
    resumeDialog(drawing);
    return;
  }
  const margins = roundMargins(marginsFromCrop(pageBoxOf(page), rect, pageTotalRotation(ws, page)));
  resumeDialog({ ...drawing, margins });
}

/** Tests: stop listening for Esc. */
export function stopCropDrawingListener(): void {
  listen(false);
}

/** The displayed size of a page (the "same size" scope), or undefined. */
export function displayedSizeOf(ws: Workspace, pageId: PageId | undefined): Size | undefined {
  if (pageId === undefined) return undefined;
  const page = findPage(ws, pageId);
  if (page === undefined) return undefined;
  try {
    return pageDisplaySize(ws, page);
  } catch {
    return undefined;
  }
}
