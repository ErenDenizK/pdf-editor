/**
 * Helpers for the image-object tests (browser mode): a hosted engine with an adapter and an
 * image editor on the calling thread, page renders, and synthetic PDFs built with pdf-lib
 * (images in forms, rotated pages, clipped images).
 */
import { degrees, PDFDocument, PDFName, type PDFRef } from '@cantoo/pdf-lib';
import type { Rect, SourceId } from '@pdf-editor/document-model';

import { sid, toBuffer, wasmUrl } from '../../test/helpers';
import { createHostedEngine, type HostedEngine } from '../pdfium/host';
import { PdfiumAdapter } from '../pdfium/pdfium-adapter';
import { createImageEditor, type HostedImageEditor } from './editor';

export interface ImageHarness {
  readonly host: HostedEngine;
  readonly adapter: PdfiumAdapter;
  readonly editor: HostedImageEditor;
  open(bytes: ArrayBuffer): Promise<SourceId>;
}

let counter = 0;

export async function createImageHarness(): Promise<ImageHarness> {
  const host = await createHostedEngine({ wasm: wasmUrl });
  const adapter = new PdfiumAdapter({ wasmUrl, engineFactory: () => host.engine });
  return {
    host,
    adapter,
    editor: createImageEditor(host),
    async open(bytes) {
      const id = sid(`img-${++counter}`);
      await adapter.open(id, bytes.slice(0));
      return id;
    },
  };
}

/** RGBA pixels of a page render (display orientation). */
export async function renderPage(
  h: ImageHarness,
  id: SourceId,
  pageIndex: number,
  scale = 1,
): Promise<ImageData> {
  const result = await h.adapter.renderPage(id, pageIndex, { scale });
  const canvas = new OffscreenCanvas(result.width, result.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.drawImage(result.bitmap, 0, 0);
  result.bitmap.close();
  return context.getImageData(0, 0, result.width, result.height);
}

/** A device-pixel box of a user-space rect on an unrotated page of height `pageHeight`. */
export function deviceBox(rect: Rect, pageHeight: number, scale = 1, pad = 2) {
  return {
    x0: Math.floor(rect.x * scale) - pad,
    y0: Math.floor((pageHeight - rect.y - rect.height) * scale) - pad,
    x1: Math.ceil((rect.x + rect.width) * scale) + pad,
    y1: Math.ceil((pageHeight - rect.y) * scale) + pad,
  };
}

type Box = ReturnType<typeof deviceBox>;

const inside = (x: number, y: number, box: Box) =>
  x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1;

/** Pixels that differ between two renders, outside every box and inside any. */
export function diffPixels(a: ImageData, b: ImageData, boxes: readonly Box[]) {
  let outside = 0;
  let insideCount = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const k = (y * a.width + x) * 4;
      const differs = [0, 1, 2].some(
        (c) => Math.abs((a.data[k + c] ?? 0) - (b.data[k + c] ?? 0)) > 8,
      );
      if (!differs) continue;
      if (boxes.some((box) => inside(x, y, box))) insideCount++;
      else outside++;
    }
  }
  return { outside, inside: insideCount };
}

/** Whether every pixel of `box` (shrunk by `inset`) is white. */
export function isWhite(image: ImageData, box: Box, inset = 4): boolean {
  for (let y = box.y0 + inset; y < box.y1 - inset; y++) {
    for (let x = box.x0 + inset; x < box.x1 - inset; x++) {
      const k = (y * image.width + x) * 4;
      if ([0, 1, 2].some((c) => (image.data[k + c] ?? 0) < 245)) return false;
    }
  }
  return true;
}

/** A PNG of `width × height` filled with `rgba` (via OffscreenCanvas). */
export async function solidPng(
  width: number,
  height: number,
  rgba: readonly [number, number, number, number],
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  const data = new ImageData(width, height);
  for (let i = 0; i < data.data.length; i += 4) data.data.set(rgba, i);
  context.putImageData(data, 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

/**
 * A 400 × 300 page with one image (`imageMatrix` as the `cm` before `Do`), optionally
 * drawn inside a Form XObject placed with `formMatrix`, optionally clipped to `clip`
 * (a user-space rect around the image, page level), optionally on a page with `/Rotate`.
 * A black text-like bar at the bottom left serves as "other content".
 */
export async function imagePdf(options: {
  readonly imageMatrix: readonly number[];
  readonly formMatrix?: readonly number[];
  /** Draw the form on a second page too (a shared form). */
  readonly formOnSecondPage?: boolean;
  readonly clip?: Rect;
  readonly rotate?: 0 | 90 | 180 | 270;
  readonly png?: Uint8Array;
}): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const image = await doc.embedPng(options.png ?? (await solidPng(8, 6, [200, 30, 30, 255])));
  const imageRef = image.ref;
  const place = `q ${options.imageMatrix.join(' ')} cm /Im1 Do Q`;
  const bar = 'q 0 0 0 rg 20 20 120 12 re f Q';
  const clip = options.clip
    ? `${options.clip.x} ${options.clip.y} ${options.clip.width} ${options.clip.height} re W n `
    : '';
  const pages = options.formOnSecondPage ? 2 : 1;
  let formRef: PDFRef | undefined;
  if (options.formMatrix) {
    formRef = ctx.register(
      ctx.stream(place, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [-1000, -1000, 1000, 1000],
        Resources: { XObject: { Im1: imageRef } },
      }),
    );
  }
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([400, 300]);
    const body = formRef
      ? `q ${clip}${(options.formMatrix ?? []).join(' ')} cm /Fm1 Do Q`
      : `q ${clip}${place} Q`;
    page.node.set(
      PDFName.of('Resources'),
      ctx.obj({ XObject: formRef ? { Fm1: formRef } : { Im1: imageRef } }),
    );
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(`${bar}\n${body}`)));
    if (options.rotate) page.setRotation(degrees(options.rotate));
  }
  return toBuffer(await doc.save());
}

type Bytes = ArrayBuffer | Uint8Array | Uint8ClampedArray;

export function sameBytes(a: Bytes, b: Bytes): boolean {
  const x = a instanceof ArrayBuffer ? new Uint8Array(a) : a;
  const y = b instanceof ArrayBuffer ? new Uint8Array(b) : b;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
