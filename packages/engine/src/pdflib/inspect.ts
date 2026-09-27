/**
 * Source inspection with pdf-lib: document facts PDFium (through EmbedPDF 2.15) does not
 * expose. Runs in the assembly worker (`AssemblerProxy.inspect`) or directly in tests.
 *
 * - Page labels: the catalog's /PageLabels number tree (ISO 32000-2 §12.4.2) expanded to one
 *   string per page. PDFium has `FPDF_GetPageLabel` and `@embedpdf/pdfium` even exports it,
 *   but EmbedPDF runs PDFium inside its own blob: worker and offers no engine method for it,
 *   so the low-level module is unreachable from the adapter. TODO(M2): switch to PDFium once
 *   EmbedPDF exposes page labels (one parse instead of two).
 * - /Lang from the catalog (EmbedPDF's getMetadata omits it).
 * - Outline facts EmbedPDF drops: the open state (/Count sign) and which /XYZ parameters
 *   are null (PDFium reports null as 0, a valid coordinate).
 * - The open state of note popups (EmbedPDF does not read popups).
 * - Custom Info keys (EmbedPDF's getMetadata reads the standard keys only) and the
 *   /Encrypt dictionary's algorithm and /P (EmbedPDF reports neither the handler nor, for
 *   owner-unlocked files, the authored permissions).
 */

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFString,
} from '@cantoo/pdf-lib';
import type { PageLabelStyle, PermissionFlags, SecurityHandler } from '@pdf-editor/document-model';

import type { EncryptionFacts, NoteStateFact, OutlineItemFacts, SourceInspection } from '../types';
import { nameText, namedDestinationResolver } from './named-destinations';
import { formatNumber } from './page-labels';

const STYLE_BY_NAME: Readonly<Record<string, PageLabelStyle>> = {
  D: 'decimal',
  R: 'roman-upper',
  r: 'roman-lower',
  A: 'alpha-upper',
  a: 'alpha-lower',
};

/** Cap on number-tree nodes visited (malformed or hostile trees). */
const MAX_TREE_NODES = 10_000;

function text(value: PDFObject | undefined): string | undefined {
  return value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : undefined;
}

interface LabelEntry {
  readonly start: number;
  readonly style: PageLabelStyle;
  readonly prefix: string;
  readonly first: number;
}

/** Collects (key, value) pairs of a number tree, depth first, with a cycle guard. */
function numberTreeEntries(doc: PDFDocument, root: PDFDict): [number, PDFObject][] {
  const { context } = doc;
  const out: [number, PDFObject][] = [];
  const stack: PDFDict[] = [root];
  const seen = new Set<PDFDict>();
  while (stack.length > 0 && seen.size < MAX_TREE_NODES) {
    const node = stack.pop() as PDFDict;
    if (seen.has(node)) continue;
    seen.add(node);
    const nums = context.lookupMaybe(node.get(PDFName.of('Nums')), PDFArray);
    if (nums) {
      for (let i = 0; i + 1 < nums.size(); i += 2) {
        const key = context.lookup(nums.get(i));
        const value = context.lookup(nums.get(i + 1));
        if (key instanceof PDFNumber && value) out.push([key.asNumber(), value]);
      }
    }
    const kids = context.lookupMaybe(node.get(PDFName.of('Kids')), PDFArray);
    for (let i = (kids?.size() ?? 0) - 1; i >= 0; i--) {
      const kid = context.lookupMaybe(kids?.get(i), PDFDict);
      if (kid) stack.push(kid);
    }
  }
  return out;
}

/** Per-page label strings from /PageLabels; undefined when the catalog has none. */
export function readPageLabels(doc: PDFDocument): string[] | undefined {
  const { context } = doc;
  const tree = context.lookupMaybe(doc.catalog.get(PDFName.of('PageLabels')), PDFDict);
  if (!tree) return undefined;
  const entries: LabelEntry[] = [];
  for (const [start, value] of numberTreeEntries(doc, tree)) {
    if (!(value instanceof PDFDict) || !Number.isInteger(start) || start < 0) continue;
    const s = context.lookup(value.get(PDFName.of('S')));
    const st = context.lookup(value.get(PDFName.of('St')));
    entries.push({
      start,
      style: s instanceof PDFName ? (STYLE_BY_NAME[s.decodeText()] ?? 'none') : 'none',
      prefix: text(context.lookup(value.get(PDFName.of('P')))) ?? '',
      first: st instanceof PDFNumber && st.asNumber() >= 1 ? Math.floor(st.asNumber()) : 1,
    });
  }
  entries.sort((a, b) => a.start - b.start);
  const count = doc.getPageCount();
  const labels: string[] = [];
  let e = -1;
  for (let index = 0; index < count; index++) {
    while (e + 1 < entries.length && (entries[e + 1] as LabelEntry).start <= index) e++;
    const entry = entries[e];
    // Pages before the first range: PDFium's FPDF_GetPageLabel answers the 1-based position.
    labels.push(
      entry
        ? entry.prefix + formatNumber(entry.style, entry.first + index - entry.start)
        : String(index + 1),
    );
  }
  return labels;
}

export function readLanguage(doc: PDFDocument): string | undefined {
  const lang = text(doc.context.lookup(doc.catalog.get(PDFName.of('Lang'))))?.trim();
  return lang === undefined || lang === '' ? undefined : lang;
}

/** Cap on outline items visited (malformed or hostile outlines). */
const MAX_OUTLINE_ITEMS = 100_000;

function xyzFacts(
  doc: PDFDocument,
  item: PDFDict,
  resolve: (name: string) => PDFArray | undefined,
): OutlineItemFacts['xyz'] {
  const { context } = doc;
  let destination: PDFObject | undefined = context.lookup(item.get(PDFName.of('Dest')));
  if (!destination) {
    const action = context.lookupMaybe(item.get(PDFName.of('A')), PDFDict);
    if (action && context.lookup(action.get(PDFName.of('S'))) === PDFName.of('GoTo')) {
      destination = context.lookup(action.get(PDFName.of('D')));
    }
  }
  const name = nameText(destination);
  if (name !== undefined) destination = resolve(name);
  if (destination instanceof PDFDict) {
    destination = context.lookup(destination.get(PDFName.of('D')));
  }
  if (!(destination instanceof PDFArray)) return undefined;
  if (context.lookup(destination.get(1)) !== PDFName.of('XYZ')) return undefined;
  const param = (index: number): number | null => {
    const value = index < destination.size() ? context.lookup(destination.get(index)) : undefined;
    return value instanceof PDFNumber ? value.asNumber() : null;
  };
  return { left: param(2), top: param(3), zoom: param(4) };
}

/**
 * Outline items in pre-order (the order `/First` + `/Next` visits them, as PDFium does):
 * open state from the /Count sign and /XYZ parameter presence. Undefined without outline.
 */
export function readOutlineFacts(doc: PDFDocument): OutlineItemFacts[] | undefined {
  const { context } = doc;
  const root = context.lookupMaybe(doc.catalog.get(PDFName.of('Outlines')), PDFDict);
  if (!root) return undefined;
  const resolve = namedDestinationResolver(doc);
  const out: OutlineItemFacts[] = [];
  const seen = new Set<PDFDict>();
  const visit = (first: PDFObject | undefined, depth: number): void => {
    let item = context.lookupMaybe(first, PDFDict);
    while (item && !seen.has(item) && seen.size < MAX_OUTLINE_ITEMS && depth < 64) {
      seen.add(item);
      const count = context.lookup(item.get(PDFName.of('Count')));
      const xyz = xyzFacts(doc, item, resolve);
      out.push({
        open: count instanceof PDFNumber && count.asNumber() > 0,
        ...(xyz ? { xyz } : {}),
      });
      visit(item.get(PDFName.of('First')), depth + 1);
      item = context.lookupMaybe(item.get(PDFName.of('Next')), PDFDict);
    }
  };
  visit(root.get(PDFName.of('First')), 0);
  return out;
}

function bool(value: PDFObject | undefined): boolean | undefined {
  return value instanceof PDFBool ? value.asBoolean() : undefined;
}

/** Open state of note (/Text) annotations: their popup's /Open, else their own /Open. */
export function readNoteStates(doc: PDFDocument): NoteStateFact[] {
  const { context } = doc;
  const out: NoteStateFact[] = [];
  doc.getPages().forEach((page, pageIndex) => {
    const annots = context.lookupMaybe(page.node.get(PDFName.of('Annots')), PDFArray);
    for (let index = 0; annots && index < annots.size(); index++) {
      const annot = context.lookupMaybe(annots.get(index), PDFDict);
      if (!annot || context.lookup(annot.get(PDFName.of('Subtype'))) !== PDFName.of('Text')) {
        continue;
      }
      const popup = context.lookupMaybe(annot.get(PDFName.of('Popup')), PDFDict);
      const open =
        bool(context.lookup(popup?.get(PDFName.of('Open')))) ??
        bool(context.lookup(annot.get(PDFName.of('Open'))));
      if (open === undefined) continue;
      const nm = text(context.lookup(annot.get(PDFName.of('NM'))));
      out.push({ pageIndex, index, open, ...(nm ? { nm } : {}) });
    }
  });
  return out;
}

/** Info keys ISO 32000-2 §14.3.3 defines (everything else is a custom key). */
const STANDARD_INFO = new Set([
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
  'Trapped',
]);

/** Cap on custom Info keys read (hostile files). */
const MAX_CUSTOM_KEYS = 256;

/** The document information dictionary, when the trailer has one. */
export function infoDict(doc: PDFDocument): PDFDict | undefined {
  return doc.context.lookupMaybe(doc.context.trailerInfo.Info, PDFDict);
}

/** Custom text keys of the Info dictionary (non-text values are skipped). */
export function readCustomInfo(doc: PDFDocument): Record<string, string> {
  const info = infoDict(doc);
  const out: Record<string, string> = {};
  if (!info) return out;
  let count = 0;
  for (const [key, value] of info.entries()) {
    const name = key.decodeText();
    if (STANDARD_INFO.has(name)) continue;
    const decoded = text(doc.context.lookup(value));
    if (decoded === undefined) continue;
    out[name] = decoded;
    if (++count >= MAX_CUSTOM_KEYS) break;
  }
  return out;
}

/**
 * Permission flags from a /P value (ISO 32000-2 Table 22). Revision 2 handlers define bits
 * 3–6 only; the later bits follow their revision-2 counterparts.
 */
export function permissionsFromP(p: number, revision = 3): PermissionFlags {
  const bit = (n: number) => (p & (1 << (n - 1))) !== 0;
  const print = bit(3);
  const modify = bit(4);
  const copy = bit(5);
  const annotate = bit(6);
  if (revision < 3) {
    return {
      print,
      printHighQuality: print,
      modify,
      copy,
      annotate,
      fillForms: annotate,
      accessibility: copy,
      assemble: modify,
    };
  }
  return {
    print,
    printHighQuality: print && bit(12),
    modify,
    copy,
    annotate,
    fillForms: bit(9),
    accessibility: bit(10),
    assemble: bit(11),
  };
}

function numberOf(doc: PDFDocument, value: PDFObject | undefined): number | undefined {
  const resolved = doc.context.lookup(value);
  return resolved instanceof PDFNumber ? resolved.asNumber() : undefined;
}

function nameOf(doc: PDFDocument, value: PDFObject | undefined): string | undefined {
  const resolved = doc.context.lookup(value);
  return resolved instanceof PDFName ? resolved.decodeText() : undefined;
}

/** The /Encrypt dictionary's algorithm, revision and /P; undefined when not encrypted. */
export function readEncryption(doc: PDFDocument): EncryptionFacts | undefined {
  const enc = doc.context.lookupMaybe(doc.context.trailerInfo.Encrypt, PDFDict);
  if (!enc) return undefined;
  const filter = nameOf(doc, enc.get(PDFName.of('Filter'))) ?? 'Standard';
  const v = numberOf(doc, enc.get(PDFName.of('V'))) ?? 0;
  const r = numberOf(doc, enc.get(PDFName.of('R'))) ?? 0;
  const length = numberOf(doc, enc.get(PDFName.of('Length')));
  const p = numberOf(doc, enc.get(PDFName.of('P')));
  let handler: SecurityHandler = 'unknown';
  let keyBits: number | undefined = length;
  if (filter === 'Standard') {
    if (v === 1) {
      handler = 'rc4-40';
      keyBits = 40;
    } else if (v === 2 || v === 3) {
      keyBits = length ?? 40;
      handler = keyBits <= 40 ? 'rc4-40' : 'rc4-128';
    } else if (v === 4) {
      const cfName = nameOf(doc, enc.get(PDFName.of('StmF'))) ?? 'Identity';
      const cf = doc.context.lookupMaybe(enc.get(PDFName.of('CF')), PDFDict);
      const filterDict = cf
        ? doc.context.lookupMaybe(cf.get(PDFName.of(cfName)), PDFDict)
        : undefined;
      const cfm = filterDict ? nameOf(doc, filterDict.get(PDFName.of('CFM'))) : undefined;
      if (cfm === 'AESV2') handler = 'aes-128';
      else if (cfm === 'V2') handler = 'rc4-128';
      keyBits = 128;
    } else if (v === 5) {
      handler = 'aes-256';
      keyBits = 256;
    }
  }
  return {
    handler,
    filter,
    v,
    r,
    ...(keyBits === undefined ? {} : { keyBits }),
    ...(p === undefined ? {} : { permissions: permissionsFromP(p | 0, r) }),
  };
}

/**
 * Loads `bytes` with pdf-lib for reading. Encrypted files open with `password`, else with
 * the empty user password (owner-only files); `undefined` when neither works.
 */
export async function loadForReading(
  bytes: ArrayBuffer | Uint8Array,
  password: string | undefined,
): Promise<PDFDocument | undefined> {
  const attempts = password === undefined ? [undefined, ''] : [password];
  for (const attempt of attempts) {
    try {
      return await PDFDocument.load(bytes, {
        updateMetadata: false,
        throwOnInvalidObject: false,
        ...(attempt === undefined ? {} : { password: attempt }),
      });
    } catch {
      // Next attempt.
    }
  }
  return undefined;
}

/** Loads an encrypted file without decrypting it (structure and /Encrypt only). */
export async function loadEncryptedRaw(
  bytes: ArrayBuffer | Uint8Array,
): Promise<PDFDocument | undefined> {
  try {
    return await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: false,
      ignoreEncryption: true,
    });
  } catch {
    return undefined;
  }
}

function hasToken(bytes: Uint8Array, token: string): boolean {
  const first = token.charCodeAt(0);
  for (let i = bytes.indexOf(first); i !== -1; i = bytes.indexOf(first, i + 1)) {
    let match = true;
    for (let j = 1; j < token.length; j++) {
      if (bytes[i + j] !== token.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * The /Encrypt facts of `bytes`. pdf-lib drops /Encrypt from the trailer once it decrypted
 * a file, so they are read from a second, non-decrypting parse (only for files that carry
 * the token; the trailer is never in a compressed object stream).
 */
export async function readEncryptionOf(
  input: ArrayBuffer | Uint8Array,
): Promise<EncryptionFacts | undefined> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!hasToken(bytes, '/Encrypt')) return undefined;
  const raw = await loadEncryptedRaw(bytes);
  try {
    return raw ? readEncryption(raw) : undefined;
  } catch {
    return undefined;
  }
} /**
 * Parses `bytes` (not mutated, not transferred) and reads what PDFium does not report.
 * Never throws for damaged or locked files: it returns what it could read (possibly `{}`).
 */
export async function inspectSource(
  bytes: ArrayBuffer | Uint8Array,
  options: { readonly password?: string } = {},
): Promise<SourceInspection> {
  const loaded = await loadForReading(bytes, options.password);
  const encryption = await readEncryptionOf(bytes);
  // Locked without the right password: the /Encrypt facts are still readable.
  if (!loaded) return encryption ? { encryption } : {};
  const doc = loaded;
  const out: {
    pageLabels?: string[];
    language?: string;
    outline?: OutlineItemFacts[];
    noteStates?: NoteStateFact[];
    customInfo?: Record<string, string>;
    encryption?: EncryptionFacts;
  } = {};
  if (encryption) out.encryption = encryption;
  try {
    const custom = readCustomInfo(doc);
    if (Object.keys(custom).length > 0) out.customInfo = custom;
  } catch {
    // Malformed Info: no custom keys.
  }
  try {
    const labels = readPageLabels(doc);
    if (labels) out.pageLabels = labels;
  } catch {
    // Malformed label tree: report no labels rather than failing the open.
  }
  const language = readLanguage(doc);
  if (language !== undefined) out.language = language;
  try {
    const outline = readOutlineFacts(doc);
    if (outline && outline.length > 0) out.outline = outline;
  } catch {
    // Malformed outline: the adapter falls back to PDFium's view.
  }
  try {
    const notes = readNoteStates(doc);
    if (notes.length > 0) out.noteStates = notes;
  } catch {
    // Malformed annotations: open states stay unknown.
  }
  return out;
}
