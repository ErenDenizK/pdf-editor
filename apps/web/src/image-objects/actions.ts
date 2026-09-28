/**
 * Image edits as history entries (M4 §3): each is one `image.*` engine edit executed through
 * the edit runner (serialised with annotation and text edits and with export) and recorded
 * with its inverse: a transform's inverse moves the image back, a removal's or
 * replacement's says "replay required" (undo reopens the source and replays). The runner
 * then invalidates the page, which locates its images again.
 *
 * Replacement files: JPEG and PNG bytes go to PDFium as they are (a JPEG is embedded
 * unchanged); anything else the browser decodes (WebP) is decoded with `createImageBitmap`
 * and re-encoded as PNG, which keeps the recorded edit small (RGBA would be 4 bytes per
 * pixel in the workspace history). Extraction saves the original JPEG of a DCT image
 * without transparency, and a PNG of the decoded pixels otherwise.
 */
import type { EngineEdit, Rect } from '@pdf-editor/document-model';
import type { ImageReplacementJson, LocatedImage } from '@pdf-editor/engine';

import type { PageTarget } from '../annotations/annotation-store';
import { executeEdit, runAction } from '../annotations/edit-runner';
import { getEngineService } from '../engine/engine-service';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { deliverFile } from '../tools/deliver-file';
import { useImageStore } from './image-store';

export type ImageEditOutcome =
  | { readonly ok: true; readonly label: string }
  | { readonly ok: false; readonly message: string };

/** Runs one image edit as a history entry. Never rejects. */
async function commit(
  target: PageTarget,
  kind: 'image.transform' | 'image.remove' | 'image.replace',
  payload: unknown,
  label: string,
  expectBounds: Rect | null,
): Promise<ImageEditOutcome & { readonly reason?: string }> {
  const engine = await import('@pdf-editor/engine');
  const store = useImageStore.getState();
  const edit: EngineEdit = {
    id: globalThis.crypto.randomUUID(),
    source: target.source,
    pageIndex: target.pageIndex,
    kind,
    payload,
  };
  let failure: unknown;
  store.setBusy(true);
  store.setExpect(expectBounds ? { target, bounds: expectBounds } : null);
  let done: boolean | undefined;
  try {
    done = await runAction(async (ctx) => {
      try {
        const executed = await executeEdit(ctx, edit);
        return { edits: [executed.recorded], label, value: true };
      } catch (error) {
        // Nothing was committed (the editor verifies before it regenerates the page).
        failure = error;
        return undefined;
      }
    });
  } catch (error) {
    failure = error;
  } finally {
    useImageStore.getState().setBusy(false);
  }
  if (done) {
    announce(label);
    return { ok: true, label };
  }
  useImageStore.getState().setExpect(null);
  if (failure !== undefined) console.warn('Image edit failed', failure);
  const reason = engine.imageEditFailureReason(failure);
  const message =
    reason === 'stale-image' ? m.image_object_failed_stale() : m.image_object_failed();
  announce(message);
  return { ok: false, message, ...(reason === undefined ? {} : { reason }) };
}

/** Moves / resizes `image` so that its bounds fill `rect` (unrotated user space). */
export async function transformImage(
  target: PageTarget,
  image: LocatedImage,
  rect: Rect,
): Promise<ImageEditOutcome> {
  const engine = await import('@pdf-editor/engine');
  const resized =
    Math.abs(rect.width - image.bounds.width) > 0.01 ||
    Math.abs(rect.height - image.bounds.height) > 0.01;
  const label = resized ? m.image_object_resized() : m.image_object_moved();
  return commit(
    target,
    'image.transform',
    { image: engine.imageRefJson(image), rect },
    label,
    rect,
  );
}

export async function deleteImage(
  target: PageTarget,
  image: LocatedImage,
): Promise<ImageEditOutcome> {
  const engine = await import('@pdf-editor/engine');
  useImageStore.getState().select(null);
  return commit(
    target,
    'image.remove',
    { image: engine.imageRefJson(image) },
    m.image_object_removed(),
    null,
  );
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

/** Decodes any image the browser reads and encodes it as PNG. */
async function reencodePng(file: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('OffscreenCanvas 2D context is unavailable');
    context.drawImage(bitmap, 0, 0);
    const png = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/** The replacement to record for `file`: JPEG and PNG as they are, the rest as PNG. */
export async function replacementOfFile(file: Blob): Promise<ImageReplacementJson> {
  const engine = await import('@pdf-editor/engine');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (startsWith(bytes, JPEG_MAGIC)) return engine.imageReplacementJson({ jpeg: bytes });
  if (startsWith(bytes, PNG_MAGIC)) return engine.imageReplacementJson({ png: bytes });
  return engine.imageReplacementJson({ png: await reencodePng(file) });
}

/** Replaces `image`'s pixels with `file` (PNG, JPEG or WebP), keeping its place. */
export async function replaceImage(
  target: PageTarget,
  image: LocatedImage,
  file: File,
): Promise<ImageEditOutcome> {
  const engine = await import('@pdf-editor/engine');
  let replacement: ImageReplacementJson;
  try {
    replacement = await replacementOfFile(file);
  } catch (error) {
    console.warn('Could not read the replacement image', error);
    const message = m.image_object_read_failed({ name: file.name });
    announce(message);
    return { ok: false, message };
  }
  const run = (json: ImageReplacementJson) =>
    commit(
      target,
      'image.replace',
      { image: engine.imageRefJson(image), replacement: json },
      m.image_object_replaced(),
      image.bounds,
    );
  const first = await run(replacement);
  // A PNG PDFium's decoder refuses (16-bit, unusual chunks): through the browser's decoder.
  if (!first.ok && first.reason === 'invalid-replacement' && replacement.format === 'png') {
    try {
      return await run(engine.imageReplacementJson({ png: await reencodePng(file) }));
    } catch {
      return first;
    }
  }
  return first;
}

/** Encodes RGBA pixels as a PNG blob. */
async function pngOf(rgba: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('OffscreenCanvas 2D context is unavailable');
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** File name of an extracted image: "<document>-page-<n>-image.<ext>". */
export function extractName(documentTitle: string, position: number, extension: string): string {
  const base = documentTitle
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .trim();
  return `${base || 'document'}-page-${position}-image.${extension}`;
}

/** Saves the image's pixels: the original JPEG when it is one (and opaque), else a PNG. */
export async function extractImage(
  target: PageTarget,
  image: LocatedImage,
  documentTitle: string,
): Promise<boolean> {
  try {
    const editor = await getEngineService().imageEditor();
    const out = await editor.extractImage(image);
    const jpeg = out.original && !image.hasSMask ? out.original : undefined;
    const name = extractName(documentTitle, target.position, jpeg ? 'jpg' : 'png');
    const blob = jpeg
      ? new Blob([new Uint8Array(jpeg.bytes)], { type: jpeg.mime })
      : await pngOf(out.rgba, out.width, out.height);
    const outcome = await deliverFile(blob, name, blob.type);
    if (outcome !== 'cancelled') announce(m.image_object_extracted({ name }));
    return outcome !== 'cancelled';
  } catch (error) {
    console.warn('Extracting the image failed', error);
    announce(m.image_object_extract_failed());
    return false;
  }
}
