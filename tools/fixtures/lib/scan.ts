/**
 * Finds every object of a loaded document whose decoded value contains a
 * token. Used by the generator (to assert that a redaction fixture holds its
 * token exactly where documented) and by the verifier.
 */
import {
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFHexString,
  PDFName,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';

/** Back-links and duplicate links; following them would only produce longer paths. */
const SKIP = new Set(['Parent', 'P', 'Pg', 'Prev', 'Last', 'Popup']);
/** Visited before other keys, so shared objects get their canonical path. */
const FIRST = ['Pages', 'Names'];

function keyOrder(a: string, b: string): number {
  const [ia, ib] = [FIRST.indexOf(a), FIRST.indexOf(b)];
  if (ia !== ib) return (ia < 0 ? FIRST.length : ia) - (ib < 0 ? FIRST.length : ib);
  return a < b ? -1 : a > b ? 1 : 0;
}

function streamBytes(stream: PDFStream): Uint8Array {
  if (!(stream instanceof PDFRawStream)) return stream.getContents();
  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    return stream.getContents(); // DCT and other image filters: search the raw bytes
  }
}

/**
 * Walks the object graph from the trailer (Info first, then Root; /Pages and
 * /Names before other keys, dictionary keys otherwise sorted) and reports each hit as
 * the path it was first reached by, e.g. `Root/Pages/Kids[0]/Contents (stream)`,
 * `Info/Title` or `Root/Names/Dests/Names[0]`. Streams are inflated; strings,
 * names and dictionary keys are decoded. Objects that are in the xref but not
 * reachable from the trailer are reported as `unreachable n g R`.
 */
export function findToken(doc: PDFDocument, token: string): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  const latin = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

  const visitDict = (dict: PDFDict, path: string): void => {
    const entries = dict
      .entries()
      .map(([key, value]) => [key.decodeText(), value] as const)
      .sort(([a], [b]) => keyOrder(a, b));
    for (const [key, value] of entries) {
      if (key.includes(token)) hits.push(`${path}/${key} (key)`);
      if (!SKIP.has(key)) visit(value, `${path}/${key}`);
    }
  };

  const visit = (obj: PDFObject | undefined, path: string): void => {
    if (obj instanceof PDFRef) {
      if (seen.has(obj.tag)) return;
      seen.add(obj.tag);
      visit(doc.context.lookup(obj), path);
    } else if (obj instanceof PDFString || obj instanceof PDFHexString || obj instanceof PDFName) {
      if (obj.decodeText().includes(token)) hits.push(path);
    } else if (obj instanceof PDFArray) {
      obj.asArray().forEach((item, i) => visit(item, `${path}[${i}]`));
    } else if (obj instanceof PDFStream) {
      if (latin(streamBytes(obj)).includes(token)) hits.push(`${path} (stream)`);
      visitDict(obj.dict, path);
    } else if (obj instanceof PDFDict) {
      visitDict(obj, path);
    }
  };

  const trailer = doc.context.trailerInfo;
  visit(trailer.Info, 'Info');
  visit(trailer.Root, 'Root');
  for (const [ref] of doc.context.enumerateIndirectObjects()) {
    if (seen.has(ref.tag)) continue;
    const before = hits.length;
    visit(ref, 'unreachable');
    if (hits.length > before) {
      hits.splice(before, hits.length - before, `unreachable ${ref.tag}`);
    }
  }
  return hits.sort();
}
