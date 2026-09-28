/**
 * Compare view state (spec recognize-and-compare §2.2): the two documents and options the
 * user picked, the run's progress and progressive results (page map, visual diffs as they
 * land), the finished `ComparisonResult`, and how the view shows it. Session only, never
 * undoable: the view is read-only. The run itself (worker lease, heat maps, scratch
 * documents) lives in `compare-runner.ts`.
 */
import type { DocumentId, Rect } from '@pdf-editor/document-model';
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
    current: null,
    reveal: null,
    visibleRow: 0,
  });
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
