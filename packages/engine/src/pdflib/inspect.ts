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
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFString,
} from '@cantoo/pdf-lib';
import type { PageLabelStyle } from '@pdf-editor/document-model';

import type { SourceInspection } from '../types';
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
  const out: { pageLabels?: string[]; language?: string } = {};
  try {
    const labels = readPageLabels(doc);
    if (labels) out.pageLabels = labels;
  } catch {
    // Malformed label tree: report no labels rather than failing the open.
  }
  const language = readLanguage(doc);
  if (language !== undefined) out.language = language;
  return out;
}
