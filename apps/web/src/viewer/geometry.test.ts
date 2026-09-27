/**
 * Coordinate mapping, checked twice: against the formulas (all four rotations, CropBox
 * origin) and against the engine itself — a glyph box mapped to CSS must land on ink in
 * the page bitmap PDFium renders (rotated-pages.pdf at /Rotate 0/90/180/270, plus a model
 * rotation on top, and cropbox.pdf with an offset CropBox).
 */
import type { Rect, Rotation, SourceId } from '@pdf-editor/document-model';
import type { TextRun } from '@pdf-editor/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import cropboxUrl from '../../../../test/fixtures/cropbox.pdf?url';
import rotatedUrl from '../../../../test/fixtures/rotated-pages.pdf?url';
import { type EngineService, getEngineService } from '../engine/engine-service';
import {
  type Box,
  displayedSize,
  displayRectToUser,
  lineAngle,
  type PageFrame,
  userRectToCss,
} from './geometry';
import { layoutTextLines } from './text-model';

const A4 = { width: 595.28, height: 841.89 };

function frame(rotation: Rotation, extra: Partial<PageFrame> = {}): PageFrame {
  return { size: A4, originX: 0, originY: 0, rotation, scale: 1, ...extra };
}

describe('userRectToCss (formulas)', () => {
  // A 100 x 20 box whose lower-left corner is 72 pt from the left and 60 pt from the top.
  const rect: Rect = { x: 72, y: A4.height - 80, width: 100, height: 20 };

  it('maps without rotation: y flips, origin top-left', () => {
    expect(userRectToCss(frame(0), rect)).toEqual({ left: 72, top: 60, width: 100, height: 20 });
  });

  it('maps a quarter turn clockwise: the top edge goes to the right', () => {
    const box = userRectToCss(frame(90), rect);
    // 60 pt below the top edge becomes 60 pt left of the right edge.
    expect(displayedSize(frame(90)).width - (box.left + box.width)).toBeCloseTo(60);
    expect(box.top).toBeCloseTo(72);
    expect([box.width, box.height]).toEqual([20, 100]);
  });

  it('maps a half turn: everything mirrors in both axes', () => {
    const box = userRectToCss(frame(180), rect);
    expect(box.left).toBeCloseTo(A4.width - 172);
    expect(box.top).toBeCloseTo(A4.height - 80);
  });

  it('maps three quarter turns: the top edge goes to the left', () => {
    const box = userRectToCss(frame(270), rect);
    expect(box.left).toBeCloseTo(60);
    expect(box.top).toBeCloseTo(A4.width - 172);
    expect([box.width, box.height]).toEqual([20, 100]);
  });

  it('subtracts the CropBox origin and applies the scale', () => {
    const cropped = frame(0, {
      size: { width: 468, height: 576 },
      originX: 72,
      originY: 144,
      scale: 2,
    });
    const box = userRectToCss(cropped, { x: 100, y: 650, width: 50, height: 10 });
    expect(box).toEqual({ left: 56, top: 2 * (144 + 576 - 660), width: 100, height: 20 });
  });

  it('displayRectToUser inverts userRectToCss at every rotation', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const f = frame(rotation, { originX: 10, originY: 20 });
      const box = userRectToCss(f, rect);
      const back = displayRectToUser(f, box);
      expect(back.x).toBeCloseTo(rect.x + 0);
      expect(back.width).toBeCloseTo(rect.width);
      // The origin shifts the input once and the output once: round trip holds.
      const again = userRectToCss(f, back);
      expect(again.left).toBeCloseTo(box.left);
      expect(again.top).toBeCloseTo(box.top);
    }
  });

  it('reads a horizontal user-space line in the direction the page is turned', () => {
    const glyphs = [
      { rect: { x: 72, y: 700, width: 10, height: 12 } },
      { rect: { x: 150, y: 700, width: 10, height: 12 } },
    ];
    expect([0, 90, 180, 270].map((r) => lineAngle(frame(r as Rotation), glyphs))).toEqual([
      0, 90, 180, 270,
    ]);
    // Text drawn upward in user space (rotated content) on an unrotated page.
    const up = [
      { rect: { x: 72, y: 100, width: 12, height: 10 } },
      { rect: { x: 72, y: 300, width: 12, height: 10 } },
    ];
    expect(lineAngle(frame(0), up)).toBe(270);
  });
});

// ---------------------------------------------------------------------------
// Against PDFium's own rendering
// ---------------------------------------------------------------------------

async function openFixture(service: EngineService, url: string, name: string) {
  const bytes = await (await fetch(url)).arrayBuffer();
  const opened = await service.open(new File([bytes], name, { type: 'application/pdf' }));
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

/** Share of dark pixels inside `box` (CSS px at scale 1 = bitmap px). */
async function inkIn(
  service: EngineService,
  sourceId: SourceId,
  index: number,
  rotation: Rotation,
  box: Box,
): Promise<number> {
  const result = await service.renderPage({ sourceId, index, rotation, bucket: 1, priority: 3 });
  if (!result.ok) throw new Error(result.error.message);
  const { bitmap } = result.value;
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no 2d context');
  context.drawImage(bitmap, 0, 0);
  const x = Math.max(0, Math.floor(box.left));
  const y = Math.max(0, Math.floor(box.top));
  const w = Math.max(1, Math.min(bitmap.width - x, Math.ceil(box.width)));
  const h = Math.max(1, Math.min(bitmap.height - y, Math.ceil(box.height)));
  const data = context.getImageData(x, y, w, h).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i] ?? 255) + (data[i + 1] ?? 255) + (data[i + 2] ?? 255) < 300) dark++;
  }
  return dark / (w * h);
}

function findRun(runs: readonly TextRun[], text: string): TextRun {
  const run = runs.find((r) => r.text.includes(text));
  if (!run) throw new Error(`No run with "${text}" in ${runs.map((r) => r.text).join(' | ')}`);
  return run;
}

describe('glyph boxes land on the rendered glyphs', () => {
  const service = getEngineService();
  let rotated: SourceId;
  let cropbox: SourceId;
  let intrinsic: readonly Rotation[];

  beforeAll(async () => {
    const r = await openFixture(service, rotatedUrl, 'rotated-pages.pdf');
    rotated = r.id;
    intrinsic = r.document.pages.map((p) => p.rotation);
    cropbox = (await openFixture(service, cropboxUrl, 'cropbox.pdf')).id;
  }, 30_000);

  afterAll(async () => {
    await service.close(rotated);
    await service.close(cropbox);
  });

  for (const pageIndex of [0, 1, 2, 3]) {
    for (const extra of [0, 90] as const) {
      it(`rotated-pages page ${pageIndex + 1} (/Rotate ${pageIndex * 90}) with +${extra}°`, async () => {
        expect(intrinsic[pageIndex]).toBe(pageIndex * 90);
        const text = await service.getPageText(rotated, pageIndex);
        if (!text.ok) throw new Error(text.error.message);
        const marker = findRun(text.value, `ROTATE ${pageIndex * 90}`);
        // The marker is drawn at user (72, 760), 20 pt Helvetica.
        expect(marker.rect.x).toBeGreaterThan(70);
        expect(marker.rect.x).toBeLessThan(76);
        expect(marker.rect.y).toBeGreaterThan(754);
        expect(marker.rect.y).toBeLessThan(764);
        const total = (((intrinsic[pageIndex] ?? 0) + extra) % 360) as Rotation;
        const f: PageFrame = { size: A4, originX: 0, originY: 0, rotation: total, scale: 1 };
        const box = userRectToCss(f, marker.rect);
        // Ink under the mapped box, none in the same box shifted off the text.
        expect(await inkIn(service, rotated, pageIndex, extra, box)).toBeGreaterThan(0.12);
        const away = {
          ...box,
          left: box.left + (total % 180 === 0 ? 0 : box.width * 3),
          top: box.top + (total % 180 === 0 ? box.height * 3 : 0),
        };
        expect(await inkIn(service, rotated, pageIndex, extra, away)).toBeLessThan(0.02);
        // The text layer reads it in the displayed direction.
        const line = layoutTextLines([marker], f)[0];
        expect(line?.angle).toBe(total);
        expect(line?.length).toBeCloseTo(total % 180 === 0 ? box.width : box.height);
      });
    }
  }

  it('honours an offset CropBox (cropbox.pdf page 1)', async () => {
    const crop = service.pageCropBox(cropbox, 0);
    expect(crop).toMatchObject({ x: 72, y: 144 });
    const text = await service.getPageText(cropbox, 0);
    if (!text.ok) throw new Error(text.error.message);
    const visible = findRun(text.value, 'VISIBLE INSIDE');
    const f: PageFrame = {
      size: { width: 468, height: 576 },
      originX: crop?.x ?? 0,
      originY: crop?.y ?? 0,
      rotation: 0,
      scale: 1,
    };
    const box = userRectToCss(f, visible.rect);
    expect(box.left).toBeCloseTo(100 - 72, 0);
    expect(await inkIn(service, cropbox, 0, 0, box)).toBeGreaterThan(0.12);
  });
});
