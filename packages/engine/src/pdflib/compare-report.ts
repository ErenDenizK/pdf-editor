/**
 * The comparison report (spec §2.1 "Report", decision §8.7-6): the second document with
 * change annotations, after one or more summary pages (files, fingerprints, counts, the
 * honesty text, the page map, the facts and the text changes). Annotations, all conformant
 * with annotations/conformance.ts (appearance stream, /P, /NM, /F Print, /M):
 *
 * - `/Square` around each area whose pixels differ, and around an inserted page;
 * - `/Highlight` (Multiply blend) over added and changed words, `/Contents` old → new;
 * - `/Text` notes (icon `Insert`) where words were removed and where a deleted page was.
 *   Removed words do not exist in the second document, so nothing can be struck out; the
 *   note sits where they stood in the first document (same coordinates on the paired page).
 *
 * The wording is plain: "pixel differences at 100 dpi; a pixel diff cannot tell intent".
 * Pure pdf-lib; runs in the analysis worker.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  type PDFFont,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFPage,
  PDFString,
  rgb,
  StandardFonts,
} from '@cantoo/pdf-lib';
import type { Rect } from '@pdf-editor/document-model';

import { ANNOT_FLAG, pdfDate } from '../annotations/finalize';
import { bundledFace } from '../fonts/font-catalog';
import { loadBundledFont } from '../fonts/bundled-fonts';
import type { ComparisonResult, FactChange, TextChange } from '../types';

export interface ComparisonReportOptions {
  /** Password of the second document, when it is encrypted (the report is written without). */
  readonly password?: string;
  /** Summary title (default "Comparison report"). */
  readonly title?: string;
  /** Time written to the summary and to every annotation's /M (default now). */
  readonly now?: Date;
  /**
   * Summary font: bundled Inter (default, any Latin, Greek or Cyrillic text) or the
   * standard Helvetica (WinAnsi only; other characters become "?"). Inter falls back to
   * Helvetica when its files cannot be loaded.
   */
  readonly font?: 'inter' | 'helvetica';
  /** Font files to use instead of fetching the bundled Inter (tests, tools). */
  readonly fontBytes?: { readonly regular: Uint8Array; readonly bold: Uint8Array };
  /** Annotations per page at most (default 300); further visual areas are left out and counted. */
  readonly maxAnnotationsPerPage?: number;
}

/** What the report wrote, for tests and the export summary. */
export interface ComparisonReportCounts {
  readonly summaryPages: number;
  readonly square: number;
  readonly highlight: number;
  readonly note: number;
  readonly omitted: number;
}

type Rgb = readonly [number, number, number];

const INK: Rgb = [0.11, 0.12, 0.14];
const MUTED: Rgb = [0.42, 0.44, 0.48];
const RULE: Rgb = [0.82, 0.83, 0.85];
/** The single accent: visual areas and removals. */
const ACCENT: Rgb = [0.84, 0.19, 0.24];
/** Highlights: changed (amber) and added (green) words. */
const CHANGED: Rgb = [1, 0.84, 0.35];
const ADDED: Rgb = [0.6, 0.9, 0.62];

const N = {
  Nums: PDFName.of('Nums'),
  Kids: PDFName.of('Kids'),
  PageLabels: PDFName.of('PageLabels'),
};

const fmt = (v: number) => (Math.round(v * 1000) / 1000).toString();
const color = (c: Rgb) => c.map(fmt).join(' ');

class Annotator {
  private serial = 0;
  readonly counts = { square: 0, highlight: 0, note: 0, omitted: 0 };
  private readonly perPage = new Map<PDFPage, number>();

  constructor(
    private readonly doc: PDFDocument,
    private readonly date: string,
    private readonly limit: number,
  ) {}

  private room(page: PDFPage): boolean {
    const used = this.perPage.get(page) ?? 0;
    if (used >= this.limit) {
      this.counts.omitted++;
      return false;
    }
    this.perPage.set(page, used + 1);
    return true;
  }

  private add(
    page: PDFPage,
    subtype: string,
    rect: Rect,
    contents: string,
    ap: { ops: string; resources?: PDFDict },
    extra: Record<string, unknown> = {},
    c: Rgb = ACCENT,
  ): void {
    const { context } = this.doc;
    const x1 = rect.x;
    const y1 = rect.y;
    const x2 = rect.x + rect.width;
    const y2 = rect.y + rect.height;
    const stream = context.stream(ap.ops, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [x1, y1, x2, y2],
      ...(ap.resources ? { Resources: ap.resources } : {}),
    });
    const apRef = context.register(stream);
    const dict = context.obj({
      Type: 'Annot',
      Subtype: subtype,
      Rect: [x1, y1, x2, y2],
      F: ANNOT_FLAG.Print,
      C: [...c],
      T: PDFHexString.fromText('Recto compare'),
      ...extra,
    });
    dict.set(PDFName.of('Contents'), PDFHexString.fromText(contents));
    dict.set(PDFName.of('NM'), PDFString.of(`pdfe-compare-${++this.serial}`));
    dict.set(PDFName.of('M'), PDFString.of(this.date));
    dict.set(PDFName.of('P'), page.ref);
    dict.set(PDFName.of('AP'), context.obj({ N: apRef }));
    page.node.addAnnot(context.register(dict));
  }

  square(page: PDFPage, rect: Rect, contents: string): void {
    if (!this.room(page)) return;
    const w = 1;
    const r = { x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 };
    const ops = `q ${w} w ${color(ACCENT)} RG ${fmt(r.x + w / 2)} ${fmt(r.y + w / 2)} ${fmt(r.width - w)} ${fmt(r.height - w)} re S Q`;
    this.add(page, 'Square', r, contents, { ops }, { BS: { W: w, S: 'S' } });
    this.counts.square++;
  }

  highlight(page: PDFPage, rects: readonly Rect[], contents: string, c: Rgb): void {
    if (rects.length === 0 || !this.room(page)) return;
    const quads: number[] = [];
    let path = '';
    for (const r of rects) {
      const x1 = r.x;
      const x2 = r.x + r.width;
      const y1 = r.y;
      const y2 = r.y + r.height;
      // Upper-left, upper-right, lower-left, lower-right (conformance.ts `quad-points`).
      quads.push(x1, y2, x2, y2, x1, y1, x2, y1);
      path += `${fmt(x1)} ${fmt(y1)} ${fmt(x2 - x1)} ${fmt(y2 - y1)} re `;
    }
    const bounds = union(rects);
    const ops = `q /GS0 gs ${color(c)} rg ${path}f Q`;
    const resources = this.doc.context.obj({
      ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 } },
    });
    this.add(page, 'Highlight', bounds, contents, { ops, resources }, { QuadPoints: quads }, c);
    this.counts.highlight++;
  }

  note(page: PDFPage, x: number, y: number, contents: string): void {
    if (!this.room(page)) return;
    const box = page.getCropBox();
    const size = 16;
    const nx = Math.min(Math.max(x, box.x), box.x + box.width - size);
    const ny = Math.min(Math.max(y, box.y), box.y + box.height - size);
    const r = { x: nx, y: ny, width: size, height: size };
    // A rounded tab with a caret: the "Insert" icon.
    const ops = [
      'q',
      `${color(ACCENT)} rg ${fmt(nx + 1)} ${fmt(ny + 1)} ${size - 2} ${size - 2} re f`,
      `1 1 1 RG 1.6 w 1 J 1 j ${fmt(nx + 4)} ${fmt(ny + 5)} m ${fmt(nx + 8)} ${fmt(ny + 11)} l ${fmt(nx + 12)} ${fmt(ny + 5)} l S`,
      'Q',
    ].join(' ');
    this.add(page, 'Text', r, contents, { ops }, { Name: 'Insert', Open: false });
    this.counts.note++;
  }
}

function union(rects: readonly Rect[]): Rect {
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.width));
  const y2 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

const quote = (text: string, max = 160) =>
  `"${text.length > max ? `${text.slice(0, max - 1)}…` : text}"`;

function changeContents(change: TextChange): string {
  const where = change.a ? ` (first document, page ${change.a.page + 1})` : '';
  if (change.kind === 'changed')
    return `Changed: ${quote(change.a?.text ?? '')} → ${quote(change.b?.text ?? '')}${where}`;
  if (change.kind === 'added') return `Added: ${quote(change.b?.text ?? '')}`;
  return `Removed: ${quote(change.a?.text ?? '')}${where}. The position is where the words stood in the first document.`;
}

// ---------------------------------------------------------------------------
// Summary pages
// ---------------------------------------------------------------------------

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  readonly charset: Set<number>;
}

async function loadFonts(doc: PDFDocument, options: ComparisonReportOptions): Promise<Fonts> {
  if ((options.font ?? 'inter') === 'inter') {
    try {
      const bytes = options.fontBytes ?? {
        regular: await loadBundledFont(bundledFace('inter', 400)),
        bold: await loadBundledFont(bundledFace('inter', 700)),
      };
      const { default: fontkit } = await import('@cantoo/fontkit');
      doc.registerFontkit(fontkit);
      const regular = await doc.embedFont(bytes.regular, { subset: true });
      const bold = await doc.embedFont(bytes.bold, { subset: true });
      return { regular, bold, charset: new Set(regular.getCharacterSet()) };
    } catch {
      // Fall back to the standard fonts below.
    }
  }
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { regular, bold, charset: new Set(regular.getCharacterSet()) };
}

class SummaryWriter {
  private page: PDFPage | undefined;
  private y = 0;
  readonly pages: PDFPage[] = [];
  private readonly margin = 54;

  constructor(
    private readonly doc: PDFDocument,
    private readonly fonts: Fonts,
    private readonly size: [number, number],
  ) {}

  private clean(text: string): string {
    let out = '';
    for (const ch of text.replace(/[\r\n\t]+/g, ' ')) {
      out += this.fonts.charset.has(ch.codePointAt(0) ?? 0) ? ch : '?';
    }
    return out;
  }

  private get width(): number {
    return this.size[0] - 2 * this.margin;
  }

  private newPage(): PDFPage {
    const page = this.doc.insertPage(this.pages.length, this.size);
    this.pages.push(page);
    this.page = page;
    this.y = this.size[1] - this.margin;
    return page;
  }

  private ensure(height: number): PDFPage {
    if (!this.page || this.y - height < this.margin) return this.newPage();
    return this.page;
  }

  private wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const words = this.clean(text).split(' ');
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line === '' ? word : `${line} ${word}`;
      if (font.widthOfTextAtSize(next, size) <= width || line === '') {
        line = next;
        // A single word wider than the column is cut.
        while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line !== '') lines.push(line);
    return lines;
  }

  text(
    text: string,
    options: { size?: number; bold?: boolean; color?: Rgb; indent?: number; gap?: number } = {},
  ): void {
    const size = options.size ?? 9.5;
    const font = options.bold ? this.fonts.bold : this.fonts.regular;
    const indent = options.indent ?? 0;
    const leading = size * 1.35;
    for (const line of this.wrap(text, font, size, this.width - indent)) {
      const page = this.ensure(leading);
      this.y -= leading;
      page.drawText(line, {
        x: this.margin + indent,
        y: this.y + size * 0.25,
        size,
        font,
        color: rgb(...(options.color ?? INK)),
      });
    }
    this.y -= options.gap ?? 0;
  }

  heading(text: string): void {
    this.ensure(40);
    this.y -= 10;
    this.text(text, { size: 11, bold: true, gap: 2 });
    this.rule();
  }

  rule(): void {
    const page = this.ensure(6);
    this.y -= 3;
    page.drawLine({
      start: { x: this.margin, y: this.y },
      end: { x: this.margin + this.width, y: this.y },
      thickness: 0.5,
      color: rgb(...RULE),
    });
    this.y -= 3;
  }

  /** A table row: cells at fixed fractions of the width, each wrapped in its column. */
  row(
    cells: readonly string[],
    columns: readonly number[],
    options: { bold?: boolean; color?: Rgb } = {},
  ): void {
    const size = 8.5;
    const font = options.bold ? this.fonts.bold : this.fonts.regular;
    const leading = size * 1.35;
    const widths = columns.map((c, i) => ((columns[i + 1] ?? 1) - c) * this.width - 6);
    const wrapped = cells.map((cell, i) =>
      this.wrap(cell, font, size, Math.max(10, widths[i] ?? 10)),
    );
    const lines = Math.max(1, ...wrapped.map((w) => w.length));
    const page = this.ensure(lines * leading + 2);
    for (let l = 0; l < lines; l++) {
      this.y -= leading;
      wrapped.forEach((w, i) => {
        const line = w[l];
        if (line === undefined || line === '') return;
        page.drawText(line, {
          x: this.margin + (columns[i] ?? 0) * this.width,
          y: this.y + size * 0.25,
          size,
          font,
          color: rgb(...(options.color ?? INK)),
        });
      });
    }
    this.y -= 2;
  }
}

function factLine(f: FactChange): string[] {
  const where =
    f.aPage !== undefined && f.bPage !== undefined
      ? ` (pages ${f.aPage + 1} → ${f.bPage + 1})`
      : '';
  return [`${f.kind}${where}`, f.key, f.a ?? '(absent)', f.b ?? '(absent)'];
}

function writeSummary(
  w: SummaryWriter,
  result: ComparisonResult,
  options: ComparisonReportOptions,
  date: Date,
  counts: () => string,
): void {
  const c = result.counts;
  w.text(options.title ?? 'Comparison report', { size: 18, bold: true, gap: 2 });
  w.text(
    `Made on this device on ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC. Nothing was sent anywhere.`,
    {
      color: MUTED,
      gap: 6,
    },
  );
  w.heading('Documents');
  const side = (label: string, s: ComparisonResult['a']) =>
    w.row(
      [
        label,
        s.name,
        `${s.pageCount} page${s.pageCount === 1 ? '' : 's'}`,
        s.fingerprint ? `fingerprint ${s.fingerprint.slice(0, 16)}` : '',
      ],
      [0, 0.14, 0.5, 0.62],
    );
  side('First', result.a);
  side('Second', result.b);
  w.text('The pages after this summary are the second document with the changes marked.', {
    color: MUTED,
    gap: 4,
  });

  w.heading('Summary');
  w.text(
    `Pages: ${c.identical} identical, ${c.changed} changed, ${c.inserted} inserted, ${c.deleted} deleted. ` +
      `Text: ${c.textChanged} changed, ${c.textAdded} added, ${c.textRemoved} removed. ` +
      `Visual: ${c.visualRegions} area${c.visualRegions === 1 ? '' : 's'} with pixel differences at ${result.settings.dpi} dpi. ` +
      `Facts: ${c.facts} difference${c.facts === 1 ? '' : 's'}.`,
    { gap: 2 },
  );
  w.text(counts(), { color: MUTED, gap: 2 });
  w.text(
    `Pages were paired ${result.settings.alignment === 'index' ? 'by position' : 'by best match of their words'}.` +
      (result.settings.visual ? '' : ' The visual comparison was not run.') +
      (result.settings.text ? '' : ' The text comparison was not run.') +
      (result.text.scope === 'page-pairs' ? ' Text was compared page by page.' : ''),
    { color: MUTED },
  );

  w.heading('Read this first');
  for (const note of result.notes) w.text(`•  ${note}`, { indent: 0, gap: 1 });

  w.heading('Page map');
  const columns = [0, 0.12, 0.24, 0.38, 0.54, 0.72];
  w.row(['First', 'Second', 'Similarity', 'Status', 'Text changes', 'Changed pixels'], columns, {
    bold: true,
    color: MUTED,
  });
  for (const p of result.pages) {
    const visual = p.visual;
    w.row(
      [
        p.pair.a === undefined ? '–' : String(p.pair.a + 1),
        p.pair.b === undefined ? '–' : String(p.pair.b + 1),
        `${Math.round(p.pair.similarity * 100)} %${p.pair.basis === 'thumbnail' ? ' (image)' : ''}`,
        p.status + (p.geometryChanged ? ', size or rotation' : ''),
        p.status === 'inserted' || p.status === 'deleted'
          ? `${p.words ?? 0} words`
          : String(p.textChanges),
        visual
          ? `${(visual.changedRatio * 100).toFixed(2)} %${visual.sizeMismatch ? ', sizes differ' : ''}`
          : '–',
      ],
      columns,
    );
  }

  w.heading('Facts');
  if (result.facts.length === 0)
    w.text(
      'No differences in the facts compared (metadata, page sizes and rotation, annotation counts, form fields, attachments, signatures).',
      { color: MUTED },
    );
  else {
    const factColumns = [0, 0.26, 0.46, 0.73];
    w.row(['What', 'Key', 'First', 'Second'], factColumns, { bold: true, color: MUTED });
    for (const f of result.facts) w.row(factLine(f), factColumns);
  }

  w.heading('Text changes');
  if (result.text.changes.length === 0)
    w.text('No word changed on the paired pages.', { color: MUTED });
  else {
    const textColumns = [0, 0.12, 0.26];
    w.row(['Pages', 'Change', 'Words'], textColumns, { bold: true, color: MUTED });
    const shown = result.text.changes.slice(0, 400);
    for (const t of shown) {
      const pages = `${t.a ? t.a.page + 1 : '–'} → ${t.b ? t.b.page + 1 : '–'}`;
      const words =
        t.kind === 'changed'
          ? `${quote(t.a?.text ?? '', 120)} → ${quote(t.b?.text ?? '', 120)}`
          : quote((t.a ?? t.b)?.text ?? '', 240);
      w.row([pages, t.kind, words], textColumns);
    }
    if (result.text.changes.length > shown.length) {
      w.text(
        `… and ${result.text.changes.length - shown.length} more (all are marked on the pages).`,
        { color: MUTED },
      );
    }
  }
}

/** Shifts existing page labels past the summary pages (a label tree with /Kids is dropped). */
function shiftPageLabels(doc: PDFDocument, count: number): void {
  const { context } = doc;
  const labels = context.lookupMaybe(doc.catalog.get(N.PageLabels), PDFDict);
  if (!labels) return;
  const nums = context.lookupMaybe(labels.get(N.Nums), PDFArray);
  if (!nums || labels.has(N.Kids)) {
    doc.catalog.delete(N.PageLabels);
    return;
  }
  const out = context.obj([0, { S: 'D', P: PDFHexString.fromText('Summary ') }]);
  for (let i = 0; i + 1 < nums.size(); i += 2) {
    const key = context.lookup(nums.get(i));
    if (!(key instanceof PDFNumber)) continue;
    out.push(PDFNumber.of(key.asNumber() + count));
    out.push(nums.get(i + 1));
  }
  labels.set(N.Nums, out);
}

/** Builds the report: returns the PDF bytes and what was written. */
export async function buildComparisonReportWithCounts(
  bytes: ArrayBuffer | Uint8Array,
  result: ComparisonResult,
  options: ComparisonReportOptions = {},
): Promise<{ bytes: Uint8Array; counts: ComparisonReportCounts }> {
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    throwOnInvalidObject: false,
    ...(options.password === undefined ? {} : { password: options.password }),
  });
  const now = options.now ?? new Date();
  const annotator = new Annotator(
    doc,
    pdfDate(now.toISOString()),
    options.maxAnnotationsPerPage ?? 300,
  );
  const pages = doc.getPages();
  const pageB = (index: number | undefined) => (index === undefined ? undefined : pages[index]);
  const dpi = result.settings.dpi;
  // Visual areas, inserted pages and deleted pages, along the page map.
  result.pages.forEach((p, index) => {
    const page = pageB(p.pair.b);
    if (p.status === 'inserted' && page) {
      const box = page.getCropBox();
      annotator.square(
        page,
        { x: box.x + 12, y: box.y + 12, width: box.width - 24, height: box.height - 24 },
        'Inserted page: it has no counterpart in the first document.',
      );
      return;
    }
    if (p.status === 'deleted') {
      // The note goes on the next page of the second document (or the last one).
      const next = result.pages.slice(index + 1).find((q) => q.pair.b !== undefined)?.pair.b;
      const target = pageB(next) ?? pages[pages.length - 1];
      if (target) {
        const box = target.getCropBox();
        const heading = p.firstLine ? ` (${quote(p.firstLine, 80)})` : '';
        annotator.note(
          target,
          box.x + 4,
          box.y + box.height - 20,
          `Deleted page: page ${(p.pair.a ?? 0) + 1} of the first document${heading}, ${p.words ?? 0} words, is not in the second document. It stood ${next === undefined ? 'after the last page' : 'before this page'}.`,
        );
      }
      return;
    }
    if (!page || !p.visual) return;
    for (const region of p.visual.regions) {
      annotator.square(
        page,
        region,
        `Visual change: pixel differences at ${dpi} dpi (first document page ${(p.pair.a ?? 0) + 1}). A pixel diff shows where the pages look different, not why; it cannot tell intent.`,
      );
    }
  });
  // Text changes.
  const pairOfA = new Map(
    result.pages.flatMap((p) =>
      p.pair.a !== undefined && p.pair.b !== undefined ? [[p.pair.a, p.pair.b] as const] : [],
    ),
  );
  for (const change of result.text.changes) {
    if (change.b) {
      const page = pageB(change.b.page);
      if (page)
        annotator.highlight(
          page,
          change.b.rects,
          changeContents(change),
          change.kind === 'added' ? ADDED : CHANGED,
        );
    } else if (change.a) {
      const page = pageB(pairOfA.get(change.a.page));
      const at = change.a.rects[0];
      if (page && at) annotator.note(page, at.x, at.y + at.height, changeContents(change));
    }
  }
  // Summary pages at the front, in the second document's first page size class.
  const first = pages[0]?.getSize();
  const size: [number, number] =
    first && Math.abs(first.width - 595.28) < 20 ? [595.28, 841.89] : [612, 792];
  const fonts = await loadFonts(doc, options);
  const writer = new SummaryWriter(doc, fonts, size);
  const counts = annotator.counts;
  writeSummary(
    writer,
    result,
    options,
    now,
    () =>
      `Marked on the pages: ${counts.square} rectangle${counts.square === 1 ? '' : 's'}, ${counts.highlight} highlight${counts.highlight === 1 ? '' : 's'}, ${counts.note} note${counts.note === 1 ? '' : 's'}` +
      (counts.omitted > 0 ? `; ${counts.omitted} more left out (limit per page).` : '.'),
  );
  shiftPageLabels(doc, writer.pages.length);
  const out = await doc.save({ useObjectStreams: false });
  return { bytes: out, counts: { summaryPages: writer.pages.length, ...counts } };
}

export async function buildComparisonReport(
  bytes: ArrayBuffer | Uint8Array,
  result: ComparisonResult,
  options: ComparisonReportOptions = {},
): Promise<Uint8Array> {
  return (await buildComparisonReportWithCounts(bytes, result, options)).bytes;
}
