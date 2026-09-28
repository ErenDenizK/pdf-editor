/**
 * Annotation post-pass of `PdfEditor.save()` (pdf-lib). PDFium, through EmbedPDF 2.15,
 * writes annotations with an appearance stream, /NM, /F and colors, but leaves out what
 * other viewers rely on (docs/research/04-feature-feasibility.md §3):
 *
 * - `/P` (page back-pointer): never written. Set on every annotation.
 * - `/M`: written only when given. Our mapping always gives it; the pass adds it to
 *   touched annotations still lacking it.
 * - `/F` Print: forced on touched annotations.
 * - Popups: EmbedPDF has no popup support. Touched notes (/Text) always, and touched markup
 *   annotations with /Contents, get a /Popup (with /Parent, /Open) unless comments are
 *   excluded; `includeComments: false` removes every popup. Popups whose parent is gone
 *   (deleted notes) are removed.
 * - Note open state: /Open on the note and its popup.
 * - Opacity of stamps: EmbedPDF writes no /CA for stamps; the pass sets /CA and wraps the
 *   appearance in a form that applies a matching ExtGState (`/CA` alone is not honoured by
 *   all viewers).
 * - Link colour: a touched link without /C gets the stroke colour of its appearance (the
 *   generated underline; blue when none is found). pdf.js reads a missing /C as black and
 *   draws a second, black underline from /BS.
 *
 * Pure function of the bytes and the request; runs in the assembly worker when the
 * adapter's inspector offers `finalizeAnnotations`, else in the adapter's thread.
 */

import {
  decodePDFRawStream,
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  type PDFPage,
  PDFRawStream,
  PDFRef,
  PDFString,
} from '@cantoo/pdf-lib';

import type { AnnotationFinalizeRequest } from '../types';

const N = {
  Annots: PDFName.of('Annots'),
  AP: PDFName.of('AP'),
  BBox: PDFName.of('BBox'),
  C: PDFName.of('C'),
  CA: PDFName.of('CA'),
  Contents: PDFName.of('Contents'),
  ExtGState: PDFName.of('ExtGState'),
  F: PDFName.of('F'),
  M: PDFName.of('M'),
  Matrix: PDFName.of('Matrix'),
  N: PDFName.of('N'),
  NM: PDFName.of('NM'),
  Open: PDFName.of('Open'),
  P: PDFName.of('P'),
  Parent: PDFName.of('Parent'),
  Popup: PDFName.of('Popup'),
  Rect: PDFName.of('Rect'),
  Resources: PDFName.of('Resources'),
  Subtype: PDFName.of('Subtype'),
  Widget: PDFName.of('Widget'),
  XObject: PDFName.of('XObject'),
};

/** Annotation flags (ISO 32000-2 Table 167). */
export const ANNOT_FLAG = {
  Invisible: 1,
  Hidden: 2,
  Print: 4,
  NoZoom: 8,
  NoRotate: 16,
  NoView: 32,
  ReadOnly: 64,
  Locked: 128,
} as const;

/** Markup subtypes that carry their comment in a popup (FreeText shows its text itself). */
const POPUP_SUBTYPES = new Set([
  'Text',
  'Highlight',
  'Underline',
  'StrikeOut',
  'Squiggly',
  'Ink',
  'Square',
  'Circle',
  'Line',
  'Polygon',
  'PolyLine',
  'Stamp',
]);

const POPUP_WIDTH = 200;
const POPUP_HEIGHT = 120;

function text(value: PDFObject | undefined): string | undefined {
  return value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : undefined;
}

function numbers(doc: PDFDocument, value: PDFObject | undefined): number[] | undefined {
  const array = doc.context.lookupMaybe(value, PDFArray);
  if (!array) return undefined;
  const out: number[] = [];
  for (let i = 0; i < array.size(); i++) {
    const n = doc.context.lookup(array.get(i));
    if (!(n instanceof PDFNumber)) return undefined;
    out.push(n.asNumber());
  }
  return out;
}

/** PDF date string (ISO 32000-2 §7.9.4) in UTC. */
export function pdfDate(iso: string): string {
  const d = new Date(iso);
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

interface PageEntry {
  readonly ref: PDFRef | undefined;
  readonly dict: PDFDict;
  readonly subtype: string;
  readonly nm: string | undefined;
}

function entriesOf(doc: PDFDocument, annots: PDFArray): PageEntry[] {
  const { context } = doc;
  const out: PageEntry[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    const dict = context.lookupMaybe(raw, PDFDict);
    if (!dict) continue;
    const subtype = context.lookup(dict.get(N.Subtype));
    out.push({
      ref: raw instanceof PDFRef ? raw : undefined,
      dict,
      subtype: subtype instanceof PDFName ? subtype.decodeText() : '',
      nm: text(context.lookup(dict.get(N.NM))),
    });
  }
  return out;
}

function removeFromArray(array: PDFArray, target: PDFRef | PDFDict): void {
  for (let i = array.size() - 1; i >= 0; i--) {
    const value = array.get(i);
    if (value === target) array.remove(i);
  }
}

/** Places a popup next to its parent, inside the page's MediaBox. */
function popupRect(page: PDFPage, parentRect: number[] | undefined): number[] {
  const media = page.getMediaBox();
  const [x1 = media.x, y1 = media.y, x2 = x1, y2 = y1] = parentRect ?? [];
  const right = Math.max(x1, x2);
  const top = Math.max(y1, y2);
  const maxX = media.x + media.width;
  const maxY = media.y + media.height;
  let left = right + 4;
  if (left + POPUP_WIDTH > maxX) left = Math.max(media.x, Math.min(x1, x2) - 4 - POPUP_WIDTH);
  const width = Math.min(POPUP_WIDTH, media.width);
  const height = Math.min(POPUP_HEIGHT, media.height);
  let ptop = Math.min(top, maxY);
  if (ptop - height < media.y) ptop = media.y + height;
  return [left, ptop - height, Math.min(left + width, maxX), ptop];
}

/**
 * Wraps the normal appearance in a form that sets `alpha` through an ExtGState. The wrapper
 * has an identity /Matrix and a /BBox equal to the original BBox after its /Matrix, so the
 * §12.5.5 mapping onto /Rect is unchanged.
 */
function applyOpacity(doc: PDFDocument, annot: PDFDict, alpha: number): void {
  const { context } = doc;
  annot.set(N.CA, PDFNumber.of(alpha));
  const ap = context.lookupMaybe(annot.get(N.AP), PDFDict);
  const normalRef = ap?.get(N.N);
  const normal = context.lookup(normalRef);
  if (!ap || !(normal instanceof PDFRawStream) || !(normalRef instanceof PDFRef)) return;
  const bbox = numbers(doc, normal.dict.get(N.BBox)) ?? [0, 0, 0, 0];
  const matrix = numbers(doc, normal.dict.get(N.Matrix)) ?? [1, 0, 0, 1, 0, 0];
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix;
  const [bx1 = 0, by1 = 0, bx2 = 0, by2 = 0] = bbox;
  const corners = [
    [bx1, by1],
    [bx2, by1],
    [bx1, by2],
    [bx2, by2],
  ].map(([x = 0, y = 0]) => [a * x + c * y + e, b * x + d * y + f] as const);
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const gs = context.obj({ Type: 'ExtGState', CA: alpha, ca: alpha });
  const content = new TextEncoder().encode('q /GSopacity gs /APinner Do Q');
  const wrapper = context.stream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: { ExtGState: { GSopacity: gs }, XObject: { APinner: normalRef } },
  });
  ap.set(N.N, context.register(wrapper));
}

/** Default link colour (the underline EmbedPDF generates without /C). */
const LINK_RGB = [0, 0, 1] as const;

/** The last `r g b RG` stroke colour in an annotation's normal appearance, if any. */
function appearanceStrokeRgb(doc: PDFDocument, annot: PDFDict): number[] | undefined {
  const { context } = doc;
  const ap = context.lookupMaybe(annot.get(N.AP), PDFDict);
  const normal = ap ? context.lookup(ap.get(N.N)) : undefined;
  if (!(normal instanceof PDFRawStream)) return undefined;
  let content: string;
  try {
    content = new TextDecoder('latin1').decode(decodePDFRawStream(normal).decode());
  } catch {
    return undefined;
  }
  const number = String.raw`(-?(?:\d+\.?\d*|\.\d+))`;
  const ops = [
    ...content.matchAll(new RegExp(`${number}\\s+${number}\\s+${number}\\s+RG\\b`, 'g')),
  ];
  const last = ops[ops.length - 1];
  return last ? [Number(last[1]), Number(last[2]), Number(last[3])] : undefined;
}

/**
 * Applies the post-pass to `bytes` and returns the new bytes. Never changes page content
 * or widgets.
 */
export async function finalizeAnnotations(
  bytes: ArrayBuffer | Uint8Array,
  request: AnnotationFinalizeRequest,
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    throwOnInvalidObject: false,
    ...(request.password === undefined ? {} : { password: request.password }),
  });
  const { context } = doc;
  const touched = new Set(request.touched);
  const now = PDFString.of(pdfDate(request.now));
  for (const page of doc.getPages()) {
    const annots = context.lookupMaybe(page.node.get(N.Annots), PDFArray);
    if (!annots) continue;
    const entries = entriesOf(doc, annots);
    const present = new Set<PDFObject>(
      entries.flatMap((e) => (e.ref ? [e.ref, e.dict] : [e.dict])),
    );

    // Popups: drop orphans (their note was deleted) and, without comments, all of them.
    for (const entry of entries) {
      if (entry.subtype !== 'Popup') continue;
      const parentRef = entry.dict.get(N.Parent);
      const parent = context.lookupMaybe(parentRef, PDFDict);
      const orphan = !parent || !present.has(parentRef as PDFObject);
      if (orphan || !request.includeComments) {
        removeFromArray(annots, entry.ref ?? entry.dict);
        if (parent?.get(N.Popup) === (entry.ref ?? entry.dict)) parent?.delete(N.Popup);
      }
    }
    if (!request.includeComments) {
      for (const entry of entries) entry.dict.delete(N.Popup);
    }

    for (const entry of entries) {
      const { dict, subtype, nm } = entry;
      if (subtype === 'Widget') continue;
      if (page.ref) dict.set(N.P, page.ref);
      if (subtype === 'Popup' || nm === undefined || !touched.has(nm)) continue;

      if (!dict.has(N.M)) dict.set(N.M, now);
      const flags = context.lookup(dict.get(N.F));
      const f = flags instanceof PDFNumber ? flags.asNumber() : 0;
      dict.set(N.F, PDFNumber.of(f | ANNOT_FLAG.Print));

      if (subtype === 'Link' && !dict.has(N.C)) {
        dict.set(N.C, context.obj(appearanceStrokeRgb(doc, dict) ?? [...LINK_RGB]));
      }

      const alpha = request.opacity[nm];
      if (alpha !== undefined && alpha < 1) applyOpacity(doc, dict, alpha);

      const open = request.noteOpen[nm];
      if (subtype === 'Text' && open !== undefined)
        dict.set(N.Open, open ? PDFBool.True : PDFBool.False);

      if (!request.includeComments || !POPUP_SUBTYPES.has(subtype)) continue;
      const existing = context.lookupMaybe(dict.get(N.Popup), PDFDict);
      if (existing) {
        if (open !== undefined) existing.set(N.Open, open ? PDFBool.True : PDFBool.False);
        continue;
      }
      const contents = text(context.lookup(dict.get(N.Contents))) ?? '';
      if (subtype !== 'Text' && contents === '') continue;
      if (!entry.ref) continue; // a direct annotation dict cannot be a popup /Parent
      const popup = context.obj({
        Type: 'Annot',
        Subtype: 'Popup',
        Rect: popupRect(page, numbers(doc, dict.get(N.Rect))),
        F: ANNOT_FLAG.Print | ANNOT_FLAG.NoZoom | ANNOT_FLAG.NoRotate,
        Open: open ?? false,
      });
      popup.set(N.Parent, entry.ref);
      popup.set(N.NM, PDFString.of(`${nm}-popup`));
      popup.set(N.M, now);
      if (page.ref) popup.set(N.P, page.ref);
      const popupRef = context.register(popup);
      dict.set(N.Popup, popupRef);
      // Right after its parent, so readers that pair them by order find it.
      let at = annots.size();
      for (let i = 0; i < annots.size(); i++) {
        if (annots.get(i) === entry.ref) at = i + 1;
      }
      annots.insert(at, popupRef);
    }
  }
  const saved = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  return saved.slice().buffer;
}
