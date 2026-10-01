/**
 * Mapping between EmbedPDF annotation objects (device space, see coords.ts) and our
 * engine-neutral `Annotation` union (PDF user space).
 */

import {
  PdfActionType,
  PdfAnnotationBorderStyle,
  PdfAnnotationLineEnding,
  PdfBlendMode,
  PdfAnnotationName,
  type PdfAnnotationFlagName,
  type PdfAnnotationObject,
  PdfAnnotationSubtype,
  type PdfFreeTextAnnoObject,
  type PdfHighlightAnnoObject,
  type PdfInkAnnoObject,
  type PdfLineAnnoObject,
  type PdfLinkAnnoObject,
  type PdfPolygonAnnoObject,
  type PdfPolylineAnnoObject,
  type PdfRedactAnnoObject,
  type PdfSquareAnnoObject,
  type PdfSquigglyAnnoObject,
  PdfStandardFont,
  type PdfStampAnnoObject,
  type PdfStrikeOutAnnoObject,
  PdfTextAlignment,
  type PdfTextAnnoObject,
  type PdfUnderlineAnnoObject,
  PdfVerticalAlignment,
  PdfZoomMode,
} from '@embedpdf/models';
import type { Rect } from '@pdf-editor/document-model';

import {
  type Annotation,
  type AnnotationBase,
  type AnnotationKind,
  EngineError,
  type InkAnnotation,
  type LineEnding,
  type MarkupAnnotation,
  type NewAnnotation,
  type ShapeAnnotation,
} from '../types';
import {
  annotationRectToUser,
  deviceToUserPoint,
  deviceToUserRect,
  type PageGeometry,
  unionRect,
  userToDevicePoint,
  userToDeviceRect,
} from './coords';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Named stamps with a generated text-only appearance (spec §3: Draft, Approved, ...). */
export const STAMP_NAMES = [
  'Approved',
  'Experimental',
  'NotApproved',
  'AsIs',
  'Expired',
  'NotForPublicRelease',
  'Confidential',
  'Final',
  'Sold',
  'Departmental',
  'ForComment',
  'TopSecret',
  'Draft',
  'ForPublicRelease',
] as const;

/** Note icons PDF viewers draw for /Text annotations (ISO 32000-2 §12.5.6.4). */
export const NOTE_ICONS = [
  'Comment',
  'Key',
  'Note',
  'Help',
  'NewParagraph',
  'Paragraph',
  'Insert',
] as const;

/** `#rrggbb` as `#RRGGBB`; other values unchanged. */
function normalizeColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : color;
}

/**
 * PDFium stores opacity as 8 bits (/CA = n/255). Two-decimal values survive the roundtrip
 * exactly when rounded back to two decimals (|n/255 - v| <= 1/510 < 0.005).
 */
export function roundOpacity(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

export function standardFontFromFamily(family: string | undefined): PdfStandardFont {
  const f = (family ?? '').toLowerCase();
  if (f.includes('times') || f.includes('serif')) {
    return f.includes('sans') ? PdfStandardFont.Helvetica : PdfStandardFont.Times_Roman;
  }
  if (f.includes('courier') || f.includes('mono')) {
    return PdfStandardFont.Courier;
  }
  return PdfStandardFont.Helvetica;
}

export function familyFromStandardFont(font: PdfStandardFont): string | undefined {
  const name = PdfStandardFont[font];
  return name === undefined || font === PdfStandardFont.Unknown
    ? undefined
    : name.replace(/_/g, '-');
}

// ---------------------------------------------------------------------------
// EmbedPDF -> ours
// ---------------------------------------------------------------------------

const MARKUP_KINDS: Partial<Record<PdfAnnotationSubtype, AnnotationKind>> = {
  [PdfAnnotationSubtype.HIGHLIGHT]: 'highlight',
  [PdfAnnotationSubtype.UNDERLINE]: 'underline',
  [PdfAnnotationSubtype.STRIKEOUT]: 'strikeout',
  [PdfAnnotationSubtype.SQUIGGLY]: 'squiggly',
};

function baseFrom(
  a: PdfAnnotationObject,
  g: PageGeometry,
  kind: AnnotationKind,
): Mutable<AnnotationBase> {
  const base: Mutable<AnnotationBase> = {
    id: a.id,
    kind,
    pageIndex: a.pageIndex,
    rect: annotationRectToUser(g, a.rect),
  };
  if (a.author) base.author = a.author;
  if (a.contents) base.contents = a.contents;
  if (a.modified instanceof Date && !Number.isNaN(a.modified.getTime())) {
    base.modified = a.modified.toISOString();
  }
  if (a.flags && a.flags.length > 0) {
    base.flags = {
      hidden: a.flags.includes('hidden'),
      print: a.flags.includes('print'),
      locked: a.flags.includes('locked'),
    };
  }
  return base;
}

function withColors(
  base: Mutable<AnnotationBase>,
  color: string | undefined,
  interior: string | undefined,
  opacity: number | undefined,
): void {
  if (color && color !== 'transparent') base.color = normalizeColor(color);
  if (interior && interior !== 'transparent') base.interiorColor = normalizeColor(interior);
  if (opacity !== undefined) base.opacity = roundOpacity(opacity);
}

/**
 * Maps an EmbedPDF annotation to ours. Returns undefined for kinds we do not model
 * (popup, widget, caret, file attachment, ...); callers log and skip those.
 */
export function fromEmbedPdf(a: PdfAnnotationObject, g: PageGeometry): Annotation | undefined {
  const markupKind = MARKUP_KINDS[a.type];
  if (markupKind) {
    const m = a as
      | PdfHighlightAnnoObject
      | PdfUnderlineAnnoObject
      | PdfStrikeOutAnnoObject
      | PdfSquigglyAnnoObject;
    const base = baseFrom(a, g, markupKind);
    withColors(base, m.strokeColor, undefined, m.opacity);
    return {
      ...base,
      kind: markupKind as 'highlight',
      quads: (m.segmentRects ?? []).map((r) => deviceToUserRect(g, r)),
    };
  }
  switch (a.type) {
    case PdfAnnotationSubtype.REDACT: {
      // /C is the outline (`color`), /IC the fill once applied (`interiorColor`), /OC the
      // overlay text colour (docs/research/06-redaction-spike.md §1).
      const r = a;
      const base = baseFrom(a, g, 'redact');
      withColors(base, r.strokeColor, r.color, r.opacity);
      const overlayColor =
        r.overlayColor && r.overlayColor !== 'transparent'
          ? normalizeColor(r.overlayColor)
          : undefined;
      return {
        ...base,
        kind: 'redact',
        quads: (r.segmentRects ?? []).map((q) => deviceToUserRect(g, q)),
        ...(r.overlayText ? { overlayText: r.overlayText } : {}),
        ...(overlayColor ? { overlayColor } : {}),
      };
    }
    case PdfAnnotationSubtype.INK: {
      const ink = a;
      const base = baseFrom(a, g, 'ink');
      withColors(base, ink.strokeColor, undefined, ink.opacity);
      return {
        ...base,
        kind: 'ink',
        strokeWidth: ink.strokeWidth,
        paths: ink.inkList.map((stroke) => stroke.points.map((p) => deviceToUserPoint(g, p))),
      };
    }
    case PdfAnnotationSubtype.SQUARE:
    case PdfAnnotationSubtype.CIRCLE: {
      const s = a;
      const kind = a.type === PdfAnnotationSubtype.SQUARE ? 'square' : 'circle';
      const base = baseFrom(a, g, kind);
      withColors(base, s.strokeColor, s.color, s.opacity);
      return { ...base, kind, strokeWidth: s.strokeWidth };
    }
    case PdfAnnotationSubtype.LINE: {
      const l = a;
      const base = baseFrom(a, g, 'line');
      withColors(base, l.strokeColor, l.color, l.opacity);
      return {
        ...base,
        kind: 'line',
        strokeWidth: l.strokeWidth,
        vertices: [
          deviceToUserPoint(g, l.linePoints.start),
          deviceToUserPoint(g, l.linePoints.end),
        ],
        ...readLineEndings(l.lineEndings),
      };
    }
    case PdfAnnotationSubtype.POLYGON:
    case PdfAnnotationSubtype.POLYLINE: {
      const p = a;
      const kind = a.type === PdfAnnotationSubtype.POLYGON ? 'polygon' : 'polyline';
      const base = baseFrom(a, g, kind);
      withColors(base, p.strokeColor, p.color, p.opacity);
      return {
        ...base,
        kind,
        strokeWidth: p.strokeWidth,
        vertices: p.vertices.map((v) => deviceToUserPoint(g, v)),
        ...(a.type === PdfAnnotationSubtype.POLYLINE ? readLineEndings(a.lineEndings) : {}),
      };
    }
    case PdfAnnotationSubtype.FREETEXT: {
      const f = a;
      const base = baseFrom(a, g, 'free-text');
      withColors(base, f.strokeColor, f.color, f.opacity);
      const family = familyFromStandardFont(f.fontFamily);
      return {
        ...base,
        kind: 'free-text',
        text: f.contents ?? '',
        fontSize: f.fontSize,
        ...(family === undefined ? {} : { fontFamily: family }),
        ...(f.fontColor ? { textColor: normalizeColor(f.fontColor) } : {}),
      };
    }
    case PdfAnnotationSubtype.TEXT: {
      const t = a;
      const base = baseFrom(a, g, 'text');
      withColors(base, t.strokeColor, undefined, t.opacity);
      const iconName = annotationName(t.name);
      return { ...base, kind: 'text', ...(iconName === undefined ? {} : { icon: iconName }) };
    }
    case PdfAnnotationSubtype.STAMP: {
      const s = a;
      const base = baseFrom(a, g, 'stamp');
      const name = annotationName(s.name);
      // The appearance is not listed (see StampAnnotation.imageBlob); the adapter adds
      // the opacity it keeps for stamps (EmbedPDF does not write /CA for them).
      return { ...base, kind: 'stamp', ...(name === undefined ? {} : { name }) };
    }
    case PdfAnnotationSubtype.LINK: {
      const l = a;
      const base = baseFrom(a, g, 'link');
      withColors(base, l.strokeColor, undefined, undefined);
      const target = l.target;
      if (target?.type === 'destination') {
        return { ...base, kind: 'link', targetPageIndex: target.destination.pageIndex };
      }
      if (target?.type === 'action') {
        const action = target.action;
        if (action.type === PdfActionType.URI) {
          return { ...base, kind: 'link', uri: action.uri };
        }
        if (action.type === PdfActionType.Goto) {
          return { ...base, kind: 'link', targetPageIndex: action.destination.pageIndex };
        }
      }
      return { ...base, kind: 'link' };
    }
    default:
      return undefined;
  }
}

const LINE_ENDINGS: Readonly<Record<LineEnding, PdfAnnotationLineEnding>> = {
  none: PdfAnnotationLineEnding.None,
  square: PdfAnnotationLineEnding.Square,
  circle: PdfAnnotationLineEnding.Circle,
  diamond: PdfAnnotationLineEnding.Diamond,
  'open-arrow': PdfAnnotationLineEnding.OpenArrow,
  'closed-arrow': PdfAnnotationLineEnding.ClosedArrow,
  butt: PdfAnnotationLineEnding.Butt,
  'r-open-arrow': PdfAnnotationLineEnding.ROpenArrow,
  'r-closed-arrow': PdfAnnotationLineEnding.RClosedArrow,
  slash: PdfAnnotationLineEnding.Slash,
};

function lineEndingName(value: PdfAnnotationLineEnding | undefined): LineEnding | undefined {
  const entry = Object.entries(LINE_ENDINGS).find(([, v]) => v === value);
  return entry?.[0] as LineEnding | undefined;
}

function readLineEndings(
  endings: { start: PdfAnnotationLineEnding; end: PdfAnnotationLineEnding } | undefined,
): { lineEndings?: { start?: LineEnding; end?: LineEnding } } {
  const start = lineEndingName(endings?.start);
  const end = lineEndingName(endings?.end);
  const out: { start?: LineEnding; end?: LineEnding } = {};
  if (start && start !== 'none') out.start = start;
  if (end && end !== 'none') out.end = end;
  return out.start || out.end ? { lineEndings: out } : {};
}

function writeLineEndings(a: NewAnnotation): {
  lineEndings?: { start: PdfAnnotationLineEnding; end: PdfAnnotationLineEnding };
} {
  if (a.kind !== 'line' && a.kind !== 'polyline') return {};
  return {
    lineEndings: {
      start: LINE_ENDINGS[a.lineEndings?.start ?? 'none'],
      end: LINE_ENDINGS[a.lineEndings?.end ?? 'none'],
    },
  };
}

function annotationName(name: PdfAnnotationName | undefined): string | undefined {
  if (name === undefined || name === PdfAnnotationName.Unknown) return undefined;
  return PdfAnnotationName[name];
}

// ---------------------------------------------------------------------------
// ours -> EmbedPDF
// ---------------------------------------------------------------------------

function flagNames(a: NewAnnotation): PdfAnnotationFlagName[] {
  const names: PdfAnnotationFlagName[] = [];
  if (a.flags?.hidden) names.push('hidden');
  if (a.flags?.print ?? true) names.push('print');
  if (a.flags?.locked) names.push('locked');
  // Note icons keep their size and orientation when zoomed or on rotated pages, as
  // Acrobat writes them.
  if (a.kind === 'text') names.push('noZoom', 'noRotate');
  return names;
}

function pointsBounds(points: readonly { x: number; y: number }[], pad: number): Rect | undefined {
  if (points.length === 0) return undefined;
  const rect = unionRect(points.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 }))) as Rect;
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + 2 * pad,
    height: rect.height + 2 * pad,
  };
}

/**
 * The /Rect written for an annotation. Box kinds use `rect` as given. Kinds whose geometry
 * lives elsewhere (quads, ink paths, vertices) get the smallest rect that encloses both the
 * given rect (when it is not empty) and the geometry, padded by half the stroke width so
 * the appearance stream (clipped to /Rect) shows the whole stroke.
 */
export function effectiveRect(a: NewAnnotation): Rect {
  const given = a.rect.width > 0 || a.rect.height > 0 ? a.rect : undefined;
  let geometry: Rect | undefined;
  switch (a.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly':
    case 'redact':
      geometry = unionRect(a.quads);
      break;
    case 'ink':
      geometry = pointsBounds(a.paths.flat(), a.strokeWidth / 2);
      break;
    case 'line':
    case 'polygon':
    case 'polyline': {
      // Line endings are drawn around the end points, a few stroke widths wide.
      const endings = a.kind === 'polygon' ? undefined : a.lineEndings;
      const decorated = [endings?.start, endings?.end].some((e) => e !== undefined && e !== 'none');
      const pad = decorated ? Math.max(a.strokeWidth * 5, 6) : a.strokeWidth / 2;
      geometry = pointsBounds(a.vertices ?? [], pad);
      break;
    }
    default:
      break;
  }
  if (!geometry) return a.rect;
  return given ? (unionRect([given, geometry]) as Rect) : geometry;
}

/** Whether a user-space rect (or point list) is the same within `tolerance` points. */
export function sameRect(a: Rect, b: Rect, tolerance = 0.01): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

function iconFromName(name: string | undefined): PdfAnnotationName | undefined {
  if (!name) return undefined;
  return (PdfAnnotationName as unknown as Record<string, PdfAnnotationName | undefined>)[name];
}

/** Colour of the links we write (their underline appearance and /C). */
export const LINK_COLOR = '#0000FF';

/**
 * Builds the EmbedPDF object for a create/update. `id` may be empty for a create; EmbedPDF
 * then generates one (and writes it to /NM).
 */
export function toEmbedPdf(a: NewAnnotation, id: string, g: PageGeometry): PdfAnnotationObject {
  const modified = a.modified === undefined ? new Date() : new Date(a.modified);
  const base = {
    id,
    pageIndex: a.pageIndex,
    rect: userToDeviceRect(g, effectiveRect(a)),
    flags: flagNames(a),
    // Always written: an update carries the full new state, so absent means empty (an
    // undo back to "no comment" must clear it).
    author: a.author ?? '',
    contents: a.contents ?? '',
    // /M is required by our conformance rules; PDFium only writes it when given.
    modified: Number.isNaN(modified.getTime()) ? new Date() : modified,
  };
  const opacity = a.opacity ?? 1;
  switch (a.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly': {
      const type = {
        highlight: PdfAnnotationSubtype.HIGHLIGHT,
        underline: PdfAnnotationSubtype.UNDERLINE,
        strikeout: PdfAnnotationSubtype.STRIKEOUT,
        squiggly: PdfAnnotationSubtype.SQUIGGLY,
      }[a.kind];
      const color = a.color ?? (a.kind === 'highlight' ? '#FFEB3B' : '#E53935');
      return {
        ...base,
        type,
        opacity,
        strokeColor: color,
        // Highlights darken the text under them instead of covering it.
        ...(a.kind === 'highlight' ? { blendMode: PdfBlendMode.Multiply } : {}),
        segmentRects: a.quads.map((q) => userToDeviceRect(g, q)),
      } as PdfHighlightAnnoObject;
    }
    case 'redact': {
      const redact: PdfRedactAnnoObject = {
        ...base,
        type: PdfAnnotationSubtype.REDACT,
        segmentRects: a.quads.map((q) => userToDeviceRect(g, q)),
        // EmbedPDF writes `color` as /IC (the fill applying paints), `strokeColor` as /C
        // and `overlayColor` as /OC. Without /IC applying removes content but paints
        // nothing (spike 06 §1), so it defaults to black.
        color: a.interiorColor ?? '#000000',
        strokeColor: a.color ?? '#E53935',
        opacity,
        // Always written: an update carries the full state, so absent clears them.
        overlayText: a.overlayText ?? '',
        overlayColor: a.overlayColor ?? 'transparent',
      };
      return redact;
    }
    case 'ink': {
      const color = a.color ?? '#000000';
      const ink: PdfInkAnnoObject = {
        ...base,
        type: PdfAnnotationSubtype.INK,
        inkList: a.paths.map((path) => ({ points: path.map((p) => userToDevicePoint(g, p)) })),
        strokeColor: color,
        opacity,
        strokeWidth: a.strokeWidth,
      };
      return ink;
    }
    case 'square':
    case 'circle': {
      const shape: PdfSquareAnnoObject = {
        ...base,
        type: PdfAnnotationSubtype.SQUARE,
        color: a.interiorColor ?? 'transparent',
        strokeColor: a.color ?? '#000000',
        opacity,
        strokeWidth: a.strokeWidth,
        strokeStyle: PdfAnnotationBorderStyle.SOLID,
      };
      if (a.kind === 'circle') {
        return { ...shape, type: PdfAnnotationSubtype.CIRCLE };
      }
      return shape;
    }
    case 'line':
    case 'polygon':
    case 'polyline': {
      const vertices = (a.vertices ?? []).map((v) => userToDevicePoint(g, v));
      const common = {
        ...base,
        color: a.interiorColor ?? 'transparent',
        strokeColor: a.color ?? '#000000',
        opacity,
        strokeWidth: a.strokeWidth,
        strokeStyle: PdfAnnotationBorderStyle.SOLID,
      };
      if (a.kind === 'line') {
        const [start, end] = vertices;
        if (!start || !end) {
          throw new EngineError('internal', 'A line annotation needs two vertices');
        }
        const line: PdfLineAnnoObject = {
          ...common,
          ...writeLineEndings(a),
          type: PdfAnnotationSubtype.LINE,
          linePoints: { start, end },
        };
        return line;
      }
      if (a.kind === 'polygon') {
        const polygon: PdfPolygonAnnoObject = {
          ...common,
          type: PdfAnnotationSubtype.POLYGON,
          vertices,
        };
        return polygon;
      }
      const polyline: PdfPolylineAnnoObject = {
        ...common,
        ...writeLineEndings(a),
        type: PdfAnnotationSubtype.POLYLINE,
        vertices,
      };
      return polyline;
    }
    case 'free-text': {
      const freeText: PdfFreeTextAnnoObject = {
        ...base,
        type: PdfAnnotationSubtype.FREETEXT,
        contents: a.text,
        fontFamily: standardFontFromFamily(a.fontFamily),
        fontSize: a.fontSize,
        fontColor: a.textColor ?? a.color ?? '#000000',
        textAlign: PdfTextAlignment.Left,
        verticalAlign: PdfVerticalAlignment.Top,
        opacity,
        ...(a.interiorColor === undefined ? {} : { color: a.interiorColor }),
      };
      return freeText;
    }
    case 'text': {
      const icon = iconFromName(a.icon) ?? PdfAnnotationName.Comment;
      const note: PdfTextAnnoObject = {
        ...base,
        type: PdfAnnotationSubtype.TEXT,
        contents: a.contents ?? '',
        strokeColor: a.color ?? '#FFEB3B',
        opacity,
        name: icon,
      };
      return note;
    }
    case 'stamp': {
      const icon = iconFromName(a.name);
      const stamp: PdfStampAnnoObject = {
        ...base,
        type: PdfAnnotationSubtype.STAMP,
        ...(icon === undefined ? {} : { name: icon }),
      };
      return stamp;
    }
    case 'link': {
      const link: PdfLinkAnnoObject = {
        ...base,
        type: PdfAnnotationSubtype.LINK,
        // The generated appearance is an underline (/BS /S /U) in this colour; without /C,
        // pdf.js draws a second, black underline from /BS (it reads a missing /C as black).
        strokeColor: a.color ?? LINK_COLOR,
        target:
          a.uri !== undefined
            ? { type: 'action', action: { type: PdfActionType.URI, uri: a.uri } }
            : a.targetPageIndex !== undefined
              ? {
                  type: 'destination',
                  destination: {
                    pageIndex: a.targetPageIndex,
                    zoom: { mode: PdfZoomMode.FitPage },
                    view: [],
                  },
                }
              : undefined,
      };
      return link;
    }
  }
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

interface Point {
  readonly x: number;
  readonly y: number;
}

function samePoints(a: readonly Point[], b: readonly Point[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => {
      const q = b[i] as Point;
      return Math.abs(p.x - q.x) <= 0.01 && Math.abs(p.y - q.y) <= 0.01;
    })
  );
}

/**
 * The ink's per-point widths when they match its paths point for point (ADR-0018 §4), else
 * `undefined`: widths that no longer match (a path removed or edited without them) mean a
 * constant-width stroke. Data only: the appearance from the widths is written elsewhere.
 */
export function matchingInkWidths(
  a: Pick<InkAnnotation, 'paths' | 'widths'>,
): readonly (readonly number[])[] | undefined {
  const widths = a.widths;
  if (widths?.length !== a.paths.length) return undefined;
  const matches = widths.every(
    (ws, i) =>
      ws.length === (a.paths[i]?.length ?? -1) && ws.every((w) => Number.isFinite(w) && w > 0),
  );
  return matches ? widths : undefined;
}

/** `a` with its widths kept only when they match its paths. */
function withMatchingInkWidths<T extends InkAnnotation>(a: T): T {
  if (a.widths === undefined || matchingInkWidths(a)) return a;
  const { widths: _dropped, ...rest } = a;
  return rest as T;
}

/**
 * For kinds whose geometry is not the rect (quads, ink paths, vertices): when an update
 * changes only `rect`, maps the geometry from the old rect onto the new one (a move, or a
 * resize that scales the geometry). An update that changes the geometry is taken as is.
 */
export function followRect(before: Annotation, after: Annotation): Annotation {
  if (before.kind !== after.kind || sameRect(before.rect, after.rect)) return after;
  const from = before.rect;
  const to = after.rect;
  const sx = from.width > 0 ? to.width / from.width : 1;
  const sy = from.height > 0 ? to.height / from.height : 1;
  const map = (p: Point): Point => ({
    x: to.x + (p.x - from.x) * sx,
    y: to.y + (p.y - from.y) * sy,
  });
  const mapRect = (r: Rect): Rect => {
    const a = map({ x: r.x, y: r.y });
    return { x: a.x, y: a.y, width: r.width * sx, height: r.height * sy };
  };
  switch (after.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly':
    case 'redact': {
      const old = (before as MarkupAnnotation).quads;
      const unchanged =
        old.length === after.quads.length &&
        old.every((q, i) => sameRect(q, after.quads[i] as Rect));
      return unchanged ? { ...after, quads: after.quads.map(mapRect) } : after;
    }
    case 'ink': {
      const old = (before as InkAnnotation).paths;
      const unchanged =
        old.length === after.paths.length &&
        old.every((p, i) => samePoints(p, after.paths[i] ?? []));
      const next = withMatchingInkWidths(after);
      return unchanged ? { ...next, paths: next.paths.map((path) => path.map(map)) } : next;
    }
    case 'line':
    case 'polygon':
    case 'polyline': {
      const old = (before as ShapeAnnotation).vertices ?? [];
      const vertices = after.vertices ?? [];
      return samePoints(old, vertices) ? { ...after, vertices: vertices.map(map) } : after;
    }
    default:
      return after;
  }
}

// ---------------------------------------------------------------------------
// Content checks
// ---------------------------------------------------------------------------

/** Windows-1252 code points above 0x7F that are not Latin-1 (the 0x80-0x9F row). */
const CP1252_EXTRAS = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/**
 * Whether PDFium's FreeText appearance (a standard-14 font with WinAnsiEncoding) can show
 * `ch`. Line breaks and tabs count as showable.
 */
export function isWinAnsi(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (ch === '\n' || ch === '\r' || ch === '\t') return true;
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0xa0 && code <= 0xff) return true;
  return CP1252_EXTRAS.has(ch);
}

/** PNG, JPEG or PDF by magic bytes (what EmbedPDF's stamp creation accepts). */
export function sniffStampData(head: Uint8Array): 'png' | 'jpeg' | 'pdf' | undefined {
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'pdf';
  return undefined;
}
