/**
 * Minimal DER encoder and reader (ITU-T X.690) for the test PKI and the CMS
 * signatures of the signed fixtures. Only what lib/pki.ts needs: no BER, no
 * indefinite lengths, tag numbers below 31.
 */

export const TAG = {
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utf8String: 0x0c,
  printableString: 0x13,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31,
} as const;

function lengthBytes(length: number): number[] {
  if (length < 0x80) return [length];
  const out: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) out.unshift(n % 256);
  return [0x80 | out.length, ...out];
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const body = concat(content);
  return concat([Uint8Array.of(tag, ...lengthBytes(body.length)), body]);
}

export const seq = (...items: Uint8Array[]): Uint8Array => tlv(TAG.sequence, ...items);

/** SET OF with the DER ordering (elements sorted by their encodings). */
export function setOf(...items: Uint8Array[]): Uint8Array {
  return tlv(TAG.set, ...[...items].sort(compareBytes));
}

/** Context-specific constructed tag [n] (EXPLICIT wrapper, or IMPLICIT SEQUENCE/SET). */
export const ctx = (n: number, ...items: Uint8Array[]): Uint8Array => tlv(0xa0 | n, ...items);

/** Context-specific primitive tag [n] (IMPLICIT OCTET STRING and the like). */
export const ctxPrim = (n: number, bytes: Uint8Array): Uint8Array => tlv(0x80 | n, bytes);

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return a.length - b.length;
}

/** Non-negative INTEGER from a small number or big-endian magnitude bytes. */
export function int(value: number | Uint8Array): Uint8Array {
  let bytes: number[];
  if (typeof value === 'number') {
    bytes = [];
    for (let n = value; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
    if (!bytes.length) bytes = [0];
  } else {
    bytes = [...value];
    while (bytes.length > 1 && bytes[0] === 0 && ((bytes[1] ?? 0) & 0x80) === 0) bytes.shift();
  }
  if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0);
  return tlv(TAG.integer, Uint8Array.from(bytes));
}

export function oid(dotted: string): Uint8Array {
  const [a = 0, b = 0, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const arc of rest) {
    const chunk: number[] = [];
    for (let n = arc; ; n = Math.floor(n / 128)) {
      chunk.unshift((n % 128) | (chunk.length ? 0x80 : 0));
      if (n < 128) break;
    }
    out.push(...chunk);
  }
  return tlv(TAG.oid, Uint8Array.from(out));
}

export const nul = (): Uint8Array => tlv(TAG.null);
export const octets = (bytes: Uint8Array): Uint8Array => tlv(TAG.octetString, bytes);
export const bits = (bytes: Uint8Array, unused = 0): Uint8Array =>
  tlv(TAG.bitString, Uint8Array.of(unused), bytes);
export const utf8 = (text: string): Uint8Array =>
  tlv(TAG.utf8String, new Uint8Array(Buffer.from(text, 'utf8')));
export const printable = (text: string): Uint8Array =>
  tlv(TAG.printableString, new Uint8Array(Buffer.from(text, 'latin1')));
export const bool = (value: boolean): Uint8Array => tlv(0x01, Uint8Array.of(value ? 0xff : 0));

/** UTCTime (years 1950-2049) as YYMMDDHHMMSSZ. */
export function utcTime(date: Date): Uint8Array {
  const iso = date.toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(TAG.utcTime, new Uint8Array(Buffer.from(text, 'latin1')));
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export interface Tlv {
  tag: number;
  /** Offset of the tag byte in the buffer the node was read from. */
  start: number;
  /** Offset of the first content byte. */
  contentStart: number;
  end: number;
  /** Content bytes. */
  content: Uint8Array;
  /** The whole encoding (tag, length and content). */
  raw: Uint8Array;
}

export function readTlv(buf: Uint8Array, start = 0): Tlv {
  const tag = buf[start];
  let lenByte = buf[start + 1];
  if (tag === undefined || lenByte === undefined) throw new Error(`DER: truncated at ${start}`);
  if ((tag & 0x1f) === 0x1f) throw new Error('DER: high tag numbers are not supported');
  let contentStart = start + 2;
  let length = lenByte;
  if (lenByte & 0x80) {
    const count = lenByte & 0x7f;
    if (count === 0 || count > 4) throw new Error('DER: unsupported length form');
    length = 0;
    for (let i = 0; i < count; i++) {
      lenByte = buf[contentStart + i];
      if (lenByte === undefined) throw new Error('DER: truncated length');
      length = length * 256 + lenByte;
    }
    contentStart += count;
  }
  const end = contentStart + length;
  if (end > buf.length) throw new Error(`DER: element at ${start} overruns the buffer`);
  return {
    tag,
    start,
    contentStart,
    end,
    content: buf.subarray(contentStart, end),
    raw: buf.subarray(start, end),
  };
}

/** Children of a constructed element. */
export function children(node: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let offset = 0; offset < node.content.length; ) {
    const child = readTlv(node.content, offset);
    out.push(child);
    offset = child.end;
  }
  return out;
}

export function child(node: Tlv, index: number): Tlv {
  const found = children(node)[index];
  if (!found) throw new Error(`DER: element has no child ${index}`);
  return found;
}

export function readOid(node: Tlv): string {
  if (node.tag !== TAG.oid) throw new Error('DER: expected an OBJECT IDENTIFIER');
  const bytes = node.content;
  const first = bytes[0] ?? 0;
  const arcs = [
    Math.min(2, Math.floor(first / 40)),
    first - 40 * Math.min(2, Math.floor(first / 40)),
  ];
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    value = value * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      arcs.push(value);
      value = 0;
    }
  }
  return arcs.join('.');
}
