/**
 * Compare view state (spec recognize-and-compare §2.2): the two documents and options the
 * user picked, the run's progress and progressive results (page map, visual diffs as they
 * land), the finished `ComparisonResult`, and how the view shows it. Session only, never
 * undoable: the view is read-only. The run itself (worker lease, heat maps, scratch
 * documents) lives in `compare-runner.ts`.
 *
 * Staleness: a run records what it read of each document (`CompareBasis`: its pages,
 * furniture, fields and metadata, and the engine edits of its sources). When a compared
 * document changes afterwards (an edit, undo or redo, a page command, in any view), the
 * result no longer describes what the view draws: `stale` says so until the documents are
 * back to what was compared (undo) or the comparison runs again.
 */
import type {
  DocumentId,
  EngineEdit,
  Rect,
  SourceId,
  VirtualDocument,
  Workspace,
} from '@pdf-editor/document-model';
import type {
  CompareAlignment,
  CompareProgress,
  ComparisonResult,
  PagePair,
  PixelDiffResult,
} from '@pdf-editor/engine';
import { create } from 'zustand';

import type { SidePage } from './side-page';

export type CompareStatus = 'setup' | 'preparing' | 'running' | 'done' | 'failed';
export type CompareDpi = 100 | 150;
export type CompareLayout = 'side' | 'overlay';

/** What the view shows of one side: its name and pages (for rendering and geometry). */
export interface CompareSideView {
  readonly documentId: DocumentId;
  readonly name: string;
  readonly pages: readonly SidePage[];
  readonly assembled: boolean;
}

/** A request to bring a change into view; `serial` makes repeats distinct. */
export interface RevealRequest {
  readonly serial: number;
  readonly row: number;
  readonly side: 'a' | 'b';
  /** User-space rectangle on that side's page; absent: the page top. */
  readonly rect?: Rect;
}

/** What a run read of one document: the result describes these, and only these. */
export interface CompareSideBasis {
  readonly documentId: DocumentId;
  readonly pages: VirtualDocument['pages'];
  readonly furniture: VirtualDocument['furniture'];
  readonly fields: VirtualDocument['fields'];
  readonly metadata: VirtualDocument['metadata'];
  readonly bates: VirtualDocument['bates'];
  /** The engine edits of the document's sources (annotations, form values, content). */
  readonly edits: readonly EngineEdit[];
}

export interface CompareBasis {
  readonly a: CompareSideBasis;
  readonly b: CompareSideBasis;
}

export interface CompareState {
  readonly a: DocumentId | null;
  readonly b: DocumentId | null;
  readonly alignment: CompareAlignment;
  readonly dpi: CompareDpi;
  readonly status: CompareStatus;
  readonly progress: CompareProgress | null;
  readonly error: string | null;
  readonly sides: { readonly a: CompareSideView; readonly b: CompareSideView } | null;
  /** The page map, as soon as alignment is done. */
  readonly pairs: readonly PagePair[] | null;
  /** Visual diffs by page-map row, as they land. */
  readonly visuals: Readonly<Record<number, PixelDiffResult>>;
  readonly result: ComparisonResult | null;
  /** What the run read of the two documents (set when it starts). */
  readonly basis: CompareBasis | null;
  /** A compared document changed since the run read it: the result is out of date. */
  readonly stale: boolean;
  readonly layout: CompareLayout;
  /** Opacity of B over A in the overlay layout, 0–1. */
  readonly opacity: number;
  readonly heatmap: boolean;
  /** CSS pixels per point, or null to fit the stage width. */
  readonly zoom: number | null;
  /** The change the panel and the view point at (a `ChangeItem.id`). */
  readonly current: string | null;
  readonly reveal: RevealRequest | null;
  /** First page-map row in view (the visual diff starts there). */
  readonly visibleRow: number;
}

const INITIAL: CompareState = {
  a: null,
  b: null,
  alignment: 'auto',
  dpi: 100,
  status: 'setup',
  progress: null,
  error: null,
  sides: null,
  pairs: null,
  visuals: {},
  result: null,
  basis: null,
  stale: false,
  layout: 'side',
  opacity: 0.5,
  heatmap: false,
  zoom: null,
  current: null,
  reveal: null,
  visibleRow: 0,
};

export const useCompareStore = create<CompareState>()(() => INITIAL);

/** Clears the run's results (keeps the choices and the display options). */
export function clearCompareResults(): void {
  useCompareStore.setState({
    status: 'setup',
    progress: null,
    error: null,
    sides: null,
    pairs: null,
    visuals: {},
    result: null,
    basis: null,
    stale: false,
    current: null,
    reveal: null,
    visibleRow: 0,
  });
}

/**
 * A comparison is open: being set up in the Compare view, running, or finished and kept
 * (leaving the view keeps it). The view switch shows its Compare segment only then (spec
 * §2.2).
 */
export function comparisonOpen(inCompareView: boolean, status: CompareStatus): boolean {
  return inCompareView || status === 'preparing' || status === 'running' || status === 'done';
}

/** Back to the initial state (tests). */
export function resetCompareStore(): void {
  useCompareStore.setState(INITIAL, true);
}

export function requestReveal(request: Omit<RevealRequest, 'serial'>): void {
  useCompareStore.setState((s) => ({
    reveal: { ...request, serial: (s.reveal?.serial ?? 0) + 1 },
  }));
}

function sourcesOf(doc: VirtualDocument): Set<SourceId> {
  const out = new Set<SourceId>();
  for (const page of doc.pages) if (page.ref.kind === 'source') out.add(page.ref.source);
  return out;
}

/** What a comparison reads of `documentId` now; null when it is not open. */
export function sideBasis(ws: Workspace, documentId: DocumentId): CompareSideBasis | null {
  const doc = ws.documents[documentId];
  if (!doc) return null;
  const sources = sourcesOf(doc);
  return {
    documentId,
    pages: doc.pages,
    furniture: doc.furniture,
    fields: doc.fields,
    metadata: doc.metadata,
    bates: doc.bates,
    edits: ws.engineEdits.filter((edit) => sources.has(edit.source)),
  };
}

/** True when the document no longer is what `basis` recorded (compared by identity). */
export function sideChanged(basis: CompareSideBasis, ws: Workspace): boolean {
  const now = sideBasis(ws, basis.documentId);
  if (!now) return true;
  return (
    now.pages !== basis.pages ||
    now.furniture !== basis.furniture ||
    now.fields !== basis.fields ||
    now.metadata !== basis.metadata ||
    now.bates !== basis.bates ||
    now.edits.length !== basis.edits.length ||
    now.edits.some((edit, i) => edit !== basis.edits[i])
  );
}

/** Records what a run starting now reads of `a` and `b`. */
export function recordCompareBasis(ws: Workspace, a: DocumentId, b: DocumentId): void {
  const sideA = sideBasis(ws, a);
  const sideB = sideBasis(ws, b);
  useCompareStore.setState({
    basis: sideA && sideB ? { a: sideA, b: sideB } : null,
    stale: false,
  });
}

/**
 * Marks the comparison stale when a compared document changed since the run read it, and
 * fresh again when it is back to that state (undo). Called on every workspace change.
 */
export function refreshCompareStale(ws: Workspace): void {
  const { basis, stale } = useCompareStore.getState();
  if (!basis) return;
  const changed = sideChanged(basis.a, ws) || sideChanged(basis.b, ws);
  if (changed !== stale) useCompareStore.setState({ stale: changed });
}
