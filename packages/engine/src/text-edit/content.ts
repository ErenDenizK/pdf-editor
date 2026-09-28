/**
 * What PDFium cannot tell the editor about a text object, read from the content stream
 * (review M2/M3/m4): the object's original character codes (PDFium has no getter for them;
 * `FPDFText_SetText` re-encodes from Unicode and picks the wrong code when a font maps two
 * codes to one character), the colour spaces it is painted in, and, for text in a Form
 * XObject, which XObject draws it, its /BBox and how often the document draws it.
 *
 * The bytes come from PDFium itself (pages imported into a scratch document and saved with
 * `PDFiumExt_SaveAsCopy`), so they include every edit made in this session: the page alone,
 * or every page when the text is in a form (the use count needs them all). pdf-lib parses
 * them.
 *
 * A text object maps to its operator by order: PDFium creates one object per text-showing
 * operator (`Tj`, `TJ`, `'`, `"`) with a font and at least one byte, and one form object per
 * `Do` of a Form XObject, in content order. The mapping is checked by the caller (the number
 * of codes must equal the number of glyphs PDFium reports), and every edit is verified by a
 * read-back afterwards, so a wrong mapping fails closed.
 */
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from '@cantoo/pdf-lib';

import type { PdfiumMemory } from '../pdfium/host/memory';

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** Saves a (scratch) document as PDFium holds it now (a full copy). */
export function saveDocumentBytes(
  m: WrappedPdfiumModule,
  mem: PdfiumMemory,
  docPtr: number,
): Uint8Array {
  const writer = m.PDFiumExt_OpenFileWriter();
  if (!writer) throw new Error('PDFiumExt_OpenFileWriter failed');
  try {
    if (!m.PDFiumExt_SaveAsCopy(docPtr, writer)) throw new Error('PDFiumExt_SaveAsCopy failed');
    const size = m.PDFiumExt_GetFileWriterSize(writer);
    return mem.withMem(size, (ptr) => {
      m.PDFiumExt_GetFileWriterData(writer, ptr, size);
      return mem.readBytes(ptr, size);
    });
  } finally {
    m.PDFiumExt_CloseFileWriter(writer);
  }
}

/**
 * Pages of `docPtr` (one, or all), imported into a scratch document and saved with their
 * resources. The copy is never encrypted (an encrypted source is read decrypted), and objects
 * shared by the imported pages stay shared in it.
 */
export function savePagesBytes(
  m: WrappedPdfiumModule,
  mem: PdfiumMemory,
  docPtr: number,
  pageIndex: number | 'all',
): Uint8Array {
  const scratch = m.FPDF_CreateNewDocument();
  if (!scratch) throw new Error('FPDF_CreateNewDocument failed');
  try {
    const imported =
      pageIndex === 'all'
        ? m.FPDF_ImportPagesByIndex(scratch, docPtr, 0, 0, 0)
        : mem.withMem(4, (ptr) => {
            mem.heap().HEAP32[ptr >> 2] = pageIndex;
            return m.FPDF_ImportPagesByIndex(scratch, docPtr, ptr, 1, 0);
          });
    if (!imported) throw new Error('FPDF_ImportPagesByIndex failed');
    return saveDocumentBytes(m, mem, scratch);
  } finally {
    m.FPDF_CloseDocument(scratch);
  }
}

/** Parsed bytes of a snapshot and the index of the page in it. */
export interface Snapshot {
  readonly doc: PDFDocument;
  readonly pageIndex: number;
}

export async function loadSnapshot(bytes: Uint8Array, pageIndex: number): Promise<Snapshot> {
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
    throwOnInvalidObject: false,
  });
  return { doc, pageIndex };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** An operand: number, name, string bytes, array, or a (skipped) dictionary. */
export type Operand =
  | { readonly kind: 'num'; readonly value: number }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'str'; readonly value: Uint8Array }
  | { readonly kind: 'array'; readonly value: Operand[] }
  | { readonly kind: 'dict' }
  | { readonly kind: 'other' };

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const MAX_TOKENS = 20_000_000;

function isRegular(byte: number): boolean {
  return !WHITESPACE.has(byte) && !DELIMITERS.has(byte);
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

/** A content-stream reader: operands are collected, operators are reported. */
class ContentReader {
  private i = 0;
  private count = 0;

  constructor(private readonly data: Uint8Array) {}

  /** Calls `onOperator` for every operator with its operands, in order. */
  run(onOperator: (op: string, operands: Operand[]) => void): void {
    const operands: Operand[] = [];
    for (;;) {
      const token = this.next();
      if (token === undefined) return;
      if (token.kind === 'op') {
        if (token.value === 'BI') this.skipInlineImage();
        else onOperator(token.value, operands.splice(0));
      } else if (token.kind === 'close') {
        // Unbalanced ']' or '>>': ignore.
      } else {
        operands.push(token.value);
      }
    }
  }

  private next():
    | { kind: 'op'; value: string }
    | { kind: 'value'; value: Operand }
    | { kind: 'close' }
    | undefined {
    const { data } = this;
    const n = data.length;
    while (this.i < n) {
      if (++this.count > MAX_TOKENS) return undefined;
      const c = data[this.i] as number;
      if (WHITESPACE.has(c)) {
        this.i++;
      } else if (c === 0x25) {
        while (this.i < n && data[this.i] !== 0x0a && data[this.i] !== 0x0d) this.i++;
      } else if (c === 0x28) {
        return { kind: 'value', value: { kind: 'str', value: this.literal() } };
      } else if (c === 0x3c) {
        if (data[this.i + 1] === 0x3c) {
          this.i += 2;
          this.skipDict();
          return { kind: 'value', value: { kind: 'dict' } };
        }
        return { kind: 'value', value: { kind: 'str', value: this.hex() } };
      } else if (c === 0x5b) {
        this.i++;
        return { kind: 'value', value: { kind: 'array', value: this.array() } };
      } else if (c === 0x5d || c === 0x3e) {
        this.i += c === 0x3e && data[this.i + 1] === 0x3e ? 2 : 1;
        return { kind: 'close' };
      } else if (c === 0x7b || c === 0x7d || c === 0x29) {
        this.i++;
      } else if (c === 0x2f) {
        let j = this.i + 1;
        while (j < n && isRegular(data[j] as number)) j++;
        const raw = String.fromCharCode(...data.subarray(this.i + 1, j));
        this.i = j;
        return {
          kind: 'value',
          value: {
            kind: 'name',
            value: raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
              String.fromCharCode(Number.parseInt(hex, 16)),
            ),
          },
        };
      } else {
        let j = this.i;
        while (j < n && isRegular(data[j] as number)) j++;
        if (j === this.i) {
          this.i++;
          continue;
        }
        const word = String.fromCharCode(...data.subarray(this.i, j));
        this.i = j;
        if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
          return { kind: 'value', value: { kind: 'num', value: Number(word) } };
        }
        if (word === 'true' || word === 'false' || word === 'null') {
          return { kind: 'value', value: { kind: 'other' } };
        }
        return { kind: 'op', value: word };
      }
    }
    return undefined;
  }

  private array(): Operand[] {
    const out: Operand[] = [];
    for (;;) {
      const token = this.next();
      if (token === undefined || token.kind === 'close') return out;
      if (token.kind === 'value') out.push(token.value);
      // An operator inside an array is malformed; PDFium ends the array there too.
      else return out;
    }
  }

  private skipDict(): void {
    let depth = 1;
    const { data } = this;
    while (this.i < data.length && depth > 0) {
      const c = data[this.i];
      if (c === 0x28) {
        this.literal();
      } else if (c === 0x3c && data[this.i + 1] === 0x3c) {
        depth++;
        this.i += 2;
      } else if (c === 0x3e && data[this.i + 1] === 0x3e) {
        depth--;
        this.i += 2;
      } else if (c === 0x3c) {
        this.hex();
      } else {
        this.i++;
      }
    }
  }

  /** A literal string at `(`: escapes decoded, end-of-line markers normalised. */
  private literal(): Uint8Array {
    const { data } = this;
    const out: number[] = [];
    let depth = 1;
    this.i++;
    while (this.i < data.length) {
      const c = data[this.i] as number;
      if (c === 0x5c) {
        const e = data[this.i + 1];
        this.i += 2;
        if (e === undefined) break;
        if (e >= 0x30 && e <= 0x37) {
          let value = e - 0x30;
          for (let k = 0; k < 2; k++) {
            const d = data[this.i];
            if (d === undefined || d < 0x30 || d > 0x37) break;
            value = value * 8 + (d - 0x30);
            this.i++;
          }
          out.push(value & 0xff);
        } else if (e === 0x6e) out.push(0x0a);
        else if (e === 0x72) out.push(0x0d);
        else if (e === 0x74) out.push(0x09);
        else if (e === 0x62) out.push(0x08);
        else if (e === 0x66) out.push(0x0c);
        else if (e === 0x0d) {
          if (data[this.i] === 0x0a) this.i++;
        } else if (e !== 0x0a) out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
        this.i++;
      } else if (c === 0x29) {
        depth--;
        this.i++;
        if (depth === 0) break;
        out.push(c);
      } else if (c === 0x0d) {
        out.push(0x0a);
        this.i++;
        if (data[this.i] === 0x0a) this.i++;
      } else {
        out.push(c);
        this.i++;
      }
    }
    return Uint8Array.from(out);
  }

  /** A hex string at `<`. */
  private hex(): Uint8Array {
    const { data } = this;
    const out: number[] = [];
    let high = -1;
    this.i++;
    while (this.i < data.length) {
      const c = data[this.i] as number;
      this.i++;
      if (c === 0x3e) break;
      const v = hexValue(c);
      if (v < 0) continue;
      if (high < 0) high = v;
      else {
        out.push(high * 16 + v);
        high = -1;
      }
    }
    if (high >= 0) out.push(high * 16);
    return Uint8Array.from(out);
  }

  /** Skips an inline image (`BI … ID <data> EI`). */
  private skipInlineImage(): void {
    const { data } = this;
    const n = data.length;
    let k = this.i;
    // Find ID.
    while (k + 1 < n) {
      if (
        data[k] === 0x49 &&
        data[k + 1] === 0x44 &&
        WHITESPACE.has(data[k - 1] as number) &&
        (k + 2 >= n || WHITESPACE.has(data[k + 2] as number))
      ) {
        break;
      }
      k++;
    }
    k += 3;
    while (k + 1 < n) {
      if (
        data[k] === 0x45 &&
        data[k + 1] === 0x49 &&
        WHITESPACE.has(data[k - 1] as number) &&
        (k + 2 >= n ||
          WHITESPACE.has(data[k + 2] as number) ||
          DELIMITERS.has(data[k + 2] as number))
      ) {
        break;
      }
      k++;
    }
    this.i = k + 2;
  }
}

// ---------------------------------------------------------------------------
// Interpretation
// ---------------------------------------------------------------------------

/**
 * The colour space family text is painted in. `DeviceRGB` and `DeviceGray` survive
 * `FPDFPageObj_SetFillColor` (RGB) unchanged in appearance; anything else does not.
 */
export type SpaceKind = 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK' | 'other';

interface GraphicsState {
  fill: SpaceKind;
  stroke: SpaceKind;
  font: PDFDict | undefined;
}

/** A text-showing operator that creates a PDFium text object. */
export interface TextOp {
  readonly font: PDFDict | undefined;
  /** The string operands, in order (TJ: its strings; numbers dropped). */
  readonly strings: readonly Uint8Array[];
  readonly fill: SpaceKind;
  readonly stroke: SpaceKind;
}

/** A `Do` of a Form XObject (a PDFium form object). */
export interface FormUse {
  readonly name: string;
  readonly ref: PDFRef | undefined;
  readonly stream: PDFRawStream;
  readonly state: Readonly<GraphicsState>;
}

export interface Interpreted {
  readonly texts: TextOp[];
  readonly forms: FormUse[];
}

function lookup(doc: PDFDocument, value: PDFObject | undefined): PDFObject | undefined {
  return value instanceof PDFRef ? doc.context.lookup(value) : value;
}

function dictOf(doc: PDFDocument, value: PDFObject | undefined): PDFDict | undefined {
  const v = lookup(doc, value);
  return v instanceof PDFDict ? v : v instanceof PDFStream ? v.dict : undefined;
}

function resourceEntry(
  doc: PDFDocument,
  resources: PDFDict | undefined,
  category: string,
  name: string,
): { value: PDFObject | undefined; raw: PDFObject | undefined } {
  const group = dictOf(doc, resources?.get(PDFName.of(category)));
  const raw = group?.get(PDFName.of(name));
  return { value: lookup(doc, raw), raw };
}

function spaceKind(doc: PDFDocument, resources: PDFDict | undefined, name: string): SpaceKind {
  if (name === 'DeviceGray' || name === 'G') return 'DeviceGray';
  if (name === 'DeviceRGB' || name === 'RGB') return 'DeviceRGB';
  if (name === 'DeviceCMYK' || name === 'CMYK') return 'DeviceCMYK';
  const { value } = resourceEntry(doc, resources, 'ColorSpace', name);
  if (value instanceof PDFName) return spaceKind(doc, undefined, value.decodeText());
  return 'other';
}

function streamData(stream: PDFObject | undefined): Uint8Array | undefined {
  if (!(stream instanceof PDFRawStream)) return undefined;
  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    return undefined;
  }
}

/** The page's content streams, decoded and joined (PDFium parses them as one). */
export function pageContent(doc: PDFDocument, page: PDFDict): Uint8Array {
  const contents = lookup(doc, page.get(PDFName.of('Contents')));
  const parts: Uint8Array[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const part = streamData(lookup(doc, contents.get(i)));
      if (part) parts.push(part);
    }
  } else {
    const part = streamData(contents);
    if (part) parts.push(part);
  }
  const total = parts.reduce((sum, p) => sum + p.length + 1, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
    out[at++] = 0x0a;
  }
  return out;
}

/** The page's resources (inherited from the page tree when absent). */
export function pageResources(doc: PDFDocument, page: PDFDict): PDFDict | undefined {
  let node: PDFDict | undefined = page;
  for (let depth = 0; node && depth < 64; depth++) {
    const resources = dictOf(doc, node.get(PDFName.of('Resources')));
    if (resources) return resources;
    node = dictOf(doc, node.get(PDFName.of('Parent')));
  }
  return undefined;
}

const INITIAL_STATE: GraphicsState = { fill: 'DeviceGray', stroke: 'DeviceGray', font: undefined };

const Form = PDFName.of('Form');

/**
 * Walks one content stream (no descent into forms): the text operators PDFium turns into
 * text objects and the `Do`s it turns into form objects, with the state they run in.
 */
export function interpret(
  doc: PDFDocument,
  data: Uint8Array,
  resources: PDFDict | undefined,
  initial: Readonly<GraphicsState> = INITIAL_STATE,
): Interpreted {
  const texts: TextOp[] = [];
  const forms: FormUse[] = [];
  let state: GraphicsState = { ...initial };
  const stack: GraphicsState[] = [];
  const name = (o: Operand | undefined) => (o?.kind === 'name' ? o.value : undefined);
  const show = (strings: Uint8Array[]) => {
    if (!state.font) return;
    const kept = strings.filter((s) => s.length > 0);
    if (kept.length === 0) return;
    texts.push({ font: state.font, strings: kept, fill: state.fill, stroke: state.stroke });
  };
  new ContentReader(data).run((op, operands) => {
    const last = operands[operands.length - 1];
    switch (op) {
      case 'q':
        stack.push({ ...state });
        break;
      case 'Q':
        state = stack.pop() ?? state;
        break;
      case 'g':
        state.fill = 'DeviceGray';
        break;
      case 'G':
        state.stroke = 'DeviceGray';
        break;
      case 'rg':
        state.fill = 'DeviceRGB';
        break;
      case 'RG':
        state.stroke = 'DeviceRGB';
        break;
      case 'k':
        state.fill = 'DeviceCMYK';
        break;
      case 'K':
        state.stroke = 'DeviceCMYK';
        break;
      case 'cs':
        state.fill = spaceKind(doc, resources, name(last) ?? '');
        break;
      case 'CS':
        state.stroke = spaceKind(doc, resources, name(last) ?? '');
        break;
      case 'Tf': {
        const fontName = name(operands[0]);
        if (fontName === undefined) break;
        const { value } = resourceEntry(doc, resources, 'Font', fontName);
        // PDFium falls back to a stock font for an unknown name: text still becomes objects.
        state.font = value instanceof PDFDict ? value : doc.context.obj({});
        break;
      }
      case 'gs': {
        const gs = dictOf(doc, resourceEntry(doc, resources, 'ExtGState', name(last) ?? '').value);
        const font = gs?.lookupMaybe(PDFName.of('Font'), PDFArray);
        const fontDict = font ? dictOf(doc, font.get(0)) : undefined;
        if (fontDict) state.font = fontDict;
        break;
      }
      case 'Tj':
      case "'":
      case '"':
        if (last?.kind === 'str') show([last.value]);
        break;
      case 'TJ':
        if (last?.kind === 'array') {
          show(last.value.flatMap((o) => (o.kind === 'str' ? [o.value] : [])));
        }
        break;
      case 'Do': {
        const xname = name(last);
        if (xname === undefined) break;
        const { value, raw } = resourceEntry(doc, resources, 'XObject', xname);
        if (value instanceof PDFRawStream && value.dict.get(PDFName.of('Subtype')) === Form) {
          forms.push({
            name: xname,
            ref: raw instanceof PDFRef ? raw : undefined,
            stream: value,
            state: { ...state },
          });
        }
        break;
      }
      default:
        break;
    }
  });
  return { texts, forms };
}

/** The /Resources of a form (PDFium falls back to the caller's resources). */
export function formResources(
  doc: PDFDocument,
  stream: PDFRawStream,
  fallback: PDFDict | undefined,
): PDFDict | undefined {
  return dictOf(doc, stream.dict.get(PDFName.of('Resources'))) ?? fallback;
}

export function formData(stream: PDFRawStream): Uint8Array | undefined {
  return streamData(stream);
}

/** A form's /BBox as `[x0, y0, x1, y1]` (form space), when it has a valid one. */
export function formBBox(
  doc: PDFDocument,
  stream: PDFRawStream,
): [number, number, number, number] | undefined {
  const array = lookup(doc, stream.dict.get(PDFName.of('BBox')));
  if (!(array instanceof PDFArray) || array.size() !== 4) return undefined;
  const v: number[] = [];
  for (let i = 0; i < 4; i++) {
    const n = lookup(doc, array.get(i));
    if (!(n instanceof PDFNumber)) return undefined;
    v.push(n.asNumber());
  }
  const [a = 0, b = 0, c = 0, d = 0] = v;
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

// ---------------------------------------------------------------------------
// Form reuse (review M2)
// ---------------------------------------------------------------------------

function sameRef(a: PDFObject | undefined, b: PDFRef): boolean {
  return (
    a instanceof PDFRef &&
    a.objectNumber === b.objectNumber &&
    a.generationNumber === b.generationNumber
  );
}

/** Names under which `target` appears in a resource dictionary's /XObject. */
function aliases(doc: PDFDocument, resources: PDFDict | undefined, target: PDFRef): Set<string> {
  const out = new Set<string>();
  const xobjects = dictOf(doc, resources?.get(PDFName.of('XObject')));
  for (const [key, value] of xobjects?.entries() ?? []) {
    if (sameRef(value, target)) out.add(key.decodeText());
  }
  return out;
}

/** `Do` operators in `data` naming one of `names`. */
function countDo(data: Uint8Array, names: ReadonlySet<string>): number {
  if (names.size === 0) return 0;
  let count = 0;
  new ContentReader(data).run((op, operands) => {
    const last = operands[operands.length - 1];
    if (op === 'Do' && last?.kind === 'name' && names.has(last.value)) count++;
  });
  return count;
}

/**
 * How many times the document draws the Form XObject `target`: `Do`s in every page's
 * content, plus any use from another content stream (a form, an appearance, a pattern),
 * counted once each (such a stream may itself be drawn any number of times, so one use
 * there already means "shared").
 */
export function formUseCount(doc: PDFDocument, target: PDFRef): number {
  let uses = 0;
  const pageContents = new Set<PDFObject>();
  for (const page of doc.getPages()) {
    const names = aliases(doc, pageResources(doc, page.node), target);
    const contents = page.node.get(PDFName.of('Contents'));
    const resolved = lookup(doc, contents);
    if (resolved instanceof PDFArray) {
      for (let i = 0; i < resolved.size(); i++)
        pageContents.add(lookup(doc, resolved.get(i)) as PDFObject);
    } else if (resolved) {
      pageContents.add(resolved);
    }
    if (names.size > 0) uses += countDo(pageContent(doc, page.node), names);
  }
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || pageContents.has(obj)) continue;
    if (ref.objectNumber === target.objectNumber) continue;
    const resources = dictOf(doc, obj.dict.get(PDFName.of('Resources')));
    if (!resources) continue;
    const names = aliases(doc, resources, target);
    if (names.size === 0) continue;
    const data = streamData(obj);
    if (data && countDo(data, names) > 0) uses += 1;
  }
  return uses;
}
