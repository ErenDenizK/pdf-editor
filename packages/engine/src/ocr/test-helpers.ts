/**
 * Shared by the OCR tests: the scan fixtures and their ground truth (test/fixtures
 * manifest.json `expect.ocr`), a PDFium worker proxy, one recognizer, and the spike's word
 * accuracy (research 07 §3: LCS of edge-punctuation-trimmed words over the truth words).
 */
import type { Rect, SourceId } from '@pdf-editor/document-model';

import manifest from '../../../../test/fixtures/manifest.json';
import scanForeignUrl from '../../../../test/fixtures/scan-foreign-ocr.pdf?url';
import scanRotatedUrl from '../../../../test/fixtures/scan-rotated.pdf?url';
import scanTextUrl from '../../../../test/fixtures/scan-text.pdf?url';
import scanTurkishUrl from '../../../../test/fixtures/scan-turkish.pdf?url';
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { PdfLibAssembler } from '../pdflib/pdflib-assembler';
import type { OcrWord } from '../types';
import { createPdfiumProxy, type PdfiumProxy } from '../worker/pdfium-proxy';

export const SCANS = {
  'scan-text.pdf': scanTextUrl,
  'scan-turkish.pdf': scanTurkishUrl,
  'scan-rotated.pdf': scanRotatedUrl,
  'scan-foreign-ocr.pdf': scanForeignUrl,
} as const;
export type ScanName = keyof typeof SCANS;

export interface TruthWord {
  readonly text: string;
  /** Ink box, user space: x, y, width, height. */
  readonly box: readonly [number, number, number, number];
}

export interface TruthPage {
  readonly page: number;
  readonly rotate: number;
  readonly skewDegrees: number;
  readonly text: string;
  readonly words: readonly TruthWord[];
}

interface ManifestEntry {
  readonly file: string;
  readonly expect: { readonly ocr?: { readonly languages: string[]; readonly pages: TruthPage[] } };
}

export function truth(file: ScanName): { languages: string[]; pages: TruthPage[] } {
  const entry = (manifest.fixtures as unknown as ManifestEntry[]).find((f) => f.file === file);
  const ocr = entry?.expect.ocr;
  if (!ocr) throw new Error(`${file}: no expect.ocr in manifest.json`);
  return ocr;
}

export async function fixtureBytes(file: ScanName): Promise<ArrayBuffer> {
  return (await fetch(SCANS[file])).arrayBuffer();
}

export const sid = (s: string) => s as SourceId;

export function createProxy(name: string): PdfiumProxy {
  const worker = new Worker(new URL('../worker/pdfium.worker.ts', import.meta.url), {
    type: 'module',
    name,
  });
  return createPdfiumProxy(worker, { wasmUrl, inspector: new PdfLibAssembler() });
}

const EDGE_PUNCTUATION = /^[\s.,;:!?"'()“”‘’«»\-–—]+|[\s.,;:!?"'()“”‘’«»\-–—]+$/gu;

export function normalizeWord(word: string): string {
  return word.normalize('NFC').replace(EDGE_PUNCTUATION, '');
}

/** A longest common subsequence of `truth` and `ocr`: OCR index → truth index. */
export function lcsMatches(
  truthWords: readonly string[],
  ocr: readonly string[],
): Map<number, number> {
  const n = truthWords.length;
  const m = ocr.length;
  const table = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] =
        truthWords[i] === ocr[j]
          ? (table[(i + 1) * (m + 1) + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * (m + 1) + j] ?? 0, table[i * (m + 1) + j + 1] ?? 0);
    }
  }
  const matched = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (truthWords[i] === ocr[j]) {
      matched.set(j, i);
      i++;
      j++;
    } else if ((table[(i + 1) * (m + 1) + j] ?? 0) >= (table[i * (m + 1) + j + 1] ?? 0)) i++;
    else j++;
  }
  return matched;
}

export interface Accuracy {
  /** Truth words found in order, 0–1. */
  readonly accuracy: number;
  readonly truthWords: number;
  /** Matched pairs: OCR word index → truth word index. */
  readonly matches: Map<number, number>;
}

export function wordAccuracy(page: TruthPage, words: readonly OcrWord[]): Accuracy {
  const t = page.words.map((w) => normalizeWord(w.text));
  const o = words.map((w) => normalizeWord(w.text));
  const matches = lcsMatches(t, o);
  return { accuracy: t.length === 0 ? 0 : matches.size / t.length, truthWords: t.length, matches };
}

export function boxRect(box: TruthWord['box']): Rect {
  return { x: box[0], y: box[1], width: box[2], height: box[3] };
}

/** Largest difference between the edges of two rects. */
export function edgeDistance(a: Rect, b: Rect): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - (b.x + b.width)),
    Math.abs(a.y + a.height - (b.y + b.height)),
  );
}

/** How far `inner` sticks out of `outer` (0 when it lies inside). */
export function overhang(inner: Rect, outer: Rect): number {
  return Math.max(
    0,
    outer.x - inner.x,
    outer.y - inner.y,
    inner.x + inner.width - (outer.x + outer.width),
    inner.y + inner.height - (outer.y + outer.height),
  );
}

export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? Number.NaN;
}

export const OCR_BASE = '/ocr/';
