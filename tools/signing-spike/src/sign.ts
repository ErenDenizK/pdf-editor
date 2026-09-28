/**
 * PAdES-B signing pipeline on Cantoo's incremental writer: placeholder → commit → patch
 * /ByteRange inside the appended section only → SHA-256 over the ranges → CMS → hex into the
 * reserved /Contents (fail if it does not fit).
 */
import type * as pkijs from 'pkijs';

import { ascii, concat, latin1, toHex } from './bytes';
import { buildCadesDetached, type CmsOptions, sha256 } from './cms';
import { addSignaturePlaceholder, loadIncremental } from './pdf-edits';
import { lastStartxref, parseSection, type XrefKind } from './xref';

export interface Placeholder {
  /** Offset of '[' and of the byte after ']' of the placeholder /ByteRange array. */
  readonly rangeStart: number;
  readonly rangeEnd: number;
  /** Offset of '<' and of the byte after '>' of /Contents. */
  readonly contentsStart: number;
  readonly contentsEnd: number;
}

export async function sourceXrefKind(bytes: Uint8Array): Promise<XrefKind | 'broken'> {
  const at = lastStartxref(bytes);
  if (at === undefined) return 'broken';
  try {
    return (await parseSection(bytes, at)).kind;
  } catch {
    return 'broken';
  }
}

/** Looks only after `from` (the end of the signed-over source): the appended section. */
export function findPlaceholder(bytes: Uint8Array, from: number): Placeholder {
  const text = latin1(bytes, from);
  const range = /\/ByteRange\s*(\[\s*0\s+9999999999\s+9999999999\s+9999999999\s*\])/.exec(text);
  if (!range) throw new Error('no /ByteRange placeholder in the appended section');
  const rangeStart = from + range.index + range[0].length - (range[1]?.length ?? 0);
  const contents = /\/Contents\s*<(0{64,})>/.exec(text);
  if (!contents) throw new Error('no /Contents placeholder in the appended section');
  const contentsStart = from + contents.index + contents[0].indexOf('<');
  return {
    rangeStart,
    rangeEnd: rangeStart + (range[1]?.length ?? 0),
    contentsStart,
    contentsEnd: contentsStart + (contents[1]?.length ?? 0) + 2,
  };
}

export function patchByteRange(
  bytes: Uint8Array,
  p: Placeholder,
): [number, number, number, number] {
  const range: [number, number, number, number] = [
    0,
    p.contentsStart,
    p.contentsEnd,
    bytes.length - p.contentsEnd,
  ];
  const width = p.rangeEnd - p.rangeStart;
  const text = `[${range.join(' ')}`.padEnd(width - 1, ' ') + ']';
  if (text.length !== width) throw new Error('byte range does not fit its placeholder');
  bytes.set(ascii(text), p.rangeStart);
  return range;
}

export function signedBytes(bytes: Uint8Array, range: readonly number[]): Uint8Array<ArrayBuffer> {
  const [a = 0, b = 0, c = 0, d = 0] = range;
  return concat([bytes.subarray(a, a + b), bytes.subarray(c, c + d)]);
}

export function embedContents(bytes: Uint8Array, p: Placeholder, cms: Uint8Array): void {
  const room = (p.contentsEnd - p.contentsStart - 2) / 2;
  if (cms.length > room) throw new Error(`CMS is ${cms.length} bytes; only ${room} reserved`);
  bytes.set(ascii(toHex(cms).toUpperCase()), p.contentsStart + 1);
}

export interface SignOptions extends CmsOptions {
  readonly name?: string;
  readonly reserveBytes?: number;
  readonly date?: Date;
  readonly reason?: string;
}

export interface SignResult {
  readonly bytes: Uint8Array;
  readonly byteRange: [number, number, number, number];
  readonly xrefKind: XrefKind | 'broken';
  readonly cmsBytes: number;
  /** Bytes appended to the source, and the same without the reserved /Contents hex. */
  readonly appended: number;
  readonly appendedWithoutContents: number;
  readonly ms: { load: number; commit: number; digest: number; cms: number; total: number };
}

export interface Identity {
  readonly key: CryptoKey;
  readonly chain: readonly pkijs.Certificate[];
}

/**
 * After `commit`: patch /ByteRange and embed the CMS in the section appended after `from`.
 * Mutates `out`; returns the byte range, the CMS size and the digest/CMS times.
 */
export async function finishSignature(
  out: Uint8Array,
  from: number,
  identity: Identity,
  o: CmsOptions = {},
): Promise<{
  byteRange: [number, number, number, number];
  cmsBytes: number;
  digestMs: number;
  cmsMs: number;
}> {
  const t0 = performance.now();
  const p = findPlaceholder(out, from);
  const byteRange = patchByteRange(out, p);
  const digest = await sha256(signedBytes(out, byteRange));
  const t1 = performance.now();
  const cms = await buildCadesDetached(digest, identity.key, identity.chain, o);
  embedContents(out, p, cms);
  return { byteRange, cmsBytes: cms.length, digestMs: t1 - t0, cmsMs: performance.now() - t1 };
}

export async function signPdf(
  source: Uint8Array,
  identity: Identity,
  o: SignOptions = {},
): Promise<SignResult> {
  const reserveBytes = o.reserveBytes ?? 16_384;
  const t0 = performance.now();
  const xrefKind = await sourceXrefKind(source);
  const doc = await loadIncremental(source);
  const t1 = performance.now();
  addSignaturePlaceholder(doc, {
    name: o.name ?? 'Signature1',
    reserveBytes,
    date: o.date ?? new Date(),
    ...(o.reason === undefined ? {} : { reason: o.reason }),
  });
  // Match the source: a classic table after a table, an xref stream after a stream. The
  // stream writer keeps /Type /Sig dictionaries out of object streams.
  const out = await doc.commit({ useObjectStreams: xrefKind === 'stream' });
  const t2 = performance.now();
  const done = await finishSignature(out, source.length, identity, o);
  const t3 = performance.now();
  return {
    bytes: out,
    byteRange: done.byteRange,
    xrefKind,
    cmsBytes: done.cmsBytes,
    appended: out.length - source.length,
    appendedWithoutContents: out.length - source.length - reserveBytes * 2,
    ms: { load: t1 - t0, commit: t2 - t1, digest: done.digestMs, cms: done.cmsMs, total: t3 - t0 },
  };
}
