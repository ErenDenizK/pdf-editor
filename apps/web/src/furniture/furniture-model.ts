/**
 * Page furniture (document-tools spec §2) as the dialogs see it: settings ↔ overlays, the
 * presets, and the workspace operations that apply or remove one kind of furniture as a
 * single history entry. Pure: no React, no stores.
 *
 * Every piece of furniture is a declarative overlay on every page of the document, tagged
 * with an `OverlayRole` so the dialogs can find it again, replace it and remove it. Page
 * ranges, numbering and mirroring are overlay fields interpreted by the shared layout
 * (`@pdf-editor/engine/overlay-geometry`), so the preview and the export agree.
 */
import {
  type Anchor,
  type BatesConfig,
  type BlobId,
  type DocumentId,
  getDocument,
  type OverlayLayer,
  type OverlayOp,
  type OverlayPageRange,
  type OverlayRole,
  type RgbColor,
  setDocumentBates,
  type TextOverlay,
  updateDocumentOverlays,
  type VirtualDocument,
  type Workspace,
} from '@pdf-editor/document-model';

export type FurnitureKind = 'page-numbers' | 'header-footer' | 'bates' | 'watermark';

export const FURNITURE_ROLES: Readonly<Record<FurnitureKind, readonly OverlayRole[]>> = {
  'page-numbers': ['page-number'],
  'header-footer': ['header', 'footer'],
  bates: ['bates'],
  watermark: ['watermark'],
};

export function kindOfRole(role: OverlayRole): FurnitureKind {
  switch (role) {
    case 'page-number':
      return 'page-numbers';
    case 'header':
    case 'footer':
      return 'header-footer';
    case 'bates':
      return 'bates';
    case 'watermark':
      return 'watermark';
  }
}

// ---------------------------------------------------------------------------
// Shared settings
// ---------------------------------------------------------------------------

export const FONT_FAMILIES = ['Inter', 'JetBrains Mono', 'Noto Serif'] as const;
export type FurnitureFamily = (typeof FONT_FAMILIES)[number];

export interface TextStyle {
  readonly family: FurnitureFamily;
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  /** #rrggbb */
  readonly color: string;
  /** 0…1 */
  readonly opacity: number;
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  family: 'Inter',
  size: 10,
  bold: false,
  italic: false,
  color: '#000000',
  opacity: 1,
};

export type RangeMode = 'all' | 'skip-first' | 'odd' | 'even' | 'custom';

export interface RangeChoice {
  readonly mode: RangeMode;
  /** 1-based, inclusive; used by 'custom'. */
  readonly from: number;
  readonly to: number;
}

export const ALL_PAGES: RangeChoice = { mode: 'all', from: 1, to: 1 };

export function rangeToModel(choice: RangeChoice): OverlayPageRange | undefined {
  switch (choice.mode) {
    case 'all':
      return undefined;
    case 'skip-first':
      return { from: 2 };
    case 'odd':
      return { parity: 'odd' };
    case 'even':
      return { parity: 'even' };
    case 'custom': {
      const from = Math.max(1, Math.floor(choice.from));
      const to = Math.max(from, Math.floor(choice.to));
      return { from, to };
    }
  }
}

export function rangeFromModel(
  range: OverlayPageRange | undefined,
  pageCount: number,
): RangeChoice {
  const fallback = { from: 1, to: Math.max(1, pageCount) };
  if (range === undefined) return { mode: 'all', ...fallback };
  if (range.parity !== undefined && range.from === undefined && range.to === undefined) {
    return { mode: range.parity, ...fallback };
  }
  if (range.from === 2 && range.to === undefined && range.parity === undefined) {
    return { mode: 'skip-first', ...fallback };
  }
  return { mode: 'custom', from: range.from ?? 1, to: range.to ?? fallback.to };
}

/** First 1-based page position a range draws on (for the default start number). */
export function firstPosition(choice: RangeChoice): number {
  switch (choice.mode) {
    case 'skip-first':
    case 'even':
      return 2;
    case 'custom':
      return Math.max(1, Math.floor(choice.from));
    default:
      return 1;
  }
}

export function hexToRgb(hex: string): RgbColor {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const value = match ? Number.parseInt(match[1] as string, 16) : 0;
  return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 };
}

export function rgbToHex(color: RgbColor): string {
  const scale = Math.max(color.r, color.g, color.b) > 1 ? 1 : 255;
  const part = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v * scale)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

function fontOf(style: TextStyle): TextOverlay['font'] {
  return {
    family: style.family,
    size: style.size,
    ...(style.bold ? { weight: 700 as const } : {}),
    ...(style.italic ? { italic: true } : {}),
  };
}

function styleOf(overlay: TextOverlay): TextStyle {
  const family = FONT_FAMILIES.find((f) => f.toLowerCase() === overlay.font.family.toLowerCase());
  return {
    family: family ?? 'Inter',
    size: overlay.font.size,
    bold: overlay.font.weight === 700,
    italic: overlay.font.italic === true,
    color: rgbToHex(overlay.color),
    opacity: overlay.opacity,
  };
}

/** Display-space offset that puts content `marginX`/`marginY` points inside the edges. */
export function offsetFor(
  anchor: Anchor,
  marginX: number,
  marginY: number,
): { readonly x: number; readonly y: number } {
  const [vertical, horizontal] = anchor === 'center' ? ['middle', 'center'] : anchor.split('-');
  const x = horizontal === 'left' ? marginX : horizontal === 'right' ? -marginX : 0;
  const y = vertical === 'bottom' ? marginY : vertical === 'top' ? -marginY : 0;
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
}

export function marginsOf(offset: { readonly x: number; readonly y: number }): {
  readonly marginX: number;
  readonly marginY: number;
} {
  return { marginX: Math.abs(offset.x), marginY: Math.abs(offset.y) };
}

// ---------------------------------------------------------------------------
// Page numbers
// ---------------------------------------------------------------------------

export type PageNumberPreset = 'plain' | 'page-of' | 'slash' | 'dashes' | 'custom';

/**
 * Preset templates. "Page {page} of {pages}" is worded in the UI language (the caller
 * passes the translated words), the others are language neutral.
 */
export function presetTemplate(
  preset: Exclude<PageNumberPreset, 'custom'>,
  pageOf = 'Page {page} of {pages}',
): string {
  switch (preset) {
    case 'plain':
      return '{page}';
    case 'page-of':
      return pageOf;
    case 'slash':
      return '{page} / {pages}';
    case 'dashes':
      return '- {page} -';
  }
}

export function presetOf(template: string, pageOf: string): PageNumberPreset {
  const presets = ['plain', 'page-of', 'slash', 'dashes'] as const;
  return presets.find((p) => presetTemplate(p, pageOf) === template) ?? 'custom';
}

export interface PageNumberSettings {
  readonly template: string;
  readonly anchor: Anchor;
  readonly marginX: number;
  readonly marginY: number;
  readonly style: TextStyle;
  readonly startNumber: number;
  readonly range: RangeChoice;
  readonly mirror: boolean;
}

export function defaultPageNumbers(pageCount: number): PageNumberSettings {
  return {
    template: '{page}',
    anchor: 'bottom-center',
    marginX: 36,
    marginY: 28,
    style: DEFAULT_TEXT_STYLE,
    startNumber: 1,
    range: { ...ALL_PAGES, to: Math.max(1, pageCount) },
    mirror: false,
  };
}

export function pageNumberOverlay(settings: PageNumberSettings): TextOverlay {
  const pages = rangeToModel(settings.range);
  return {
    kind: 'text',
    layer: 'over',
    template: settings.template,
    anchor: settings.anchor,
    offset: offsetFor(settings.anchor, settings.marginX, settings.marginY),
    font: fontOf(settings.style),
    color: hexToRgb(settings.style.color),
    opacity: settings.style.opacity,
    startNumber: Math.floor(settings.startNumber),
    ...(pages ? { pages } : {}),
    ...(settings.mirror ? { mirror: true } : {}),
    role: 'page-number',
  };
}

export function readPageNumbers(overlay: TextOverlay, pageCount: number): PageNumberSettings {
  const range = rangeFromModel(overlay.pages, pageCount);
  return {
    template: overlay.template,
    anchor: overlay.anchor,
    ...marginsOf(overlay.offset),
    style: styleOf(overlay),
    startNumber: overlay.startNumber ?? firstPosition(range),
    range,
    mirror: overlay.mirror === true,
  };
}

// ---------------------------------------------------------------------------
// Header / footer
// ---------------------------------------------------------------------------

export const SLOTS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const satisfies readonly Anchor[];
export type Slot = (typeof SLOTS)[number];

export interface HeaderFooterSettings {
  readonly slots: Readonly<Record<Slot, string>>;
  readonly marginX: number;
  readonly marginY: number;
  readonly style: TextStyle;
  readonly range: RangeChoice;
  readonly mirror: boolean;
}

export function defaultHeaderFooter(pageCount: number): HeaderFooterSettings {
  return {
    slots: {
      'top-left': '{title}',
      'top-center': '',
      'top-right': '{date}',
      'bottom-left': '',
      'bottom-center': '',
      'bottom-right': '{page} / {pages}',
    },
    marginX: 36,
    marginY: 28,
    style: { ...DEFAULT_TEXT_STYLE, size: 9, color: '#404040' },
    range: { ...ALL_PAGES, to: Math.max(1, pageCount) },
    mirror: false,
  };
}

export function headerFooterOverlays(settings: HeaderFooterSettings): TextOverlay[] {
  const pages = rangeToModel(settings.range);
  return SLOTS.filter((slot) => settings.slots[slot].trim() !== '').map((slot) => ({
    kind: 'text',
    layer: 'over',
    template: settings.slots[slot],
    anchor: slot,
    offset: offsetFor(slot, settings.marginX, settings.marginY),
    font: fontOf(settings.style),
    color: hexToRgb(settings.style.color),
    opacity: settings.style.opacity,
    ...(pages ? { pages } : {}),
    ...(settings.mirror ? { mirror: true } : {}),
    role: slot.startsWith('top') ? 'header' : 'footer',
  }));
}

export function readHeaderFooter(
  overlays: readonly TextOverlay[],
  pageCount: number,
): HeaderFooterSettings {
  const base = defaultHeaderFooter(pageCount);
  const first = overlays[0];
  if (!first) return base;
  const slots = Object.fromEntries(SLOTS.map((slot) => [slot, ''])) as Record<Slot, string>;
  for (const overlay of overlays) {
    if ((SLOTS as readonly string[]).includes(overlay.anchor)) {
      slots[overlay.anchor as Slot] = overlay.template;
    }
  }
  return {
    slots,
    ...marginsOf(first.offset),
    style: styleOf(first),
    range: rangeFromModel(first.pages, pageCount),
    mirror: first.mirror === true,
  };
}

// ---------------------------------------------------------------------------
// Bates
// ---------------------------------------------------------------------------

export interface BatesSettings {
  readonly prefix: string;
  readonly width: number;
  readonly start: number;
  readonly suffix: string;
  readonly anchor: Anchor;
  readonly marginX: number;
  readonly marginY: number;
  readonly style: TextStyle;
}

export function defaultBates(): BatesSettings {
  return {
    prefix: '',
    width: 6,
    start: 1,
    suffix: '',
    anchor: 'bottom-right',
    marginX: 36,
    marginY: 28,
    style: { ...DEFAULT_TEXT_STYLE, family: 'JetBrains Mono', size: 9 },
  };
}

export function batesOverlay(settings: BatesSettings): TextOverlay {
  return {
    kind: 'text',
    layer: 'over',
    template: '{bates}',
    anchor: settings.anchor,
    offset: offsetFor(settings.anchor, settings.marginX, settings.marginY),
    font: fontOf(settings.style),
    color: hexToRgb(settings.style.color),
    opacity: settings.style.opacity,
    role: 'bates',
  };
}

export function readBates(
  overlay: TextOverlay | undefined,
  config: BatesConfig | undefined,
): BatesSettings {
  const base = defaultBates();
  return {
    ...base,
    ...(config
      ? { prefix: config.prefix, width: config.width, start: config.start, suffix: config.suffix }
      : {}),
    ...(overlay
      ? { anchor: overlay.anchor, ...marginsOf(overlay.offset), style: styleOf(overlay) }
      : {}),
  };
}

export interface BatesRunEntry {
  readonly documentId: DocumentId;
  readonly config: BatesConfig;
  /** First and last numbers of this document. */
  readonly first: number;
  readonly last: number;
}

/**
 * One continuous counter across `documents` (in the given order, i.e. tab order): each
 * document starts where the previous one ended. Empty documents take no numbers.
 */
export function planBatesRun(
  documents: readonly Pick<VirtualDocument, 'id' | 'pages'>[],
  settings: Pick<BatesSettings, 'prefix' | 'width' | 'start' | 'suffix'>,
): BatesRunEntry[] {
  let next = Math.max(0, Math.floor(settings.start));
  const width = Math.min(12, Math.max(1, Math.floor(settings.width)));
  return documents.map((doc) => {
    const first = next;
    next += doc.pages.length;
    return {
      documentId: doc.id,
      config: { prefix: settings.prefix, width, start: first, suffix: settings.suffix },
      first,
      last: next - 1,
    };
  });
}

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

export interface WatermarkSettings {
  readonly mode: 'text' | 'image';
  readonly text: string;
  readonly style: TextStyle;
  readonly blob?: BlobId;
  /** Image scale (1 = 1 pt per pixel, i.e. 72 dpi). */
  readonly scale: number;
  /** Counter-clockwise degrees, −90…90. */
  readonly rotate: number;
  readonly tile: boolean;
  readonly gapX: number;
  readonly gapY: number;
  readonly layer: OverlayLayer;
  readonly range: RangeChoice;
}

export function defaultWatermark(pageCount: number): WatermarkSettings {
  return {
    mode: 'text',
    text: 'DRAFT',
    style: { ...DEFAULT_TEXT_STYLE, size: 72, bold: true, color: '#c0392b', opacity: 0.2 },
    scale: 1,
    rotate: 45,
    tile: false,
    gapX: 72,
    gapY: 144,
    layer: 'over',
    range: { ...ALL_PAGES, to: Math.max(1, pageCount) },
  };
}

export function clampRotation(value: number): number {
  return Math.max(-90, Math.min(90, Math.round(value)));
}

export function watermarkOverlay(settings: WatermarkSettings): OverlayOp | undefined {
  const pages = rangeToModel(settings.range);
  const common = {
    layer: settings.layer,
    anchor: 'center' as const,
    offset: { x: 0, y: 0 },
    opacity: settings.style.opacity,
    rotate: clampRotation(settings.rotate),
    ...(settings.tile
      ? { tile: { gapX: Math.max(0, settings.gapX), gapY: Math.max(0, settings.gapY) } }
      : {}),
    ...(pages ? { pages } : {}),
    role: 'watermark' as const,
  };
  if (settings.mode === 'image') {
    if (settings.blob === undefined) return undefined;
    return { kind: 'image', ...common, blob: settings.blob, scale: Math.max(0.01, settings.scale) };
  }
  if (settings.text.trim() === '') return undefined;
  return {
    kind: 'text',
    ...common,
    template: settings.text,
    font: fontOf(settings.style),
    color: hexToRgb(settings.style.color),
  };
}

export function readWatermark(overlay: OverlayOp, pageCount: number): WatermarkSettings {
  const base = defaultWatermark(pageCount);
  const common = {
    rotate: overlay.rotate ?? 0,
    tile: overlay.tile !== undefined,
    gapX: overlay.tile?.gapX ?? base.gapX,
    gapY: overlay.tile?.gapY ?? base.gapY,
    layer: overlay.layer,
    range: rangeFromModel(overlay.pages, pageCount),
  };
  if (overlay.kind === 'image') {
    return {
      ...base,
      ...common,
      mode: 'image',
      blob: overlay.blob,
      scale: overlay.scale,
      style: { ...base.style, opacity: overlay.opacity },
    };
  }
  return { ...base, ...common, mode: 'text', text: overlay.template, style: styleOf(overlay) };
}

// ---------------------------------------------------------------------------
// Workspace operations
// ---------------------------------------------------------------------------

/** Overlays of one kind on a document (from the first page that carries any). */
export function furnitureOf(doc: VirtualDocument, kind: FurnitureKind): OverlayOp[] {
  const roles = FURNITURE_ROLES[kind];
  for (const page of doc.pages) {
    const found = page.overlays.filter((o) => o.role !== undefined && roles.includes(o.role));
    if (found.length > 0) return found;
  }
  return [];
}

export function hasFurniture(doc: VirtualDocument, kind: FurnitureKind): boolean {
  return furnitureOf(doc, kind).length > 0;
}

/** The page overlays with one kind of furniture replaced by `overlays`. */
export function replaceFurniture(
  current: readonly OverlayOp[],
  kind: FurnitureKind,
  overlays: readonly OverlayOp[],
): readonly OverlayOp[] {
  const roles = FURNITURE_ROLES[kind];
  const kept = current.filter((o) => o.role === undefined || !roles.includes(o.role));
  if (kept.length === current.length && overlays.length === 0) return current;
  // Watermarks go first so that, within a layer, other furniture draws on top of them.
  return kind === 'watermark' ? [...overlays, ...kept] : [...kept, ...overlays];
}

/** Puts `overlays` of one kind on every page of a document, replacing that kind. */
export function applyFurniture(
  ws: Workspace,
  documentId: DocumentId,
  kind: FurnitureKind,
  overlays: readonly OverlayOp[],
): Workspace {
  return updateDocumentOverlays(ws, documentId, (current) =>
    replaceFurniture(current, kind, overlays),
  );
}

/** Removes one kind of furniture (and, for Bates, the document's numbering). */
export function removeFurniture(
  ws: Workspace,
  documentId: DocumentId,
  kind: FurnitureKind,
): Workspace {
  let next = applyFurniture(ws, documentId, kind, []);
  if (kind === 'bates') next = setDocumentBates(next, documentId, undefined);
  return next;
}

/** Applies a Bates run: the overlay on every page and each document's numbering. */
export function applyBatesRun(
  ws: Workspace,
  run: readonly BatesRunEntry[],
  overlay: TextOverlay,
): Workspace {
  let next = ws;
  for (const entry of run) {
    if (getDocument(next, entry.documentId).pages.length === 0) continue;
    next = applyFurniture(next, entry.documentId, 'bates', [overlay]);
    next = setDocumentBates(next, entry.documentId, entry.config);
  }
  return next;
}
