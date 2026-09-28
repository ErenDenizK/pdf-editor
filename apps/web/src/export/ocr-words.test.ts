/**
 * The export's OCR word check (spec recognize-and-compare §1.3,
 * `VerificationExpectation.ocrWords`): `ocrWordsExpectation` maps the words of the held
 * `ocr.apply` payloads to output pages (order, deleted and duplicated pages, resized pages by
 * text only, re-runs and later redactions), and `prepareExport` hands them to the real
 * PDFium verifier, which fails the export when a page does not yield its words.
 *
 * The "layer" here is simple-text.pdf's visible marker line: its words are planned at the
 * boxes PDFium reports for them, which is all the verifier looks at (text and boxes), so the
 * test needs no recognition and no layer writer.
 */
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import {
  addSource,
  createSequentialIdGenerator,
  createWorkspace,
  type DocumentId,
  deletePages,
  duplicatePages,
  type EngineEdit,
  getDocument,
  type PageId,
  resizePages,
  sourceId,
  type Workspace,
} from '@pdf-editor/document-model';
import * as engineModule from '@pdf-editor/engine';
import type { OcrLayerPage, OcrLayerWord, VerificationExpectation } from '@pdf-editor/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { type ExportDependencies, ocrWordsExpectation, prepareExport } from './export-service';

const assembler = new engineModule.PdfLibAssembler();
const adapter = new engineModule.PdfiumAdapter({ wasmUrl, inspector: assembler });
const SOURCE = sourceId('ocr-simple');
let original: ArrayBuffer;
let base: Workspace;
let documentId: DocumentId;
/** Planned words per source page: "PAGE", "n", "OF" at their PDFium boxes. */
let pages: OcrLayerPage[];

/** The words of `wanted` on a page, as a layer would carry them (box = PDFium's box). */
async function wordsAt(pageIndex: number, wanted: readonly string[]): Promise<OcrLayerWord[]> {
  const glyphs = (await adapter.getPageText(SOURCE, pageIndex)).flatMap((run) => run.glyphs);
  const text = glyphs.map((g) => g.text).join('');
  return wanted.map((word) => {
    const at = text.indexOf(word);
    if (at < 0) throw new Error(`"${word}" is not on page ${pageIndex + 1}`);
    const boxes = glyphs.slice(at, at + word.length).map((g) => g.rect);
    const x = Math.min(...boxes.map((r) => r.x));
    const y = Math.min(...boxes.map((r) => r.y));
    const width = Math.max(...boxes.map((r) => r.x + r.width)) - x;
    const fontSize = Math.max(...boxes.map((r) => r.y + r.height)) - y;
    return { text: word, origin: { x, y }, width, fontSize, angle: 0, confidence: 96 };
  });
}

const ocrEdit = (id: string, planned: readonly OcrLayerPage[]): EngineEdit =>
  engineModule.ocrApplyEdit(id, SOURCE, { pages: planned, replace: 'ours', lang: 'en' });

function deps(ws: Workspace, seen?: VerificationExpectation[]): ExportDependencies {
  return {
    engine: {
      sourceBytes: () => Promise.resolve({ ok: true, value: original.slice(0) }),
      saveSource: async (id, options) => ({ ok: true, value: await adapter.save(id, options) }),
      verify: async (bytes, expectation) => {
        seen?.push(expectation);
        return { ok: true, value: await adapter.verify(bytes, expectation) };
      },
      editor: () => Promise.resolve(adapter),
    },
    assembler: () => Promise.resolve(assembler),
    workspace: () => ws,
  };
}

beforeAll(async () => {
  original = await (await fetch(simpleUrl)).arrayBuffer();
  const opened = await adapter.open(SOURCE, original.slice(0));
  const added = addSource(
    createWorkspace(),
    { ...opened, name: 'simple-text.pdf', byteLength: original.byteLength },
    createSequentialIdGenerator('ocr'),
    { sourceId: SOURCE },
  );
  base = added.workspace;
  documentId = added.documentId;
  pages = [];
  for (const pageIndex of [0, 1, 2]) {
    const words = await wordsAt(pageIndex, ['PAGE', String(pageIndex + 1), 'OF']);
    pages.push({ pageIndex, languages: ['eng'], words });
  }
});

afterAll(async () => {
  await adapter.destroy();
});

/** Source pages 0 and 2 (page 1 deleted), page 0 duplicated, page 2 resized to fit A5. */
function edited(ws: Workspace): Workspace {
  const ids = getDocument(ws, documentId).pages.map((p) => p.id);
  let out = duplicatePages(ws, [ids[0] as PageId], createSequentialIdGenerator('dup'));
  out = deletePages(out, [ids[1] as PageId]);
  return resizePages(out, [ids[2] as PageId], {
    width: 420,
    height: 595,
    mode: 'fit',
    anchor: 'center',
  });
}

describe('ocrWordsExpectation', () => {
  it('maps the held words to output pages, resized pages by text only', () => {
    const ws = edited(base);
    const doc = getDocument(ws, documentId);
    const edit = ocrEdit('ocr-1', pages);
    const expected = ocrWordsExpectation(doc, () => [edit], engineModule);
    const boxed = (index: number) =>
      pages[index]?.words.map((w) => ({ text: w.text, rect: engineModule.layerWordRect(w) }));
    expect(expected).toEqual([
      { pageIndex: 0, words: boxed(0) },
      { pageIndex: 1, words: boxed(0) },
      { pageIndex: 2, words: [{ text: 'PAGE' }, { text: '3' }, { text: 'OF' }] },
    ]);
  });

  it('expects the last run per page, nothing after a redaction, and skips undo markers', () => {
    const doc = getDocument(base, documentId);
    const first = ocrEdit('ocr-1', pages);
    const rerun = ocrEdit('ocr-2', [
      { pageIndex: 1, languages: ['eng'], words: pages[1]?.words.slice(0, 1) ?? [] },
    ]);
    const undo: EngineEdit = {
      id: 'ocr-undo',
      source: SOURCE,
      pageIndex: 0,
      kind: 'ocr.apply',
      payload: { replayRequired: true, of: 'ocr-1' },
    };
    const words = (edits: readonly EngineEdit[]) =>
      ocrWordsExpectation(doc, () => edits, engineModule)?.map((p) => [
        p.pageIndex,
        p.words.map((w) => w.text),
      ]);
    expect(words([first, rerun, undo])).toEqual([
      [0, ['PAGE', '1', 'OF']],
      [1, ['PAGE']],
      [2, ['PAGE', '3', 'OF']],
    ]);
    const redaction: EngineEdit = {
      id: 'redact-1',
      source: SOURCE,
      pageIndex: 0,
      kind: 'redaction.apply',
      payload: {},
    };
    expect(words([first, redaction])).toBeUndefined();
    expect(words([first, redaction, rerun])).toEqual([[1, ['PAGE']]]);
    expect(words([])).toBeUndefined();
  });
});

describe('prepareExport with an ocr.apply edit', () => {
  it('fills ocrWords and passes when every output page yields its words', async () => {
    const ws = { ...edited(base), engineEdits: [ocrEdit('ocr-1', pages)] };
    const seen: VerificationExpectation[] = [];
    const result = await prepareExport(documentId, {}, deps(ws, seen));
    if (!result.ok) throw new Error(result.error.message);
    expect(seen[0]?.ocrWords?.map((p) => [p.pageIndex, p.words.length])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    expect(seen[0]?.ocrWords?.[2]?.words.every((w) => w.rect === undefined)).toBe(true);
    expect(result.value.verification).toEqual({ ok: true, problems: [] });
  });

  it('fails verification when an output page lacks its words, naming page and count', async () => {
    const missing = await wordsAt(2, ['PAGE']);
    const planned: OcrLayerPage[] = [
      pages[0] as OcrLayerPage,
      {
        pageIndex: 2,
        languages: ['eng'],
        words: [...(pages[2]?.words ?? []), { ...missing[0]!, text: 'Zebra' }],
      },
    ];
    const ws = { ...edited(base), engineEdits: [ocrEdit('ocr-1', planned)] };
    const result = await prepareExport(documentId, {}, deps(ws));
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.verification).toEqual({
      ok: false,
      problems: ['Page 3: 1 of 4 OCR words not found in the text (Zebra)'],
    });
  });
});
