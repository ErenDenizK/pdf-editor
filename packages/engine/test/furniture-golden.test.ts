/**
 * Golden tests for page furniture (document-tools spec §2, §9): every page-number preset
 * on the four rotations of rotated-pages.pdf and the offset CropBoxes of cropbox.pdf,
 * rendered through PDFium. The overlay's ink (render with minus render without) must sit
 * in the box the shared layout (overlay-layout.ts) predicts, and PDFium must extract the
 * text at that position. Also: Unicode through the bundled fonts, Bates continuity across
 * documents, page-range filters, and behind vs over.
 */
import fontkit from '@cantoo/fontkit';
import { PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import type { Anchor, OverlayOp, Rect, Rotation, TextOverlay } from '@pdf-editor/document-model';
import cropboxUrl from '../../../test/fixtures/cropbox.pdf?url';
import rotatedUrl from '../../../test/fixtures/rotated-pages.pdf?url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { loadBundledFont } from '../src/fonts/bundled-fonts';
import { resolveFont } from '../src/fonts/font-catalog';
import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import { displaySize, displayToUser } from '../src/pdflib/overlay-geometry';
import { layoutOverlay, type OverlayBox } from '../src/pdflib/overlay-layout';
import { PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import type { Glyph } from '../src/types';
import { bid, makePdf, sid, vdoc, vpage, wasmUrl } from './helpers';

const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();
const assembler = new PdfLibAssembler();
let adapter: PdfiumAdapter;
let opened = 0;

beforeAll(() => {
  adapter = new PdfiumAdapter({ wasmUrl });
});
afterAll(async () => {
  await adapter.destroy();
});

const R = sid('rotated');
const C = sid('cropbox');

/** Visible box (user space) and /Rotate of the fixture pages, from manifest.json. */
const PAGES: readonly { source: typeof R; index: number; box: Rect; rotation: Rotation }[] = [
  ...([0, 90, 180, 270] as const).map((rotation, index) => ({
    source: R,
    index,
    box: { x: 0, y: 0, width: 595.28, height: 841.89 },
    rotation,
  })),
  { source: C, index: 0, box: { x: 72, y: 144, width: 468, height: 576 }, rotation: 0 },
  { source: C, index: 1, box: { x: 150, y: 200, width: 300, height: 300 }, rotation: 0 },
];

const PRESETS: readonly { template: string; anchor: Anchor; offset: { x: number; y: number } }[] = [
  { template: '{page}', anchor: 'bottom-center', offset: { x: 0, y: 30 } },
  { template: 'Page {page} of {pages}', anchor: 'bottom-right', offset: { x: -30, y: 30 } },
  { template: '{page} / {pages}', anchor: 'top-right', offset: { x: -30, y: -30 } },
  { template: '- {page} -', anchor: 'top-left', offset: { x: 30, y: -30 } },
];

function numbers(preset: (typeof PRESETS)[number]): TextOverlay {
  return {
    kind: 'text',
    layer: 'over',
    ...preset,
    font: { family: 'Inter', size: 14 },
    color: { r: 0, g: 0, b: 0 },
    opacity: 1,
    role: 'page-number',
  };
}

const SCALE = 2;

interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

async function openBytes(bytes: ArrayBuffer): Promise<ReturnType<typeof sid>> {
  const id = sid(`out-${++opened}`);
  await adapter.open(id, bytes.slice(0));
  return id;
}

async function raster(id: ReturnType<typeof sid>, index: number): Promise<Raster> {
  const r = await adapter.renderPage(id, index, { scale: SCALE });
  const canvas = new OffscreenCanvas(r.width, r.height);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(r.bitmap, 0, 0);
  return { width: r.width, height: r.height, data: ctx.getImageData(0, 0, r.width, r.height).data };
}

/** Bounding box (display points, y up) of pixels that differ between two renders. */
function inkDiff(a: Raster, b: Raster): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      const d =
        Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) +
        Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) +
        Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
      if (d < 120) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x + 1);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y + 1);
    }
  }
  if (x0 === Infinity) return null;
  const H = a.height / SCALE;
  return { x0: x0 / SCALE, x1: x1 / SCALE, y0: H - y1 / SCALE, y1: H - y0 / SCALE };
}

function darkPixels(r: Raster, box: { x0: number; y0: number; x1: number; y1: number }): number {
  const H = r.height / SCALE;
  let n = 0;
  for (let y = Math.floor((H - box.y1) * SCALE); y < Math.ceil((H - box.y0) * SCALE); y++) {
    for (let x = Math.floor(box.x0 * SCALE); x < Math.ceil(box.x1 * SCALE); x++) {
      const i = (y * r.width + x) * 4;
      if ((r.data[i] ?? 255) < 96 && (r.data[i + 1] ?? 255) < 96 && (r.data[i + 2] ?? 255) < 96)
        n++;
    }
  }
  return n;
}

let measureFont: Awaited<ReturnType<PDFDocument['embedFont']>>;

beforeAll(async () => {
  const scratch = await PDFDocument.create();
  scratch.registerFontkit(fontkit);
  const face = resolveFont({ family: 'Inter', size: 1 });
  if (face.kind !== 'bundled') throw new Error('Inter is bundled');
  measureFont = await scratch.embedFont(await loadBundledFont(face.face), { subset: true });
});

/** The box the shared layout predicts for `overlay` on output page `index`. */
function expectedBox(overlay: OverlayOp, index: number, count: number): OverlayBox {
  const page = PAGES[index] as (typeof PAGES)[number];
  const laid = layoutOverlay(
    overlay,
    {
      index,
      count,
      page: displaySize(page.box, page.rotation),
      text: { label: String(index + 1), title: 'Test document', date: new Date() },
    },
    {
      textWidth: (t, o) => measureFont.widthOfTextAtSize(t, o.font.size),
      imageSize: () => undefined,
    },
  );
  const box = laid?.boxes[0];
  if (!box) throw new Error('overlay not laid out');
  return box;
}

/**
 * Glyphs of an occurrence of `text` (spaces ignored) on a page: the one closest to `near`
 * (user space) when given, else the first.
 */
function findText(
  glyphs: readonly Glyph[],
  text: string,
  near?: { x: number; y: number },
): Glyph[] | undefined {
  const inked = glyphs.filter((g) => g.text.trim() !== '');
  const target = text.replace(/\s+/g, '');
  const joined = inked.map((g) => g.text).join('');
  let best: Glyph[] | undefined;
  let bestDistance = Infinity;
  for (let at = joined.indexOf(target); at >= 0; at = joined.indexOf(target, at + 1)) {
    const found = inked.slice(at, at + target.length);
    if (!near) return found;
    const r = union(found.map((g) => g.rect));
    const d = Math.hypot(r.x + r.width / 2 - near.x, r.y + r.height / 2 - near.y);
    if (d < bestDistance) {
      best = found;
      bestDistance = d;
    }
  }
  return best;
}

function union(rects: readonly Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** A display-space box mapped to a user-space rectangle. */
function toUser(box: OverlayBox, page: (typeof PAGES)[number]): Rect {
  const corners = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ].map(([x, y]) => displayToUser({ x: x as number, y: y as number }, page.box, page.rotation));
  return union(corners.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })));
}

async function sources() {
  return new Map([
    [R, await fetchBytes(rotatedUrl)],
    [C, await fetchBytes(cropboxUrl)],
  ]);
}

describe('page-number presets at four rotations and with a CropBox offset', () => {
  let baseline: ReturnType<typeof sid>;
  let rasters: Raster[];

  beforeAll(async () => {
    const doc = vdoc(PAGES.map((p) => vpage({ kind: 'source', source: p.source, index: p.index })));
    const { bytes } = await assembler.assemble({
      document: doc,
      sources: await sources(),
      blobs: new Map(),
    });
    baseline = await openBytes(bytes);
    rasters = [];
    for (let i = 0; i < PAGES.length; i++) rasters.push(await raster(baseline, i));
  });

  for (const preset of PRESETS) {
    test(`"${preset.template}" at ${preset.anchor}`, async () => {
      const overlay = numbers(preset);
      const doc = vdoc(
        PAGES.map((p) =>
          vpage({ kind: 'source', source: p.source, index: p.index }, { overlays: [overlay] }),
        ),
      );
      const { bytes, report } = await assembler.assemble({
        document: doc,
        sources: await sources(),
        blobs: new Map(),
      });
      expect(report.warnings).toEqual([]);
      const id = await openBytes(bytes);
      for (let index = 0; index < PAGES.length; index++) {
        const page = PAGES[index] as (typeof PAGES)[number];
        const where = `page ${index + 1} (/Rotate ${page.rotation}, box ${page.box.x},${page.box.y})`;
        const box = expectedBox(overlay, index, PAGES.length);
        const size = overlay.font.size;
        // Ink lies in the predicted box: descenders below the baseline, a little overshoot.
        const ink = inkDiff(await raster(id, index), rasters[index] as Raster);
        expect(ink, where).not.toBeNull();
        if (!ink) continue;
        expect(ink.x0, where).toBeGreaterThanOrEqual(box.x - 1.5);
        expect(ink.x1, where).toBeLessThanOrEqual(box.x + box.width + 1.5);
        expect(ink.y0, where).toBeGreaterThanOrEqual(box.y - 0.3 * size);
        expect(ink.y1, where).toBeLessThanOrEqual(box.y + box.height + 0.15 * size);
        expect(ink.x1 - ink.x0, where).toBeGreaterThan(box.width * 0.7);
        expect(ink.y1 - ink.y0, where).toBeGreaterThan(box.height * 0.8);

        // PDFium extracts the expanded text at that position (user space).
        const text = preset.template
          .replace('{page}', String(index + 1))
          .replace('{pages}', String(PAGES.length));
        const glyphs = (await adapter.getPageText(id, index)).flatMap((run) => run.glyphs);
        const want = toUser(box, page);
        const found = findText(glyphs, text, {
          x: want.x + want.width / 2,
          y: want.y + want.height / 2,
        });
        expect(found, `${where}: "${text}"`).toBeDefined();
        const got = union((found ?? []).map((g) => g.rect));
        const cx = got.x + got.width / 2;
        const cy = got.y + got.height / 2;
        expect(cx, where).toBeGreaterThan(want.x - 2);
        expect(cx, where).toBeLessThan(want.x + want.width + 2);
        expect(cy, where).toBeGreaterThan(want.y - 0.3 * size);
        expect(cy, where).toBeLessThan(want.y + want.height + 0.3 * size);
      }
    });
  }
});

describe('bundled fonts', () => {
  test('Turkish, Cyrillic and Greek text survive embedding in every family', async () => {
    const samples = ['Doğruluk ğüşıöç İĞÜŞÖÇ', 'Привет, мир', 'Καλημέρα κόσμε'];
    const families = ['Inter', 'JetBrains Mono', 'Noto Serif'];
    const overlays: OverlayOp[] = families.flatMap((family, f) =>
      samples.map((template, s) => ({
        kind: 'text' as const,
        layer: 'over' as const,
        template,
        anchor: 'top-left' as const,
        offset: { x: 20, y: -30 - (f * samples.length + s) * 24 },
        font: {
          family,
          size: 12,
          weight: s === 1 ? (700 as const) : (400 as const),
          italic: s === 2,
        },
        color: { r: 0, g: 0, b: 0 },
        opacity: 1,
      })),
    );
    const src = await makePdf([{ size: [400, 400] }]);
    const doc = vdoc([vpage({ kind: 'source', source: sid('u'), index: 0 }, { overlays })]);
    const { bytes, report } = await assembler.assemble({
      document: doc,
      sources: new Map([[sid('u'), src]]),
      blobs: new Map(),
    });
    expect(report.warnings).toEqual([]);
    const out = await PDFDocument.load(bytes);
    const fonts = out.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    expect(fonts?.keys().length).toBe(overlays.length);
    const id = await openBytes(bytes);
    const glyphs = (await adapter.getPageText(id, 0)).flatMap((r) => r.glyphs);
    for (const sample of samples) {
      expect(findText(glyphs, sample), sample).toBeDefined();
    }
    // Embedded fonts are subsets: the file stays far below the size of the full fonts.
    expect(bytes.byteLength).toBeLessThan(200_000);
  });

  test('a standard-font overlay with non-WinAnsi text falls back to a bundled family', async () => {
    const src = await makePdf([{ size: [300, 200] }]);
    const overlay: OverlayOp = {
      kind: 'text',
      layer: 'over',
      template: 'Sayfa ğ {page}',
      anchor: 'center',
      offset: { x: 0, y: 0 },
      font: { family: 'Helvetica', size: 12 },
      color: { r: 0, g: 0, b: 0 },
      opacity: 1,
    };
    const { bytes, report } = await assembler.assemble({
      document: vdoc([
        vpage({ kind: 'source', source: sid('h'), index: 0 }, { overlays: [overlay] }),
      ]),
      sources: new Map([[sid('h'), src]]),
      blobs: new Map(),
    });
    expect(report.warnings.join(' ')).toMatch(/bundled font was embedded/);
    const id = await openBytes(bytes);
    const glyphs = (await adapter.getPageText(id, 0)).flatMap((r) => r.glyphs);
    expect(findText(glyphs, 'Sayfa ğ 1')).toBeDefined();
  });
});

function pageTexts(id: ReturnType<typeof sid>, count: number): Promise<string[]> {
  return Promise.all(
    Array.from({ length: count }, async (_, i) =>
      (await adapter.getPageText(id, i)).map((r) => r.text).join(' '),
    ),
  );
}

describe('tokens and filters', () => {
  test('Bates numbering continues across two documents', async () => {
    const a = await makePdf([{ size: [300, 300] }, { size: [300, 300] }, { size: [300, 300] }]);
    const b = await makePdf([{ size: [300, 300] }, { size: [300, 300] }]);
    const bates: OverlayOp = {
      kind: 'text',
      layer: 'over',
      template: '{bates}',
      anchor: 'bottom-right',
      offset: { x: -20, y: 20 },
      font: { family: 'JetBrains Mono', size: 10 },
      color: { r: 0, g: 0, b: 0 },
      opacity: 1,
      role: 'bates',
    };
    const config = { prefix: 'ACME', width: 6, suffix: '-C' };
    const run = async (source: ArrayBuffer, pages: number, start: number) => {
      const s = sid(`bates-${start}`);
      const doc = vdoc(
        Array.from({ length: pages }, (_, i) =>
          vpage({ kind: 'source', source: s, index: i }, { overlays: [bates] }),
        ),
        { bates: { ...config, start } },
      );
      const { bytes } = await assembler.assemble({
        document: doc,
        sources: new Map([[s, source]]),
        blobs: new Map(),
      });
      return pageTexts(await openBytes(bytes), pages);
    };
    // The app gives the second document the start that continues the first (3 pages).
    const first = await run(a, 3, 1);
    const second = await run(b, 2, 1 + 3);
    expect([...first, ...second].map((t) => t.trim())).toEqual([
      'ACME000001-C',
      'ACME000002-C',
      'ACME000003-C',
      'ACME000004-C',
      'ACME000005-C',
    ]);
  });

  test('page ranges, start number and mirroring', async () => {
    const s = sid('ranges');
    const src = await makePdf(
      Array.from({ length: 5 }, () => ({ size: [300, 300] as [number, number] })),
    );
    const skipCover: OverlayOp = {
      kind: 'text',
      layer: 'over',
      template: 'n{page}/{pages}',
      anchor: 'bottom-right',
      offset: { x: -20, y: 20 },
      font: { family: 'Inter', size: 10 },
      color: { r: 0, g: 0, b: 0 },
      opacity: 1,
      pages: { from: 2 },
      startNumber: 1,
      mirror: true,
    };
    const evenOnly: OverlayOp = {
      ...skipCover,
      template: 'even',
      pages: { parity: 'even' },
      anchor: 'top-center',
    };
    const doc = vdoc(
      Array.from({ length: 5 }, (_, i) =>
        vpage({ kind: 'source', source: s, index: i }, { overlays: [skipCover, evenOnly] }),
      ),
    );
    const { bytes } = await assembler.assemble({
      document: doc,
      sources: new Map([[s, src]]),
      blobs: new Map(),
    });
    const id = await openBytes(bytes);
    const texts = (await pageTexts(id, 5)).map((t) => t.replace(/\s+/g, ' ').trim());
    expect(texts).toEqual(['', 'n1/4 even', 'n2/4', 'n3/4 even', 'n4/4']);
    // Mirrored: page 2 (even) has its number at the bottom left, page 3 at the bottom right.
    const at = async (index: number) => {
      const glyphs = (await adapter.getPageText(id, index)).flatMap((r) => r.glyphs);
      return union((findText(glyphs, `n${index}/4`) ?? []).map((g) => g.rect));
    };
    expect((await at(1)).x).toBeLessThan(60);
    expect((await at(2)).x).toBeGreaterThan(200);
  });
});

/** A 1x1 white PNG. */
async function whitePng(): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 1, 1);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

describe('layers', () => {
  test('an opaque "over" overlay hides the page text; "behind" keeps it visible', async () => {
    const s = sid('layers');
    const src = await makePdf([{ size: [300, 200], text: 'VISIBLE MARKER', at: [40, 100] }]);
    const blob = bid('white');
    const blobs = new Map<string, ArrayBuffer>([[blob, await whitePng()]]);
    const cover = (layer: 'over' | 'behind'): OverlayOp => ({
      kind: 'image',
      layer,
      blob,
      anchor: 'center',
      offset: { x: 0, y: 0 },
      scale: 400,
      opacity: 1,
      role: 'watermark',
    });
    const marker = { x0: 40, y0: 98, x1: 180, y1: 115 };
    const render = async (layer: 'over' | 'behind') => {
      const doc = vdoc([
        vpage({ kind: 'source', source: s, index: 0 }, { overlays: [cover(layer)] }),
      ]);
      const { bytes } = await assembler.assemble({
        document: doc,
        sources: new Map([[s, src]]),
        blobs,
      });
      return raster(await openBytes(bytes), 0);
    };
    expect(darkPixels(await render('behind'), marker)).toBeGreaterThan(100);
    expect(darkPixels(await render('over'), marker)).toBe(0);
  });

  test('a tiled watermark is one Form XObject reused by every page', async () => {
    const s = sid('wm');
    const src = await makePdf([{ size: [300, 300] }, { size: [300, 300] }]);
    const watermark: OverlayOp = {
      kind: 'text',
      layer: 'behind',
      template: 'CONFIDENTIAL',
      anchor: 'center',
      offset: { x: 0, y: 0 },
      font: { family: 'Noto Serif', size: 24, weight: 700 },
      color: { r: 0.8, g: 0.1, b: 0.1 },
      opacity: 0.25,
      rotate: 45,
      tile: { gapX: 30, gapY: 60 },
      role: 'watermark',
    };
    const doc = vdoc(
      [0, 1].map((i) => vpage({ kind: 'source', source: s, index: i }, { overlays: [watermark] })),
    );
    const { bytes } = await assembler.assemble({
      document: doc,
      sources: new Map([[s, src]]),
      blobs: new Map(),
    });
    const out = await PDFDocument.load(bytes);
    const refs = out.getPages().map((page) => {
      const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
      const keys = xobjects?.keys() ?? [];
      expect(keys.length).toBe(1);
      return xobjects?.get(keys[0] as PDFName)?.toString();
    });
    expect(refs[0]).toBeDefined();
    expect(refs[1]).toBe(refs[0]);
  });
});
