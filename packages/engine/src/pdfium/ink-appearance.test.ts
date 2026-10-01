/**
 * Variable-width ink through the real PDFium adapter (ADR-0018, spec experience-redesign.md
 * §6.7 and §9): `createAnnotation` / `updateAnnotation` write our appearance, the outline's
 * /Rect and `/PdfEditorInkWidths` after EmbedPDF's write; `listAnnotations` reads the widths
 * back. Rendered with our PDFium and pdf.js, saved, reopened, flattened, assembled and
 * verified. The adapter runs on the hosted engine with `rawTask`, as in the PDFium worker.
 */
import type { SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { makePdf, sid, vdoc, vpage, wasmUrl } from '../../test/helpers';
import { checkAnnotationConformance } from '../annotations/conformance';
import { INK_WIDTHS_KEY, inkAppearance, storedInkWidths } from '../annotations/ink-appearance';
import { PdfLibAssembler } from '../pdflib/pdflib-assembler';
import type { InkAnnotation, NewAnnotation, OpenedDocument } from '../types';
import { createPdfiumProxy } from '../worker/pdfium-proxy';
import { createHostedEngine, type HostedEngine } from './host';
import { annotationAppearance, annotationString } from './host/annot-appearance';
import {
  centreColour,
  expectColour,
  expectConstant,
  expectVariable,
  formXObjects,
  type Rendered,
  renderPdfium,
  renderPdfjs,
  rgbOf,
  savedInk,
  shifted,
  type Taper,
  taperStroke,
  widthProfile,
} from './ink-width-probe';
import { PdfiumAdapter } from './pdfium-adapter';

let host: HostedEngine;
let adapter: PdfiumAdapter;
let counter = 0;
const ZERO = { x: 0, y: 0, width: 0, height: 0 };
const NOMINAL = 4;
const BLUE = '#1E5BD8';
const RED = '#E53935';
const GREEN = '#2E7D32';
const SIZE = { width: 612, height: 792 };

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
  const id = sid(`ink-appearance-${++counter}`);
  return { id, opened: await adapter.open(id, bytes.slice(0)) };
}

/** Page 1 upright, page 2 /Rotate 90. */
function twoPageDoc(): Promise<ArrayBuffer> {
  return makePdf([
    { size: [612, 792], text: 'Ink page 1 (upright)', at: [72, 720] },
    { size: [612, 792], text: 'Ink page 2 (/Rotate 90)', at: [72, 720], rotation: 90 },
  ]);
}

interface Stroke {
  readonly pageIndex: number;
  readonly taper: Taper;
  readonly color: string;
  readonly opacity: number;
}

const STROKES: readonly Stroke[] = [
  {
    pageIndex: 0,
    taper: { from: { x: 120, y: 500 }, to: { x: 420, y: 500 }, startWidth: 1, endWidth: 9 },
    color: BLUE,
    opacity: 1,
  },
  {
    pageIndex: 1,
    taper: { from: { x: 120, y: 400 }, to: { x: 420, y: 400 }, startWidth: 1, endWidth: 9 },
    color: RED,
    opacity: 0.6,
  },
];

function inkOf(stroke: Stroke): Extract<NewAnnotation, { kind: 'ink' }> {
  const { path, widths } = taperStroke(stroke.taper);
  return {
    kind: 'ink',
    pageIndex: stroke.pageIndex,
    rect: ZERO,
    paths: [path],
    widths: [widths],
    strokeWidth: NOMINAL,
    color: stroke.color,
    ...(stroke.opacity < 1 ? { opacity: stroke.opacity } : {}),
  };
}

async function create(id: SourceId, a: NewAnnotation): Promise<InkAnnotation> {
  const created = await adapter.createAnnotation(id, a);
  expect(created.kind).toBe('ink');
  return created as InkAnnotation;
}

async function listed(id: SourceId, pageIndex: number, nm: string): Promise<InkAnnotation> {
  const found = (await adapter.listAnnotations(id, pageIndex)).find((a) => a.id === nm);
  expect(found?.kind).toBe('ink');
  return found as InkAnnotation;
}

function rawAp(id: SourceId, pageIndex: number, nm: string): Promise<string> {
  return host.withRawAccess(id, (raw) => annotationAppearance(raw, pageIndex, nm));
}

function rawWidths(id: SourceId, pageIndex: number, nm: string): Promise<string | undefined> {
  return host.withRawAccess(id, (raw) => annotationString(raw, pageIndex, nm, INK_WIDTHS_KEY));
}

async function profile(
  id: SourceId,
  opened: OpenedDocument,
  stroke: Stroke,
  taper = stroke.taper,
  color = stroke.color,
) {
  const rendered = await renderPdfium(adapter, id, opened, stroke.pageIndex);
  return { rendered, samples: widthProfile(rendered, taper, rgbOf(color, stroke.opacity)) };
}

function expectRectNear(actual: InkAnnotation['rect'], expected: InkAnnotation['rect']): void {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(actual[key] - expected[key]), key).toBeLessThanOrEqual(0.01);
  }
}

describe('create', () => {
  test('writes our appearance, the outline /Rect and the widths; PDFium draws the variable width', async () => {
    const { id, opened } = await open(await twoPageDoc());
    for (const stroke of STROKES) {
      const ink = inkOf(stroke);
      const created = await create(id, ink);
      const write = inkAppearance(created);
      expect(created.widths).toEqual(storedInkWidths(ink.paths, ink.widths));
      expect(created.strokeWidth).toBe(NOMINAL);
      expect(write).toBeDefined();
      expectRectNear(created.rect, write?.rect ?? ZERO);
      expect(await rawAp(id, stroke.pageIndex, created.id)).toBe(write?.content);
      expect(await rawWidths(id, stroke.pageIndex, created.id)).toBe(write?.widths);

      const { rendered, samples } = await profile(id, opened, stroke);
      expectVariable(samples, `page ${stroke.pageIndex + 1}`);
      expectColour(
        centreColour(rendered, stroke.taper, 0.9),
        rgbOf(stroke.color, stroke.opacity),
        `colour page ${stroke.pageIndex + 1}`,
      );
      // Listing and rendering again do not regenerate it.
      expect((await listed(id, stroke.pageIndex, created.id)).widths).toEqual(created.widths);
      await renderPdfium(adapter, id, opened, stroke.pageIndex);
      expect(await rawAp(id, stroke.pageIndex, created.id)).toBe(write?.content);
    }
    await adapter.close(id);
  });

  test('ink without widths keeps EmbedPDF’s constant-width appearance and no key', async () => {
    const { id, opened } = await open(await twoPageDoc());
    const stroke = STROKES[0] as Stroke;
    const { widths: _none, ...plain } = inkOf(stroke);
    const created = await create(id, plain);
    expect(created.widths).toBeUndefined();
    expect(await rawWidths(id, 0, created.id)).toBeUndefined();
    expectConstant((await profile(id, opened, stroke)).samples, NOMINAL, 'no widths');
    await adapter.close(id);
  });
});

describe('update', () => {
  test('a recolour, an opacity change and a move regenerate the variable width', async () => {
    const { id, opened } = await open(await twoPageDoc());
    const stroke = STROKES[0] as Stroke;
    const created = await create(id, inkOf(stroke));

    const recoloured = (await adapter.updateAnnotation(id, {
      ...(await listed(id, 0, created.id)),
      color: GREEN,
    })) as InkAnnotation;
    expect(recoloured.color).toBe(GREEN);
    expect(recoloured.widths).toEqual(created.widths);
    expect(await rawAp(id, 0, created.id)).toBe(inkAppearance(recoloured)?.content);
    const green = await profile(id, opened, stroke, stroke.taper, GREEN);
    expectVariable(green.samples, 'recoloured');
    expectColour(centreColour(green.rendered, stroke.taper, 0.9), rgbOf(GREEN), 'green');

    // Opacity below 1: the /GS our content selects comes from the new /CA.
    const faded = (await adapter.updateAnnotation(id, {
      ...recoloured,
      opacity: 0.5,
    })) as InkAnnotation;
    expect(faded.opacity).toBe(0.5);
    const half = widthProfile(
      await renderPdfium(adapter, id, opened, 0),
      stroke.taper,
      rgbOf(GREEN, 0.5),
    );
    expectVariable(half, 'opacity 0.5');

    // A move of the box: the paths follow it and the appearance is rebuilt there.
    const moved = (await adapter.updateAnnotation(id, {
      ...faded,
      rect: { ...faded.rect, y: faded.rect.y - 40 },
    })) as InkAnnotation;
    expect(moved.paths[0]?.[0]?.y).toBeCloseTo(stroke.taper.from.y - 40, 2);
    expect(moved.widths).toEqual(created.widths);
    const below = shifted(stroke.taper, 0, -40);
    expectVariable(
      widthProfile(await renderPdfium(adapter, id, opened, 0), below, rgbOf(GREEN, 0.5)),
      'moved',
    );
    // Nothing is left at the old place.
    expect(
      widthProfile(await renderPdfium(adapter, id, opened, 0), stroke.taper, rgbOf(GREEN, 0.5))
        .map((s) => s.width)
        .every((w) => w < 0.2),
    ).toBe(true);

    // EmbedPDF writes the data only (no regenerated appearance): one replaced stream per
    // update, plus EmbedPDF's appearance from the create.
    const saved = await adapter.save(id);
    expect(await formXObjects(saved)).toEqual({ forms: 5, unreachable: 4 });
    const report = await checkAnnotationConformance(saved.slice(0));
    expect(report.problems).toEqual([]);
    await adapter.close(id);
  });

  test('an eraser split keeps the width of the remaining path; mismatched widths are dropped', async () => {
    const { id, opened } = await open(await twoPageDoc());
    const stroke = STROKES[0] as Stroke;
    const lower = shifted(stroke.taper, 0, -60);
    const a = taperStroke(stroke.taper);
    const b = taperStroke(lower);
    const created = await create(id, {
      kind: 'ink',
      pageIndex: 0,
      rect: ZERO,
      paths: [a.path, b.path],
      widths: [a.widths, b.widths],
      strokeWidth: NOMINAL,
      color: BLUE,
    });
    expect(created.widths).toHaveLength(2);

    // The eraser removes the first path (and its widths).
    const before = await listed(id, 0, created.id);
    const split = (await adapter.updateAnnotation(id, {
      ...before,
      paths: before.paths.slice(1),
      widths: before.widths?.slice(1) ?? [],
    })) as InkAnnotation;
    expect(split.paths).toHaveLength(1);
    expect(split.widths).toEqual(before.widths?.slice(1));
    let rendered = await renderPdfium(adapter, id, opened, 0);
    expectVariable(widthProfile(rendered, lower, rgbOf(BLUE)), 'remaining path');
    expect(widthProfile(rendered, stroke.taper, rgbOf(BLUE)).every((s) => s.width < 0.2)).toBe(
      true,
    );

    // Widths that do not match the paths (one point short): constant width, key emptied.
    const mismatched = (await adapter.updateAnnotation(id, {
      ...split,
      widths: [(split.widths?.[0] ?? []).slice(1)],
    })) as InkAnnotation;
    expect(mismatched.widths).toBeUndefined();
    expect(await rawWidths(id, 0, created.id)).toBe('');
    rendered = await renderPdfium(adapter, id, opened, 0);
    expectConstant(widthProfile(rendered, lower, rgbOf(BLUE)), NOMINAL, 'mismatched');

    // Widths again: variable again.
    const again = (await adapter.updateAnnotation(id, {
      ...mismatched,
      widths: [b.widths],
    })) as InkAnnotation;
    expect(again.widths).toEqual(storedInkWidths(again.paths, [b.widths]));
    rendered = await renderPdfium(adapter, id, opened, 0);
    expectVariable(widthProfile(rendered, lower, rgbOf(BLUE)), 'widths restored');

    // An update without widths makes it constant width.
    const { widths: _dropped, ...plain } = again;
    const constant = (await adapter.updateAnnotation(id, plain)) as InkAnnotation;
    expect(constant.widths).toBeUndefined();
    expect((await listed(id, 0, created.id)).widths).toBeUndefined();
    rendered = await renderPdfium(adapter, id, opened, 0);
    expectConstant(widthProfile(rendered, lower, rgbOf(BLUE)), NOMINAL, 'widths removed');
    await adapter.close(id);
  });
});

/** Creates the two strokes; returns their ids and appearance content. */
async function writeStrokes(id: SourceId): Promise<{ nm: string; content: string }[]> {
  const out: { nm: string; content: string }[] = [];
  for (const stroke of STROKES) {
    const created = await create(id, inkOf(stroke));
    out.push({ nm: created.id, content: inkAppearance(created)?.content ?? '' });
  }
  return out;
}

describe('save, reopen, flatten, export', () => {
  test('save → pdf.js draws it; reopen → widths listed, stream unchanged, a later move regenerates', async () => {
    const { id } = await open(await twoPageDoc());
    const inks = await writeStrokes(id);
    const saved = await adapter.save(id);
    await adapter.close(id);
    expect((await checkAnnotationConformance(saved.slice(0))).problems).toEqual([]);

    const js = await renderPdfjs(saved, [0, 1]);
    for (const [index, stroke] of STROKES.entries()) {
      const nm = inks[index]?.nm ?? '';
      const file = await savedInk(saved, stroke.pageIndex, nm);
      expect(file.keys).toContain(`/${INK_WIDTHS_KEY}`);
      expect(file.bsWidth).toBe(NOMINAL);
      expect(file.apBBox).toEqual(file.rect);
      if (stroke.opacity < 1) expect(file.apExtGStateCA).toBeCloseTo(stroke.opacity, 2);
      const rendered = js.pages.get(stroke.pageIndex) as Rendered;
      const colour = rgbOf(stroke.color, stroke.opacity);
      expectVariable(widthProfile(rendered, stroke.taper, colour), `pdf.js ${index}`);
      expectColour(centreColour(rendered, stroke.taper, 0.9), colour, `pdf.js colour ${index}`);
      const jsInk = js.annotations.get(stroke.pageIndex)?.find((a) => a.subtype === 'Ink');
      expect(jsInk?.borderStyle?.width).toBe(NOMINAL);
    }

    // A later session.
    const reopened = await open(saved);
    for (const [index, stroke] of STROKES.entries()) {
      const { nm = '', content = '' } = inks[index] ?? {};
      expect(await rawAp(reopened.id, stroke.pageIndex, nm)).toBe(content);
      const ink = await listed(reopened.id, stroke.pageIndex, nm);
      const { path, widths } = taperStroke(stroke.taper);
      expect(ink.widths).toEqual(storedInkWidths([path], [widths]));
      expectVariable((await profile(reopened.id, reopened.opened, stroke)).samples, 'reopened');
      const moved = ink.paths.map((p) => p.map((q) => ({ x: q.x, y: q.y - 20 })));
      await adapter.updateAnnotation(reopened.id, { ...ink, paths: moved });
      expectVariable(
        (
          await profile(
            reopened.id,
            reopened.opened,
            stroke,
            shifted(stroke.taper, 0, -20),
            stroke.color,
          )
        ).samples,
        `moved in a later session, page ${stroke.pageIndex + 1}`,
      );
    }
    await adapter.close(reopened.id);
  });

  test('flatten bakes the outline into the page (both renderers); verification passes', async () => {
    const { id } = await open(await twoPageDoc());
    await writeStrokes(id);
    const flat = await adapter.save(id, { flattenAnnotations: true });
    await adapter.close(id);
    expect(
      await adapter.verify(flat.slice(0), {
        pageCount: 2,
        pageSizes: [SIZE, SIZE],
        rotations: [0, 90],
        annotationCounts: { 0: 0, 1: 0 },
      }),
    ).toEqual({ ok: true, problems: [] });
    const reopened = await open(flat);
    const js = await renderPdfjs(flat, [0, 1]);
    for (const stroke of STROKES) {
      const colour = rgbOf(stroke.color, stroke.opacity);
      expectVariable(
        (await profile(reopened.id, reopened.opened, stroke)).samples,
        `flattened PDFium ${stroke.pageIndex + 1}`,
      );
      expectVariable(
        widthProfile(js.pages.get(stroke.pageIndex) as Rendered, stroke.taper, colour),
        `flattened pdf.js ${stroke.pageIndex + 1}`,
      );
    }
    await adapter.close(reopened.id);
  });

  test('export: assembly keeps the stream, verification passes, replaced streams are collected', async () => {
    const { id } = await open(await twoPageDoc());
    const inks = await writeStrokes(id);
    // Three recolours of the first stroke: each leaves the previous stream in save().
    const first = STROKES[0] as Stroke;
    const nm = inks[0]?.nm ?? '';
    let content = '';
    for (const color of [GREEN, RED, first.color]) {
      const updated = (await adapter.updateAnnotation(id, {
        ...(await listed(id, 0, nm)),
        color,
      })) as InkAnnotation;
      content = inkAppearance(updated)?.content ?? '';
    }
    expect(content).toBe(inks[0]?.content);
    const saved = await adapter.save(id);
    await adapter.close(id);
    expect((await formXObjects(saved)).unreachable).toBeGreaterThan(0);

    const source = sid('ink-export-source');
    const assembled = await new PdfLibAssembler().assemble({
      document: vdoc([
        vpage({ kind: 'source', source, index: 0 }),
        vpage({ kind: 'source', source, index: 1 }),
      ]),
      sources: new Map([[source, saved]]),
      blobs: new Map(),
    });
    expect(await formXObjects(assembled.bytes.slice(0))).toEqual({ forms: 2, unreachable: 0 });
    expect(
      await adapter.verify(assembled.bytes.slice(0), {
        pageCount: 2,
        pageSizes: [SIZE, SIZE],
        rotations: [0, 90],
        annotationCounts: { 0: 1, 1: 1 },
        checkAnnotations: true,
        annotationIds: inks.map((i) => i.nm),
      }),
    ).toEqual({ ok: true, problems: [] });

    const exported = await open(assembled.bytes);
    for (const [index, stroke] of STROKES.entries()) {
      const ink = inks[index] ?? { nm: '', content: '' };
      expect(await rawAp(exported.id, stroke.pageIndex, ink.nm)).toBe(ink.content);
      expect((await listed(exported.id, stroke.pageIndex, ink.nm)).widths).toHaveLength(1);
      expectVariable(
        (await profile(exported.id, exported.opened, stroke)).samples,
        `exported page ${stroke.pageIndex + 1}`,
      );
    }
    await adapter.close(exported.id);
  });
});

describe('without raw access', () => {
  test('EmbedPDF alone: widths are neither written nor read (nominal width)', async () => {
    const plain = new PdfiumAdapter({ wasmUrl, engineFactory: () => host.engine });
    const id = sid(`ink-appearance-plain-${++counter}`);
    const opened = await plain.open(id, await twoPageDoc());
    const stroke = STROKES[0] as Stroke;
    const created = (await plain.createAnnotation(id, inkOf(stroke))) as InkAnnotation;
    expect(created.widths).toBeUndefined();
    expect(await rawWidths(id, 0, created.id)).toBeUndefined();
    const rendered = await renderPdfium(plain, id, opened, 0);
    expectConstant(widthProfile(rendered, stroke.taper, rgbOf(stroke.color)), NOMINAL, 'plain');
    await plain.close(id);
  });
});

describe('in the PDFium worker', () => {
  test('create and update under the source lock write the appearance; renders interleave', async () => {
    const worker = new Worker(new URL('../worker/pdfium.worker.ts', import.meta.url), {
      type: 'module',
      name: 'ink appearance test',
    });
    const proxy = createPdfiumProxy(worker, { wasmUrl, inspector: new PdfLibAssembler() });
    try {
      const id = sid('ink-worker');
      const opened = await proxy.open(id, await twoPageDoc());
      const [first, second] = STROKES as [Stroke, Stroke];
      // Renders and a listing in flight while the ink is written.
      const [created, , , other] = await Promise.all([
        proxy.createAnnotation(id, inkOf(first)),
        proxy.renderPage(id, 0, { scale: 1 }),
        proxy.listAnnotations(id, 0),
        proxy.createAnnotation(id, inkOf(second)),
        proxy.renderPage(id, 1, { scale: 1 }),
      ]);
      const ink = created as InkAnnotation;
      expect(ink.widths).toEqual(inkAppearance(ink)?.stored);
      expect((other as InkAnnotation).widths).toHaveLength(1);
      for (const stroke of STROKES) {
        const rendered = await renderPdfium(proxy, id, opened, stroke.pageIndex);
        const colour = rgbOf(stroke.color, stroke.opacity);
        expectVariable(widthProfile(rendered, stroke.taper, colour), `worker ${stroke.pageIndex}`);
      }
      const updated = (await proxy.updateAnnotation(id, { ...ink, color: GREEN })) as InkAnnotation;
      expect(updated.widths).toEqual(ink.widths);
      expectVariable(
        widthProfile(await renderPdfium(proxy, id, opened, 0), first.taper, rgbOf(GREEN)),
        'worker recolour',
      );
      const saved = await proxy.save(id);
      expect((await savedInk(saved, 0, ink.id)).widths).toBe(inkAppearance(updated)?.widths);
      await proxy.close(id);
    } finally {
      await proxy.destroy();
    }
  });
});
