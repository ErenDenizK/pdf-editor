/**
 * Unit tests of the content-stream text lexer (review finding M1), the predictor decoding
 * of the stream walk and the byte grep (review finding m2), and `contentStreams`.
 */

import { PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import { zlibSync } from 'fflate';
import { describe, expect, test } from 'vitest';

import { contentStreams, normalizedShownText, shownText } from './content-text';
import { decodeStreamOutcome, undoPredictor } from './pdf-util';

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const shown = (s: string) => shownText(bytes(s)).latin1;

describe('shownText', () => {
  test('joins the elements of a kerned TJ array, ignoring the adjustments', () => {
    expect(shown('BT /F1 14 Tf 5 8 Td [(SECRET-)-10(7731)] TJ ET')).toBe('SECRET-7731');
    expect(shown('BT [(SE) 120 (CR) -3.5 (ET)] TJ ET')).toBe('SECRET');
  });

  test('decodes literal-string escapes: octal, named, balanced and escaped parentheses', () => {
    expect(shown('(\\123ECRET-7731) Tj')).toBe('SECRET-7731');
    expect(shown('(\\1231\\62) Tj')).toBe('S12');
    expect(shown('(a\\(b\\)c (d) e\\\\) Tj')).toBe('a(b)c (d) e\\');
    expect(shown('(a\\nb\\tc) Tj')).toBe('a\nb\tc');
    expect(shown('(SEC\\\nRET) Tj')).toBe('SECRET'); // line continuation
    expect(shown('(SEC\\\r\nRET) Tj')).toBe('SECRET');
  });

  test('reads hex strings with whitespace between the digits (and an odd final digit)', () => {
    expect(shown('<53 45 43 52 45 54 2D 37 37 33 31> Tj')).toBe('SECRET-7731');
    expect(shown('<5345\n4352\t4554> Tj')).toBe('SECRET');
    expect(shown('<414> Tj')).toBe('A@');
  });

  test('joins consecutive showing operators, \' and " included, across positioning', () => {
    expect(shown('BT (SEC) Tj 0 0 Td (RET) Tj ET')).toBe('SECRET');
    expect(shown("BT (SEC) Tj (RET) ' ET")).toBe('SECRET');
    expect(shown('BT (SEC) Tj 1 2 (RET) " ET')).toBe('SECRET');
    // Glyph-by-glyph layout: every character positioned on its own.
    expect(shown('BT (S) Tj 7 0 Td (E) Tj 7 0 Td (C) Tj ET')).toBe('SEC');
  });

  test('ignores operands of other operators, comments, names, dictionaries and inline images', () => {
    expect(shown('(NOTSHOWN) BDC /Tx <</MCID 0 /Alt (ALT)>> BDC (A) Tj EMC')).toBe('A');
    expect(shown('% (SECRET) Tj\n(A) Tj')).toBe('A');
    expect(shown('/SECRET Do (B) Tj')).toBe('B');
    expect(shown('BI /W 4 /H 1 /BPC 8 /CS /G ID (SECRET) Tj EI (C) Tj')).toBe('C');
  });

  test('reads even-length strings as UTF-16BE too', () => {
    const text = shownText(bytes('<FEFF0053004500430052004500540020> Tj'));
    expect(text.utf16).toBe('SECRET ');
    expect(normalizedShownText(bytes('[<00530045> -20 <0043>] TJ'))).toContain('sec');
  });

  test('never throws on malformed input', () => {
    for (const junk of [
      '(unterminated',
      '<4142',
      '] ] [[[ Tj',
      ')))',
      'BI ID',
      '\\',
      '[(A) Tj] TJ',
    ]) {
      expect(() => shownText(bytes(junk))).not.toThrow();
    }
  });
});

/** PNG-predicts `data` in rows of `rowBytes` with filter `type` (bytes per pixel `bpp`). */
function pngEncode(data: Uint8Array, rowBytes: number, bpp: number, type: number): Uint8Array {
  const rows = Math.ceil(data.length / rowBytes);
  const out: number[] = [];
  for (let r = 0; r < rows; r++) {
    out.push(type);
    for (let j = 0; j < rowBytes && r * rowBytes + j < data.length; j++) {
      const x = data[r * rowBytes + j] ?? 0;
      const a = j >= bpp ? (data[r * rowBytes + j - bpp] ?? 0) : 0;
      const b = r > 0 ? (data[(r - 1) * rowBytes + j] ?? 0) : 0;
      const c = r > 0 && j >= bpp ? (data[(r - 1) * rowBytes + j - bpp] ?? 0) : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][type] ?? 0;
      out.push((x - predicted) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

describe('undoPredictor', () => {
  const payload = bytes('notes: SECRET-7731 (keep private) and some more text.');

  test.each([0, 1, 2, 3, 4])('PNG row filter %i', (type) => {
    const encoded = pngEncode(payload, 6, 3, type);
    const undone = undoPredictor(encoded, {
      predictor: 10 + type,
      colors: 3,
      bitsPerComponent: 8,
      columns: 2,
    });
    expect('data' in undone && Array.from(undone.data)).toEqual(Array.from(payload));
  });

  test('TIFF predictor 2, 8 bits per component', () => {
    const encoded = payload.slice();
    for (let at = 0; at < encoded.length; at += 8) {
      for (let j = Math.min(at + 8, encoded.length) - 1; j >= at + 2; j--) {
        encoded[j] = ((payload[j] ?? 0) - (payload[j - 2] ?? 0)) & 0xff;
      }
    }
    const undone = undoPredictor(encoded, {
      predictor: 2,
      colors: 2,
      bitsPerComponent: 8,
      columns: 4,
    });
    expect('data' in undone && Array.from(undone.data)).toEqual(Array.from(payload));
  });

  test('unsupported parameters give a reason', () => {
    const params = { predictor: 12, colors: 0, bitsPerComponent: 8, columns: 4 };
    const reasonOf = (outcome: { data: Uint8Array } | { reason: string }) =>
      'reason' in outcome ? outcome.reason : '';
    expect(reasonOf(undoPredictor(payload, params))).toContain('Colors 0');
    expect(undoPredictor(payload, { ...params, colors: 1, predictor: 7 })).toMatchObject({
      reason: 'predictor 7 is not defined',
    });
    expect(reasonOf(undoPredictor(bytes('\u0009abcd'), { ...params, colors: 1 }))).toContain(
      'row filter 9',
    );
  });
});

describe('decodeStreamOutcome', () => {
  test('undoes a Flate PNG predictor (P16) and names what it cannot decode', async () => {
    const doc = await PDFDocument.create();
    const { context } = doc;
    const cols = 4;
    const text = bytes('notes: SECRET-7731 (keep private)'.padEnd(36, ' '));
    const rows: number[] = [];
    for (let i = 0; i < text.length; i += cols) rows.push(0, ...text.slice(i, i + cols));
    const predicted = PDFRawStream.of(
      context.obj({ Filter: 'FlateDecode', DecodeParms: { Predictor: 12, Columns: cols } }),
      zlibSync(Uint8Array.from(rows)),
    );
    const outcome = decodeStreamOutcome(context, predicted);
    expect('data' in outcome && String.fromCharCode(...outcome.data)).toBe(
      String.fromCharCode(...text),
    );
    const arrayParms = PDFRawStream.of(
      context.obj({
        Filter: ['ASCIIHexDecode', 'FlateDecode'],
        DecodeParms: [null, { Predictor: 12, Columns: cols }],
      }),
      bytes(
        `${Array.from(zlibSync(Uint8Array.from(rows)), (b) => b.toString(16).padStart(2, '0')).join('')}>`,
      ),
    );
    const second = decodeStreamOutcome(context, arrayParms);
    expect('data' in second && String.fromCharCode(...second.data)).toContain('SECRET-7731');

    const dct = PDFRawStream.of(context.obj({ Filter: 'DCTDecode' }), bytes('not a jpeg'));
    expect(decodeStreamOutcome(context, dct)).toEqual({ reason: 'DCTDecode not decodable here' });
    const bad = PDFRawStream.of(
      context.obj({ Filter: 'FlateDecode', DecodeParms: { Predictor: 12, Colors: 99 } }),
      zlibSync(Uint8Array.from(rows)),
    );
    const badOutcome = decodeStreamOutcome(context, bad);
    expect('reason' in badOutcome && badOutcome.reason).toContain(
      'FlateDecode: predictor 12 with Colors 99',
    );
  });
});

describe('contentStreams', () => {
  test('finds page contents, forms, appearances, tiling patterns and Type3 glyph procedures', async () => {
    const doc = await PDFDocument.create();
    const { context } = doc;
    const page = doc.addPage([200, 200]);
    const contents = context.register(context.stream('(A) Tj'));
    const form = context.register(
      context.stream('(B) Tj', { Subtype: 'Form', BBox: [0, 0, 1, 1] }),
    );
    const bareAp = context.register(context.stream('(C) Tj', { BBox: [0, 0, 1, 1] }));
    const pattern = context.register(
      context.stream('(D) Tj', { PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 1, 1] }),
    );
    const proc = context.register(context.stream('(E) Tj'));
    const image = context.register(
      context.stream('xx', { Subtype: 'Image', BBox: [0, 0, 1, 1], Width: 1, Height: 1 }),
    );
    const font = context.register(
      context.obj({ Type: 'Font', Subtype: 'Type3', CharProcs: { a: proc } }),
    );
    const annot = context.register(
      context.obj({
        Type: 'Annot',
        Subtype: 'Stamp',
        Rect: [0, 0, 1, 1],
        AP: { N: { On: bareAp } },
      }),
    );
    page.node.set(PDFName.of('Contents'), contents);
    page.node.set(
      PDFName.of('Resources'),
      context.obj({
        XObject: { Fm: form, Im: image },
        Pattern: { P: pattern },
        Font: { T3: font },
      }),
    );
    page.node.set(PDFName.of('Annots'), context.obj([annot]));
    const found = contentStreams(doc);
    const kind = (ref: typeof contents) => found.get(context.lookup(ref) as never);
    expect(kind(contents)).toBe('page content');
    expect(kind(form)).toBe('form XObject');
    expect(kind(pattern)).toBe('tiling pattern');
    expect(kind(proc)).toBe('Type3 glyph procedure');
    expect(kind(bareAp)).toBeDefined();
    expect(kind(image)).toBeUndefined();
  });
});
