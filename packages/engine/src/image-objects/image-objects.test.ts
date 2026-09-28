/**
 * `PdfImageEditor` on the hosted engine (M4 §3): locate, extract, move / resize, remove and
 * replace, on images.pdf, redact-images.pdf and synthetic PDFs (images in Form XObjects,
 * rotated pages, clipped images), with render diffs as the independent check.
 */
import { PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import type { EngineEdit, SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import imagesUrl from '../../../../test/fixtures/images.pdf?url';
import redactImagesUrl from '../../../../test/fixtures/redact-images.pdf?url';
import { applyEngineEditWithResult, replayEngineEdits } from '../edits/apply';
import { imageRefJson, isImageReplayRequired } from '../edits/image-edit';
import { isReplayRequired } from '../edits/text-edit';
import { wasmUrl } from '../../test/helpers';
import { fixture, rejection } from '../text-edit/test-helpers';
import { createPdfiumProxy } from '../worker/pdfium-proxy';
import type { LocatedImage } from '../types';
import { imageEditFailureReason } from './errors';
import { finalizeContentEdits } from './finalize';
import { imageBounds, matrixForRect, rectDistance } from './geometry';
import {
  createImageHarness,
  deviceBox,
  diffPixels,
  type ImageHarness,
  imagePdf,
  isWhite,
  renderPage,
  sameBytes,
  solidPng,
} from './test-helpers';

let h: ImageHarness;

beforeAll(async () => {
  h = await createImageHarness();
});

afterAll(async () => {
  await h.adapter.destroy();
});

/** The one image of a page. */
async function only(id: SourceId, pageIndex: number): Promise<LocatedImage> {
  const images = await h.editor.locateImages(id, pageIndex);
  expect(images).toHaveLength(1);
  return images[0] as LocatedImage;
}

/** The edit target `PdfiumProxy` would be: the adapter plus the image editor. */
function target() {
  return Object.assign(Object.create(h.adapter) as typeof h.adapter, {
    transformImage: h.editor.transformImage.bind(h.editor),
    removeImage: h.editor.removeImage.bind(h.editor),
    replaceImage: h.editor.replaceImage.bind(h.editor),
  });
}

const IMAGES_RECT = { x: 126, y: 330, width: 360, height: 270 };

/** Every pixel of `box` is a light neutral grey or white (no colour of an image). */
function isPaper(image: ImageData, box: ReturnType<typeof deviceBox>): boolean {
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const k = (y * image.width + x) * 4;
      const [r, g, b] = [image.data[k] ?? 0, image.data[k + 1] ?? 0, image.data[k + 2] ?? 0];
      if (r !== g || g !== b || r < 200) return false;
    }
  }
  return true;
}

describe('locate (images.pdf, redact-images.pdf)', () => {
  test('images.pdf: three images, one per page, all at 126,330 360×270', async () => {
    const id = await h.open(await fixture(imagesUrl));
    const found = [await only(id, 0), await only(id, 1), await only(id, 2)];
    for (const image of found) {
      expect(image.bounds).toEqual(IMAGES_RECT);
      expect(image.matrix).toEqual([360, 0, 0, 270, 126, 330]);
      expect(image.objectPath).toHaveLength(1);
      expect(image.inForm).toBe(false);
      expect(image.colorSpace).toBe('DeviceRGB');
    }
    expect(found.map((i) => [i.pixelWidth, i.pixelHeight])).toEqual([
      [160, 120],
      [128, 96],
      [160, 120],
    ]);
    expect(found.map((i) => i.filters)).toEqual([['Flate'], ['Flate'], ['DCT']]);
    // Page 1 is a PNG with alpha (a soft mask); the others are opaque.
    expect(found.map((i) => i.hasSMask)).toEqual([true, false, false]);
    expect(found[0]?.dpi.x).toBeCloseTo(32, 5);
    expect(String(await rejection(h.editor.locateImages(id, 3)))).toMatch(/Page 4 does not exist/);
    await h.adapter.close(id);
  });

  test('redact-images.pdf: four images in paint order, an unfiltered inline one last', async () => {
    const id = await h.open(await fixture(redactImagesUrl));
    const images = await h.editor.locateImages(id, 0);
    expect(images.map((i) => i.bounds)).toEqual([
      { x: 72, y: 560, width: 128, height: 128 },
      { x: 240, y: 560, width: 128, height: 128 },
      { x: 408, y: 560, width: 128, height: 128 },
      { x: 72, y: 400, width: 64, height: 64 },
    ]);
    expect(images[3]?.filters).toEqual([]);
    await h.adapter.close(id);
  });
});

describe('extract', () => {
  test('pixels at the image size; a DCT image also gives its JPEG as is', async () => {
    const id = await h.open(await fixture(imagesUrl));
    const png = await h.editor.extractImage(await only(id, 0));
    expect([png.width, png.height, png.rgba.length]).toEqual([160, 120, 160 * 120 * 4]);
    expect(png.original).toBeUndefined();
    // The soft mask is applied: some pixels are transparent.
    expect(png.rgba.some((v, i) => i % 4 === 3 && v < 255)).toBe(true);
    const jpeg = await h.editor.extractImage(await only(id, 2));
    expect([jpeg.width, jpeg.height]).toEqual([160, 120]);
    expect(jpeg.original?.mime).toBe('image/jpeg');
    expect([...(jpeg.original?.bytes.subarray(0, 3) ?? [])]).toEqual([0xff, 0xd8, 0xff]);
    // Extraction leaves the page as it was.
    expect((await only(id, 2)).matrix).toEqual([360, 0, 0, 270, 126, 330]);
    await h.adapter.close(id);
  });
});

describe('transform', () => {
  test('move and resize: new bounds within 0.01 pt, nothing else on the page changes', async () => {
    const id = await h.open(await fixture(imagesUrl));
    const image = await only(id, 1);
    const before = await renderPage(h, id, 1);
    const rect = { x: 176.25, y: 300.5, width: 300, height: 225 };
    const result = await h.editor.transformImage(image, { rect });
    expect(result.previousMatrix).toEqual(image.matrix);
    expect(result.drift).toBeLessThan(0.01);
    const moved = await only(id, 1);
    expect(rectDistance(moved.bounds, rect)).toBeLessThan(0.01);
    expect([moved.pixelWidth, moved.pixelHeight]).toEqual([128, 96]);
    const after = await renderPage(h, id, 1);
    const diff = diffPixels(before, after, [deviceBox(IMAGES_RECT, 792), deviceBox(rect, 792)]);
    expect(diff.outside).toBe(0);
    expect(diff.inside).toBeGreaterThan(0);
    // A second move from the new position (the page was located again).
    await h.editor.transformImage(moved, { rect: { ...rect, x: rect.x - 100 } });
    expect((await only(id, 1)).bounds.x).toBeCloseTo(76.25, 2);
    await h.adapter.close(id);
  });

  test('rotation and skew of the original matrix are kept', async () => {
    const id = await h.open(await imagePdf({ imageMatrix: [60, 20, -10, 40, 100, 100] }));
    const image = await only(id, 0);
    expect(image.bounds).toEqual({ x: 90, y: 100, width: 70, height: 60 });
    const rect = { x: 150, y: 120, width: 140, height: 90 };
    await h.editor.transformImage(image, { rect });
    const moved = await only(id, 0);
    expect(rectDistance(moved.bounds, rect)).toBeLessThan(0.01);
    const m = moved.matrix;
    // Same axis directions: the x axis still rises at 20/60, the y axis still leans back.
    expect(m[1] / m[0]).toBeCloseTo(20 / 60, 4);
    expect(m[2] / m[3]).toBeCloseTo(-10 / 40, 4);
    await h.adapter.close(id);
  });

  test('a matrix target is taken as is; a degenerate one is refused', async () => {
    const id = await h.open(await imagePdf({ imageMatrix: [80, 0, 0, 60, 50, 50] }));
    const image = await only(id, 0);
    await h.editor.transformImage(image, { matrix: [0, 80, -60, 0, 200, 50] });
    const turned = await only(id, 0);
    expect(turned.matrix).toEqual([0, 80, -60, 0, 200, 50]);
    expect(turned.bounds).toEqual({ x: 140, y: 50, width: 60, height: 80 });
    const error = await rejection(h.editor.transformImage(turned, { matrix: [0, 0, 0, 0, 1, 1] }));
    expect(imageEditFailureReason(error)).toBe('invalid-target');
    expect((await only(id, 0)).matrix).toEqual([0, 80, -60, 0, 200, 50]);
    await h.adapter.close(id);
  });

  test('a clipped image takes its clip along', async () => {
    const clip = { x: 45, y: 45, width: 90, height: 70 };
    const id = await h.open(await imagePdf({ imageMatrix: [80, 0, 0, 60, 50, 50], clip }));
    const image = await only(id, 0);
    const rect = { x: 250, y: 150, width: 80, height: 60 };
    await h.editor.transformImage(image, { rect });
    const after = await renderPage(h, id, 0);
    // The image shows (red) at its new place, not clipped away.
    const box = deviceBox(rect, 300, 1, -4);
    const k = ((box.y0 + box.y1) / 2) * after.width * 4 + ((box.x0 + box.x1) / 2) * 4;
    expect([after.data[k], after.data[k + 1], after.data[k + 2]]).toEqual([200, 30, 30]);
    await h.adapter.close(id);
  });

  test('stale refs fail with stale-image and change nothing', async () => {
    const id = await h.open(await fixture(imagesUrl));
    const image = await only(id, 0);
    const moved = { ...image, bounds: { ...image.bounds, x: image.bounds.x + 1 } };
    expect(
      imageEditFailureReason(
        await rejection(h.editor.transformImage(moved, { rect: IMAGES_RECT })),
      ),
    ).toBe('stale-image');
    const resized = { ...image, pixelWidth: 10 };
    expect(imageEditFailureReason(await rejection(h.editor.removeImage(resized)))).toBe(
      'stale-image',
    );
    const elsewhere = { ...image, objectPath: [0] };
    expect(imageEditFailureReason(await rejection(h.editor.extractImage(elsewhere)))).toBe(
      'stale-image',
    );
    expect((await only(id, 0)).bounds).toEqual(IMAGES_RECT);
    await h.adapter.close(id);
  });
});

describe('remove', () => {
  test('the image is gone and its area renders white; other pages keep theirs', async () => {
    const id = await h.open(await fixture(imagesUrl));
    const before = await renderPage(h, id, 1);
    expect(isWhite(before, deviceBox(IMAGES_RECT, 792))).toBe(false);
    const result = await h.editor.removeImage(await only(id, 1));
    expect(result.image).toBeUndefined();
    expect(result.previousMatrix).toEqual([360, 0, 0, 270, 126, 330]);
    expect(await h.editor.locateImages(id, 1)).toEqual([]);
    const after = await renderPage(h, id, 1);
    // What is left there is the fixture's own light-grey backdrop and white paper.
    expect(isPaper(after, deviceBox(IMAGES_RECT, 792, 1, 0))).toBe(true);
    expect(diffPixels(before, after, [deviceBox(IMAGES_RECT, 792)]).outside).toBe(0);
    expect(await h.editor.locateImages(id, 0)).toHaveLength(1);
    expect(await h.editor.locateImages(id, 2)).toHaveLength(1);
    // Saved and opened again: still gone.
    const again = await h.open(await h.adapter.save(id));
    expect(await h.editor.locateImages(again, 1)).toEqual([]);
    await h.adapter.close(again);
    await h.adapter.close(id);
  });

  test('a synthetic page: the area of the removed image is plain white', async () => {
    const id = await h.open(await imagePdf({ imageMatrix: [80, 0, 0, 60, 200, 150] }));
    const before = await renderPage(h, id, 0);
    const box = deviceBox({ x: 200, y: 150, width: 80, height: 60 }, 300, 1, 0);
    expect(isWhite(before, box, 0)).toBe(false);
    await h.editor.removeImage(await only(id, 0));
    const after = await renderPage(h, id, 0);
    expect(isWhite(after, box, 0)).toBe(true);
    expect(
      diffPixels(before, after, [deviceBox({ x: 200, y: 150, width: 80, height: 60 }, 300)])
        .outside,
    ).toBe(0);
    await h.adapter.close(id);
  });

  test('the removed image is not in the saved file; finalizeContentEdits drops the old content', async () => {
    const imageStreams = async (bytes: ArrayBuffer) => {
      const doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
      return doc.context
        .enumerateIndirectObjects()
        .filter(
          ([, o]) =>
            o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'),
        ).length;
    };
    const bytes = await fixture(imagesUrl);
    const id = await h.open(bytes);
    const before = await imageStreams(await h.adapter.save(id));
    // Two edits of the page: the second GenerateContent orphans the first one's stream.
    await h.editor.transformImage(await only(id, 1), {
      rect: { x: 10, y: 10, width: 36, height: 27 },
    });
    await h.editor.removeImage(await only(id, 1));
    const saved = await h.adapter.save(id);
    // PDFium's save leaves out the removed image's stream (nothing references it)…
    expect(await imageStreams(saved)).toBe(before - 1);
    // …but keeps the page's previous content stream, which the GC pass drops.
    const finalized = await finalizeContentEdits(saved);
    expect(finalized.unreachableRemoved).toBeGreaterThanOrEqual(1);
    expect(await imageStreams(finalized.bytes)).toBe(before - 1);
    const reopened = await h.open(finalized.bytes);
    expect(await h.editor.locateImages(reopened, 0)).toHaveLength(1);
    expect(await h.editor.locateImages(reopened, 1)).toEqual([]);
    await h.adapter.close(reopened);
    await h.adapter.close(id);
  });

  test('removing one of several images keeps the others where they were', async () => {
    const id = await h.open(await fixture(redactImagesUrl));
    const images = await h.editor.locateImages(id, 0);
    await h.editor.removeImage(images[1] as LocatedImage);
    const left = await h.editor.locateImages(id, 0);
    expect(left.map((i) => i.bounds)).toEqual([0, 2, 3].map((k) => images[k]?.bounds));
    await h.adapter.close(id);
  });
});

describe('replace', () => {
  const RGBA_2x2 = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128,
  ]);

  test('with 2×2 RGBA: same place, extraction returns the new pixels (alpha as a soft mask)', async () => {
    const id = await h.open(await fixture(imagesUrl));
    const image = await only(id, 1);
    const result = await h.editor.replaceImage(image, { rgba: RGBA_2x2, width: 2, height: 2 });
    expect(result.image?.bounds).toEqual(IMAGES_RECT);
    const now = await only(id, 1);
    expect([now.pixelWidth, now.pixelHeight, now.hasSMask]).toEqual([2, 2, true]);
    const out = await h.editor.extractImage(now);
    expect([out.width, out.height]).toEqual([2, 2]);
    expect([...out.rgba].map((v, i) => (i % 4 === 3 ? Math.round(v / 8) : v))).toEqual(
      [...RGBA_2x2].map((v, i) => (i % 4 === 3 ? Math.round(v / 8) : v)),
    );
    // Saved and opened again: the new pixels are in the file.
    const again = await h.open(await h.adapter.save(id));
    const reread = await h.editor.extractImage(await only(again, 1));
    expect([...reread.rgba.subarray(0, 8)]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    await h.adapter.close(again);
    await h.adapter.close(id);
  });

  test('with a JPEG: embedded as is (extraction gives the same bytes back)', async () => {
    const id = await h.open(await fixture(imagesUrl));
    const jpeg = (await h.editor.extractImage(await only(id, 2))).original?.bytes;
    if (!jpeg) throw new Error('images.pdf page 3 should be a JPEG');
    await h.editor.replaceImage(await only(id, 0), { jpeg });
    const now = await only(id, 0);
    expect(now.filters).toEqual(['DCT']);
    expect(now.bounds).toEqual(IMAGES_RECT);
    expect([now.pixelWidth, now.pixelHeight, now.hasSMask]).toEqual([160, 120, false]);
    const out = await h.editor.extractImage(now);
    expect(sameBytes(out.original?.bytes ?? new Uint8Array(), jpeg)).toBe(true);
    await h.adapter.close(id);
  });

  test('with a PNG: decoded by PDFium, lossless', async () => {
    const id = await h.open(await fixture(imagesUrl));
    await h.editor.replaceImage(await only(id, 2), {
      png: await solidPng(3, 2, [10, 120, 240, 255]),
    });
    const now = await only(id, 2);
    expect([now.pixelWidth, now.pixelHeight]).toEqual([3, 2]);
    const out = await h.editor.extractImage(now);
    expect([...out.rgba.subarray(0, 4)]).toEqual([10, 120, 240, 255]);
    await h.adapter.close(id);
  });

  test('an image XObject drawn twice keeps its pixels at the other place', async () => {
    const id = await h.open(await fixture(redactImagesUrl));
    const images = await h.editor.locateImages(id, 0);
    const pixels = await Promise.all(images.map((i) => h.editor.extractImage(i)));
    await h.editor.replaceImage(images[0] as LocatedImage, { rgba: RGBA_2x2, width: 2, height: 2 });
    const after = await h.editor.locateImages(id, 0);
    expect(after.map((i) => i.bounds)).toEqual(images.map((i) => i.bounds));
    for (const k of [1, 2, 3]) {
      const out = await h.editor.extractImage(after[k] as LocatedImage);
      expect(sameBytes(out.rgba, pixels[k]?.rgba ?? new Uint8Array())).toBe(true);
    }
    await h.adapter.close(id);
  });

  test('bad replacements are refused before anything changes', async () => {
    const id = await h.open(await fixture(imagesUrl));
    const image = await only(id, 0);
    for (const bad of [
      { rgba: new Uint8Array(3), width: 1, height: 1 },
      { jpeg: new Uint8Array([1, 2, 3]) },
      { png: new Uint8Array([0xff, 0xd8, 0xff]) },
    ]) {
      expect(imageEditFailureReason(await rejection(h.editor.replaceImage(image, bad)))).toBe(
        'invalid-replacement',
      );
    }
    expect((await only(id, 0)).pixelWidth).toBe(160);
    await h.adapter.close(id);
  });
});

describe('images inside Form XObjects (built with pdf-lib)', () => {
  const formPdf = () =>
    imagePdf({ imageMatrix: [40, 0, 0, 30, 10, 10], formMatrix: [2, 0, 0, 2, 100, 50] });

  test('located with a two-level path, in page space, marked inForm', async () => {
    const id = await h.open(await formPdf());
    const image = await only(id, 0);
    expect(image.objectPath).toHaveLength(2);
    expect(image.inForm).toBe(true);
    expect(image.matrix).toEqual([80, 0, 0, 60, 120, 70]);
    expect(image.bounds).toEqual({ x: 120, y: 70, width: 80, height: 60 });
    await h.adapter.close(id);
  });

  test('a transform moves the image out of its form to the page; it persists through a save', async () => {
    const id = await h.open(await formPdf());
    const image = await only(id, 0);
    const rect = { x: 200, y: 150, width: 100, height: 75 };
    const result = await h.editor.transformImage(image, { rect });
    expect(result.image?.objectPath).toEqual([(image.objectPath[0] ?? 0) + 1]);
    expect(result.image?.inForm).toBe(false);
    const reopened = await h.open(await h.adapter.save(id));
    const moved = await only(reopened, 0);
    expect(moved.inForm).toBe(false);
    expect(rectDistance(moved.bounds, rect)).toBeLessThan(0.01);
    for (const s of [id, reopened]) await h.adapter.close(s);
  });

  test('replace and remove inside a form persist through a save', async () => {
    const id = await h.open(await formPdf());
    const image = await only(id, 0);
    await h.editor.replaceImage(image, {
      rgba: new Uint8Array([0, 0, 255, 255]),
      width: 1,
      height: 1,
    });
    const replaced = await h.open(await h.adapter.save(id));
    const now = await only(replaced, 0);
    expect([now.pixelWidth, now.pixelHeight, now.inForm]).toEqual([1, 1, false]);
    expect(rectDistance(now.bounds, image.bounds)).toBeLessThan(0.01);
    const other = await h.open(await formPdf());
    await h.editor.removeImage(await only(other, 0));
    const removed = await h.open(await h.adapter.save(other));
    expect(await h.editor.locateImages(removed, 0)).toEqual([]);
    for (const s of [id, replaced, other, removed]) await h.adapter.close(s);
  });

  test('a form drawn on two pages: the other page loses the image (the documented limit)', async () => {
    const id = await h.open(
      await imagePdf({
        imageMatrix: [40, 0, 0, 30, 10, 10],
        formMatrix: [1, 0, 0, 1, 0, 0],
        formOnSecondPage: true,
      }),
    );
    expect((await only(id, 1)).inForm).toBe(true);
    const rect = { x: 200, y: 200, width: 40, height: 30 };
    await h.editor.transformImage(await only(id, 0), { rect });
    const reopened = await h.open(await h.adapter.save(id));
    expect(rectDistance((await only(reopened, 0)).bounds, rect)).toBeLessThan(0.01);
    expect(await h.editor.locateImages(reopened, 1)).toEqual([]);
    await h.adapter.close(reopened);
    await h.adapter.close(id);
  });
});

describe('rotated pages', () => {
  test('/Rotate 90: bounds in unrotated user space, a move lands there', async () => {
    const id = await h.open(await imagePdf({ imageMatrix: [80, 0, 0, 60, 50, 50], rotate: 90 }));
    const image = await only(id, 0);
    expect(image.bounds).toEqual({ x: 50, y: 50, width: 80, height: 60 });
    const rect = { x: 150, y: 100, width: 80, height: 60 };
    await h.editor.transformImage(image, { rect });
    expect(rectDistance((await only(id, 0)).bounds, rect)).toBeLessThan(0.01);
    // Displayed rotated 90° clockwise: user (x, y) → device (y, x) on a 300 × 400 render.
    const shown = await renderPage(h, id, 0);
    expect([shown.width, shown.height]).toEqual([300, 400]);
    const k = (190 * shown.width + 130) * 4;
    expect([shown.data[k], shown.data[k + 1], shown.data[k + 2]]).toEqual([200, 30, 30]);
    await h.adapter.close(id);
  });
});

describe('engine edits (image.transform / image.remove / image.replace)', () => {
  function edit(
    id: SourceId,
    pageIndex: number,
    kind: EngineEdit['kind'],
    payload: unknown,
  ): EngineEdit {
    return { id: `e-${kind}-${Math.random()}`, source: id, pageIndex, kind, payload };
  }

  test('a transform and its inverse: the page renders as before, and a replay is byte-identical', async () => {
    const bytes = await fixture(imagesUrl);
    const id = await h.open(bytes);
    const original = await renderPage(h, id, 1);
    const image = await only(id, 1);
    const forward = edit(id, 1, 'image.transform', {
      image: imageRefJson(image),
      rect: { x: 200, y: 100, width: 180, height: 135 },
    });
    const done = await applyEngineEditWithResult(target(), forward);
    expect(done.inverse.kind).toBe('image.transform');
    expect(isReplayRequired(done.inverse)).toBe(false);
    expect((done.applied.payload as { matrix: number[] }).matrix).toEqual(
      done.image?.image?.matrix,
    );
    const undone = await applyEngineEditWithResult(target(), done.inverse);
    expect((await only(id, 1)).matrix).toEqual(image.matrix);
    expect(diffPixels(original, await renderPage(h, id, 1), []).outside).toBe(0);
    const live = await h.adapter.save(id);

    // The same log replayed onto the original bytes gives the same file.
    const fresh = await h.open(bytes);
    const onFresh = (e: EngineEdit): EngineEdit => ({ ...e, source: fresh });
    const replay = await replayEngineEdits(target(), [done.applied, undone.applied].map(onFresh));
    expect(replay.failed).toEqual([]);
    const replayed = await h.adapter.save(fresh);
    expect(sameBytes(live, replayed)).toBe(true);
    await h.adapter.close(fresh);
    await h.adapter.close(id);
  });

  test('remove and replace are replay-required; replay re-checks the page', async () => {
    const id = await h.open(await fixture(imagesUrl));
    const image = await only(id, 0);
    const removed = await applyEngineEditWithResult(
      target(),
      edit(id, 0, 'image.remove', { image: imageRefJson(image) }),
    );
    expect(isReplayRequired(removed.inverse)).toBe(true);
    expect(isImageReplayRequired(removed.inverse)).toBe(true);
    expect(
      imageEditFailureReason(await rejection(applyEngineEditWithResult(target(), removed.inverse))),
    ).toBe('replay-required');
    // Replaying the removal onto the edited page: the image is not there any more.
    expect(
      imageEditFailureReason(await rejection(applyEngineEditWithResult(target(), removed.applied))),
    ).toBe('stale-image');
    const other = await only(id, 1);
    const replaced = await applyEngineEditWithResult(
      target(),
      edit(id, 1, 'image.replace', {
        image: imageRefJson(other),
        replacement: {
          format: 'png',
          base64: btoa(String.fromCharCode(...(await solidPng(2, 2, [0, 0, 0, 255])))),
        },
      }),
    );
    expect(isReplayRequired(replaced.inverse)).toBe(true);
    expect([replaced.image?.image?.pixelWidth, replaced.image?.image?.pixelHeight]).toEqual([2, 2]);
    await h.adapter.close(id);
  });

  test('invalid payloads are refused', async () => {
    const id = await h.open(await fixture(imagesUrl));
    for (const [kind, payload] of [
      [
        'image.transform',
        {
          image: { objectPath: [], pixelWidth: 1, pixelHeight: 1, bounds: IMAGES_RECT },
          rect: IMAGES_RECT,
        },
      ],
      [
        'image.transform',
        { image: { objectPath: [12], pixelWidth: 1, pixelHeight: 1, bounds: IMAGES_RECT } },
      ],
      ['image.remove', { image: { objectPath: [12] } }],
      [
        'image.replace',
        {
          image: { objectPath: [12], pixelWidth: 1, pixelHeight: 1, bounds: IMAGES_RECT },
          replacement: { format: 'gif', base64: '' },
        },
      ],
    ] as const) {
      const error = await rejection(
        applyEngineEditWithResult(target(), edit(id, 0, kind, payload)),
      );
      expect(String(error)).toMatch(/Invalid image\.(transform|remove|replace) payload/);
    }
    await h.adapter.close(id);
  });
});

describe('PdfiumProxy (worker)', () => {
  test('locate, extract, transform, replace and remove cross the worker; reasons survive', async () => {
    const worker = new Worker(new URL('../worker/pdfium.worker.ts', import.meta.url), {
      type: 'module',
      name: 'pdfium image-objects test',
    });
    const proxy = createPdfiumProxy(worker, { wasmUrl });
    try {
      const id = 'proxy-img' as SourceId;
      await proxy.open(id, await fixture(imagesUrl));
      const [image] = await proxy.locateImages(id, 2);
      if (!image) throw new Error('no image');
      expect(image.filters).toEqual(['DCT']);
      const extracted = await proxy.extractImage(image);
      expect([extracted.width, extracted.height, extracted.rgba.length]).toEqual([160, 120, 76800]);
      expect(extracted.original?.mime).toBe('image/jpeg');
      const rect = { x: 100, y: 100, width: 180, height: 135 };
      const moved = await proxy.transformImage(image, { rect });
      expect(rectDistance(moved.image?.bounds ?? IMAGES_RECT, rect)).toBeLessThan(0.01);
      const error = await rejection(proxy.removeImage(image));
      expect(imageEditFailureReason(error)).toBe('stale-image');
      const replaced = await proxy.replaceImage(moved.image as LocatedImage, {
        rgba: new Uint8Array([9, 9, 9, 255]),
        width: 1,
        height: 1,
      });
      expect(replaced.image?.pixelWidth).toBe(1);
      // The EngineEdit path works against the proxy too.
      const applied = await applyEngineEditWithResult(proxy, {
        id: 'proxy-remove',
        source: id,
        pageIndex: 2,
        kind: 'image.remove',
        payload: { image: imageRefJson(replaced.image as LocatedImage) },
      });
      expect(isReplayRequired(applied.inverse)).toBe(true);
      expect(await proxy.locateImages(id, 2)).toEqual([]);
    } finally {
      await proxy.destroy();
    }
  });
});

test('matrixForRect: a 45° image cannot take every aspect ratio and is scaled in page space', () => {
  const s = Math.SQRT1_2 * 100;
  const turned = [s, s, -s, s, 200, 100] as const;
  const rect = { x: 10, y: 20, width: 300, height: 100 };
  const m = matrixForRect(turned, rect);
  expect(m).toBeDefined();
  expect(rectDistance(imageBounds(m ?? turned), rect)).toBeLessThan(1e-9);
  // A square target keeps the turn exactly (uniform image-axis scale).
  const square = matrixForRect(turned, { x: 0, y: 0, width: 50, height: 50 }) ?? turned;
  expect(square[1] / square[0]).toBeCloseTo(1, 10);
  expect(matrixForRect(turned, { x: 0, y: 0, width: 0, height: 5 })).toBeUndefined();
});

test('imageBounds is the bounding box of the unit square', () => {
  expect(imageBounds([0, 10, -20, 0, 5, 5])).toEqual({ x: -15, y: 5, width: 20, height: 10 });
});
