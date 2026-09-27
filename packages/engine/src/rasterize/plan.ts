/**
 * PDF → images planning (spec §6): pure functions shared by the dialog and the worker.
 * Pages are rendered in tiles no larger than the renderer's single-bitmap cap and stitched
 * into one canvas per page; a page larger than the browser's canvas limits is refused
 * with a clear message rather than silently scaled.
 */

export type RasterFormat = 'png' | 'jpeg' | 'webp';
export type RasterBackground = 'white' | 'transparent';

export const RASTER_DPI_PRESETS = [72, 150, 300, 600] as const;
export const MIN_RASTER_DPI = 18;
export const MAX_RASTER_DPI = 1200;
/** Largest tile rendered in one call (the engine service's MAX_BITMAP_PIXELS side). */
export const RASTER_TILE_PX = 4096;
/** Chromium's canvas limits: 32767 per side and 268 435 456 pixels in total. */
export const MAX_CANVAS_SIDE = 32_767;
export const MAX_CANVAS_PIXELS = 268_435_456;

export const RASTER_MIME: Readonly<Record<RasterFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export const RASTER_EXTENSION: Readonly<Record<RasterFormat, string>> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};

export interface RasterTileSpec {
  /** Position and size on the displayed page, in pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Output pixel size of a displayed page of `widthPt` × `heightPt` at `dpi`. */
export function rasterSize(
  widthPt: number,
  heightPt: number,
  dpi: number,
): { readonly width: number; readonly height: number } {
  const scale = dpi / 72;
  return {
    width: Math.max(1, Math.round(widthPt * scale)),
    height: Math.max(1, Math.round(heightPt * scale)),
  };
}

export function fitsCanvas(width: number, height: number): boolean {
  return (
    width <= MAX_CANVAS_SIDE && height <= MAX_CANVAS_SIDE && width * height <= MAX_CANVAS_PIXELS
  );
}

/** Tiles covering a width × height pixel page, row by row. */
export function rasterTiles(
  width: number,
  height: number,
  tile = RASTER_TILE_PX,
): RasterTileSpec[] {
  const tiles: RasterTileSpec[] = [];
  for (let y = 0; y < height; y += tile) {
    for (let x = 0; x < width; x += tile) {
      tiles.push({ x, y, width: Math.min(tile, width - x), height: Math.min(tile, height - y) });
    }
  }
  return tiles;
}

/**
 * Parses a page range like "1-3, 5, 8-" (1-based, inclusive; open ends allowed) into
 * sorted 0-based indices. Empty input means all pages. Returns null when invalid.
 */
export function parsePageRange(input: string, pageCount: number): number[] | null {
  const text = input.trim();
  if (text === '') return Array.from({ length: pageCount }, (_, i) => i);
  const pages = new Set<number>();
  for (const part of text.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    const match = /^(\d*)\s*(?:[-–]\s*(\d*))?$/.exec(token);
    if (!match) return null;
    const [, a, b] = match;
    const isRange = token.includes('-') || token.includes('–');
    const start = a === '' || a === undefined ? 1 : Number(a);
    const end = isRange ? (b === '' || b === undefined ? pageCount : Number(b)) : start;
    if (!isRange && (a === '' || a === undefined)) return null;
    if (start < 1 || end > pageCount || start > end) return null;
    for (let p = start; p <= end; p++) pages.add(p - 1);
  }
  return pages.size === 0 ? null : [...pages].sort((x, y) => x - y);
}

/** Characters not allowed in file names on common systems. */
const UNSAFE = /[\\/:*?"<>|\p{Cc}]+/gu;

/**
 * File name for one page from a template with `{title}`, `{page}` (1-based, zero-padded
 * to the width of the largest page number) and `{label}`.
 */
export function rasterFileName(
  template: string,
  values: {
    readonly title: string;
    readonly page: number;
    readonly pageCount: number;
    readonly label?: string;
  },
  format: RasterFormat,
): string {
  const width = String(values.pageCount).length;
  const base = (template.trim() === '' ? '{title}-{page}' : template)
    .replaceAll('{title}', values.title)
    .replaceAll('{page}', String(values.page).padStart(width, '0'))
    .replaceAll('{label}', values.label ?? String(values.page))
    .replace(UNSAFE, '_')
    .trim();
  return `${base === '' ? 'page' : base}.${RASTER_EXTENSION[format]}`;
}

/** Makes names unique by appending " (2)", " (3)", … before the extension. */
export function uniqueNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; used.has(candidate); n++) candidate = `${stem} (${n})${ext}`;
    used.add(candidate);
    return candidate;
  });
}
