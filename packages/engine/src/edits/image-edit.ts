/**
 * The image-object engine edits (M4 §3).
 *
 * | kind              | payload                                               | inverse            |
 * | ----------------- | ----------------------------------------------------- | ------------------ |
 * | `image.transform` | `ImageTransformPayload`: the image + the new matrix   | the previous matrix|
 * |                   | (or a rect, resolved to a matrix when applied)        |                    |
 * | `image.remove`    | `ImageRemovePayload`: the image                       | replay required    |
 * | `image.replace`   | `ImageReplacePayload`: the image + the new pixels     | replay required    |
 * |                   | (JPEG or PNG bytes, or RGBA, as base64)               |                    |
 *
 * The image is recorded as its `ImageObjectRef` minus source and page (the edit's own):
 * object path, pixel size and bounds, which replay re-checks (`stale-image` when the page
 * differs). A transform is invertible: its inverse is a transform of the moved image back to
 * the previous page-space matrix. Removal and replacement are not (PDFium cannot restore
 * the old objects), so, as for text edits, their inverse is marked "replay required" and
 * undo reopens the source and replays the remaining edits.
 */
import type { EngineEdit, Rect } from '@pdf-editor/document-model';

import { imageEditError } from '../image-objects/errors';
import {
  type EngineCallOptions,
  EngineError,
  type ImageEditResult,
  type ImageObjectRef,
  type ImageReplacement,
  type PdfImageEditor,
  type TextMatrix,
} from '../types';

/** The image as recorded: `ImageObjectRef` minus source and page. */
export interface ImageRefJson {
  readonly objectPath: readonly number[];
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly bounds: Rect;
}

export interface ImageTransformPayload {
  readonly image: ImageRefJson;
  /** The new page-space matrix; once applied, always present. */
  readonly matrix?: TextMatrix;
  /** Or the rect the image's bounds must fill (resolved to `matrix` when applied). */
  readonly rect?: Rect;
}

export interface ImageRemovePayload {
  readonly image: ImageRefJson;
}

/** New pixels as JSON: encoded bytes, or RGBA with its size. */
export type ImageReplacementJson =
  | { readonly format: 'jpeg'; readonly base64: string }
  | { readonly format: 'png'; readonly base64: string }
  | {
      readonly format: 'rgba';
      readonly width: number;
      readonly height: number;
      readonly base64: string;
    };

export interface ImageReplacePayload {
  readonly image: ImageRefJson;
  readonly replacement: ImageReplacementJson;
}

/** Payload of the inverse of a removal or replacement. */
export interface ImageReplayPayload {
  readonly replayRequired: true;
  /** Id of the edit this undoes. */
  readonly of: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(kind: string, why: string): EngineError {
  return new EngineError('internal', `Invalid ${kind} payload: ${why}`);
}

function isRect(value: unknown): value is Rect {
  return (
    isObject(value) &&
    [value.x, value.y, value.width, value.height].every(
      (n) => typeof n === 'number' && Number.isFinite(n),
    )
  );
}

function isMatrix(value: unknown): value is TextMatrix {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function readImageRef(kind: string, value: unknown): ImageRefJson {
  if (!isObject(value)) throw invalid(kind, 'expected { image, … }');
  const { objectPath, pixelWidth, pixelHeight, bounds } = value;
  if (
    !Array.isArray(objectPath) ||
    objectPath.length === 0 ||
    !objectPath.every((n) => Number.isInteger(n) && (n as number) >= 0) ||
    !Number.isInteger(pixelWidth) ||
    !Number.isInteger(pixelHeight) ||
    !isRect(bounds)
  ) {
    throw invalid(kind, 'image needs objectPath, pixelWidth, pixelHeight and bounds');
  }
  return {
    objectPath: objectPath as number[],
    pixelWidth: pixelWidth as number,
    pixelHeight: pixelHeight as number,
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
  };
}

export function readImageTransformPayload(payload: unknown): ImageTransformPayload {
  if (!isObject(payload)) throw invalid('image.transform', 'expected an object');
  const image = readImageRef('image.transform', payload.image);
  const { matrix, rect } = payload;
  if (matrix !== undefined && !isMatrix(matrix)) throw invalid('image.transform', 'bad matrix');
  if (rect !== undefined && !isRect(rect)) throw invalid('image.transform', 'bad rect');
  if (matrix === undefined && rect === undefined) {
    throw invalid('image.transform', 'needs a matrix or a rect');
  }
  return {
    image,
    ...(matrix === undefined ? {} : { matrix: [...matrix] as unknown as TextMatrix }),
    ...(rect === undefined || matrix !== undefined ? {} : { rect }),
  };
}

export function readImageRemovePayload(payload: unknown): ImageRemovePayload {
  if (!isObject(payload)) throw invalid('image.remove', 'expected an object');
  return { image: readImageRef('image.remove', payload.image) };
}

export function readImageReplacePayload(payload: unknown): ImageReplacePayload {
  if (!isObject(payload) || !isObject(payload.replacement)) {
    throw invalid('image.replace', 'expected { image, replacement }');
  }
  const image = readImageRef('image.replace', payload.image);
  const r = payload.replacement;
  if (typeof r.base64 !== 'string') throw invalid('image.replace', 'replacement needs base64');
  if (r.format === 'jpeg') return { image, replacement: { format: 'jpeg', base64: r.base64 } };
  if (r.format === 'png') return { image, replacement: { format: 'png', base64: r.base64 } };
  if (r.format === 'rgba' && Number.isInteger(r.width) && Number.isInteger(r.height)) {
    return {
      image,
      replacement: {
        format: 'rgba',
        width: r.width as number,
        height: r.height as number,
        base64: r.base64,
      },
    };
  }
  throw invalid('image.replace', 'replacement format must be jpeg, png or rgba (with its size)');
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The recorded form of an image reference. */
export function imageRefJson(ref: ImageRefJson): ImageRefJson {
  return {
    objectPath: [...ref.objectPath],
    pixelWidth: ref.pixelWidth,
    pixelHeight: ref.pixelHeight,
    bounds: {
      x: ref.bounds.x,
      y: ref.bounds.y,
      width: ref.bounds.width,
      height: ref.bounds.height,
    },
  };
}

/** The replacement as JSON (bytes as base64). */
export function imageReplacementJson(replacement: ImageReplacement): ImageReplacementJson {
  if ('jpeg' in replacement) return { format: 'jpeg', base64: toBase64(replacement.jpeg) };
  if ('png' in replacement) return { format: 'png', base64: toBase64(replacement.png) };
  return {
    format: 'rgba',
    width: replacement.width,
    height: replacement.height,
    base64: toBase64(new Uint8Array(replacement.rgba)),
  };
}

export function imageReplacementOf(json: ImageReplacementJson): ImageReplacement {
  const bytes = fromBase64(json.base64);
  if (json.format === 'jpeg') return { jpeg: bytes };
  if (json.format === 'png') return { png: bytes };
  return { rgba: bytes, width: json.width, height: json.height };
}

function refOf(edit: EngineEdit, image: ImageRefJson): ImageObjectRef {
  return { ...image, source: edit.source, pageIndex: edit.pageIndex };
}

/** Whether `edit` is the inverse of an image removal or replacement (undo: reopen + replay). */
export function isImageReplayRequired(edit: EngineEdit): boolean {
  return (
    (edit.kind === 'image.remove' || edit.kind === 'image.replace') &&
    isObject(edit.payload) &&
    edit.payload.replayRequired === true
  );
}

type ImageEditTarget = Partial<
  Pick<PdfImageEditor, 'transformImage' | 'removeImage' | 'replaceImage'>
>;

function noEditor(): EngineError {
  return new EngineError('unsupported', 'This engine has no image editor');
}

export interface AppliedImageEdit {
  /** The payload to record (a transform's matrix resolved). */
  readonly payload: unknown;
  /** A transform's inverse payload; undefined for replay-required kinds. */
  readonly inversePayload?: ImageTransformPayload;
  readonly result: ImageEditResult;
}

/** Runs an `image.*` edit through `editor` (throws `replay-required` for such an inverse). */
export async function applyImageEdit(
  editor: ImageEditTarget,
  edit: EngineEdit,
  options: EngineCallOptions,
): Promise<AppliedImageEdit> {
  if (isImageReplayRequired(edit)) {
    throw imageEditError(
      'replay-required',
      `Edit ${edit.id} undoes an image ${edit.kind === 'image.remove' ? 'removal' : 'replacement'}: reopen the source and replay its remaining edits`,
    );
  }
  switch (edit.kind) {
    case 'image.transform': {
      if (!editor.transformImage) throw noEditor();
      const payload = readImageTransformPayload(edit.payload);
      const target = payload.matrix ? { matrix: payload.matrix } : { rect: payload.rect as Rect };
      const result = await editor.transformImage(refOf(edit, payload.image), target, options);
      const moved = result.image;
      if (!moved) throw imageEditError('verification-failed', 'The image was not located again');
      return {
        payload: { image: payload.image, matrix: [...moved.matrix] },
        inversePayload: {
          image: imageRefJson(moved),
          matrix: [...result.previousMatrix] as unknown as TextMatrix,
        },
        result,
      };
    }
    case 'image.remove': {
      if (!editor.removeImage) throw noEditor();
      const payload = readImageRemovePayload(edit.payload);
      const result = await editor.removeImage(refOf(edit, payload.image), options);
      return { payload, result };
    }
    case 'image.replace': {
      if (!editor.replaceImage) throw noEditor();
      const payload = readImageReplacePayload(edit.payload);
      const result = await editor.replaceImage(
        refOf(edit, payload.image),
        imageReplacementOf(payload.replacement),
        options,
      );
      return { payload, result };
    }
    default:
      throw new EngineError('internal', `Edit ${edit.id} is not an image edit (${edit.kind})`);
  }
}
