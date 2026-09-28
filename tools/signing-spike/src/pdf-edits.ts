/**
 * The changes the spike appends with Cantoo's incremental writer: an empty signature field,
 * an approval-signature placeholder (no /Perms, no /Reference), a text annotation, a content
 * change. All go through `PDFDocument.load(bytes, { forIncrementalUpdate: true })` + `commit`.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
} from '@cantoo/pdf-lib';
import type { PDFRef } from '@cantoo/pdf-lib';

/** Ten digits each: patched in place (same width, space padded) after serialisation. */
export const BYTE_RANGE_PLACEHOLDER = [0, 9_999_999_999, 9_999_999_999, 9_999_999_999] as const;

export async function loadIncremental(bytes: Uint8Array, password?: string): Promise<PDFDocument> {
  return PDFDocument.load(bytes, {
    forIncrementalUpdate: true,
    updateMetadata: false,
    preserveXFA: true,
    ...(password === undefined ? {} : { password }),
  });
}

/**
 * Appends an annotation to a page's /Annots without `PDFPageLeaf.addAnnot`: that goes through
 * `normalize()`, which wraps the page content in q/Q streams (new /Contents array) and copies
 * inherited /Resources onto the page, i.e. a content change in the signing revision.
 */
export function appendAnnot(doc: PDFDocument, pageIndex: number, ref: PDFRef): void {
  const page = doc.getPage(pageIndex);
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (annots) annots.push(ref);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
}

/** Set by the corpus spike to measure the difference (`true`: Cantoo's high-level call). */
export const options = { useAddAnnot: false };

function attach(doc: PDFDocument, pageIndex: number, ref: PDFRef): void {
  if (options.useAddAnnot) doc.getPage(pageIndex).node.addAnnot(ref);
  else appendAnnot(doc, pageIndex, ref);
}

function addWidgetField(doc: PDFDocument, fields: Record<string, unknown>): PDFRef {
  const page = doc.getPage(0);
  const widget = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: [0, 0, 0, 0],
    F: 132, // Print + Locked; invisible (zero rect)
    P: page.ref,
    ...fields,
  } as never);
  const ref = doc.context.register(widget);
  attach(doc, 0, ref);
  doc.catalog.getOrCreateAcroForm().addField(ref);
  return ref;
}

export function addEmptySignatureField(doc: PDFDocument, name: string): PDFRef {
  return addWidgetField(doc, { T: PDFString.of(name) });
}

export interface PlaceholderOptions {
  readonly name: string;
  /** Bytes reserved for the DER CMS (the hex string is twice as long). */
  readonly reserveBytes: number;
  readonly date: Date;
  readonly reason?: string;
}

export function addSignaturePlaceholder(doc: PDFDocument, o: PlaceholderOptions): PDFRef {
  const sig = doc.context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'ETSI.CAdES.detached',
    ByteRange: [...BYTE_RANGE_PLACEHOLDER],
    Contents: PDFHexString.of('0'.repeat(o.reserveBytes * 2)),
    M: PDFString.fromDate(o.date),
    ...(o.reason === undefined ? {} : { Reason: PDFString.of(o.reason) }),
  } as never);
  const sigRef = doc.context.register(sig);
  addWidgetField(doc, { T: PDFString.of(o.name), V: sigRef });
  doc.catalog.getOrCreateAcroForm().dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  return sigRef;
}

export function addTextAnnotation(doc: PDFDocument, pageIndex = 0): PDFRef {
  const page = doc.getPage(pageIndex);
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [40, 40, 60, 60],
    Contents: PDFString.of('Comment added after signing'),
    Name: 'Comment',
    F: 4,
    P: page.ref,
  } as never);
  const ref = doc.context.register(annot);
  attach(doc, pageIndex, ref);
  return ref;
}

export async function addContentChange(doc: PDFDocument): Promise<void> {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.getPage(0).drawText('Changed after signing', { x: 40, y: 80, size: 12, font });
}

/** Field names from a plain (non-incremental) reload, to prove pdf-lib re-opens the output. */
export async function reloadFieldNames(bytes: Uint8Array, password?: string): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ...(password === undefined ? {} : { password }),
  });
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  const fields = acroForm?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  const names: string[] = [];
  for (let i = 0; i < (fields?.size() ?? 0); i++) {
    const field = fields?.lookupMaybe(i, PDFDict);
    const t = field?.lookupMaybe(PDFName.of('T'), PDFString, PDFHexString);
    if (t) names.push(t.decodeText());
  }
  return names;
}
