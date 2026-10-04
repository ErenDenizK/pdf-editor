/**
 * Clipped repaints (craft spec §5.3 item 9): a change confined to a box re-renders only that
 * box, at each cached scale of the page, and composites it into the cached bitmap instead of
 * dropping it. Real ImageBitmaps (browser mode) with a mock adapter that paints the page in
 * the colour of its current content.
 */
import { type Rect, type Rotation, sourceId } from '@pdf-editor/document-model';
import type { OpenedDocument, RenderOptions } from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import {
  clippedRepaintBox,
  EngineService,
  MAX_CLIPPED_REPAINTS,
  RENDER_PRIORITY,
  type RendererLike,
} from './engine-service';

const PAGE = { width: 100, height: 200 };

interface Call {
  readonly index: number;
  readonly options: RenderOptions;
}

/** An adapter whose pages are one colour: `content.color` at the time of the render. */
function paintingRenderer(rotation: Rotation = 0) {
  const content = { color: '#ff0000' };
  const calls: Call[] = [];
  const document: OpenedDocument = {
    id: sourceId('unused'),
    pageCount: 1,
    pages: [{ size: PAGE, rotation }],
    fingerprint: 'f',
    flags: {} as OpenedDocument['flags'],
    metadata: {} as OpenedDocument['metadata'],
    outline: [],
  };
  const renderer: RendererLike = {
    open: () => Promise.resolve(document),
    close: () => Promise.resolve(),
    getPageText: () => Promise.resolve([]),
    renderPage: (_id, index, options) => {
      calls.push({ index, options });
      const odd = rotation === 90 || rotation === 270;
      const shown = odd ? { width: PAGE.height, height: PAGE.width } : PAGE;
      // The clip is unrotated user space; on an upright page its size is the box's.
      const w = options.clip ? options.clip.width : shown.width;
      const h = options.clip ? options.clip.height : shown.height;
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(w * options.scale)),
        Math.max(1, Math.round(h * options.scale)),
      );
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no canvas');
      ctx.fillStyle = content.color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const bitmap = canvas.transferToImageBitmap();
      return Promise.resolve({ bitmap, width: bitmap.width, height: bitmap.height });
    },
  };
  return { renderer, content, calls };
}

async function openService(rotation: Rotation = 0) {
  const painting = paintingRenderer(rotation);
  const service = new EngineService({ createRenderer: () => painting.renderer, timings: false });
  const opened = await service.open(new File([new Uint8Array([1])], 'a.pdf'));
  if (!opened.ok) throw new Error('open failed');
  return { service, id: opened.value.id, ...painting };
}

function pixel(bitmap: ImageBitmap, x: number, y: number): string {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(bitmap, 0, 0);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(x, y, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** A stroke box in user space: x 20–30, y 150–160 (near the top of a 200 pt page). */
const BOX: Rect = { x: 20, y: 150, width: 10, height: 10 };

describe('clippedRepaintBox', () => {
  const shape = { size: PAGE, rotation: 0 as Rotation, originX: 0, originY: 0 };

  it('covers the rect in whole pixels and renders exactly that box', () => {
    const box = clippedRepaintBox(
      shape,
      0,
      { x: 20.3, y: 150.2, width: 9.5, height: 9.5 },
      200,
      400,
    );
    expect(box).toMatchObject({ left: 40, top: 80, width: 20, height: 20 });
    expect(box?.clip).toEqual({ x: 20, y: 150, width: 10, height: 10 });
  });

  it('follows the view rotation and the CropBox origin', () => {
    const cropped = { ...shape, originX: 10, originY: 20 };
    // A 90° turn: the displayed page is 200 × 100 pt; user x runs down, user y right to left.
    const box = clippedRepaintBox(cropped, 90, { x: 30, y: 170, width: 10, height: 10 }, 400, 200);
    expect(box).toMatchObject({ left: 300, top: 40, width: 20, height: 20 });
    expect(box?.clip).toEqual({ x: 30, y: 170, width: 10, height: 10 });
  });

  it('uses the bitmap pixels per point on each axis (EmbedPDF rounds its size)', () => {
    const box = clippedRepaintBox(shape, 0, BOX, 151, 301);
    expect(box?.left).toBe(Math.floor((20 * 151) / 100));
    expect(box?.width).toBe(Math.ceil((30 * 151) / 100) - Math.floor((20 * 151) / 100));
  });

  it('is undefined for a rect off the page', () => {
    expect(clippedRepaintBox(shape, 0, { x: 300, y: 10, width: 5, height: 5 }, 200, 400)).toBe(
      undefined,
    );
  });
});

describe('EngineService clipped repaint', () => {
  it('re-renders only the box at the cached scale and composites it into the bitmap', async () => {
    const { service, id, content, calls } = await openService();
    const first = await service.renderPage({
      sourceId: id,
      index: 0,
      rotation: 0,
      bucket: 2,
      priority: RENDER_PRIORITY.page,
    });
    expect(first.ok).toBe(true);
    const revision = service.pageRevision(id, 0);

    content.color = '#0000ff';
    service.noteClippedChange(id, 0, BOX);
    service.invalidatePage(id, 0);
    // The revision moves at once; the old bitmap is not offered as the new one.
    expect(service.pageRevision(id, 0)).toBe(revision + 1);
    expect(service.peek(id, 0, 0, 2)).toBeUndefined();

    const after = await service.renderPage({
      sourceId: id,
      index: 0,
      rotation: 0,
      bucket: 2,
      priority: RENDER_PRIORITY.page,
    });
    if (!after.ok) throw new Error('render failed');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.options.clip).toEqual(BOX);
    expect(calls[1]?.options.scale).toBe(2);
    const { bitmap } = after.value;
    expect([bitmap.width, bitmap.height]).toEqual([200, 400]);
    // Inside the box (user y 150–160 is 80–100 px from the top at 2×): the new content.
    expect(pixel(bitmap, 50, 90)).toBe('#0000ff');
    // Outside: the old pixels, not rendered again.
    expect(pixel(bitmap, 150, 300)).toBe('#ff0000');
    expect(service.peek(id, 0, 0, 2)?.bitmap).toBe(bitmap);
  });

  it('two changes in a row both land; without a note the page renders again whole', async () => {
    const { service, id, content, calls } = await openService();
    const req = { sourceId: id, index: 0, rotation: 0 as Rotation, bucket: 1, priority: 3 };
    await service.renderPage(req);
    content.color = '#00ff00';
    service.requestClippedRepaint(id, 0, BOX);
    content.color = '#0000ff';
    service.requestClippedRepaint(id, 0, { x: 60, y: 20, width: 10, height: 10 });
    const done = await service.renderPage(req);
    if (!done.ok) throw new Error('render failed');
    expect(calls.map((c) => c.options.clip !== undefined)).toEqual([false, true, true]);
    // The first box was rendered after both changes, so it shows the newest content.
    expect(pixel(done.value.bitmap, 25, 45)).not.toBe('#ff0000');
    expect(pixel(done.value.bitmap, 65, 175)).toBe('#0000ff');
    expect(pixel(done.value.bitmap, 90, 100)).toBe('#ff0000');

    service.invalidatePage(id, 0);
    expect(service.peek(id, 0, 0, 1)).toBeUndefined();
    const whole = await service.renderPage(req);
    expect(calls.at(-1)?.options.clip).toBeUndefined();
    if (whole.ok) expect(pixel(whole.value.bitmap, 90, 100)).toBe('#0000ff');
  });

  it('patches the most recent scales only; the tiles the box touches render again', async () => {
    const { service, id, calls } = await openService();
    const scales = [0.5, 1, 1.5, 2, 2.5, 3];
    for (const bucket of scales) {
      await service.renderPage({ sourceId: id, index: 0, rotation: 0, bucket, priority: 3 });
    }
    const tile = (clip: Rect, name: string) =>
      service.renderPage({
        sourceId: id,
        index: 0,
        rotation: 0,
        bucket: 4,
        priority: 3,
        clip,
        tile: name,
      });
    await tile({ x: 0, y: 100, width: 50, height: 100 }, 't:0,0');
    await tile({ x: 50, y: 0, width: 50, height: 100 }, 't:1,1');
    const before = calls.length;
    service.requestClippedRepaint(id, 0, BOX);
    // Wait for every patch.
    for (const bucket of scales.slice(-MAX_CLIPPED_REPAINTS)) {
      await service.renderPage({ sourceId: id, index: 0, rotation: 0, bucket, priority: 3 });
    }
    const pieces = calls.slice(before);
    expect(pieces).toHaveLength(MAX_CLIPPED_REPAINTS);
    expect(pieces.every((c) => c.options.clip !== undefined)).toBe(true);
    expect(pieces.map((c) => c.options.scale).sort()).toEqual(scales.slice(-MAX_CLIPPED_REPAINTS));
    // The oldest scales were dropped; the untouched tile is still cached, the touched one not.
    expect(service.peek(id, 0, 0, 0.5)).toBeUndefined();
    expect(service.cacheStats.entries).toBe(MAX_CLIPPED_REPAINTS + 1);
  });

  // Review F5: a bitmap still being patched was offered by `preview()`, and PageCanvas drew
  // it as the new revision, so the dry ink layer dropped the new stroke a frame too early.
  it('preview() does not offer a bitmap that is still being repainted', async () => {
    const { service, id, content } = await openService();
    const req = { sourceId: id, index: 0, rotation: 0 as Rotation, bucket: 2, priority: 3 };
    const first = await service.renderPage(req);
    if (!first.ok) throw new Error('render failed');
    expect(first.value.revision).toBe(service.pageRevision(id, 0));
    content.color = '#0000ff';
    service.noteClippedChange(id, 0, BOX);
    service.invalidatePage(id, 0);
    expect(service.peek(id, 0, 0, 2)).toBeUndefined();
    expect(service.preview(id, 0, 0, 2)).toBeUndefined();
    // Once patched, both offer it, with the new content in the box.
    const after = await service.renderPage(req);
    if (!after.ok) throw new Error('render failed');
    const preview = service.preview(id, 0, 0, 2);
    expect(preview?.bitmap).toBe(after.value.bitmap);
    if (preview) expect(pixel(preview.bitmap, 50, 90)).toBe('#0000ff');
  });

  it('every bitmap carries the revision whose content it shows', async () => {
    const { service, id, content } = await openService();
    const req = { sourceId: id, index: 0, rotation: 0 as Rotation, bucket: 1, priority: 3 };
    const first = await service.renderPage(req);
    if (!first.ok) throw new Error('render failed');
    const r0 = service.pageRevision(id, 0);
    expect(first.value.revision).toBe(r0);
    content.color = '#0000ff';
    service.requestClippedRepaint(id, 0, BOX);
    const r1 = service.pageRevision(id, 0);
    expect(r1).toBe(r0 + 1);
    // Whatever is offered during the repaint is never labelled newer than its content.
    for (const offered of [service.peek(id, 0, 0, 1), service.preview(id, 0, 0, 1)]) {
      if (offered) expect(offered.revision).toBe(r0);
    }
    const patched = await service.renderPage(req);
    if (!patched.ok) throw new Error('render failed');
    expect(patched.value.revision).toBe(r1);
    expect(pixel(patched.value.bitmap, 25, 45)).toBe('#0000ff');
    expect(service.peek(id, 0, 0, 1)?.revision).toBe(r1);

    // A change that misses the page leaves the pixels as they are: they show the new revision.
    service.requestClippedRepaint(id, 0, { x: 300, y: 10, width: 5, height: 5 });
    const r2 = service.pageRevision(id, 0);
    const kept = await service.renderPage(req);
    if (!kept.ok) throw new Error('render failed');
    expect(kept.value.bitmap).toBe(patched.value.bitmap);
    expect(kept.value.revision).toBe(r2);

    // A whole render after a full invalidation carries the revision it was rendered under.
    service.invalidatePage(id, 0);
    const whole = await service.renderPage(req);
    if (!whole.ok) throw new Error('render failed');
    expect(whole.value.revision).toBe(service.pageRevision(id, 0));
    expect(whole.value.revision).toBe(r2 + 1);
  });
});
