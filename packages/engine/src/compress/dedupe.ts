/**
 * Merges streams with identical dictionaries and bytes (spec §5 "duplicate image and font
 * streams de-duplicated by hash"): typical after merging documents that embed the same
 * logo or font. Every reference to a duplicate is pointed at the first copy and the
 * duplicate is deleted. qpdf does not do this.
 */
import {
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFName,
  type PDFObject,
  PDFRawStream,
  PDFRef,
} from '@cantoo/pdf-lib';

const SKIP_TYPES = new Set(['XRef', 'ObjStm', 'Metadata']);

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

function dictKey(dict: PDFDict): string {
  const entries = dict
    .entries()
    .filter(([key]) => key !== PDFName.of('Length'))
    .map(([key, value]) => `${key.toString()} ${value.toString()}`)
    .sort();
  return entries.join('\n');
}

/** Finds duplicate streams: duplicate ref → canonical ref. */
export async function findDuplicateStreams(doc: PDFDocument): Promise<Map<string, PDFRef>> {
  const seen = new Map<string, PDFRef>();
  const duplicates = new Map<string, PDFRef>();
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const type = object.dict.get(PDFName.of('Type'));
    if (type instanceof PDFName && SKIP_TYPES.has(type.decodeText())) continue;
    if (object.contents.length < 64) continue;
    const key = `${await digest(object.contents)}\n${dictKey(object.dict)}`;
    const first = seen.get(key);
    if (first) duplicates.set(ref.toString(), first);
    else seen.set(key, ref);
  }
  return duplicates;
}

/** Rewrites references to duplicates and deletes them. Returns the number merged. */
export async function dedupeStreams(doc: PDFDocument): Promise<number> {
  const duplicates = await findDuplicateStreams(doc);
  if (duplicates.size === 0) return 0;
  const replace = (value: PDFObject): PDFObject | undefined =>
    value instanceof PDFRef ? duplicates.get(value.toString()) : undefined;
  const visit = (object: PDFObject, depth: number) => {
    if (depth > 64) return;
    const dict = object instanceof PDFRawStream ? object.dict : object;
    if (dict instanceof PDFDict) {
      for (const [key, value] of dict.entries()) {
        const next = replace(value);
        if (next) dict.set(key, next);
        else visit(value, depth + 1);
      }
    } else if (dict instanceof PDFArray) {
      for (let i = 0; i < dict.size(); i++) {
        const value = dict.get(i);
        const next = replace(value);
        if (next) dict.set(i, next);
        else visit(value, depth + 1);
      }
    }
  };
  for (const [, object] of doc.context.enumerateIndirectObjects()) visit(object, 0);
  for (const [key] of duplicates) {
    const [num, gen] = key.split(' ');
    doc.context.delete(PDFRef.of(Number(num), Number(gen)));
  }
  return duplicates.size;
}
