/**
 * Cross-reference and revision reader for signatures (ISO 32000-2 §7.5.4, §7.5.6, §7.5.8):
 * parses classic tables and xref streams, walks the /Prev chain (following /XRefStm of hybrid
 * files) and finds the end of every incremental revision. Deliberately independent of
 * pdf-lib, which ignores the xref when parsing. Lifted from spike S2 (`src/xref.ts`).
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
  readonly xrefStm?: number;
  /** Object number of the xref stream itself (stream sections). */
  readonly streamObject?: number;
}

/** An indirect reference `/Key n g R` in a dictionary's raw text. */
export function dictRef(dict: string, key: string): { num: number; gen: number } | undefined {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+(\\d+)\\s+R`).exec(dict);
  return m ? { num: Number(m[1]), gen: Number(m[2]) } : undefined;
}

export function dictInt(dict: string, key: string): number | undefined {
  const m = new RegExp(`/${key}\\s+(\\d+)(?!\\s+\\d+\\s+R)`).exec(dict);
  return m ? Number(m[1]) : undefined;
}

function dictNumbers(dict: string, key: string): number[] | undefined {
  const m = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`).exec(dict);
  return m?.[1]?.trim().split(/\s+/).filter(Boolean).map(Number);
}

/** The value of the last `startxref` before `end`. */
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
      const left = c > 0 ? (out[r * columns + c - 1] ?? 0) : 0;
      const upLeft = r > 0 && c > 0 ? (out[(r - 1) * columns + c - 1] ?? 0) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new Error(`PNG predictor filter ${String(filter)} not supported`);
      }
      out[r * columns + c] = value & 0xff;
    }
  }
  return out;
}

function parseTable(text: string, offset: number): XrefSection {
  const entries: XrefEntry[] = [];
  let pos = 4;
  const ws = /\s*/y;
  const sub = /(\d+)\s+(\d+)/y;
  const entry = /(\d{10})\s(\d{5})\s([nf])/y;
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
  const xrefStm = dictInt(dict, 'XRefStm');
  return {
    offset,
    kind: 'table',
    entries,
    dict,
    ...(prev === undefined ? {} : { prev }),
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
  if (/\/Filter\s*\[?\s*\/FlateDecode/.test(dict)) data = await inflate(data);
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
    for (let k = 0; k < count && at < data.length; k++) {
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
    streamObject: num,
    ...(prev === undefined ? {} : { prev }),
  };
}

export async function parseSection(bytes: Uint8Array, offset: number): Promise<XrefSection> {
  if (offset < 0 || offset >= bytes.length) throw new Error(`xref offset ${offset} out of file`);
  const text = latin1(bytes, offset, Math.min(bytes.length, offset + 4 * 1024 * 1024));
  if (text.startsWith('xref')) return parseTable(text, offset);
  const obj = /^(\d+)\s+(\d+)\s+obj\s*<</.exec(text);
  if (obj) return parseStream(bytes, text, offset, Number(obj[1]));
  throw new Error(`no xref section at offset ${offset}`);
}

/** Newest first; hybrid sections' /XRefStm streams follow their table. Stops at a break. */
export async function walkChain(
  bytes: Uint8Array,
  end = bytes.length,
): Promise<{ sections: XrefSection[]; error?: string }> {
  const sections: XrefSection[] = [];
  let offset = lastStartxref(bytes, end);
  if (offset === undefined) return { sections, error: 'no startxref' };
  const seen = new Set<number>();
  while (offset !== undefined && sections.length < 1024) {
    if (seen.has(offset)) return { sections, error: `cycle at ${offset}` };
    seen.add(offset);
    try {
      const section = await parseSection(bytes, offset);
      sections.push(section);
      if (section.xrefStm !== undefined && !seen.has(section.xrefStm)) {
        seen.add(section.xrefStm);
        sections.push(await parseSection(bytes, section.xrefStm));
      }
      offset = section.prev;
    } catch (error) {
      return { sections, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { sections };
}

/** The xref kind of the newest section, or 'broken' when it cannot be read. */
export async function sourceXrefKind(bytes: Uint8Array): Promise<XrefKind | 'broken'> {
  const at = lastStartxref(bytes);
  if (at === undefined) return 'broken';
  try {
    return (await parseSection(bytes, at)).kind;
  } catch {
    return 'broken';
  }
}

/** One incremental revision: its `startxref` value and where it ends. */
export interface RevisionEnd {
  /** 1-based, in file order. */
  readonly revision: number;
  readonly startxref: number;
  /** Just past `%%EOF`. */
  readonly endWithoutEol: number;
  /** Past the end-of-line after `%%EOF` when there is one (else equal to `endWithoutEol`). */
  readonly end: number;
}

/**
 * Every `startxref N %%EOF` trailer in the file, in order: the revision ends. A `%%EOF` not
 * preceded by `startxref` (e.g. inside a stream) is not one. A signer may cover the EOL after
 * `%%EOF` or not, so both ends are kept. A last `startxref N` without `%%EOF` at the very end
 * of the file ends a revision too: readers find it by searching back from the end, so an
 * update written that way is part of the file (M5 review finding 1c).
 */
export function revisionEnds(bytes: Uint8Array): RevisionEnd[] {
  const text = latin1(bytes);
  const out: RevisionEnd[] = [];
  const marker = /startxref\s+(\d+)\s*%%EOF/g;
  for (let m = marker.exec(text); m; m = marker.exec(text)) {
    const endWithoutEol = m.index + m[0].length;
    let end = endWithoutEol;
    if (text[end] === '\r') end++;
    if (text[end] === '\n') end++;
    out.push({ revision: out.length + 1, startxref: Number(m[1]), endWithoutEol, end });
  }
  const last = out[out.length - 1]?.end ?? 0;
  const tail = /startxref\s+(\d+)[\t\n\f\r \0]*$/.exec(
    text.slice(Math.max(last, text.length - 2048)),
  );
  if (tail && text.slice(last).trim().length > 0) {
    const at = text.length - tail[0].length;
    const endWithoutEol = at + tail[0].trimEnd().length;
    out.push({
      revision: out.length + 1,
      startxref: Number(tail[1]),
      endWithoutEol,
      end: text.length,
    });
  }
  return out;
}

/** The revision a signed range ending at `end` belongs to, or undefined when none ends there. */
export function revisionEndingAt(
  ends: readonly RevisionEnd[],
  end: number,
): RevisionEnd | undefined {
  return ends.find((r) => r.end === end || r.endWithoutEol === end);
}
