/**
 * Builds docs/qa/samples/annotations-sample.pdf: one annotation of every kind in spec
 * viewer-annotations.md §3, written by the app's own PDFium adapter (the code path export
 * uses: `createAnnotation` + `save()`), for the manual cross-viewer matrix in
 * docs/qa/annotations-matrix.md.
 *
 *   pnpm --filter @pdf-editor/qa-tool sample
 *
 * Runs as a Vitest browser-mode file (see vitest.config.ts): the adapter needs a browser
 * (EmbedPDF's worker and WASM), and `commands.writeFile` stores the bytes. The sample must
 * pass `checkAnnotationConformance` before it is written. Page 1 is upright; page 2 has
 * /Rotate 90 (annotations are placed in unrotated user space and shown rotated).
 */

import { degrees, PDFDocument, type PDFFont, StandardFonts } from '@cantoo/pdf-lib';
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import {
  checkAnnotationConformance,
  describeConformanceProblems,
  type NewAnnotation,
  PdfiumAdapter,
  PdfLibAssembler,
} from '@pdf-editor/engine';
import type { SourceId } from '@pdf-editor/document-model';
import { expect, test } from 'vitest';
import { commands } from 'vitest/browser';

const OUTPUT = '../../docs/qa/samples/annotations-sample.pdf';
const SAMPLE_TEXT = 'The quick brown fox jumps over the lazy dog';
const TEXT_SIZE = 12;

interface Labelled {
  readonly label: string;
  /** Where the label is drawn (user space, baseline). */
  readonly at: readonly [number, number];
  readonly annotation: NewAnnotation;
}

function textQuad(font: PDFFont, x: number, baseline: number) {
  const width = font.widthOfTextAtSize(SAMPLE_TEXT, TEXT_SIZE);
  const descent = 3;
  return { x, y: baseline - descent, width, height: TEXT_SIZE + 2 };
}

/** A small PNG drawn on a canvas (a stamp image). */
async function pngStamp(): Promise<Blob> {
  const canvas = new OffscreenCanvas(96, 96);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas');
  ctx.fillStyle = '#1E88E5';
  ctx.beginPath();
  ctx.arc(48, 48, 44, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('IMG', 48, 50);
  return canvas.convertToBlob({ type: 'image/png' });
}

function page1(font: PDFFont, image: Blob): Labelled[] {
  const markup = (
    kind: 'highlight' | 'underline' | 'strikeout' | 'squiggly',
    baseline: number,
    color: string,
  ): Labelled => {
    const quad = textQuad(font, 72, baseline);
    return {
      label: kind,
      at: [400, baseline],
      annotation: {
        kind,
        pageIndex: 0,
        rect: quad,
        quads: [quad],
        color,
        contents: `${kind} comment`,
      },
    };
  };
  return [
    markup('highlight', 690, '#FFEB3B'),
    markup('underline', 665, '#1E88E5'),
    markup('strikeout', 640, '#E53935'),
    markup('squiggly', 615, '#43A047'),
    {
      label: 'ink',
      at: [72, 500],
      annotation: {
        kind: 'ink',
        pageIndex: 0,
        rect: { x: 0, y: 0, width: 0, height: 0 },
        paths: [
          [
            { x: 72, y: 520 },
            { x: 100, y: 580 },
            { x: 130, y: 530 },
            { x: 160, y: 585 },
          ],
        ],
        strokeWidth: 2,
        color: '#6A1B9A',
      },
    },
    {
      label: 'square (50% opacity)',
      at: [200, 500],
      annotation: {
        kind: 'square',
        pageIndex: 0,
        rect: { x: 200, y: 520, width: 80, height: 60 },
        strokeWidth: 2,
        color: '#E53935',
        interiorColor: '#FFCDD2',
        opacity: 0.5,
      },
    },
    {
      label: 'circle',
      at: [320, 500],
      annotation: {
        kind: 'circle',
        pageIndex: 0,
        rect: { x: 320, y: 520, width: 80, height: 60 },
        strokeWidth: 2,
        color: '#43A047',
      },
    },
    {
      label: 'line (arrow)',
      at: [440, 500],
      annotation: {
        kind: 'line',
        pageIndex: 0,
        rect: { x: 0, y: 0, width: 0, height: 0 },
        strokeWidth: 2,
        vertices: [
          { x: 440, y: 525 },
          { x: 530, y: 580 },
        ],
        lineEndings: { end: 'open-arrow' },
        color: '#000000',
      },
    },
    {
      label: 'polygon',
      at: [72, 380],
      annotation: {
        kind: 'polygon',
        pageIndex: 0,
        rect: { x: 0, y: 0, width: 0, height: 0 },
        strokeWidth: 1.5,
        vertices: [
          { x: 72, y: 400 },
          { x: 160, y: 400 },
          { x: 116, y: 460 },
        ],
        color: '#00897B',
        interiorColor: '#B2DFDB',
      },
    },
    {
      label: 'polyline',
      at: [200, 380],
      annotation: {
        kind: 'polyline',
        pageIndex: 0,
        rect: { x: 0, y: 0, width: 0, height: 0 },
        strokeWidth: 1.5,
        vertices: [
          { x: 200, y: 400 },
          { x: 230, y: 460 },
          { x: 260, y: 400 },
          { x: 290, y: 460 },
        ],
        color: '#F4511E',
      },
    },
    {
      label: 'free text',
      at: [320, 380],
      annotation: {
        kind: 'free-text',
        pageIndex: 0,
        rect: { x: 320, y: 400, width: 220, height: 50 },
        text: 'Free text in a box, 14 pt',
        fontSize: 14,
        textColor: '#C62828',
      },
    },
    {
      label: 'note (open popup)',
      at: [72, 250],
      annotation: {
        kind: 'text',
        pageIndex: 0,
        rect: { x: 72, y: 270, width: 20, height: 20 },
        contents: 'This note text must appear in the comment UI.',
        icon: 'Comment',
        open: true,
        color: '#FFEB3B',
      },
    },
    {
      label: 'stamp (named: Approved)',
      at: [200, 250],
      annotation: {
        kind: 'stamp',
        pageIndex: 0,
        rect: { x: 200, y: 270, width: 140, height: 44 },
        name: 'Approved',
      },
    },
    {
      label: 'stamp (image)',
      at: [380, 250],
      annotation: {
        kind: 'stamp',
        pageIndex: 0,
        rect: { x: 380, y: 270, width: 48, height: 48 },
        imageBlob: image,
        contents: 'Image stamp',
      },
    },
    {
      label: 'link (https://example.org/)',
      at: [72, 150],
      annotation: {
        kind: 'link',
        pageIndex: 0,
        rect: { x: 72, y: 165, width: 160, height: 18 },
        uri: 'https://example.org/',
      },
    },
  ];
}

/** Page 2 has /Rotate 90: a few kinds to check rotated placement. */
function page2(font: PDFFont): Labelled[] {
  const quad = textQuad(font, 72, 690);
  return [
    {
      label: 'highlight on a rotated page',
      at: [400, 690],
      annotation: { kind: 'highlight', pageIndex: 1, rect: quad, quads: [quad], color: '#FFEB3B' },
    },
    {
      label: 'note on a rotated page',
      at: [72, 560],
      annotation: {
        kind: 'text',
        pageIndex: 1,
        rect: { x: 72, y: 580, width: 20, height: 20 },
        contents: 'Rotated page note',
      },
    },
    {
      label: 'square on a rotated page',
      at: [200, 560],
      annotation: {
        kind: 'square',
        pageIndex: 1,
        rect: { x: 200, y: 580, width: 100, height: 50 },
        strokeWidth: 2,
        color: '#1E88E5',
      },
    },
  ];
}

async function basePdf(items: readonly Labelled[][]): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  doc.setTitle('Annotation sample');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  items.forEach((list, pageIndex) => {
    const page = doc.addPage([612, 792]);
    page.drawText(
      `Annotation sample, page ${pageIndex + 1}${pageIndex === 1 ? ' (/Rotate 90)' : ''}`,
      {
        x: 72,
        y: 740,
        size: 16,
        font: bold,
      },
    );
    for (const item of list) {
      if ('quads' in item.annotation) {
        const quad = item.annotation.quads[0];
        if (quad) page.drawText(SAMPLE_TEXT, { x: quad.x, y: quad.y + 3, size: TEXT_SIZE, font });
      }
      page.drawText(item.label, { x: item.at[0], y: item.at[1], size: 9, font });
    }
    if (pageIndex === 1) page.setRotation(degrees(90));
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

test('build docs/qa/samples/annotations-sample.pdf', async () => {
  const scratch = await PDFDocument.create();
  const font = await scratch.embedFont(StandardFonts.Helvetica);
  const items = [page1(font, await pngStamp()), page2(font)];
  const adapter = new PdfiumAdapter({ wasmUrl, inspector: new PdfLibAssembler() });
  const id = 'qa-sample' as SourceId;
  try {
    await adapter.open(id, await basePdf(items));
    for (const item of items.flat()) {
      await adapter.createAnnotation(id, { ...item.annotation, author: 'QA sample' });
    }
    const bytes = await adapter.save(id);
    const report = await checkAnnotationConformance(bytes.slice(0));
    expect(describeConformanceProblems(report.problems)).toEqual([]);
    expect(report.counts).toEqual(items.map((list) => list.length));
    await commands.writeFile(OUTPUT, toBase64(new Uint8Array(bytes)), 'base64');
  } finally {
    await adapter.destroy();
  }
});
