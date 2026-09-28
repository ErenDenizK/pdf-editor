/**
 * PDF → Markdown / plain text (spec §4): pages are added one at a time (text runs, link
 * annotations, images with their pixels), laid out when the conversion finishes (running
 * headers and footers need every page), and written as `document.md` / `page-NNN.md` plus
 * `images/pP-K.png` (JPEG passed through as `.jpg`), zipped when there is more than one file.
 */
import { zipSync, type Zippable } from 'fflate';

import { Slicer } from '../analysis/scheduler';
import {
  type ConvertFile,
  type ConvertImageInput,
  type ConvertOptions,
  type ConvertPageInput,
  type ConvertReport,
  type ConvertResult,
  EngineError,
} from '../types';
import {
  applyLinks,
  type Box,
  type DropReason,
  detectFurniture,
  type ImageItem,
  type Item,
  pageSegments,
  type Segment,
  suspectedTables,
  toBlocks,
  toDisplayBox,
  toLines,
  xyCut,
} from './layout';
import { type PageBlocks, renderPage, styleModel } from './markdown';
import { encodePng } from './png';

export const CONVERT_NOTES: readonly string[] = [
  'Reading order and headings are reconstructed from positions and font sizes: columns, sidebars, footnotes, tables and rotated text may come out in the wrong order.',
  'Tables are not detected: their text follows in reading order.',
  'Pages without extractable text (scans) have no text here; run OCR first.',
];

const HEADER_COMMENT =
  '<!-- Converted from PDF by pdf-editor. Reading order and headings are reconstructed from positions and font sizes; tables are not detected (their text follows in reading order). -->';

/** Images smaller than this (points) are rules and decorations, not pictures. */
const MIN_IMAGE = 4;

interface StoredImage {
  readonly box: Box;
  readonly file?: { readonly ext: 'png' | 'jpg'; readonly bytes: Uint8Array };
}

interface StoredPage {
  readonly index: number;
  readonly height: number;
  readonly segments: Segment[];
  readonly images: StoredImage[];
  readonly links: ConvertPageInput['links'];
  readonly hasText: boolean;
}

function encodeImage(image: ConvertImageInput): StoredImage['file'] {
  if (image.jpeg) return { ext: 'jpg', bytes: image.jpeg };
  if (image.png) return { ext: 'png', bytes: image.png };
  if (image.rgba)
    return { ext: 'png', bytes: encodePng(image.rgba.width, image.rgba.height, image.rgba.data) };
  return undefined;
}

const pad3 = (n: number) => String(n).padStart(3, '0');

/**
 * The fixed modification time of every ZIP entry: the instant whose wall-clock time is
 * 1980-01-01 12:00 in a zone `timezoneOffset` minutes behind UTC (`Date#getTimezoneOffset`'s
 * sign: 300 in New York, −540 in Tokyo). fflate writes an entry's MS-DOS date from the
 * *local* fields of `mtime` and throws below 1980, so a UTC instant (the earlier
 * `1980-01-01T00:00:00Z`) is 1979-12-31 19:00 in New York and every export with images threw
 * there. Noon on the first day of the range is inside it for every offset (−14 h … +12 h),
 * and the stamp is the same bytes in every zone, so the ZIP stays reproducible. The offset is
 * a parameter because a test cannot change the browser's time zone (Vitest browser mode has
 * no `TZ`): the tests pass both signs and check the local fields fflate reads.
 */
export function zipModifiedTime(
  timezoneOffset = new Date(1980, 0, 1, 12).getTimezoneOffset(),
): Date {
  return new Date(Date.UTC(1980, 0, 1, 12) + timezoneOffset * 60_000);
}

export class ConvertSession {
  private readonly pages = new Map<number, StoredPage>();

  constructor(readonly options: ConvertOptions = {}) {}

  addPage(index: number, input: ConvertPageInput): void {
    if (!Number.isInteger(index) || index < 0)
      throw new EngineError('internal', `Bad page index ${index}`);
    const segments = pageSegments(input, input.runs);
    applyLinks(input, segments);
    const wantImages =
      (this.options.format ?? 'markdown') === 'markdown' && this.options.images !== false;
    const images: StoredImage[] = [];
    for (const image of input.images ?? []) {
      if (image.rect.width < MIN_IMAGE || image.rect.height < MIN_IMAGE) continue;
      const file = wantImages ? encodeImage(image) : undefined;
      images.push({ box: toDisplayBox(input, image.rect), ...(file ? { file } : {}) });
    }
    const display = toDisplayBox(input, {
      x: input.origin?.x ?? 0,
      y: input.origin?.y ?? 0,
      width: input.size.width,
      height: input.size.height,
    });
    this.pages.set(index, {
      index,
      height: display.y1 - display.y0,
      segments,
      images,
      links: input.links ?? [],
      hasText: input.runs.some((r) => r.text.trim() !== ''),
    });
  }

  async finish(signal?: AbortSignal): Promise<ConvertResult> {
    const slicer = new Slicer('convert', signal);
    const options = this.options;
    const format = options.format ?? 'markdown';
    const ordered = [...this.pages.values()].sort((a, b) => a.index - b.index);
    const furniture = options.keepHeadersFooters
      ? new Map<Segment, DropReason>()
      : detectFurniture(ordered);
    const dropped: ConvertReport['dropped'][number][] = [];
    const files: ConvertFile[] = [];
    const imageFiles: ConvertFile[] = [];
    const pageBlocks: PageBlocks[] = [];
    let tables = 0;
    for (const page of ordered) {
      const kept: Segment[] = [];
      for (const s of page.segments) {
        const reason = furniture.get(s);
        if (reason) dropped.push({ page: page.index, text: s.text, reason });
        else kept.push(s);
      }
      tables += suspectedTables(kept);
      // Images under text (backgrounds, watermarks) go first; the rest join the layout.
      const background: ImageItem[] = [];
      const items: Item[] = [...kept];
      const imagePaths: (string | undefined)[] = [];
      page.images.forEach((image, index) => {
        const item: ImageItem = { kind: 'image', box: image.box, index };
        const covers = kept.some((s) => {
          const cx = (s.box.x0 + s.box.x1) / 2;
          const cy = (s.box.y0 + s.box.y1) / 2;
          return cx > image.box.x0 && cx < image.box.x1 && cy > image.box.y0 && cy < image.box.y1;
        });
        if (covers) background.push(item);
        else items.push(item);
        imagePaths.push(undefined);
      });
      const placed = [...background.map((item) => ({ item, column: '' })), ...xyCut(items)];
      const blocks = toBlocks(toLines(placed));
      // Images are numbered per page in reading order.
      let k = 0;
      for (const block of blocks) {
        if (block.kind !== 'image') continue;
        const file = page.images[block.image.index]?.file;
        if (!file) continue;
        k++;
        const path = `images/p${page.index + 1}-${k}.${file.ext}`;
        imagePaths[block.image.index] = path;
        imageFiles.push({
          path,
          mime: file.ext === 'png' ? 'image/png' : 'image/jpeg',
          bytes: file.bytes,
        });
      }
      pageBlocks.push({ page: page.index, blocks, links: page.links ?? [], imagePaths });
      await slicer.tick('convert: layout');
    }
    const style = styleModel(pageBlocks);
    const renderOptions = {
      format,
      joinHyphens: options.joinHyphens ?? true,
      images: options.images ?? true,
    } as const;
    const counts = { headings: 0, paragraphs: 0, listItems: 0, images: 0, links: 0 };
    const pageTexts: string[] = [];
    for (const page of pageBlocks) {
      const rendered = renderPage(page, style, renderOptions);
      for (const key of Object.keys(counts) as (keyof typeof counts)[])
        counts[key] += rendered.counts[key];
      pageTexts.push(rendered.text);
      await slicer.tick('convert: render');
    }
    const ext = format === 'markdown' ? 'md' : 'txt';
    const mime = format === 'markdown' ? 'text/markdown' : 'text/plain';
    const header = format === 'markdown' && options.headerComment ? `${HEADER_COMMENT}\n\n` : '';
    const encoder = new TextEncoder();
    const breakText = (pageIndex: number): string => {
      const pageBreak = options.pageBreak ?? 'none';
      if (pageBreak === 'rule') return '\n\n---\n\n';
      if (pageBreak === 'comment') {
        return format === 'markdown'
          ? `\n\n<!-- page ${pageIndex + 1} -->\n\n`
          : `\n\n[page ${pageIndex + 1}]\n\n`;
      }
      return '\n\n';
    };
    let text = '';
    ordered.forEach((page, i) => {
      const body = pageTexts[i] ?? '';
      if (body === '') return;
      text += text === '' ? body : `${breakText(page.index)}${body}`;
    });
    text = `${header}${text}${text === '' ? '' : '\n'}`;
    if ((options.scope ?? 'document') === 'pages') {
      ordered.forEach((page, i) => {
        const body = pageTexts[i] ?? '';
        const content = `${header}${body}${body === '' ? '' : '\n'}`;
        files.push({
          path: `page-${pad3(page.index + 1)}.${ext}`,
          mime,
          bytes: encoder.encode(content),
        });
      });
    } else {
      files.push({
        path: `${options.baseName ?? 'document'}.${ext}`,
        mime,
        bytes: encoder.encode(text),
      });
    }
    files.push(...imageFiles);
    await slicer.tick('convert: files');
    let zip: Uint8Array | undefined;
    if (files.length > 1) {
      const entries: Zippable = {};
      for (const f of files)
        entries[f.path] = [f.bytes, { level: f.mime.startsWith('text/') ? 6 : 0 }];
      zip = zipSync(entries, { mtime: zipModifiedTime() });
    }
    slicer.done('convert: files');
    const report: ConvertReport = {
      pages: ordered.length,
      pagesWithoutText: ordered.filter((p) => !p.hasText).map((p) => p.index),
      headings: counts.headings,
      paragraphs: counts.paragraphs,
      listItems: counts.listItems,
      images: counts.images,
      links: counts.links,
      suspectedTables: tables,
      ...(style.bodySize === undefined ? {} : { bodyFontSize: style.bodySize }),
      dropped,
      notes: CONVERT_NOTES,
    };
    return {
      format,
      text,
      pageTexts: pageTexts.map((t) => (t === '' ? '' : `${t}\n`)),
      files,
      ...(zip ? { zip } : {}),
      report,
    };
  }
}

/** Converts pages in one call (tests, small documents). */
export async function convertPages(
  pages: readonly ConvertPageInput[],
  options: ConvertOptions = {},
  signal?: AbortSignal,
): Promise<ConvertResult> {
  const session = new ConvertSession(options);
  pages.forEach((page, index) => {
    session.addPage(index, page);
  });
  return session.finish(signal);
}
