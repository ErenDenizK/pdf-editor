/**
 * Cross-reference reader for the spike's checks (ISO 32000-2 §7.5.4, §7.5.8): parses one
 * section (classic table or xref stream) completely, walks the /Prev chain and verifies every
 * in-use offset. Deliberately independent of pdf-lib, which ignores the xref when parsing.
 */
import { inflate, latin1 } from './bytes';

export type XrefKind = 'table' | 'stream';

/** type 0 free, 1 in use at `field2` (offset), 2 compressed in object stream `field2`. */
export interface XrefEntry {
  readonly num: number;
  readonly type: 0 | 1 | 2;
  readonly field2: number;
  readonly field3: number;
}

export interface XrefSection {
  readonly offset: number;
  readonly kind: XrefKind;
  readonly entries: readonly XrefEntry[];
  /** The trailer dictionary (table) or the xref stream dictionary, as raw text. */
  readonly dict: string;
  readonly prev?: number;
  readonly size?: number;
  readonly xrefStm?: number;
  /** Object number of the xref stream itself (stream sections). */
  readonly streamObject?: number;
}

export function dictInt(dict: string, key: string): number | undefined {
  const m = new RegExp(`/${key}\\s+(\\d+)(?!\\s+\\d+\\s+R)`).exec(dict);
  return m ? Number(m[1]) : undefined;
}

function dictNumbers(dict: string, key: string): number[] | undefined {
  const m = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`).exec(dict);
  return m?.[1]?.trim().split(/\s+/).filter(Boolean).map(Number);
}

export function lastStartxref(bytes: Uint8Array, end = bytes.length): number | undefined {
  const tail = latin1(bytes, Math.max(0, end - 2048), end);
  const at = tail.lastIndexOf('startxref');
  if (at < 0) return undefined;
  const m = /^startxref\s+(\d+)/.exec(tail.slice(at));
  return m ? Number(m[1]) : undefined;
}

function undoPngPredictor(data: Uint8Array, columns: number): Uint8Array {
  const rowLength = columns + 1;
  const rows = Math.floor(data.length / rowLength);
  const out = new Uint8Array(rows * columns);
  for (let r = 0; r < rows; r++) {
    const filter = data[r * rowLength];
    for (let c = 0; c < columns; c++) {
      const raw = data[r * rowLength + 1 + c] ?? 0;
      const up = r > 0 ? (out[(r - 1) * columns + c] ?? 0) : 0;
      if (filter === 0) out[r * columns + c] = raw;
      else if (filter === 2) out[r * columns + c] = (raw + up) & 0xff;
      else throw new Error(`PNG predictor filter ${filter} not supported by the spike`);
    }
  }
  return out;
}

function parseTable(text: string, offset: number): XrefSection {
  const entries: XrefEntry[] = [];
  let pos = 4;
  const ws = /\s*/y;
  const sub = /(\d+)\s+(\d+)/y;
  const entry = /(\d{10}) (\d{5}) ([nf])/y;
  for (;;) {
    ws.lastIndex = pos;
    ws.exec(text);
    pos = ws.lastIndex;
    if (text.startsWith('trailer', pos)) break;
    sub.lastIndex = pos;
    const s = sub.exec(text);
    if (!s) throw new Error(`bad xref subsection header at ${offset + pos}`);
    pos = sub.lastIndex;
    const first = Number(s[1]);
    const count = Number(s[2]);
    for (let i = 0; i < count; i++) {
      ws.lastIndex = pos;
      ws.exec(text);
      entry.lastIndex = ws.lastIndex;
      const e = entry.exec(text);
      if (!e) throw new Error(`bad xref entry ${first + i} at ${offset + ws.lastIndex}`);
      pos = entry.lastIndex;
      const inUse = e[3] === 'n';
      entries.push({
        num: first + i,
        type: inUse ? 1 : 0,
        field2: Number(e[1]),
        field3: Number(e[2]),
      });
    }
  }
  const end = text.indexOf('startxref', pos);
  const dict = text.slice(pos + 7, end < 0 ? undefined : end);
  const prev = dictInt(dict, 'Prev');
  const size = dictInt(dict, 'Size');
  const xrefStm = dictInt(dict, 'XRefStm');
  return {
    offset,
    kind: 'table',
    entries,
    dict,
    ...(prev === undefined ? {} : { prev }),
    ...(size === undefined ? {} : { size }),
    ...(xrefStm === undefined ? {} : { xrefStm }),
  };
}

async function parseStream(
  bytes: Uint8Array,
  text: string,
  offset: number,
  num: number,
): Promise<XrefSection> {
  const streamAt = text.indexOf('stream');
  const dict = text.slice(text.indexOf('<<'), streamAt);
  if (!/\/Type\s*\/XRef/.test(dict)) throw new Error(`object at ${offset} is not an xref stream`);
  let dataAt = streamAt + 6;
  if (text[dataAt] === '\r') dataAt++;
  if (text[dataAt] === '\n') dataAt++;
  const length = dictInt(dict, 'Length');
  if (length === undefined) throw new Error('xref stream /Length is not a direct integer');
  let data: Uint8Array = bytes.subarray(offset + dataAt, offset + dataAt + length);
  if (/\/Filter\s*\/FlateDecode/.test(dict)) data = await inflate(data);
  const w = dictNumbers(dict, 'W');
  if (w?.length !== 3) throw new Error('xref stream /W missing');
  const [w1, w2, w3] = w as [number, number, number];
  const predictor = dictInt(dict, 'Predictor');
  if (predictor !== undefined && predictor >= 10) {
    data = undoPngPredictor(data, dictInt(dict, 'Columns') ?? w1 + w2 + w3);
  }
  const size = dictInt(dict, 'Size') ?? 0;
  const index = dictNumbers(dict, 'Index') ?? [0, size];
  const read = (at: number, width: number): number => {
    let v = 0;
    for (let i = 0; i < width; i++) v = v * 256 + (data[at + i] ?? 0);
    return v;
  };
  const entries: XrefEntry[] = [];
  let at = 0;
  for (let i = 0; i + 1 < index.length; i += 2) {
    const first = index[i] ?? 0;
    const count = index[i + 1] ?? 0;
    for (let k = 0; k < count; k++) {
      const type = w1 === 0 ? 1 : read(at, w1);
      entries.push({
        num: first + k,
        type: type === 0 ? 0 : type === 2 ? 2 : 1,
        field2: read(at + w1, w2),
        field3: read(at + w1 + w2, w3),
      });
      at += w1 + w2 + w3;
    }
  }
  const prev = dictInt(dict, 'Prev');
  return {
    offset,
    kind: 'stream',
    entries,
    dict,
    size,
    streamObject: num,
    ...(prev === undefined ? {} : { prev }),
  };
}

export async function parseSection(bytes: Uint8Array, offset: number): Promise<XrefSection> {
  if (offset < 0 || offset >= bytes.length) throw new Error(`xref offset ${offset} out of file`);
  const text = latin1(bytes, offset);
  if (text.startsWith('xref')) return parseTable(text, offset);
  const obj = /^(\d+)\s+(\d+)\s+obj\s*<</.exec(text);
  if (obj) return parseStream(bytes, text, offset, Number(obj[1]));
  throw new Error(`no xref section at offset ${offset}`);
}

/** Newest first. Stops at the first broken link and reports it. */
export async function walkChain(
  bytes: Uint8Array,
): Promise<{ sections: XrefSection[]; error?: string }> {
  const sections: XrefSection[] = [];
  let offset = lastStartxref(bytes);
  if (offset === undefined) return { sections, error: 'no startxref' };
  const seen = new Set<number>();
  while (offset !== undefined && sections.length < 64) {
    if (seen.has(offset)) return { sections, error: `cycle at ${offset}` };
    seen.add(offset);
    try {
      const section = await parseSection(bytes, offset);
      sections.push(section);
      offset = section.prev;
    } catch (error) {
      return { sections, error: (error as Error).message };
    }
  }
  return { sections };
}

/** Every in-use entry must point exactly at `num gen obj`. Returns the bad object numbers. */
export function badOffsets(bytes: Uint8Array, section: XrefSection): number[] {
  const bad: number[] = [];
  for (const e of section.entries) {
    if (e.type !== 1) continue;
    const head = latin1(bytes, e.field2, Math.min(bytes.length, e.field2 + 24));
    if (!head.startsWith(`${e.num} ${e.field3} obj`)) bad.push(e.num);
  }
  return bad;
}
