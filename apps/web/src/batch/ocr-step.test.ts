/**
 * The pure parts of the batch OCR step: which pages a file's step recognises (after the
 * earlier steps), the layer plan, invisible text kept next to the new layer, the per-file
 * notes, and the languages ensured once per batch. The recognition itself runs in
 * runner.test.ts against the real engines.
 */
import {
  addSource,
  createRandomIdGenerator,
  createWorkspace,
  deletePages,
  getDocument,
  rotatePages,
  type SourceId,
  type SourceInput,
} from '@pdf-editor/document-model';
import type { OcrPageFacts, OcrPageResult } from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import {
  keptInvisiblePages,
  ocrStepNotes,
  ocrStepPlan,
  ocrStepTargets,
  pageList,
  recipeOcrLanguages,
} from './ocr-step';

const input: SourceInput = {
  name: 'scan.pdf',
  byteLength: 1,
  pageCount: 4,
  pages: Array.from({ length: 4 }, () => ({
    size: { width: 612, height: 792 },
    rotation: 0 as const,
  })),
  fingerprint: 'f',
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
};

function fact(pageIndex: number, overrides: Partial<OcrPageFacts> = {}): OcrPageFacts {
  return {
    pageIndex,
    visibleText: false,
    invisibleText: 'none',
    ourLayer: false,
    images: 1,
    imageOnly: true,
    ...overrides,
  };
}

function setup() {
  const added = addSource(createWorkspace(), input, createRandomIdGenerator());
  const facts = new Map<SourceId, readonly OcrPageFacts[]>([
    [
      added.sourceId,
      [
        fact(0),
        fact(1, { visibleText: true, imageOnly: false }),
        fact(2, { invisibleText: 'foreign' }),
        fact(3, { invisibleText: 'ours', ourLayer: true }),
      ],
    ],
  ]);
  return { ...added, facts };
}

function result(pageIndex: number, words: number, quality: OcrPageResult['quality']) {
  return { pageIndex, words: new Array(words).fill({}), quality } as unknown as OcrPageResult;
}

describe('the pages an OCR step recognises', () => {
  it('takes the pages without visible text, or all, in document order', () => {
    const { workspace, documentId, facts } = setup();
    const doc = getDocument(workspace, documentId);
    expect(ocrStepTargets(doc, facts, 'without-text').map((t) => t.index)).toEqual([0, 2, 3]);
    expect(ocrStepTargets(doc, facts, 'all').map((t) => t.index)).toEqual([0, 1, 2, 3]);
  });

  it('follows the earlier steps: deleted pages are left out, rotated ones read upright', () => {
    const { workspace, documentId, facts } = setup();
    const pages = getDocument(workspace, documentId).pages;
    const first = pages[0]?.id;
    const third = pages[2]?.id;
    if (first === undefined || third === undefined) throw new Error('fixture');
    const changed = rotatePages(deletePages(workspace, [first]), [third], 90);
    const targets = ocrStepTargets(getDocument(changed, documentId), facts, 'without-text');
    expect(targets.map((t) => [t.index, t.docIndex, t.rotation])).toEqual([
      [2, 1, 90],
      [3, 2, 0],
    ]);
  });
});

describe('the layer plan and what it keeps', () => {
  it('orders the pages and carries the replace mode', () => {
    const plan = ocrStepPlan([result(3, 1, 'good'), result(0, 2, 'review')], 'ours');
    expect(plan.pages.map((p) => p.pageIndex)).toEqual([0, 3]);
    expect(plan.replace).toBe('ours');
  });

  it('counts pages whose earlier invisible text stays next to the new layer', () => {
    const { workspace, documentId, facts } = setup();
    const targets = ocrStepTargets(getDocument(workspace, documentId), facts, 'all');
    // Another tool's text stays unless everything invisible is replaced.
    expect(keptInvisiblePages(targets, facts, 'ours')).toBe(1);
    // Keeping everything keeps this app's earlier layer too.
    expect(keptInvisiblePages(targets, facts, 'none')).toBe(2);
    expect(keptInvisiblePages(targets, facts, 'all-invisible')).toBe(0);
  });
});

describe('the notes of a file', () => {
  it('lists the pages, languages and quality, then pages without text', () => {
    const notes = ocrStepNotes({
      pages: [1, 0],
      languages: ['tur', 'eng'],
      byQuality: { good: 1, review: 0, poor: 0, 'no-text': 1 },
      withoutText: [1],
      reducedDpi: 0,
      keptInvisible: 0,
    });
    expect(notes).toEqual([
      {
        code: 'ocr.pages',
        message: 'Recognized 2 pages (1, 2) as tur+eng. Quality: Good 1, No text found 1.',
      },
      {
        code: 'ocr.without-text',
        message: 'No text was found on these pages: 2. They may be blank or in another language.',
      },
    ]);
  });

  it('says when pages were reduced or keep invisible text, and when nothing needed OCR', () => {
    const codes = ocrStepNotes({
      pages: [0],
      languages: ['eng'],
      byQuality: { good: 1, review: 0, poor: 0, 'no-text': 0 },
      withoutText: [],
      reducedDpi: 1,
      keptInvisible: 1,
    }).map((n) => n.code);
    expect(codes).toEqual(['ocr.pages', 'ocr.reduced-dpi', 'ocr.kept-invisible']);
    expect(
      ocrStepNotes({
        pages: [],
        languages: ['eng'],
        byQuality: { good: 0, review: 0, poor: 0, 'no-text': 0 },
        withoutText: [],
        reducedDpi: 0,
        keptInvisible: 0,
      }),
    ).toEqual([
      {
        code: 'ocr.nothing',
        message: 'No page needed text recognition: every page already has text.',
      },
    ]);
  });

  it('numbers pages from one, in order', () => {
    expect(pageList([4, 0, 2])).toBe('1, 3, 5');
  });
});

it('ensures every language of the recipe once, in first-seen order', () => {
  expect(
    recipeOcrLanguages([
      { options: { languages: ['tur', 'eng'], dpi: 300, scope: 'all' } },
      { options: { languages: ['eng', 'deu'], dpi: 400, scope: 'without-text' } },
    ]),
  ).toEqual(['tur', 'eng', 'deu']);
});
