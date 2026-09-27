/**
 * Named destinations (ISO 32000-2 §12.3.2.4), shared by the assembler (link and outline
 * reconciliation) and the source inspector (outline /XYZ facts).
 */

import {
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFHexString,
  PDFName,
  type PDFObject,
  PDFString,
} from '@cantoo/pdf-lib';

/** Text of a name or string object (destination names can be either). */
export function nameText(value: PDFObject | undefined): string | undefined {
  if (value instanceof PDFName) return value.decodeText();
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  return undefined;
}

/** Cap on name-tree nodes visited (malformed or hostile trees). */
const MAX_NAME_TREE_NODES = 10_000;

/**
 * Resolves named destinations (ISO 32000-2 §12.3.2.4): PDF 1.1 catalog /Dests dictionary
 * (keys are names) and PDF 1.2+ /Names /Dests name tree (keys are strings). Values are an
 * explicit destination array or a dictionary whose /D holds one. Both lookups are tried for
 * either kind of name, as real files mix them up. Built lazily, once per source.
 */
export function namedDestinationResolver(doc: PDFDocument): (name: string) => PDFArray | undefined {
  const { context, catalog } = doc;
  let table: Map<string, PDFObject> | undefined;
  const build = (): Map<string, PDFObject> => {
    const map = new Map<string, PDFObject>();
    const names = context.lookupMaybe(catalog.get(PDFName.of('Names')), PDFDict);
    const root = names ? context.lookupMaybe(names.get(PDFName.of('Dests')), PDFDict) : undefined;
    const stack = root ? [root] : [];
    const seen = new Set<PDFDict>();
    while (stack.length > 0 && seen.size < MAX_NAME_TREE_NODES) {
      const node = stack.pop() as PDFDict;
      if (seen.has(node)) continue;
      seen.add(node);
      const pairs = context.lookupMaybe(node.get(PDFName.of('Names')), PDFArray);
      for (let i = 0; pairs && i + 1 < pairs.size(); i += 2) {
        const key = nameText(context.lookup(pairs.get(i)));
        if (key !== undefined && !map.has(key)) map.set(key, pairs.get(i + 1));
      }
      const kids = context.lookupMaybe(node.get(PDFName.of('Kids')), PDFArray);
      for (let i = 0; kids && i < kids.size(); i++) {
        const kid = context.lookupMaybe(kids.get(i), PDFDict);
        if (kid) stack.push(kid);
      }
    }
    // The PDF 1.1 dictionary; the name tree wins when both define a name.
    const dests = context.lookupMaybe(catalog.get(PDFName.of('Dests')), PDFDict);
    for (const [key, value] of dests?.entries() ?? []) {
      if (!map.has(key.decodeText())) map.set(key.decodeText(), value);
    }
    return map;
  };
  return (name) => {
    table ??= build();
    const value = context.lookup(table.get(name));
    if (value instanceof PDFArray) return value;
    if (value instanceof PDFDict) return context.lookupMaybe(value.get(PDFName.of('D')), PDFArray);
    return undefined;
  };
}
