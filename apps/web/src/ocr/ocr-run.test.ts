/**
 * One OCR run (ocr-run.ts) with the real edit runner and PDFium worker on scan-text.pdf; the
 * recognizer (tesseract.js) is replaced by a stub that reads "TOPSECRET" off any page that is
 * not blacked out. Covered: the layer plans per source; a redaction landing while a page is
 * being recognised (review M5 #1: the page is recognised again from the redacted render, and
 * the redacted word never reaches the page text or the history); a document that keeps
 * changing (the run fails, nothing committed); redacting after the run (the panel's rows and
 * the export summary drop the word, #2); closing the document mid-run (#6); cancelling
 * mid-recognition; a failing page stopping the other lane before the error is passed on (#8).
 */
import type {
  DocumentId,
  EngineEdit,
  PageId,
  SourceId,
  VirtualDocument,
} from '@pdf-editor/document-model';
import {
  EngineError,
  OCR_LOW_CONFIDENCE,
  OCR_QUALITY_THRESHOLDS,
  type OcrPageFacts,
  type OcrPageResult,
  type OcrRaster,
  type OcrRecognizer,
} from '@pdf-editor/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import scanUrl from '../../../../test/fixtures/scan-text.pdf?url';
import { deferred, fixtureFile } from '../../test/store-harness';
import { resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { getEngineService, getOcrRecognizers } from '../engine/engine-service';
import { prepareExport } from '../export/export-service';
import { m } from '../i18n';
import { applyRedactionPlans } from '../redaction/apply';
import { useAnnouncer } from '../shell/announcer';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import {
  documentTargets,
  lowConfidenceRows,
  ocrRecords,
  type OcrTarget,
  thresholdsOf,
} from './ocr-model';
import { plansOf, RECHECKS, recognizeAndApply, recognizeTargets } from './ocr-run';
import type { OcrRunRequest } from './ocr-store';

const T = thresholdsOf({ OCR_LOW_CONFIDENCE, OCR_QUALITY_THRESHOLDS });
const WORD = 'TOPSECRET';
const PAGE = { x: 0, y: 0, width: 612, height: 792 };
const model = () => useWorkspaceStore.getState();

/** A page result as the recognizer returns it: one word, or none. */
function pageResult(pageIndex: number, words: readonly string[], confidence = 95): OcrPageResult {
  return {
    pageIndex,
    dpi: 300,
    languages: ['eng'],
    words: words.map((text, i) => ({
      text,
      origin: { x: 100, y: 400 - 30 * i },
      width: 120,
      fontSize: 20,
      angle: 0,
      rect: { x: 100, y: 400 - 30 * i, width: 120, height: 20 },
      pixelBox: { x0: 0, y0: 0, x1: 1, y1: 1 },
      confidence,
      line: i,
      lowConfidence: confidence < OCR_LOW_CONFIDENCE,
    })),
    lines: [],
    meanConfidence: words.length === 0 ? 0 : confidence,
    quality: words.length === 0 ? 'no-text' : confidence >= 90 ? 'good' : 'poor',
    engine: 'stub',
    dropped: 0,
    lowConfidence: confidence < OCR_LOW_CONFIDENCE ? words.length : 0,
    timedOut: false,
  } as unknown as OcrPageResult;
}

/** Mean grey level of a PGM raster (0 black … 255 white). */
function meanGrey(raster: OcrRaster): number {
  const bytes = new Uint8Array(raster.bytes);
  const pixels = bytes.subarray(bytes.length - raster.width * raster.height);
  let sum = 0;
  for (const value of pixels) sum += value;
  return sum / pixels.length;
}

interface Stub {
  readonly recognizer: Pick<OcrRecognizer, 'recognize' | 'ensureLanguages' | 'dispose'>;
  /** Pages recognised, in call order, with whether the render was blacked out. */
  readonly calls: { page: number; dark: boolean; signal: AbortSignal | undefined }[];
  readonly released: () => number;
}

/**
 * Replaces the app's recognizer lease with a stub: `hook` runs inside each `recognize` (to
 * hold it or change the document meanwhile); the word is read unless the page is dark.
 */
function stubRecognizer(
  hook: (call: number, signal: AbortSignal | undefined) => Promise<void> = () => Promise.resolve(),
  confidence = 95,
): Stub {
  const calls: Stub['calls'] = [];
  let released = 0;
  const recognizer: Stub['recognizer'] = {
    ensureLanguages: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    recognize: async (raster, page, _languages, options) => {
      const dark = meanGrey(raster) < 64;
      calls.push({ page, dark, signal: options?.signal });
      await hook(calls.length, options?.signal);
      if (options?.signal?.aborted) throw new EngineError('aborted', 'OCR was cancelled');
      return pageResult(page, dark ? [] : [WORD], confidence);
    },
  };
  vi.spyOn(getOcrRecognizers(), 'acquire').mockResolvedValue({
    recognizer: recognizer as OcrRecognizer,
    release: () => {
      released += 1;
    },
  });
  return { recognizer, calls, released: () => released };
}

/** Resolves when `signal` aborts. */
const aborted = (signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (!signal || signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

async function openScan() {
  const report = await model().openFiles([await fixtureFile(scanUrl, 'scan-text.pdf')]);
  const documentId = report.opened[0]?.documentId;
  if (!documentId) throw new Error('scan-text.pdf did not open');
  const doc = model().workspace.documents[documentId] as VirtualDocument;
  const targets = documentTargets(doc).slice(0, 1);
  const source = targets[0]?.source as SourceId;
  const request: OcrRunRequest = {
    documentId,
    targets,
    facts: new Map(),
    languages: ['eng'],
    quality: 'standard',
    replace: false,
  };
  return { documentId, source, request };
}

const redactPage = (source: SourceId, rect = PAGE) =>
  applyRedactionPlans([{ source, plan: { areas: [{ pageIndex: 0, rect }], strings: [] } }], {
    label: 'Redact',
    coalesceKey: `redact-${Math.random()}`,
    captureStrings: false,
  });

const kinds = () => model().workspace.engineEdits.map((edit) => edit.kind);

/** Page 1's text as the app reads it (the engine service, memoized per page). */
async function pageText(source: SourceId): Promise<string> {
  const runs = await getEngineService().getPageText(source, 0);
  if (!runs.ok) throw new Error(runs.error.message);
  return runs.value.map((run) => run.text).join(' ');
}

function ocrWords(edit: EngineEdit | undefined): string[] {
  const pages = (edit?.payload as { pages?: { words: [string][] }[] } | undefined)?.pages ?? [];
  return pages.flatMap((page) => page.words.map((word) => word[0]));
}

const noProgress = () => undefined;

beforeEach(() => {
  resetWorkspace();
  resetEditRunner();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await whenIdle();
  resetWorkspace();
});

describe('plansOf', () => {
  const A = 'a' as SourceId;
  const B = 'b' as SourceId;
  const target = (source: SourceId, index: number, docIndex: number): OcrTarget => ({
    pageId: `p${docIndex}` as PageId,
    docIndex,
    source,
    index,
    rotation: 0,
  });
  const fact = (pageIndex: number, invisibleText: OcrPageFacts['invisibleText']) =>
    ({ pageIndex, invisibleText, ourLayer: invisibleText === 'ours' }) as OcrPageFacts;

  it('makes one plan per source, pages in source order, the replace mode per source', () => {
    const targets = [target(A, 2, 0), target(B, 0, 1), target(A, 0, 2), target(A, 1, 3)];
    const facts = new Map([
      [A, [fact(0, 'none'), fact(1, 'ours'), fact(2, 'none')]],
      [B, [fact(0, 'foreign')]],
    ]);
    const request = {
      documentId: 'd' as DocumentId,
      targets,
      facts,
      languages: ['eng'],
      quality: 'standard',
      replace: true,
    } as const;
    // The fourth page was not recognised (a sparse result): it is left out.
    const results = [pageResult(2, ['c']), pageResult(0, ['b']), pageResult(0, ['a'])];
    const plans = plansOf(request, results);
    expect([...plans.keys()]).toEqual([A, B]);
    expect(plans.get(A)?.pages.map((p) => p.pageIndex)).toEqual([0, 2]);
    expect(plans.get(A)?.replace).toBe('ours');
    expect(plans.get(B)?.replace).toBe('all-invisible');
    expect(plansOf({ ...request, replace: false }, results).get(A)?.replace).toBe('none');
  });
});

describe('an OCR run against edits made meanwhile', () => {
  it('recognises a page again when a redaction lands during its recognition', async () => {
    const { documentId, source, request } = await openScan();
    const gate = deferred();
    const holding = deferred();
    const stub = stubRecognizer(async (call) => {
      if (call === 1) {
        holding.resolve();
        await gate.promise;
      }
    });
    const said: string[] = [];
    const unsubscribe = useAnnouncer.subscribe((s) => said.push(s.message));
    const run = recognizeAndApply(request, {
      signal: new AbortController().signal,
      onProgress: noProgress,
    });
    await holding.promise;
    // While page 1 is being recognised, the user redacts the whole page.
    expect((await redactPage(source)).kind).toBe('applied');
    gate.resolve();
    const result = await run;
    unsubscribe();

    // Read again from the redacted render, which yields nothing.
    expect(stub.calls.map((c) => [c.page, c.dark])).toEqual([
      [0, false],
      [0, true],
    ]);
    expect(said).toContain(m.ocr_recheck({ count: 1, countText: '1' }));
    expect(result?.words).toBe(0);
    expect(kinds()).toEqual(['redaction.apply', 'ocr.apply']);
    const ocr = model().workspace.engineEdits.find((edit) => edit.kind === 'ocr.apply');
    expect(ocrWords(ocr)).toEqual([]);
    expect(await pageText(source)).not.toContain(WORD);
    const exported = await prepareExport(documentId);
    if (!exported.ok) throw new Error(exported.error.message);
    expect(exported.value.verification.ok).toBe(true);
    expect(exported.value.redaction?.report.ok).toBe(true);
    expect(stub.released()).toBe(1);
  }, 120_000);

  it('fails without writing when the document keeps changing', async () => {
    const { source, request } = await openScan();
    // Every pass redacts the page again while it is being recognised.
    const stub = stubRecognizer(async () => {
      expect((await redactPage(source)).kind).toBe('applied');
    });
    await expect(
      recognizeAndApply(request, { signal: new AbortController().signal, onProgress: noProgress }),
    ).rejects.toThrow(m.ocr_changed_during_run());
    expect(stub.calls).toHaveLength(RECHECKS + 1);
    expect(kinds()).toEqual(Array.from({ length: RECHECKS + 1 }, () => 'redaction.apply'));
    expect(stub.released()).toBe(1);
  }, 120_000);

  it('keeps redacted words out of the panel and the export summary after the run', async () => {
    const { documentId, source, request } = await openScan();
    stubRecognizer(undefined, 50);
    // The scan has no text before the run (read, so the service remembers it).
    expect(await pageText(source)).toBe('');
    const result = await recognizeAndApply(request, {
      signal: new AbortController().signal,
      onProgress: noProgress,
    });
    expect(result?.words).toBe(1);
    expect(await pageText(source)).toContain(WORD);
    const before = ocrRecords(model().workspace.engineEdits, T);
    expect([...before.values()].flatMap((r) => lowConfidenceRows(r, T).map((w) => w.text))).toEqual(
      [WORD],
    );

    expect((await redactPage(source)).kind).toBe('applied');
    expect(kinds()).toEqual(['ocr.apply', 'redaction.apply']);
    expect(await pageText(source)).not.toContain(WORD);
    const records = ocrRecords(model().workspace.engineEdits, T);
    expect([...records.values()].flatMap((r) => r.words.map((w) => w[0]))).toEqual([]);
    expect([...records.values()].flatMap((r) => lowConfidenceRows(r, T))).toEqual([]);
    // The stored payload is untouched: undo brings the word back with the layer.
    const ocr = model().workspace.engineEdits.find((edit) => edit.kind === 'ocr.apply');
    expect(ocrWords(ocr)).toEqual([WORD]);
    const exported = await prepareExport(documentId);
    if (!exported.ok) throw new Error(exported.error.message);
    expect(exported.value.verification.ok).toBe(true);
    // No page carries recognised text any more: no OCR line.
    expect(exported.value.ocr).toBeUndefined();
  }, 120_000);
});

describe('stopping an OCR run', () => {
  it('stops when its document closes and writes nothing', async () => {
    const { documentId, request } = await openScan();
    const holding = deferred();
    const stub = stubRecognizer(async (_call, signal) => {
      holding.resolve();
      await aborted(signal);
    });
    const run = recognizeAndApply(request, {
      signal: new AbortController().signal,
      onProgress: noProgress,
    });
    await holding.promise;
    model().closeDocument(documentId);
    expect(await run).toBeUndefined();
    expect(stub.calls[0]?.signal?.aborted).toBe(true);
    expect(kinds()).toEqual([]);
    expect(useAnnouncer.getState().message).toBe(m.ocr_document_closed());
    expect(stub.released()).toBe(1);
  }, 120_000);

  it('cancels mid-recognition and writes nothing', async () => {
    const { request } = await openScan();
    const holding = deferred();
    const stub = stubRecognizer(async (_call, signal) => {
      holding.resolve();
      await aborted(signal);
    });
    const controller = new AbortController();
    const phases: string[] = [];
    const run = recognizeAndApply(request, {
      signal: controller.signal,
      onProgress: (progress) => phases.push(progress.phase),
    });
    await holding.promise;
    const edits = model().workspace.engineEdits;
    controller.abort();
    expect(await run).toBeUndefined();
    expect(stub.calls[0]?.signal?.aborted).toBe(true);
    expect(phases).not.toContain('write');
    expect(model().workspace.engineEdits).toBe(edits);
    expect(useAnnouncer.getState().message).toBe(m.ocr_cancelled());
    expect(stub.released()).toBe(1);
  }, 120_000);

  it('stops the other lane when a page fails, and throws once both have stopped', async () => {
    const source = 's' as SourceId;
    const targets = [0, 1, 2, 3].map(
      (index): OcrTarget => ({
        pageId: `p${index}` as PageId,
        docIndex: index,
        source,
        index,
        rotation: 0,
      }),
    );
    const log: string[] = [];
    const rendering = deferred();
    const raster = (pageIndex: number) => ({ pageIndex }) as unknown as OcrRaster;
    const layer = {
      renderForOcr: async (_source: SourceId, index: number) => {
        log.push(`render ${index}`);
        if (index === 0) {
          // Fails once page 2 is being recognised.
          await rendering.promise;
          throw new Error('render failed');
        }
        return raster(index);
      },
    };
    const recognizer = {
      recognize: async (
        r: OcrRaster,
        page: number,
        _l: readonly string[],
        options?: { signal?: AbortSignal },
      ) => {
        log.push(`recognize ${page}`);
        rendering.resolve();
        await aborted(options?.signal);
        // The lane takes a moment to stop (tesseract.js terminating a job).
        await new Promise((resolve) => setTimeout(resolve, 20));
        log.push(`stopped ${page}`);
        throw new EngineError('aborted', `stopped ${r.pageIndex}`);
      },
    };
    const outer = new AbortController();
    await expect(
      recognizeTargets(
        targets,
        { recognizer, layer, languages: ['eng'], dpiOf: () => 300 },
        { signal: outer.signal, onProgress: noProgress },
      ).finally(() => log.push('rejected')),
    ).rejects.toThrow('render failed');
    expect(log).toEqual(['render 0', 'render 1', 'recognize 1', 'stopped 1', 'rejected']);
    expect(outer.signal.aborted).toBe(false);
  });
});
