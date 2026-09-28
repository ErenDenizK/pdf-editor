/**
 * Unit tests of the comparison parts on synthetic data: tokens, the text diff (document and
 * page-pair scopes), the pixel diff (frame, regions on rotated pages), XMP and the facts diff.
 */
import type { Rect } from '@pdf-editor/document-model';
import { describe, expect, test } from 'vitest';

import type { CompareFacts, Glyph, PagePair, TextRun } from '../types';
import { diffFacts, factsFromEngine, parseXmp } from './facts';
import { pixelBoxToUser } from './geometry';
import { boxesToUser, changeBoxes, diffRgba, thumbnailOf } from './pixels';
import { Slicer } from './scheduler';
import { diffText, joinTokens } from './text-diff';
import { tokenizePage } from './tokens';

function run(text: string, x: number, y: number, size = 10): TextRun {
  const glyphs: Glyph[] = [];
  let cx = x;
  for (const ch of text) {
    if (ch !== ' ')
      glyphs.push({ text: ch, rect: { x: cx, y, width: size / 2, height: size }, fontSize: size });
    cx += size / 2;
  }
  return { text, rect: { x, y, width: cx - x, height: size }, glyphs };
}

describe('tokens', () => {
  test('words and punctuation with boxes; NFKC; a soft hyphen at a line end joins the word', () => {
    const first = run('An eﬃcient hy', 72, 700);
    const marker: Glyph = {
      text: '',
      rect: { x: 137, y: 700, width: 3, height: 10 },
      fontSize: 10,
    };
    const page = tokenizePage([
      { ...first, glyphs: [...first.glyphs, marker] },
      run('phen, here.', 72, 686),
    ]);
    expect(page.tokens.map((t) => t.text)).toEqual(['An', 'efficient', 'hyphen', ',', 'here', '.']);
    const joined = page.tokens[2]!;
    expect(joined.rects).toHaveLength(2);
    expect(joined.rects[0]!.y).toBe(700);
    expect(joined.rects[1]!.y).toBe(686);
    expect(page.tokens[0]!.rects[0]).toEqual({ x: 72, y: 700, width: 10, height: 10 });
    const apart = tokenizePage(
      [{ ...first, glyphs: [...first.glyphs, marker] }, run('phen', 72, 686)],
      {
        joinHyphens: false,
      },
    );
    expect(apart.tokens.map((t) => t.text)).toEqual(['An', 'efficient', 'hy', 'phen']);
  });

  test('runs are read in layout order, not in content order', () => {
    const page = tokenizePage([run('second line', 72, 680), run('first line', 72, 700)]);
    expect(page.tokens.map((t) => t.text)).toEqual(['first', 'line', 'second', 'line']);
  });

  test('joinTokens spaces words but not punctuation', () => {
    expect(joinTokens(['Hello', ',', 'world', '(', 'again', ')', '.'])).toBe(
      'Hello, world (again).',
    );
  });
});

describe('text diff', () => {
  const pageOf = (...lines: string[]) =>
    tokenizePage(lines.map((l, i) => run(l, 72, 700 - 14 * i)));
  const pairs = (n: number): PagePair[] =>
    Array.from({ length: n }, (_, i) => ({ a: i, b: i, similarity: 1, basis: 'text' }));

  test('text reflowing across a page break is not a change in document scope', async () => {
    const a = [pageOf('one two three four'), pageOf('five six')];
    const b = [pageOf('one two three'), pageOf('four five six')];
    const doc = await diffText(a, b, pairs(2), 'document', new Slicer('t'));
    expect(doc.changes).toEqual([]);
    const perPage = await diffText(a, b, pairs(2), 'page-pairs', new Slicer('t'));
    expect(perPage.scope).toBe('page-pairs');
    expect(perPage.changes.map((c) => [c.kind, c.a?.text, c.b?.text])).toEqual([
      ['removed', 'four', undefined],
      ['added', undefined, 'four'],
    ]);
  });

  test('insert, delete and replace runs with boxes on their pages', async () => {
    const a = [pageOf('keep this word and drop that')];
    const b = [pageOf('keep this term and drop that', 'plus a new line')];
    const result = await diffText(a, b, pairs(1), 'document', new Slicer('t'));
    expect(result.changes.map((c) => [c.kind, c.a?.text, c.b?.text])).toEqual([
      ['changed', 'word', 'term'],
      ['added', undefined, 'plus a new line'],
    ]);
    expect(result.changes[1]!.b!.rects).toEqual([{ x: 72, y: 686, width: 75, height: 10 }]);
    expect(result.changes[0]!.a!.line).toBe('keep this word and drop that');
  });

  test('unpaired pages are left to the page map', async () => {
    const a = [pageOf('same'), pageOf('only in a')];
    const b = [pageOf('same')];
    const result = await diffText(
      a,
      b,
      [
        { a: 0, b: 0, similarity: 1, basis: 'text' },
        { a: 1, similarity: 0, basis: 'none' },
      ],
      'document',
      new Slicer('t'),
    );
    expect(result.changes).toEqual([]);
  });
});

describe('pixel diff', () => {
  const solid = (w: number, h: number, v = 255) => ({
    width: w,
    height: h,
    data: new Uint8ClampedArray(w * h * 4).fill(v),
  });

  test('a dark square is one region; the frame reports a size mismatch as changed pixels', async () => {
    const a = solid(100, 100);
    const b = solid(100, 120);
    for (let y = 20; y < 30; y++) {
      for (let x = 40; x < 60; x++) b.data.fill(0, (y * 100 + x) * 4, (y * 100 + x) * 4 + 3);
    }
    const core = await diffRgba(a, b, 0.1, new Slicer('t'));
    expect(core.sizeMismatch).toBe(true);
    expect([core.width, core.height]).toEqual([100, 120]);
    // 200 dark pixels + the 20 rows the first page does not cover.
    expect(core.changedPixels).toBe(200 + 20 * 100);
    const boxes = changeBoxes(core);
    expect(boxes).toEqual([
      { x0: 40, y0: 16, x1: 64, y1: 32 },
      { x0: 0, y0: 96, x1: 100, y1: 120 },
    ]);
    // In user space of a 72 × 86.4 pt page rendered at 100 dpi (100 × 120 px).
    const page = { size: { width: 72, height: 86.4 }, rotation: 0 as const };
    const rects = boxesToUser(boxes, page, 100, 120);
    expect(rects[0]).toEqual({ x: 28.8, y: 63.36, width: 17.28, height: 11.52 });
  });

  test('identical images have no changed pixels; thumbnails average', async () => {
    const core = await diffRgba(solid(50, 50, 200), solid(50, 50, 200), 0.1, new Slicer('t'));
    expect(core.changedPixels).toBe(0);
    expect(changeBoxes(core)).toEqual([]);
    const thumb = thumbnailOf(solid(64, 64, 128));
    expect(thumb.length).toBe(1024);
    expect(new Set(thumb)).toEqual(new Set([128]));
  });

  test('pixel boxes map to user space on rotated and cropped pages', () => {
    // A 200 × 100 pt page with /Rotate 90 shows as 100 × 200 pt; at 72 dpi 100 × 200 px.
    const page = {
      size: { width: 200, height: 100 },
      rotation: 90 as const,
      origin: { x: 10, y: 20 },
    };
    // The top-left 10 × 20 px of the display is user x 10..30 (display y), y 20..30.
    const rect: Rect | undefined = pixelBoxToUser(page, 100, 200, { x0: 0, y0: 0, x1: 10, y1: 20 });
    expect(rect).toEqual({ x: 10, y: 20, width: 20, height: 10 });
  });
});

describe('facts', () => {
  test('XMP in element and attribute form', () => {
    const xmp = parseXmp(
      '<x:xmpmeta><rdf:RDF><rdf:Description pdf:Producer="Tool &amp; Co" xmp:CreatorTool="Writer">' +
        '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Report</rdf:li></rdf:Alt></dc:title>' +
        '<dc:creator><rdf:Seq><rdf:li>Ada</rdf:li><rdf:li>Grace</rdf:li></rdf:Seq></dc:creator>' +
        '<xmpMM:InstanceID>uuid:1</xmpMM:InstanceID></rdf:Description></rdf:RDF></x:xmpmeta>',
    );
    expect(xmp).toEqual({
      'dc:title': 'Report',
      'dc:creator': 'Ada; Grace',
      'pdf:Producer': 'Tool & Co',
      'xmp:CreatorTool': 'Writer',
    });
  });

  test('every kind of fact; XMP that mirrors a changed Info key is reported once', () => {
    const base: CompareFacts = {
      info: { Title: 'Old', Author: 'Ada' },
      xmp: { 'dc:title': 'Old', 'pdfaid:part': '2' },
      pages: [
        { size: { width: 612, height: 792 }, rotation: 0 },
        { size: { width: 612, height: 792 }, rotation: 0 },
      ],
      annotations: [{ Highlight: 1 }, {}],
      formFields: [
        { name: 'name', kind: 'text', value: 'A' },
        { name: 'gone', kind: 'checkbox', value: 'Off' },
      ],
      attachments: ['data.csv'],
      signatures: [{ field: 'Sig1', signed: false }],
    };
    const next: CompareFacts = {
      info: { Title: 'New', Author: 'Ada' },
      xmp: { 'dc:title': 'New' },
      pages: [
        { size: { width: 612, height: 1008 }, rotation: 90 },
        { size: { width: 612, height: 792 }, rotation: 0 },
      ],
      annotations: [{ Highlight: 2, Link: 1 }, {}],
      formFields: [
        { name: 'name', kind: 'text', value: 'B' },
        { name: 'new', kind: 'text', value: '' },
      ],
      attachments: [],
      signatures: [{ field: 'Sig1', signed: true }],
    };
    const pairs: PagePair[] = [
      { a: 0, b: 0, similarity: 1, basis: 'text' },
      { a: 1, b: 1, similarity: 1, basis: 'text' },
    ];
    expect(diffFacts(base, next, pairs)).toEqual([
      { kind: 'metadata', key: 'Title', a: 'Old', b: 'New' },
      { kind: 'xmp', key: 'pdfaid:part', a: '2' },
      { kind: 'page-size', key: 'size', a: '612 × 792 pt', b: '612 × 1008 pt', aPage: 0, bPage: 0 },
      { kind: 'page-rotation', key: 'rotation', a: '0°', b: '90°', aPage: 0, bPage: 0 },
      { kind: 'annotations', key: 'Highlight', a: '1', b: '2', aPage: 0, bPage: 0 },
      { kind: 'annotations', key: 'Link', a: '0', b: '1', aPage: 0, bPage: 0 },
      { kind: 'form-field', key: 'gone', a: 'Off' },
      { kind: 'form-field', key: 'name', a: 'A', b: 'B' },
      { kind: 'form-field', key: 'new', b: '' },
      { kind: 'attachment', key: 'data.csv', a: 'present' },
      { kind: 'signature', key: 'Sig1', a: 'empty signature field', b: 'signed' },
    ]);
    expect(diffFacts(base, base, pairs)).toEqual([]);
  });

  test('facts from engine data', () => {
    const facts = factsFromEngine(
      {
        pages: [{ size: { width: 100, height: 200 }, rotation: 0 }],
        metadata: { title: 'T', policy: 'inherit-first-source', custom: { Dept: 'X' } },
      },
      [
        [
          {
            id: '1',
            kind: 'highlight',
            pageIndex: 0,
            rect: { x: 0, y: 0, width: 1, height: 1 },
            quads: [],
          },
        ],
      ],
      [
        {
          name: 'f',
          kind: 'checkbox',
          pageIndex: 0,
          rect: { x: 0, y: 0, width: 1, height: 1 },
          value: true,
          readOnly: false,
          required: false,
        },
        {
          name: 's',
          kind: 'signature',
          pageIndex: 0,
          rect: { x: 0, y: 0, width: 1, height: 1 },
          readOnly: false,
          required: false,
        },
      ],
    );
    expect(facts).toEqual({
      info: { Title: 'T', Dept: 'X' },
      pages: [{ size: { width: 100, height: 200 }, rotation: 0 }],
      annotations: [{ Highlight: 1 }],
      formFields: [{ name: 'f', kind: 'checkbox', value: 'On' }],
      attachments: [],
      signatures: [{ field: 's', signed: false }],
    });
  });
});
