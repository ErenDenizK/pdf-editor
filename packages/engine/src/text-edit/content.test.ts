/**
 * Content-stream interpretation (spec craft §4.3): `TJ` adjustment numbers are kept per
 * string, and spread per code for a writer that reapplies kerning pairs.
 */
import { PDFDocument } from '@cantoo/pdf-lib';
import { describe, expect, test } from 'vitest';

import { interpret, kerningPerCode, type TextOp } from './content';

async function opsOf(content: string): Promise<TextOp[]> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = ctx.register(
    ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }),
  );
  const resources = ctx.obj({ Font: { F1: font } });
  return interpret(doc, new TextEncoder().encode(content), resources).texts;
}

const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);

describe('TJ adjustments', () => {
  test('numbers are kept after the string they follow, summed between strings', async () => {
    const [op, ...rest] = await opsOf(
      'BT /F1 12 Tf 20 100 Td [-15 (The quick br) 30 (own f) -40 () 5 (ox jum) 25 (ps over.) 7] TJ ET',
    );
    expect(rest).toEqual([]);
    expect(op?.strings.map(latin1)).toEqual(['The quick br', 'own f', 'ox jum', 'ps over.']);
    // -40 and 5 both sit between "own f" and "ox jum" (the empty string draws nothing).
    expect(op?.adjustments).toEqual([30, -35, 25, 7]);
    expect(op?.leadingAdjustment).toBe(-15);
  });

  test('Tj, quote operators and TJ without numbers have zero adjustments', async () => {
    const ops = await opsOf(
      'BT /F1 12 Tf 20 100 Td (one) Tj (two) \' 1 2 (three) " [(four) (five)] TJ ET',
    );
    expect(ops.map((o) => o.strings.map(latin1))).toEqual([
      ['one'],
      ['two'],
      ['three'],
      ['four', 'five'],
    ]);
    expect(ops.map((o) => o.adjustments)).toEqual([[0], [0], [0], [0, 0]]);
    expect(ops.every((o) => o.leadingAdjustment === 0)).toBe(true);
  });

  test('a TJ of numbers only creates no text object', async () => {
    expect(await opsOf('BT /F1 12 Tf [100 -200] TJ [()] TJ ET')).toEqual([]);
  });

  test('kerningPerCode puts each adjustment on the last code of its string', async () => {
    const [op] = await opsOf('BT /F1 12 Tf [(AV) -80 (A) 120 (To)] TJ ET');
    if (!op) throw new Error('no text op');
    // One-byte font: one code per byte.
    const kerning = kerningPerCode(
      op,
      op.strings.map((s) => s.length),
    );
    expect(kerning).toEqual([0, -80, 120, 0, 0]);
    // The pair "V"→"A" (codes 1 and 2) carries -80, "A"→"T" carries 120.
    expect(kerningPerCode(op, [2, 1])).toBeUndefined();
    expect(kerningPerCode(op, [2, 0, 2])).toBeUndefined();
    // Another splitter: one code per string.
    expect(kerningPerCode(op, [1, 1, 1])).toEqual([-80, 120, 0]);
  });
});
