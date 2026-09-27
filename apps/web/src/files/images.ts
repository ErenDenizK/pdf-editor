/**
 * Images as pages (ROADMAP M1): PNG, JPEG and WebP files become image pages.
 *
 * - Decoding uses `createImageBitmap` for the pixel size (and to prove the file decodes).
 * - The assembler embeds PNG and JPEG only, so JPEG and PNG bytes pass through untouched
 *   and anything else (WebP) is re-encoded to PNG once, here, before it is stored.
 * - Page size: 1 image pixel = 1 point (72 dpi). "Fit to A4" caps the page width at A4
 *   width, aspect ratio kept; "Original size" keeps 72 dpi as is.
 */
import { DEFAULT_PAGE_SIZE, type Size } from '@pdf-editor/document-model';

import type { StoredBlob } from '../state/workspace-store';
import { isHiddenName, type NamedFile } from './file-filters';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const IMAGE_EXTENSION = /\.(png|jpe?g|webp)$/i;

/** Accept string for pickers and inputs. */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';

export function isImageFile(file: NamedFile): boolean {
  if (isHiddenName(file.name)) return false;
  if (IMAGE_TYPES.has(file.type.toLowerCase())) return true;
  return IMAGE_EXTENSION.test(file.name);
}

export type ImageSizing = 'fit-a4' | 'original';

/** A4 in points (the model's default page size). */
export const A4: Size = DEFAULT_PAGE_SIZE;

/** Page size in points for an image of `width` × `height` pixels. */
export function imagePageSize(width: number, height: number, sizing: ImageSizing): Size {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  if (sizing === 'original' || w <= A4.width) return { width: w, height: h };
  const scale = A4.width / w;
  return { width: A4.width, height: Math.max(1, Math.round(h * scale * 100) / 100) };
}

/** Whether an image at 72 dpi is larger than an A4 page in either direction. */
export function exceedsA4(width: number, height: number): boolean {
  return width > A4.width || height > A4.height;
}

/** Whether the size question is worth asking (several images, or one larger than A4). */
export function shouldAskImageSizing(images: readonly { width: number; height: number }[]) {
  return images.length > 1 || images.some((image) => exceedsA4(image.width, image.height));
}

/** Sniffs the container from the first bytes; the MIME type of a File can lie. */
export function sniffImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return undefined;
}

async function encodePng(bitmap: ImageBitmap): Promise<ArrayBuffer> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D context for image conversion');
    context.drawImage(bitmap, 0, 0);
    return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No 2D context for image conversion');
  context.drawImage(bitmap, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Image conversion failed');
  return blob.arrayBuffer();
}

/**
 * Decodes an image file into what the store keeps: PNG or JPEG bytes and the pixel size.
 * Rejects when the browser cannot decode the file.
 */
export async function decodeImageFile(file: File): Promise<StoredBlob> {
  const original = await file.arrayBuffer();
  const bitmap = await createImageBitmap(new Blob([original], { type: file.type }));
  try {
    const type = sniffImageType(new Uint8Array(original, 0, Math.min(16, original.byteLength)));
    const bytes = type === undefined ? await encodePng(bitmap) : original;
    return {
      bytes,
      type: type ?? 'image/png',
      width: bitmap.width,
      height: bitmap.height,
      name: file.name,
    };
  } finally {
    bitmap.close();
  }
}
