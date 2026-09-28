/**
 * Page resize (`VirtualPage.resize`): the math shared by the model, the assembler (which
 * materializes it, packages/engine/src/pdflib/page-resize.ts) and the UI (thumbnails and
 * the dialog preview), so the page on screen and the exported page agree.
 *
 * Pipeline, in unrotated user space: source page → crop (`cropBox`) → resize → rotation.
 * The *content box* is what the crop leaves visible (the crop box, else the source, blank
 * or image page size). A resize maps the content box into a new page box of
 * `width` × `height` with origin (0, 0):
 *
 *   x' = scaleX · (x − box.x) + offsetX,   y' = scaleY · (y − box.y) + offsetY
 *
 * where `resizeTransform` picks the scale from the mode (`fit`: min of the axis ratios,
 * `scale`: max, or both ratios with `stretch`, `canvas`: 1) and the offset from the anchor
 * (the scaled content box sits flush with the anchor's sides, centred on the others).
 * Anything outside the new page box is cut off; nothing outside the content box shows.
 *
 * The stored resize is unrotated (like `cropBox`), so a later rotation turns the resized
 * page as a whole. What the user sees is rotated: `resizeForPage` converts a displayed
 * request (size and anchor as seen) into the stored form per page.
 */
import { DocumentModelError } from './errors';
import { isPositiveFinite, isRotation, requireDocument } from './internal';
import { pageContentSize, pageDisplaySize, pageTotalRotation } from './selectors';
import type {
  Anchor,
  DocumentId,
  PageId,
  PageResize,
  ResizeMode,
  Rotation,
  Size,
  VirtualPage,
  Workspace,
} from './types';

export const RESIZE_MODES: readonly ResizeMode[] = ['scale', 'fit', 'canvas'];

/** The nine anchor positions, row by row from the top-left (the dialog's 3 × 3 grid). */
export const ANCHOR_POSITIONS: readonly Anchor[] = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

/** Page side limits of ISO 32000 (Annex C): 3 … 14,400 points. */
export const MIN_PAGE_SIDE = 3;
export const MAX_PAGE_SIDE = 14_400;

export type PaperSizeId = 'a4' | 'a3' | 'a5' | 'letter' | 'legal' | 'tabloid';

/** Common paper sizes in points, portrait. */
export const PAPER_SIZES: Readonly<Record<PaperSizeId, Size>> = {
  a4: { width: 595.28, height: 841.89 },
  a3: { width: 841.89, height: 1190.55 },
  a5: { width: 419.53, height: 595.28 },
  letter: { width: 612, height: 792 },
  legal: { width: 612, height: 1008 },
  tabloid: { width: 792, height: 1224 },
};

/** The paper size `size` matches (either orientation) within `tolerance` points. */
export function matchPaperSize(
  size: Size,
  tolerance = 1,
): { readonly id: PaperSizeId; readonly landscape: boolean } | undefined {
  for (const [id, paper] of Object.entries(PAPER_SIZES) as [PaperSizeId, Size][]) {
    if (sameSize(size, paper, tolerance)) return { id, landscape: false };
    if (sameSize(size, { width: paper.height, height: paper.width }, tolerance)) {
      return { id, landscape: true };
    }
  }
  return undefined;
}

export function sameSize(a: Size, b: Size, tolerance = 0.01): boolean {
  return Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

/**
 * Maps a point of the content box, measured from its lower-left corner, onto the new page:
 * `x' = scaleX · x + offsetX`, `y' = scaleY · y + offsetY`. Scales are always positive.
 */
export interface ResizeTransform {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Where along each axis an anchor sits: 0 = left/bottom, 0.5 = centre, 1 = right/top. */
export function anchorFactors(anchor: Anchor): { readonly x: number; readonly y: number } {
  const [vertical, horizontal] = anchor === 'center' ? ['middle', 'center'] : anchor.split('-');
  return {
    x: horizontal === 'left' ? 0 : horizontal === 'right' ? 1 : 0.5,
    y: vertical === 'bottom' ? 0 : vertical === 'top' ? 1 : 0.5,
  };
}

export function resizeTransform(
  content: Size,
  resize: Pick<PageResize, 'width' | 'height' | 'mode' | 'anchor' | 'stretch'>,
): ResizeTransform {
  const ratioX = resize.width / content.width;
  const ratioY = resize.height / content.height;
  let scaleX: number;
  let scaleY: number;
  if (resize.mode === 'canvas') {
    scaleX = scaleY = 1;
  } else if (resize.mode === 'fit') {
    scaleX = scaleY = Math.min(ratioX, ratioY);
  } else if (resize.stretch === true) {
    scaleX = ratioX;
    scaleY = ratioY;
  } else {
    scaleX = scaleY = Math.max(ratioX, ratioY);
  }
  const factors = anchorFactors(resize.anchor);
  return {
    scaleX,
    scaleY,
    // `+ 0` turns −0 (a left or bottom anchor with overflow) into 0.
    offsetX: factors.x * (resize.width - scaleX * content.width) + 0,
    offsetY: factors.y * (resize.height - scaleY * content.height) + 0,
  };
}

/** Whether the transform leaves every point where it was (same size, no scaling). */
export function isIdentityTransform(t: ResizeTransform, epsilon = 1e-6): boolean {
  return (
    Math.abs(t.scaleX - 1) < epsilon &&
    Math.abs(t.scaleY - 1) < epsilon &&
    Math.abs(t.offsetX) < epsilon &&
    Math.abs(t.offsetY) < epsilon
  );
}

// ---------------------------------------------------------------------------
// Displayed ↔ unrotated
// ---------------------------------------------------------------------------

type Vector = readonly [number, number];

function anchorVector(anchor: Anchor): Vector {
  const f = anchorFactors(anchor);
  return [f.x * 2 - 1, f.y * 2 - 1];
}

function vectorAnchor([x, y]: Vector): Anchor {
  const row = y > 0 ? 0 : y < 0 ? 2 : 1;
  const column = x < 0 ? 0 : x > 0 ? 2 : 1;
  return ANCHOR_POSITIONS[row * 3 + column] as Anchor;
}

/** Quarter turns clockwise (y up): (x, y) → (y, −x). */
function turnClockwise(vector: Vector, rotation: Rotation): Vector {
  let [x, y] = vector;
  for (let i = 0; i < rotation / 90; i++) [x, y] = [y, -x];
  return [x + 0, y + 0];
}

/**
 * The anchor as seen on a page shown turned clockwise by `rotation` (the unrotated top of
 * a page turned 90° is on the right).
 */
export function displayedAnchor(anchor: Anchor, rotation: Rotation): Anchor {
  return vectorAnchor(turnClockwise(anchorVector(anchor), rotation));
}

/** The inverse of `displayedAnchor`: which unrotated side an anchor seen on screen names. */
export function unrotatedAnchor(anchor: Anchor, rotation: Rotation): Anchor {
  return vectorAnchor(turnClockwise(anchorVector(anchor), ((360 - rotation) % 360) as Rotation));
}

function turned(size: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270 ? { width: size.height, height: size.width } : size;
}

/** What the user asks for, as seen on screen (applied to each page in its own rotation). */
export interface ResizeRequest {
  /** New page size as displayed, in points. */
  readonly width: number;
  readonly height: number;
  readonly mode: ResizeMode;
  /** Anchor as seen on the displayed page. */
  readonly anchor: Anchor;
  /** Only with `scale`: fill the page exactly, scaling each axis on its own. */
  readonly stretch?: boolean;
  /**
   * Keep each page's orientation: a landscape page asked to become A4 portrait becomes A4
   * landscape (width and height swap). Square pages take the size as given.
   */
  readonly matchOrientation?: boolean;
}

/**
 * The stored resize for `page` under a displayed request, or undefined when the request
 * would not change the page (same size as its content box: every mode is then the
 * identity), which clears any earlier resize. A request replaces an earlier resize: it is
 * always relative to the content box, never to a previous resize.
 */
export function resizeForPage(
  ws: Workspace,
  page: VirtualPage,
  request: ResizeRequest,
): PageResize | undefined {
  const rotation = pageTotalRotation(ws, page);
  const content = pageContentSize(ws, page);
  const shownContent = turned(content, rotation);
  let shown: Size = { width: request.width, height: request.height };
  if (request.matchOrientation === true) {
    const wantsLandscape = shown.width > shown.height;
    const isLandscape = shownContent.width > shownContent.height;
    const square = shown.width === shown.height || shownContent.width === shownContent.height;
    if (!square && wantsLandscape !== isLandscape) {
      shown = { width: shown.height, height: shown.width };
    }
  }
  const size = turned(shown, rotation);
  if (sameSize(size, content)) return undefined;
  const resize: PageResize = {
    width: size.width,
    height: size.height,
    mode: request.mode,
    anchor: unrotatedAnchor(request.anchor, rotation),
    ...(request.mode === 'scale' && request.stretch === true ? { stretch: true } : {}),
  };
  return resize;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** What is wrong with a stored or requested resize, or undefined when it is valid. */
export function resizeProblem(resize: {
  readonly width: unknown;
  readonly height: unknown;
  readonly mode: unknown;
  readonly anchor: unknown;
  readonly stretch?: unknown;
}): string | undefined {
  if (typeof resize !== 'object' || resize === null) return 'resize must be an object';
  const side = (value: unknown) =>
    isPositiveFinite(value) && value >= MIN_PAGE_SIDE && value <= MAX_PAGE_SIDE;
  if (!side(resize.width) || !side(resize.height)) {
    return `resize width and height must be within ${MIN_PAGE_SIDE}…${MAX_PAGE_SIDE} pt`;
  }
  if (!RESIZE_MODES.includes(resize.mode as ResizeMode)) return 'unknown resize mode';
  if (!ANCHOR_POSITIONS.includes(resize.anchor as Anchor)) return 'unknown resize anchor';
  if (resize.stretch !== undefined && resize.stretch !== true && resize.stretch !== false) {
    return 'resize stretch must be a boolean';
  }
  if (resize.stretch === true && resize.mode !== 'scale') {
    return 'resize stretch applies to the scale mode only';
  }
  return undefined;
}

export function assertResize(resize: Parameters<typeof resizeProblem>[0], what: string): void {
  const problem = resizeProblem(resize);
  if (problem !== undefined) {
    throw new DocumentModelError('invalid-argument', `${what}: ${problem}`);
  }
}

// ---------------------------------------------------------------------------
// Placement on screen
// ---------------------------------------------------------------------------

/**
 * Where the content box shows on the displayed page, as fractions of the displayed width
 * and height from the top-left corner. May reach outside 0…1 (`scale` without stretch and
 * a shrinking `canvas` cut content off). The page's bitmap (rendered with its rotation)
 * fills exactly this box.
 */
export interface ContentPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function resizeContentPlacement(
  content: Size,
  resize: Pick<PageResize, 'width' | 'height' | 'mode' | 'anchor' | 'stretch'>,
  rotation: Rotation,
): ContentPlacement {
  if (!isRotation(rotation)) {
    throw new DocumentModelError('invalid-argument', `Invalid rotation ${String(rotation)}`);
  }
  const t = resizeTransform(content, resize);
  const W = resize.width;
  const H = resize.height;
  const w = t.scaleX * content.width;
  const h = t.scaleY * content.height;
  // Unrotated, top-left origin, y down.
  const ux = t.offsetX;
  const uy = H - (t.offsetY + h);
  let box: ContentPlacement;
  switch (rotation) {
    case 90:
      box = { left: H - (uy + h), top: ux, width: h, height: w };
      break;
    case 180:
      box = { left: W - (ux + w), top: H - (uy + h), width: w, height: h };
      break;
    case 270:
      box = { left: uy, top: W - (ux + w), width: h, height: w };
      break;
    default:
      box = { left: ux, top: uy, width: w, height: h };
  }
  const shown = turned({ width: W, height: H }, rotation);
  return {
    left: box.left / shown.width + 0,
    top: box.top / shown.height + 0,
    width: box.width / shown.width,
    height: box.height / shown.height,
  };
}

/** `resizeContentPlacement` for a page of the workspace; undefined when not resized. */
export function pageContentPlacement(
  ws: Workspace,
  page: VirtualPage,
): ContentPlacement | undefined {
  if (page.resize === undefined) return undefined;
  return resizeContentPlacement(
    pageContentSize(ws, page),
    page.resize,
    pageTotalRotation(ws, page),
  );
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

/**
 * Pages of a document displayed at `size` in either orientation (within `tolerance`
 * points): "every page with size X".
 */
export function pagesOfSize(
  ws: Workspace,
  documentId: DocumentId,
  size: Size,
  tolerance = 1,
): PageId[] {
  const doc = requireDocument(ws, documentId);
  const swapped = { width: size.height, height: size.width };
  return doc.pages
    .filter((page) => {
      const shown = pageDisplaySize(ws, page);
      return sameSize(shown, size, tolerance) || sameSize(shown, swapped, tolerance);
    })
    .map((page) => page.id);
}
