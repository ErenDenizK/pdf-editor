/**
 * PdfTextEditor mechanics (spec redaction-and-text-editing §2.4, §2.5): tier 1 removal and
 * extraction, kerned text, the read-back fallback, stale refs, the fit report with shrink and
 * overflow, rotated pages (rendered) and Form XObjects.
 */
import type { SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import formUrl from '../../../../test/fixtures/redact-form-xobject.pdf?url';
import fontsUrl from '../../../../test/fixtures/text-edit-fonts.pdf?url';
import rotatedUrl from '../../../../test/fixtures/text-edit-rotated.pdf?url';
import { type PageGeometry, userToDeviceRect } from '../pdfium/coords';
import { createTextEditor } from './editor';
import { textEditFailureReason } from './errors';
import {
  charOrigins,
  createHarness,
  encodings,
  fixture,
  type Harness,
  inflatedContent,
  onBaseline,
  pageText,
  rawPdf,
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
const KERNED =
  'BT /F1 12 Tf 20 100 Td [(The quick br) 30 (own f) -40 (ox jum) 25 (ps over.)] TJ ET';

/** Largest origin movement of the characters of `tail`, found in both page texts. */
function tailDrift(
  before: { text: string; origins: { x: number; y: number }[] },
  after: { text: string; origins: { x: number; y: number }[] },
  tail: string,
): number {
  const b = before.text.indexOf(tail);
  const a = after.text.lastIndexOf(tail);
  expect(b).toBeGreaterThanOrEqual(0);
  expect(a).toBeGreaterThanOrEqual(0);
  let drift = 0;
  for (let k = 0; k < tail.length; k++) {
    const p = before.origins[b + k]!;
    const q = after.origins[a + k]!;
    drift = Math.max(drift, Math.hypot(p.x - q.x, p.y - q.y));
  }
  return drift;
}

describe('tier mechanics', () => {
  test('tier 1 removes the old glyphs: not extractable, not in the content stream; the new text is', async () => {
    const bytes = await rawPdf({ content: `BT /F1 12 Tf 20 100 Td (${FOX}) Tj ET` });
    const id = await h.open(bytes);
    const run = await runWith(h, id, 0, 'fox');
    const result = await h.editor.applyTextEdit({
      run,
      ...span(run, 'fox'),
      replacement: 'wolf',
      tier: 1,
      fit: 'overflow',
    });
    expect(result).toMatchObject({ tier: 1, honesty: 'font-substituted', fellBack: false });
    expect(result.verification.insideLineBox).toBe(true);
    expect(await pageText(h, id, 0)).toEqual([FOX.replace('fox', 'wolf')]);
    expect(await h.adapter.search(id, 'fox')).toEqual([]);
    expect(await h.adapter.search(id, 'wolf')).toHaveLength(1);
    const saved = await h.adapter.save(id);
    const content = (await inflatedContent(saved, 0)).page;
    expect(encodings('fox').some((e) => content.includes(e))).toBe(false);
    // Re-opened, the new text is extractable in reading order.
    const reopened = await charOrigins(h, saved, 0);
    expect(reopened.text).toBe(FOX.replace('fox', 'wolf'));
    await h.adapter.close(id);
  });

  test('kerned TJ text: both tiers keep every neighbour in place (drift < 1e-3 pt)', async () => {
    const bytes = await rawPdf({ content: KERNED });
    const before = await charOrigins(h, bytes, 0);
    for (const [tier, replacement] of [
      [2, 'cat'],
      [1, 'owl'],
    ] as const) {
      const id = await h.open(bytes);
      const run = await runWith(h, id, 0, 'fox');
      const result = await h.editor.applyTextEdit({
        run,
        ...span(run, 'fox'),
        replacement,
        tier,
        fit: 'overflow',
      });
      expect(result.tier).toBe(tier);
      expect(result.verification.maxDrift).toBeLessThan(1e-3);
      const after = await charOrigins(h, await h.adapter.save(id), 0);
      expect(after.text).toBe(`The quick brown ${replacement} jumps over.`);
      expect(tailDrift(before, after, 'The quick brown ')).toBeLessThan(1e-3);
      expect(tailDrift(before, after, ' jumps over.')).toBeLessThan(1e-3);
      await h.adapter.close(id);
    }
  });

  test('a read-back failure in tier 2 rolls back and falls back to tier 1 (auto), or fails (tier 2)', async () => {
    // Without the pre-check, Helvetica takes "Ω" in SetText and writes 0xFF ("ÿ", research
    // 05 §2): only the read-back sees it.
    const lenient = createTextEditor(h.host, { skipTier2Precheck: true });
    const bytes = await rawPdf({ content: `BT /F1 12 Tf 20 100 Td (${FOX}) Tj ET` });
    const id = await h.open(bytes);
    const clean = await h.adapter.save(id);
    const run = await runWith(h, id, 0, 'fox');
    const check = await lenient.checkEditability({ run, ...span(run, 'fox'), replacement: 'Ωx' });
    expect(check.tier2).toEqual({ ok: false, reason: 'readback', missing: ['Ω'] });
    expect(new Uint8Array(await h.adapter.save(id))).toEqual(new Uint8Array(clean));
    const error = await rejection(
      lenient.applyTextEdit({
        run,
        ...span(run, 'fox'),
        replacement: 'Ωx',
        tier: 2,
        fit: 'overflow',
      }),
    );
    expect(textEditFailureReason(error)).toBe('verification-failed');
    expect(await pageText(h, id, 0)).toEqual([FOX]);
    const result = await lenient.applyTextEdit({
      run,
      ...span(run, 'fox'),
      replacement: 'Ωx',
      tier: 'auto',
      fit: 'overflow',
    });
    expect(result).toMatchObject({
      tier: 1,
      fellBack: true,
      tier2Refusal: 'readback',
      honesty: 'font-substituted',
      verification: { readback: FOX.replace('fox', 'Ωx') },
    });
    await h.adapter.close(id);
  });

  test('deleting a word and replacing a whole run', async () => {
    const id = await h.open(await rawPdf({ content: `BT /F1 12 Tf 20 100 Td (${FOX}) Tj ET` }));
    const run = await runWith(h, id, 0, 'fox');
    const deleted = await h.editor.applyTextEdit({
      run,
      ...span(run, 'fox '),
      replacement: '',
      tier: 'auto',
      fit: 'keep',
    });
    expect(deleted).toMatchObject({ tier: 2, verification: { readback: FOX.replace('fox ', '') } });
    expect(deleted.verification.maxDrift).toBeLessThan(1e-3);
    // The deletion leaves a gap: the rest of the line stays where it was.
    const after = await runWith(h, id, 0, 'jumps');
    expect(after.text).toBe('jumps over the lazy dog');
    expect(after.glyphs[0]!.origin.x).toBeCloseTo(run.glyphs[FOX.indexOf('jumps')]!.origin.x, 3);
    const whole = await h.editor.applyTextEdit({
      run: after,
      replacement: 'Ωmega',
      tier: 'auto',
      fit: 'keep',
    });
    expect(whole).toMatchObject({ tier: 1, verification: { readback: 'Ωmega' } });
    expect(await pageText(h, id, 0)).toEqual(['The quick brown Ωmega']);
    await h.adapter.close(id);
  });

  test('stale refs fail with stale-run; ranges must be on glyph boundaries', async () => {
    const id = await h.open(await rawPdf({ content: `BT /F1 12 Tf 20 100 Td (${FOX}) Tj ET` }));
    const run = await runWith(h, id, 0, 'fox');
    await h.editor.applyTextEdit({
      run,
      ...span(run, 'fox'),
      replacement: 'cat',
      tier: 2,
      fit: 'keep',
    });
    const stale = await rejection(
      h.editor.applyTextEdit({
        run,
        ...span(run, 'fox'),
        replacement: 'owl',
        tier: 2,
        fit: 'keep',
      }),
    );
    expect(textEditFailureReason(stale)).toBe('stale-run');
    expect((stale as Error).message).toContain(`expected "${FOX}"`);
    const fresh = await runWith(h, id, 0, 'cat');
    const range = await rejection(
      h.editor.checkEditability({
        run: fresh,
        start: 0,
        end: fresh.text.length + 1,
        replacement: 'x',
      }),
    );
    expect(textEditFailureReason(range)).toBe('invalid-range');
    await h.adapter.close(id);
  });
});

describe('fit', () => {
  test('keep refuses a wider replacement; shrink goes down to 75%; overflow keeps the size', async () => {
    const bytes = await fixture(fontsUrl);
    const id = await h.open(bytes);
    const run = await runWith(h, id, 0, 'fox', onBaseline(700));
    // Helvetica 16 pt: "fox" 21.34 pt, "wolf" 28.45 pt, "wolverine" far wider.
    const wolf = await h.editor.checkEditability({ run, ...span(run, 'fox'), replacement: 'wolf' });
    expect(wolf.fit.available).toBeCloseTo(21.344, 2);
    expect(wolf.fit.replaced).toBeCloseTo(21.344, 2);
    expect(wolf.fit.boundedByGlyph).toBe(true);
    expect(wolf.fit.tier2!.width).toBeCloseTo(28.448, 2);
    expect(wolf.fit.tier2).toMatchObject({ fits: false, canShrink: true });
    expect(wolf.fit.tier2!.shrink).toBeCloseTo(21.344 / 28.448, 3);
    expect(wolf.fit.tier1!.width).toBeGreaterThan(wolf.fit.tier2!.width);
    const keep = await rejection(
      h.editor.applyTextEdit({
        run,
        ...span(run, 'fox'),
        replacement: 'wolf',
        tier: 'auto',
        fit: 'keep',
      }),
    );
    expect(textEditFailureReason(keep)).toBe('does-not-fit');
    const long = await h.editor.checkEditability({
      run,
      ...span(run, 'fox'),
      replacement: 'wolverine',
    });
    expect(long.fit.tier2).toMatchObject({ fits: false, canShrink: false });
    const floor = await rejection(
      h.editor.applyTextEdit({
        run,
        ...span(run, 'fox'),
        replacement: 'wolverine',
        tier: 'auto',
        fit: 'shrink',
      }),
    );
    expect(textEditFailureReason(floor)).toBe('does-not-fit');
    const shrunk = await h.editor.applyTextEdit({
      run,
      ...span(run, 'fox'),
      replacement: 'wolf',
      tier: 'auto',
      fit: 'shrink',
    });
    expect(shrunk.tier).toBe(2);
    expect(shrunk.fontSize).toBeCloseTo((16 * 21.344) / 28.448, 2);
    expect(shrunk.fontSize).toBeLessThanOrEqual((16 * 21.344) / 28.448);
    expect(shrunk.verification.insideLineBox).toBe(true);
    // The last word may use the free space up to the page edge.
    const edited = await runWith(h, id, 0, 'dog', onBaseline(700));
    const dog = await h.editor.checkEditability({
      run: edited,
      ...span(edited, 'dog'),
      replacement: 'doggies',
    });
    expect(dog.fit.boundedByGlyph).toBe(false);
    expect(dog.fit.available).toBeGreaterThan(200);
    expect(dog.fit.tier2).toMatchObject({ fits: true, shrink: 1 });
    // Overflow: wider than the free space, at the original size.
    const over = await runWith(h, id, 0, 'jumps', onBaseline(700));
    const overflow = await h.editor.applyTextEdit({
      run: over,
      ...span(over, 'jumps'),
      replacement: 'leaps high',
      tier: 'auto',
      fit: 'overflow',
    });
    expect(overflow).toMatchObject({ tier: 2, fontSize: 16 });
    await h.adapter.close(id);
  });

  test('free space ends at the next glyph of another object on the same baseline', async () => {
    const bytes = await rawPdf({
      content:
        'BT /F1 12 Tf 20 100 Td (Left part) Tj ET\nBT /F1 12 Tf 120 100 Td (Right part) Tj ET',
    });
    const id = await h.open(bytes);
    const run = await runWith(h, id, 0, 'Left');
    const check = await h.editor.checkEditability({ run, ...span(run, 'part'), replacement: 'x' });
    expect(check.fit.boundedByGlyph).toBe(true);
    const partStart = run.glyphs[5]!.origin.x;
    expect(check.fit.available).toBeCloseTo(120 - partStart, 3);
    await h.adapter.close(id);
  });
});

/** RGBA pixels of a page render (display orientation). */
async function render(id: SourceId, pageIndex: number, scale: number) {
  const result = await h.adapter.renderPage(id, pageIndex, { scale });
  const canvas = new OffscreenCanvas(result.width, result.height);
  const context = canvas.getContext('2d')!;
  context.drawImage(result.bitmap, 0, 0);
  result.bitmap.close();
  return context.getImageData(0, 0, result.width, result.height);
}

function changedOutside(
  a: ImageData,
  b: ImageData,
  box: { x0: number; y0: number; x1: number; y1: number },
) {
  let outside = 0;
  let inside = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const k = (y * a.width + x) * 4;
      const differs = [0, 1, 2].some((c) => Math.abs(a.data[k + c]! - b.data[k + c]!) > 8);
      if (!differs) continue;
      if (x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1) inside++;
      else outside++;
    }
  }
  return { outside, inside };
}

describe('rotated pages (text-edit-rotated.pdf)', () => {
  test('edits on /Rotate 90 and 270 pages: positions in unrotated user space, the new text renders in place', async () => {
    const bytes = await fixture(rotatedUrl);
    const id = await h.open(bytes);
    const opened = await h.adapter.open(`${id}-probe` as SourceId, bytes.slice(0));
    await h.adapter.close(`${id}-probe` as SourceId);
    const cases = [
      { page: 0, line: 'line 2', word: 'reads', replacement: 'looks', tier: 2 as const },
      { page: 1, line: 'line 2', word: 'reads', replacement: 'looks', tier: 1 as const },
      { page: 0, line: 'line 1', word: 'fox', replacement: 'cat', tier: 1 as const },
    ];
    for (const c of cases) {
      const run = await runWith(h, id, c.page, c.line);
      const scale = 1;
      const before = await render(id, c.page, scale);
      const { start } = span(run, c.word);
      const origin = run.glyphs[start]!.origin;
      const result = await h.editor.applyTextEdit({
        run,
        ...span(run, c.word),
        replacement: c.replacement,
        tier: c.tier,
        fit: 'overflow',
      });
      expect(result.tier).toBe(c.tier);
      expect(result.verification.maxDrift).toBeLessThan(1e-3);
      const after = await runWith(h, id, c.page, c.replacement);
      const glyphs = after.glyphs;
      // The replacement's run starts where the word started, along the same direction.
      const first = after.text.startsWith(c.replacement)
        ? glyphs[0]!
        : glyphs[after.text.indexOf(c.replacement)]!;
      expect(first.origin.x).toBeCloseTo(origin.x, 3);
      expect(first.origin.y).toBeCloseTo(origin.y, 3);
      expect(after.direction.x).toBeCloseTo(run.direction.x, 6);
      expect(after.direction.y).toBeCloseTo(run.direction.y, 6);
      // Upright on screen: the render changes only inside the line's device box.
      const page = opened.pages[c.page]!;
      const geometry: PageGeometry = {
        quarterTurns: ((page.rotation / 90) & 3) as 0 | 1 | 2 | 3,
        displayWidth: page.rotation % 180 === 0 ? page.size.width : page.size.height,
        displayHeight: page.rotation % 180 === 0 ? page.size.height : page.size.width,
        originX: 0,
        originY: 0,
      };
      const d = userToDeviceRect(geometry, run.lineBox);
      const pad = 3;
      const box = {
        x0: Math.floor(d.origin.x * scale) - pad,
        y0: Math.floor(d.origin.y * scale) - pad,
        x1: Math.ceil((d.origin.x + d.size.width) * scale) + pad,
        y1: Math.ceil((d.origin.y + d.size.height) * scale) + pad,
      };
      const diff = changedOutside(before, await render(id, c.page, scale), box);
      expect(diff.outside).toBe(0);
      expect(diff.inside).toBeGreaterThan(0);
    }
    await h.adapter.close(id);
  });
});

describe('Form XObjects (redact-form-xobject.pdf)', () => {
  test('text in a form: tier 1 only, written at page level, "moved out of form"; nested forms are not editable', async () => {
    const id = await h.open(await fixture(formUrl));
    const outer = await runWith(h, id, 0, 'Outer form');
    expect(outer).toMatchObject({ inForm: true, objectPath: [1, 0] });
    const check = await h.editor.checkEditability({
      run: outer,
      ...span(outer, 'SECRET-7731'),
      replacement: 'PUBLIC',
    });
    expect(check).toMatchObject({
      tier2: { ok: false, reason: 'in-form' },
      tier1: { ok: true },
      tier: 1,
      honesty: 'moved-out-of-form',
    });
    const result = await h.editor.applyTextEdit({
      run: outer,
      ...span(outer, 'SECRET-7731'),
      replacement: 'PUBLIC',
      tier: 'auto',
      fit: 'keep',
    });
    expect(result).toMatchObject({
      tier: 1,
      honesty: 'moved-out-of-form',
      tier2Refusal: 'in-form',
      verification: { readback: 'Outer form: PUBLIC stays', insideLineBox: true },
    });
    const nested = await runWith(h, id, 0, 'Nested form');
    expect(nested.objectPath).toHaveLength(3);
    const blocked = await h.editor.checkEditability({
      run: nested,
      ...span(nested, 'SECRET-7731'),
      replacement: 'PUBLIC',
    });
    expect(blocked).toMatchObject({
      tier1: { ok: false, reason: 'nested-form' },
      honesty: 'not-editable',
    });
    const saved = await h.adapter.save(id);
    const content = await inflatedContent(saved, 0);
    // The outer form keeps only the nested form's invocation; the edited line is page content.
    expect(content.forms).toHaveLength(1);
    expect(content.forms[0]).not.toMatch(/Tj|TJ/);
    expect(content.forms[0]).toContain('Do');
    const text = (await charOrigins(h, saved, 0)).text;
    expect(text).toContain('Outer form: PUBLIC stays');
    expect(text).toContain('Nested form: SECRET-7731 stays');
    await h.adapter.close(id);
  });
});
