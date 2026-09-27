/**
 * Object-graph helpers shared by the metadata writer/stripper (metadata.ts) and the
 * diagnostics (metadata-diagnostics.ts): visiting every dictionary of a document once,
 * name-tree entries, and the predicates that recognise what "Strip metadata" removes.
 */

import type { PDFRef } from '@cantoo/pdf-lib';
import {
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFHexString,
  PDFName,
  type PDFObject,
  PDFStream,
  PDFString,
} from '@cantoo/pdf-lib';

export const NAMES = {
  A: PDFName.of('A'),
  AA: PDFName.of('AA'),
  AF: PDFName.of('AF'),
  Annots: PDFName.of('Annots'),
  CreationDate: PDFName.of('CreationDate'),
  EmbeddedFiles: PDFName.of('EmbeddedFiles'),
  F: PDFName.of('F'),
  FS: PDFName.of('FS'),
  JavaScript: PDFName.of('JavaScript'),
  Kids: PDFName.of('Kids'),
  M: PDFName.of('M'),
  Metadata: PDFName.of('Metadata'),
  Names: PDFName.of('Names'),
  Next: PDFName.of('Next'),
  OpenAction: PDFName.of('OpenAction'),
  PieceInfo: PDFName.of('PieceInfo'),
  S: PDFName.of('S'),
  Subtype: PDFName.of('Subtype'),
  T: PDFName.of('T'),
  Thumb: PDFName.of('Thumb'),
  Type: PDFName.of('Type'),
  UF: PDFName.of('UF'),
};

/** Cap on containers visited (hostile files). */
const MAX_VISITED = 2_000_000;
/** Cap on name-tree nodes visited. */
const MAX_TREE_NODES = 10_000;

export interface VisitedDict {
  readonly dict: PDFDict;
  /** The indirect object this dictionary belongs to (the object itself or its container). */
  readonly owner: PDFRef;
  /** The dictionary is a stream's dictionary. */
  readonly stream?: PDFStream;
}

/**
 * Calls `visit` for every dictionary in the document (indirect ones, direct ones nested in
 * them, stream dictionaries), each exactly once, without following references (every
 * indirect object is visited on its own).
 */
export function forEachDict(doc: PDFDocument, visit: (entry: VisitedDict) => void): void {
  const seen = new Set<PDFDict | PDFArray>();
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    const stack: { value: PDFObject; stream?: PDFStream }[] = [{ value: object }];
    while (stack.length > 0 && seen.size < MAX_VISITED) {
      const { value, stream } = stack.pop() as { value: PDFObject; stream?: PDFStream };
      if (value instanceof PDFStream) {
        stack.push({ value: value.dict, stream: value });
        continue;
      }
      if (!(value instanceof PDFDict || value instanceof PDFArray)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      if (value instanceof PDFDict) {
        visit(stream ? { dict: value, owner: ref, stream } : { dict: value, owner: ref });
        for (const [, child] of value.entries()) {
          if (child instanceof PDFDict || child instanceof PDFArray) stack.push({ value: child });
        }
      } else {
        for (let i = 0; i < value.size(); i++) {
          const child = value.get(i);
          if (child instanceof PDFDict || child instanceof PDFArray) stack.push({ value: child });
        }
      }
    }
  }
}

export function textOf(value: PDFObject | undefined): string | undefined {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  if (value instanceof PDFName) return value.decodeText();
  return undefined;
}

/** (key, value) pairs of a name tree, depth first, with a cycle guard. */
export function nameTreeEntries(doc: PDFDocument, root: PDFDict): [string, PDFObject][] {
  const { context } = doc;
  const out: [string, PDFObject][] = [];
  const stack: PDFDict[] = [root];
  const seen = new Set<PDFDict>();
  while (stack.length > 0 && seen.size < MAX_TREE_NODES) {
    const node = stack.pop() as PDFDict;
    if (seen.has(node)) continue;
    seen.add(node);
    const pairs = context.lookupMaybe(node.get(NAMES.Names), PDFArray);
    for (let i = 0; pairs && i + 1 < pairs.size(); i += 2) {
      const key = textOf(context.lookup(pairs.get(i)));
      const value = pairs.get(i + 1);
      if (key !== undefined && value !== undefined) out.push([key, value]);
    }
    const kids = context.lookupMaybe(node.get(NAMES.Kids), PDFArray);
    for (let i = (kids?.size() ?? 0) - 1; i >= 0; i--) {
      const kid = context.lookupMaybe(kids?.get(i), PDFDict);
      if (kid) stack.push(kid);
    }
  }
  return out;
}

/** The catalog's /Names subtree `key` (e.g. EmbeddedFiles, JavaScript), when present. */
export function catalogNameTree(doc: PDFDocument, key: PDFName): PDFDict | undefined {
  const names = doc.context.lookupMaybe(doc.catalog.get(NAMES.Names), PDFDict);
  return names ? doc.context.lookupMaybe(names.get(key), PDFDict) : undefined;
}

/** An action dictionary of type /JavaScript. */
export function isJavaScriptAction(doc: PDFDocument, value: PDFObject | undefined): boolean {
  const action = doc.context.lookupMaybe(value, PDFDict);
  return action !== undefined && doc.context.lookup(action.get(NAMES.S)) === NAMES.JavaScript;
}

/** Annotation /Subtype of a dictionary that is an annotation, else undefined. */
export function annotationSubtype(doc: PDFDocument, dict: PDFDict): string | undefined {
  const type = doc.context.lookup(dict.get(NAMES.Type));
  const subtype = doc.context.lookup(dict.get(NAMES.Subtype));
  if (!(subtype instanceof PDFName)) return undefined;
  if (type !== undefined && type !== PDFName.of('Annot')) return undefined;
  // Annotations always have /Rect; images and fonts (which also have /Subtype) do not.
  if (!dict.has(PDFName.of('Rect'))) return undefined;
  return subtype.decodeText();
}

/** The dictionary is an XMP metadata stream's dictionary. */
export function isMetadataStream(doc: PDFDocument, entry: VisitedDict): boolean {
  return (
    entry.stream !== undefined && doc.context.lookup(entry.dict.get(NAMES.Type)) === NAMES.Metadata
  );
}

/** Annotations of every page, in page order. */
export function pageAnnotations(doc: PDFDocument): { pageIndex: number; annots: PDFArray }[] {
  const out: { pageIndex: number; annots: PDFArray }[] = [];
  doc.getPages().forEach((page, pageIndex) => {
    const annots = doc.context.lookupMaybe(page.node.get(NAMES.Annots), PDFArray);
    if (annots) out.push({ pageIndex, annots });
  });
  return out;
}
