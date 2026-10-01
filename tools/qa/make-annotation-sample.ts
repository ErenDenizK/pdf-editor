/**
 * Builds docs/qa/samples/annotations-sample.pdf: one annotation of every kind in spec
 * viewer-annotations.md §3, written by the app's own PDFium adapter (the code path export
 * uses: `createAnnotation` + `save()`), for the cross-viewer matrix in
 * docs/qa/annotations-matrix.md. What is written, and what viewers must show for it, is the
 * plan in annotation-sample-plan.ts, which the automated matrix (annotation-matrix.ts)
 * checks against.
 *
 *   pnpm --filter @pdf-editor/qa-tool sample
 *
 * Runs as a Vitest browser-mode file (see vitest.config.ts): the adapter needs a browser
 * (PDFium's WASM), and `commands.writeFile` stores the bytes. The adapter runs on the hosted
 * engine with raw access, as in the app's PDFium worker, so variable-width inks get the
 * engine's appearance and `/PdfEditorInkWidths` (ADR-0018). The sample must
 * pass `checkAnnotationConformance` before it is written. Page 1 is upright; page 2 has
 * /Rotate 90 (annotations are placed in unrotated user space and shown rotated).
 *
 * Reproducible: /NM values come from the plan, every date is SAMPLE_DATE (the clock is
 * frozen while the adapter saves, since its annotation post-pass stamps popups with the
 * current time) and the stamp image is drawn pixel by pixel, so regenerating on the same
 * engine version yields the same bytes.
 */

import { degrees, PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import {
  checkAnnotationConformance,
  createHostedEngine,
  describeConformanceProblems,
  type NewAnnotation,
  PdfiumAdapter,
  PdfLibAssembler,
} from '@pdf-editor/engine';
import type { SourceId } from '@pdf-editor/document-model';
import { afterEach, expect, test, vi } from 'vitest';
import { commands } from 'vitest/browser';

import {
  PAGE_ROTATIONS,
  PAGE_SIZE,
  PLAN,
  SAMPLE_DATE,
  SAMPLE_PATH,
  SAMPLE_TEXT,
  SAMPLE_TEXT_WIDTH,
  TEXT_SIZE,
  entriesOnPage,
} from './annotation-sample-plan';

/**
 * The stamp image: a blue disc (#1E88E5) with a white bar, on white, drawn pixel by pixel
 * (4× supersampled edges, no fonts) so the PNG is the same on every machine.
 */
async function pngStamp(): Promise<Blob> {
  const size = 96;
  const image = new ImageData(size, size);
  const blue = [0x1e, 0x88, 0xe5];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const dx = x + (sx + 0.5) / 4 - 48;
          const dy = y + (sy + 0.5) / 4 - 48;
          if (dx * dx + dy * dy <= 44 * 44) inside++;
        }
      }
      const bar = x >= 28 && x < 68 && y >= 42 && y < 54;
      const coverage = bar ? 0 : inside / 16;
      const offset = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        image.data[offset + c] = Math.round(255 - (255 - (blue[c] ?? 0)) * coverage);
      }
      image.data[offset + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas');
  ctx.putImageData(image, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

async function basePdf(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  doc.setTitle('Annotation sample');
  doc.setCreationDate(new Date(SAMPLE_DATE));
  doc.setModificationDate(new Date(SAMPLE_DATE));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  expect(font.widthOfTextAtSize(SAMPLE_TEXT, TEXT_SIZE)).toBeCloseTo(SAMPLE_TEXT_WIDTH, 3);
  PAGE_ROTATIONS.forEach((rotation, pageIndex) => {
    const page = doc.addPage([PAGE_SIZE.width, PAGE_SIZE.height]);
    const suffix = rotation === 0 ? '' : ` (/Rotate ${rotation})`;
    page.drawText(`Annotation sample, page ${pageIndex + 1}${suffix}`, {
      x: 72,
      y: 740,
      size: 16,
      font: bold,
    });
    for (const entry of entriesOnPage(pageIndex)) {
      if (entry.overText && 'quads' in entry.annotation) {
        const quad = entry.annotation.quads[0];
        if (quad) page.drawText(SAMPLE_TEXT, { x: quad.x, y: quad.y + 3, size: TEXT_SIZE, font });
      }
      if (entry.underlay) {
        const [x, y] = entry.underlay.at;
        page.drawText(entry.underlay.text, { x, y, size: 10, font: bold });
      }
      page.drawText(entry.label, { x: entry.at[0], y: entry.at[1], size: 9, font });
    }
    if (rotation !== 0) page.setRotation(degrees(rotation));
  });
  const bytes = await doc.save();
  return bytes.slice().buffer;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

afterEach(() => {
  vi.useRealTimers();
});

test('build docs/qa/samples/annotations-sample.pdf', async () => {
  const image = await pngStamp();
  // pdf-lib (/ModDate on load) and the adapter's post-pass (popup /M) read the clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(SAMPLE_DATE));
  const host = await createHostedEngine({ wasm: wasmUrl });
  const adapter = new PdfiumAdapter({
    wasmUrl,
    engineFactory: () => host.engine,
    rawTask: (sourceId, fn, options) => host.withRawTask(sourceId, fn, options),
    inspector: new PdfLibAssembler(),
  });
  const id = 'qa-sample' as SourceId;
  try {
    await adapter.open(id, await basePdf());
    for (const entry of PLAN) {
      const annotation: NewAnnotation =
        entry.imageStamp && entry.annotation.kind === 'stamp'
          ? { ...entry.annotation, imageBlob: image }
          : entry.annotation;
      const created = await adapter.createAnnotation(id, annotation);
      expect(created.id).toBe(entry.annotation.id);
      // Variable-width inks come back with their widths (stored, two decimals).
      if (entry.widthProfile) expect(created.kind === 'ink' && created.widths).toBeTruthy();
    }
    const bytes = await adapter.save(id);
    const report = await checkAnnotationConformance(bytes.slice(0));
    expect(describeConformanceProblems(report.problems)).toEqual([]);
    expect(report.counts).toEqual(PAGE_ROTATIONS.map((_, i) => entriesOnPage(i).length));
    await commands.writeFile(SAMPLE_PATH, toBase64(new Uint8Array(bytes)), 'base64');
  } finally {
    await adapter.destroy();
  }
});
