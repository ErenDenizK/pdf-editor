/**
 * Canary for the PDFium host (ADR-0011 §2, §6): EmbedPDF's private layout that the host
 * relies on is present in the pinned build, raw calls reach the adapter's documents, the
 * per-source lock serialises raw edits with each other and with orchestrated tasks, and
 * dropping the page cache makes a raw edit visible. If this file fails after an
 * `@embedpdf/*` update, do not ship the update.
 */
import { PdfiumNative } from '@embedpdf/engines';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import simpleTextUrl from '../../../../../test/fixtures/simple-text.pdf?url';
import enginePackage from '../../../package.json';
import { sid, wasmUrl } from '../../../test/helpers';
import { EngineError } from '../../types';
import { PdfiumAdapter } from '../pdfium-adapter';
import {
  createHostedEngine,
  docContext,
  type HostedEngine,
  PINNED_EMBEDPDF_VERSION,
  SourceLocks,
} from './index';

let host: HostedEngine;
let adapter: PdfiumAdapter;
let fixtureBytes: ArrayBuffer;
let counter = 0;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function openFixture(): Promise<string> {
  const id = `host-${++counter}`;
  await adapter.open(sid(id), fixtureBytes.slice(0));
  return id;
}

beforeAll(async () => {
  host = await createHostedEngine({ wasm: wasmUrl });
  adapter = new PdfiumAdapter({ wasmUrl, engineFactory: () => host.engine });
  fixtureBytes = await (await fetch(simpleTextUrl)).arrayBuffer();
});

afterAll(async () => {
  await adapter.destroy();
});

describe('PDFium host: private layout (pinned EmbedPDF)', () => {
  test('the pinned version matches the package dependencies', () => {
    for (const name of ['@embedpdf/engines', '@embedpdf/pdfium', '@embedpdf/models'] as const) {
      expect(enginePackage.dependencies[name]).toBe(PINNED_EMBEDPDF_VERSION);
    }
  });

  test('docPtr and pagePtr are reachable for an open source; raw calls see its content', async () => {
    const id = await openFixture();
    const ctx = host.docContext(id);
    expect(ctx.docPtr).toBeGreaterThan(0);
    expect(host.module.FPDF_GetPageCount(ctx.docPtr)).toBe(3);
    const page = ctx.acquirePage(0);
    try {
      expect(page.pagePtr).toBeGreaterThan(0);
      // simple-text.pdf page 1: the marker and two lines of body text, one text object each.
      expect(host.module.FPDFPage_CountObjects(page.pagePtr)).toBe(3);
      const textPage = page.getTextPage();
      const first = host.module.FPDFText_GetTextObject(textPage, 0);
      const text = host.memory.readUtf16Result((buf, len) =>
        host.module.FPDFTextObj_GetText(first, textPage, buf, len),
      );
      expect(text).toBe('PAGE 1 OF simple-text');
    } finally {
      page.release();
    }
    await adapter.close(sid(id));
  });

  test('docContext fails clearly for a closed source and for a changed layout', async () => {
    const id = await openFixture();
    await adapter.close(sid(id));
    expect(() => host.docContext(id)).toThrow(/is not open/);
    // A PdfiumNative-shaped object without the private cache: the layout guard trips.
    const bare = Object.create(PdfiumNative.prototype) as PdfiumNative;
    let error: unknown;
    try {
      docContext(bare, id);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EngineError);
    expect((error as Error).message).toContain(`@embedpdf/engines ${PINNED_EMBEDPDF_VERSION}`);
  });
});

describe('PDFium host: raw access', () => {
  test('overlapping withRawAccess calls on one source run in order', async () => {
    const id = await openFixture();
    const events: string[] = [];
    const first = host.withRawAccess(id, async (raw) => {
      events.push('first:start');
      expect(raw.docPtr).toBe(host.docContext(id).docPtr);
      await delay(30);
      events.push('first:end');
      return 1;
    });
    const second = host.withRawAccess(id, (raw) => {
      events.push('second:start');
      return raw.module.FPDF_GetPageCount(raw.docPtr);
    });
    expect(await Promise.all([first, second])).toEqual([1, 3]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    await adapter.close(sid(id));
  });

  test('orchestrated tasks wait for a raw access, and it waits for adapter calls in flight', async () => {
    const id = await openFixture();
    const other = await openFixture();
    const events: string[] = [];
    // An adapter call under the shared lock started first: the raw access waits for it.
    const text = host.withEngineAccess(id, async () => {
      const runs = await adapter.getPageText(sid(id), 0);
      events.push('text');
      return runs;
    });
    const raw = host.withRawAccess(id, async () => {
      events.push('raw:start');
      await delay(30);
      events.push('raw:end');
    });
    // A render of *another* source, enqueued while the raw access holds the queue slot.
    await delay(5);
    const render = adapter.renderPage(sid(other), 0, { scale: 0.25 }).then((result) => {
      events.push('render');
      result.bitmap.close();
    });
    await Promise.all([text, raw, render]);
    expect(events).toEqual(['text', 'raw:start', 'raw:end', 'render']);
    await adapter.close(sid(id));
    await adapter.close(sid(other));
  });

  test('a request withdrawn by its signal never runs', async () => {
    const id = await openFixture();
    const aborted = new AbortController();
    aborted.abort();
    await expect(host.withRawAccess(id, () => 1, { signal: aborted.signal })).rejects.toMatchObject(
      { code: 'aborted' },
    );
    let ran = false;
    const blocker = host.withRawAccess(id, () => delay(30));
    const controller = new AbortController();
    const waiting = host.withRawAccess(
      id,
      () => {
        ran = true;
      },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' });
    await blocker;
    expect(ran).toBe(false);
    expect(host.locks.busy(id)).toBe(false);
    await adapter.close(sid(id));
  });

  test('errors thrown by the callback reach the caller and release the lock', async () => {
    const id = await openFixture();
    await expect(
      host.withRawAccess(id, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await host.withRawAccess(id, (raw) => raw.module.FPDF_GetPageCount(raw.docPtr))).toBe(3);
    await expect(host.withRawAccess('not-open', () => 1)).rejects.toThrow(/is not open/);
    await adapter.close(sid(id));
  });

  test('after dropPageCache a fresh text page sees a raw edit', async () => {
    const id = await openFixture();
    const before = await adapter.getPageText(sid(id), 0);
    expect(before[0]?.text).toBe('PAGE 1 OF simple-text');
    await host.withRawAccess(id, ({ module, memory, doc }) => {
      const page = doc.acquirePage(0);
      try {
        const obj = module.FPDFText_GetTextObject(page.getTextPage(), 0);
        expect(
          memory.withWideString('EDITED BY HOST', (ptr) => module.FPDFText_SetText(obj, ptr)),
        ).toBe(true);
        expect(module.FPDFPage_GenerateContent(page.pagePtr)).toBe(true);
      } finally {
        page.release();
      }
    });
    // The executor still holds the text page loaded before the edit (05 spike §1).
    const stale = await adapter.getPageText(sid(id), 0);
    expect(stale[0]?.text).toBe('PAGE 1 OF simple-text');
    await host.withRawAccess(id, (raw) => {
      raw.dropPageCache(0);
    });
    const fresh = await adapter.getPageText(sid(id), 0);
    expect(fresh[0]?.text).toBe('EDITED BY HOST');
    await adapter.close(sid(id));
  });
});

describe('SourceLocks', () => {
  test('shared holders run together; exclusive waits for them and holds back later ones', async () => {
    const locks = new SourceLocks();
    const events: string[] = [];
    const hold = (name: string, mode: 'shared' | 'exclusive', ms: number) =>
      locks.run('s', mode, async () => {
        events.push(`${name}+`);
        await delay(ms);
        events.push(`${name}-`);
      });
    await Promise.all([
      hold('a', 'shared', 20),
      hold('b', 'shared', 10),
      hold('w', 'exclusive', 10),
      hold('c', 'shared', 1),
    ]);
    expect(events).toEqual(['a+', 'b+', 'b-', 'a-', 'w+', 'w-', 'c+', 'c-']);
    expect(locks.busy('s')).toBe(false);
  });
});
