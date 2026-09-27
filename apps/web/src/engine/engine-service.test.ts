import { type Rotation, type SourceId, sourceId } from '@pdf-editor/document-model';
import { EngineError, type OpenedDocument, type RenderOptions } from '@pdf-editor/engine';
import { describe, expect, it, vi } from 'vitest';

import { BitmapCache, bitmapBytes, bitmapKey, pageKey } from './bitmap-cache';
import {
  chooseBucket,
  EngineService,
  MAX_BITMAP_PIXELS,
  type RendererLike,
  RENDER_PRIORITY,
  scaleBucket,
} from './engine-service';

/** A stand-in ImageBitmap: only width/height/close are used by the cache. */
function fakeBitmap(width: number, height: number) {
  const bitmap = {
    width,
    height,
    closed: false,
    close() {
      bitmap.closed = true;
      bitmap.width = 0;
      bitmap.height = 0;
    },
  };
  return bitmap;
}

function entry(key: string, width: number, height: number, bucket = 1) {
  const bitmap = fakeBitmap(width, height);
  return {
    entry: { key, bitmap: bitmap as unknown as ImageBitmap, width, height, bucket },
    bitmap,
  };
}

describe('BitmapCache', () => {
  it('evicts least recently used entries over the byte budget and closes them', () => {
    const cache = new BitmapCache(bitmapBytes(10, 10) * 2);
    const a = entry('s:0:0:1', 10, 10);
    const b = entry('s:1:0:1', 10, 10);
    const c = entry('s:2:0:1', 10, 10);
    cache.set('s:0:0', a.entry);
    cache.set('s:1:0', b.entry);
    cache.get('s:0:0:1'); // a is now most recently used
    cache.set('s:2:0', c.entry);
    expect(cache.has('s:0:0:1')).toBe(true);
    expect(cache.has('s:1:0:1')).toBe(false);
    expect(b.bitmap.closed).toBe(true);
    expect(a.bitmap.closed).toBe(false);
    expect(cache.usedBytes).toBe(bitmapBytes(10, 10) * 2);
  });

  it('keeps a single entry larger than the budget (never evicts the newest)', () => {
    const cache = new BitmapCache(100);
    const big = entry('s:0:0:4', 100, 100, 4);
    cache.set('s:0:0', big.entry);
    expect(cache.has('s:0:0:4')).toBe(true);
    expect(big.bitmap.closed).toBe(false);
  });

  it('replacing a key closes the previous bitmap and keeps byte accounting exact', () => {
    const cache = new BitmapCache();
    const first = entry('s:0:0:1', 10, 10);
    const second = entry('s:0:0:1', 20, 10);
    cache.set('s:0:0', first.entry);
    cache.set('s:0:0', second.entry);
    expect(first.bitmap.closed).toBe(true);
    expect(cache.size).toBe(1);
    expect(cache.usedBytes).toBe(bitmapBytes(20, 10));
  });

  it('finds the best lower bucket of a page, or a higher one when allowed', () => {
    const cache = new BitmapCache();
    const page = pageKey('s', 3, 90);
    cache.set(page, entry(bitmapKey('s', 3, 90, 0.5), 5, 5, 0.5).entry);
    cache.set(page, entry(bitmapKey('s', 3, 90, 1), 10, 10, 1).entry);
    cache.set(page, entry(bitmapKey('s', 3, 90, 4), 40, 40, 4).entry);
    expect(cache.best(page, 2)?.bucket).toBe(1);
    expect(cache.best(page, 0.25)).toBeUndefined();
    expect(cache.best(page, 0.25, true)?.bucket).toBe(0.5);
    expect(cache.best(pageKey('s', 3, 0), 2, true)).toBeUndefined();
  });

  it('removes every bitmap of a source', () => {
    const cache = new BitmapCache();
    const a = entry('a:0:0:1', 1, 1);
    const b = entry('b:0:0:1', 1, 1);
    cache.set('a:0:0', a.entry);
    cache.set('b:0:0', b.entry);
    cache.removeSource('a');
    expect(a.bitmap.closed).toBe(true);
    expect(cache.has('b:0:0:1')).toBe(true);
    expect(cache.best('a:0:0', 8, true)).toBeUndefined();
  });
});

describe('scale buckets', () => {
  it('rounds up to quarter octaves', () => {
    expect(scaleBucket(1)).toBe(1);
    expect(scaleBucket(1.01)).toBe(1.1892);
    expect(scaleBucket(2)).toBe(2);
    expect(scaleBucket(0.3)).toBe(0.3536);
    expect(scaleBucket(Number.NaN)).toBe(1);
  });

  it('caps the bitmap size for huge pages', () => {
    const bucket = chooseBucket(8, 612, 792);
    expect(612 * bucket * 792 * bucket).toBeLessThanOrEqual(MAX_BITMAP_PIXELS);
    expect(chooseBucket(1, 612, 792)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// EngineService with a mock adapter
// ---------------------------------------------------------------------------

interface PendingRender {
  readonly index: number;
  readonly options: RenderOptions;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function mockRenderer(openImpl?: RendererLike['open']) {
  const pending: PendingRender[] = [];
  const closed: SourceId[] = [];
  const renderer: RendererLike = {
    open:
      openImpl ??
      (() => Promise.reject(new EngineError('internal', 'open not mocked in this test'))),
    close: (id) => {
      closed.push(id);
      return Promise.resolve();
    },
    getPageText: () => Promise.resolve([]),
    renderPage: (_id, index, options) =>
      new Promise((resolve, reject) => {
        const item: PendingRender = {
          index,
          options,
          resolve: () => {
            const bitmap = fakeBitmap(10, 10) as unknown as ImageBitmap;
            resolve({ bitmap, width: 10, height: 10 });
          },
          reject,
        };
        pending.push(item);
        options.signal?.addEventListener('abort', () => {
          reject(new EngineError('aborted', 'aborted'));
        });
      }),
  };
  return { renderer, pending, closed };
}

const SRC = sourceId('src-1');
const request = (
  index: number,
  priority: number,
  signal?: AbortSignal,
  rotation: Rotation = 0,
) => ({
  sourceId: SRC,
  index,
  rotation,
  bucket: 1,
  priority,
  ...(signal === undefined ? {} : { signal }),
});

/** Lets queued microtasks and promise chains (adapter creation, queue pumping) settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('EngineService queue', () => {
  it('runs at most `concurrency` renders and picks the highest priority next', async () => {
    const { renderer, pending } = mockRenderer();
    const service = new EngineService({
      createRenderer: () => renderer,
      concurrency: 1,
      timings: false,
    });
    const results = [
      service.renderPage(request(0, RENDER_PRIORITY.offscreen)),
      service.renderPage(request(1, RENDER_PRIORITY.offscreen)),
      service.renderPage(request(2, RENDER_PRIORITY.visible)),
      service.renderPage(request(3, RENDER_PRIORITY.page)),
    ];
    await flush();
    expect(pending.map((p) => p.index)).toEqual([0]);
    const order: number[] = [];
    for (let step = 0; step < 4; step++) {
      const next = pending[step];
      if (!next) break;
      order.push(next.index);
      next.resolve();
      await flush();
    }
    expect(order).toEqual([0, 3, 2, 1]);
    const settled = await Promise.all(results);
    expect(settled.every((r) => r.ok)).toBe(true);
  });

  it('deduplicates identical requests and serves later ones from the cache', async () => {
    const { renderer, pending } = mockRenderer();
    const service = new EngineService({ createRenderer: () => renderer, timings: false });
    const a = service.renderPage(request(0, 1));
    const b = service.renderPage(request(0, 2));
    await flush();
    expect(pending).toHaveLength(1);
    pending[0]?.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok && ra.value.bitmap === rb.value.bitmap).toBe(true);
    const c = await service.renderPage(request(0, 1));
    expect(c.ok).toBe(true);
    expect(pending).toHaveLength(1);
    expect(service.peek(SRC, 0, 0, 1)).toBeDefined();
  });

  it('cancels a queued job once every requester aborted, without touching the adapter', async () => {
    const { renderer, pending } = mockRenderer();
    const service = new EngineService({
      createRenderer: () => renderer,
      concurrency: 1,
      timings: false,
    });
    const first = service.renderPage(request(0, 1));
    const controller = new AbortController();
    const second = service.renderPage(request(1, 1, controller.signal));
    await flush();
    controller.abort();
    expect(await second).toMatchObject({ ok: false, error: { code: 'aborted' } });
    pending[0]?.resolve();
    await first;
    await flush();
    expect(pending.map((p) => p.index)).toEqual([0]);
    expect(service.pendingJobs).toBe(0);
  });

  it('aborts a running job through its AbortSignal when nobody needs it', async () => {
    const { renderer, pending } = mockRenderer();
    const service = new EngineService({ createRenderer: () => renderer, timings: false });
    const controller = new AbortController();
    const result = service.renderPage(request(0, 1, controller.signal));
    await flush();
    expect(pending).toHaveLength(1);
    controller.abort();
    expect(await result).toMatchObject({ ok: false, error: { code: 'aborted' } });
    expect(pending[0]?.options.signal?.aborted).toBe(true);
  });

  it('keeps a job alive while another requester still wants it', async () => {
    const { renderer, pending } = mockRenderer();
    const service = new EngineService({ createRenderer: () => renderer, timings: false });
    const controller = new AbortController();
    const leaving = service.renderPage(request(0, 1, controller.signal));
    const staying = service.renderPage(request(0, 2));
    await flush();
    controller.abort();
    expect(pending[0]?.options.signal?.aborted).toBe(false);
    pending[0]?.resolve();
    expect((await leaving).ok).toBe(false);
    expect((await staying).ok).toBe(true);
  });

  it('turns adapter failures into typed results (no rejections)', async () => {
    const { renderer, pending } = mockRenderer();
    const service = new EngineService({ createRenderer: () => renderer, timings: false });
    const result = service.renderPage(request(0, 1));
    await flush();
    pending[0]?.reject(new EngineError('corrupt', 'bad page'));
    expect(await result).toMatchObject({ ok: false, error: { code: 'corrupt' } });
    const odd = service.renderPage(request(1, 1));
    await flush();
    pending[1]?.reject('not even an Error');
    expect(await odd).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('close() cancels pending renders of the source and drops its bitmaps', async () => {
    const { renderer, pending, closed } = mockRenderer();
    const service = new EngineService({
      createRenderer: () => renderer,
      concurrency: 1,
      timings: false,
    });
    const done = service.renderPage(request(0, 1));
    await flush();
    pending[0]?.resolve();
    await done;
    const queued = service.renderPage(request(1, 1));
    const queued2 = service.renderPage(request(2, 1));
    await service.close(SRC);
    expect((await queued).ok).toBe(false);
    expect((await queued2).ok).toBe(false);
    expect(service.peek(SRC, 0, 0, 1)).toBeUndefined();
    expect(closed).toEqual([SRC]);
  });

  it('does not cache a render that completes after its source was closed', async () => {
    // The adapter finishes the render without noticing the abort (it was already done).
    let finish: (() => void) | undefined;
    const bitmap = fakeBitmap(10, 10);
    const { renderer, closed } = mockRenderer();
    const late: RendererLike = {
      ...renderer,
      renderPage: () =>
        new Promise((resolve) => {
          finish = () => {
            resolve({ bitmap: bitmap as unknown as ImageBitmap, width: 10, height: 10 });
          };
        }),
    };
    const service = new EngineService({ createRenderer: () => late, timings: false });
    const result = service.renderPage(request(0, 1));
    await flush();
    expect(finish).toBeDefined();
    await service.close(SRC);
    expect(closed).toEqual([SRC]);
    expect(await result).toMatchObject({ ok: false, error: { code: 'aborted' } });
    finish?.();
    await flush();
    expect(service.peek(SRC, 0, 0, 1)).toBeUndefined();
    expect(service.cacheStats.entries).toBe(0);
    expect(bitmap.closed).toBe(true);
    expect(service.pendingJobs).toBe(0);
  });
});

describe('EngineService open', () => {
  const opened = { pageCount: 1 } as unknown as OpenedDocument;
  const file = () => new File([new Uint8Array([37, 80, 68, 70])], 'secret.pdf');

  it('asks for a password, re-prompts after a wrong one, and opens with the right one', async () => {
    const open = vi.fn<RendererLike['open']>((_id, _bytes, options) => {
      if (options?.password === undefined) {
        return Promise.reject(new EngineError('password-required', 'locked'));
      }
      if (options.password !== 'right') {
        return Promise.reject(new EngineError('password-incorrect', 'wrong'));
      }
      return Promise.resolve(opened);
    });
    const { renderer } = mockRenderer(open);
    const service = new EngineService({ createRenderer: () => renderer, timings: false });
    const prompts: boolean[] = [];
    const answers = ['wrong', 'right'];
    service.setPasswordPrompt(({ incorrect }) => {
      prompts.push(incorrect);
      return Promise.resolve(answers.shift() ?? null);
    });
    const result = await service.open(file());
    expect(result.ok).toBe(true);
    expect(prompts).toEqual([false, true]);
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('reports a skipped file when the prompt is cancelled', async () => {
    const { renderer } = mockRenderer(() =>
      Promise.reject(new EngineError('password-required', 'locked')),
    );
    const service = new EngineService({ createRenderer: () => renderer, timings: false });
    service.setPasswordPrompt(() => Promise.resolve(null));
    expect(await service.open(file())).toMatchObject({
      ok: false,
      error: { code: 'password-cancelled' },
    });
  });

  it('reports engine failures without prompting', async () => {
    const { renderer } = mockRenderer(() => Promise.reject(new EngineError('corrupt', 'bad')));
    const service = new EngineService({ createRenderer: () => renderer, timings: false });
    const prompt = vi.fn(() => Promise.resolve('x'));
    service.setPasswordPrompt(prompt);
    expect(await service.open(file())).toMatchObject({ ok: false, error: { code: 'corrupt' } });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('keeps a copy of the original bytes for export and drops it on close', async () => {
    const detaching: RendererLike['open'] = (_id, bytes) => {
      // Like the real adapter: the buffer is transferred to a worker.
      const channel = new MessageChannel();
      channel.port1.postMessage(bytes, [bytes]);
      channel.port1.close();
      return Promise.resolve(opened);
    };
    const { renderer } = mockRenderer(detaching);
    const service = new EngineService({ createRenderer: () => renderer, timings: false });
    const result = await service.open(file());
    if (!result.ok) throw new Error(result.error.message);
    const kept = await service.sourceBytes(result.value.id);
    expect(kept.ok && [...new Uint8Array(kept.value)]).toEqual([37, 80, 68, 70]);
    await service.close(result.value.id);
    expect(await service.sourceBytes(result.value.id)).toMatchObject({ ok: false });
  });

  it('reports missing save/verify support instead of throwing', async () => {
    const { renderer } = mockRenderer();
    const service = new EngineService({ createRenderer: () => renderer, timings: false });
    expect(await service.saveSource(SRC)).toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
    expect(await service.verify(new ArrayBuffer(0), { pageCount: 0, pageSizes: [] })).toMatchObject(
      { ok: false, error: { code: 'unsupported' } },
    );
  });
});

describe('EngineService invalidatePage', () => {
  it('resolves requesters of a queued job it discards, and drops a running one’s result', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const renderPage = vi.fn(async (_id: SourceId, index: number) => {
      if (index === 0) await gate;
      return { bitmap: { width: 1, height: 1, close: vi.fn() } as never, width: 1, height: 1 };
    });
    const service = new EngineService({
      createRenderer: () => ({
        open: vi.fn(),
        close: vi.fn(() => Promise.resolve()),
        getPageText: vi.fn(() => Promise.resolve([])),
        renderPage,
      }),
      concurrency: 1,
      timings: false,
    });
    const s = sourceId('s');
    const running = service.renderPage({
      sourceId: s,
      index: 0,
      rotation: 0,
      bucket: 1,
      priority: 3,
    });
    await vi.waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));
    const queued = service.renderPage({
      sourceId: s,
      index: 1,
      rotation: 0,
      bucket: 1,
      priority: 3,
    });
    service.invalidatePage(s, 1);
    service.invalidatePage(s, 0);
    expect(await queued).toMatchObject({ ok: false, error: { code: 'aborted' } });
    releaseFirst();
    expect(await running).toMatchObject({ ok: false, error: { code: 'aborted' } });
    expect(service.pendingJobs).toBe(0);
    expect(service.peek(s, 0, 0, 1)).toBeUndefined();
    expect(service.pageRevision(s, 1)).toBe(1);
  });

  it('forgets page revisions and tells listeners when a source closes', async () => {
    const service = new EngineService({
      createRenderer: () => ({
        open: vi.fn(),
        close: vi.fn(() => Promise.resolve()),
        getPageText: vi.fn(() => Promise.resolve([])),
        renderPage: vi.fn(),
      }),
      timings: false,
    });
    const s = sourceId('s');
    const closed: SourceId[] = [];
    service.onSourceClosed((id) => closed.push(id));
    service.invalidatePage(s, 2);
    expect(service.pageRevision(s, 2)).toBe(1);
    await service.close(s);
    expect(service.pageRevision(s, 2)).toBe(0);
    expect(closed).toEqual([s]);
  });
});
