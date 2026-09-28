/**
 * The layer's own verification fails closed (spec §1.2–§1.3, M5 review finding 5), on a
 * hosted engine and small synthetic PDFs: whole-word matching ("in" is not found inside
 * "within"), a word found away from its planned box fails, invisible text the removal could
 * not reach fails, and a planned page without new words is still render-checked after its
 * content was regenerated.
 */
import { PDFDocument, PDFName, type PDFRef, StandardFonts } from '@cantoo/pdf-lib';
import type { Rect } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { wasmUrl } from '../../test/helpers';
import { createHostedEngine, type HostedEngine } from '../pdfium/host';
import { openScratch, type PageChar } from '../redaction/engine-session';
import type { OcrLayerPlan, OcrLayerWord } from '../types';
import { applyOcrLayerToBytes, OcrLayerFailedError } from './apply';
import { layerWordRect, locateWords, OCR_RECT_TOLERANCE, verifyOcrLayer } from './verify';

let host: HostedEngine;
beforeAll(async () => {
  host = await createHostedEngine({ wasm: wasmUrl });
});
afterAll(async () => {
  await host.engine.destroy?.().toPromise();
});

/** Characters of `text` laid out left to right, 6 pt each, spaces included. */
function charsOf(text: string): PageChar[] {
  return Array.from(text, (ch, i) => ({
    text: ch,
    rect: { x: 100 + i * 6, y: 700, width: 6, height: 10 },
  }));
}

const word = (text: string, x: number, y: number): OcrLayerWord => ({
  text,
  origin: { x, y },
  width: text.length * 6,
  fontSize: 10,
  angle: 0,
  confidence: 95,
});

function plan(
  words: readonly OcrLayerWord[][],
  replace: OcrLayerPlan['replace'] = 'none',
): OcrLayerPlan {
  return {
    replace,
    pages: words.map((w, pageIndex) => ({ pageIndex, languages: ['eng'], words: w })),
  };
}

/**
 * A one-page PDF whose content is `content`, with Helvetica as `/F1` and the given Form
 * XObjects (name → content, each able to draw the others) in its resources.
 */
async function pdfWith(content: string, forms: Record<string, string> = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const context = doc.context;
  const refs: Record<string, PDFRef> = {};
  for (const name of Object.keys(forms)) refs[name] = context.nextRef();
  const xobjects = context.obj(refs);
  for (const [name, body] of Object.entries(forms)) {
    const form = context.stream(body, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 612, 792],
      Resources: { Font: { F1: font.ref }, XObject: xobjects },
    });
    context.assign(refs[name]!, form);
  }
  page.node.set(
    PDFName.of('Resources'),
    context.obj({ Font: { F1: font.ref }, XObject: xobjects }),
  );
  page.node.set(PDFName.of('Contents'), context.register(context.stream(content)));
  return doc.save({ useObjectStreams: false });
}

const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

describe('locateWords', () => {
  test('matches whole words only: "in" is not found inside "within"', () => {
    expect(locateWords(charsOf('within'), ['in'])).toEqual([undefined]);
    const [inRect] = locateWords(charsOf('within in'), ['in']);
    // The standalone word: characters 7 and 8.
    expect(inRect).toEqual({ x: 142, y: 700, width: 12, height: 10 });
    // In order, each occurrence once, and punctuation is not a word character.
    const found = locateWords(charsOf('in within, in.'), ['in', 'within,', 'in']);
    expect(found.map((r) => r?.x)).toEqual([100, 118, 166]);
    // A word that starts or ends with punctuation matches where the text continues.
    expect(locateWords(charsOf('(within)x'), ['(within'])[0]?.x).toBe(100);
    expect(locateWords(charsOf('şişe şiş'), ['şiş'])[0]?.x).toBe(130);
    // PDFium's generated line break (no text, no box) in place of a line's trailing space
    // separates the last word of a line from the first of the next.
    const glued = [...charsOf('within'), { text: '' }, { text: '' }, ...charsOf('in')];
    expect(locateWords(glued, ['within', 'in']).map((r) => r?.width)).toEqual([36, 12]);
  });
});

describe('verifyOcrLayer', () => {
  test('a word found more than 2 pt from its planned box fails the check', async () => {
    const input = await pdfWith('');
    const written = plan([[word('Alpha', 72, 700), word('within', 120, 700), word('in', 72, 680)]]);
    const result = await applyOcrLayerToBytes(host, buffer(input), written);
    expect(result.verification.ok).toBe(true);
    expect(result.verification.pages[0]).toMatchObject({ words: 3, found: 3, within2pt: 3 });

    // The same bytes checked against a plan that puts "in" 5 pt higher than it was written.
    const misplaced = plan([
      [word('Alpha', 72, 700), word('within', 120, 700), word('in', 72, 685)],
    ]);
    const before = await openScratch(host, input);
    const after = await openScratch(host, new Uint8Array(result.bytes));
    try {
      const check = await verifyOcrLayer(before, after, misplaced);
      expect(check.pages[0]).toMatchObject({ words: 3, found: 3, within2pt: 2 });
      expect(check.pages[0]!.worstDeviation).toBeGreaterThan(OCR_RECT_TOLERANCE);
      expect(check.ok).toBe(false);
      expect(check.problems.join()).toMatch(/1 word\(s\) more than 2 pt/);
      // Whole words: "in" is the planned word at (72, 680), not the end of "within".
      const chars = await after.chars(0);
      const [, , inRect] = locateWords(chars, ['Alpha', 'within', 'in']);
      const planned: Rect = layerWordRect(word('in', 72, 680));
      expect(Math.abs(inRect!.x - planned.x)).toBeLessThan(OCR_RECT_TOLERANCE);
      expect(Math.abs(inRect!.y - planned.y)).toBeLessThan(OCR_RECT_TOLERANCE);
    } finally {
      await after.close();
      await before.close();
    }
  });

  test('invisible text the removal cannot reach fails an all-invisible run', async () => {
    // Another tool's invisible word inside Form XObjects nested twelve deep: deeper than the
    // removal descends (8 levels, as the redaction pass), still read by PDFium's text page.
    const forms: Record<string, string> = {};
    for (let n = 0; n < 12; n++) forms[`Fm${n}`] = `q /Fm${n + 1} Do Q\n`;
    forms.Fm12 = 'BT 3 Tr /F1 12 Tf 300 300 Td (Hidden) Tj ET\n';
    const input = await pdfWith('q /Fm0 Do Q\n', forms);
    const scratch = await openScratch(host, input);
    try {
      expect((await scratch.chars(0)).map((c) => c.text).join('')).toContain('Hidden');
    } finally {
      await scratch.close();
    }
    const error = await applyOcrLayerToBytes(
      host,
      buffer(input),
      plan([[word('Visible', 72, 700)]], 'all-invisible'),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OcrLayerFailedError);
    const { verification } = error as OcrLayerFailedError;
    expect(verification.ok).toBe(false);
    expect(verification.problems[0]).toBe('Page 1: 6 invisible character(s) could not be removed');
    // Everything else about the page passed: the leftover alone fails the run.
    expect(verification.pages[0]).toMatchObject({ words: 1, found: 1, within2pt: 1 });
    expect(verification.pages[0]!.pixelsDiffering).toBe(0);
  });

  test('a planned page without new words is still render-checked', async () => {
    // Page content clipped by invisible text (mode 7 adds the glyphs to the clip): removing
    // it regenerates the page and the blue fill then covers the whole page.
    const input = await pdfWith(
      'q BT 7 Tr /F1 96 Tf 72 600 Td (Clip) Tj ET 0 0 1 rg 0 0 612 792 re f Q\n',
    );
    const error = await applyOcrLayerToBytes(
      host,
      buffer(input),
      plan([[]], 'all-invisible'),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OcrLayerFailedError);
    const { verification } = error as OcrLayerFailedError;
    expect(verification.ok).toBe(false);
    expect(verification.pages).toHaveLength(1);
    expect(verification.pages[0]).toMatchObject({ pageIndex: 0, words: 0, found: 0 });
    expect(verification.pages[0]!.pixelsDiffering).toBeGreaterThan(0);
    expect(verification.problems.join()).toMatch(/Page 1: the render changed/);
  });
});
