/**
 * Image encoders for the image pass: JPEG through the browser's encoder
 * (`OffscreenCanvas.convertToBlob`, available in workers), and a lossless palette encoding
 * (8-bit /Indexed + Flate) for images with at most 256 colours, where JPEG would smear
 * sharp edges (charts, screenshots, line art).
 */
import { zlibSync } from 'fflate';

export interface ImageEncoder {
  jpeg(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    quality: number,
  ): Promise<Uint8Array>;
}

export const canvasEncoder: ImageEncoder = {
  async jpeg(data, width, height, quality) {
    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('OffscreenCanvas is not available for JPEG encoding');
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D context for JPEG encoding');
    context.putImageData(
      new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height),
      0,
      0,
    );
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
    return new Uint8Array(await blob.arrayBuffer());
  },
};

/**
 * The distinct RGB colours of an opaque RGBA image, or null when there are more than
 * `limit`. Stops at the first colour past the limit.
 */
export function palette(data: Uint8ClampedArray, limit = 256): number[] | null {
  const seen = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    const rgb =
      ((data[i] as number) << 16) | ((data[i + 1] as number) << 8) | (data[i + 2] as number);
    if (!seen.has(rgb)) {
      if (seen.size >= limit) return null;
      seen.set(rgb, seen.size);
    }
  }
  return [...seen.keys()];
}

export interface IndexedImage {
  /** Flate (zlib) compressed 8-bit indices. */
  readonly data: Uint8Array;
  /** Palette as RGB triplets. */
  readonly lookup: Uint8Array;
  readonly hival: number;
}

export function encodeIndexed(data: Uint8ClampedArray, colours: readonly number[]): IndexedImage {
  const index = new Map(colours.map((rgb, i) => [rgb, i]));
  const pixels = new Uint8Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const rgb =
      ((data[i] as number) << 16) | ((data[i + 1] as number) << 8) | (data[i + 2] as number);
    pixels[p] = index.get(rgb) ?? 0;
  }
  const lookup = new Uint8Array(colours.length * 3);
  colours.forEach((rgb, i) => {
    lookup[i * 3] = (rgb >> 16) & 0xff;
    lookup[i * 3 + 1] = (rgb >> 8) & 0xff;
    lookup[i * 3 + 2] = rgb & 0xff;
  });
  return { data: zlibSync(pixels, { level: 9 }), lookup, hival: colours.length - 1 };
}

/** Images with at most this many colours (or grey levels) are line art: lossless only. */
export const LINE_ART_COLOURS = 16;

/** Whether every pixel of an RGBA image is grey (R = G = B). */
export function isGray(data: Uint8ClampedArray): boolean {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) return false;
  }
  return true;
}

/** Distinct grey levels of a grey RGBA image, counting up to `limit + 1`. */
export function grayLevels(data: Uint8ClampedArray, limit: number): number {
  const seen = new Uint8Array(256);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i] as number;
    if (seen[v] === 0) {
      seen[v] = 1;
      if (++count > limit) return count;
    }
  }
  return count;
}

/** Flate (zlib) compressed 8-bit DeviceGray samples of a grey RGBA image. */
export function encodeGray(data: Uint8ClampedArray): Uint8Array {
  const samples = new Uint8Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) samples[p] = data[i] as number;
  return zlibSync(samples, { level: 9 });
}
