/**
 * Multiply ink through the real PDFium adapter (the free Highlighter, craft spec §5.4):
 * `blendMode: 'multiply'` on an ink is written by EmbedPDF's blended appearance
 * (`EPDFAnnot_GenerateAppearanceWithBlend`), listed back from it, kept through an update,
 * saved with `/BM /Multiply` in the appearance's ExtGState and listed again after reopening.
 * Such an ink is constant width: widths sent with it are not written. Rendered with our
 * PDFium and pdf.js: the tint shows on white paper and black under it stays black.
 */
import { PDFDict, PDFDocument, PDFName, PDFRawStream, rgb } from '@cantoo/pdf-lib';
import type { SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { makePdf, sid, wasmUrl } from '../../test/helpers';
import { checkAnnotationConformance } from '../annotations/conformance';
import { INK_WIDTHS_KEY } from '../annotations/ink-appearance';
import type { InkAnnotation, NewAnnotation, OpenedDocument } from '../types';
import { createHostedEngine, type HostedEngine } from './host';
import { annotationString } from './host/annot-appearance';
import { type Rendered, renderPdfium, renderPdfjs } from './ink-width-probe';
import { PdfiumAdapter } from './pdfium-adapter';

let host: HostedEngine;
let adapter: PdfiumAdapter;
let counter = 0;
const ZERO = { x: 0, y: 0, width: 0, height: 0 };
const TINT = '#FFEA00';
const WIDTH = 12;
/** A black bar the stroke crosses: Multiply must keep it black. */
const BLACK_BAR = { x: 200, y: 480, width: 40, height: 40 };
const FROM = { x: 120, y: 500 };
const TO = { x: 420, y: 500 };

beforeAll(async () => {
  host = await createHostedEngine({ wasm: wasmUrl });
  adapter = new PdfiumAdapter({
    wasmUrl,
    engineFactory: () => host.engine,
    rawTask: (sourceId, fn, options) => host.withRawTask(sourceId, fn, options),
  });
});

afterAll(async () => {
  await adapter.destroy();
});

async function open(bytes: ArrayBuffer): Promise<{ id: SourceId; opened: OpenedDocument }> {
  const id = sid(`ink-blend-${++counter}`);
  return { id, opened: await adapter.open(id, bytes.slice(0)) };
}

function barDoc(): Promise<ArrayBuffer> {
  return makePdf([{ size: [612, 792], text: 'Multiply ink', at: [72, 720] }], (doc) => {
    doc.getPage(0).drawRectangle({ ...BLACK_BAR, color: rgb(0, 0, 0) });
  });
}

function multiplyInk(extra: Partial<Extract<NewAnnotation, { kind: 'ink' }>> = {}) {
  const ink: Extract<NewAnnotation, { kind: 'ink' }> = {
    kind: 'ink',
    pageIndex: 0,
    rect: ZERO,
    paths: [[FROM, { x: 270, y: 500 }, TO]],
    strokeWidth: WIDTH,
    color: TINT,
    blendMode: 'multiply',
    ...extra,
  };
  return ink;
}

async function listed(id: SourceId, nm: string): Promise<InkAnnotation> {
  const found = (await adapter.listAnnotations(id, 0)).find((a) => a.id === nm);
  expect(found?.kind).toBe('ink');
  return found as InkAnnotation;
}

function pixel(r: Rendered, p: { x: number; y: number }): readonly number[] {
  const [px, py] = r.toPixel(p);
  const k = (Math.round(py) * r.raster.width + Math.round(px)) * 4;
  return [r.raster.data[k] ?? -1, r.raster.data[k + 1] ?? -1, r.raster.data[k + 2] ?? -1];
}

function expectNear(actual: readonly number[], expected: readonly number[], label: string) {
  for (const [c, value] of expected.entries()) {
    expect(Math.abs((actual[c] ?? -1) - value), `${label} channel ${c}`).toBeLessThanOrEqual(8);
  }
}

/** The tint on white, black under the stroke, at the stroke's centre line. */
function expectMultiply(r: Rendered, label: string): void {
  expectNear(pixel(r, { x: 160, y: 500 }), [0xff, 0xea, 0x00], `${label}: tint on white`);
  expectNear(pixel(r, { x: 220, y: 500 }), [0, 0, 0], `${label}: black under the stroke`);
  // Constant width: the band reaches ±(WIDTH/2 − 1) pt at both ends.
  for (const x of [140, 400]) {
    expectNear(pixel(r, { x, y: 500 + WIDTH / 2 - 1 }), [0xff, 0xea, 0x00], `${label}: x ${x}`);
  }
}

/** The `/BM` values in the normal appearance's ExtGStates of the ink `nm` of a saved file. */
async function savedBlendModes(bytes: ArrayBuffer, nm: string): Promise<string[]> {
  const doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
  for (const ref of doc.getPage(0).node.Annots()?.asArray() ?? []) {
    const dict = doc.context.lookup(ref);
    if (!(dict instanceof PDFDict)) continue;
    const name = dict.get(PDFName.of('NM'));
    if (!name?.toString().includes(nm)) continue;
    const n = dict.lookupMaybe(PDFName.of('AP'), PDFDict)?.lookup(PDFName.of('N'));
    if (!(n instanceof PDFRawStream)) return [];
    const states = n.dict
      .lookupMaybe(PDFName.of('Resources'), PDFDict)
      ?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
    if (!states) return [];
    return states
      .keys()
      .map((key) => states.lookupMaybe(key, PDFDict)?.get(PDFName.of('BM'))?.toString() ?? '');
  }
  throw new Error(`No annotation ${nm}`);
}

describe('Multiply ink', () => {
  test('create writes a blended constant-width appearance; widths are not written', async () => {
    const { id, opened } = await open(await barDoc());
    const created = (await adapter.createAnnotation(
      id,
      multiplyInk({ widths: [[6, 12, 18]] }),
    )) as InkAnnotation;
    expect(created.blendMode).toBe('multiply');
    expect(created.widths).toBeUndefined();
    expect(created.strokeWidth).toBe(WIDTH);
    expect(created.color).toBe(TINT);
    expect(
      await host.withRawAccess(id, (raw) => annotationString(raw, 0, created.id, INK_WIDTHS_KEY)),
    ).toBeUndefined();
    expect((await listed(id, created.id)).blendMode).toBe('multiply');
    expectMultiply(await renderPdfium(adapter, id, opened, 0), 'PDFium');
    await adapter.close(id);
  });

  test('an ink without a blend mode lists none', async () => {
    const { id } = await open(await barDoc());
    const { blendMode: _none, ...plain } = multiplyInk({ color: '#1A1A1A', strokeWidth: 2 });
    const created = (await adapter.createAnnotation(id, plain)) as InkAnnotation;
    expect(created.blendMode).toBeUndefined();
    expect((await listed(id, created.id)).blendMode).toBeUndefined();
    await adapter.close(id);
  });

  test('a move and a path append keep Multiply and the constant width', async () => {
    const { id, opened } = await open(await barDoc());
    const created = (await adapter.createAnnotation(id, multiplyInk())) as InkAnnotation;
    // A burst append: one more path, with widths (as the pen sends them), joins the ink.
    const appended = (await adapter.updateAnnotation(id, {
      ...created,
      paths: [
        ...created.paths,
        [
          { x: 120, y: 560 },
          { x: 420, y: 560 },
        ],
      ],
      widths: [created.paths[0]?.map(() => WIDTH) ?? [], [WIDTH, WIDTH]],
    })) as InkAnnotation;
    expect(appended.blendMode).toBe('multiply');
    expect(appended.widths).toBeUndefined();
    expect(appended.paths).toHaveLength(2);
    expectMultiply(await renderPdfium(adapter, id, opened, 0), 'after append');
    // A move of the box moves the paths; the blend stays.
    const moved = (await adapter.updateAnnotation(id, {
      ...appended,
      rect: { ...appended.rect, x: appended.rect.x + 10 },
    })) as InkAnnotation;
    expect(moved.blendMode).toBe('multiply');
    expect(moved.paths[0]?.[0]?.x).toBeCloseTo(FROM.x + 10, 1);
    await adapter.close(id);
  });

  test('save writes /BM /Multiply; reopen lists it; pdf.js draws it multiplied', async () => {
    const { id } = await open(await barDoc());
    const created = (await adapter.createAnnotation(id, multiplyInk())) as InkAnnotation;
    const saved = await adapter.save(id);
    expect((await checkAnnotationConformance(saved.slice(0))).problems).toEqual([]);
    expect(await savedBlendModes(saved, created.id)).toContain('/Multiply');

    const js = await renderPdfjs(saved, [0]);
    const page = js.pages.get(0);
    if (!page) throw new Error('pdf.js rendered nothing');
    expectMultiply(page, 'pdf.js');

    const reopened = await open(saved);
    const back = await listed(reopened.id, created.id);
    expect(back.blendMode).toBe('multiply');
    expect(back.strokeWidth).toBe(WIDTH);
    expect(back.widths).toBeUndefined();
    expectMultiply(await renderPdfium(adapter, reopened.id, reopened.opened, 0), 'reopened');
    await adapter.close(reopened.id);
    await adapter.close(id);
  });
});
