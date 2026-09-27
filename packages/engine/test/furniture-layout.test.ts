import fontkit from '@cantoo/fontkit';
import type { OverlayOp, TextOverlay } from '@pdf-editor/document-model';
import { describe, expect, test } from 'vitest';

import { bundledFontUrl } from '../src/fonts/bundled-fonts';
import { BUNDLED_FACES, resolveFont, substituteFont } from '../src/fonts/font-catalog';
import {
  effectiveAnchor,
  formatBates,
  formatOverlayDate,
  layoutOverlay,
  overlayBoxes,
  overlayNumbers,
  overlayText,
  pageInRange,
} from '../src/pdflib/overlay-layout';

const text: TextOverlay = {
  kind: 'text',
  layer: 'over',
  template: '{page}',
  anchor: 'bottom-right',
  offset: { x: -36, y: 36 },
  font: { family: 'Inter', size: 10 },
  color: { r: 0, g: 0, b: 0 },
  opacity: 1,
};

const ctx = {
  label: 'iv',
  title: 'Report',
  date: new Date(2026, 8, 27),
  locale: 'en-US',
};

describe('page ranges and numbering', () => {
  test('pageInRange honours from, to and parity (1-based positions)', () => {
    const pick = (range: Parameters<typeof pageInRange>[0]) =>
      Array.from({ length: 6 }, (_, i) => i).filter((i) => pageInRange(range, i, 6));
    expect(pick(undefined)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pick({ from: 2 })).toEqual([1, 2, 3, 4, 5]);
    expect(pick({ from: 2, to: 4 })).toEqual([1, 2, 3]);
    expect(pick({ parity: 'odd' })).toEqual([0, 2, 4]);
    expect(pick({ parity: 'even', from: 3 })).toEqual([3, 5]);
    expect(pageInRange(undefined, 6, 6)).toBe(false);
  });

  test('startNumber numbers the pages in range; {pages} is the last number shown', () => {
    expect(overlayNumbers({}, 3, 10)).toEqual({ page: 4, pages: 10 });
    const skipCover = { pages: { from: 2 }, startNumber: 1 };
    expect(overlayNumbers(skipCover, 1, 10)).toEqual({ page: 1, pages: 9 });
    expect(overlayNumbers(skipCover, 9, 10)).toEqual({ page: 9, pages: 9 });
    expect(overlayNumbers({ startNumber: 5 }, 0, 3)).toEqual({ page: 5, pages: 7 });
  });

  test('Bates numbers are zero padded and continue from start', () => {
    const bates = { prefix: 'ACME-', width: 6, start: 41, suffix: '-C' };
    expect(formatBates(bates, 0)).toBe('ACME-000041-C');
    expect(formatBates(bates, 2)).toBe('ACME-000043-C');
    expect(formatBates({ ...bates, width: 1, start: 12345 }, 0)).toBe('ACME-12345-C');
  });
});

describe('tokens', () => {
  test('every token expands; unknown tokens stay', () => {
    const out = overlayText(
      { template: '{title} · {label} · Page {page} of {pages} · {bates} · {nope}' },
      { ...ctx, index: 1, count: 3, bates: { prefix: 'B', width: 3, start: 7, suffix: '' } },
    );
    expect(out).toBe('Report · iv · Page 2 of 3 · B008 · {nope}');
  });

  test('{date} uses Intl.DateTimeFormat with the document locale', () => {
    const at = (template: string, locale: string) =>
      overlayText({ template }, { ...ctx, locale, index: 0, count: 1 });
    expect(at('{date:iso}', 'en-US')).toBe('2026-09-27');
    expect(at('{date}', 'en-US')).toBe(
      new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(ctx.date),
    );
    expect(at('{date:long}', 'tr')).toBe('27 Eylül 2026');
    expect(at('{date:weird}', 'en-US')).toBe('{date:weird}');
    expect(formatOverlayDate(ctx.date, 'short', 'not a locale!')).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(ctx.date),
    );
  });
});

describe('placement', () => {
  test('mirroring flips left/right anchors and the x offset on even pages only', () => {
    const mirrored = { ...text, mirror: true };
    expect(effectiveAnchor(mirrored, 0)).toEqual({
      anchor: 'bottom-right',
      offset: { x: -36, y: 36 },
    });
    expect(effectiveAnchor(mirrored, 1)).toEqual({
      anchor: 'bottom-left',
      offset: { x: 36, y: 36 },
    });
    expect(
      effectiveAnchor({ ...mirrored, anchor: 'top-center', offset: { x: 5, y: -20 } }, 1),
    ).toEqual({
      anchor: 'top-center',
      offset: { x: -5, y: -20 },
    });
    expect(effectiveAnchor(text, 1).anchor).toBe('bottom-right');
  });

  test('layoutOverlay anchors a cap-height box and skips pages out of range', () => {
    const page = { width: 600, height: 800 };
    const measure = { textWidth: (t: string) => t.length * 5, imageSize: () => undefined };
    const input = { index: 4, count: 10, page, text: ctx };
    const laid = layoutOverlay({ ...text, template: 'Page {page}' }, input, measure);
    const cap = resolveFont(text.font).capHeight * 10;
    expect(laid?.kind === 'text' && laid.text).toBe('Page 5');
    expect(laid?.boxes).toEqual([{ x: 600 - 30 - 36, y: 36, width: 30, height: cap, rotate: 0 }]);
    expect(layoutOverlay({ ...text, pages: { parity: 'even' } }, input, measure)).toBeUndefined();
    expect(layoutOverlay({ ...text, template: '{bates}' }, input, measure)).toBeUndefined();
  });

  test('rotated tiles cover the whole page, corners included', () => {
    const page = { width: 400, height: 300 };
    const content = { width: 120, height: 30 };
    const watermark: OverlayOp = {
      ...text,
      anchor: 'center',
      offset: { x: 0, y: 0 },
      rotate: 45,
      tile: { gapX: 20, gapY: 40 },
    };
    const boxes = overlayBoxes(watermark, 0, page, content);
    // The anchored copy is part of the grid.
    expect(boxes).toContainEqual({ x: 140, y: 135, width: 120, height: 30, rotate: 45 });
    // Every page corner is within reach (half a diagonal) of some tile centre.
    const reach = Math.hypot(120, 30) / 2 + Math.max(140, 70);
    for (const [cx, cy] of [
      [0, 0],
      [400, 0],
      [0, 300],
      [400, 300],
    ] as const) {
      const near = boxes.some(
        (b) => Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy) <= reach,
      );
      expect(near).toBe(true);
    }
  });
});

describe('font catalog', () => {
  test('families resolve to bundled faces with synthesis flags; others to standard fonts', () => {
    const inter = resolveFont({ family: 'Inter', size: 10, weight: 700, italic: true });
    expect(
      inter.kind === 'bundled' && [inter.face.key, inter.syntheticBold, inter.syntheticItalic],
    ).toEqual(['Inter-Bold', false, true]);
    const mono = resolveFont({ family: 'jetbrains-mono', size: 10, weight: 700 });
    expect(mono.kind === 'bundled' && [mono.face.key, mono.syntheticBold]).toEqual([
      'JetBrainsMono-Regular',
      true,
    ]);
    const times = resolveFont({ family: 'Times-Roman', size: 10 });
    expect(times.kind).toBe('standard');
    const sub = substituteFont({ family: 'Times-Roman', size: 10, weight: 700 });
    expect(sub.kind === 'bundled' && sub.face.key).toBe('NotoSerif-Bold');
  });

  test('cap heights in the catalog match the bundled files', async () => {
    for (const face of BUNDLED_FACES) {
      const bytes = new Uint8Array(await (await fetch(bundledFontUrl(face))).arrayBuffer());
      const font = fontkit.create(bytes) as unknown as { capHeight: number; unitsPerEm: number };
      expect(face.capHeight, face.key).toBeCloseTo(font.capHeight / font.unitsPerEm, 3);
    }
  });

  test('the bundled fonts together stay under 1.5 MB', async () => {
    let total = 0;
    for (const face of BUNDLED_FACES) {
      total += (await (await fetch(bundledFontUrl(face))).arrayBuffer()).byteLength;
    }
    expect(total).toBeLessThan(1.5 * 1024 * 1024);
  });
});
