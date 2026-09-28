/**
 * Blocks → Markdown or plain text (spec §4 "Markdown"). The body size is the font size that
 * covers the most characters; text blocks of at most three lines at ≥ 1.15 × body size are
 * headings, their sizes clustered (within 5 %) and ranked `#` to `####`; a short bold
 * standalone line at body size is a heading one level below the smallest cluster. List
 * items keep their nesting (by marker indentation), line-end hyphenation is joined, text
 * under a URI link annotation becomes `[text](uri)`, images are referenced where they sit.
 */
import type { ConvertBlockKind, ConvertLinkInput } from '../types';
import type { Block, Line, ListMarker, TextBlock, Unit } from './layout';

/** Where a page's blocks came from and what they link to. */
export interface PageBlocks {
  readonly page: number;
  readonly blocks: readonly Block[];
  readonly links: readonly ConvertLinkInput[];
  /** Relative path of each image (by `ImageItem.index`); undefined when it has no pixels. */
  readonly imagePaths: readonly (string | undefined)[];
}

export interface StyleModel {
  readonly bodySize: number | undefined;
  /** Heading sizes, largest first (level = position + 1, capped at 4). */
  readonly headingSizes: readonly number[];
}

const HEADING_RATIO = 1.15;
const MAX_HEADING_LINES = 3;
const MAX_BOLD_HEADING_CHARS = 80;

function blockSize(block: TextBlock): number {
  return Math.max(...block.lines.map((l) => l.size));
}

/** Body size and heading size clusters over every page. */
export function styleModel(pages: readonly PageBlocks[]): StyleModel {
  const chars = new Map<number, number>();
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'text') continue;
      for (const line of block.lines) {
        for (const s of line.segments) {
          for (const u of s.units) {
            if (!u.box || u.ch.trim() === '') continue;
            const size = Math.round(u.size * 2) / 2;
            chars.set(size, (chars.get(size) ?? 0) + 1);
          }
        }
      }
    }
  }
  let bodySize: number | undefined;
  let most = 0;
  for (const [size, count] of chars) {
    if (count > most || (count === most && size < (bodySize ?? Number.POSITIVE_INFINITY))) {
      bodySize = size;
      most = count;
    }
  }
  if (bodySize === undefined) return { bodySize, headingSizes: [] };
  const sizes = new Set<number>();
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'text' || block.marker || block.lines.length > MAX_HEADING_LINES) continue;
      const size = blockSize(block);
      if (size >= HEADING_RATIO * bodySize) sizes.add(size);
    }
  }
  const clusters: number[] = [];
  for (const size of [...sizes].sort((a, b) => b - a)) {
    const last = clusters[clusters.length - 1];
    if (last === undefined || size < last * 0.95) clusters.push(size);
  }
  return { bodySize, headingSizes: clusters };
}

export interface Classified {
  readonly kind: ConvertBlockKind;
  readonly level: number;
  readonly block: Block;
}

export function classify(block: Block, style: StyleModel): Classified {
  if (block.kind === 'image') return { kind: 'image', level: 0, block };
  if (block.marker) return { kind: 'list-item', level: 1, block };
  const body = style.bodySize;
  if (body !== undefined && block.lines.length <= MAX_HEADING_LINES) {
    const size = blockSize(block);
    if (size >= HEADING_RATIO * body) {
      const index = style.headingSizes.findIndex((h) => size >= h * 0.95);
      const level = Math.min(4, (index < 0 ? style.headingSizes.length - 1 : index) + 1);
      return { kind: 'heading', level, block };
    }
    const text = rawText(block).trim();
    if (
      block.lines.length === 1 &&
      block.lines.every((l) => l.bold) &&
      text.length <= MAX_BOLD_HEADING_CHARS &&
      !/[.,;:]$/.test(text)
    ) {
      return { kind: 'heading', level: Math.min(4, style.headingSizes.length + 1), block };
    }
  }
  return { kind: 'paragraph', level: 0, block };
}

interface Piece {
  readonly ch: string;
  readonly link: number;
}

const SPACE = (link: number): Piece => ({ ch: ' ', link });

/** The block's characters with line breaks resolved (hyphenation joined, else a space). */
function blockPieces(block: TextBlock, joinHyphens: boolean): Piece[] {
  const out: Piece[] = [];
  const lines: readonly Line[] = block.lines;
  lines.forEach((line, li) => {
    const units: Unit[] = [];
    line.segments.forEach((s, si) => {
      if (si > 0) units.push({ ch: ' ', size: s.size, bold: s.bold, link: -1 });
      units.push(...s.units);
    });
    if (li > 0) {
      const prev = lines[li - 1] as Line;
      const lastPiece = out[out.length - 1];
      const first = units.find((u) => u.ch.trim() !== '');
      const lower = /^\p{Ll}/u.test(first?.ch ?? '');
      if (prev.hyphen === 'soft' && joinHyphens) {
        // Joined: nothing between the parts.
      } else if (prev.hyphen === 'hard' && joinHyphens && lower) {
        if (lastPiece && /[-\u2010]/.test(lastPiece.ch)) out.pop();
      } else if (prev.hyphen === 'hard' && joinHyphens) {
        // A capitalised continuation keeps its hyphen and no space ("Jean-Paul").
      } else {
        if (prev.hyphen === 'soft') out.push({ ch: '-', link: lastPiece?.link ?? -1 });
        const link = first && lastPiece?.link === first.link ? first.link : -1;
        out.push(SPACE(link));
      }
    }
    for (const u of units) out.push({ ch: u.ch, link: u.link });
  });
  // Collapse whitespace.
  const collapsed: Piece[] = [];
  for (const p of out) {
    const ch = /\s/.test(p.ch) ? ' ' : p.ch;
    const last = collapsed[collapsed.length - 1];
    if (ch === ' ' && (last === undefined || last.ch === ' ')) continue;
    collapsed.push({ ch, link: p.link });
  }
  while (collapsed[collapsed.length - 1]?.ch === ' ') collapsed.pop();
  return collapsed;
}

function rawText(block: TextBlock): string {
  return blockPieces(block, true)
    .map((p) => p.ch)
    .join('');
}

function dropMarker(pieces: Piece[], marker: ListMarker | undefined): Piece[] {
  if (!marker) return pieces;
  const rest = pieces.slice(marker.length);
  while (rest[0]?.ch === ' ') rest.shift();
  return rest;
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<]/g, (c) => `\\${c}`);
}

function escapeBlockStart(text: string): string {
  return text.replace(/^(#{1,6}(?=\s)|>|[-+](?=\s)|\d+(?=[.)]\s))/, (m) => `\\${m}`);
}

function linkTarget(uri: string): string {
  return /[\s()<>]/.test(uri) ? `<${uri.replace(/[<>]/g, encodeURIComponent)}>` : uri;
}

/** Markdown of the pieces; linked runs become `[text](uri)`. */
function markdownInline(
  pieces: readonly Piece[],
  links: readonly ConvertLinkInput[],
  used: Set<number>,
): string {
  let out = '';
  let i = 0;
  while (i < pieces.length) {
    const link = pieces[i]?.link ?? -1;
    let j = i;
    let text = '';
    while (j < pieces.length && (pieces[j]?.link ?? -1) === link) text += pieces[j++]?.ch ?? '';
    const uri = links[link]?.uri;
    if (link >= 0 && uri !== undefined && text.trim() !== '') {
      const lead = /^\s*/.exec(text)?.[0] ?? '';
      const trail = /\s*$/.exec(text)?.[0] ?? '';
      out += `${lead}[${escapeMarkdown(text.trim())}](${linkTarget(uri)})${trail}`;
      used.add(link);
    } else {
      out += escapeMarkdown(text);
    }
    i = j;
  }
  return out;
}

export interface RenderOptions {
  readonly format: 'markdown' | 'text';
  readonly joinHyphens: boolean;
  readonly images: boolean;
}

export interface RenderedPage {
  readonly text: string;
  readonly counts: {
    headings: number;
    paragraphs: number;
    listItems: number;
    images: number;
    links: number;
  };
}

/** One page as Markdown or plain text (no trailing newline; empty for an empty page). */
export function renderPage(
  page: PageBlocks,
  style: StyleModel,
  options: RenderOptions,
): RenderedPage {
  const counts = { headings: 0, paragraphs: 0, listItems: 0, images: 0, links: 0 };
  const usedLinks = new Set<number>();
  const parts: { text: string; list: boolean; ordered?: boolean }[] = [];
  // List nesting: marker left edges and content indents of the open levels.
  let listStack: { x: number; indent: number; width: number }[] = [];
  const markdown = options.format === 'markdown';
  for (const block of page.blocks) {
    const c = classify(block, style);
    if (c.kind !== 'list-item') listStack = [];
    if (c.kind === 'image') {
      if (block.kind !== 'image') continue;
      const path = page.imagePaths[block.image.index];
      if (!markdown || !options.images || path === undefined) continue;
      counts.images++;
      parts.push({
        text: `![Page ${page.page + 1}, image ${counts.images}](${path})`,
        list: false,
      });
      continue;
    }
    if (block.kind !== 'text') continue;
    const pieces = dropMarker(
      blockPieces(block, options.joinHyphens),
      c.kind === 'list-item' ? block.marker : undefined,
    );
    const plain = pieces.map((p) => p.ch).join('');
    if (plain.trim() === '' && c.kind !== 'list-item') continue;
    const inline = markdown ? markdownInline(pieces, page.links, usedLinks) : plain;
    if (c.kind === 'heading') {
      counts.headings++;
      parts.push({ text: markdown ? `${'#'.repeat(c.level)} ${inline}` : plain, list: false });
    } else if (c.kind === 'paragraph') {
      counts.paragraphs++;
      parts.push({ text: markdown ? escapeBlockStart(inline) : plain, list: false });
    } else {
      counts.listItems++;
      const marker = block.marker as ListMarker;
      const x = block.lines[0]?.box.x0 ?? 0;
      const tolerance = 0.5 * (block.lines[0]?.size ?? 10);
      while (listStack.length > 0 && x < (listStack[listStack.length - 1]?.x ?? 0) - tolerance)
        listStack.pop();
      const top = listStack[listStack.length - 1];
      if (!top || x > top.x + tolerance) {
        const indent = top ? top.indent + top.width : 0;
        listStack.push({ x, indent, width: 2 });
      }
      const level = listStack[listStack.length - 1] as { x: number; indent: number; width: number };
      let prefix: string;
      if (!markdown) prefix = `${marker.marker} `;
      else if (marker.ordered && marker.number !== undefined) prefix = `${marker.number}. `;
      else if (marker.ordered) prefix = `- ${escapeMarkdown(marker.marker)} `;
      else prefix = '- ';
      level.width = markdown
        ? marker.ordered && marker.number !== undefined
          ? prefix.length
          : 2
        : 2;
      parts.push({
        text: `${' '.repeat(level.indent)}${prefix}${inline}`,
        list: true,
        ordered: marker.ordered,
      });
    }
  }
  counts.links = usedLinks.size;
  let text = '';
  parts.forEach((part, i) => {
    const prev = parts[i - 1];
    // List items follow each other on single lines; a blank line starts another list kind.
    if (prev) text += part.list && prev.list && part.ordered === prev.ordered ? '\n' : '\n\n';
    text += part.text;
  });
  return { text, counts };
}
