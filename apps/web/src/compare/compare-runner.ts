/**
 * Runs a comparison (spec recognize-and-compare §2): reads both tabs (`document-pages.ts`),
 * feeds them to the analysis worker (`AnalysisProxy.compare`: text, thumbnails, page map,
 * visual diff per pair with the pages in view first, text diff, facts) and publishes the
 * progress and the results to the compare store as they land.
 *
 * Lifetime: the run holds an analysis-worker lease and, for assembled tabs, scratch
 * documents in the PDFium worker. Both are released on cancel, on a new run ("New
 * comparison", "Run again") and when a compared tab closes; the worker keeps the pages and
 * heat maps of a finished run until then (`CompareRun.release`), so leaving the Compare
 * view and coming back shows the same result.
 *
 * The report is built from the second document's bytes as the run read them (a snapshot
 * taken when it starts), never from the tab at export time; while a compared document has
 * changed since (`stale` in the store) the report is refused and the view offers to run
 * again.
 */
import type { CompareRun, PagePair } from '@pdf-editor/engine';

import { type AnalysisLease, getAnalysisWorkers } from '../engine/engine-service';
import { exportFileName } from '../export/filename';
import { getLocale, m } from '../i18n';
import { announce } from '../shell/announcer';
import { useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { deliverFile } from '../tools/deliver-file';
import { toolSourceBytes } from '../tools/tool-source';
import {
  clearCompareResults,
  type CompareSideView,
  recordCompareBasis,
  useCompareStore,
} from './compare-store';
import {
  documentFacts,
  type DocumentPages,
  documentPages,
  pageAt,
  pageEngine,
  pageGeometry,
  pageText,
} from './document-pages';

interface ActiveRun {
  readonly controller: AbortController;
  lease: AnalysisLease | undefined;
  sides: DocumentPages[];
  run: CompareRun | undefined;
  readonly heatmaps: Map<string, Promise<ImageBitmap | null>>;
  /** B's bytes as this run read them, for the report (dropped with the run). */
  reportBytes: Promise<ArrayBuffer> | undefined;
}

let active: ActiveRun | null = null;

/** The heat map colour: the accent (#7c8cff), the one colour for state on the page. */
const HEATMAP_RGB: readonly [number, number, number] = [124, 140, 255];
/** Pairs diffed first: the rows in view and a few after them. */
const VISIBLE_FIRST = 6;

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'aborted')
  );
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function dispose(run: ActiveRun): Promise<void> {
  for (const pending of run.heatmaps.values()) {
    void pending.then(
      (bitmap) => bitmap?.close(),
      () => undefined,
    );
  }
  run.heatmaps.clear();
  const finished = run.run;
  run.run = undefined;
  run.reportBytes = undefined;
  if (finished) await finished.release().catch(() => undefined);
  for (const side of run.sides.splice(0)) await side.dispose().catch(() => undefined);
  run.lease?.release();
  run.lease = undefined;
}

function sideView(side: DocumentPages): CompareSideView {
  return {
    documentId: side.documentId,
    name: side.name,
    pages: side.pages,
    assembled: side.assembled,
  };
}

/** Stops a run in progress and frees a finished one; the choices stay. */
export async function releaseCompare(): Promise<void> {
  const current = active;
  active = null;
  if (current) {
    current.controller.abort();
    await dispose(current);
  }
  clearCompareResults();
}

/** Cancels the run in progress (the view goes back to the choices). */
export function cancelCompare(): void {
  void releaseCompare();
  announce(m.compare_cancelled());
}

/** Starts comparing the chosen documents; resolves when the run ends (any outcome). */
export async function startCompare(): Promise<void> {
  const { a, b, alignment, dpi } = useCompareStore.getState();
  if (a === null || b === null || a === b) return;
  await releaseCompare();
  const run: ActiveRun = {
    controller: new AbortController(),
    lease: undefined,
    sides: [],
    run: undefined,
    heatmaps: new Map(),
    reportBytes: undefined,
  };
  active = run;
  const { signal } = run.controller;
  const store = useCompareStore;
  // What the result will describe: a later change to either document makes it stale.
  recordCompareBasis(useWorkspaceStore.getState().workspace, a, b);
  store.setState({ status: 'preparing', progress: null, error: null });
  try {
    run.lease = await getAnalysisWorkers().acquire();
    // A newer run or a release may have replaced this one at any await: then it frees
    // whatever it got so far itself.
    const superseded = async () => {
      if (active === run) return false;
      await dispose(run);
      return true;
    };
    if (await superseded()) return;
    const engine = await pageEngine();
    const sideA = await documentPages(a, { signal });
    run.sides.push(sideA);
    if (await superseded()) return;
    const sideB = await documentPages(b, { signal });
    run.sides.push(sideB);
    // The report annotates B as compared: an assembled tab's copy, or the tab assembled now
    // (in the background, while the comparison runs).
    const reportBytes = sideB.assembled
      ? sideB.bytes().then((read) => {
          const first = read[0];
          if (!first) throw new Error(m.compare_error_document_closed());
          return first.bytes;
        })
      : toolSourceBytes(b, signal);
    reportBytes.catch(() => undefined);
    run.reportBytes = reportBytes;
    if (await superseded()) return;
    store.setState({ status: 'running', sides: { a: sideView(sideA), b: sideView(sideB) } });
    const proxy = run.lease.proxy;
    const extract = (bytes: ArrayBuffer, password?: string) => proxy.extractFacts(bytes, password);
    const source = (side: DocumentPages) => ({
      name: side.name,
      ...(side.fingerprint ? { fingerprint: side.fingerprint } : {}),
      pageCount: side.pages.length,
      geometry: (index: number) => pageGeometry(pageAt(side, index)),
      text: (index: number, options: { signal?: AbortSignal }) =>
        pageText(engine, side, index, options),
      render: async (
        index: number,
        { dpi: at, ...options }: { dpi: number; signal?: AbortSignal },
      ) => {
        const page = pageAt(side, index);
        const rendered = await engine.renderPage(page.sourceId, page.index, {
          ...options,
          priority: 'low',
          scale: at / 72,
          rotation: page.delta,
          withAnnotations: true,
          withForms: true,
          background: 'white',
        });
        return rendered.bitmap;
      },
      facts: (options: { signal?: AbortSignal }) => documentFacts(engine, side, options, extract),
    });
    const language = useWorkspaceStore.getState().workspace.documents[a]?.metadata.language;
    const compared = await proxy.compare(source(sideA), source(sideB), {
      signal,
      alignment,
      dpi,
      locale: language ?? getLocale(),
      onProgress: (progress) => {
        if (active === run) store.setState({ progress });
      },
      visualOrder: (pairs: readonly PagePair[]) => {
        if (active !== run) return [];
        store.setState({ pairs });
        const from = Math.min(store.getState().visibleRow, Math.max(0, pairs.length - 1));
        return Array.from({ length: VISIBLE_FIRST }, (_, i) => from + i).filter(
          (i) => i < pairs.length,
        );
      },
      onPair: (index, _pair, visual) => {
        if (active === run) store.setState((s) => ({ visuals: { ...s.visuals, [index]: visual } }));
      },
    });
    run.run = compared;
    if (await superseded()) return;
    const { result } = compared;
    store.setState({
      status: 'done',
      result,
      pairs: result.pages.map((p) => p.pair),
      visuals: Object.fromEntries(
        result.pages.flatMap((p, i) => (p.visual ? [[i, p.visual] as const] : [])),
      ),
    });
    const { counts } = result;
    const changes = counts.changed + counts.inserted + counts.deleted + counts.facts;
    announce(
      changes === 0
        ? m.compare_announce_identical()
        : m.compare_announce_done({ pages: counts.changed + counts.inserted + counts.deleted }),
    );
    // The Changes panel lists the result (in the view; a run finishing after the user left
    // waits there for their return).
    const ui = useUiStore.getState();
    if (ui.viewMode === 'compare' && (!ui.leftPanelOpen || ui.leftPanelView !== 'changes')) {
      useUiStore.setState({ leftPanelOpen: true, leftPanelView: 'changes' });
    }
  } catch (error) {
    if (active !== run) {
      await dispose(run);
      return;
    }
    if (isAbort(error, signal)) {
      active = null;
      await dispose(run);
      clearCompareResults();
      return;
    }
    await dispose(run);
    active = null;
    store.setState({
      status: 'failed',
      error: m.compare_failed({ reason: reason(error) }),
      progress: null,
    });
    announce(m.compare_failed({ reason: reason(error) }));
  }
}

/** A finished run's heat map as a bitmap (cached until the run is released). */
export function heatmapBitmap(id: string): Promise<ImageBitmap | null> {
  const run = active?.run;
  if (!active || !run) return Promise.resolve(null);
  const cached = active.heatmaps.get(id);
  if (cached) return cached;
  const pending = run.heatmap(id, HEATMAP_RGB).then(
    (rgba) =>
      createImageBitmap(new ImageData(new Uint8ClampedArray(rgba.data), rgba.width, rgba.height)),
    () => null,
  );
  active.heatmaps.set(id, pending);
  return pending;
}

function stemOf(name: string): string {
  return exportFileName(name).replace(/\.pdf$/, '');
}

/**
 * The comparison report (spec §2.1): the second document as compared, with a summary page
 * and change annotations, built in the analysis worker and downloaded.
 */
export async function exportComparisonReport(): Promise<void> {
  const { result, sides, stale } = useCompareStore.getState();
  const lease = active?.lease;
  const compared = active?.reportBytes;
  if (!result || !lease || !sides || !compared) return;
  if (stale) {
    announce(m.compare_stale());
    return;
  }
  try {
    // A copy: the snapshot stays for another export.
    const bytes = (await compared).slice(0);
    const report = await lease.proxy.buildReport(bytes, result);
    const name = `${stemOf(sides.b.name)}-comparison.pdf`;
    const outcome = await deliverFile(report, name, 'application/pdf');
    if (outcome === 'cancelled') return;
    announce(outcome === 'saved' ? m.announce_saved({ name }) : m.announce_downloaded({ name }));
  } catch (error) {
    announce(m.compare_report_failed({ reason: reason(error) }));
  }
}

/** For the changes list's file name. */
export function comparedStem(): string {
  const sides = useCompareStore.getState().sides;
  return sides ? stemOf(sides.b.name) : 'document';
}

/** True while a run holds the worker (tests). */
export function hasActiveCompare(): boolean {
  return active !== null;
}
