/**
 * Forensic checks on the raw bytes (research 06 §4 checks 1 and 6): the file must be a
 * single revision, and no redacted string may appear in its bytes or in any inflated
 * stream, in any of the encodings of `byte-grep.ts`.
 *
 * Streams are found lexically (`stream` EOL … `endstream`), so object streams, orphaned
 * objects of old revisions and damaged objects are searched too, whatever the parser
 * makes of them. Stream payloads are blanked before looking for trailers, `startxref` and
 * `%%EOF`, so binary data cannot fake or hide them.
 */

import { unzlibSync } from 'fflate';

import type { ForensicFinding } from '../types';
import { type ByteVariant, grepBytes } from './byte-grep';
import { undoPredictor } from './pdf-util';

export interface RawFile {
  readonly bytes: Uint8Array;
  /** One character per byte (Latin-1 style), for offsets and keyword searches. */
  readonly text: string;
  /** Stream payloads as `[start, end)` byte ranges. */
  readonly payloads: readonly (readonly [number, number])[];
  /** `text` with every payload blanked. */
  readonly skeleton: string;
}

/** Indexes a file for the raw checks. Never throws. */
export function readRawFile(bytes: Uint8Array): RawFile {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const payloads: [number, number][] = [];
  const re = /stream\r?\n/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (text.slice(m.index - 3, m.index) === 'end') continue;
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) break;
    payloads.push([start, end]);
    re.lastIndex = end + 9;
  }
  let skeleton = '';
  let from = 0;
  for (const [start, end] of payloads) {
    skeleton += text.slice(from, start) + ' '.repeat(end - start);
    from = end;
  }
  skeleton += text.slice(from);
  return { bytes, text, payloads, skeleton };
}

/** Object number of the `N G obj` header before `offset`, if any. */
export function objectNumberAt(file: RawFile, offset: number): number | undefined {
  const window = file.skeleton.slice(Math.max(0, offset - 8192), offset);
  let last: number | undefined;
  for (const m of window.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)) last = Number(m[1]);
  return last;
}

/**
 * Check 1: exactly one `startxref` and one `%%EOF`, and no /Prev in any trailer or
 * cross-reference stream dictionary.
 */
export function singleRevisionFindings(file: RawFile): ForensicFinding[] {
  const findings: ForensicFinding[] = [];
  const { skeleton } = file;
  const startxrefs = [...skeleton.matchAll(/startxref/g)].length;
  const eofs = [...skeleton.matchAll(/%%EOF/g)].length;
  if (startxrefs !== 1) {
    findings.push({
      where: 'file',
      channel: 'startxref',
      detail: `${startxrefs} startxref sections (expected 1)`,
    });
  }
  if (eofs !== 1) {
    findings.push({
      where: 'file',
      channel: '%%EOF',
      detail: `${eofs} %%EOF markers (expected 1)`,
    });
  }
  for (const m of skeleton.matchAll(/trailer\s*<</g)) {
    const end = skeleton.indexOf('startxref', m.index);
    const dict = skeleton.slice(m.index, end < 0 ? m.index + 4096 : end);
    if (/\/Prev\b/.test(dict)) {
      findings.push({
        where: `trailer at byte ${m.index}`,
        channel: 'trailer',
        detail: '/Prev present',
      });
    }
  }
  for (const m of skeleton.matchAll(/\/Type\s*\/XRef\b/g)) {
    const start = Math.max(skeleton.lastIndexOf('obj', m.index), 0);
    const end = skeleton.indexOf('stream', m.index);
    const dict = skeleton.slice(start, end < 0 ? m.index + 4096 : end);
    if (/\/Prev\b/.test(dict)) {
      const objectNumber = objectNumberAt(file, m.index);
      findings.push({
        where: `cross-reference stream${objectNumber === undefined ? '' : ` (object ${objectNumber})`}`,
        ...(objectNumber === undefined ? {} : { objectNumber }),
        channel: 'xref stream',
        detail: '/Prev present',
      });
    }
  }
  return findings;
}

/** A redacted string with its byte encodings. */
export interface GrepTarget {
  /** Index of the string in the plan (the string itself is not repeated in findings). */
  readonly stringIndex: number;
  readonly variants: readonly ByteVariant[];
}

/**
 * Predictor parameters written directly in the dictionary of the stream whose payload
 * starts at `start` (`/DecodeParms << /Predictor 12 /Columns 4 >>`), if any. Parameters
 * behind a reference or in an array are left to check 5, which reads the parsed dictionary.
 */
function payloadPredictor(file: RawFile, start: number) {
  const before = file.skeleton.slice(Math.max(0, start - 4096), start);
  const dict = before.slice(before.lastIndexOf('obj') + 1);
  const parms = /\/DecodeParms\s*<<([^>]*)>>/.exec(dict)?.[1];
  if (parms === undefined) return undefined;
  const num = (key: string, fallback: number) => {
    const m = new RegExp(`/${key}\\s+(\\d+)`).exec(parms);
    return m ? Number(m[1]) : fallback;
  };
  const predictor = num('Predictor', 1);
  if (predictor <= 1) return undefined;
  return {
    predictor,
    colors: num('Colors', 1),
    bitsPerComponent: num('BitsPerComponent', 8),
    columns: num('Columns', 1),
  };
}

/** Check 6: the raw bytes, then every inflated stream payload (predictors undone). */
export function byteGrepFindings(file: RawFile, targets: readonly GrepTarget[]): ForensicFinding[] {
  const findings: ForensicFinding[] = [];
  for (const target of targets) {
    for (const hit of grepBytes(file.bytes, target.variants)) {
      const objectNumber = objectNumberAt(file, hit.offset);
      findings.push({
        where: `raw bytes at ${hit.offset}${objectNumber === undefined ? '' : ` (object ${objectNumber})`}`,
        ...(objectNumber === undefined ? {} : { objectNumber }),
        channel: `raw ${hit.variant}`,
        detail: `redacted string ${target.stringIndex}`,
      });
    }
  }
  for (const [start, end] of file.payloads) {
    let data: Uint8Array;
    try {
      data = unzlibSync(file.bytes.subarray(start, end));
    } catch {
      continue; // not zlib data: already covered by the raw grep
    }
    const predictor = payloadPredictor(file, start);
    if (predictor) {
      // Search the rows as stored too: an undone predictor must not hide what was there.
      const undone = undoPredictor(data, predictor);
      if ('data' in undone) {
        const both = new Uint8Array(data.length + 1 + undone.data.length);
        both.set(data);
        both.set(undone.data, data.length + 1);
        data = both;
      }
    }
    for (const target of targets) {
      for (const hit of grepBytes(data, target.variants)) {
        const objectNumber = objectNumberAt(file, start);
        findings.push({
          where: `inflated stream at byte ${start}${objectNumber === undefined ? '' : ` (object ${objectNumber})`}`,
          ...(objectNumber === undefined ? {} : { objectNumber }),
          channel: `inflated ${hit.variant}`,
          detail: `redacted string ${target.stringIndex} at offset ${hit.offset}`,
        });
      }
    }
  }
  return findings;
}

/** "num gen" of every /Encrypt reference in a trailer or cross-reference stream dictionary. */
export function encryptRefs(file: RawFile): Set<string> {
  const keys = new Set<string>();
  for (const m of file.skeleton.matchAll(/\/Encrypt\s+(\d+)\s+(\d+)\s+R/g))
    keys.add(`${m[1]} ${m[2]}`);
  return keys;
}
