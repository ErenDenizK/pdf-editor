/**
 * Page furniture layout shared by the assembler (export) and the app's live preview: which
 * pages an overlay is drawn on, what its text reads, and where each copy of it goes on the
 * page as displayed. Pure functions; the only inputs from the outside world are the text
 * measurement (fontkit in the assembler, canvas in the preview) and image sizes.
 *
 * Boxes are in display space (overlay-geometry.ts): origin at the bottom-left of the page
 * as displayed, y up, in points. `rotate` turns a box counter-clockwise around its centre.
 * A text box is `width` (advance width, no kerning) by the font's cap height; the
 * baseline is the box's bottom edge, so a margin is the distance from the page edge to
 * the baseline (bottom anchors) or to the top of capitals (top anchors).
 */
import type {
  Anchor,
  BatesConfig,
  OverlayOp,
  OverlayPageRange,
  Size,
  TextOverlay,
} from '@pdf-editor/document-model';

import { resolveFont } from '../fonts/font-catalog';
import { anchorOrigin, type Point, tileOrigins } from './overlay-geometry';

// ---------------------------------------------------------------------------
// Page ranges and numbering
// ---------------------------------------------------------------------------

/**
 * Overlays drawn on a page: the document-level furniture (`VirtualDocument.furniture`,
 * which pages added later inherit), then the page's own overlays.
 */
export function pageOverlays(
  furniture: readonly OverlayOp[] | undefined,
  own: readonly OverlayOp[],
): readonly OverlayOp[] {
  return furniture === undefined || furniture.length === 0 ? own : [...furniture, ...own];
}

/** Whether the page at 0-based `index` of a `count`-page document is in `range`. */
export function pageInRange(
  range: OverlayPageRange | undefined,
  index: number,
  count: number,
): boolean {
  if (index < 0 || index >= count) return false;
  if (range === undefined) return true;
  const position = index + 1;
  if (range.from !== undefined && position < range.from) return false;
  if (range.to !== undefined && position > range.to) return false;
  if (range.parity === 'odd' && position % 2 === 0) return false;
  if (range.parity === 'even' && position % 2 === 1) return false;
  return true;
}

/** Number of pages of a `count`-page document in `range` up to and including `index`. */
function positionsUpTo(range: OverlayPageRange | undefined, index: number, count: number): number {
  let n = 0;
  for (let i = 0; i <= index && i < count; i++) if (pageInRange(range, i, count)) n++;
  return n;
}

/** What {page} and {pages} read on the page at `index`. */
export function overlayNumbers(
  overlay: Pick<TextOverlay, 'pages' | 'startNumber'>,
  index: number,
  count: number,
): { readonly page: number; readonly pages: number } {
  if (overlay.startNumber === undefined) return { page: index + 1, pages: count };
  const start = overlay.startNumber;
  const ordinal = positionsUpTo(overlay.pages, index, count);
  const matched = positionsUpTo(overlay.pages, count - 1, count);
  return { page: start + ordinal - 1, pages: start + matched - 1 };
}

/** The Bates number of the page at `index`: prefix + zero-padded (start + index) + suffix. */
export function formatBates(bates: BatesConfig, index: number): string {
  const n = String(bates.start + index).padStart(Math.max(1, bates.width), '0');
  return `${bates.prefix}${n}${bates.suffix}`;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export type DateStyle = 'short' | 'medium' | 'long' | 'full' | 'iso';
export const DATE_STYLES: readonly DateStyle[] = ['short', 'medium', 'long', 'full', 'iso'];

/** Formats a date for {date:<style>}; `iso` is the local calendar date as YYYY-MM-DD. */
export function formatOverlayDate(date: Date, style: DateStyle, locale?: string): string {
  if (style === 'iso') {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: style }).format(date);
  } catch {
    // An invalid document locale (bad BCP-47 tag) falls back to the runtime default.
    return new Intl.DateTimeFormat(undefined, { dateStyle: style }).format(date);
  }
}

export interface OverlayTextContext {
  /** 0-based page position and page count of the document. */
  readonly index: number;
  readonly count: number;
  /** Page label of this page ({label}). */
  readonly label: string;
  readonly title: string;
  readonly date: Date;
  /** Document language (BCP-47) for {date}; the runtime default when absent. */
  readonly locale?: string;
  readonly bates?: BatesConfig;
}

const TOKEN = /\{(page|pages|label|title|bates|date)(?::(\w+))?\}/g;

/** The template of a text overlay with its tokens replaced for one page. */
export function overlayText(
  overlay: Pick<TextOverlay, 'template' | 'pages' | 'startNumber'>,
  ctx: OverlayTextContext,
): string {
  const numbers = overlayNumbers(overlay, ctx.index, ctx.count);
  return overlay.template.replace(TOKEN, (match, name: string, arg: string | undefined) => {
    switch (name) {
      case 'page':
        return arg === undefined ? String(numbers.page) : match;
      case 'pages':
        return arg === undefined ? String(numbers.pages) : match;
      case 'label':
        return ctx.label;
      case 'title':
        return ctx.title;
      case 'bates':
        return ctx.bates ? formatBates(ctx.bates, ctx.index) : '';
      case 'date': {
        const style = (arg ?? 'medium') as DateStyle;
        return DATE_STYLES.includes(style) ? formatOverlayDate(ctx.date, style, ctx.locale) : match;
      }
      default:
        return match;
    }
  });
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

const MIRRORED: Readonly<Partial<Record<Anchor, Anchor>>> = {
  'top-left': 'top-right',
  'top-right': 'top-left',
  'middle-left': 'middle-right',
  'middle-right': 'middle-left',
  'bottom-left': 'bottom-right',
  'bottom-right': 'bottom-left',
};

/** Anchor and offset on the page at `index`: mirrored on even pages when asked (duplex). */
export function effectiveAnchor(
  overlay: Pick<OverlayOp, 'anchor' | 'offset' | 'mirror'>,
  index: number,
): { readonly anchor: Anchor; readonly offset: Point } {
  if (!overlay.mirror || (index + 1) % 2 === 1) {
    return { anchor: overlay.anchor, offset: overlay.offset };
  }
  return {
    anchor: MIRRORED[overlay.anchor] ?? overlay.anchor,
    offset: { x: -overlay.offset.x, y: overlay.offset.y },
  };
}

export interface OverlayBox {
  /** Lower-left corner in display space, before `rotate`. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Counter-clockwise degrees around the box centre. */
  readonly rotate: number;
}

/**
 * Every copy of a `content`-sized overlay on a page displayed at `page` size: one box, or
 * a grid of tiles covering the page (rotated tiles included) phased so the anchored copy
 * is one of them.
 */
export function overlayBoxes(
  overlay: Pick<OverlayOp, 'anchor' | 'offset' | 'mirror' | 'rotate' | 'tile'>,
  index: number,
  page: Size,
  content: Size,
): OverlayBox[] {
  const { anchor, offset } = effectiveAnchor(overlay, index);
  const anchored = anchorOrigin(anchor, page, content);
  const first = { x: anchored.x + offset.x, y: anchored.y + offset.y };
  const rotate = overlay.rotate ?? 0;
  // A rotated tile reaches up to half its diagonal from its centre.
  const margin =
    rotate % 180 === 0
      ? 0
      : Math.hypot(content.width, content.height) / 2 - Math.min(content.width, content.height) / 2;
  const origins = overlay.tile ? tileOrigins(page, content, first, overlay.tile, margin) : [first];
  return origins.map((o) => ({
    x: o.x,
    y: o.y,
    width: content.width,
    height: content.height,
    rotate,
  }));
}

export interface PageLayoutInput {
  readonly index: number;
  readonly count: number;
  /** Displayed page size in points (after /Rotate). */
  readonly page: Size;
  readonly text: Omit<OverlayTextContext, 'index' | 'count'>;
}

export type LaidOutOverlay =
  | {
      readonly kind: 'text';
      readonly overlay: TextOverlay;
      readonly text: string;
      readonly boxes: readonly OverlayBox[];
    }
  | {
      readonly kind: 'image';
      readonly overlay: Extract<OverlayOp, { kind: 'image' }>;
      readonly boxes: readonly OverlayBox[];
    };

export interface OverlayMeasure {
  /** Advance width in points of `text` set in `overlay.font` (no kerning). */
  readonly textWidth: (text: string, overlay: TextOverlay) => number;
  /** Intrinsic size (points at scale 1) of an image overlay's blob; undefined skips it. */
  readonly imageSize: (overlay: Extract<OverlayOp, { kind: 'image' }>) => Size | undefined;
}

/**
 * The single placement function behind export and preview: filters by page range,
 * expands the template, measures, anchors (with mirroring) and tiles. Returns undefined
 * when the overlay is not drawn on this page.
 */
export function layoutOverlay(
  overlay: OverlayOp,
  input: PageLayoutInput,
  measure: OverlayMeasure,
): LaidOutOverlay | undefined {
  if (!pageInRange(overlay.pages, input.index, input.count)) return undefined;
  if (overlay.kind === 'text') {
    const text = overlayText(overlay, { ...input.text, index: input.index, count: input.count });
    if (text.trim() === '') return undefined;
    const content = {
      width: measure.textWidth(text, overlay),
      height: resolveFont(overlay.font).capHeight * overlay.font.size,
    };
    return {
      kind: 'text',
      overlay,
      text,
      boxes: overlayBoxes(overlay, input.index, input.page, content),
    };
  }
  const size = measure.imageSize(overlay);
  if (!size) return undefined;
  const content = { width: size.width * overlay.scale, height: size.height * overlay.scale };
  return { kind: 'image', overlay, boxes: overlayBoxes(overlay, input.index, input.page, content) };
}
