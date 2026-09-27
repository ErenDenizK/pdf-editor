/**
 * Cheap structural check of a PDF's cross-reference chain (ISO 32000-2 §7.5.4–§7.5.8).
 *
 * PDFium and pdf-lib both open damaged files silently: PDFium rebuilds the xref by scanning
 * for objects, pdf-lib ignores the xref altogether. Neither tells the caller, so the UI could
 * not honour "tell the user the file was repaired" (VISION.md principle 5, research 04 §12).
 * This check reads only the file's header and tail plus the xref sections it points at:
 *
 * - the header `%PDF-` must start at byte 0 (junk before it shifts every offset);
 * - the last `startxref` must exist and point at an `xref` table or an xref stream object
 *   (`N G obj << /Type /XRef … >>`);
 * - a table's subsections must parse and be followed by a `trailer` dictionary with /Size;
 * - `/Prev` (and hybrid `/XRefStm`) offsets must point at valid sections too;
 * - a sample of in-use table entries must point at `N G obj` with the right object number.
 *
 * Any failure means the reader had to reconstruct the file: `repaired: true`. The check is
 * pure (no DOM, no engine) and runs in well under a millisecond for typical files.
 */

export interface XrefCheckResult {
  /** True when the xref chain is not intact, i.e. a reader must have repaired the file. */
  readonly repaired: boolean;
  /** Why the file counts as repaired (English, for logs and tests). */
  readonly reason?: string;
}

/** How far from the end `startxref` is searched (spec: the last line; be lenient). */
const TAIL_WINDOW = 4096;
/** Max /Prev chain length followed (cycle and cost guard). */
const MAX_SECTIONS = 64;
/** In-use table entries whose offsets are spot-checked per section. */
const SAMPLED_ENTRIES = 8;

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

function isDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

function skipWhitespace(bytes: Uint8Array, at: number): number {
  let i = at;
  for (;;) {
    while (i < bytes.length && WHITESPACE.has(bytes[i] as number)) i++;
    // Comments count as whitespace between tokens.
    if (bytes[i] !== 0x25) return i;
    while (i < bytes.length && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
  }
}

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  if (at < 0 || at + text.length > bytes.length) return false;
  for (let j = 0; j < text.length; j++) {
    if (bytes[at + j] !== text.charCodeAt(j)) return false;
  }
  return true;
}

function readInt(bytes: Uint8Array, at: number): { value: number; end: number } | undefined {
  let i = at;
  let value = 0;
  if (!isDigit(bytes[i])) return undefined;
  while (isDigit(bytes[i])) {
    value = value * 10 + ((bytes[i] as number) - 0x30);
    i++;
    if (value > Number.MAX_SAFE_INTEGER / 10) return undefined;
  }
  return { value, end: i };
}

function lastIndexOf(bytes: Uint8Array, text: string, from: number, to: number): number {
  for (let i = Math.min(from, bytes.length - text.length); i >= to; i--) {
    if (startsWith(bytes, i, text)) return i;
  }
  return -1;
}

function indexOf(bytes: Uint8Array, text: string, from: number, to: number): number {
  const end = Math.min(to, bytes.length) - text.length;
  for (let i = from; i <= end; i++) {
    if (startsWith(bytes, i, text)) return i;
  }
  return -1;
}

function latin1(bytes: Uint8Array, from: number, to: number): string {
  let out = '';
  const end = Math.min(to, bytes.length);
  for (let i = from; i < end; i++) out += String.fromCharCode(bytes[i] as number);
  return out;
}

/** `N G obj` at `at` (after whitespace); returns the object number and the end offset. */
function readObjectHeader(
  bytes: Uint8Array,
  at: number,
): { objectNumber: number; end: number } | undefined {
  const num = readInt(bytes, skipWhitespace(bytes, at));
  if (!num) return undefined;
  const gen = readInt(bytes, skipWhitespace(bytes, num.end));
  if (!gen) return undefined;
  const keyword = skipWhitespace(bytes, gen.end);
  if (!startsWith(bytes, keyword, 'obj')) return undefined;
  return { objectNumber: num.value, end: keyword + 3 };
}

interface Section {
  /** Offsets of further sections to validate (/Prev, /XRefStm). */
  readonly next: readonly number[];
}

/** Numeric value of `/Key n` in a dictionary's source text. */
function dictNumber(dict: string, key: string): number | undefined {
  const match = new RegExp(`/${key}\\s+(\\d+)(?![\\d.]|\\s+\\d+\\s+R)`).exec(dict);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function parseTable(bytes: Uint8Array, at: number): Section | string {
  let i = skipWhitespace(bytes, at + 4);
  const sampled: { objectNumber: number; offset: number }[] = [];
  let subsections = 0;
  for (;;) {
    const start = readInt(bytes, i);
    if (!start) break;
    const count = readInt(bytes, skipWhitespace(bytes, start.end));
    if (!count || bytes[count.end] === 0x2e) return 'malformed xref subsection header';
    subsections++;
    i = count.end;
    for (let k = 0; k < count.value; k++) {
      i = skipWhitespace(bytes, i);
      const offset = readInt(bytes, i);
      const generation = offset && readInt(bytes, skipWhitespace(bytes, offset.end));
      if (!offset || !generation || offset.end - i !== 10) return 'malformed xref entry';
      const typeAt = skipWhitespace(bytes, generation.end);
      const type = bytes[typeAt];
      if (type !== 0x6e /* n */ && type !== 0x66 /* f */) return 'malformed xref entry';
      if (type === 0x6e && offset.value > 0 && sampled.length < SAMPLED_ENTRIES) {
        sampled.push({ objectNumber: start.value + k, offset: offset.value });
      }
      i = typeAt + 1;
    }
    i = skipWhitespace(bytes, i);
  }
  if (subsections === 0) return 'empty xref table';
  if (!startsWith(bytes, i, 'trailer')) return 'xref table is not followed by a trailer';
  const dictStart = skipWhitespace(bytes, i + 7);
  if (!startsWith(bytes, dictStart, '<<')) return 'trailer is not a dictionary';
  const dictEnd = indexOf(bytes, 'startxref', dictStart, dictStart + 65536);
  const dict = latin1(bytes, dictStart, dictEnd === -1 ? dictStart + 4096 : dictEnd);
  if (dictNumber(dict, 'Size') === undefined) return 'trailer has no /Size';
  for (const entry of sampled) {
    const header = entry.offset < bytes.length ? readObjectHeader(bytes, entry.offset) : undefined;
    if (header?.objectNumber !== entry.objectNumber) {
      return `xref entry for object ${entry.objectNumber} does not point at that object`;
    }
  }
  const next: number[] = [];
  const prev = dictNumber(dict, 'Prev');
  const stream = dictNumber(dict, 'XRefStm');
  if (prev !== undefined) next.push(prev);
  if (stream !== undefined) next.push(stream);
  return { next };
}

function parseStream(bytes: Uint8Array, at: number): Section | string {
  const header = readObjectHeader(bytes, at);
  if (!header) return 'startxref points at neither an xref table nor an object';
  const dictStart = skipWhitespace(bytes, header.end);
  if (!startsWith(bytes, dictStart, '<<')) return 'xref stream has no dictionary';
  const streamAt = indexOf(bytes, 'stream', dictStart, dictStart + 65536);
  const dict = latin1(bytes, dictStart, streamAt === -1 ? dictStart + 4096 : streamAt);
  if (!/\/Type\s*\/XRef\b/.test(dict))
    return 'startxref points at an object that is not an xref stream';
  if (dictNumber(dict, 'Size') === undefined) return 'xref stream has no /Size';
  const prev = dictNumber(dict, 'Prev');
  return { next: prev === undefined ? [] : [prev] };
}

export function checkXrefStructure(input: Uint8Array | ArrayBuffer): XrefCheckResult {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const broken = (reason: string): XrefCheckResult => ({ repaired: true, reason });
  if (!startsWith(bytes, 0, '%PDF-')) {
    return broken(
      indexOf(bytes, '%PDF-', 0, 65536) === -1 ? 'no PDF header' : 'data before the PDF header',
    );
  }
  const tailStart = Math.max(0, bytes.length - TAIL_WINDOW);
  const keyword = lastIndexOf(bytes, 'startxref', bytes.length, tailStart);
  if (keyword === -1) return broken('no startxref near the end of the file (truncated?)');
  const first = readInt(bytes, skipWhitespace(bytes, keyword + 9));
  if (!first) return broken('startxref has no offset');

  const queue = [first.value];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const offset = queue.shift() as number;
    if (seen.has(offset)) continue;
    if (seen.size >= MAX_SECTIONS) return broken('xref chain is too long or cyclic');
    seen.add(offset);
    if (offset <= 0 || offset >= bytes.length) return broken('xref offset outside the file');
    const section = startsWith(bytes, offset, 'xref')
      ? parseTable(bytes, offset)
      : parseStream(bytes, offset);
    if (typeof section === 'string') return broken(section);
    queue.push(...section.next);
  }
  return { repaired: false };
}
