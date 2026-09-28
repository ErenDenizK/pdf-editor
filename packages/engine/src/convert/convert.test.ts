/**
 * PDF → Markdown / text (spec §4): the golden of markdown-source.pdf (test/fixtures), reading
 * order on the two-column page, and one test per heuristic on synthetic runs.
 */
import { unzipSync, zipSync } from 'fflate';
import type { Rect } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import manifest from '../../../../test/fixtures/manifest.json';
import markdownUrl from '../../../../test/fixtures/markdown-source.pdf?url';
import { createLocalAnalysisBackend } from '../analysis/backend';
import { sid } from '../../test/helpers';
import { createImageHarness, type ImageHarness } from '../image-objects/test-helpers';
import type { ConvertPageInput, Glyph, TextRun } from '../types';
import { convertPages, zipModifiedTime } from './convert';
import { convertDocument, pdfiumConvertSource } from './pipeline';

interface MarkdownExpect {
  readonly golden: string;
  readonly dropped: readonly { page: number; text: string; reason: string }[];
  readonly bodyFontSize: number;
}

const expected = (
  manifest.fixtures.find((f) => f.file === 'markdown-source.pdf')?.expect as unknown as {
    markdown: MarkdownExpect;
  }
).markdown;

let h: ImageHarness;

beforeAll(async () => {
  h = await createImageHarness();
});
afterAll(async () => {
  await h.adapter.destroy();
});

let fixtureCounter = 0;

async function convertFixture(options: Parameters<typeof convertDocument>[2] = {}) {
  const id = sid(`md-${++fixtureCounter}`);
  const opened = await h.adapter.open(id, await (await fetch(markdownUrl)).arrayBuffer());
  const engine = {
    getPageText: h.adapter.getPageText.bind(h.adapter),
    listAnnotations: h.adapter.listAnnotations.bind(h.adapter),
    locateImages: h.editor.locateImages.bind(h.editor),
    extractImage: h.editor.extractImage.bind(h.editor),
  };
  try {
    return await convertDocument(
      createLocalAnalysisBackend(),
      pdfiumConvertSource(engine, id, opened),
      options,
    );
  } finally {
    await h.adapter.close(id);
  }
}

describe('markdown-source.pdf', () => {
  test('converts to the golden Markdown exactly', async () => {
    const result = await convertFixture();
    expect(result.text).toBe(expected.golden);
    expect(result.report.bodyFontSize).toBe(expected.bodyFontSize);
    expect(
      result.report.dropped.map((d) => ({ page: d.page + 1, text: d.text, reason: d.reason })),
    ).toEqual(expected.dropped);
    expect(result.report).toMatchObject({
      headings: 4,
      listItems: 3,
      images: 1,
      links: 1,
      paragraphs: 4,
    });
    expect(result.report.pagesWithoutText).toEqual([]);
    expect(result.files.map((f) => f.path)).toEqual(['document.md', 'images/p1-1.png']);
    const png = result.files[1]!.bytes;
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // The PNG decodes to the image's pixel size (80 × 50).
    const bitmap = await createImageBitmap(new Blob([png.slice()], { type: 'image/png' }));
    expect([bitmap.width, bitmap.height]).toEqual([80, 50]);
    bitmap.close();
    const zip = unzipSync(result.zip!);
    expect(Object.keys(zip).sort()).toEqual(['document.md', 'images/p1-1.png']);
    expect(new TextDecoder().decode(zip['document.md'])).toBe(expected.golden);
  });

  test('plain text keeps the reading order: left column before the right one', async () => {
    const result = await convertFixture({ format: 'text' });
    const page2 = result.pageTexts[1]!;
    expect(page2).toBe(
      'Two columns\n\n' +
        'The left column is read first, from top to bottom, before the reader moves to the right column.\n\n' +
        'The right column comes second. Its lines sit on the same baselines as the left column.\n',
    );
    expect(result.text).not.toContain('](');
    expect(result.text).toContain('• Known text in a known place\n• A documented reason to exist');
    expect(result.files.map((f) => f.path)).toEqual(['document.txt']);
    expect(result.zip).toBeUndefined();
  });

  test('keeps headers and page numbers when asked, per page files and page-break comments', async () => {
    const kept = await convertFixture({ keepHeadersFooters: true, format: 'text' });
    expect(kept.report.dropped).toEqual([]);
    expect(kept.pageTexts[0]!.startsWith('Fixture Handbook\n\n')).toBe(true);
    expect(kept.pageTexts[0]!.trimEnd().endsWith('Page 1')).toBe(true);
    const perPage = await convertFixture({
      scope: 'pages',
      pageBreak: 'comment',
      headerComment: true,
    });
    expect(perPage.files.map((f) => f.path)).toEqual([
      'page-001.md',
      'page-002.md',
      'images/p1-1.png',
    ]);
    expect(perPage.text).toContain('\n\n<!-- page 2 -->\n\n## Two columns');
    expect(perPage.text.startsWith('<!-- Converted from PDF by pdf-editor.')).toBe(true);
    expect(perPage.text).toContain('tables are not detected');
  });
});

// ---------------------------------------------------------------------------
// Heuristics on synthetic runs (Letter page, user space)
// ---------------------------------------------------------------------------

const PAGE = { size: { width: 612, height: 792 }, rotation: 0 as const };

/** A run of `text` at (x, y) in `size` pt Helvetica(-Bold): monospaced glyph boxes. */
function run(text: string, x: number, y: number, size = 11, font = 'Helvetica'): TextRun {
  const advance = size * 0.5;
  const glyphs: Glyph[] = [];
  let cx = x;
  for (const ch of text) {
    if (ch !== ' ')
      glyphs.push({
        text: ch,
        rect: { x: cx, y, width: advance, height: size },
        fontSize: size,
        fontName: font,
      });
    cx += advance;
  }
  const rect: Rect = { x, y, width: cx - x, height: size };
  return { text, rect, glyphs };
}

function page(runs: TextRun[], extra: Partial<ConvertPageInput> = {}): ConvertPageInput {
  return { ...PAGE, runs, ...extra };
}

async function md(pages: ConvertPageInput[], options = {}): Promise<string> {
  return (await convertPages(pages, options)).text;
}

describe('heuristics', () => {
  test('headings by size relative to the body, bold standalone lines one level below', async () => {
    const text = await md([
      page([
        run('Big title', 72, 700, 20, 'Helvetica-Bold'),
        run('Body text that is long enough to be the body size.', 72, 670),
        run('More body text on a second paragraph line here.', 72, 640),
        run('Bold aside', 72, 610, 11, 'Helvetica-Bold'),
        run('Closing body line with enough characters in it.', 72, 580),
      ]),
    ]);
    expect(text).toBe(
      '# Big title\n\nBody text that is long enough to be the body size.\n\n' +
        'More body text on a second paragraph line here.\n\n## Bold aside\n\n' +
        'Closing body line with enough characters in it.\n',
    );
  });

  test('line-end hyphens: a soft marker joins, a hard hyphen joins before lower case only', async () => {
    const soft = run('A word broken with a soft hy', 72, 700);
    const marker: Glyph = {
      text: '',
      rect: { x: 300, y: 700, width: 4, height: 11 },
      fontSize: 11,
    };
    const text = await md([
      page([
        { ...soft, glyphs: [...soft.glyphs, marker] },
        run('phen and a hard hyph-', 72, 686),
        run('en and a name like Jean-', 72, 672),
        run('Paul at the end.', 72, 658),
      ]),
    ]);
    expect(text).toBe(
      'A word broken with a soft hyphen and a hard hyphen and a name like Jean-Paul at the end.\n',
    );
    const kept = await md([page([run('hard hyph-', 72, 700), run('en here', 72, 686)])], {
      joinHyphens: false,
    });
    expect(kept).toBe('hard hyph- en here\n');
  });

  test('bulleted and numbered lists, nested by indent, wrapped items joined', async () => {
    const text = await md([
      page([
        run('• First item', 72, 700),
        run('◦ Nested item', 90, 686),
        run('– Nested too, wrapping onto', 90, 672),
        run('a second line', 100, 658),
        run('• Back out', 72, 644),
        run('1. One', 72, 610),
        run('2. Two', 72, 596),
        run('a) Letter item', 90, 582),
      ]),
    ]);
    expect(text).toBe(
      '- First item\n  - Nested item\n  - Nested too, wrapping onto a second line\n- Back out\n\n' +
        '1. One\n2. Two\n   - a) Letter item\n',
    );
  });

  test('link annotations over text become Markdown links', async () => {
    const text = await md([
      page([run('See the site for details.', 72, 700)], {
        links: [
          {
            rect: { x: 72 + 8 * 5.5, y: 699, width: 4 * 5.5, height: 12 },
            uri: 'https://example.org/a b',
          },
        ],
      }),
    ]);
    expect(text).toBe('See the [site](<https://example.org/a b>) for details.\n');
  });

  test('columns on shared baselines are read column by column', async () => {
    const left = ['Left one', 'Left two', 'Left three'];
    const right = ['Right one', 'Right two', 'Right three'];
    const runs = left.flatMap((l, i) => [
      run(l, 72, 700 - 14 * i),
      run(right[i]!, 330, 700 - 14 * i),
    ]);
    const text = await md([page(runs)], { format: 'text' });
    expect(text).toBe('Left one Left two Left three\n\nRight one Right two Right three\n');
  });

  test('running headers, footers and page numbers are dropped across pages', async () => {
    const pages = [1, 2, 3].map((n) =>
      page([
        run('Annual Report 2026', 72, 760, 9),
        run(`Body of page ${n} with some words.`, 72, 600),
        run(`${n} / 3`, 290, 30, 9),
      ]),
    );
    const result = await convertPages(pages, { format: 'text' });
    expect(result.pageTexts).toEqual([1, 2, 3].map((n) => `Body of page ${n} with some words.\n`));
    expect(result.report.dropped.map((d) => d.reason)).toEqual([
      'running-header',
      'page-number',
      'running-header',
      'page-number',
      'running-header',
      'page-number',
    ]);
  });

  test('empty pages are reported for OCR, markdown is escaped, tables are counted', async () => {
    const table = [0, 1, 2, 3].flatMap((r) => [
      run(`Cell ${r}a`, 72, 600 - 14 * r),
      run(`Cell ${r}b`, 200, 600 - 14 * r),
      run(`Cell ${r}c`, 330, 600 - 14 * r),
    ]);
    const result = await convertPages([
      page([]),
      page([run('# not a heading *really* [x]', 72, 700), ...table]),
    ]);
    expect(result.report.pagesWithoutText).toEqual([0]);
    expect(result.report.suspectedTables).toBe(1);
    expect(result.text.startsWith('\\# not a heading \\*really\\* \\[x\\]\n')).toBe(true);
  });

  test('rotated pages are read in display orientation', async () => {
    // /Rotate 90: user-space lines stacked left to right read top to bottom on screen.
    const runs = [run('Second line', 110, 300), run('First line', 80, 300)];
    const vertical = runs.map((r) => ({
      ...r,
      // Text drawn upright on the displayed page: user x grows downwards on screen.
      rect: { x: r.rect.x, y: r.rect.y, width: r.rect.height, height: r.rect.width },
      glyphs: r.glyphs.map((g, i) => ({
        ...g,
        rect: { x: r.rect.x, y: 300 + i * 5.5, width: 11, height: 5.5 },
      })),
    }));
    const result = await convertPages(
      [{ size: { width: 612, height: 792 }, rotation: 90, runs: vertical }],
      {
        format: 'text',
      },
    );
    expect(result.text).toBe('First line\n\nSecond line\n');
  });
});

// ---------------------------------------------------------------------------
// ZIP timestamps in every time zone (M5 review finding 4)
// ---------------------------------------------------------------------------

/** Local-field getters fflate reads to write an entry's MS-DOS date and time. */
const LOCAL_GETTERS = ['FullYear', 'Month', 'Date', 'Hours', 'Minutes', 'Seconds'] as const;

/**
 * Runs `fn` as if the browser were in a zone `offset` minutes behind UTC (`getTimezoneOffset`
 * sign). Vitest browser mode cannot set `TZ`, so the local getters are redirected for the
 * duration: each reads the UTC field of the instant shifted by the offset, which is what the
 * local field is in such a zone, and `getTimezoneOffset` returns the offset. Only these are
 * replaced, and they are restored afterwards.
 */
async function inTimeZone<T>(offset: number, fn: () => T | Promise<T>): Promise<T> {
  const proto = Date.prototype as unknown as Record<string, (this: Date) => number>;
  const names = [...LOCAL_GETTERS.map((name) => `get${name}`), 'getTimezoneOffset'];
  const saved = names.map((name) => [name, proto[name]!] as const);
  for (const name of LOCAL_GETTERS) {
    const utc = proto[`getUTC${name}`]!;
    proto[`get${name}`] = function (this: Date) {
      return utc.call(new Date(this.getTime() - offset * 60_000));
    };
  }
  proto.getTimezoneOffset = () => offset;
  try {
    return await fn();
  } finally {
    for (const [name, getter] of saved) proto[name] = getter;
  }
}

/** MS-DOS date and time of the first local file header (offsets 10 and 12). */
function firstEntryStamp(zip: Uint8Array): { date: string; time: string } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  const time = view.getUint16(10, true);
  const date = view.getUint16(12, true);
  const two = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${(date >> 9) + 1980}-${two((date >> 5) & 15)}-${two(date & 31)}`,
    time: `${two(time >> 11)}:${two((time >> 5) & 63)}:${two((time & 31) * 2)}`,
  };
}

describe('ZIP timestamps', () => {
  // New York (+300), Hawaii (+600), Baker Island (+720), UTC, Tokyo (−540), Kiribati (−840).
  const OFFSETS = [300, 600, 720, 0, -540, -840];

  test('the fixed time is 1980-01-01 12:00 local in zones on both sides of UTC', () => {
    for (const offset of OFFSETS) {
      const local = new Date(zipModifiedTime(offset).getTime() - offset * 60_000);
      expect(local.toISOString()).toBe('1980-01-01T12:00:00.000Z');
    }
    // The runner's own zone: the default offset gives the same wall-clock time.
    const here = zipModifiedTime();
    expect([here.getFullYear(), here.getMonth(), here.getDate(), here.getHours()]).toEqual([
      1980, 0, 1, 12,
    ]);
  });

  test('fflate writes the same entry stamp in every zone; the old UTC midnight threw behind UTC', async () => {
    const entries = { 'a.txt': new TextEncoder().encode('a') };
    for (const offset of OFFSETS) {
      const stamp = await inTimeZone(offset, () =>
        firstEntryStamp(zipSync(entries, { mtime: zipModifiedTime(offset) })),
      );
      expect(stamp).toEqual({ date: '1980-01-01', time: '12:00:00' });
    }
    // What the review found: 1980-01-01T00:00Z is 1979-12-31 in New York.
    await expect(
      inTimeZone(300, () => zipSync(entries, { mtime: new Date('1980-01-01T00:00:00Z') })),
    ).rejects.toThrow(/date not in range/);
  });

  test('a Markdown export with an image zips in a zone behind UTC', async () => {
    const rgba = { width: 2, height: 2, data: new Uint8Array(16).fill(200) };
    const input = page([run('Text beside a picture.', 72, 700)], {
      images: [{ rect: { x: 72, y: 500, width: 100, height: 100 }, rgba }],
    });
    for (const offset of [300, -540]) {
      // `ConvertSession.finish` reads the zone's offset itself (the default of
      // `zipModifiedTime`), inside the simulated zone.
      const result = await inTimeZone(offset, () => convertPages([input]));
      expect(result.zip).toBeDefined();
      expect(firstEntryStamp(result.zip!)).toEqual({ date: '1980-01-01', time: '12:00:00' });
      expect(Object.keys(unzipSync(result.zip!)).sort()).toEqual([
        'document.md',
        'images/p1-1.png',
      ]);
    }
  });
});
