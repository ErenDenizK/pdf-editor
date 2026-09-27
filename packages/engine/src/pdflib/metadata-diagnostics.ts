/**
 * Diagnostics for the Info panel's "Details" (spec document-tools.md §7) and what "Strip
 * metadata" would find (§3), read with pdf-lib in the assembly worker. Pure reading: the
 * bytes are parsed into a private document and never written.
 *
 * Image resolution is approximate: the first placement of an image drawn directly by a
 * page's content stream (q/Q/cm tracked, forms and patterns not entered) gives the placed
 * size; images drawn only inside forms get pixel dimensions but no DPI.
 */

import {
  decodePDFRawStream,
  PDFArray,
  PDFBool,
  PDFDict,
  type PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
} from '@cantoo/pdf-lib';

import { checkXrefStructure } from '../structure/xref-check';
import type {
  FontFact,
  ImageFact,
  InspectOptions,
  MetadataFindings,
  SourceDiagnostics,
} from '../types';
import {
  infoDict,
  loadEncryptedRaw,
  loadForReading,
  readCustomInfo,
  readEncryptionOf,
} from './inspect';
import {
  annotationSubtype,
  catalogNameTree,
  forEachDict,
  isMetadataStream,
  NAMES,
  nameTreeEntries,
  pageAnnotations,
  textOf,
} from './metadata-walk';

const LIST_CAP = 200;
/** Pages whose content streams are scanned for image placements. */
const DPI_PAGE_CAP = 300;
/** Decoded content bytes scanned per page. */
const CONTENT_BYTE_CAP = 4 * 1024 * 1024;
const SUBSET_TAG = /^[A-Z]{6}\+/;

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let out = '';
  for (let i = from; i < Math.min(to, bytes.length); i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

function headerVersion(bytes: Uint8Array): string | undefined {
  const head = ascii(bytes, 0, 1024);
  return /%PDF-(\d\.\d)/.exec(head)?.[1];
}

function numberValue(doc: PDFDocument, value: PDFObject | undefined): number | undefined {
  const resolved = doc.context.lookup(value);
  return resolved instanceof PDFNumber ? resolved.asNumber() : undefined;
}

function nameValue(doc: PDFDocument, value: PDFObject | undefined): string | undefined {
  const resolved = doc.context.lookup(value);
  if (resolved instanceof PDFName) return resolved.decodeText();
  if (resolved instanceof PDFArray) {
    const first = doc.context.lookup(resolved.get(0));
    return first instanceof PDFName ? first.decodeText() : undefined;
  }
  return undefined;
}

function effectiveVersion(doc: PDFDocument, bytes: Uint8Array) {
  const header = headerVersion(bytes) ?? '1.4';
  const catalogVersion = nameValue(doc, doc.catalog.get(PDFName.of('Version')));
  const version =
    catalogVersion && /^\d\.\d$/.test(catalogVersion) && catalogVersion > header
      ? catalogVersion
      : header;
  const extensions = doc.context.lookupMaybe(doc.catalog.get(PDFName.of('Extensions')), PDFDict);
  const adbe = extensions
    ? doc.context.lookupMaybe(extensions.get(PDFName.of('ADBE')), PDFDict)
    : undefined;
  const level = adbe ? numberValue(doc, adbe.get(PDFName.of('ExtensionLevel'))) : undefined;
  return { version, ...(level === undefined ? {} : { extensionLevel: level }) };
}

function fontFact(doc: PDFDocument, font: PDFDict): FontFact | undefined {
  const { context } = doc;
  const subtype = nameValue(doc, font.get(NAMES.Subtype)) ?? 'Unknown';
  // Descendants are reported through their Type0 parent.
  if (subtype === 'CIDFontType0' || subtype === 'CIDFontType2') return undefined;
  const base = nameValue(doc, font.get(PDFName.of('BaseFont'))) ?? '';
  let descriptorOwner = font;
  if (subtype === 'Type0') {
    const descendants = context.lookupMaybe(font.get(PDFName.of('DescendantFonts')), PDFArray);
    const first = descendants ? context.lookupMaybe(descendants.get(0), PDFDict) : undefined;
    if (first) descriptorOwner = first;
  }
  const descriptor = context.lookupMaybe(
    descriptorOwner.get(PDFName.of('FontDescriptor')),
    PDFDict,
  );
  const embedded =
    subtype === 'Type3' ||
    (descriptor !== undefined &&
      ['FontFile', 'FontFile2', 'FontFile3'].some((k) => descriptor.has(PDFName.of(k))));
  const subset = SUBSET_TAG.test(base);
  return {
    name: (subset ? base.slice(7) : base) || '(unnamed)',
    subtype,
    embedded,
    subset,
  };
}

type Matrix = [number, number, number, number, number, number];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/**
 * Minimal content-stream scan: calls `onImage(name, ctm)` for each `Do` with the current
 * transformation matrix. Strings, arrays, dictionaries and inline images are skipped.
 */
function scanContent(bytes: Uint8Array, onDo: (name: string, ctm: Matrix) => void): void {
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const operands: (number | string)[] = [];
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const c = bytes[i] as number;
    if (WS.has(c)) {
      i++;
    } else if (c === 0x25) {
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
    } else if (c === 0x28) {
      let depth = 0;
      for (; i < n; i++) {
        const b = bytes[i];
        if (b === 0x5c) i++;
        else if (b === 0x28) depth++;
        else if (b === 0x29 && --depth === 0) break;
      }
      i++;
      operands.length = 0;
    } else if (c === 0x3c && bytes[i + 1] !== 0x3c) {
      while (i < n && bytes[i] !== 0x3e) i++;
      i++;
    } else if (c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      i += c === 0x3c || c === 0x3e ? 2 : 1;
    } else if (c === 0x2f) {
      let j = i + 1;
      while (j < n && !WS.has(bytes[j] as number) && !DELIMITERS.has(bytes[j] as number)) j++;
      operands.push(ascii(bytes, i + 1, j));
      i = j;
    } else {
      let j = i;
      while (j < n && !WS.has(bytes[j] as number) && !DELIMITERS.has(bytes[j] as number)) j++;
      if (j === i) j++;
      const word = ascii(bytes, i, j);
      i = j;
      const value = Number(word);
      if (word !== '' && !Number.isNaN(value) && /^[-+.\d]/.test(word)) {
        operands.push(value);
        continue;
      }
      if (word === 'q') stack.push(ctm);
      else if (word === 'Q') ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (word === 'cm' && operands.length >= 6) {
        const m = operands.slice(-6) as number[];
        if (m.every((v) => typeof v === 'number')) ctm = multiply(m as Matrix, ctm);
      } else if (word === 'Do') {
        const name = operands[operands.length - 1];
        if (typeof name === 'string') onDo(name, ctm);
      } else if (word === 'BI') {
        // Inline image: skip to "EI" delimited by whitespace.
        while (i < n - 2) {
          if (
            bytes[i] === 0x45 &&
            bytes[i + 1] === 0x49 &&
            WS.has(bytes[i - 1] as number) &&
            (i + 2 >= n || WS.has(bytes[i + 2] as number))
          ) {
            i += 2;
            break;
          }
          i++;
        }
      }
      operands.length = 0;
    }
  }
}

function contentBytes(doc: PDFDocument, contents: PDFObject | undefined): Uint8Array[] {
  const resolved = doc.context.lookup(contents);
  const streams: PDFRawStream[] = [];
  if (resolved instanceof PDFRawStream) streams.push(resolved);
  else if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i++) {
      const s = doc.context.lookup(resolved.get(i));
      if (s instanceof PDFRawStream) streams.push(s);
    }
  }
  const out: Uint8Array[] = [];
  let total = 0;
  for (const stream of streams) {
    try {
      const bytes = decodePDFRawStream(stream).decode();
      total += bytes.length;
      if (total > CONTENT_BYTE_CAP) break;
      out.push(bytes);
    } catch {
      // Undecodable filter: skip this stream.
    }
  }
  return out;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function countTerminalFields(doc: PDFDocument, fields: PDFArray | undefined): number {
  const { context } = doc;
  let count = 0;
  const stack: PDFObject[] = [];
  for (let i = 0; fields && i < fields.size(); i++) stack.push(fields.get(i));
  const seen = new Set<PDFDict>();
  while (stack.length > 0 && seen.size < 100_000) {
    const field = context.lookupMaybe(stack.pop(), PDFDict);
    if (!field || seen.has(field)) continue;
    seen.add(field);
    const kids = context.lookupMaybe(field.get(NAMES.Kids), PDFArray);
    const namedKids: PDFObject[] = [];
    for (let i = 0; kids && i < kids.size(); i++) {
      const kid = context.lookupMaybe(kids.get(i), PDFDict);
      if (kid?.has(NAMES.T)) namedKids.push(kids.get(i));
    }
    if (namedKids.length === 0) count++;
    else stack.push(...namedKids);
  }
  return count;
}

/**
 * Reads the diagnostics of `bytes` (not mutated; may be a transferred buffer). Encrypted
 * files are decrypted with `password` (or the empty user password); without it the
 * structure is still read, but facts inside compressed object streams are missing and the
 * result is marked `partial`.
 */
export async function diagnoseSource(
  input: ArrayBuffer | Uint8Array,
  options: Pick<InspectOptions, 'password'> = {},
): Promise<SourceDiagnostics> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const warnings: string[] = [];
  const structure = checkXrefStructure(bytes);
  if (structure.repaired) {
    warnings.push(`Cross-reference table damaged: ${structure.reason ?? 'rebuilt on open'}`);
  }
  let partial = false;
  let doc = await loadForReading(bytes, options.password);
  if (!doc) {
    doc = await loadEncryptedRaw(bytes);
    partial = true;
    if (doc) warnings.push('Encrypted: facts inside encrypted objects could not be read');
  }
  const linearized = ascii(bytes, 0, 1024).includes('/Linearized');
  if (!doc) {
    return {
      version: headerVersion(bytes) ?? '?',
      pageCount: 0,
      linearized,
      tagged: false,
      formType: 'none',
      formFields: 0,
      fonts: { total: 0, embedded: 0, notEmbedded: 0, subset: 0, list: [] },
      images: { count: 0, list: [] },
      annotations: { total: 0, bySubtype: {} },
      metadata: emptyFindings(),
      warnings: [...warnings, 'The file could not be parsed'],
      partial: true,
    };
  }
  const { context, catalog } = doc;

  // Structure-level facts.
  const markInfo = context.lookupMaybe(catalog.get(PDFName.of('MarkInfo')), PDFDict);
  const marked = context.lookup(markInfo?.get(PDFName.of('Marked')));
  const tagged =
    (marked instanceof PDFBool && marked.asBoolean()) || catalog.has(PDFName.of('StructTreeRoot'));
  const acroForm = context.lookupMaybe(catalog.get(PDFName.of('AcroForm')), PDFDict);
  const fieldsArray = acroForm
    ? context.lookupMaybe(acroForm.get(PDFName.of('Fields')), PDFArray)
    : undefined;
  const formFields = countTerminalFields(doc, fieldsArray);
  const formType: SourceDiagnostics['formType'] = acroForm?.has(PDFName.of('XFA'))
    ? 'xfa'
    : formFields > 0
      ? 'acroform'
      : 'none';

  // One pass over every dictionary: fonts, images, metadata findings.
  const fonts: FontFact[] = [];
  let fontTotal = 0;
  let embedded = 0;
  let subset = 0;
  const images = new Map<PDFRef, { fact: ImageFact; order: number }>();
  const smasks = new Set<PDFRef>();
  let xmpPackets = 0;
  let javascript = 0;
  let pieceInfo = 0;
  let thumbnails = 0;
  let annotationAuthors = 0;
  let fileAttachments = 0;
  forEachDict(doc, (entry) => {
    const { dict, stream, owner } = entry;
    const type = context.lookup(dict.get(NAMES.Type));
    if (type === PDFName.of('Font')) {
      const fact = fontFact(doc, dict);
      if (fact) {
        fontTotal++;
        if (fact.embedded) embedded++;
        if (fact.subset) subset++;
        if (fonts.length < LIST_CAP) fonts.push(fact);
      }
    }
    if (stream && context.lookup(dict.get(NAMES.Subtype)) === PDFName.of('Image')) {
      const width = numberValue(doc, dict.get(PDFName.of('Width'))) ?? 0;
      const height = numberValue(doc, dict.get(PDFName.of('Height'))) ?? 0;
      const filter = nameValue(doc, dict.get(PDFName.of('Filter')));
      const filters = context.lookup(dict.get(PDFName.of('Filter')));
      const lastFilter =
        filters instanceof PDFArray ? nameValue(doc, filters.get(filters.size() - 1)) : filter;
      const colorSpace = nameValue(doc, dict.get(PDFName.of('ColorSpace')));
      const bpc = numberValue(doc, dict.get(PDFName.of('BitsPerComponent')));
      images.set(owner, {
        order: images.size,
        fact: {
          width,
          height,
          ...(lastFilter ? { filter: lastFilter } : {}),
          ...(colorSpace ? { colorSpace } : {}),
          ...(bpc === undefined ? {} : { bitsPerComponent: bpc }),
        },
      });
      const smask = dict.get(PDFName.of('SMask'));
      if (smask instanceof PDFRef) smasks.add(smask);
    }
    if (isMetadataStream(doc, entry)) xmpPackets++;
    if (context.lookup(dict.get(NAMES.S)) === NAMES.JavaScript) javascript++;
    if (dict.has(NAMES.AA)) javascript++;
    if (dict.has(NAMES.PieceInfo)) pieceInfo++;
    if (dict.has(NAMES.Thumb)) thumbnails++;
    const subtype = annotationSubtype(doc, dict);
    if (subtype !== undefined && subtype !== 'Widget') {
      if (dict.has(NAMES.T) || dict.has(NAMES.M) || dict.has(NAMES.CreationDate)) {
        annotationAuthors++;
      }
      if (subtype === 'FileAttachment') fileAttachments++;
    }
  });
  for (const ref of smasks) images.delete(ref);

  // Annotations per subtype (widgets and popups excluded), and image placements.
  const bySubtype: Record<string, number> = {};
  let annotationTotal = 0;
  for (const { annots } of pageAnnotations(doc)) {
    for (let i = 0; i < annots.size(); i++) {
      const annot = context.lookupMaybe(annots.get(i), PDFDict);
      const subtype = annot ? annotationSubtype(doc, annot) : undefined;
      if (subtype === undefined || subtype === 'Widget' || subtype === 'Popup') continue;
      bySubtype[subtype] = (bySubtype[subtype] ?? 0) + 1;
      annotationTotal++;
    }
  }
  const pages = doc.getPages();
  let pageCapHit = false;
  pages.forEach((page, pageIndex) => {
    if (pageIndex >= DPI_PAGE_CAP) {
      pageCapHit = true;
      return;
    }
    const resources = page.node.Resources();
    const xobjects = resources
      ? context.lookupMaybe(resources.get(PDFName.of('XObject')), PDFDict)
      : undefined;
    if (!xobjects) return;
    try {
      for (const content of contentBytes(doc, page.node.Contents())) {
        scanContent(content, (name, ctm) => {
          const ref = xobjects.get(PDFName.of(name));
          const image = ref instanceof PDFRef ? images.get(ref) : undefined;
          if (!image || image.fact.dpi !== undefined) return;
          const widthPt = Math.hypot(ctm[0], ctm[1]);
          const heightPt = Math.hypot(ctm[2], ctm[3]);
          if (widthPt < 0.01 || heightPt < 0.01) return;
          const dpi = Math.min(
            image.fact.width / (widthPt / 72),
            image.fact.height / (heightPt / 72),
          );
          image.fact = { ...image.fact, pageIndex, dpi: Math.round(dpi) };
        });
      }
    } catch {
      // Unparseable content: this page contributes no placements.
    }
  });
  if (pageCapHit) {
    warnings.push(`Image resolution estimated from the first ${DPI_PAGE_CAP} pages only`);
  }
  const imageFacts = [...images.values()].sort((a, b) => a.order - b.order).map((i) => i.fact);
  const dpis = imageFacts.flatMap((i) => (i.dpi === undefined ? [] : [i.dpi]));
  const medianDpi = median(dpis);

  // Metadata findings.
  const info = infoDict(doc);
  const infoKeys = info
    ? info
        .entries()
        .map(([key]) => key.decodeText())
        .filter((key) =>
          [
            'Title',
            'Author',
            'Subject',
            'Keywords',
            'Creator',
            'Producer',
            'CreationDate',
            'ModDate',
            'Trapped',
          ].includes(key),
        )
    : [];
  const embeddedTree = catalogNameTree(doc, NAMES.EmbeddedFiles);
  const embeddedFiles = embeddedTree ? nameTreeEntries(doc, embeddedTree) : [];
  const attachmentNames = embeddedFiles.slice(0, LIST_CAP).map(([name, value]) => {
    const spec = context.lookupMaybe(value, PDFDict);
    return (
      textOf(context.lookup(spec?.get(NAMES.UF))) ??
      textOf(context.lookup(spec?.get(NAMES.F))) ??
      name
    );
  });
  const metadata: MetadataFindings = {
    infoKeys,
    customKeys: Object.keys(readCustomInfo(doc)),
    xmpPackets,
    attachments: embeddedFiles.length + fileAttachments,
    attachmentNames,
    javascript,
    pieceInfo,
    thumbnails,
    annotationAuthors,
  };
  const encryption = await readEncryptionOf(bytes);
  const version = effectiveVersion(doc, bytes);
  return {
    ...version,
    pageCount: doc.getPageCount(),
    ...(encryption ? { encryption } : {}),
    linearized,
    tagged,
    formType,
    formFields,
    fonts: { total: fontTotal, embedded, notEmbedded: fontTotal - embedded, subset, list: fonts },
    images: {
      count: images.size,
      list: imageFacts.slice(0, LIST_CAP),
      ...(dpis.length > 0 ? { minDpi: Math.min(...dpis) } : {}),
      ...(medianDpi === undefined ? {} : { medianDpi: Math.round(medianDpi) }),
    },
    annotations: { total: annotationTotal, bySubtype },
    metadata,
    warnings,
    partial,
  };
}

function emptyFindings(): MetadataFindings {
  return {
    infoKeys: [],
    customKeys: [],
    xmpPackets: 0,
    attachments: 0,
    attachmentNames: [],
    javascript: 0,
    pieceInfo: 0,
    thumbnails: 0,
    annotationAuthors: 0,
  };
}
