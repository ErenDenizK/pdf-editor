/**
 * Visual diff (spec §2.1 "Visual"): both pages rendered at the same DPI are laid into a common
 * top-left frame (the larger size on each axis; the uncovered part of the smaller page is a
 * neutral grey, so a size difference shows up as changed pixels), compared with pixelmatch
 * (threshold 0.1, anti-aliasing detection on), in horizontal strips so no task runs long.
 * Changed pixels are kept as a bit set (the heat map, 1 bit per pixel) and grouped on an 8 px
 * grid into rectangles, reported in both documents' user space.
 */
import pixelmatch from 'pixelmatch';
import type { Rect } from '@pdf-editor/document-model';

import {
  EngineError,
  type AnalysisRaster,
  type AnalysisRgba,
  type ComparePageGeometry,
} from '../types';
import { THUMB_SIZE } from './align';
import { pixelBoxToUser } from './geometry';
import type { Slicer } from './scheduler';

/** Pixels per strip (≈ 3–8 ms of pixelmatch work). */
const STRIP_PIXELS = 160_000;
/** Rows of context above and below a strip: pixelmatch's anti-aliasing test looks 2 px away. */
const STRIP_MARGIN = 3;
/** Grid cell for grouping changed pixels into regions. */
export const REGION_GRID = 8;
/** More regions than this on a page are merged on a coarser grid. */
const MAX_REGIONS = 64;
/** Frame fill where a page does not reach (opaque mid grey). */
const PAD = 0xff808080; // ABGR little-endian: r = g = b = 0x80, a = 0xff

/** Rows read back per slice when decoding a bitmap (≈ a quarter of a Letter page at 100 dpi). */
const DECODE_PIXELS = 250_000;

function context2d(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  if (!context) throw new EngineError('internal', 'No 2D context for the page render');
  return context;
}

function checkedRgba(raster: AnalysisRaster): AnalysisRgba {
  const rgba = raster as AnalysisRgba;
  if (rgba.data.length !== rgba.width * rgba.height * 4) {
    throw new EngineError('internal', `RGBA size mismatch (${rgba.width}×${rgba.height})`);
  }
  return rgba;
}

const isBitmap = (raster: AnalysisRaster): raster is ImageBitmap =>
  typeof ImageBitmap !== 'undefined' && raster instanceof ImageBitmap;

/** RGBA pixels of a raster; an `ImageBitmap` is drawn once and closed. */
export function rasterToRgba(raster: AnalysisRaster): AnalysisRgba {
  if (!isBitmap(raster)) return checkedRgba(raster);
  const { width, height } = raster;
  try {
    const context = context2d(width, height);
    context.drawImage(raster, 0, 0);
    return { width, height, data: context.getImageData(0, 0, width, height).data };
  } finally {
    raster.close();
  }
}

/**
 * `rasterToRgba` for page renders: the bitmap is read back in bands with a slice between
 * them, so a large page (or a busy machine) never makes one long task.
 */
export async function rasterToRgbaSliced(
  raster: AnalysisRaster,
  slicer: Slicer,
): Promise<AnalysisRgba> {
  if (!isBitmap(raster)) return checkedRgba(raster);
  const { width, height } = raster;
  let context: OffscreenCanvasRenderingContext2D;
  try {
    context = context2d(width, height);
    context.drawImage(raster, 0, 0);
  } finally {
    raster.close();
  }
  await slicer.tick('visual: draw');
  const data = new Uint8ClampedArray(width * height * 4);
  const band = Math.max(1, Math.floor(DECODE_PIXELS / Math.max(1, width)));
  for (let y = 0; y < height; y += band) {
    const rows = Math.min(band, height - y);
    data.set(context.getImageData(0, y, width, rows).data, y * width * 4);
    await slicer.tick('visual: decode');
  }
  return { width, height, data };
}

/** 32×32 greyscale thumbnail (box filter, Rec. 601 luma). */
export function thumbnailOf(image: AnalysisRgba): Uint8Array {
  const out = new Uint8Array(THUMB_SIZE * THUMB_SIZE);
  const { width, height, data } = image;
  if (width === 0 || height === 0) return out;
  for (let ty = 0; ty < THUMB_SIZE; ty++) {
    const y0 = Math.floor((ty * height) / THUMB_SIZE);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / THUMB_SIZE));
    for (let tx = 0; tx < THUMB_SIZE; tx++) {
      const x0 = Math.floor((tx * width) / THUMB_SIZE);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / THUMB_SIZE));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          const k = (y * width + x) * 4;
          sum += 0.299 * (data[k] ?? 0) + 0.587 * (data[k + 1] ?? 0) + 0.114 * (data[k + 2] ?? 0);
          count++;
        }
      }
      out[ty * THUMB_SIZE + tx] = count > 0 ? Math.round(sum / count) : 255;
    }
  }
  return out;
}

/** An image placed at the top-left of a `width` × `height` frame, padded with grey. */
function inFrame(image: AnalysisRgba, width: number, height: number): Uint8ClampedArray {
  if (image.width === width && image.height === height) return image.data;
  const out = new Uint8ClampedArray(width * height * 4);
  new Uint32Array(out.buffer).fill(PAD);
  const rowBytes = image.width * 4;
  for (let y = 0; y < image.height; y++) {
    out.set(image.data.subarray(y * rowBytes, (y + 1) * rowBytes), y * width * 4);
  }
  return out;
}

/** The changed pixels of a frame, 1 bit each (row-major). */
export interface ChangeMask {
  readonly width: number;
  readonly height: number;
  readonly bits: Uint8Array;
}

export interface PixelDiffCore {
  readonly width: number;
  readonly height: number;
  readonly changedPixels: number;
  readonly sizeMismatch: boolean;
  readonly mask: ChangeMask;
  /** Changed cells of the 8 px grid. */
  readonly cells: Uint8Array;
}

export async function diffRgba(
  a: AnalysisRgba,
  b: AnalysisRgba,
  threshold: number,
  slicer: Slicer,
): Promise<PixelDiffCore> {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const sizeMismatch = a.width !== b.width || a.height !== b.height;
  const imgA = inFrame(a, width, height);
  const imgB = inFrame(b, width, height);
  await slicer.tick('visual: frame');
  const bits = new Uint8Array(Math.ceil((width * height) / 8));
  const cols = Math.ceil(width / REGION_GRID);
  const cells = new Uint8Array(cols * Math.ceil(height / REGION_GRID));
  const rows = Math.max(16, Math.floor(STRIP_PIXELS / Math.max(1, width)));
  const out = new Uint8ClampedArray((rows + 2 * STRIP_MARGIN) * width * 4);
  const a32 = new Uint32Array(imgA.buffer, imgA.byteOffset, width * height);
  const b32 = new Uint32Array(imgB.buffer, imgB.byteOffset, width * height);
  let changed = 0;
  for (let y0 = 0; y0 < height; y0 += rows) {
    const y1 = Math.min(height, y0 + rows);
    // Skip identical strips without pixelmatch (the common case).
    let same = true;
    for (let i = y0 * width, end = y1 * width; i < end; i++) {
      if (a32[i] !== b32[i]) {
        same = false;
        break;
      }
    }
    if (!same) {
      const sy0 = Math.max(0, y0 - STRIP_MARGIN);
      const sy1 = Math.min(height, y1 + STRIP_MARGIN);
      const bytes = (sy1 - sy0) * width * 4;
      const strip = out.subarray(0, bytes);
      strip.fill(0);
      pixelmatch(
        imgA.subarray(sy0 * width * 4, sy1 * width * 4),
        imgB.subarray(sy0 * width * 4, sy1 * width * 4),
        strip,
        width,
        sy1 - sy0,
        { threshold, includeAA: false, diffMask: true, alpha: 0 },
      );
      for (let y = y0; y < y1; y++) {
        const rowStart = (y - sy0) * width * 4;
        const cellRow = Math.floor(y / REGION_GRID) * cols;
        for (let x = 0; x < width; x++) {
          if (strip[rowStart + x * 4 + 3] !== 255) continue;
          const i = y * width + x;
          bits[i >> 3] = (bits[i >> 3] ?? 0) | (1 << (i & 7));
          cells[cellRow + Math.floor(x / REGION_GRID)] = 1;
          changed++;
        }
      }
    }
    await slicer.tick('visual: pixelmatch');
  }
  return {
    width,
    height,
    changedPixels: changed,
    sizeMismatch,
    mask: { width, height, bits },
    cells,
  };
}

interface CellBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Connected groups of marked cells (8-neighbourhood, bridging gaps of `bridge` cells). */
function cellGroups(cells: Uint8Array, cols: number, rows: number, bridge: number): CellBox[] {
  const seen = new Uint8Array(cells.length);
  const boxes: CellBox[] = [];
  const stack: number[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    const box = { x0: cols, y0: rows, x1: -1, y1: -1 };
    while (stack.length > 0) {
      const k = stack.pop() as number;
      const cx = k % cols;
      const cy = (k - cx) / cols;
      box.x0 = Math.min(box.x0, cx);
      box.y0 = Math.min(box.y0, cy);
      box.x1 = Math.max(box.x1, cx);
      box.y1 = Math.max(box.y1, cy);
      for (let dy = -1 - bridge; dy <= 1 + bridge; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= rows) continue;
        for (let dx = -1 - bridge; dx <= 1 + bridge; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= cols) continue;
          const nk = ny * cols + nx;
          if (cells[nk] && !seen[nk]) {
            seen[nk] = 1;
            stack.push(nk);
          }
        }
      }
    }
    boxes.push(box);
  }
  return boxes;
}

/**
 * Pixel boxes of the changed areas: groups of changed grid cells (gaps of one cell bridged),
 * on a coarser grid while there are more than 64. Boxes are clipped to the frame.
 */
export function changeBoxes(
  core: PixelDiffCore,
): { x0: number; y0: number; x1: number; y1: number }[] {
  const cols = Math.ceil(core.width / REGION_GRID);
  const rows = Math.ceil(core.height / REGION_GRID);
  let bridge = 1;
  let groups = cellGroups(core.cells, cols, rows, bridge);
  while (groups.length > MAX_REGIONS && bridge < Math.max(cols, rows)) {
    bridge *= 2;
    groups = cellGroups(core.cells, cols, rows, bridge);
  }
  return groups
    .map((g) => ({
      x0: g.x0 * REGION_GRID,
      y0: g.y0 * REGION_GRID,
      x1: Math.min(core.width, (g.x1 + 1) * REGION_GRID),
      y1: Math.min(core.height, (g.y1 + 1) * REGION_GRID),
    }))
    .sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0);
}

/** Changed areas in a page's user space (clipped to the page; areas off the page dropped). */
export function boxesToUser(
  boxes: readonly { x0: number; y0: number; x1: number; y1: number }[],
  page: ComparePageGeometry,
  pageWidthPx: number,
  pageHeightPx: number,
): Rect[] {
  const out: Rect[] = [];
  for (const box of boxes) {
    const clipped = {
      x0: box.x0,
      y0: box.y0,
      x1: Math.min(box.x1, pageWidthPx),
      y1: Math.min(box.y1, pageHeightPx),
    };
    const rect = pixelBoxToUser(page, pageWidthPx, pageHeightPx, clipped);
    if (rect) out.push(rect);
  }
  return out;
}

/** The heat map: changed pixels opaque in `color`, the rest transparent. */
export function heatmapRgba(
  mask: ChangeMask,
  color: readonly [number, number, number] = [229, 72, 77],
): AnalysisRgba {
  const { width, height, bits } = mask;
  const data = new Uint8ClampedArray(width * height * 4);
  const px = new Uint32Array(data.buffer);
  const value = (0xff << 24) | (color[2] << 16) | (color[1] << 8) | color[0];
  for (let byte = 0; byte < bits.length; byte++) {
    const b = bits[byte] ?? 0;
    if (b === 0) continue;
    for (let bit = 0; bit < 8; bit++) {
      if (b & (1 << bit)) {
        const i = byte * 8 + bit;
        if (i < px.length) px[i] = value >>> 0;
      }
    }
  }
  return { width, height, data };
}
