/**
 * "The current view" as an outline destination, and back.
 *
 * Read mode: the page in view (`view-store.currentPage`) and the point of it at the top of
 * the viewport, as `/XYZ` coordinates in the page's user space (source user space for
 * resized pages, as the assembler expects). The position is read from the rendered page
 * (`[data-page-id]` in the Read view) and its scroll container; zoom is left unspecified
 * (`null`: readers keep theirs). Arrange mode: the focused (else first selected) page of
 * the document, without a position.
 */
import {
  type Destination,
  type DestinationView,
  type PageId,
  pageDisplaySize,
  pageTotalRotation,
  type Rect,
  type VirtualDocument,
  type VirtualPage,
  type Workspace,
} from '@pdf-editor/document-model';

import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { displayedSize, displayRectToUser } from '../viewer/geometry';
import { pageFrame } from '../viewer/page-frame';

type PageDestination = Extract<Destination, { kind: 'page' }>;

/** Positions this close to the top of the page navigate to the page itself. */
const NEAR_TOP_PT = 36;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function scrollContainer(element: HTMLElement): HTMLElement | null {
  for (let el = element.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
      return el;
    }
  }
  return null;
}

function frameOf(ws: Workspace, page: VirtualPage, cssScale: number) {
  return pageFrame({
    sourceId: page.ref.kind === 'source' ? page.ref.source : undefined,
    sourceIndex: page.ref.kind === 'source' ? page.ref.index : 0,
    sizePt: pageDisplaySize(ws, page),
    rotation: pageTotalRotation(ws, page),
    cssScale,
    page,
  });
}

/**
 * The user-space point shown at the top of the Read viewport on `page`, or undefined when
 * the page is not rendered (another mode, virtualized away) or its top is in view.
 */
function viewTop(ws: Workspace, page: VirtualPage): DestinationView | undefined {
  const element = document.querySelector<HTMLElement>(
    `[data-page-index][data-page-id="${CSS.escape(page.id)}"]`,
  );
  if (!element) return undefined;
  const container = scrollContainer(element);
  const box = element.getBoundingClientRect();
  if (!container || box.height <= 0) return undefined;
  const offset = container.getBoundingClientRect().top - box.top;
  if (offset <= 0) return undefined;
  const frame = frameOf(ws, page, 1);
  const shown = displayedSize(frame);
  const scale = box.height / shown.height;
  const topPt = Math.min(shown.height, offset / scale);
  const point = displayRectToUser(frame, { left: 0, top: topPt, width: 0, height: 0 });
  const quarter = frame.rotation === 90 || frame.rotation === 270;
  // The displayed top edge is a user-space y (upright, upside down) or x (quarter turns).
  return quarter ? { fit: 'xyz', left: round(point.x) } : { fit: 'xyz', top: round(point.y) };
}

/** Destination for "Add bookmark" / "Set destination to current view", if any page. */
export function currentViewDestination(
  ws: Workspace,
  doc: VirtualDocument,
): PageDestination | undefined {
  if (doc.pages.length === 0) return undefined;
  if (useUiStore.getState().viewMode === 'arrange') {
    const { focused, selected } = useSelectionStore.getState();
    const inDoc = (id: PageId | null) => id !== null && doc.pages.some((p) => p.id === id);
    const pageId =
      (inDoc(focused) ? focused : null) ??
      doc.pages.find((p) => selected.has(p.id))?.id ??
      doc.pages[Math.min(useViewStore.getState().currentPage, doc.pages.length - 1)]?.id;
    return pageId ? { kind: 'page', page: pageId } : undefined;
  }
  const index = Math.min(Math.max(0, useViewStore.getState().currentPage), doc.pages.length - 1);
  const page = doc.pages[index];
  if (!page) return undefined;
  const view = viewTop(ws, page);
  return view === undefined
    ? { kind: 'page', page: page.id }
    : { kind: 'page', page: page.id, view };
}

/**
 * Where to scroll for a destination's `/XYZ` position, as a user-space rectangle for the
 * Read view's reveal (which scrolls minimally, placing it a third down the viewport).
 */
export function revealFor(
  ws: Workspace,
  page: VirtualPage,
  view: DestinationView | undefined,
): Rect | undefined {
  if (view?.fit !== 'xyz' || (view.top === undefined && view.left === undefined)) return undefined;
  const frame = frameOf(ws, page, 1);
  const pageTop = frame.originY + frame.size.height;
  // Near the top of an upright page, scrolling to the page itself reads better.
  if (view.left === undefined && view.top !== undefined && view.top >= pageTop - NEAR_TOP_PT) {
    return undefined;
  }
  // A 1 pt square at the position: its displayed top is the destination's.
  return {
    x: view.left ?? frame.originX,
    y: (view.top ?? pageTop) - 1,
    width: 1,
    height: 1,
  };
}
