/**
 * PDF → images, worker side. A page is drawn tile by tile into one OffscreenCanvas as the
 * tiles arrive (each ImageBitmap is closed at once, so at most one tile is alive) and
 * encoded with `convertToBlob`; encoded pages stream into a stored (uncompressed) ZIP
 * (fflate `Zip` + `ZipPassThrough`), so no page is held twice. JPEG has no alpha and
 * always gets a white background; transparency is honoured for PNG and WebP.
 */
import { Zip, ZipPassThrough } from 'fflate';

import { fitsCanvas, RASTER_MIME, type RasterBackground, type RasterFormat } from './plan';

export interface RasterTile {
  readonly bitmap: ImageBitmap;
  readonly x: number;
  readonly y: number;
}

export interface RasterPageSpec {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly format: RasterFormat;
  /** 1–100, JPEG and WebP only. */
  readonly quality: number;
  readonly background: RasterBackground;
}

export interface RasterPageInput extends RasterPageSpec {
  readonly tiles: readonly RasterTile[];
}

/** One page being assembled from tiles. */
export class RasterCanvas {
  private readonly canvas: OffscreenCanvas;
  private readonly context: OffscreenCanvasRenderingContext2D;

  constructor(readonly spec: RasterPageSpec) {
    const { width, height, format } = spec;
    if (!fitsCanvas(width, height)) {
      throw new RangeError(`${width}×${height} px exceeds the browser's canvas limits`);
    }
    this.canvas = new OffscreenCanvas(width, height);
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('No 2D context');
    this.context = context;
    if (format === 'jpeg' || spec.background === 'white') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }
  }

  /** Draws a tile and releases its bitmap. */
  draw(tile: RasterTile): void {
    try {
      this.context.drawImage(tile.bitmap, tile.x, tile.y);
    } finally {
      tile.bitmap.close();
    }
  }

  async encode(): Promise<Uint8Array> {
    const { format } = this.spec;
    const blob = await this.canvas.convertToBlob({
      type: RASTER_MIME[format],
      ...(format === 'png' ? {} : { quality: this.spec.quality / 100 }),
    });
    if (blob.type !== RASTER_MIME[format]) {
      throw new Error(`This browser cannot encode ${RASTER_MIME[format]}`);
    }
    // Free the backing store now rather than at garbage collection.
    this.canvas.width = 0;
    this.canvas.height = 0;
    return new Uint8Array(await blob.arrayBuffer());
  }
}

/** Convenience: a page from tiles already rendered. */
export async function encodeRasterPage(input: RasterPageInput): Promise<Uint8Array> {
  let canvas: RasterCanvas;
  try {
    canvas = new RasterCanvas(input);
  } catch (error) {
    for (const tile of input.tiles) tile.bitmap.close();
    throw error;
  }
  for (const tile of input.tiles) canvas.draw(tile);
  return canvas.encode();
}

const ZIP_MTIME = new Date('2000-01-01T00:00:00Z');

/**
 * The output of one raster job: a single file, or (from the second page on) a ZIP that
 * the pages stream into as they are encoded.
 */
export class RasterArchive {
  private first: { name: string; bytes: Uint8Array; type: string } | undefined;
  private zip: Zip | undefined;
  private readonly chunks: Uint8Array[] = [];
  private failure: Error | undefined;
  count = 0;

  add(name: string, bytes: Uint8Array, type: string): void {
    this.count += 1;
    if (this.count === 1) {
      this.first = { name, bytes, type };
      return;
    }
    if (!this.zip) {
      this.zip = new Zip((error, data) => {
        if (error) this.failure = error;
        else this.chunks.push(data);
      });
      const first = this.first;
      this.first = undefined;
      if (first) this.store(first.name, first.bytes);
    }
    this.store(name, bytes);
    if (this.failure) throw this.failure;
  }

  private store(name: string, bytes: Uint8Array): void {
    const entry = new ZipPassThrough(name);
    entry.mtime = ZIP_MTIME;
    this.zip?.add(entry);
    entry.push(bytes, true);
  }

  /** The finished file (a Blob, which the browser may keep on disk). */
  finish(zipName: string): { blob: Blob; name: string; type: string } {
    if (this.count === 0) throw new Error('No pages were rendered');
    if (this.first) {
      const { name, bytes, type } = this.first;
      return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type }), name, type };
    }
    this.zip?.end();
    if (this.failure) throw this.failure;
    const blob = new Blob(this.chunks as Uint8Array<ArrayBuffer>[], { type: 'application/zip' });
    this.chunks.length = 0;
    return { blob, name: zipName, type: 'application/zip' };
  }
}

/** A stored ZIP of two or more files (tests, small outputs). */
export async function zipFiles(
  files: readonly { readonly name: string; readonly bytes: Uint8Array }[],
): Promise<Uint8Array> {
  const archive = new RasterArchive();
  for (const file of files) archive.add(file.name, file.bytes, 'application/octet-stream');
  const { blob } = archive.finish('files.zip');
  return new Uint8Array(await blob.arrayBuffer());
}
