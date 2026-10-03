/**
 * Run location facts for paragraph analysis (spec craft §4.1, §8): ascent and descent, fill
 * colour, loose line box, baseline, font identity, line-end hyphen and the character
 * matrix on `LocatedRun`, and the raw wrappers behind them (object bounds, glyph outlines).
 */
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import type { SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { toBuffer } from '../../test/helpers';
import type { LocatedRun } from '../types';
import { locatePage, objectTree, resolveRun } from './locate';
import { RawText } from './raw';
import { createHarness, type Harness } from './test-helpers';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.adapter.destroy();
});

/** A one-page PDF: F1 = Helvetica, F2 = Times-Roman (both WinAnsi, not embedded). */
async function twoFontPdf(content: string): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const page = doc.addPage([400, 300]);
  const font = (base: string) =>
    ctx.register(
      ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: base, Encoding: 'WinAnsiEncoding' }),
    );
  page.node.set(
    PDFName.of('Resources'),
    ctx.obj({ Font: { F1: font('Helvetica'), F2: font('Times-Roman') } }),
  );
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(content)));
  return toBuffer(await doc.save());
}

/** Runs `fn` with raw access to page `pageIndex` of `source` and a fresh text page. */
function withPage<T>(
  source: SourceId,
  pageIndex: number,
  fn: (raw: RawText, pagePtr: number, textPage: number) => T,
): Promise<T> {
  return h.host.withRawAccess(source, (access) => {
    const raw = new RawText(access.module, access.memory);
    const page = access.doc.acquirePage(pageIndex);
    try {
      return raw.withTextPage(page.pagePtr, (textPage) => fn(raw, page.pagePtr, textPage));
    } finally {
      page.release();
    }
  });
}

async function runsOf(bytes: ArrayBuffer): Promise<{ id: SourceId; runs: readonly LocatedRun[] }> {
  const id = await h.open(bytes);
  return { id, runs: await h.editor.locateRuns(id, 0) };
}

const CONTENT =
  'BT 1 0 0 rg /F1 12 Tf 20 200 Td (An exam-) Tj 0 -14 Td (ple line) Tj ET ' +
  'BT 0 0 1 rg /F2 12 Tf 20 150 Td (Times) Tj ET ' +
  'BT 0 g /F1 10 Tf 0 1 -1 0 200 50 Tm (Up) Tj ET';

function run(runs: readonly LocatedRun[], text: string): LocatedRun {
  const found = runs.find((r) => r.text.startsWith(text));
  if (!found) throw new Error(`no run "${text}" in ${JSON.stringify(runs.map((r) => r.text))}`);
  return found;
}

function contains(
  outer: { x: number; y: number; width: number; height: number },
  inner: typeof outer,
) {
  const e = 0.01;
  return (
    outer.x <= inner.x + e &&
    outer.y <= inner.y + e &&
    outer.x + outer.width >= inner.x + inner.width - e &&
    outer.y + outer.height >= inner.y + inner.height - e
  );
}

describe('enriched located runs', () => {
  test('ascent and descent come from the font at the run size, in text space', async () => {
    const { runs } = await runsOf(await twoFontPdf(CONTENT));
    const helvetica = run(runs, 'An exam');
    expect(helvetica.ascent).toBeGreaterThan(0.6 * 12);
    expect(helvetica.ascent).toBeLessThan(1.1 * 12);
    expect(helvetica.descent).toBeLessThan(0);
    expect(helvetica.descent).toBeGreaterThan(-0.4 * 12);
    // Same font at another size scales linearly.
    const up = run(runs, 'Up');
    expect(up.ascent).toBeCloseTo(((helvetica.ascent ?? 0) * 10) / 12, 3);
    // Times differs from Helvetica.
    expect(run(runs, 'Times').ascent).not.toBeCloseTo(helvetica.ascent ?? 0, 2);
  });

  test("fill colour is the glyphs' RGBA", async () => {
    const { runs } = await runsOf(await twoFontPdf(CONTENT));
    expect(run(runs, 'An exam').fill).toEqual([255, 0, 0, 255]);
    expect(run(runs, 'Times').fill).toEqual([0, 0, 255, 255]);
    expect(run(runs, 'Up').fill).toEqual([0, 0, 0, 255]);
  });

  test('the loose line box spans ascent to descent and contains the ink box', async () => {
    const { runs } = await runsOf(await twoFontPdf(CONTENT));
    const r = run(runs, 'ple line');
    const loose = r.looseLineBox;
    expect(loose).toBeDefined();
    if (!loose) return;
    expect(contains(loose, r.lineBox)).toBe(true);
    expect(loose.y).toBeCloseTo(186 + (r.descent ?? 0), 1);
    expect(loose.y + loose.height).toBeCloseTo(186 + (r.ascent ?? 0), 1);
  });

  test('baseline is the origin across the writing direction', async () => {
    const { runs } = await runsOf(await twoFontPdf(CONTENT));
    expect(run(runs, 'An exam').baseline).toBeCloseTo(200, 3);
    expect(run(runs, 'ple line').baseline).toBeCloseTo(186, 3);
    // Rotated 90°: direction (0, 1), the baseline is −x of the origin.
    const up = run(runs, 'Up');
    expect(up.direction.x).toBeCloseTo(0, 5);
    expect(up.direction.y).toBeCloseTo(1, 5);
    expect(up.baseline).toBeCloseTo(-200, 3);
  });

  test('font ids are shared by runs in one FPDF_FONT, also through resolveRun', async () => {
    const { id, runs } = await runsOf(await twoFontPdf(CONTENT));
    const ids = ['An exam', 'ple line', 'Times', 'Up'].map((t) => run(runs, t).fontId);
    expect(ids).toEqual([0, 0, 1, 0]);
    const times = run(runs, 'Times');
    const resolved = await withPage(id, 0, (raw, pagePtr, textPage) =>
      resolveRun(raw, pagePtr, textPage, times),
    );
    expect(resolved.located.fontId).toBe(1);
  });

  test('a hyphen at a line end is flagged on the run, not elsewhere', async () => {
    const { runs } = await runsOf(await twoFontPdf(CONTENT));
    expect(run(runs, 'An exam').endsWithHyphen).toBe(true);
    expect(run(runs, 'ple line').endsWithHyphen).toBe(false);
    expect(run(runs, 'Times').endsWithHyphen).toBe(false);
  });

  test("the text matrix is the first character's effective matrix", async () => {
    const { runs } = await runsOf(await twoFontPdf(CONTENT));
    const second = run(runs, 'ple line').textMatrix ?? [];
    [1, 0, 0, 1, 20, 186].forEach((v, i) => expect(second[i]).toBeCloseTo(v, 4));
    const up = run(runs, 'Up').textMatrix ?? [];
    [0, 1, -1, 0, 200, 50].forEach((v, i) => expect(up[i]).toBeCloseTo(v, 4));
  });

  test('locatePage and the editor agree (the editor uses locatePage)', async () => {
    const { id, runs } = await runsOf(await twoFontPdf(CONTENT));
    const direct = await withPage(id, 0, (raw, pagePtr, textPage) =>
      locatePage(raw, pagePtr, textPage, id, 0),
    );
    expect(direct).toEqual(runs);
  });
});

describe('raw wrappers', () => {
  test('object bounds contain the glyph boxes of the object', async () => {
    const { id, runs } = await runsOf(await twoFontPdf(CONTENT));
    const r = run(runs, 'Times');
    const bounds = await withPage(id, 0, (raw, pagePtr) => {
      const objects = [...objectTree(raw, pagePtr).keys()];
      return raw.bounds(objects[r.objectPath[0] ?? -1] ?? 0);
    });
    expect(bounds).toBeDefined();
    if (bounds) expect(contains(bounds, r.lineBox)).toBe(true);
  });

  test('glyph outlines: segments start with a move and close, in em units whatever the size', async () => {
    const { id } = await runsOf(await twoFontPdf(CONTENT));
    const result = await withPage(id, 0, (raw, pagePtr) => {
      const first = [...objectTree(raw, pagePtr).keys()][0] ?? 0;
      const font = raw.font(first);
      return {
        h: raw.glyphPath(font, 'H', 12),
        h24: raw.glyphPath(font, 'H', 24),
        space: raw.glyphPath(font, ' ', 12),
      };
    });
    const segments = result.h ?? [];
    expect(segments.length).toBeGreaterThan(4);
    expect(segments[0]?.kind).toBe('move');
    expect(segments.some((s) => s.close)).toBe(true);
    for (const s of segments) {
      expect(['move', 'line', 'bezier']).toContain(s.kind);
      expect(Number.isFinite(s.x) && Number.isFinite(s.y)).toBe(true);
    }
    const top = (list: readonly { y: number }[]) => Math.max(...list.map((p) => p.y));
    // Helvetica's cap height is 0.718 em; PDFium returns the outline in em units.
    expect(top(segments)).toBeCloseTo(0.718, 2);
    expect(top(result.h24 ?? [])).toBeCloseTo(top(segments), 5);
    // A space has no outline.
    expect(result.space).toBeUndefined();
  });
});
