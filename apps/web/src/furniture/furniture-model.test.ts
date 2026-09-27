import {
  createSequentialIdGenerator,
  createWorkspace,
  addSource,
  type DocumentId,
  getDocument,
  type OverlayOp,
} from '@pdf-editor/document-model';
import { overlayText } from '@pdf-editor/engine/overlay-geometry';
import { describe, expect, it } from 'vitest';

import {
  applyBatesRun,
  applyFurniture,
  batesOverlay,
  clampRotation,
  defaultBates,
  defaultHeaderFooter,
  defaultPageNumbers,
  defaultWatermark,
  firstPosition,
  furnitureOf,
  headerFooterOverlays,
  hexToRgb,
  offsetFor,
  pageNumberOverlay,
  planBatesRun,
  presetOf,
  presetTemplate,
  rangeFromModel,
  rangeToModel,
  readHeaderFooter,
  readPageNumbers,
  readWatermark,
  removeFurniture,
  replaceFurniture,
  rgbToHex,
  watermarkOverlay,
} from './furniture-model';

function workspace(...counts: number[]) {
  const ids = createSequentialIdGenerator();
  let ws = createWorkspace();
  for (const [i, count] of counts.entries()) {
    ws = addSource(
      ws,
      {
        name: `doc${i}.pdf`,
        byteLength: 100,
        pageCount: count,
        pages: Array.from({ length: count }, () => ({
          size: { width: 600, height: 800 },
          rotation: 0 as const,
        })),
        fingerprint: `fp${i}`,
        flags: {
          encrypted: false,
          repaired: false,
          hasAcroForm: false,
          hasXfa: false,
          hasSignatures: false,
          tagged: false,
          linearized: false,
        },
        metadata: { policy: 'inherit-first-source' },
        outline: [],
      },
      ids,
    ).workspace;
  }
  return { ws, docs: ws.documentOrder as DocumentId[] };
}

const expand = (template: string, index: number, count: number, extra: Partial<OverlayOp> = {}) =>
  overlayText(
    { template, ...extra },
    { index, count, label: String(index + 1), title: 'T', date: new Date(2026, 0, 2) },
  );

describe('page-number presets', () => {
  it('produce the four documented formats', () => {
    const pageOf = 'Page {page} of {pages}';
    expect(
      ['plain', 'page-of', 'slash', 'dashes'].map((p) =>
        expand(presetTemplate(p as 'plain', pageOf), 0, 10),
      ),
    ).toEqual(['1', 'Page 1 of 10', '1 / 10', '- 1 -']);
    expect(presetOf('- {page} -', pageOf)).toBe('dashes');
    expect(presetOf('Sayfa {page} / {pages}', 'Sayfa {page} / {pages}')).toBe('page-of');
    expect(presetOf('p. {page}', pageOf)).toBe('custom');
  });

  it('skip-first with the default start number keeps physical numbering', () => {
    const settings = {
      ...defaultPageNumbers(10),
      template: '{page} / {pages}',
      range: { mode: 'skip-first' as const, from: 1, to: 10 },
    };
    const overlay = pageNumberOverlay({ ...settings, startNumber: firstPosition(settings.range) });
    expect(overlay.pages).toEqual({ from: 2 });
    expect(expand(overlay.template, 1, 10, overlay)).toBe('2 / 10');
    // Numbering restarted at 1 on the second page: the cover does not count.
    const restarted = pageNumberOverlay({ ...settings, startNumber: 1 });
    expect(expand(restarted.template, 1, 10, restarted)).toBe('1 / 9');
  });

  it('round-trips settings through the overlay', () => {
    const settings = {
      ...defaultPageNumbers(12),
      anchor: 'top-right' as const,
      marginX: 40,
      marginY: 20,
      mirror: true,
      startNumber: 3,
      range: { mode: 'custom' as const, from: 3, to: 9 },
      style: {
        family: 'Noto Serif' as const,
        size: 11,
        bold: true,
        italic: true,
        color: '#336699',
        opacity: 0.5,
      },
    };
    const overlay = pageNumberOverlay(settings);
    expect(overlay.offset).toEqual({ x: -40, y: -20 });
    expect(overlay.font).toEqual({ family: 'Noto Serif', size: 11, weight: 700, italic: true });
    expect(readPageNumbers(overlay, 12)).toEqual(settings);
  });
});

describe('placement helpers', () => {
  it('offsets point inwards from the anchored edges', () => {
    expect(offsetFor('bottom-left', 10, 20)).toEqual({ x: 10, y: 20 });
    expect(offsetFor('top-right', 10, 20)).toEqual({ x: -10, y: -20 });
    expect(offsetFor('center', 10, 20)).toEqual({ x: 0, y: 0 });
    expect(offsetFor('middle-left', 10, 20)).toEqual({ x: 10, y: 0 });
  });

  it('maps page-range choices both ways', () => {
    for (const mode of ['all', 'skip-first', 'odd', 'even'] as const) {
      const choice = { mode, from: 1, to: 8 };
      expect(rangeFromModel(rangeToModel(choice), 8)).toEqual(choice);
    }
    expect(rangeToModel({ mode: 'custom', from: 5, to: 2 })).toEqual({ from: 5, to: 5 });
  });

  it('converts colours', () => {
    expect(hexToRgb('#ff8000')).toEqual({ r: 1, g: 128 / 255, b: 0 });
    expect(rgbToHex({ r: 1, g: 128 / 255, b: 0 })).toBe('#ff8000');
    expect(rgbToHex({ r: 255, g: 0, b: 16 })).toBe('#ff0010');
  });
});

describe('header and footer', () => {
  it('writes one overlay per filled slot and reads them back', () => {
    const settings = defaultHeaderFooter(4);
    const overlays = headerFooterOverlays(settings);
    expect(overlays.map((o) => [o.anchor, o.role])).toEqual([
      ['top-left', 'header'],
      ['top-right', 'header'],
      ['bottom-right', 'footer'],
    ]);
    expect(readHeaderFooter(overlays, 4)).toEqual(settings);
  });
});

describe('Bates', () => {
  it('plans one continuous counter across documents in order', () => {
    const run = planBatesRun(
      [
        { id: 'a' as DocumentId, pages: new Array(3) },
        { id: 'b' as DocumentId, pages: [] },
        { id: 'c' as DocumentId, pages: new Array(2) },
      ],
      { prefix: 'X', width: 4, start: 10, suffix: '' },
    );
    expect(run.map((e) => [e.documentId, e.first, e.last, e.config.start])).toEqual([
      ['a', 10, 12, 10],
      ['b', 13, 12, 13],
      ['c', 13, 14, 13],
    ]);
  });

  it('applies the run to every page and each document in one step', () => {
    const { ws, docs } = workspace(3, 2);
    const run = planBatesRun(
      docs.map((id) => getDocument(ws, id)),
      { ...defaultBates(), prefix: 'P', start: 1 },
    );
    const next = applyBatesRun(ws, run, batesOverlay(defaultBates()));
    expect(docs.map((id) => getDocument(next, id).bates?.start)).toEqual([1, 4]);
    expect(
      getDocument(next, docs[1] as DocumentId).pages.every((p) => p.overlays.length === 1),
    ).toBe(true);
    const removed = removeFurniture(next, docs[0] as DocumentId, 'bates');
    expect(getDocument(removed, docs[0] as DocumentId).bates).toBeUndefined();
    expect(furnitureOf(getDocument(removed, docs[0] as DocumentId), 'bates')).toEqual([]);
  });
});

describe('watermark and replacing furniture', () => {
  it('clamps rotation and reads settings back', () => {
    expect(clampRotation(120)).toBe(90);
    expect(clampRotation(-91)).toBe(-90);
    const settings = { ...defaultWatermark(3), tile: true, rotate: -30, layer: 'behind' as const };
    const overlay = watermarkOverlay(settings);
    expect(overlay && readWatermark(overlay, 3)).toEqual(settings);
    expect(watermarkOverlay({ ...settings, text: '  ' })).toBeUndefined();
    expect(watermarkOverlay({ ...settings, mode: 'image' })).toBeUndefined();
  });

  it('replaces only its own kind; watermarks go first', () => {
    const numbers = pageNumberOverlay(defaultPageNumbers(1));
    const mark = watermarkOverlay(defaultWatermark(1)) as OverlayOp;
    const plain: OverlayOp = { ...numbers, role: undefined as never };
    const start = [plain, numbers];
    expect(replaceFurniture(start, 'watermark', [mark])).toEqual([mark, plain, numbers]);
    expect(replaceFurniture(start, 'page-numbers', [])).toEqual([plain]);
    const { ws, docs } = workspace(2);
    const id = docs[0] as DocumentId;
    const once = applyFurniture(ws, id, 'page-numbers', [numbers]);
    const twice = applyFurniture(once, id, 'page-numbers', [{ ...numbers, template: 'x' }]);
    expect(
      getDocument(twice, id).pages[0]?.overlays.map((o) => (o.kind === 'text' ? o.template : '')),
    ).toEqual(['x']);
  });
});
