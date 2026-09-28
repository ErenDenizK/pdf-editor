/**
 * Byte helpers for the signature code (DOM-free: pages, workers and Node alike). Lifted from
 * spike S2 (`tools/signing-spike/src/bytes.ts`).
 */

const decoder = new TextDecoder('latin1');

/** One UTF-16 code unit per byte, so string indices equal byte offsets. */
export function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  return decoder.decode(bytes.subarray(start, end));
}

export function ascii(text: string): Uint8Array<ArrayBuffer> {
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

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Hex digits only (whitespace is skipped, as in a PDF hex string); odd length pads a 0. */
export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  let clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 === 1) clean += '0';
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A standalone ArrayBuffer copy (WebCrypto and pkijs want exact buffers). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The bytes a /ByteRange `[a b c d]` covers: `[a, a+b)` then `[c, c+d)`. */
export function signedBytes(bytes: Uint8Array, range: readonly number[]): Uint8Array<ArrayBuffer> {
  const [a = 0, b = 0, c = 0, d = 0] = range;
  return concat([bytes.subarray(a, a + b), bytes.subarray(c, c + d)]);
}

/** Total length of a DER TLV at the start of `der`, or undefined when it cannot be read. */
export function derLength(der: Uint8Array): number | undefined {
  if (der.length < 2) return undefined;
  const first = der[1] ?? 0;
  if (first < 0x80) return 2 + first;
  const n = first & 0x7f;
  if (n === 0 || n > 4) return undefined;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + (der[2 + i] ?? 0);
  return 2 + n + len;
}
