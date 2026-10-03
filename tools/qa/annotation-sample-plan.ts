/**
 * The plan of docs/qa/samples/annotations-sample.pdf: every labelled annotation with what a
 * conformant viewer must show for it. Shared by the generator (make-annotation-sample.ts),
 * which writes exactly these annotations, and the automated matrix (annotation-matrix.ts),
 * which renders the sample and checks each entry against it.
 *
 * Coordinates are PDF user space of the unrotated page (origin bottom-left, points), like
 * the engine's annotation rects. Page 2 has /Rotate 90; its entries are placed in user
 * space and the checker maps them to display space.
 */

import type { NewAnnotation } from '@pdf-editor/engine';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** The committed sample, relative to tools/qa (Vitest's `commands` resolve from there). */
export const SAMPLE_PATH = '../../docs/qa/samples/annotations-sample.pdf';
/** Every date written into the sample (/M, /CreationDate, /ModDate): keeps it reproducible. */
export const SAMPLE_DATE = '2026-01-01T00:00:00.000Z';
export const SAMPLE_AUTHOR = 'QA sample';
export const PAGE_SIZE = { width: 612, height: 792 } as const;
/** /Rotate of each page. */
export const PAGE_ROTATIONS = [0, 90] as const;

/** The text line under every text markup, in Helvetica at TEXT_SIZE, baseline at quad.y + 3. */
export const SAMPLE_TEXT = 'The quick brown fox jumps over the lazy dog';
export const TEXT_SIZE = 12;
/** Width of SAMPLE_TEXT in Helvetica at TEXT_SIZE (the generator asserts it with pdf-lib). */
export const SAMPLE_TEXT_WIDTH = 235.812;
const DESCENT = 3;

export type PdfSubtype =
  | 'Highlight'
  | 'Underline'
  | 'StrikeOut'
  | 'Squiggly'
  | 'Ink'
  | 'Square'
  | 'Circle'
  | 'Line'
  | 'Polygon'
  | 'PolyLine'
  | 'FreeText'
  | 'Text'
  | 'Stamp'
  | 'Link';

export interface Appearance {
  /** Where the appearance must be drawn (user space). */
  readonly region: Rect;
  /**
   * `rect`: the region as mapped through the page rotation. `no-rotate` (notes, ISO 32000-2
   * §12.5.6.4): an upright box of the region's size hung from the display position of the
   * region's user-space upper-left corner; on an unrotated page both are the same.
   */
  readonly placement: 'rect' | 'no-rotate';
  /** The colour that must dominate the region, as composited over white (#RRGGBB). */
  readonly colour: string;
  /**
   * How much of the region the colour must span: `both` (60 % of width and height), `x`
   * (width only: strokes along a text line) or `none` (text of a free-text box).
   */
  readonly span: 'both' | 'x' | 'none';
  /** Dark text that must stay visible under the appearance (user space). */
  readonly textVisible?: Rect;
  /**
   * For underline, strikeout and squiggly: where the stroke's centre must lie, as a
   * fraction of the region height from its bottom edge (the text baseline is at 0.21).
   */
  readonly strokeBand?: readonly [number, number];
  /** Nothing but the expected colour may be drawn here (no black or grey ink). */
  readonly exclusive?: true;
}

export interface PlanEntry {
  /** Stable key; the annotation's /NM is `qa-<key>`. */
  readonly key: string;
  /** Printed on the page next to the annotation. */
  readonly label: string;
  /** Where the label is drawn (user space, baseline). */
  readonly at: readonly [number, number];
  /** Text printed underneath the annotation (to prove the annotation lets it show through). */
  readonly underlay?: { readonly text: string; readonly at: readonly [number, number] };
  /** A text markup: SAMPLE_TEXT is printed under its first quad. */
  readonly overText?: true;
  /** The generator attaches the PNG stamp image. */
  readonly imageStamp?: true;
  readonly annotation: NewAnnotation;
  readonly subtype: PdfSubtype;
  /** What the annotation's /Rect must cover (user space); derived rects may be larger. */
  readonly geometry: Rect;
  /** What must be drawn; every entry of the sample has one. */
  readonly appearance?: Appearance;
  /**
   * A variable-width ink (ADR-0018): how its drawn width must vary along the stroke. Its
   * annotation carries the per-point `widths`; its `strokeWidth` is the nominal /BS /W.
   */
  readonly widthProfile?: WidthProfile;
}

/** How the drawn width of a straight variable-width stroke is checked. */
export interface WidthProfile {
  /** The centre line: one straight stroke (user space). */
  readonly from: Point;
  readonly to: Point;
  /** /InkList points along it, evenly spaced. */
  readonly points: number;
  /** Full width at `from` and at `to` (points); linear in between, one per /InkList point. */
  readonly startWidth: number;
  readonly endWidth: number;
  /** Where along the stroke (0–1) the drawn width is measured, across the stroke. */
  readonly at: readonly number[];
  /**
   * Allowed difference between the drawn and the planned width, and between the drawn and
   * the planned centre (points, at 2× render).
   */
  readonly tolerance: number;
  /** The drawn width must grow at least this much from the first to the last sample. */
  readonly minRatio: number;
}

/** One row of the results table: aspects of one plan entry, or of several checked alike. */
export interface MatrixRow {
  readonly title: string;
  readonly key: string;
  /** Further entries the row checks the same way (problems then name the entry). */
  readonly alsoKeys?: readonly string[];
  /**
   * `appearance`: the rendered pixels (presence, colour, placement, see-through);
   * `upright`: a note on a rotated page is drawn like the upright note of page 1, not turned
   * with the page; `data`: subtype, /Rect, QuadPoints and /Contents as the renderer reports
   * them; `contents`, `open`, `uri`: what a comment UI or link handler gets (and, for pdf.js,
   * what its annotation layer shows); `width`: the drawn width varies along the stroke as the
   * entry's `widthProfile` plans; `nominal-width`: the width the renderer reports (/BS /W)
   * is the annotation's `strokeWidth`.
   */
  readonly aspects: readonly (
    | 'appearance'
    | 'upright'
    | 'data'
    | 'contents'
    | 'open'
    | 'uri'
    | 'width'
    | 'nominal-width'
  )[];
}

function textQuad(x: number, baseline: number): Rect {
  return { x, y: baseline - DESCENT, width: SAMPLE_TEXT_WIDTH, height: TEXT_SIZE + 2 };
}

function bbox(points: readonly Point[], pad: number): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
}

function inset(rect: Rect, by: number): Rect {
  return {
    x: rect.x + by,
    y: rect.y + by,
    width: rect.width - 2 * by,
    height: rect.height - 2 * by,
  };
}

/** `colour` at `opacity` over white, as #RRGGBB. */
function overWhite(colour: string, opacity: number): string {
  const channels = [1, 3, 5].map((i) => Number.parseInt(colour.slice(i, i + 2), 16));
  return `#${channels
    .map((c) =>
      Math.round(255 - (255 - c) * opacity)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`;
}

const common = { author: SAMPLE_AUTHOR, modified: SAMPLE_DATE } as const;
const id = (key: string) => `qa-${key}`;

function markup(
  kind: 'highlight' | 'underline' | 'strikeout' | 'squiggly',
  subtype: PdfSubtype,
  pageIndex: number,
  key: string,
  baseline: number,
  colour: string,
  label: string,
  contents?: string,
): PlanEntry {
  const quad = textQuad(72, baseline);
  const band: Partial<Record<typeof kind, readonly [number, number]>> = {
    underline: [0, 0.3],
    strikeout: [0.3, 0.7],
    squiggly: [0, 0.3],
  };
  const strokeBand = band[kind];
  return {
    key,
    label,
    at: [400, baseline],
    overText: true,
    subtype,
    geometry: quad,
    annotation: {
      ...common,
      id: id(key),
      kind,
      pageIndex,
      rect: quad,
      quads: [quad],
      color: colour,
      ...(contents === undefined ? {} : { contents }),
    },
    appearance: {
      region: quad,
      placement: 'rect',
      colour,
      ...(strokeBand ? { span: 'x', strokeBand } : { span: 'both', textVisible: inset(quad, 1) }),
    },
  };
}

const ZERO = { x: 0, y: 0, width: 0, height: 0 } as const;

const INK_PATH: readonly Point[] = [
  { x: 72, y: 520 },
  { x: 100, y: 580 },
  { x: 130, y: 530 },
  { x: 160, y: 585 },
];
/** The free Highlighter (craft spec §5.4): a 12 pt Multiply stroke over a line of text. */
const MULTIPLY_INK: readonly Point[] = [
  { x: 72, y: 206 },
  { x: 152, y: 206.5 },
  { x: 232, y: 206 },
];
const MULTIPLY_TEXT = 'text under the highlighter';
const SQUARE: Rect = { x: 200, y: 520, width: 80, height: 60 };
const CIRCLE: Rect = { x: 320, y: 520, width: 80, height: 60 };
const LINE: readonly Point[] = [
  { x: 440, y: 525 },
  { x: 530, y: 580 },
];
const POLYGON: readonly Point[] = [
  { x: 72, y: 400 },
  { x: 160, y: 400 },
  { x: 116, y: 460 },
];
const POLYLINE: readonly Point[] = [
  { x: 200, y: 400 },
  { x: 230, y: 460 },
  { x: 260, y: 400 },
  { x: 290, y: 460 },
];
const FREE_TEXT: Rect = { x: 320, y: 400, width: 220, height: 50 };
const NOTE: Rect = { x: 72, y: 270, width: 20, height: 20 };
const NAMED_STAMP: Rect = { x: 200, y: 270, width: 140, height: 44 };
const IMAGE_STAMP: Rect = { x: 380, y: 270, width: 48, height: 48 };
const LINK: Rect = { x: 72, y: 165, width: 160, height: 18 };
const NOTE_2: Rect = { x: 72, y: 580, width: 20, height: 20 };
const SQUARE_2: Rect = { x: 200, y: 580, width: 100, height: 50 };

export const NOTE_CONTENTS = 'This note text must appear in the comment UI.';
export const LINK_URI = 'https://example.org/';
/** The engine's default ink for positive named stamps (annotations/stamp-appearance.ts). */
const APPROVED_GREEN = '#218C21';

function profilePath(profile: WidthProfile): Point[] {
  const { from, to, points } = profile;
  return Array.from({ length: points }, (_, i) => {
    const t = i / (points - 1);
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  });
}

/** The planned full width at `t` (0–1) along the stroke. */
export function plannedWidth(profile: WidthProfile, t: number): number {
  return profile.startWidth + (profile.endWidth - profile.startWidth) * t;
}

/**
 * A variable-width ink (ADR-0018, spike S1): a straight stroke whose width grows linearly,
 * with the nominal width 4 pt in /BS /W. The generator writes its `widths`; the engine draws
 * the outline in the appearance stream and keeps the widths in `/PdfEditorInkWidths`.
 */
function variableInk(
  key: string,
  label: string,
  pageIndex: number,
  at: readonly [number, number],
  colour: string,
  opacity: number,
  profile: WidthProfile,
): PlanEntry {
  const path = profilePath(profile);
  const widths = path.map((_, i) => plannedWidth(profile, i / (path.length - 1)));
  return {
    key,
    label,
    at,
    subtype: 'Ink',
    geometry: bbox(path, 0.5),
    annotation: {
      ...common,
      id: id(key),
      kind: 'ink',
      pageIndex,
      rect: ZERO,
      paths: [path],
      widths: [widths],
      strokeWidth: 4,
      color: colour,
      ...(opacity < 1 ? { opacity } : {}),
    },
    appearance: {
      region: bbox(path, profile.endWidth / 2),
      placement: 'rect',
      colour: opacity < 1 ? overWhite(colour, opacity) : colour,
      span: 'x',
    },
    widthProfile: profile,
  };
}

const TAPER = { points: 25, startWidth: 1, endWidth: 9, tolerance: 0.6, minRatio: 3 } as const;
const TAPER_AT = [0.1, 0.3, 0.5, 0.7, 0.9] as const;

export const PLAN: readonly PlanEntry[] = [
  markup(
    'highlight',
    'Highlight',
    0,
    'highlight',
    690,
    '#FFEB3B',
    'highlight',
    'highlight comment',
  ),
  markup(
    'underline',
    'Underline',
    0,
    'underline',
    665,
    '#1E88E5',
    'underline',
    'underline comment',
  ),
  markup(
    'strikeout',
    'StrikeOut',
    0,
    'strikeout',
    640,
    '#E53935',
    'strikeout',
    'strikeout comment',
  ),
  markup('squiggly', 'Squiggly', 0, 'squiggly', 615, '#43A047', 'squiggly', 'squiggly comment'),
  {
    key: 'ink',
    label: 'ink',
    at: [72, 500],
    subtype: 'Ink',
    geometry: bbox(INK_PATH, 0),
    annotation: {
      ...common,
      id: id('ink'),
      kind: 'ink',
      pageIndex: 0,
      rect: ZERO,
      paths: [INK_PATH],
      strokeWidth: 2,
      color: '#6A1B9A',
    },
    appearance: { region: bbox(INK_PATH, 2), placement: 'rect', colour: '#6A1B9A', span: 'both' },
  },
  {
    key: 'ink-multiply',
    label: 'ink, Multiply (free highlighter)',
    at: [260, 203],
    underlay: { text: MULTIPLY_TEXT, at: [78, 202] },
    subtype: 'Ink',
    geometry: bbox(MULTIPLY_INK, 0),
    annotation: {
      ...common,
      id: id('ink-multiply'),
      kind: 'ink',
      pageIndex: 0,
      rect: ZERO,
      paths: [MULTIPLY_INK],
      strokeWidth: 12,
      color: '#FFEA00',
      blendMode: 'multiply',
    },
    appearance: {
      region: bbox(MULTIPLY_INK, 6),
      placement: 'rect',
      colour: '#FFEA00',
      span: 'both',
      // The bold underlay's x-height band: black under the tint stays black.
      textVisible: { x: 80, y: 203, width: 110, height: 4 },
    },
  },
  {
    key: 'square',
    label: 'square (50% opacity)',
    at: [200, 500],
    underlay: { text: 'text under fill', at: [209, 546] },
    subtype: 'Square',
    geometry: SQUARE,
    annotation: {
      ...common,
      id: id('square'),
      kind: 'square',
      pageIndex: 0,
      rect: SQUARE,
      strokeWidth: 2,
      color: '#E53935',
      interiorColor: '#FFCDD2',
      opacity: 0.5,
    },
    appearance: {
      region: SQUARE,
      placement: 'rect',
      // The fill dominates; at 50 % it is lighter than #FFCDD2 and the underlay shows.
      colour: overWhite('#FFCDD2', 0.5),
      span: 'both',
      textVisible: { x: 207, y: 542, width: 66, height: 12 },
    },
  },
  {
    key: 'circle',
    label: 'circle',
    at: [320, 500],
    subtype: 'Circle',
    geometry: CIRCLE,
    annotation: {
      ...common,
      id: id('circle'),
      kind: 'circle',
      pageIndex: 0,
      rect: CIRCLE,
      strokeWidth: 2,
      color: '#43A047',
    },
    appearance: { region: CIRCLE, placement: 'rect', colour: '#43A047', span: 'both' },
  },
  {
    key: 'line',
    label: 'line (arrow)',
    at: [440, 500],
    subtype: 'Line',
    geometry: bbox(LINE, 0),
    annotation: {
      ...common,
      id: id('line'),
      kind: 'line',
      pageIndex: 0,
      rect: ZERO,
      strokeWidth: 2,
      vertices: LINE,
      lineEndings: { end: 'open-arrow' },
      color: '#000000',
    },
    // The arrow head reaches past the end point.
    appearance: { region: bbox(LINE, 6), placement: 'rect', colour: '#000000', span: 'both' },
  },
  {
    key: 'polygon',
    label: 'polygon',
    at: [72, 380],
    subtype: 'Polygon',
    geometry: bbox(POLYGON, 0),
    annotation: {
      ...common,
      id: id('polygon'),
      kind: 'polygon',
      pageIndex: 0,
      rect: ZERO,
      strokeWidth: 1.5,
      vertices: POLYGON,
      color: '#00897B',
      interiorColor: '#B2DFDB',
    },
    appearance: { region: bbox(POLYGON, 2), placement: 'rect', colour: '#B2DFDB', span: 'both' },
  },
  {
    key: 'polyline',
    label: 'polyline',
    at: [200, 380],
    subtype: 'PolyLine',
    geometry: bbox(POLYLINE, 0),
    annotation: {
      ...common,
      id: id('polyline'),
      kind: 'polyline',
      pageIndex: 0,
      rect: ZERO,
      strokeWidth: 1.5,
      vertices: POLYLINE,
      color: '#F4511E',
    },
    appearance: { region: bbox(POLYLINE, 2), placement: 'rect', colour: '#F4511E', span: 'both' },
  },
  {
    key: 'free-text',
    label: 'free text',
    at: [320, 380],
    subtype: 'FreeText',
    geometry: FREE_TEXT,
    annotation: {
      ...common,
      id: id('free-text'),
      kind: 'free-text',
      pageIndex: 0,
      rect: FREE_TEXT,
      text: 'Free text in a box, 14 pt',
      fontSize: 14,
      textColor: '#C62828',
    },
    appearance: { region: FREE_TEXT, placement: 'rect', colour: '#C62828', span: 'none' },
  },
  {
    key: 'note',
    label: 'note (open popup)',
    at: [72, 250],
    subtype: 'Text',
    geometry: NOTE,
    annotation: {
      ...common,
      id: id('note'),
      kind: 'text',
      pageIndex: 0,
      rect: NOTE,
      contents: NOTE_CONTENTS,
      icon: 'Comment',
      open: true,
      color: '#FFEB3B',
    },
    appearance: { region: NOTE, placement: 'no-rotate', colour: '#FFEB3B', span: 'both' },
  },
  {
    key: 'stamp-named',
    label: 'stamp (named: Approved)',
    at: [200, 250],
    subtype: 'Stamp',
    geometry: NAMED_STAMP,
    annotation: {
      ...common,
      id: id('stamp-named'),
      kind: 'stamp',
      pageIndex: 0,
      rect: NAMED_STAMP,
      name: 'Approved',
    },
    appearance: { region: NAMED_STAMP, placement: 'rect', colour: APPROVED_GREEN, span: 'both' },
  },
  {
    key: 'stamp-image',
    label: 'stamp (image)',
    at: [380, 250],
    imageStamp: true,
    subtype: 'Stamp',
    geometry: IMAGE_STAMP,
    annotation: {
      ...common,
      id: id('stamp-image'),
      kind: 'stamp',
      pageIndex: 0,
      rect: IMAGE_STAMP,
      contents: 'Image stamp',
    },
    appearance: { region: IMAGE_STAMP, placement: 'rect', colour: '#1E88E5', span: 'both' },
  },
  {
    key: 'link',
    label: `link (${LINK_URI})`,
    at: [72, 150],
    subtype: 'Link',
    geometry: LINK,
    annotation: {
      ...common,
      id: id('link'),
      kind: 'link',
      pageIndex: 0,
      rect: LINK,
      uri: LINK_URI,
    },
    // EmbedPDF gives links a 2 pt blue underline appearance (/BS /U, /AP) and no /C.
    appearance: {
      region: { x: LINK.x, y: LINK.y - 1, width: LINK.width, height: 5 },
      placement: 'rect',
      colour: '#0000FF',
      span: 'x',
      exclusive: true,
    },
  },
  markup(
    'highlight',
    'Highlight',
    1,
    'rotated-highlight',
    690,
    '#FFEB3B',
    'highlight on a rotated page',
  ),
  {
    key: 'rotated-note',
    label: 'note on a rotated page',
    at: [72, 560],
    subtype: 'Text',
    geometry: NOTE_2,
    annotation: {
      ...common,
      id: id('rotated-note'),
      kind: 'text',
      pageIndex: 1,
      rect: NOTE_2,
      contents: 'Rotated page note',
      icon: 'Comment',
      color: '#FFEB3B',
    },
    appearance: { region: NOTE_2, placement: 'no-rotate', colour: '#FFEB3B', span: 'both' },
  },
  {
    key: 'rotated-square',
    label: 'square on a rotated page',
    at: [200, 560],
    subtype: 'Square',
    geometry: SQUARE_2,
    annotation: {
      ...common,
      id: id('rotated-square'),
      kind: 'square',
      pageIndex: 1,
      rect: SQUARE_2,
      strokeWidth: 2,
      color: '#1E88E5',
    },
    appearance: { region: SQUARE_2, placement: 'rect', colour: '#1E88E5', span: 'both' },
  },
  variableInk('ink-variable', 'ink, variable width 1-9 pt', 0, [300, 125], '#1E5BD8', 1, {
    ...TAPER,
    from: { x: 300, y: 105 },
    to: { x: 540, y: 105 },
    at: TAPER_AT,
  }),
  variableInk(
    'rotated-ink-variable',
    'ink, variable width, 60% opacity, on a rotated page',
    1,
    [72, 470],
    '#E53935',
    0.6,
    { ...TAPER, from: { x: 72, y: 450 }, to: { x: 312, y: 450 }, at: TAPER_AT },
  ),
];

export const ROWS: readonly MatrixRow[] = [
  {
    title: 'Highlight (Multiply blend, text stays readable, comment)',
    key: 'highlight',
    aspects: ['appearance', 'data'],
  },
  { title: 'Underline', key: 'underline', aspects: ['appearance', 'data'] },
  { title: 'Strikeout', key: 'strikeout', aspects: ['appearance', 'data'] },
  { title: 'Squiggly', key: 'squiggly', aspects: ['appearance', 'data'] },
  { title: 'Ink', key: 'ink', aspects: ['appearance', 'data'] },
  {
    title: 'Ink, Multiply (free highlighter): tint at full opacity, text under it stays readable',
    key: 'ink-multiply',
    aspects: ['appearance', 'data'],
  },
  {
    title: 'Square (50% opacity, interior colour, text under the fill visible)',
    key: 'square',
    aspects: ['appearance', 'data'],
  },
  { title: 'Circle', key: 'circle', aspects: ['appearance', 'data'] },
  { title: 'Line with open arrow', key: 'line', aspects: ['appearance', 'data'] },
  { title: 'Polygon (interior colour)', key: 'polygon', aspects: ['appearance', 'data'] },
  { title: 'Polyline', key: 'polyline', aspects: ['appearance', 'data'] },
  { title: 'Free text (14 pt, red)', key: 'free-text', aspects: ['appearance', 'data'] },
  { title: 'Note: icon renders', key: 'note', aspects: ['appearance', 'data'] },
  { title: 'Note: text available to the comment UI', key: 'note', aspects: ['contents'] },
  { title: 'Note: popup open by default (`/Open true`)', key: 'note', aspects: ['open'] },
  {
    title: 'Stamp, named (`Approved`, generated appearance)',
    key: 'stamp-named',
    aspects: ['appearance', 'data'],
  },
  { title: 'Stamp, image (PNG)', key: 'stamp-image', aspects: ['appearance', 'data'] },
  {
    title: `Link (URI ${LINK_URI}; its blue underline appearance only)`,
    key: 'link',
    aspects: ['appearance', 'data', 'uri'],
  },
  {
    title: 'Page 2 (`/Rotate 90`): highlight over its text line',
    key: 'rotated-highlight',
    aspects: ['appearance', 'data'],
  },
  {
    title: 'Page 2: note icon upright (NoRotate: not turned with the page), text in the comment UI',
    key: 'rotated-note',
    aspects: ['upright', 'data', 'contents'],
  },
  {
    title: 'Page 2: note icon hung from the /Rect upper-left corner (ISO 32000-2 §12.5.3)',
    key: 'rotated-note',
    aspects: ['appearance'],
  },
  {
    title: 'Page 2: square placed in display space',
    key: 'rotated-square',
    aspects: ['appearance', 'data'],
  },
  {
    title: 'Ink, variable width (appearance)',
    key: 'ink-variable',
    alsoKeys: ['rotated-ink-variable'],
    aspects: ['width'],
  },
  {
    title: 'Ink `/BS /W` equals the nominal width',
    key: 'ink-variable',
    alsoKeys: ['rotated-ink-variable'],
    aspects: ['nominal-width'],
  },
];

export function planEntry(key: string): PlanEntry {
  const entry = PLAN.find((e) => e.key === key);
  if (!entry) throw new Error(`No plan entry ${key}`);
  return entry;
}

/** Maps a user-space rect of an unrotated `size` page to display space (points, y down). */
export function userToDisplay(
  rect: Rect,
  rotation: number,
  size: { readonly width: number; readonly height: number } = PAGE_SIZE,
): Rect {
  const { width: w, height: h } = size;
  const x1 = rect.x;
  const y1 = rect.y;
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return { x: y1, y: x1, width: y2 - y1, height: x2 - x1 };
    case 180:
      return { x: w - x2, y: y1, width: x2 - x1, height: y2 - y1 };
    case 270:
      return { x: h - y2, y: w - x2, width: y2 - y1, height: x2 - x1 };
    default:
      return { x: x1, y: h - y2, width: x2 - x1, height: y2 - y1 };
  }
}

/** A user-space point to display space (points, y down). */
export function pointToDisplay(
  x: number,
  y: number,
  rotation: number,
  size: { readonly width: number; readonly height: number } = PAGE_SIZE,
): Point {
  const r = userToDisplay({ x, y, width: 0, height: 0 }, rotation, size);
  return { x: r.x, y: r.y };
}

/**
 * Where an appearance must be drawn in display space. NoRotate: the upright box of the
 * region's size whose upper-left corner is the display position of the region's
 * user-space upper-left corner (for /Rotate 90 that is the rotated footprint moved right by
 * one icon width).
 */
export function displayRegion(appearance: Appearance, rotation: number): Rect {
  const { region } = appearance;
  if (appearance.placement === 'rect') return userToDisplay(region, rotation);
  const corner = pointToDisplay(region.x, region.y + region.height, rotation);
  return { x: corner.x, y: corner.y, width: region.width, height: region.height };
}

/** Pages of the plan (for the generator and the checker). */
export function entriesOnPage(pageIndex: number): PlanEntry[] {
  return PLAN.filter((e) => e.annotation.pageIndex === pageIndex);
}
