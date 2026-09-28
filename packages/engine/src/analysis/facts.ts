/**
 * The facts diff (spec §2.1 "Facts"): what the pixel and text diffs cannot see. Facts come
 * either from the viewer's engine data (`factsFromEngine`: `OpenedDocument`, annotations,
 * form fields) or straight from the bytes with pdf-lib (`extractCompareFacts`, which also
 * reads XMP and attachments). Page facts are compared along the page map; an XMP property
 * that only mirrors a changed Info entry (dc:title ↔ Title, …) is not reported twice.
 */
import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  type PDFDocument,
  PDFDropdown,
  PDFName,
  type PDFObject,
  PDFOptionList,
  PDFRadioGroup,
  PDFRawStream,
  PDFSignature,
  PDFStream,
  PDFTextField,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import type { DocumentMetadata, Rotation, Size } from '@pdf-editor/document-model';

import { loadForReading } from '../pdflib/inspect';
import { catalogNameTree, NAMES, nameTreeEntries, textOf } from '../pdflib/metadata-walk';
import {
  type Annotation,
  type AnnotationKind,
  type CompareFacts,
  EngineError,
  type FactChange,
  type FormField,
  type OpenedDocument,
  type PagePair,
} from '../types';

/** PDF annotation subtype of each `AnnotationKind`. */
const SUBTYPE: Readonly<Record<AnnotationKind, string>> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  squiggly: 'Squiggly',
  ink: 'Ink',
  square: 'Square',
  circle: 'Circle',
  line: 'Line',
  polygon: 'Polygon',
  polyline: 'PolyLine',
  'free-text': 'FreeText',
  text: 'Text',
  stamp: 'Stamp',
  link: 'Link',
  redact: 'Redact',
};

const INFO_KEYS: readonly [keyof DocumentMetadata, string][] = [
  ['title', 'Title'],
  ['author', 'Author'],
  ['subject', 'Subject'],
  ['keywords', 'Keywords'],
  ['creator', 'Creator'],
  ['producer', 'Producer'],
  ['creationDate', 'CreationDate'],
  ['modificationDate', 'ModDate'],
];

function fieldValue(value: FormField['value']): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'string') return value;
  return value.join(', ');
}

/**
 * Facts from what the viewer's engine already reports: `opened` (sizes, rotation, metadata),
 * the annotations of every page and the form fields. XMP and attachments are not known to
 * the engine; pass them in `extra` when the inspection has them.
 */
export function factsFromEngine(
  opened: Pick<OpenedDocument, 'pages' | 'metadata'>,
  annotations: readonly (readonly Annotation[])[],
  fields: readonly FormField[],
  extra: Pick<CompareFacts, 'xmp'> & { readonly attachments?: readonly string[] } = {},
): CompareFacts {
  const info: Record<string, string> = {};
  for (const [key, name] of INFO_KEYS) {
    const v = opened.metadata[key];
    if (typeof v === 'string' && v !== '') info[name] = v;
  }
  for (const [k, v] of Object.entries(opened.metadata.custom ?? {})) info[k] = v;
  const signatures = fields
    .filter((f) => f.kind === 'signature')
    .map((f) => ({ field: f.name, signed: f.signature !== undefined }));
  return {
    info,
    ...(extra.xmp ? { xmp: extra.xmp } : {}),
    pages: opened.pages.map((p) => ({ size: p.size, rotation: p.rotation })),
    annotations: opened.pages.map((_, i) => {
      const counts: Record<string, number> = {};
      for (const a of annotations[i] ?? []) {
        const subtype = SUBTYPE[a.kind];
        counts[subtype] = (counts[subtype] ?? 0) + 1;
      }
      return counts;
    }),
    formFields: fields
      .filter((f) => f.kind !== 'signature')
      .map((f) => {
        const value = fieldValue(f.value);
        return { name: f.name, kind: f.kind, ...(value === undefined ? {} : { value }) };
      }),
    attachments: extra.attachments ?? [],
    signatures,
  };
}

// ---------------------------------------------------------------------------
// From the bytes (pdf-lib)
// ---------------------------------------------------------------------------

/** XMP properties read (volatile ones such as xmpMM:InstanceID are left out). */
const XMP_PROPERTIES = [
  'dc:title',
  'dc:creator',
  'dc:description',
  'dc:subject',
  'dc:rights',
  'pdf:Producer',
  'pdf:Keywords',
  'xmp:CreatorTool',
  'xmp:CreateDate',
  'xmp:ModifyDate',
  'xmpMM:DocumentID',
  'pdfaid:part',
  'pdfaid:conformance',
  'pdfuaid:part',
];

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function xmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (entity, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      }
      if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
      return XML_ENTITIES[body] ?? entity;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Simple XMP properties of a packet: element form (`<dc:title><rdf:Alt><rdf:li>…`, several
 * list items joined with "; ") and attribute form (`pdf:Producer="…"`).
 */
export function parseXmp(packet: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const prop of XMP_PROPERTIES) {
    const escaped = prop.replace(':', '\\:');
    const element = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`).exec(packet);
    if (element) {
      const inner = element[1] ?? '';
      const items = [...inner.matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)].map((m) =>
        xmlText(m[1] ?? ''),
      );
      const value = items.length > 0 ? items.filter((v) => v !== '').join('; ') : xmlText(inner);
      if (value !== '') out[prop] = value;
      continue;
    }
    const attribute = new RegExp(`\\s${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`).exec(packet);
    if (attribute) {
      const value = xmlText(attribute[2] ?? '');
      if (value !== '') out[prop] = value;
    }
  }
  return out;
}

function readXmp(doc: PDFDocument): Record<string, string> | undefined {
  const stream = doc.context.lookup(doc.catalog.get(NAMES.Metadata));
  if (!(stream instanceof PDFStream)) return undefined;
  try {
    const bytes =
      stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
    return parseXmp(new TextDecoder('utf-8').decode(bytes));
  } catch {
    return undefined;
  }
}

function readInfo(doc: PDFDocument): Record<string, string> {
  const out: Record<string, string> = {};
  const info = doc.context.lookupMaybe(doc.context.trailerInfo.Info, PDFDict);
  if (!info) return out;
  for (const [key, value] of info.entries()) {
    const text = textOf(doc.context.lookup(value));
    if (text !== undefined && text !== '') out[key.decodeText()] = text;
  }
  return out;
}

function fileSpecName(doc: PDFDocument, value: PDFObject | undefined): string | undefined {
  const spec = doc.context.lookup(value);
  if (!(spec instanceof PDFDict)) return textOf(spec);
  return (
    textOf(doc.context.lookup(spec.get(NAMES.UF))) ?? textOf(doc.context.lookup(spec.get(NAMES.F)))
  );
}

function readAttachments(doc: PDFDocument): string[] {
  const names: string[] = [];
  const tree = catalogNameTree(doc, NAMES.EmbeddedFiles);
  if (tree) {
    for (const [key, value] of nameTreeEntries(doc, tree))
      names.push(fileSpecName(doc, value) ?? key);
  }
  for (const page of doc.getPages()) {
    const annots = doc.context.lookupMaybe(page.node.get(NAMES.Annots), PDFArray);
    for (let i = 0; annots && i < annots.size(); i++) {
      const annot = doc.context.lookupMaybe(annots.get(i), PDFDict);
      if (annot && doc.context.lookup(annot.get(NAMES.Subtype)) === PDFName.of('FileAttachment')) {
        names.push(fileSpecName(doc, annot.get(NAMES.FS)) ?? '(unnamed)');
      }
    }
  }
  return names;
}

function normalRotation(angle: number): Rotation {
  return ((((Math.round(angle / 90) * 90) % 360) + 360) % 360) as Rotation;
}

/** Facts read from the file itself with pdf-lib (the analysis worker's self-contained path). */
export async function extractCompareFacts(
  bytes: ArrayBuffer | Uint8Array,
  password?: string,
): Promise<CompareFacts> {
  const doc = await loadForReading(bytes, password);
  if (!doc) throw new EngineError('corrupt', 'The file could not be read for its facts');
  const pages = doc.getPages();
  const formFields: { name: string; kind: string; value?: string }[] = [];
  const signatures: { field: string; signed: boolean }[] = [];
  try {
    for (const field of doc.getForm().getFields()) {
      const name = field.getName();
      if (field instanceof PDFSignature) {
        signatures.push({ field: name, signed: field.acroField.dict.has(PDFName.of('V')) });
        continue;
      }
      let kind = 'unknown';
      let value: string | undefined;
      if (field instanceof PDFTextField) {
        kind = 'text';
        value = field.getText();
      } else if (field instanceof PDFCheckBox) {
        kind = 'checkbox';
        value = field.isChecked() ? 'On' : 'Off';
      } else if (field instanceof PDFRadioGroup) {
        kind = 'radio';
        value = field.getSelected();
      } else if (field instanceof PDFDropdown) {
        kind = 'combobox';
        value = field.getSelected().join(', ');
      } else if (field instanceof PDFOptionList) {
        kind = 'listbox';
        value = field.getSelected().join(', ');
      }
      formFields.push({ name, kind, ...(value === undefined ? {} : { value }) });
    }
  } catch {
    // A form pdf-lib cannot parse: fields are left out rather than failing the comparison.
  }
  const xmp = readXmp(doc);
  return {
    info: readInfo(doc),
    ...(xmp ? { xmp } : {}),
    pages: pages.map((page) => {
      const box = page.getCropBox();
      return {
        size: { width: box.width, height: box.height },
        rotation: normalRotation(page.getRotation().angle),
      };
    }),
    annotations: pages.map((page) => {
      const counts: Record<string, number> = {};
      const annots = doc.context.lookupMaybe(page.node.get(NAMES.Annots), PDFArray);
      for (let i = 0; annots && i < annots.size(); i++) {
        const annot = doc.context.lookupMaybe(annots.get(i), PDFDict);
        const subtype = annot ? doc.context.lookup(annot.get(NAMES.Subtype)) : undefined;
        if (!(subtype instanceof PDFName)) continue;
        const name = subtype.decodeText();
        if (name === 'Widget' || name === 'Popup') continue;
        counts[name] = (counts[name] ?? 0) + 1;
      }
      return counts;
    }),
    formFields,
    attachments: readAttachments(doc),
    signatures,
  };
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/** XMP properties that mirror an Info key (ISO 32000-2 §14.3.3, Table 349). */
const XMP_MIRRORS: Readonly<Record<string, string>> = {
  'dc:title': 'Title',
  'dc:creator': 'Author',
  'dc:description': 'Subject',
  'pdf:Keywords': 'Keywords',
  'xmp:CreatorTool': 'Creator',
  'pdf:Producer': 'Producer',
  'xmp:CreateDate': 'CreationDate',
  'xmp:ModifyDate': 'ModDate',
};

const formatSize = (s: Size) =>
  `${Math.round(s.width * 100) / 100} × ${Math.round(s.height * 100) / 100} pt`;

function keyDiff(
  kind: FactChange['kind'],
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): FactChange[] {
  const out: FactChange[] = [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    const va = a[key];
    const vb = b[key];
    if (va === vb) continue;
    out.push({
      kind,
      key,
      ...(va === undefined ? {} : { a: va }),
      ...(vb === undefined ? {} : { b: vb }),
    });
  }
  return out;
}

function counted(values: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
  return map;
}

export function diffFacts(
  a: CompareFacts,
  b: CompareFacts,
  pairs: readonly PagePair[],
): FactChange[] {
  const out: FactChange[] = [];
  if (a.pages.length !== b.pages.length) {
    out.push({
      kind: 'page-count',
      key: 'pages',
      a: String(a.pages.length),
      b: String(b.pages.length),
    });
  }
  const info = keyDiff('metadata', a.info, b.info);
  out.push(...info);
  if (a.xmp || b.xmp) {
    for (const change of keyDiff('xmp', a.xmp ?? {}, b.xmp ?? {})) {
      const mirror = XMP_MIRRORS[change.key];
      const mirrored =
        mirror !== undefined &&
        info.some((c) => c.key === mirror && c.a === change.a && c.b === change.b);
      if (!mirrored) out.push(change);
    }
  }
  for (const pair of pairs) {
    if (pair.a === undefined || pair.b === undefined) continue;
    const pa = a.pages[pair.a];
    const pb = b.pages[pair.b];
    const pages = { aPage: pair.a, bPage: pair.b };
    if (pa && pb) {
      if (
        Math.abs(pa.size.width - pb.size.width) > 0.5 ||
        Math.abs(pa.size.height - pb.size.height) > 0.5
      ) {
        out.push({
          kind: 'page-size',
          key: 'size',
          a: formatSize(pa.size),
          b: formatSize(pb.size),
          ...pages,
        });
      }
      if (pa.rotation !== pb.rotation) {
        out.push({
          kind: 'page-rotation',
          key: 'rotation',
          a: `${pa.rotation}°`,
          b: `${pb.rotation}°`,
          ...pages,
        });
      }
    }
    const ca = a.annotations[pair.a] ?? {};
    const cb = b.annotations[pair.b] ?? {};
    for (const subtype of [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort()) {
      const na = ca[subtype] ?? 0;
      const nb = cb[subtype] ?? 0;
      if (na !== nb)
        out.push({ kind: 'annotations', key: subtype, a: String(na), b: String(nb), ...pages });
    }
  }
  const fieldsA = new Map(a.formFields.map((f) => [f.name, f]));
  const fieldsB = new Map(b.formFields.map((f) => [f.name, f]));
  for (const name of [...new Set([...fieldsA.keys(), ...fieldsB.keys()])].sort()) {
    const fa = fieldsA.get(name);
    const fb = fieldsB.get(name);
    if (fa && fb && fa.value === fb.value && fa.kind === fb.kind) continue;
    out.push({
      kind: 'form-field',
      key: name,
      ...(fa ? { a: fa.value ?? '' } : {}),
      ...(fb ? { b: fb.value ?? '' } : {}),
    });
  }
  const filesA = counted(a.attachments);
  const filesB = counted(b.attachments);
  for (const name of [...new Set([...filesA.keys(), ...filesB.keys()])].sort()) {
    const na = filesA.get(name) ?? 0;
    const nb = filesB.get(name) ?? 0;
    if (na === nb) continue;
    out.push({
      kind: 'attachment',
      key: name,
      ...(na > 0 ? { a: na > 1 ? `${na} files` : 'present' } : {}),
      ...(nb > 0 ? { b: nb > 1 ? `${nb} files` : 'present' } : {}),
    });
  }
  const sigA = new Map(a.signatures.map((s) => [s.field, s.signed]));
  const sigB = new Map(b.signatures.map((s) => [s.field, s.signed]));
  const state = (signed: boolean) => (signed ? 'signed' : 'empty signature field');
  for (const field of [...new Set([...sigA.keys(), ...sigB.keys()])].sort()) {
    const sa = sigA.get(field);
    const sb = sigB.get(field);
    if (sa === sb) continue;
    out.push({
      kind: 'signature',
      key: field,
      ...(sa === undefined ? {} : { a: state(sa) }),
      ...(sb === undefined ? {} : { b: state(sb) }),
    });
  }
  return out;
}
