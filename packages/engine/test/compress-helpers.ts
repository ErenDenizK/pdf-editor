/** Helpers for the compression tests: a photo-like Flate RGB fixture and PSNR. */
import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  PDFName,
  popGraphicsState,
  pushGraphicsState,
} from '@cantoo/pdf-lib';

import type { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import type { SourceId } from '@pdf-editor/document-model';
import { toBuffer } from './helpers';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Photo-like RGB pixels: smooth gradients, soft blobs and a little sensor noise. */
export function photoPixels(width: number, height: number, seed = 7): Uint8Array {
  const random = rng(seed);
  const blobs = Array.from({ length: 12 }, () => ({
    x: random() * width,
    y: random() * height,
    r: (0.1 + random() * 0.3) * width,
    c: [random() * 255, random() * 255, random() * 255],
  }));
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = (x / width) * 120 + 60;
      let g = (y / height) * 120 + 60;
      let b = 140;
      for (const blob of blobs) {
        const d = Math.hypot(x - blob.x, y - blob.y) / blob.r;
        const w = Math.exp(-d * d);
        r = r * (1 - w) + (blob.c[0] as number) * w;
        g = g * (1 - w) + (blob.c[1] as number) * w;
        b = b * (1 - w) + (blob.c[2] as number) * w;
      }
      const n = (random() - 0.5) * 12;
      const o = (y * width + x) * 3;
      out[o] = Math.max(0, Math.min(255, r + n));
      out[o + 1] = Math.max(0, Math.min(255, g + n));
      out[o + 2] = Math.max(0, Math.min(255, b + n));
    }
  }
  return out;
}

/** Photo-like 8-bit grey samples (a greyscale scan). */
export function grayPixels(width: number, height: number): Uint8Array {
  const rgb = photoPixels(width, height);
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(((rgb[i * 3] ?? 0) + (rgb[i * 3 + 1] ?? 0) + (rgb[i * 3 + 2] ?? 0)) / 3);
  }
  return gray;
}

/**
 * A Letter page with one Flate DeviceGray image of `width` × `height` pixels placed
 * `inches` wide: a greyscale scan.
 */
export async function flateGrayPdf(
  width: number,
  height: number,
  inches: number,
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ref = doc.context.register(
    doc.context.flateStream(grayPixels(width, height), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: width,
      Height: height,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
    }),
  );
  const page = doc.addPage([612, 792]);
  page.node.setXObject(PDFName.of('Scan'), ref);
  const w = inches * 72;
  const h = (w * height) / width;
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(w, 0, 0, h, 36, 36),
    drawObject('Scan'),
    popGraphicsState(),
  );
  return toBuffer(await doc.save());
}

/**
 * A Letter page with one Flate-compressed DeviceRGB image of `width` × `height` pixels
 * placed `inches` wide (so its DPI is width / inches).
 */
export async function flateRgbPdf(
  width: number,
  height: number,
  inches: number,
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const stream = doc.context.flateStream(photoPixels(width, height), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: width,
    Height: height,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
  });
  const ref = doc.context.register(stream);
  const page = doc.addPage([612, 792]);
  page.node.setXObject(PDFName.of('Photo'), ref);
  const w = inches * 72;
  const h = (w * height) / width;
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(w, 0, 0, h, 36, 792 - 36 - h),
    drawObject('Photo'),
    popGraphicsState(),
  );
  return toBuffer(await doc.save());
}

let renderCounter = 0;

/** Renders page `index` of `bytes` to RGBA through the adapter. */
export async function renderRgba(
  adapter: PdfiumAdapter,
  bytes: ArrayBuffer,
  index: number,
  scale: number,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const id = `render-${++renderCounter}` as SourceId;
  await adapter.open(id, bytes.slice(0));
  try {
    const { bitmap, width, height } = await adapter.renderPage(id, index, { scale });
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return { data: context.getImageData(0, 0, width, height).data, width, height };
  } finally {
    await adapter.close(id);
  }
}

/** Peak signal-to-noise ratio over RGB, in dB (Infinity for identical images). */
export function psnr(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  if (a.length !== b.length) throw new Error(`size mismatch ${a.length} vs ${b.length}`);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = (a[i + c] as number) - (b[i + c] as number);
      sum += d * d;
      count++;
    }
  }
  const mse = sum / count;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}
