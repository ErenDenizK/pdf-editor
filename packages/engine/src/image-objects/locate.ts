/**
 * Image location: the image objects of a page (page level and inside Form XObjects up to
 * `MAX_FORM_DEPTH` levels, paths like text runs), with bounds in unrotated user space, and
 * `resolveImage`, which finds an image again from its `ImageObjectRef` and fails with
 * `stale-image` when the page no longer matches (the replay re-check).
 */
import type { SourceId } from '@pdf-editor/document-model';

import { PAGEOBJ_FORM } from '../text-edit/raw';
import {
  IMAGE_BOUNDS_TOLERANCE,
  type ImageObjectRef,
  type LocatedImage,
  type TextMatrix,
} from '../types';
import { imageEditError } from './errors';
import { effectiveDpi, imageBounds, multiplyMatrix, rectDistance } from './geometry';
import { PAGEOBJ_IMAGE, type RawImages } from './raw';

/** Deepest form nesting walked (page → form → form → form → image). */
export const MAX_FORM_DEPTH = 3;

/** An image object and where it sits: its path and the form objects around it. */
export interface ImagePlace {
  readonly obj: number;
  readonly path: readonly number[];
  /** Enclosing form objects, outermost first. */
  readonly forms: readonly number[];
}

/** Every image object of the page, in paint order. */
export function imageObjects(raw: RawImages, pagePtr: number): ImagePlace[] {
  const out: ImagePlace[] = [];
  const walk = (objects: readonly number[], path: number[], forms: number[]): void => {
    objects.forEach((obj, i) => {
      const type = raw.objectType(obj);
      if (type === PAGEOBJ_IMAGE) out.push({ obj, path: [...path, i], forms });
      else if (type === PAGEOBJ_FORM && forms.length < MAX_FORM_DEPTH) {
        walk(raw.formObjects(obj), [...path, i], [...forms, obj]);
      }
    });
  };
  walk(raw.pageObjects(pagePtr), [], []);
  return out;
}

/** The product of the enclosing forms' matrices (innermost first): form space → page. */
export function formsMatrix(raw: RawImages, place: Pick<ImagePlace, 'forms'>): TextMatrix {
  let m: TextMatrix = [1, 0, 0, 1, 0, 0];
  for (let k = place.forms.length - 1; k >= 0; k--) {
    m = multiplyMatrix(m, raw.matrix(place.forms[k] ?? 0));
  }
  return m;
}

/** The object's matrix in page space. */
export function pageMatrixOf(raw: RawImages, place: ImagePlace): TextMatrix {
  return multiplyMatrix(raw.matrix(place.obj), formsMatrix(raw, place));
}

/** The public view of one image object. */
export function locateOne(
  raw: RawImages,
  docPtr: number,
  pagePtr: number,
  source: SourceId,
  pageIndex: number,
  place: ImagePlace,
): LocatedImage {
  const matrix = pageMatrixOf(raw, place);
  const { width, height } = raw.pixelSize(place.obj);
  const meta = raw.metadata(place.obj, pagePtr);
  return {
    source,
    pageIndex,
    objectPath: place.path,
    pixelWidth: width,
    pixelHeight: height,
    bounds: imageBounds(matrix),
    matrix,
    filters: raw.filters(place.obj),
    hasSMask: raw.hasTransparency(docPtr, pagePtr, place.obj, width, height),
    inForm: place.forms.length > 0,
    bitsPerPixel: meta.bitsPerPixel,
    colorSpace: meta.colorSpace,
    dpi: effectiveDpi(matrix, width, height),
  };
}

/** Every image of the page. */
export function locatePageImages(
  raw: RawImages,
  docPtr: number,
  pagePtr: number,
  source: SourceId,
  pageIndex: number,
): LocatedImage[] {
  return imageObjects(raw, pagePtr).map((place) =>
    locateOne(raw, docPtr, pagePtr, source, pageIndex, place),
  );
}

/** The image object at `path` and its enclosing forms, or undefined. */
export function imageAt(
  raw: RawImages,
  pagePtr: number,
  path: readonly number[],
): ImagePlace | undefined {
  let objects = raw.pageObjects(pagePtr);
  const forms: number[] = [];
  for (const [depth, index] of path.entries()) {
    const obj = objects[index] ?? 0;
    if (!obj) return undefined;
    if (depth === path.length - 1) {
      return raw.objectType(obj) === PAGEOBJ_IMAGE ? { obj, path, forms } : undefined;
    }
    if (raw.objectType(obj) !== PAGEOBJ_FORM) return undefined;
    forms.push(obj);
    objects = raw.formObjects(obj);
  }
  return undefined;
}

function stale(ref: ImageObjectRef, found: string) {
  return imageEditError(
    'stale-image',
    `Page ${ref.pageIndex + 1} changed: expected a ${ref.pixelWidth}×${ref.pixelHeight} image at object ${ref.objectPath.join('/')}; found ${found}`,
  );
}

/** Finds the image `ref` names on the current page, or throws `stale-image`. */
export function resolveImage(raw: RawImages, pagePtr: number, ref: ImageObjectRef): ImagePlace {
  if (ref.objectPath.length === 0) throw stale(ref, 'an empty object path');
  const place = imageAt(raw, pagePtr, ref.objectPath);
  if (!place) throw stale(ref, 'no image object there');
  const { width, height } = raw.pixelSize(place.obj);
  if (width !== ref.pixelWidth || height !== ref.pixelHeight) {
    throw stale(ref, `a ${width}×${height} image`);
  }
  const bounds = imageBounds(pageMatrixOf(raw, place));
  const drift = rectDistance(bounds, ref.bounds);
  if (!(drift <= IMAGE_BOUNDS_TOLERANCE)) {
    throw stale(ref, `bounds off by ${drift.toFixed(3)} pt`);
  }
  return place;
}
