/**
 * qpdf 12.4.2 quirk: when a damaged file has no trailer at all (e.g. `truncated.pdf`),
 * the rewrite carries a trailer (or xref stream dictionary) without the required /Size
 * (ISO 32000-2 §7.5.5). Readers cope, but our own structure check (and strict readers)
 * flag it. These helpers detect that and patch a classic trailer in place: the trailer
 * follows the xref table, so inserting bytes into it moves no offset.
 */

const TAIL_BYTES = 64 * 1024;

function tailText(bytes: Uint8Array): { text: string; start: number } {
  const start = Math.max(0, bytes.length - TAIL_BYTES);
  return { text: new TextDecoder('latin1').decode(bytes.subarray(start)), start };
}

/** Where the final trailer information lives and whether it has /Size. */
export function trailerState(bytes: Uint8Array): 'ok' | 'classic-missing' | 'stream-missing' {
  const { text } = tailText(bytes);
  const end = text.lastIndexOf('startxref');
  const scope = end < 0 ? text : text.slice(0, end);
  const trailer = scope.lastIndexOf('trailer');
  if (trailer >= 0) {
    return /\/Size\s+\d+/.test(scope.slice(trailer)) ? 'ok' : 'classic-missing';
  }
  const xref = scope.lastIndexOf('/XRef');
  if (xref < 0) return 'ok';
  const open = scope.lastIndexOf('obj', xref);
  const close = scope.indexOf('stream', xref);
  const dict = scope.slice(open < 0 ? 0 : open, close < 0 ? scope.length : close);
  return /\/Size\s+\d+/.test(dict) ? 'ok' : 'stream-missing';
}

/**
 * Adds `/Size n` to the last classic trailer, n taken from the xref table's subsections
 * (highest object number + 1). Returns the input unchanged when there is nothing to do.
 */
export function patchClassicTrailerSize(bytes: Uint8Array): Uint8Array {
  if (trailerState(bytes) !== 'classic-missing') return bytes;
  const { text, start } = tailText(bytes);
  const trailer = text.lastIndexOf('trailer');
  const xref = text.lastIndexOf('xref', trailer);
  if (xref < 0) return bytes;
  let size = 0;
  for (const match of text.slice(xref, trailer).matchAll(/^(\d+)\s+(\d+)\s*$/gm)) {
    size = Math.max(size, Number(match[1]) + Number(match[2]));
  }
  const open = text.indexOf('<<', trailer);
  if (open < 0 || size === 0) return bytes;
  const at = start + open + 2;
  const insert = new TextEncoder().encode(` /Size ${size}`);
  const out = new Uint8Array(bytes.length + insert.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(insert, at);
  out.set(bytes.subarray(at), at + insert.length);
  return out;
}
