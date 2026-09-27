/**
 * Stitches rendered tiles into one page image and encodes it (worker side). Tiles arrive
 * as ImageBitmaps positioned on the displayed page; they are drawn onto an OffscreenCanvas
 * and encoded with `convertToBlob`. JPEG has no alpha, so it always gets a white
 * background; transparency is honoured for PNG and WebP.
 */
import { zipSync } from 'fflate';

import { fitsCanvas, RASTER_MIME, type RasterBackground, type RasterFormat } from './plan';

export interface RasterTile {
  readonly bitmap: ImageBitmap;
  readonly x: number;
  readonly y: number;
}

export interface RasterPageInput {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly RasterTile[];
  readonly format: RasterFormat;
  /** 1–100, JPEG and WebP only. */
  readonly quality: number;
  readonly background: RasterBackground;
}

export async function encodeRasterPage(input: RasterPageInput): Promise<Uint8Array> {
  const { width, height, format } = input;
  if (!fitsCanvas(width, height)) {
    for (const tile of input.tiles) tile.bitmap.close();
    throw new RangeError(`${width}×${height} px exceeds the browser's canvas limits`);
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D context');
  if (format === 'jpeg' || input.background === 'white') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  for (const tile of input.tiles) {
    context.drawImage(tile.bitmap, tile.x, tile.y);
    tile.bitmap.close();
  }
  const blob = await canvas.convertToBlob({
    type: RASTER_MIME[format],
    ...(format === 'png' ? {} : { quality: input.quality / 100 }),
  });
  if (blob.type !== RASTER_MIME[format]) {
    throw new Error(`This browser cannot encode ${RASTER_MIME[format]}`);
  }
  return new Uint8Array(await blob.arrayBuffer());
}

/** A ZIP of already-compressed images: stored, not deflated (saves time, not bytes). */
export function zipFiles(
  files: readonly { readonly name: string; readonly bytes: Uint8Array }[],
): Uint8Array {
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const file of files) entries[file.name] = [file.bytes, { level: 0 }];
  return zipSync(entries, { mtime: new Date('2000-01-01T00:00:00Z') });
}
