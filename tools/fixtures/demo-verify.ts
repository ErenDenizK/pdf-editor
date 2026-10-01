/**
 * Verifier checks for the M7 demo fixtures (called from verify.ts). Text drawn with the
 * Type0 / Identity-H subsets is decoded through each font's own /ToUnicode CMap, written
 * here independently of the generator, so the checks see what a text extractor sees:
 * the footer on every page, headings, the sensitive-data targets, the table, the chart
 * bars, and the exact differences between the two report versions.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  type PDFObject,
  type PDFPage,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import { type Box, FIXTURES_DIR, type ManifestEntry } from './lib/common.ts';
import type { Check } from './m5-verify.ts';

const N = (value: string) => PDFName.of(value);
const SUBSET_FONT = /^[A-Z]{6}\+(Inter-Regular|Inter-Bold|NotoSerif-Regular)$/;

function resolve(doc: PDFDocument, obj: PDFObject | undefined): PDFObject | undefined {
  return obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
}

function dictOf(doc: PDFDocument, obj: PDFObject | undefined): PDFDict | undefined {
  const r = resolve(doc, obj);
  return r instanceof PDFDict ? r : r instanceof PDFRawStream ? r.dict : undefined;
}

function streamText(doc: PDFDocument, obj: PDFObject | undefined): string {
  const r = resolve(doc, obj);
  if (r instanceof PDFArray)
    return r
      .asArray()
      .map((o) => streamText(doc, o))
      .join('\n');
  if (r instanceof PDFRawStream)
    return Buffer.from(decodePDFRawStream(r).decode()).toString('latin1');
  return '';
}

function content(doc: PDFDocument, page: PDFPage | undefined): string {
  return page ? streamText(doc, page.node.get(N('Contents'))) : '';
}

/** bfchar entries of a /ToUnicode CMap: 2-byte code (hex) -> text. */
function toUnicode(doc: PDFDocument, font: PDFDict | undefined): Map<string, string> {
  const map = new Map<string, string>();
  const cmap = streamText(doc, font?.get(N('ToUnicode')));
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      const dst = m[2] ?? '';
      const units: number[] = [];
      for (let i = 0; i + 4 <= dst.length; i += 4)
        units.push(Number.parseInt(dst.slice(i, i + 4), 16));
      map.set((m[1] ?? '').toUpperCase(), String.fromCharCode(...units));
    }
  }
  return map;
}

interface Shown {
  baseFont: string;
  size: number;
  x: number;
  y: number;
  text: string;
}

/** Every Tj on the page, decoded; the generator writes one operator per line. */
function shownText(doc: PDFDocument, page: PDFPage | undefined): Shown[] {
  if (!page) return [];
  const fonts = dictOf(doc, page.node.Resources()?.get(N('Font')));
  const cache = new Map<string, { baseFont: string; cmap: Map<string, string> }>();
  const fontInfo = (key: string) => {
    let info = cache.get(key);
    if (!info) {
      const dict = dictOf(doc, fonts?.get(N(key)));
      info = {
        baseFont:
          resolve(doc, dict?.get(N('BaseFont')))
            ?.toString()
            .slice(1) ?? '',
        cmap: toUnicode(doc, dict),
      };
      cache.set(key, info);
    }
    return info;
  };
  const shown: Shown[] = [];
  let font = '';
  let size = 0;
  let [x, y] = [0, 0];
  for (const line of content(doc, page).split('\n')) {
    const tf = /^\/(\S+) ([\d.]+) Tf$/.exec(line);
    const tm = /^1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm$/.exec(line);
    const tj = /^<([0-9A-Fa-f]*)> Tj$/.exec(line);
    if (tf) [font, size] = [tf[1] ?? '', Number(tf[2])];
    else if (tm) [x, y] = [Number(tm[1]), Number(tm[2])];
    else if (tj) {
      const info = fontInfo(font);
      const hex = (tj[1] ?? '').toUpperCase();
      let text = '';
      for (let i = 0; i + 4 <= hex.length; i += 4)
        text += info.cmap.get(hex.slice(i, i + 4)) ?? '�';
      shown.push({ baseFont: info.baseFont, size, x, y, text });
    }
  }
  return shown;
}

/** [x, y, w, h] of every `x y w h re` in a content stream. */
function rects(stream: string): Box[] {
  return [...stream.matchAll(/^(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re$/gm)].map(
    (m) => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as Box,
  );
}

const sameBox = (a: Box, b: Box) => a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) <= 0.01);

/** ISO 13616 mod-97 check, independent of the app's finder. */
function ibanValid(value: string): boolean {
  const compact = value.replace(/\s/g, '');
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** Lines present in `a` but not in `b` (as multisets). */
function minus<T>(a: T[], b: T[], key: (t: T) => string): T[] {
  const counts = new Map<string, number>();
  for (const t of b) counts.set(key(t), (counts.get(key(t)) ?? 0) + 1);
  return a.filter((t) => {
    const n = counts.get(key(t)) ?? 0;
    if (n) counts.set(key(t), n - 1);
    return !n;
  });
}

export async function checkDemo(entry: ManifestEntry, doc: PDFDocument, c: Check): Promise<void> {
  const e = entry.expect;
  const demo = e.demo;
  if (!demo) return;
  c.ok(entry.file.startsWith('demo/'), 'demo fixture lives in demo/');
  c.eq(demo.footer, 'Demo document, fictional data', 'footer text');
  const pages = doc.getPages();

  if (e.ocr) {
    // Image-only scan: the footer is part of every page's ground truth, no fonts at all.
    for (const p of e.ocr.pages)
      c.ok(
        p.lines.some((l) => l.text === demo.footer),
        `scan page ${p.page}: footer in the text`,
      );
    pages.forEach((page, i) =>
      c.ok(!page.node.Resources()?.get(N('Font')), `scan page ${i + 1}: no fonts`),
    );
    return;
  }

  const shown = pages.map((page) => shownText(doc, page));
  const key = (s: Shown) => `${s.baseFont} ${s.size} ${s.x} ${s.y} ${s.text}`;
  shown.forEach((lines, i) => {
    c.ok(
      lines.some((s) => s.text === demo.footer),
      `page ${i + 1}: footer "${demo.footer}" decodes from the page`,
    );
    c.ok(
      lines.every((s) => SUBSET_FONT.test(s.baseFont) && demo.fonts.includes(s.baseFont)),
      `page ${i + 1}: text only in the listed subsets of the bundled fonts`,
    );
    c.ok(
      lines.every((s) => !s.text.includes('�')),
      `page ${i + 1}: every glyph maps through /ToUnicode`,
    );
  });
  const allText = shown.flat().map((s) => s.text);

  for (const h of demo.headings ?? []) {
    const found = shown[h.page - 1]?.find((s) => s.text === h.text && s.size === h.size);
    c.ok(!!found && found.x === h.box[0], `heading "${h.text}" on page ${h.page}`);
  }

  for (const s of demo.sensitive ?? []) {
    c.eq(
      allText.filter((t) => t.includes(s.text)).length,
      s.occurrences,
      `${s.kind} "${s.text}" occurrences`,
    );
    const line = shown[s.page - 1]?.find((l) => l.text === s.line.text);
    c.ok(
      !!line && line.x === s.line.x && line.y === s.line.baseline,
      `${s.kind} line on page ${s.page}`,
    );
    c.ok(
      s.box[0] >= s.line.x && s.box[0] + s.box[2] <= s.line.x + s.line.box[2] + 0.01,
      `${s.kind} box inside its line`,
    );
    if (s.kind === 'iban') c.ok(ibanValid(s.text), 'IBAN passes mod-97');
    if (s.kind === 'email') c.ok(s.text.endsWith('@example.com'), 'e-mail uses example.com');
    if (s.kind === 'phone') c.ok(s.text.startsWith('+44 20 7946 0'), 'phone in the drama range');
  }

  if (demo.editTarget) {
    const t = demo.editTarget;
    const line = shown[t.page - 1]?.find((s) => s.text === t.text && s.y === t.baseline);
    c.ok(!!line && line.baseFont.endsWith(`+${t.font}`), 'text-edit target line');
    const fonts = dictOf(doc, pages[t.page - 1]?.node.Resources()?.get(N('Font')));
    const font = fonts
      ?.values()
      .map((v) => dictOf(doc, v))
      .find((d) => resolve(doc, d?.get(N('BaseFont')))?.toString() === `/${line?.baseFont ?? ''}`);
    const mapped = new Set(toUnicode(doc, font).values());
    c.ok(
      '0123456789'.split('').every((d) => mapped.has(d)),
      'text-edit target font subset has every digit',
    );
  }

  if (demo.table) {
    const t = demo.table;
    const texts = new Set(shown[t.page - 1]?.map((s) => s.text));
    c.ok(
      [...t.columns, ...t.rows.flat()].every((v) => texts.has(v)),
      `table "${t.id}": every cell drawn`,
    );
  }

  for (const chart of demo.charts ?? []) {
    c.ok(
      chart.series.every((s) => s.values.length === chart.categories.length),
      `${chart.id}: one value per category`,
    );
    const texts = new Set(shown[chart.page - 1]?.map((s) => s.text));
    c.ok(
      chart.categories.every((cat) => texts.has(cat)),
      `${chart.id}: category labels drawn`,
    );
    if (chart.bars) {
      const painted = rects(content(doc, pages[chart.page - 1]));
      c.ok(
        chart.bars.every((b) => painted.some((r) => sameBox(r, b))),
        `${chart.id}: every bar painted`,
      );
      const [, y0, , h] = chart.plot;
      chart.bars.forEach((b, i) => {
        const v = chart.series[0]?.values[i] ?? Number.NaN;
        const expected = (v - chart.yRange[0]) / (chart.yRange[1] - chart.yRange[0]);
        c.ok(
          Math.abs(b[1] - y0) < 0.01 && Math.abs(b[3] / h - expected) < 0.001,
          `${chart.id}: bar ${chart.categories[i] ?? i} height`,
        );
      });
    }
  }

  const cmp = demo.compare;
  if (cmp?.role === 'b') {
    c.eq(cmp.b, entry.file, 'compare role b is this file');
    const a = await PDFDocument.load(readFileSync(join(FIXTURES_DIR, cmp.a)), {
      updateMetadata: false,
    });
    const aPages = a.getPages();
    for (const { a: pa, b: pb } of cmp.pageMap) {
      const same = content(a, aPages[pa - 1]) === content(doc, pages[pb - 1]);
      c.eq(same, cmp.identicalPages.includes(pb), `pages a${pa}/b${pb} identical as listed`);
    }
    const changedPages = new Set(cmp.changes.map((ch) => ch.page));
    c.eq(
      cmp.pageMap.length - cmp.identicalPages.length,
      changedPages.size,
      'every non-identical page has a listed change',
    );
    for (const page of changedPages) {
      const sa = shownText(a, aPages[page - 1]);
      const sb = shown[page - 1] ?? [];
      const onlyA = minus(sa, sb, key).map((s) => s.text);
      const onlyB = minus(sb, sa, key).map((s) => s.text);
      const ra = rects(content(a, aPages[page - 1]));
      const rb = rects(content(doc, pages[page - 1]));
      const rectKey = (r: Box) => r.join(' ');
      const rectsA = minus(ra, rb, rectKey);
      const rectsB = minus(rb, ra, rectKey);
      const expected = {
        textA: [] as string[],
        textB: [] as string[],
        rectsA: [] as Box[],
        rectsB: [] as Box[],
      };
      for (const ch of cmp.changes.filter((x) => x.page === page)) {
        if (ch.kind === 'paragraph') {
          expected.textA.push(...ch.changedLines.map((i) => ch.a.lines[i] ?? ''));
          expected.textB.push(...ch.changedLines.map((i) => ch.b.lines[i] ?? ''));
          c.ok(
            ch.a.lines.join(' ').includes(ch.sentences.a) &&
              ch.b.lines.join(' ').includes(ch.sentences.b),
            'rewritten sentences are in the paragraphs',
          );
          c.eq(
            ch.a.lines.join(' ').replace(ch.sentences.a, ch.sentences.b),
            ch.b.lines.join(' '),
            'only the listed sentences differ',
          );
        } else if (ch.kind === 'table-cell') {
          expected.textA.push(ch.a.text);
          expected.textB.push(ch.b.text);
          c.ok(
            sa.some((s) => s.text === ch.a.text && s.y === ch.a.baseline),
            'cell value in a',
          );
          c.ok(
            sb.some((s) => s.text === ch.b.text && s.y === ch.b.baseline),
            'cell value in b',
          );
        } else {
          expected.rectsA.push(ch.a.rect);
          expected.rectsB.push(ch.b.rect);
        }
      }
      c.eq(onlyA, expected.textA, `page ${page}: text only in a`);
      c.eq(onlyB, expected.textB, `page ${page}: text only in b`);
      c.ok(
        rectsA.length === expected.rectsA.length &&
          rectsA.every((r, i) => sameBox(r, expected.rectsA[i] ?? [0, 0, 0, 0])),
        `page ${page}: rectangles only in a`,
      );
      c.ok(
        rectsB.length === expected.rectsB.length &&
          rectsB.every((r, i) => sameBox(r, expected.rectsB[i] ?? [0, 0, 0, 0])),
        `page ${page}: rectangles only in b`,
      );
    }
  }
}
