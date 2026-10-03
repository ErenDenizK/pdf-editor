/**
 * Paragraph detection (spec craft §4.1–§4.2, research 11 §3): goldens on the text-edit corpus
 * (test/fixtures/text-edit-corpus/, built by tools/fixtures/text-edit-corpus.ts) and the
 * older fixtures, rules on synthetic pages (indents, lists, alignment, drop caps, rotated and
 * invisible text, tags that fail the contiguity check), the cache and the worker proxy.
 */
import { PDFDocument, PDFName, type PDFObject, type PDFRef } from '@cantoo/pdf-lib';
import type { SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import markdownUrl from '../../../../test/fixtures/markdown-source.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import taggedUrl from '../../../../test/fixtures/tagged.pdf?url';
import corpusCaptionsUrl from '../../../../test/fixtures/text-edit-corpus/captions.pdf?url';
import latexUrl from '../../../../test/fixtures/text-edit-corpus/latex-justified.pdf?url';
import tableUrl from '../../../../test/fixtures/text-edit-corpus/table.pdf?url';
import titleUrl from '../../../../test/fixtures/text-edit-corpus/title-date.pdf?url';
import twoColumnUrl from '../../../../test/fixtures/text-edit-corpus/two-column.pdf?url';
import wordUrl from '../../../../test/fixtures/text-edit-corpus/word-tagged.pdf?url';
import { sid, toBuffer, wasmUrl } from '../../test/helpers';
import type { LocatedRun, ParagraphBlock } from '../types';
import { createPdfiumProxy } from '../worker/pdfium-proxy';
import { detectParagraphs, fontFamily, runRefusal } from './blocks';
import { createHarness, fixture, type Harness, runWith, span } from './test-helpers';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.adapter.destroy();
});

async function analyse(url: string, pageIndex = 0): Promise<readonly ParagraphBlock[]> {
  const id = await h.open(await fixture(url));
  const blocks = await h.editor.analyzeParagraphs(id, pageIndex);
  const runs = await h.editor.locateRuns(id, pageIndex);
  checkInvariants(blocks, runs);
  return blocks;
}

/**
 * What every analysis must hold: refs index the page's runs, spans are glyph slices of them
 * with their text, line offsets point into the paragraph text, blocks are numbered in order.
 */
function checkInvariants(blocks: readonly ParagraphBlock[], runs: readonly LocatedRun[]): void {
  blocks.forEach((block, index) => {
    expect(block.ref.index).toBe(index);
    for (const ref of block.ref.runs) {
      const run = runs.find(
        (r) => r.charStart === ref.charStart && r.objectPath.join('/') === ref.objectPath.join('/'),
      );
      expect(run?.text).toBe(ref.text);
    }
    for (const line of block.lines) {
      for (const s of line.spans) {
        const ref = block.ref.runs[s.run];
        const run = runs.find((r) => r.charStart === ref?.charStart);
        expect(run).toBeDefined();
        expect(s.glyphEnd).toBeLessThanOrEqual(run?.glyphs.length ?? 0);
        const raw = (run?.glyphs ?? [])
          .slice(s.glyphStart, s.glyphEnd)
          .map((g) => (g.text === '\u0002' ? '-' : g.text))
          .join('');
        expect(s.text).toBe(raw);
      }
      const shown = line.end === 'joined' ? line.text.slice(0, -1) : line.text;
      expect(block.text.slice(line.start, line.start + shown.length)).toBe(shown);
    }
  });
}

const lineCounts = (blocks: readonly ParagraphBlock[]) => blocks.map((b) => b.lines.length);

describe('corpus goldens', () => {
  test('word-tagged.pdf (Chromium, tagged): heading, two paragraphs, a list from the tags', async () => {
    const blocks = await analyse(wordUrl);
    expect(blocks.map((b) => b.source)).toEqual(Array(6).fill('tags'));
    expect(blocks.map((b) => b.tag)).toEqual(['H1', 'P', 'P', 'LI', 'LI', 'LI']);
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
      'list-item',
      'list-item',
      'list-item',
    ]);
    expect(lineCounts(blocks)).toEqual([1, 3, 3, 1, 2, 1]);
    expect(blocks.map((b) => b.align)).toEqual(Array(6).fill('left'));
    expect(blocks[0]?.text).toBe('Harbour notes');
    expect(blocks[1]?.text).toMatch(
      /^The ferry left the quay at dawn, .* chimneys under a pale sky\.$/,
    );
    expect(blocks[4]?.text).toMatch(/^Keep the logbook dry, .* harbour office\.$/);
    // 11 pt at a line height of 1.35.
    for (const b of blocks.slice(1)) expect(b.leading).toBeCloseTo(14.85, 0);
    expect(blocks[1]?.size).toBeCloseTo(11, 1);
  });

  test('latex-justified.pdf (untagged, TJ without spaces): justified, indented, de-hyphenated, ligatures', async () => {
    const blocks = await analyse(latexUrl);
    expect(blocks.map((b) => b.source)).toEqual(['geometry', 'geometry', 'geometry']);
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'paragraph']);
    expect(lineCounts(blocks)).toEqual([1, 6, 5]);
    expect(blocks.map((b) => b.align)).toEqual(['left', 'justify', 'justify']);
    const [, first, second] = blocks as [ParagraphBlock, ParagraphBlock, ParagraphBlock];
    expect(first.leading).toBeCloseTo(13, 2);
    expect(first.indent).toBeCloseTo(15, 1);
    expect(first.measure.left).toBeCloseTo(100, 1);
    expect(first.measure.right).toBeCloseTo(450, 1);
    // Word gaps come from the ink (no space glyphs); fi/fl are ligature glyphs.
    const text = first.text.normalize('NFKC');
    expect(text).toMatch(/^The tidal gauge at the western jetty was installed in the spring/);
    expect(text).toContain('confirmed what the fishermen');
    expect(text).toContain('A simple float and pulley');
    expect(second.text.normalize('NFKC')).toContain('short oscillations that the float');
    // Hyphenated line ends are joined: no "-" left before a lower-case word.
    for (const b of [first, second]) {
      expect(b.text).not.toMatch(/\p{L}- ?\p{Ll}/u);
      expect(b.lines.some((l) => l.end === 'joined' && l.endsWithHyphen)).toBe(true);
    }
    expect(first.lines.at(-1)?.end).toBe('end');
  });

  test('two-column.pdf (untagged): title, then two columns of justified paragraphs, left first', async () => {
    const blocks = await analyse(twoColumnUrl);
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
    ]);
    expect(lineCounts(blocks)).toEqual([1, 5, 6, 5, 5]);
    expect(blocks.slice(1).map((b) => b.align)).toEqual(Array(4).fill('justify'));
    expect(blocks.every((b) => b.source === 'geometry')).toBe(true);
    const [, a, b, c, d] = blocks as ParagraphBlock[];
    expect(a?.text).toMatch(/^Every autumn the members of the orchard cooperative/);
    expect(c?.text).toMatch(/^In the afternoon the cider press/);
    // Columns: the left column's paragraphs end before the right column's begin.
    for (const left of [a, b]) {
      for (const right of [c, d]) {
        expect((left?.measure.right ?? 0) < (right?.measure.left ?? 0)).toBe(true);
      }
    }
    expect(b?.leading).toBeCloseTo(a?.leading ?? 0, 2);
  });

  test('captions.pdf (untagged): the caption under the figure is its own block', async () => {
    const blocks = await analyse(corpusCaptionsUrl);
    expect(lineCounts(blocks)).toEqual([2, 1, 2]);
    expect(blocks[1]?.text).toBe(
      'Figure 1. The river bed at the northern ford, seen from the survey post on the eastern bank.',
    );
    expect(blocks[1]?.size).toBeLessThan((blocks[0]?.size ?? 0) * 0.9);
    expect(blocks.map((b) => b.align)).toEqual(['left', 'left', 'left']);
    expect(blocks[0]?.leading).toBeCloseTo(14.85, 0);
  });

  test('title-date.pdf (untagged): a centred title and a right-aligned date', async () => {
    const blocks = await analyse(titleUrl);
    expect(blocks.map((b) => b.align)).toEqual(['center', 'right', 'left', 'left']);
    expect(blocks.map((b) => b.text.slice(0, 20))).toEqual([
      'Minutes of the Lante',
      '12 March 2024',
      'The meeting opened w',
      'Members agreed to re',
    ]);
    expect(blocks[0]?.kind).toBe('heading');
    expect(lineCounts(blocks)).toEqual([1, 1, 3, 2]);
  });

  test('table.pdf (untagged): one box per cell between two paragraphs', async () => {
    const blocks = await analyse(tableUrl);
    expect(blocks).toHaveLength(22);
    expect(blocks[0]?.kind).toBe('paragraph');
    expect(blocks.at(-1)?.kind).toBe('paragraph');
    const cells = blocks.filter((b) => b.kind === 'cell');
    expect(cells).toHaveLength(20);
    expect(cells.every((b) => b.lines.length === 1)).toBe(true);
    expect(new Set(cells.map((b) => b.text))).toEqual(
      new Set([
        'Day',
        'North pier',
        'Old quay',
        'Ferry slip',
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        '06:12',
        '06:20',
        '06:31',
        '06:58',
        '07:05',
        '07:17',
        '07:41',
        '07:49',
        '08:02',
        '08:25',
        '08:33',
        '08:44',
      ]),
    );
  });
});

describe('older fixtures', () => {
  test('tagged.pdf: the tagged paragraph from the tags, the untagged footer from geometry', async () => {
    for (const page of [0, 1]) {
      const blocks = await analyse(taggedUrl, page);
      expect(blocks.map((b) => [b.source, b.text])).toEqual([
        ['tags', `Tagged paragraph on page ${page + 1} of tagged.`],
        ['geometry', `PAGE ${page + 1} OF tagged`],
      ]);
    }
  });

  test('simple-text.pdf: three single lines, the large one a heading', async () => {
    const blocks = await analyse(simpleUrl);
    expect(blocks.map((b) => b.text)).toEqual([
      'PAGE 1 OF simple-text',
      'This is page 1 of a three-page US Letter document set in Helvetica.',
      'The quick brown fox jumps over the lazy dog.',
    ]);
    expect(blocks[0]?.kind).toBe('heading');
    expect(blocks.every((b) => b.source === 'geometry' && b.align === 'left')).toBe(true);
  });

  test('markdown-source.pdf: list items keep their bullets; page 2 has two columns on shared baselines', async () => {
    const page1 = await analyse(markdownUrl, 0);
    const items = page1.filter((b) => b.kind === 'list-item');
    expect(items.map((b) => b.text)).toEqual([
      '• Known text in a known place',
      '• A documented reason to exist',
      '• A size of a few kilobytes',
    ]);
    expect(items.every((b) => b.marker === '•')).toBe(true);
    const page2 = await analyse(markdownUrl, 1);
    const left = page2.find((b) => b.text.startsWith('The left column'));
    const right = page2.find((b) => b.text.startsWith('The right column'));
    expect(left?.text).toBe(
      'The left column is read first, from top to bottom, before the reader moves to the right column.',
    );
    expect(right?.text).toBe(
      'The right column comes second. Its lines sit on the same baselines as the left column.',
    );
    expect(left?.lines).toHaveLength(3);
    expect(right?.lines).toHaveLength(3);
    expect((left?.measure.right ?? 0) < (right?.measure.left ?? 0)).toBe(true);
    expect(page2.indexOf(left as ParagraphBlock)).toBeLessThan(
      page2.indexOf(right as ParagraphBlock),
    );
  });
});

// ---------------------------------------------------------------------------
// Synthetic pages
// ---------------------------------------------------------------------------

const esc = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);
const tj = (x: number, y: number, text: string, size = 10, font = 'F1') =>
  `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${esc(text)}) Tj ET`;

/** A Letter page with Helvetica (F1) and Helvetica-Bold (F2) and the given content. */
async function page(content: string[], tags?: (doc: PDFDocument) => void): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const p = doc.addPage([612, 792]);
  const font = (base: string) =>
    ctx.register(
      ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: base, Encoding: 'WinAnsiEncoding' }),
    );
  p.node.set(
    PDFName.of('Resources'),
    ctx.obj({ Font: { F1: font('Helvetica'), F2: font('Helvetica-Bold') } }),
  );
  p.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(content.join('\n'))));
  tags?.(doc);
  return toBuffer(await doc.save({ useObjectStreams: false }));
}

async function blocksOf(bytes: ArrayBuffer): Promise<readonly ParagraphBlock[]> {
  const id = await h.open(bytes);
  const blocks = await h.editor.analyzeParagraphs(id, 0);
  checkInvariants(blocks, await h.editor.locateRuns(id, 0));
  return blocks;
}

const LONG = [
  'Morning light came over the hills and the valley woke slowly, one',
  'farm after another, until the bells of the small chapel rang out',
  'across the fields and the first carts rolled down toward the town',
  'where the market stalls were already being set out in neat rows.',
];

describe('geometry rules', () => {
  test('a first-line indent starts each paragraph; no gap is needed between them', async () => {
    const lines = [
      tj(87, 700, LONG[0] as string),
      tj(72, 688, LONG[1] as string),
      tj(72, 676, 'short last line.'),
      tj(87, 664, LONG[2] as string),
      tj(72, 652, LONG[3] as string),
    ];
    const blocks = await blocksOf(await page(lines));
    expect(lineCounts(blocks)).toEqual([3, 2]);
    expect(blocks[0]?.indent).toBeCloseTo(15, 0);
    expect(blocks[0]?.leading).toBeCloseTo(12, 2);
    expect(blocks[0]?.measure.left).toBeCloseTo(72, 0);
  });

  test('a short line followed by a line whose first word would have fitted ends the paragraph', async () => {
    const lines = [
      tj(72, 700, LONG[0] as string),
      tj(72, 688, 'a short end.'),
      tj(72, 676, LONG[2] as string),
      tj(72, 664, LONG[3] as string),
    ];
    expect(lineCounts(await blocksOf(await page(lines)))).toEqual([2, 2]);
  });

  test('a list: markers start items, a hanging indent continues one', async () => {
    const lines = [
      tj(72, 700, '1. The first item is long enough that its text wraps onto a'),
      tj(86, 688, 'second line set under the text, not under the marker.'),
      tj(72, 676, '2. The second item.'),
      tj(72, 664, '3. The third item.'),
    ];
    const blocks = await blocksOf(await page(lines));
    expect(lineCounts(blocks)).toEqual([2, 1, 1]);
    expect(blocks.map((b) => b.kind)).toEqual(['list-item', 'list-item', 'list-item']);
    expect(blocks.map((b) => b.marker)).toEqual(['1.', '2.', '3.']);
    expect(blocks[0]?.indent).toBeLessThan(0.5);
  });

  test('centred and right-aligned paragraphs', async () => {
    const width = (s: string) => s.length * 5; // rough Helvetica 10 pt
    const centred = [
      'A centred verse line',
      'and its somewhat longer partner line',
      'then a short one',
    ];
    const right = ['Right aligned text ends', 'at the same edge on', 'every single line here'];
    const lines = [
      ...centred.map((s, i) => tj(306 - width(s) / 2, 700 - 12 * i, s)),
      ...right.map((s, i) => tj(0, 600 - 12 * i, s)),
    ];
    // Right-aligned lines: place each so that its advance ends at x = 540.
    const id = await h.open(await page(lines));
    const runs = await h.editor.locateRuns(id, 0);
    const ends = runs.slice(3).map((r) => r.lineBox.x + r.lineBox.width);
    const shifted = right.map((s, i) => tj(540 - (ends[i] ?? 0), 600 - 12 * i, s));
    const centredMeasured = runs.slice(0, 3).map((r, i) => {
      const w = r.lineBox.width;
      return tj(306 - w / 2, 700 - 12 * i, centred[i] as string);
    });
    const blocks = await blocksOf(await page([...centredMeasured, ...shifted]));
    expect(lineCounts(blocks)).toEqual([3, 3]);
    expect(blocks.map((b) => b.align)).toEqual(['center', 'right']);
  });

  test('a superscript stays in its line', async () => {
    const lines = [
      tj(72, 700, 'A sentence with a note marker'),
      tj(213, 704, '1', 6),
      tj(219, 700, ' and the rest of the sentence after it.'),
    ];
    const blocks = await blocksOf(await page(lines));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lines).toHaveLength(1);
    expect(blocks[0]?.text).toContain('marker');
  });

  test('a drop cap is attached to its paragraph, which is refused', async () => {
    const lines = [
      tj(72, 640, 'L', 40),
      tj(104, 666, 'orem ipsum is what the printers called the filler text set'),
      tj(104, 654, 'in their sample books, a scrambled passage of an old Latin'),
      tj(104, 642, 'essay that let a customer judge the type without reading'),
      tj(72, 630, 'the words themselves, which is why it still appears in the drafts'),
      tj(72, 618, 'of designers and the templates of word processors today.'),
    ];
    const blocks = await blocksOf(await page(lines));
    expect(blocks).toHaveLength(1);
    const [block] = blocks as [ParagraphBlock];
    expect(block.refusal).toBe('drop-cap');
    expect(block.dropCap?.text).toBe('L');
    expect(block.lines).toHaveLength(5);
    expect(block.text).toMatch(/^Lorem ipsum is what the printers/);
  });

  test('rotated text reads in its own frame; invisible text is refused apart', async () => {
    // Turned 90° anticlockwise: the next line is further right on the page.
    const rotated = (y: number, text: string) =>
      `BT /F1 10 Tf 0 1 -1 0 ${y} 100 Tm (${text}) Tj ET`;
    const lines = [
      rotated(500, LONG[0] as string),
      rotated(512, LONG[1] as string),
      `BT 3 Tr /F1 10 Tf 1 0 0 1 72 700 Tm (Invisible words from a scan) Tj ET`,
    ];
    const blocks = await blocksOf(await page(lines));
    const turned = blocks.find((b) => b.text.startsWith('Morning'));
    expect(turned?.direction.x).toBeCloseTo(0, 6);
    expect(turned?.direction.y).toBeCloseTo(1, 6);
    expect(turned?.lines).toHaveLength(2);
    expect(turned?.leading).toBeCloseTo(12, 2);
    expect(turned?.measure.left).toBeCloseTo(100, 0);
    expect(turned?.refusal).toBeUndefined();
    const hidden = blocks.find((b) => b.text.startsWith('Invisible'));
    expect(hidden?.refusal).toBe('invisible');
  });

  test('a tagged group whose lines are not contiguous falls back to geometry', async () => {
    const content = [
      `/P <</MCID 0>> BDC ${tj(72, 700, LONG[0] as string)} EMC`,
      `/P <</MCID 1>> BDC ${tj(72, 688, LONG[1] as string)} EMC`,
      `/P <</MCID 2>> BDC ${tj(72, 676, LONG[2] as string)} EMC`,
    ];
    const bytes = await page(content, (doc) => {
      const ctx = doc.context;
      const pg = doc.getPage(0).ref;
      doc.getPage(0).node.set(PDFName.of('StructParents'), ctx.obj(0));
      const root = ctx.nextRef();
      const documentRef = ctx.nextRef();
      const split = ctx.nextRef();
      const middle = ctx.nextRef();
      const element = (ref: PDFRef, parent: PDFRef, k: PDFObject, s = 'P') =>
        ctx.assign(ref, ctx.obj({ Type: 'StructElem', S: s, P: parent, Pg: pg, K: k }));
      element(documentRef, root, ctx.obj([split, middle]), 'Document');
      // One /P owns the first and the third line; another the line between them.
      element(split, documentRef, ctx.obj([0, 2]));
      element(middle, documentRef, ctx.obj(1));
      ctx.assign(
        root,
        ctx.obj({
          Type: 'StructTreeRoot',
          K: documentRef,
          ParentTree: ctx.obj({ Nums: [0, [split, middle, split]] }),
          ParentTreeNextKey: 1,
        }),
      );
      doc.catalog.set(PDFName.of('StructTreeRoot'), root);
      doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
    });
    const blocks = await blocksOf(bytes);
    // The middle /P is contiguous and wins; the split one falls back, its lines alone.
    expect(blocks.map((b) => [b.source, b.lines.length])).toEqual([
      ['geometry', 1],
      ['tags', 1],
      ['geometry', 1],
    ]);
    expect(blocks[1]?.text).toBe(LONG[1]);
  });
});

describe('pure helpers', () => {
  test('font families ignore subset tags and style suffixes', () => {
    expect(fontFamily('ABCDEF+TimesNewRomanPS-BoldMT')).toBe('timesnewroman');
    expect(fontFamily('Times-Roman')).toBe('times');
    expect(fontFamily('ArialMT')).toBe(fontFamily('Arial-BoldMT'));
    expect(fontFamily('Helvetica')).toBe(fontFamily('Helvetica-Oblique'));
  });

  test('refusals follow the run blockers; a vertical run is one refused block', async () => {
    const id = await h.open(await page([tj(72, 700, 'Plain words')]));
    const [run] = (await h.editor.locateRuns(id, 0)) as [LocatedRun];
    expect(runRefusal(run)).toBeUndefined();
    expect(runRefusal({ ...run, renderMode: 3 })).toBe('invisible');
    expect(runRefusal({ ...run, font: { ...run.font, kind: 'type3' } })).toBe('type3');
    expect(runRefusal({ ...run, objectPath: [0, 0, 0] })).toBe('nested-form');
    const vertical = { ...run, vertical: true };
    expect(runRefusal(vertical)).toBe('vertical');
    const blocks = detectParagraphs([vertical], [], { width: 612, height: 792, rotation: 0 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ refusal: 'vertical', text: 'Plain words' });
    expect(detectParagraphs([], [], { width: 612, height: 792, rotation: 0 })).toEqual([]);
  });
});

describe('analyzeParagraphs', () => {
  test('is cached per page state: the same page reuses it, an edit renews it', async () => {
    const id = await h.open(
      await page([tj(72, 700, LONG[0] as string), tj(72, 688, LONG[1] as string)]),
    );
    const first = await h.editor.analyzeParagraphs(id, 0);
    expect(await h.editor.analyzeParagraphs(id, 0)).toBe(first);
    const run = await runWith(h, id, 0, 'Morning');
    await h.editor.applyTextEdit({
      run,
      ...span(run, 'Morning'),
      replacement: 'Evening',
      tier: 'auto',
      fit: 'overflow',
    });
    const after = await h.editor.analyzeParagraphs(id, 0);
    expect(after).not.toBe(first);
    expect(after[0]?.text).toMatch(/^Evening light came over the hills/);
    expect(after[0]?.lines).toHaveLength(2);
  });

  test('crosses the worker through the proxy', async () => {
    const worker = new Worker(new URL('../worker/pdfium.worker.ts', import.meta.url), {
      type: 'module',
      name: 'pdfium paragraphs test',
    });
    const proxy = createPdfiumProxy(worker, { wasmUrl });
    try {
      const id: SourceId = sid('paragraphs-proxy');
      await proxy.open(id, await fixture(latexUrl));
      const blocks = await proxy.analyzeParagraphs(id, 0);
      expect(lineCounts(blocks)).toEqual([1, 6, 5]);
      expect(blocks[1]?.align).toBe('justify');
    } finally {
      await proxy.destroy();
    }
  });
});
