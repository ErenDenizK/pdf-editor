/** Byte helpers shared by the spike modules (platform-neutral: runs in Node, pages and workers). */

const decoder = new TextDecoder('latin1');

/** One UTF-16 code unit per byte, so string indices equal byte offsets. */
export function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  return decoder.decode(bytes.subarray(start, end));
}

export function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function isPrefix(prefix: Uint8Array, bytes: Uint8Array): boolean {
  if (prefix.length > bytes.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== bytes[i]) return false;
  return true;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && isPrefix(a, b);
}

/** A standalone ArrayBuffer copy (WebCrypto and pkijs want exact buffers). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Candidate revision ends: just past each `%%EOF`, and past its end-of-line when there is one
 * (a signer may cover the EOL or not; Cantoo writes none, the next increment starts with one).
 */
export function revisionEnds(bytes: Uint8Array): number[] {
  const text = latin1(bytes);
  const ends: number[] = [];
  let at = text.indexOf('%%EOF');
  while (at >= 0) {
    let end = at + 5;
    ends.push(end);
    if (text[end] === '\r') end++;
    if (text[end] === '\n') end++;
    if (end !== at + 5) ends.push(end);
    at = text.indexOf('%%EOF', at + 5);
  }
  return ends;
}
