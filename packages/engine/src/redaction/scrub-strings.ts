/**
 * Scrub step 3 (research 06 §3 step 4.3): redacted strings replaced by the placeholder in
 * every string object of the document: outline /Title, /Info, structure /ActualText, /Alt,
 * /E and /T, page-label prefixes, annotation and field strings, filespecs, URIs.
 *
 * Name-tree keys (/Names /Dests and every other tree under /Names) are renamed too; a tree
 * with a renamed key is rebuilt as a single sorted leaf (keys unique, compared by their
 * encoded bytes). Keys of the PDF 1.1 catalog /Dests dictionary are renamed the same way.
 * Named-destination referrers follow the renaming: /Dest and GoTo /D strings or names
 * equal to a renamed key get the new key, so links and outline items keep working.
 */

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

import { nameTreeEntries } from '../pdflib/metadata-walk';
import type { RedactedStringMatcher } from './strings';

export interface StringScrubResult {
  stringsReplaced: number;
  namesRenamed: number;
}

/** Keys whose name values are destination names (GoTo /D, /Dest). */
const DEST_KEYS = new Set(['D', 'Dest']);

/** Bytes a text string is written with: PDFDocEncoding-safe ASCII, else UTF-16BE + BOM. */
function encodeText(text: string): Uint8Array {
  if (/^[\x20-\x7e\t\n\r]*$/.test(text)) return Uint8Array.from(text, (c) => c.charCodeAt(0));
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < text.length; i++) {
    out[2 + i * 2] = text.charCodeAt(i) >> 8;
    out[3 + i * 2] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

/** A string object for `text` (hex, so no literal escaping is needed). */
export function textString(text: string): PDFHexString {
  return PDFHexString.fromBytes(encodeText(text));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function decoded(value: PDFObject | undefined): string | undefined {
  if (value instanceof PDFString || value instanceof PDFHexString) {
    try {
      return value.decodeText();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Runs step 3 on `doc` in place. */
export function scrubStrings(
  doc: PDFDocument,
  matcher: RedactedStringMatcher,
  placeholder: string,
): StringScrubResult {
  const result: StringScrubResult = { stringsReplaced: 0, namesRenamed: 0 };
  if (matcher.empty) return result;
  const { context } = doc;
  /** Old destination name → new one. */
  const destRenames = new Map<string, string>();
  const unique = (base: string, used: Set<string>): string => {
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base} (${n})`;
    used.add(key);
    return key;
  };

  // Name trees under /Names.
  const names = context.lookupMaybe(doc.catalog.get(PDFName.of('Names')), PDFDict);
  for (const [treeKey, treeRef] of names?.entries() ?? []) {
    const root = context.lookupMaybe(treeRef, PDFDict);
    if (!root) continue;
    const entries = nameTreeEntries(doc, root);
    if (!entries.some(([key]) => matcher.matches(key))) continue;
    const used = new Set<string>();
    const rebuilt: [Uint8Array, string, PDFObject][] = [];
    for (const [key, value] of entries) {
      if (!matcher.matches(key)) {
        if (used.has(key)) continue; // first definition wins, as readers resolve it
        used.add(key);
        rebuilt.push([encodeText(key), key, value]);
      }
    }
    for (const [key, value] of entries) {
      if (!matcher.matches(key)) continue;
      const renamed = unique(matcher.replace(key, placeholder), used);
      result.namesRenamed++;
      if (treeKey.decodeText() === 'Dests' && !destRenames.has(key)) destRenames.set(key, renamed);
      rebuilt.push([encodeText(renamed), renamed, value]);
    }
    rebuilt.sort((a, b) => compareBytes(a[0], b[0]));
    const pairs = context.obj([]);
    for (const [bytes, , value] of rebuilt) {
      pairs.push(PDFHexString.fromBytes(bytes));
      pairs.push(value);
    }
    root.delete(PDFName.of('Kids'));
    root.delete(PDFName.of('Limits'));
    root.set(PDFName.of('Names'), pairs);
  }

  // PDF 1.1 catalog /Dests: keys are names.
  const dests = context.lookupMaybe(doc.catalog.get(PDFName.of('Dests')), PDFDict);
  if (dests?.keys().some((k) => matcher.matches(k.decodeText()))) {
    const used = new Set(dests.keys().map((k) => k.decodeText()));
    for (const [key, value] of dests.entries()) {
      const old = key.decodeText();
      if (!matcher.matches(old)) continue;
      used.delete(old);
      const renamed = unique(matcher.replace(old, placeholder), used);
      dests.delete(key);
      dests.set(PDFName.of(renamed), value);
      result.namesRenamed++;
      if (!destRenames.has(old)) destRenames.set(old, renamed);
    }
  }

  // Every string of every object (and a direct trailer /Info).
  const fix = (value: PDFObject, key: string | undefined): PDFObject | undefined => {
    const text = decoded(value);
    if (text !== undefined) {
      const renamed = key !== undefined && DEST_KEYS.has(key) ? destRenames.get(text) : undefined;
      if (renamed !== undefined) return textString(renamed);
      return matcher.matches(text) ? textString(matcher.replace(text, placeholder)) : undefined;
    }
    if (value instanceof PDFName && key !== undefined && DEST_KEYS.has(key)) {
      const renamed = destRenames.get(value.decodeText());
      return renamed === undefined ? undefined : PDFName.of(renamed);
    }
    return undefined;
  };
  const seen = new Set<PDFObject>();
  const visit = (root: PDFObject) => {
    const stack: PDFObject[] = [root];
    while (stack.length > 0) {
      const o = stack.pop() as PDFObject;
      if (seen.has(o)) continue;
      seen.add(o);
      if (o instanceof PDFStream) stack.push(o.dict);
      else if (o instanceof PDFDict) {
        for (const [k, v] of o.entries()) {
          const replaced = fix(v, k.decodeText());
          if (replaced) {
            o.set(k, replaced);
            result.stringsReplaced++;
          } else stack.push(v);
        }
      } else if (o instanceof PDFArray) {
        for (let i = 0; i < o.size(); i++) {
          const replaced = fix(o.get(i), undefined);
          if (replaced) {
            o.set(i, replaced);
            result.stringsReplaced++;
          } else stack.push(o.get(i));
        }
      }
    }
  };
  for (const [, object] of context.enumerateIndirectObjects()) visit(object);
  const info = context.trailerInfo.Info;
  if (info instanceof PDFDict) visit(info);
  return result;
}
