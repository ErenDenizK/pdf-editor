/**
 * Fidelity of the split (engine review M2, M3, M4, m3, m4; probes TE1–TE5, TE9): kept glyphs
 * keep their original codes, the original object keeps its colour space, spacing and clip,
 * the replacement is spaced like the original, a form drawn more than once is not edited,
 * and a clipped line is never un-clipped.
 */
import { PDFDocument, PDFName, type PDFRef } from '@cantoo/pdf-lib';
import type { Rect, SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import encryptedUrl from '../../../../test/fixtures/encrypted-aes-128.pdf?url';
import { sid, toBuffer } from '../../test/helpers';
import type { LocatedRun } from '../types';
import { textEditFailureReason } from './errors';
import {
  createHarness,
  fixture,
  type Harness,
  inflatedContent,
  pageText,
  rejection,
  runWith,
  span,
} from './test-helpers';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.adapter.destroy();
});

/** Code 0x80 draws /B, but /ToUnicode says it is an "A" (an alternate glyph of "A"). */
const ALTERNATE_A = cmap('1 beginbfchar <80> <0041> endbfchar');
/** Code 0x81 is a ligature that reads "fi". */
const LIGATURE_FI = cmap('1 beginbfchar <81> <00660069> endbfchar');

function cmap(body: string): string {
  return [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CMapName /Adobe-Identity-UCS def /CMapType 2 def',
    '1 begincodespacerange <00> <FF> endcodespacerange',
    body,
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');
}

/** Pages of raw content over F1 = Helvetica (WinAnsi, optional /Differences and /ToUnicode). */
async function pdf(options: {
  pages: string[];
  differences?: (number | string)[];
  toUnicode?: string;
  forms?: Record<string, string>;
  bbox?: [number, number, number, number];
}): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font: Record<string, unknown> = {
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: options.differences
      ? {
          Type: 'Encoding',
          BaseEncoding: 'WinAnsiEncoding',
          Differences: options.differences.map((d) => (typeof d === 'string' ? PDFName.of(d) : d)),
        }
      : 'WinAnsiEncoding',
  };
  if (options.toUnicode) font.ToUnicode = ctx.register(ctx.stream(options.toUnicode));
  const fonts = { F1: ctx.register(ctx.obj(font as never)) };
  const xobjects: Record<string, PDFRef> = {};
  for (const [name, content] of Object.entries(options.forms ?? {})) {
    xobjects[name] = ctx.register(
      ctx.stream(content, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: options.bbox ?? [0, 0, 400, 200],
        Resources: { Font: fonts },
      }),
    );
  }
  for (const content of options.pages) {
    const page = doc.addPage([400, 200]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ Font: fonts, XObject: xobjects } as never));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(content)));
  }
  return toBuffer(await doc.save());
}

/** Byte codes of every `<…> Tj` in an inflated content stream, in order. */
function codesIn(content: string): number[] {
  const out: number[] = [];
  for (const m of content.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
    const hex = m[1] ?? '';
    for (let i = 0; i + 1 < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

async function edit(
  run: LocatedRun,
  word: string,
  replacement: string,
  tier: 'auto' | 1 | 2 = 'auto',
) {
  return h.editor.applyTextEdit({ run, ...span(run, word), replacement, tier, fit: 'overflow' });
}

/** Mean darkness (0..1) of a user-space rect of a page (scale 2). */
async function ink(id: SourceId, pageIndex: number, rect: Rect): Promise<number> {
  const { bitmap, width, height } = await h.adapter.renderPage(id, pageIndex, {
    scale: 2,
    clip: rect,
  });
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = context.getImageData(0, 0, width, height).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 255 - (data[i] ?? 255);
  return sum / (255 * (data.length / 4));
}

/** Origins of the glyphs of `text` on a page (first occurrence). */
async function originsOf(id: SourceId, pageIndex: number, text: string) {
  const glyphs = (await h.editor.locateRuns(id, pageIndex)).flatMap((r) => r.glyphs);
  const at = glyphs
    .map((g) => g.text)
    .join('')
    .indexOf(text);
  expect(at).toBeGreaterThanOrEqual(0);
  return glyphs.slice(at, at + text.length).map((g) => g.origin);
}

describe('original character codes (review M3)', () => {
  test('kept glyphs keep their codes: a plain "A" and an alternate "A" stay distinct (TE1)', async () => {
    const id = await h.open(
      await pdf({
        pages: ['BT /F1 12 Tf 20 100 Td (Alpha and \\200lso xyz) Tj ET'],
        differences: [128, 'B'],
        toUnicode: ALTERNATE_A,
      }),
    );
    const run = await runWith(h, id, 0, 'xyz');
    const before = run.glyphs.map((g) => g.rect);
    const result = await edit(run, 'xyz', 'xyw', 2);
    expect(result).toMatchObject({ tier: 2, verification: { readback: 'Alpha and Also xyw' } });
    const codes = codesIn((await inflatedContent(await h.adapter.save(id), 0)).page);
    expect(codes.slice(0, 5)).toEqual([0x41, 0x6c, 0x70, 0x68, 0x61]);
    expect(codes[10]).toBe(0x80);
    // Same glyphs, same boxes (a /B in place of the "A" would have another box).
    const after = (await runWith(h, id, 0, 'xyw')).glyphs.map((g) => g.rect);
    for (let i = 0; i < 15; i++) {
      expect(after[i]!.x).toBeCloseTo(before[i]!.x, 3);
      expect(after[i]!.width).toBeCloseTo(before[i]!.width, 3);
    }
    await h.adapter.close(id);
  });

  test('tier 2 refuses a character two different glyphs read as (ambiguous-encoding) and falls back', async () => {
    const id = await h.open(
      await pdf({
        pages: ['BT /F1 12 Tf 20 100 Td (Alpha and \\200lso xyz) Tj ET'],
        differences: [128, 'B'],
        toUnicode: ALTERNATE_A,
      }),
    );
    const run = await runWith(h, id, 0, 'xyz');
    const check = await h.editor.checkEditability({ run, ...span(run, 'xyz'), replacement: 'xyA' });
    expect(check.tier2).toEqual({ ok: false, reason: 'ambiguous-encoding', missing: ['A'] });
    expect(check).toMatchObject({ tier: 1, honesty: 'font-substituted' });
    // Space and no-break space, hyphen and soft hyphen draw the same glyphs: not ambiguous.
    const plain = await h.editor.checkEditability({
      run,
      ...span(run, 'xyz'),
      replacement: 'x-y z',
    });
    expect(plain).toMatchObject({ tier2: { ok: true }, tier: 2 });
    const result = await edit(run, 'xyz', 'xyA');
    expect(result).toMatchObject({
      tier: 1,
      fellBack: false,
      tier2Refusal: 'ambiguous-encoding',
      verification: { readback: 'Alpha and Also xyA' },
    });
    const codes = codesIn((await inflatedContent(await h.adapter.save(id), 0)).page);
    expect(codes[0]).toBe(0x41);
    expect(codes).toContain(0x80);
    await h.adapter.close(id);
  });

  test('a ligature code stays one glyph; a range inside it is refused', async () => {
    const id = await h.open(
      await pdf({
        pages: ['BT /F1 12 Tf 20 100 Td (The \\201rst word) Tj ET'],
        toUnicode: LIGATURE_FI,
      }),
    );
    const run = await runWith(h, id, 0, 'first');
    expect(run.text).toBe('The first word');
    const result = await edit(run, 'word', 'line', 2);
    expect(result.verification.readback).toBe('The first line');
    expect(codesIn((await inflatedContent(await h.adapter.save(id), 0)).page)).toContain(0x81);
    const again = await runWith(h, id, 0, 'first');
    const start = again.text.indexOf('i');
    const error = await rejection(
      h.editor.applyTextEdit({
        run: again,
        start,
        end: start + 1,
        replacement: 'o',
        tier: 'auto',
        fit: 'overflow',
      }),
    );
    expect(textEditFailureReason(error)).toBe('invalid-range');
    await h.adapter.close(id);
  });

  test('codes are read from an encrypted source too (the snapshot is decrypted)', async () => {
    const id = sid('fidelity-encrypted');
    await h.adapter.open(id, await fixture(encryptedUrl), { password: 'owner' });
    const run = await runWith(h, id, 0, 'fox');
    const same = await edit(run, 'fox', 'cat', 2);
    const other = await edit(await runWith(h, id, 0, 'lazy'), 'lazy', 'sleepy', 1);
    expect([same.tier, other.tier]).toEqual([2, 1]);
    expect(await pageText(h, id, 0)).toContain('The quick brown cat jumps over the sleepy dog.');
    await h.adapter.close(id);
  });

  test('a space the text page makes up for a wide TJ gap is not written as a code', async () => {
    const id = await h.open(
      await pdf({ pages: ['BT /F1 12 Tf 20 100 Td [(Kern) -300 (ed text) 200 ( here)] TJ ET'] }),
    );
    const run = await runWith(h, id, 0, 'Kern');
    expect(run.text).toBe('Kern ed text here');
    const tail = await originsOf(id, 0, 'here');
    await edit(run, 'Kern', 'K', 1);
    await edit(await runWith(h, id, 0, 'text'), 'text', 'txt', 2);
    const codes = codesIn((await inflatedContent(await h.adapter.save(id), 0)).page);
    expect(codes.filter((c) => c === 0x20)).toHaveLength(2);
    const after = await originsOf(id, 0, 'here');
    after.forEach((p, i) =>
      expect(Math.hypot(p.x - tail[i]!.x, p.y - tail[i]!.y)).toBeLessThan(1e-3),
    );
    await h.adapter.close(id);
  });

  test('double spaces (folded to one by the text page) are kept', async () => {
    const id = await h.open(
      await pdf({ pages: ['BT /F1 12 Tf 20 100 Td (Total:  12 EUR) Tj ET'] }),
    );
    const run = await runWith(h, id, 0, 'Total');
    const eur = await originsOf(id, 0, 'EUR');
    for (const tier of [2, 1] as const) {
      const current = await runWith(h, id, 0, 'Total');
      const word = tier === 2 ? '12' : '13';
      const result = await edit(current, word, tier === 2 ? '13' : '14', tier);
      expect(result.tier).toBe(tier);
    }
    expect(run.text).toBe('Total: 12 EUR');
    expect(await pageText(h, id, 0)).toEqual(['Total: 14 EUR']);
    const codes = codesIn((await inflatedContent(await h.adapter.save(id), 0)).page);
    expect(codes.filter((c) => c === 0x20)).toHaveLength(3);
    const moved = await originsOf(id, 0, 'EUR');
    moved.forEach((p, i) =>
      expect(Math.hypot(p.x - eur[i]!.x, p.y - eur[i]!.y)).toBeLessThan(1e-3),
    );
    await h.adapter.close(id);
  });
});

describe('clip paths (review M4)', () => {
  const CLIPPED =
    'q 0 0 100 200 re W n BT /F1 12 Tf 20 100 Td (Visible part HIDDEN-PART-BEYOND-THE-CLIP) Tj ET Q';
  const BEYOND: Rect = { x: 110, y: 95, width: 250, height: 15 };

  test('clipped text stays clipped: the original object keeps the clipped glyphs (TE2)', async () => {
    const id = await h.open(await pdf({ pages: [CLIPPED] }));
    expect(await ink(id, 0, BEYOND)).toBe(0);
    const run = await runWith(h, id, 0, 'Visible');
    // "PART" is wider than "part": the original object keeps the (clipped) suffix; the
    // prefix and the replacement, inside the clip, are the new objects.
    const result = await edit(run, 'part', 'PART', 2);
    expect(result).toMatchObject({
      tier: 2,
      verification: { readback: 'Visible PART HIDDEN-PART-BEYOND-THE-CLIP' },
    });
    expect(await ink(id, 0, BEYOND)).toBe(0);
    await h.adapter.close(id);
  });

  test('an edit that would re-create glyphs outside the clip is refused', async () => {
    const id = await h.open(await pdf({ pages: [CLIPPED] }));
    const clean = await h.adapter.save(id);
    const run = await runWith(h, id, 0, 'Visible');
    // The replacement itself lies beyond the clip: no layout keeps it clipped.
    const check = await h.editor.checkEditability({
      run,
      ...span(run, 'HIDDEN'),
      replacement: 'SECRET',
    });
    expect(check).toMatchObject({
      tier2: { ok: false, reason: 'clipped' },
      tier1: { ok: false, reason: 'clipped' },
      honesty: 'not-editable',
    });
    for (const tier of ['auto', 1, 2] as const) {
      const error = await rejection(edit(run, 'HIDDEN', 'SECRET', tier));
      expect(textEditFailureReason(error)).toBe('not-editable');
      expect((error as Error).message).toContain('clipped');
    }
    expect(await ink(id, 0, BEYOND)).toBe(0);
    expect(new Uint8Array(await h.adapter.save(id))).toEqual(new Uint8Array(clean));
    await h.adapter.close(id);
  });

  test('glyphs kept in the original object keep its clip: ink beyond the clip stays zero', async () => {
    const id = await h.open(await pdf({ pages: [CLIPPED] }));
    // Same width ("part" → "trap"): the whole line stays in the original object.
    const run = await runWith(h, id, 0, 'Visible');
    const same = await edit(run, 'part', 'trap', 2);
    expect(same.verification.readback).toBe('Visible trap HIDDEN-PART-BEYOND-THE-CLIP');
    expect(await ink(id, 0, BEYOND)).toBe(0);
    // Tier 1 at the line start: the original keeps the clipped suffix, the new word is inside.
    const again = await runWith(h, id, 0, 'Visible');
    const substituted = await edit(again, 'Visible', 'Shown', 1);
    expect(substituted).toMatchObject({ tier: 1, verification: { insideLineBox: true } });
    expect(await ink(id, 0, BEYOND)).toBe(0);
    const content = (await inflatedContent(await h.adapter.save(id), 0)).page;
    expect(content).toMatch(/re W n/);
    expect(await pageText(h, id, 0)).toEqual(['Shown trap HIDDEN-PART-BEYOND-THE-CLIP']);
    await h.adapter.close(id);
  });

  test('text moved out of a form stays inside the form /BBox, or the edit is refused', async () => {
    const id = await h.open(
      await pdf({
        pages: ['/Fm1 Do'],
        forms: { Fm1: 'BT /F1 12 Tf 20 100 Td (Inside and OUTSIDE-THE-BOX) Tj ET' },
        bbox: [0, 0, 100, 200],
      }),
    );
    const beyond: Rect = { x: 110, y: 95, width: 250, height: 15 };
    expect(await ink(id, 0, beyond)).toBe(0);
    const run = await runWith(h, id, 0, 'Inside');
    const check = await h.editor.checkEditability({ run, ...span(run, 'and'), replacement: 'or' });
    expect(check).toMatchObject({
      tier1: { ok: false, reason: 'clipped' },
      honesty: 'not-editable',
    });
    const error = await rejection(edit(run, 'and', 'or'));
    expect((error as Error).message).toContain('clipped');
    expect(await ink(id, 0, beyond)).toBe(0);
    await h.adapter.close(id);
  });
});

describe('forms drawn more than once (review M2)', () => {
  const FOOTER = { Fm1: 'BT /F1 12 Tf 20 100 Td (Company footer 2024) Tj ET' };

  test('a form on two pages is not edited: the other page keeps its text (TE3)', async () => {
    const id = await h.open(await pdf({ pages: ['/Fm1 Do', '/Fm1 Do'], forms: FOOTER }));
    const run = await runWith(h, id, 0, 'footer');
    const check = await h.editor.checkEditability({
      run,
      ...span(run, '2024'),
      replacement: '2025',
    });
    expect(check).toMatchObject({
      tier1: { ok: false, reason: 'shared-form' },
      tier2: { ok: false, reason: 'blocked' },
      honesty: 'not-editable',
    });
    const error = await rejection(edit(run, '2024', '2025'));
    expect(textEditFailureReason(error)).toBe('not-editable');
    expect((error as Error).message).toContain('shared-form');
    const saved = await h.adapter.save(id);
    const reopened = await h.open(saved);
    expect(await pageText(h, reopened, 0)).toEqual(['Company footer 2024']);
    expect(await pageText(h, reopened, 1)).toEqual(['Company footer 2024']);
    await h.adapter.close(reopened);
    await h.adapter.close(id);
  });

  test('a form drawn twice on one page is not edited; a form drawn once is', async () => {
    const twice = await h.open(
      await pdf({ pages: ['/Fm1 Do q 1 0 0 1 0 -50 cm /Fm1 Do Q'], forms: FOOTER }),
    );
    const run = await runWith(h, twice, 0, 'footer');
    const error = await rejection(edit(run, '2024', '2025'));
    expect((error as Error).message).toContain('shared-form');
    expect(await pageText(h, twice, 0)).toEqual(['Company footer 2024', 'Company footer 2024']);
    await h.adapter.close(twice);

    const once = await h.open(
      await pdf({ pages: ['/Fm1 Do', 'BT /F1 12 Tf 20 100 Td (Page two) Tj ET'], forms: FOOTER }),
    );
    const single = await runWith(h, once, 0, 'footer');
    const result = await edit(single, '2024', '2025');
    expect(result).toMatchObject({ tier: 1, honesty: 'moved-out-of-form' });
    expect(await pageText(h, once, 0)).toEqual(['Company footer 2025']);
    await h.adapter.close(once);
  });
});

describe('character and word spacing (review m3)', () => {
  test('Tc: the replacement advances like the original, in and out of the original object (TE4)', async () => {
    const id = await h.open(
      await pdf({
        pages: [
          'BT /F1 12 Tf 3 Tc 20 100 Td (Alpha beta gamma) Tj ET',
          'BT /F1 12 Tf 3 Tc 20 100 Td [(Alpha ) 40 (beta gamma)] TJ ET',
        ],
      }),
    );
    for (const page of [0, 1]) {
      const before = await originsOf(id, page, 'Alpha beta gamma'.slice(0, 5));
      const step = before[1]!.x - before[0]!.x - 12 * 0.667; // "A" advance beyond its width
      expect(step).toBeCloseTo(3, 2);
      const run = await runWith(h, id, page, 'beta');
      const result = await edit(run, 'beta', 'bata', 2);
      expect(result.tier).toBe(2);
      const after = await originsOf(id, page, 'bata');
      // b a t a: 0.556, 0.556, 0.278 em, each plus 3 pt of Tc.
      expect(after[1]!.x - after[0]!.x).toBeCloseTo(12 * 0.556 + 3, 2);
      expect(after[2]!.x - after[1]!.x).toBeCloseTo(12 * 0.556 + 3, 2);
      expect(after[3]!.x - after[2]!.x).toBeCloseTo(12 * 0.278 + 3, 2);
      expect(result.verification.maxDrift).toBeLessThan(1e-3);
    }
    await h.adapter.close(id);
  });

  test('Tw: a space in the replacement gets the word spacing; shrink keeps Tc unscaled (TE9)', async () => {
    const id = await h.open(
      await pdf({ pages: ['BT /F1 12 Tf 10 Tw 20 100 Td (Alpha beta gamma) Tj ET'] }),
    );
    const space = await originsOf(id, 0, 'a b');
    const original = space[2]!.x - space[1]!.x;
    expect(original).toBeCloseTo(12 * 0.278 + 10, 2);
    const run = await runWith(h, id, 0, 'beta');
    await edit(run, 'beta', 'b b', 2);
    const after = await originsOf(id, 0, 'b b');
    expect(after[2]!.x - after[1]!.x).toBeCloseTo(original, 2);
    await h.adapter.close(id);

    const tc = await h.open(
      await pdf({
        pages: ['BT /F1 12 Tf 2 Tc 20 100 Td (Wide) Tj ET BT /F1 12 Tf 58 100 Td (next) Tj ET'],
      }),
    );
    const wide = await runWith(h, tc, 0, 'Wide');
    const check = await h.editor.checkEditability({ run: wide, replacement: 'Wider' });
    const option = check.fit.tier2!;
    expect(option.fits).toBe(false);
    const result = await h.editor.applyTextEdit({
      run: wide,
      replacement: 'Wider',
      tier: 2,
      fit: 'shrink',
    });
    // Shrunk glyph widths plus 2 pt of Tc each fill the free space exactly.
    const shrunk = await originsOf(tc, 0, 'Wider');
    const width = shrunk[4]!.x - shrunk[0]!.x + result.fontSize * 0.333 + 2 /* "r" and its Tc */;
    expect(width).toBeLessThanOrEqual(check.fit.available + 0.01);
    expect(width).toBeGreaterThan(check.fit.available - 0.05);
    await h.adapter.close(tc);
  });
});

describe('colour spaces (review m4)', () => {
  test('the original object keeps its CMYK fill; re-created glyphs are disclosed (TE5)', async () => {
    const id = await h.open(
      await pdf({
        pages: [
          'BT 0 0 0 1 k /F1 12 Tf 20 100 Td (Alpha beta gamma) Tj ET',
          'BT 0 0 0 1 k /F1 12 Tf 20 100 Td [(Alpha) -30 ( beta gamma)] TJ ET',
        ],
      }),
    );
    // Same width: everything stays in the original object, in CMYK.
    const first = await runWith(h, id, 0, 'beta');
    const kept = await edit(first, 'beta', 'bata', 2);
    expect(kept.colorSpaceChanged).toBeUndefined();
    const page0 = (await inflatedContent(await h.adapter.save(id), 0)).page;
    expect(page0).toMatch(/0 0 0 1 k/);
    expect(page0).not.toMatch(/\brg\b/);
    // A kerned line: the glyphs after the kerning need new objects, which are RGB.
    const second = await runWith(h, id, 1, 'beta');
    const check = await h.editor.checkEditability({
      run: second,
      ...span(second, 'beta'),
      replacement: 'bet',
    });
    expect(check).toMatchObject({ tier: 2, colorSpaceChanged: true });
    const split = await edit(second, 'beta', 'bet', 2);
    expect(split.colorSpaceChanged).toBe(true);
    // The kept "Alpha" is still the original object, drawn in CMYK.
    const page1 = (await inflatedContent(await h.adapter.save(id), 1)).page;
    expect(page1).toMatch(/0 0 0 1 k[^Q]*<416C706861> Tj/);
    // Tier 1 always writes the replacement in a new (RGB) object.
    const substituted = await edit(await runWith(h, id, 0, 'gamma'), 'gamma', 'Omega', 1);
    expect(substituted.colorSpaceChanged).toBe(true);
    expect((await inflatedContent(await h.adapter.save(id), 0)).page).toMatch(/0 0 0 1 k/);
    await h.adapter.close(id);
  });
});
