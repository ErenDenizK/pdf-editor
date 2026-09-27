/**
 * Mapping between EmbedPDF annotation objects (device space, see coords.ts) and our
 * engine-neutral `Annotation` union (PDF user space).
 */

import {
  PdfActionType,
  PdfAnnotationBorderStyle,
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
  type NewAnnotation,
} from '../types';
import {
  deviceToUserPoint,
  deviceToUserRect,
  type PageGeometry,
  unionRect,
  userToDevicePoint,
  userToDeviceRect,
} from './coords';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

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
    rect: deviceToUserRect(g, a.rect),
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
  if (color && color !== 'transparent') base.color = color;
  if (interior && interior !== 'transparent') base.interiorColor = interior;
  if (opacity !== undefined) base.opacity = opacity;
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
      const r = a;
      const base = baseFrom(a, g, 'redact');
      withColors(base, r.strokeColor ?? r.color, r.overlayColor, r.opacity);
      return {
        ...base,
        kind: 'redact',
        quads: (r.segmentRects ?? []).map((q) => deviceToUserRect(g, q)),
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
        ...(f.fontColor ? { textColor: f.fontColor } : {}),
      };
    }
    case PdfAnnotationSubtype.TEXT: {
      const t = a;
      const base = baseFrom(a, g, 'text');
      withColors(base, t.strokeColor, undefined, t.opacity);
      const icon = t.name;
      const iconName = icon === undefined ? undefined : PdfAnnotationName[icon];
      return { ...base, kind: 'text', ...(iconName === undefined ? {} : { icon: iconName }) };
    }
    case PdfAnnotationSubtype.STAMP: {
      const s = a;
      const base = baseFrom(a, g, 'stamp');
      const icon = s.name;
      const name = icon === undefined ? undefined : PdfAnnotationName[icon];
      // TODO(M2): expose the appearance as `imageBlob` via renderPageAnnotation.
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

// ---------------------------------------------------------------------------
// ours -> EmbedPDF
// ---------------------------------------------------------------------------

function flagNames(a: NewAnnotation): PdfAnnotationFlagName[] {
  if (!a.flags) {
    return ['print'];
  }
  const names: PdfAnnotationFlagName[] = [];
  if (a.flags.hidden) names.push('hidden');
  if (a.flags.print ?? true) names.push('print');
  if (a.flags.locked) names.push('locked');
  return names;
}

function iconFromName(name: string | undefined): PdfAnnotationName | undefined {
  if (!name) return undefined;
  return (PdfAnnotationName as unknown as Record<string, PdfAnnotationName | undefined>)[name];
}

/**
 * Builds the EmbedPDF object for a create/update. `id` may be empty for a create; EmbedPDF
 * then generates one (and writes it to /NM).
 */
export function toEmbedPdf(a: NewAnnotation, id: string, g: PageGeometry): PdfAnnotationObject {
  const quads = 'quads' in a ? a.quads : undefined;
  const rectUser: Rect =
    a.rect.width > 0 || a.rect.height > 0 ? a.rect : (unionRect(quads ?? []) ?? a.rect);
  const base = {
    id,
    pageIndex: a.pageIndex,
    rect: userToDeviceRect(g, rectUser),
    flags: flagNames(a),
    ...(a.author === undefined ? {} : { author: a.author }),
    ...(a.contents === undefined ? {} : { contents: a.contents }),
    ...(a.modified === undefined ? {} : { modified: new Date(a.modified) }),
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
        segmentRects: a.quads.map((q) => userToDeviceRect(g, q)),
      } as PdfHighlightAnnoObject;
    }
    case 'redact': {
      const redact: PdfRedactAnnoObject = {
        ...base,
        type: PdfAnnotationSubtype.REDACT,
        segmentRects: a.quads.map((q) => userToDeviceRect(g, q)),
        strokeColor: a.color ?? '#E53935',
        overlayColor: a.interiorColor ?? '#000000',
        opacity,
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
