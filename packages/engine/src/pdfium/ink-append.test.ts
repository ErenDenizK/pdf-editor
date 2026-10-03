/**
 * Pen burst appends through the real PDFium adapter (craft spec §5.3 items 8–9):
 * `appendInkPath` writes the new `/InkList` entry, our appearance of every path (from the
 * per-path outline cache), the outline's /Rect, `/PdfEditorInkWidths` and /M in one raw pass,
 * with no listing and no EmbedPDF update. Read back, rendered by our PDFium and pdf.js against
 * the same ink written whole, refused when the ink does not hold the expected paths, routed
 * through EmbedPDF's blended appearance for a Multiply ink, and applied as an
 * `annotation.update` edit with an `inkAppend` hint (inverse from the hint, no listing).
 *
 * The `[p9]` lines are the numbers of docs/qa/ink-latency-baseline.md ("After P9"): one append
 * to a 64-path burst the old way (list + `updateAnnotation`) and the new way, and a clipped
 * re-render of a stroke's box against the full page.
 */
import type { EngineEdit, SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { makePdf, sid, wasmUrl } from '../../test/helpers';
import { checkAnnotationConformance } from '../annotations/conformance';
import { clearInkOutlineCache, INK_WIDTHS_KEY, inkAppearance } from '../annotations/ink-appearance';
import { applyEngineEditWithResult } from '../edits/apply';
import { serializeAnnotation } from '../edits/payloads';
import type { InkAnnotation, NewAnnotation, OpenedDocument } from '../types';
import { createHostedEngine, type HostedEngine } from './host';
import { annotationAppearance, annotationString } from './host/annot-appearance';
import { type Rendered, renderPdfium, renderPdfjs } from './ink-width-probe';
import { PdfLibAssembler } from '../pdflib/pdflib-assembler';
import { createPdfiumProxy } from '../worker/pdfium-proxy';
import { PdfiumAdapter } from './pdfium-adapter';

let host: HostedEngine;
let adapter: PdfiumAdapter;
let counter = 0;
const ZERO = { x: 0, y: 0, width: 0, height: 0 };
const BLUE = '#1760EE';

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

async function open(): Promise<{ id: SourceId; opened: OpenedDocument }> {
  const bytes = await makePdf([{ size: [612, 792], text: 'Burst page', at: [72, 720] }]);
  const id = sid(`ink-append-${++counter}`);
  return { id, opened: await adapter.open(id, bytes) };
}

/** A handwriting-like stroke of `n` points from (x, y), widths 1–3 pt. */
function handStroke(x: number, y: number, n: number, seed: number) {
  const path: { x: number; y: number }[] = [];
  const widths: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1);
    path.push({
      x: x + t * 18 + Math.sin(t * 9 + seed) * 2.3,
      y: y + Math.cos(t * 7 + seed * 1.7) * 6.1,
    });
    widths.push(1 + ((i * 13 + seed) % 7) * 0.31);
  }
  return { path, widths };
}

function firstInk(stroke: ReturnType<typeof handStroke>, extra: Partial<NewAnnotation> = {}) {
  return {
    kind: 'ink',
    pageIndex: 0,
    rect: ZERO,
    paths: [stroke.path],
    widths: [stroke.widths],
    strokeWidth: 2,
    color: BLUE,
    ...extra,
  } as Extract<NewAnnotation, { kind: 'ink' }>;
}

/** `ink` with `stroke` appended, as the web's burst sends it. */
function plus(ink: InkAnnotation, stroke: ReturnType<typeof handStroke>): InkAnnotation {
  return {
    ...ink,
    paths: [...ink.paths, stroke.path],
    widths: [...(ink.widths ?? ink.paths.map((p) => p.map(() => ink.strokeWidth))), stroke.widths],
  };
}

async function listed(id: SourceId, nm: string): Promise<InkAnnotation> {
  const found = (await adapter.listAnnotations(id, 0)).find((a) => a.id === nm);
  expect(found?.kind).toBe('ink');
  return found as InkAnnotation;
}

function maxPixelDifference(a: Rendered, b: Rendered): number {
  expect(a.raster.width).toBe(b.raster.width);
  expect(a.raster.height).toBe(b.raster.height);
  let max = 0;
  for (let k = 0; k < a.raster.data.length; k++) {
    max = Math.max(max, Math.abs((a.raster.data[k] ?? 0) - (b.raster.data[k] ?? 0)));
  }
  return max;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

describe('appendInkPath', () => {
  test('writes the path, widths parallel to the paths, our appearance and /Rect', async () => {
    const { id } = await open();
    let ink = (await adapter.createAnnotation(
      id,
      firstInk(handStroke(100, 500, 30, 0)),
    )) as InkAnnotation;
    for (let k = 1; k <= 3; k++) {
      const next = plus(ink, handStroke(100 + k * 25, 500, 30, k));
      const written = await adapter.appendInkPath(id, next);
      expect(written?.paths).toHaveLength(k + 1);
      ink = written as InkAnnotation;
    }
    const back = await listed(id, ink.id);
    expect(back.paths).toHaveLength(4);
    expect(back.widths?.map((w) => w.length)).toEqual(back.paths.map((p) => p.length));
    expect(back.widths).toEqual(ink.widths);
    for (const [k, path] of back.paths.entries()) {
      for (const [i, p] of path.entries()) {
        expect(p.x).toBeCloseTo(ink.paths[k]?.[i]?.x ?? Number.NaN, 3);
        expect(p.y).toBeCloseTo(ink.paths[k]?.[i]?.y ?? Number.NaN, 3);
      }
    }
    const expected = inkAppearance(ink);
    const ap = await host.withRawAccess(id, (raw) => annotationAppearance(raw, 0, ink.id));
    expect(ap).toBe(expected?.content);
    expect(
      await host.withRawAccess(id, (raw) => annotationString(raw, 0, ink.id, INK_WIDTHS_KEY)),
    ).toBe(expected?.widths);
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(back.rect[key]).toBeCloseTo(expected?.rect[key] ?? Number.NaN, 2);
    }
    expect(back.color?.toUpperCase()).toBe(BLUE);
    expect(back.strokeWidth).toBe(2);
    const saved = await adapter.save(id);
    expect((await checkAnnotationConformance(saved.slice(0))).problems).toEqual([]);
    await adapter.close(id);
  });

  test('refuses, writing nothing, when the ink does not hold the paths it expects', async () => {
    const { id } = await open();
    const ink = (await adapter.createAnnotation(
      id,
      firstInk(handStroke(100, 500, 10, 0)),
    )) as InkAnnotation;
    const skipping = plus(plus(ink, handStroke(130, 500, 10, 1)), handStroke(160, 500, 10, 2));
    expect(await adapter.appendInkPath(id, skipping)).toBeUndefined();
    const back = await listed(id, ink.id);
    expect(back.paths).toHaveLength(1);
    expect(back.widths).toHaveLength(1);
    await adapter.close(id);
  });

  test('a Multiply ink is appended through the blended appearance and never gets ours', async () => {
    const { id } = await open();
    const ink = (await adapter.createAnnotation(
      id,
      firstInk(handStroke(100, 500, 10, 0), {
        color: '#FFEA00',
        strokeWidth: 12,
        blendMode: 'multiply',
      }),
    )) as InkAnnotation;
    expect(ink.blendMode).toBe('multiply');
    const written = await adapter.appendInkPath(id, plus(ink, handStroke(130, 500, 10, 1)));
    expect(written?.blendMode).toBe('multiply');
    expect(written?.widths).toBeUndefined();
    const back = await listed(id, ink.id);
    expect(back.paths).toHaveLength(2);
    expect(back.blendMode).toBe('multiply');
    expect(back.widths).toBeUndefined();
    expect(
      await host.withRawAccess(id, (raw) => annotationString(raw, 0, ink.id, INK_WIDTHS_KEY)),
    ).toBeUndefined();
    const ap = await host.withRawAccess(id, (raw) => annotationAppearance(raw, 0, ink.id));
    const ours = inkAppearance({ ...back, widths: back.paths.map((p) => p.map(() => 12)) });
    expect(ap).not.toBe(ours?.content);
    // EmbedPDF's blended appearance strokes the centre lines; ours would fill outlines.
    expect(ap).toMatch(/\bS\b/);
    const saved = new TextDecoder('latin1').decode(await adapter.save(id));
    expect(saved).toContain('/BM /Multiply');
    await adapter.close(id);
  });

  test('one burst renders as the same ink written whole, in PDFium and pdf.js', async () => {
    const strokes = Array.from({ length: 6 }, (_, k) => handStroke(90 + k * 22, 480, 40, k));
    const burst = await open();
    let ink = (await adapter.createAnnotation(
      burst.id,
      firstInk(strokes[0] as ReturnType<typeof handStroke>, { opacity: 0.7 }),
    )) as InkAnnotation;
    for (const stroke of strokes.slice(1)) {
      ink = (await adapter.appendInkPath(burst.id, plus(ink, stroke))) as InkAnnotation;
    }
    const whole = await open();
    await adapter.createAnnotation(whole.id, {
      ...firstInk(strokes[0] as ReturnType<typeof handStroke>, { opacity: 0.7 }),
      paths: strokes.map((s) => s.path),
      widths: strokes.map((s) => s.widths),
    });
    const a = await renderPdfium(adapter, burst.id, burst.opened, 0);
    const b = await renderPdfium(adapter, whole.id, whole.opened, 0);
    expect(maxPixelDifference(a, b)).toBeLessThanOrEqual(2);
    // The ink is drawn: the first stroke's start is tinted.
    const [px, py] = a.toPixel(strokes[0]?.path[0] ?? { x: 0, y: 0 });
    const k = (Math.round(py) * a.raster.width + Math.round(px)) * 4;
    expect(a.raster.data[k + 2]).toBeGreaterThan((a.raster.data[k] ?? 255) + 40);

    const jsA = (await renderPdfjs(await adapter.save(burst.id), [0])).pages.get(0);
    const jsB = (await renderPdfjs(await adapter.save(whole.id), [0])).pages.get(0);
    if (!jsA || !jsB) throw new Error('pdf.js rendered nothing');
    expect(maxPixelDifference(jsA, jsB)).toBeLessThanOrEqual(2);
    await adapter.close(burst.id);
    await adapter.close(whole.id);
  });
});

describe('annotation.update with inkAppend', () => {
  test('appends in place, records the plain update and inverts to the hint, unlisted', async () => {
    const { id } = await open();
    const ink = (await adapter.createAnnotation(
      id,
      firstInk(handStroke(100, 500, 10, 0)),
    )) as InkAnnotation;
    const next = plus(ink, handStroke(130, 500, 10, 1));
    const annotation = await serializeAnnotation(next);
    const before = await serializeAnnotation(ink);
    const edit: EngineEdit = {
      id: 'append-1',
      source: id,
      pageIndex: 0,
      kind: 'annotation.update',
      payload: { annotation, inkAppend: { before } },
    };
    const list = vi.spyOn(adapter, 'listAnnotations');
    const update = vi.spyOn(adapter, 'updateAnnotation');
    const result = await applyEngineEditWithResult(adapter, edit);
    expect(list).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    list.mockRestore();
    update.mockRestore();
    expect(result.applied.payload).toEqual({ annotation });
    expect(result.inverse.payload).toEqual({ annotation: before });
    expect((result.annotation as InkAnnotation).paths).toHaveLength(2);
    // Undo through the inverse: back to one path with its widths.
    await applyEngineEditWithResult(adapter, result.inverse);
    const undone = await listed(id, ink.id);
    expect(undone.paths).toHaveLength(1);
    expect(undone.widths).toEqual(ink.widths);
    // A replay of the recorded edit (no hint) is an ordinary update to the same state.
    await applyEngineEditWithResult(adapter, result.applied);
    expect((await listed(id, ink.id)).paths).toHaveLength(2);
    // A hint that does not hold (the ink already has two paths) falls back to the update.
    const stale: EngineEdit = { ...edit, id: 'append-2' };
    await applyEngineEditWithResult(adapter, stale);
    expect((await listed(id, ink.id)).paths).toHaveLength(2);
    await adapter.close(id);
  });
});

describe('appendInkPath in the PDFium worker', () => {
  test('appends through the proxy; a mismatch comes back as undefined', async () => {
    const worker = new Worker(new URL('../worker/pdfium.worker.ts', import.meta.url), {
      type: 'module',
      name: 'ink append test',
    });
    const proxy = createPdfiumProxy(worker, { wasmUrl, inspector: new PdfLibAssembler() });
    try {
      const id = sid('ink-append-worker');
      await proxy.open(
        id,
        await makePdf([{ size: [612, 792], text: 'Burst page', at: [72, 720] }]),
      );
      const ink = (await proxy.createAnnotation(
        id,
        firstInk(handStroke(100, 500, 12, 0)),
      )) as InkAnnotation;
      const next = plus(ink, handStroke(130, 500, 12, 1));
      const written = await proxy.appendInkPath(id, next);
      expect(written?.paths).toHaveLength(2);
      expect(written?.widths?.map((w) => w.length)).toEqual([12, 12]);
      expect(await proxy.appendInkPath(id, next)).toBeUndefined();
      const listed = (await proxy.listAnnotations(id, 0)).find((a) => a.id === ink.id);
      expect(listed?.kind === 'ink' ? listed.paths.length : 0).toBe(2);
      await proxy.close(id);
    } finally {
      proxy.dispose();
    }
  });
});

describe('[p9] costs', () => {
  test('[p9] one append to a 64-path burst: list + updateAnnotation vs appendInkPath', async () => {
    const strokes = Array.from({ length: 64 }, (_, k) =>
      handStroke(40 + (k % 16) * 33, 640 - Math.floor(k / 16) * 40, 100, k),
    );
    const run = async (append: (id: SourceId, next: InkAnnotation) => Promise<InkAnnotation>) => {
      clearInkOutlineCache();
      const { id } = await open();
      let ink = (await adapter.createAnnotation(
        id,
        firstInk(strokes[0] as ReturnType<typeof handStroke>),
      )) as InkAnnotation;
      const times: number[] = [];
      for (const stroke of strokes.slice(1)) {
        const next = plus(ink, stroke);
        const t0 = performance.now();
        ink = await append(id, next);
        times.push(performance.now() - t0);
      }
      expect(ink.paths).toHaveLength(64);
      const back = await listed(id, ink.id);
      expect(back.paths).toHaveLength(64);
      expect(back.widths).toHaveLength(64);
      await adapter.close(id);
      // The last ten appends (54 → 64 paths).
      return median(times.slice(-10));
    };
    const before = await run(async (id, next) => {
      // What one append cost before: the web's read, the edit's read for the inverse, the
      // update with its own find, our appearance of every path, and the re-read.
      await adapter.listAnnotations(id, 0);
      await adapter.listAnnotations(id, 0);
      return (await adapter.updateAnnotation(id, next)) as InkAnnotation;
    });
    const updateOnly = await run(
      async (id, next) => (await adapter.updateAnnotation(id, next)) as InkAnnotation,
    );
    const after = await run(
      async (id, next) => (await adapter.appendInkPath(id, next)) as InkAnnotation,
    );
    // eslint-disable-next-line no-console -- the [p9] numbers of docs/qa/ink-latency-baseline.md
    console.info(
      `[p9] append at 54–64 paths (100 points each), median: 2 lists + updateAnnotation ` +
        `${before.toFixed(1)} ms; updateAnnotation alone ${updateOnly.toFixed(1)} ms; ` +
        `appendInkPath ${after.toFixed(1)} ms`,
    );
    expect(after).toBeLessThan(updateOnly);
  });

  test('[p9] re-render of a stroke box (clip) vs the full page, scale 2', async () => {
    const { id } = await open();
    const stroke = handStroke(200, 400, 60, 3);
    const ink = (await adapter.createAnnotation(id, firstInk(stroke))) as InkAnnotation;
    const clip = {
      x: ink.rect.x - 2,
      y: ink.rect.y - 2,
      width: ink.rect.width + 4,
      height: ink.rect.height + 4,
    };
    const time = async (fn: () => Promise<{ bitmap: ImageBitmap }>) => {
      const samples: number[] = [];
      for (let r = 0; r < 9; r++) {
        const t0 = performance.now();
        const { bitmap } = await fn();
        samples.push(performance.now() - t0);
        bitmap.close();
      }
      return median(samples);
    };
    const full = await time(() => adapter.renderPage(id, 0, { scale: 2 }));
    const clipped = await time(() => adapter.renderPage(id, 0, { scale: 2, clip }));
    const box = await adapter.renderPage(id, 0, { scale: 2, clip });
    // eslint-disable-next-line no-console -- the [p9] numbers of docs/qa/ink-latency-baseline.md
    console.info(
      `[p9] page re-render at scale 2 (1224×1584 px): full ${full.toFixed(1)} ms; stroke box ` +
        `${box.width}×${box.height} px ${clipped.toFixed(1)} ms`,
    );
    box.bitmap.close();
    expect(clipped).toBeLessThan(full);
    await adapter.close(id);
  });
});
