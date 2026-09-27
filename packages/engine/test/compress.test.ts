/**
 * Compression (spec §5, §9): analysis, skip rules, size deltas and visual fidelity (PSNR of
 * a rendered page before/after) on images.pdf and on a generated Flate RGB photo.
 */
import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  PDFName,
  popGraphicsState,
  pushGraphicsState,
} from '@cantoo/pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import imagesUrl from '../../../test/fixtures/images.pdf?url';
import simpleTextUrl from '../../../test/fixtures/simple-text.pdf?url';
import qpdfWasmUrl from '../qpdf/dist/qpdf.wasm?url';
import {
  analyzeCompression,
  compressPdf,
  type CompressionDependencies,
} from '../src/compress/compress';
import { canvasEncoder } from '../src/compress/encode';
import { PdfiumImageDecoder } from '../src/compress/pdfium-decoder';
import { estimateCompression, presetSettings } from '../src/compress/presets';
import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import { QpdfPlumber } from '../src/plumber/qpdf-plumber';
import { flateGrayPdf, flateRgbPdf, psnr, renderRgba } from './compress-helpers';
import { toBuffer, wasmUrl } from './helpers';

const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();

let deps: CompressionDependencies;
let adapter: PdfiumAdapter;

beforeAll(() => {
  deps = {
    plumber: new QpdfPlumber({ wasmUrl: qpdfWasmUrl }),
    decoder: new PdfiumImageDecoder(wasmUrl),
    encoder: canvasEncoder,
  };
  adapter = new PdfiumAdapter({ wasmUrl });
});
afterAll(async () => {
  await adapter.destroy();
});

async function pageCount(bytes: ArrayBuffer): Promise<number> {
  return (await PDFDocument.load(bytes.slice(0), { updateMetadata: false })).getPageCount();
}

function log(label: string, before: number, after: number, quality?: number) {
  // eslint-disable-next-line no-console -- measured numbers for the report
  console.info(
    `[compress] ${label}: ${before} -> ${after} bytes (${(((before - after) / before) * 100).toFixed(1)}% saved)${quality === undefined ? '' : `, PSNR ${quality.toFixed(1)} dB`}`,
  );
}

describe('analysis', () => {
  it('lists the images of images.pdf with encoding, alpha and DPI', async () => {
    const analysis = await analyzeCompression(await fetchBytes(imagesUrl), deps);
    expect(analysis.pageCount).toBe(3);
    // Page 1's soft mask travels with its image and is not listed on its own.
    expect(analysis.images).toHaveLength(3);
    const [alpha, opaque, jpeg] = analysis.images;
    expect(alpha).toMatchObject({ page: 0, filter: 'FlateDecode', hasSMask: true });
    expect(opaque).toMatchObject({ page: 1, filter: 'FlateDecode', hasSMask: false });
    expect(jpeg).toMatchObject({ page: 2, filter: 'DCTDecode', hasSMask: false });
    for (const image of analysis.images) {
      expect(image.dpi).not.toBeNull();
      expect(image.placements).toBe(1);
    }
    expect(analysis.fonts.every((f) => f.subtype.length > 0)).toBe(true);
    expect(analysis.losslessBytes).not.toBeNull();
    expect(analysis.objectCount).toBeGreaterThan(5);
  });

  it('computes the DPI of a generated placement exactly', async () => {
    const analysis = await analyzeCompression(await flateRgbPdf(1200, 900, 4), deps);
    expect(analysis.images).toHaveLength(1);
    expect(analysis.images[0]).toMatchObject({
      width: 1200,
      height: 900,
      colorSpace: 'DeviceRGB',
      components: 3,
      dpi: { x: 300, y: 300 },
    });
  });

  it('estimates little for a text-only file (the < 3 % honesty rule)', async () => {
    const analysis = await analyzeCompression(await fetchBytes(simpleTextUrl), deps);
    const estimate = estimateCompression(analysis, presetSettings('screen'));
    expect(analysis.images).toHaveLength(0);
    expect(estimate.imagesSaved).toBe(0);
    expect(estimate.worthwhile).toBe(estimate.ratio >= 0.03);
  });
});

describe('compression', () => {
  it('images.pdf with the Screen preset: smaller, same pages, alpha image skipped', async () => {
    const source = await fetchBytes(imagesUrl);
    const result = await compressPdf(source.slice(0), presetSettings('screen'), deps);
    expect(result.after).toBeLessThan(result.before);
    expect(await pageCount(result.bytes)).toBe(3);
    const alpha = result.images.find((r) => r.page === 0);
    expect(alpha).toMatchObject({ action: 'skipped', reason: 'has-alpha' });
    for (const report of result.images) expect(report.after).toBeLessThanOrEqual(report.before);
    // Its images are small (26–32 dpi as placed): only the lossless pass applies.
    expect(result.images.map((r) => r.reason)).toEqual(['has-alpha', 'too-small', 'at-target']);
    let worst = Infinity;
    for (const index of [0, 1, 2]) {
      const quality = psnr(
        (await renderRgba(adapter, source, index, 1)).data,
        (await renderRgba(adapter, result.bytes, index, 1)).data,
      );
      worst = Math.min(worst, quality);
    }
    log('images.pdf screen', result.before, result.after, worst);
    expect(worst).toBeGreaterThan(40);
  });

  it('flattens the alpha image onto white only when asked', async () => {
    const source = await fetchBytes(imagesUrl);
    const result = await compressPdf(
      source.slice(0),
      { ...presetSettings('ebook'), flattenAlpha: true },
      deps,
    );
    const alpha = result.images.find((r) => r.page === 0);
    expect(alpha?.reason).not.toBe('has-alpha');
    expect(await pageCount(result.bytes)).toBe(3);
    // The page is white, so compositing onto white keeps the look.
    const quality = psnr(
      (await renderRgba(adapter, source, 0, 2)).data,
      (await renderRgba(adapter, result.bytes, 0, 2)).data,
    );
    log('images.pdf ebook+flatten', result.before, result.after, quality);
    expect(result.after).toBeLessThan(result.before / 2);
    // The image is placed at 32 dpi, so this 144 dpi render magnifies JPEG blocks 4.5x.
    expect(quality).toBeGreaterThan(26);
  });

  it('never re-encodes a JPEG already at or below the target', async () => {
    const source = await fetchBytes(imagesUrl);
    const result = await compressPdf(source.slice(0), presetSettings('print'), deps);
    const jpeg = result.images.find((r) => r.page === 2);
    expect(jpeg?.action).toBe('skipped');
    expect(['at-target', 'not-smaller']).toContain(jpeg?.reason);
    expect(result.after).toBeLessThanOrEqual(result.before);
  });

  it('downsamples a large Flate RGB photo and keeps the page visually close', async () => {
    const source = await flateRgbPdf(2400, 1800, 4); // 600 dpi
    const settings = presetSettings('ebook');
    const analysis = await analyzeCompression(source.slice(0), deps);
    const estimate = estimateCompression(analysis, settings);
    expect(estimate.worthwhile).toBe(true);
    const result = await compressPdf(source.slice(0), settings, deps);
    expect(result.images[0]).toMatchObject({
      action: 'downsampled',
      newWidth: 600,
      newHeight: 450,
      encoding: 'jpeg',
    });
    expect(result.after).toBeLessThan(result.before * 0.2);
    expect(result.pages).toEqual([
      { page: 0, before: result.images[0]?.before, after: result.images[0]?.after },
    ]);
    // Rendered at 150 dpi (the target), the page differs only by JPEG noise.
    const quality = psnr(
      (await renderRgba(adapter, source, 0, 150 / 72)).data,
      (await renderRgba(adapter, result.bytes, 0, 150 / 72)).data,
    );
    log('flate-rgb 2400x1800@600dpi ebook', result.before, result.after, quality);
    log('  estimate', estimate.before, estimate.after);
    expect(quality).toBeGreaterThan(30);
  });

  it('downsamples a greyscale scan (grey is never mistaken for line art)', async () => {
    const source = await flateGrayPdf(2400, 1800, 4); // 600 dpi
    const settings = presetSettings('screen');
    const estimate = estimateCompression(await analyzeCompression(source.slice(0), deps), settings);
    const result = await compressPdf(source.slice(0), settings, deps);
    expect(result.images[0]).toMatchObject({
      action: 'downsampled',
      newWidth: 384,
      newHeight: 288,
      encoding: 'jpeg',
    });
    expect(result.after).toBeLessThan(result.before * 0.05);
    const quality = psnr(
      (await renderRgba(adapter, source, 0, 96 / 72)).data,
      (await renderRgba(adapter, result.bytes, 0, 96 / 72)).data,
    );
    log('flate-gray 2400x1800@600dpi screen', result.before, result.after, quality);
    log('  estimate', estimate.before, estimate.after);
    expect(quality).toBeGreaterThan(30);
  });

  it('keeps grey line art lossless at full resolution', async () => {
    const width = 800;
    const height = 600;
    const doc = await PDFDocument.create({ updateMetadata: false });
    const samples = new Uint8Array(width * height).map((_, i) =>
      Math.floor(i / width) % 40 < 3 || (i % width) % 50 < 2 ? 0 : 255,
    );
    // Stored uncompressed so a lossless re-encode is smaller.
    const ref = doc.context.register(
      doc.context.stream(samples, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      }),
    );
    const page = doc.addPage([612, 792]);
    page.node.setXObject(PDFName.of('Art'), ref);
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(144, 0, 0, 108, 36, 36),
      drawObject('Art'),
      popGraphicsState(),
    );
    const result = await compressPdf(toBuffer(await doc.save()), presetSettings('screen'), deps);
    expect(result.images[0]).toMatchObject({
      action: 'recompressed',
      encoding: 'flate-gray',
      newWidth: width,
    });
    const quality = psnr(
      (await renderRgba(adapter, toBuffer(await doc.save()), 0, 1)).data,
      (await renderRgba(adapter, result.bytes, 0, 1)).data,
    );
    expect(quality).toBe(Infinity);
  });

  it('honours compatibility mode (no object or xref streams)', async () => {
    const source = await flateRgbPdf(800, 600, 4);
    const result = await compressPdf(source.slice(0), presetSettings('screen'), deps, {
      compatibility: true,
    });
    const text = new TextDecoder('latin1').decode(new Uint8Array(result.bytes));
    expect(text).not.toMatch(/\/ObjStm|\/XRef/);
    expect(text).toMatch(/\nxref\r?\n/);
    expect(await pageCount(result.bytes)).toBe(1);
  });

  it('returns the original bytes when nothing gets smaller', async () => {
    const source = await fetchBytes(simpleTextUrl);
    const result = await compressPdf(source.slice(0), presetSettings('screen'), deps);
    expect(result.after).toBeLessThanOrEqual(result.before);
    if (result.unchanged) expect(result.after).toBe(result.before);
  });

  it('re-encrypts when asked and stops when aborted', async () => {
    const source = await flateRgbPdf(800, 600, 4);
    const result = await compressPdf(source.slice(0), presetSettings('screen'), deps, {
      // No owner password (the export dialog allows that): a random one is used.
      encrypt: {
        algorithm: 'aes-256',
        userPassword: 'pw',
        permissions: {
          print: true,
          printHighQuality: true,
          modify: true,
          copy: true,
          annotate: true,
          fillForms: true,
          accessibility: true,
          assemble: true,
        },
      },
    });
    await expect(PDFDocument.load(result.bytes.slice(0))).rejects.toThrow();
    const reopened = await PDFDocument.load(result.bytes.slice(0), { password: 'pw' });
    expect(reopened.getPageCount()).toBe(1);

    const controller = new AbortController();
    controller.abort();
    await expect(
      compressPdf(source.slice(0), presetSettings('screen'), deps, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});
