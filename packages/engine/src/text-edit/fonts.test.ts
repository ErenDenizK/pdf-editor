/**
 * PdfTextEditor per font kind (spec redaction-and-text-editing §2.4, §2.5): run location on
 * text-edit-fonts.pdf and text-edit-rotated.pdf, and editability, honesty and tier choice for
 * every line of the text-edit-fonts.pdf table in test/fixtures/README.md.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import fontsUrl from '../../../../test/fixtures/text-edit-fonts.pdf?url';
import rotatedUrl from '../../../../test/fixtures/text-edit-rotated.pdf?url';
import { type LocatedRun, TEXT_EDIT_SHRINK_FLOOR } from '../types';
import { textEditFailureReason } from './errors';
import { classifyFont, isWinAnsi, stripSubsetTag, substituteFace } from './fonts';
import type { FontFacts } from './raw';
import {
  createHarness,
  fixture,
  type Harness,
  onBaseline,
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

const FOX = 'The quick brown fox jumps over the lazy dog';

describe('locateRuns', () => {
  test('text-edit-fonts.pdf: one run per text object, font kinds, render modes, user space', async () => {
    const id = await h.open(await fixture(fontsUrl));
    const runs = await h.editor.locateRuns(id, 0);
    const lines = runs.map((r) => ({
      text: r.text,
      baseline: r.glyphs[0]!.origin.y,
      kind: r.font.kind,
      embedded: r.font.embedded,
      mode: r.renderMode,
    }));
    expect(lines).toEqual([
      {
        text: 'PAGE 1 OF text-edit-fonts',
        baseline: 740,
        kind: 'standard14',
        embedded: false,
        mode: 0,
      },
      { text: FOX, baseline: 700, kind: 'standard14', embedded: false, mode: 0 },
      { text: FOX, baseline: 650, kind: 'embedded', embedded: true, mode: 0 },
      { text: FOX, baseline: 600, kind: 'embedded', embedded: true, mode: 0 },
      { text: FOX, baseline: 550, kind: 'embedded', embedded: true, mode: 0 },
      { text: 'ABBA', baseline: 500, kind: 'type3', embedded: true, mode: 0 },
      { text: FOX, baseline: 400, kind: 'standard14', embedded: false, mode: 3 },
    ]);
    // (e) vector-paths at baseline 450: no text object, nothing to locate or edit.
    expect(runs.some((r) => r.lineBox.y < 452 && r.lineBox.y + r.lineBox.height > 452)).toBe(false);
    const helvetica = runs[1]!;
    expect(helvetica.font.baseName).toBe('Helvetica');
    expect(helvetica.objectPath).toEqual([1]);
    expect(helvetica.inForm).toBe(false);
    expect(helvetica.vertical).toBe(false);
    expect(helvetica.direction).toEqual({ x: 1, y: 0 });
    expect(helvetica.fontSize).toBe(16);
    expect(helvetica.charCount).toBe(FOX.length);
    // README box [72, 696.69, 316.58, 14.8]: PDFium's glyph boxes are tighter.
    expect(helvetica.lineBox.x).toBeCloseTo(72, 0);
    expect(helvetica.lineBox.y).toBeGreaterThan(696);
    expect(Math.abs(helvetica.lineBox.x + helvetica.lineBox.width - 388.58)).toBeLessThan(1.5);
    expect(runs[2]!.font.baseName).toBe('FXTAAA+Inter-Regular');
    expect(runs[3]!.font).toMatchObject({ baseName: 'JetBrainsMono-Regular', monospace: true });
    await h.adapter.close(id);
  });

  test('text-edit-rotated.pdf: glyph origins in unrotated user space, direction per text matrix', async () => {
    const id = await h.open(await fixture(rotatedUrl));
    const [p1, p2] = [await h.editor.locateRuns(id, 0), await h.editor.locateRuns(id, 1)];
    const line = (runs: readonly LocatedRun[], text: string) =>
      runs.find((r) => r.text.includes(text))!;
    expect(line(p1, 'line 1').glyphs[0]!.origin).toEqual({ x: 72, y: 700 });
    expect(line(p1, 'line 1').direction).toEqual({ x: 1, y: 0 });
    const up = line(p1, 'line 2');
    expect(up.glyphs[0]!.origin).toEqual({ x: 90, y: 72 });
    expect(up.direction.x).toBeCloseTo(0, 6);
    expect(up.direction.y).toBeCloseTo(1, 6);
    expect(up.vertical).toBe(false);
    const down = line(p2, 'line 2');
    expect(down.glyphs[0]!.origin).toEqual({ x: 522, y: 720 });
    expect(down.direction.y).toBeCloseTo(-1, 6);
    // README boxes: page1-line2 [79.95, 72, 12.95, 226.46], page2-line2 [519.1, 485.75, 12.95, 234.25].
    expect(up.lineBox.x).toBeGreaterThan(79);
    expect(up.lineBox.y + up.lineBox.height).toBeCloseTo(298.46, 0);
    expect(down.lineBox.y).toBeCloseTo(485.75, 0);
    await h.adapter.close(id);
  });
});

describe('text-edit-fonts.pdf, line by line (README table)', () => {
  test('(a) Helvetica, standard 14 not embedded: tier 2 within WinAnsi, "same font, not embedded"', async () => {
    const id = await h.open(await fixture(fontsUrl));
    const run = await runWith(h, id, 0, 'fox', onBaseline(700));
    const check = await h.editor.checkEditability({ run, ...span(run, 'fox'), replacement: 'cat' });
    expect(check).toMatchObject({
      tier2: { ok: true },
      tier1: { ok: true, substitute: 'Inter-Regular', family: 'Inter' },
      tier: 2,
      honesty: 'same-font-not-embedded',
    });
    const result = await h.editor.applyTextEdit({
      run,
      ...span(run, 'fox'),
      replacement: 'cat',
      tier: 'auto',
      fit: 'keep',
    });
    expect(result).toMatchObject({
      tier: 2,
      honesty: 'same-font-not-embedded',
      fontSize: 16,
      fellBack: false,
      verification: { readback: FOX.replace('fox', 'cat'), insideLineBox: true },
    });
    expect(result.verification.maxDrift).toBeLessThan(1e-3);
    expect(await pageText(h, id, 0)).toContain(FOX.replace('fox', 'cat'));
    // Outside WinAnsi: tier 2 is refused before anything changes; auto uses tier 1.
    const again = await runWith(h, id, 0, 'cat', onBaseline(700));
    const omega = await h.editor.checkEditability({
      run: again,
      ...span(again, 'cat'),
      replacement: 'Ωx',
    });
    expect(omega.tier2).toEqual({ ok: false, reason: 'outside-winansi', missing: ['Ω'] });
    expect(omega).toMatchObject({ tier: 1, honesty: 'font-substituted' });
    await h.adapter.close(id);
  });

  test('(b) Identity-H subset: tier 2 for chars in the subset; a missing char falls back to tier 1, honesty says so', async () => {
    const id = await h.open(await fixture(fontsUrl));
    const run = await runWith(h, id, 0, 'fox', onBaseline(650));
    const ok = await h.editor.checkEditability({ run, ...span(run, 'fox'), replacement: 'cow' });
    expect(ok).toMatchObject({ tier2: { ok: true }, tier: 2, honesty: 'same-font' });
    // "2" is not in the subset (only the sentence's glyphs are).
    const missing = await h.editor.checkEditability({
      run,
      ...span(run, 'fox'),
      replacement: 'fo2',
    });
    expect(missing).toMatchObject({
      tier2: { ok: false, reason: 'missing-glyphs', missing: ['2'] },
      tier1: { ok: true, substitute: 'Inter-Regular' },
      tier: 1,
      honesty: 'font-substituted',
    });
    const result = await h.editor.applyTextEdit({
      run,
      ...span(run, 'fox'),
      replacement: 'fo2',
      tier: 'auto',
      fit: 'shrink',
    });
    expect(result).toMatchObject({
      tier: 1,
      honesty: 'font-substituted',
      substitute: 'Inter-Regular',
      tier2Refusal: 'missing-glyphs',
      verification: { readback: FOX.replace('fox', 'fo2'), insideLineBox: true },
    });
    expect(result.fontSize).toBeLessThan(16);
    expect(result.fontSize).toBeGreaterThanOrEqual(16 * TEXT_EDIT_SHRINK_FLOOR);
    expect(result.verification.maxDrift).toBeLessThan(1e-3);
    expect(await pageText(h, id, 0)).toContain(FOX.replace('fox', 'fo2'));
    // Asking for tier 2 explicitly is refused with the reason.
    const next = await runWith(h, id, 0, 'lazy', onBaseline(650));
    const error = await rejection(
      h.editor.applyTextEdit({
        run: next,
        ...span(next, 'lazy'),
        replacement: '42',
        tier: 2,
        fit: 'overflow',
      }),
    );
    expect(textEditFailureReason(error)).toBe('not-editable');
    await h.adapter.close(id);
  });

  test('(c) whole-font Type0 (JetBrains Mono): tier 2, including glyphs the page never used', async () => {
    const id = await h.open(await fixture(fontsUrl));
    const run = await runWith(h, id, 0, 'fox', onBaseline(600));
    const check = await h.editor.checkEditability({ run, ...span(run, 'fox'), replacement: 'FOX' });
    expect(check).toMatchObject({
      tier2: { ok: true },
      tier1: { ok: true, substitute: 'JetBrainsMono-Regular' },
      honesty: 'same-font',
    });
    // Monospace: same width, fits as is.
    expect(check.fit.tier2).toMatchObject({ fits: true, shrink: 1 });
    const result = await h.editor.applyTextEdit({
      run,
      ...span(run, 'fox'),
      replacement: 'FOX',
      tier: 'auto',
      fit: 'keep',
    });
    expect(result).toMatchObject({ tier: 2, honesty: 'same-font', fontSize: 16 });
    expect(await pageText(h, id, 0)).toContain(FOX.replace('fox', 'FOX'));
    await h.adapter.close(id);
  });

  test('(b2) hand-built simple TrueType (WinAnsi subset): tier 2, and tier 1 for a missing char', async () => {
    const id = await h.open(await fixture(fontsUrl));
    const run = await runWith(h, id, 0, 'fox', onBaseline(550));
    const result = await h.editor.applyTextEdit({
      run,
      ...span(run, 'fox'),
      replacement: 'cow',
      tier: 'auto',
      fit: 'overflow',
    });
    expect(result).toMatchObject({ tier: 2, honesty: 'same-font' });
    const next = await runWith(h, id, 0, 'lazy', onBaseline(550));
    const check = await h.editor.checkEditability({
      run: next,
      ...span(next, 'lazy'),
      replacement: 'L4zy',
    });
    expect(check.tier2).toEqual({ ok: false, reason: 'missing-glyphs', missing: ['L', '4'] });
    const fallback = await h.editor.applyTextEdit({
      run: next,
      ...span(next, 'lazy'),
      replacement: 'L4zy',
      tier: 'auto',
      fit: 'overflow',
    });
    expect(fallback).toMatchObject({ tier: 1, honesty: 'font-substituted' });
    expect(await pageText(h, id, 0)).toContain('The quick brown cow jumps over the L4zy dog');
    await h.adapter.close(id);
  });

  test('(d) Type3, (f) invisible OCR text: not editable, and nothing changes', async () => {
    const id = await h.open(await fixture(fontsUrl));
    const before = await h.adapter.save(id);
    for (const [baseline, word, reason] of [
      [500, 'ABBA', 'type3'],
      [400, 'fox', 'invisible'],
    ] as const) {
      const run = await runWith(h, id, 0, word, onBaseline(baseline));
      const check = await h.editor.checkEditability({ run, ...span(run, word), replacement: 'AB' });
      expect(check).toMatchObject({
        tier2: { ok: false, reason: 'blocked' },
        tier1: { ok: false, reason },
        honesty: 'not-editable',
      });
      expect(check.tier).toBeUndefined();
      const error = await rejection(
        h.editor.applyTextEdit({
          run,
          ...span(run, word),
          replacement: 'AB',
          tier: 'auto',
          fit: 'overflow',
        }),
      );
      expect(textEditFailureReason(error)).toBe('not-editable');
    }
    expect(new Uint8Array(await h.adapter.save(id))).toEqual(new Uint8Array(before));
    await h.adapter.close(id);
  });
});

describe('substitute face heuristics (spec §2.3)', () => {
  const facts = (baseName: string, extra: Partial<FontFacts> = {}): FontFacts => ({
    baseName,
    familyName: '',
    embedded: true,
    flags: 32,
    weight: 0,
    italicAngle: 0,
    dataBytes: 1000,
    ...extra,
  });

  test('family, weight and italic from the name and the descriptor flags', () => {
    const cases: [FontFacts, string, Partial<ReturnType<typeof classifyFont>>][] = [
      [
        facts('ABCDEF+TimesNewRomanPS-BoldItalicMT'),
        'NotoSerif-Bold',
        { bold: true, italic: true, serif: true },
      ],
      [facts('CourierNewPSMT'), 'JetBrainsMono-Regular', { monospace: true }],
      [
        facts('Arial-BoldMT', { embedded: false }),
        'Inter-Bold',
        { bold: true, kind: 'not-embedded' },
      ],
      [facts('Helvetica', { embedded: false }), 'Inter-Regular', { kind: 'standard14' }],
      [
        facts('Times-Roman', { embedded: false }),
        'NotoSerif-Regular',
        { kind: 'standard14', serif: true },
      ],
      [
        facts('XYZABC+Calibri', { flags: 32 + 64 }),
        'Inter-Regular',
        { italic: true, serif: false },
      ],
      [facts('Garamond', { flags: 2 }), 'NotoSerif-Regular', { serif: true }],
      [facts('SourceSansPro-Semibold'), 'Inter-Bold', { bold: true, serif: false }],
      [facts('Custom', { flags: 1 }), 'JetBrainsMono-Regular', { monospace: true }],
      [facts('Unknown', { weight: 700 }), 'Inter-Bold', { bold: true }],
      [facts('', { dataBytes: 0, flags: 0 }), 'Inter-Regular', { kind: 'type3' }],
    ];
    for (const [input, face, expected] of cases) {
      const font = classifyFont(input);
      expect(font).toMatchObject(expected);
      expect(substituteFace(font).key).toBe(face);
    }
    expect(stripSubsetTag('ABCDEF+Inter-Regular')).toBe('Inter-Regular');
    expect(['A', 'é', '€', '—', 'ÿ'].every(isWinAnsi)).toBe(true);
    expect(['Ω', 'ğ', '\u0130'].some(isWinAnsi)).toBe(false);
  });
});
