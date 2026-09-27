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
import type { PageLabelStyle } from '@pdf-editor/document-model';

import type { NoteStateFact, OutlineItemFacts, SourceInspection } from '../types';
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

/**
 * Parses `bytes` (not mutated, not transferred) and reads what PDFium does not report.
 * Never throws for damaged or locked files: it returns what it could read (possibly `{}`).
 */
export async function inspectSource(
  bytes: ArrayBuffer | Uint8Array,
  options: { readonly password?: string } = {},
): Promise<SourceInspection> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: false,
      ...(options.password === undefined ? {} : { password: options.password }),
    });
  } catch {
    return {};
  }
  const out: {
    pageLabels?: string[];
    language?: string;
    outline?: OutlineItemFacts[];
    noteStates?: NoteStateFact[];
  } = {};
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
