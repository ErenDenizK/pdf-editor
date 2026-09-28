/**
 * `applyRedactions` on the hosted engine (part b of workstream E2): the six M4 redaction
 * fixtures, vector paths (page and Form XObject, remove if touched), rotated pages, an
 * encrypted source, both fail-closed stages (gate and forensic check), and timing on
 * many-pages.pdf.
 */

import { PDFDocument, PDFName, StandardFonts, degrees } from '@cantoo/pdf-lib';
import { PdfAnnotationSubtype } from '@embedpdf/models';
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import type { Rect } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import annotationsUrl from '../../../../test/fixtures/redact-annotations.pdf?url';
import formXObjectUrl from '../../../../test/fixtures/redact-form-xobject.pdf?url';
import imagesUrl from '../../../../test/fixtures/redact-images.pdf?url';
import incrementalUrl from '../../../../test/fixtures/redact-incremental.pdf?url';
import metadataUrl from '../../../../test/fixtures/redact-metadata.pdf?url';
import textRunsUrl from '../../../../test/fixtures/redact-text-runs.pdf?url';
import encryptedUrl from '../../../../test/fixtures/encrypted-aes-128.pdf?url';
import manyPagesUrl from '../../../../test/fixtures/many-pages.pdf?url';
import { pageGeometry, userToDeviceRect } from '../pdfium/coords';
import { createHostedEngine, type HostedEngine } from '../pdfium/host';
import type { RedactionArea, RedactionPlan } from '../types';
import { applyRedactions, RedactionFailedError } from './apply';
import { engineRedact } from './engine-pass';
import { openScratch } from './engine-session';
import { blankRegionGate } from './gate';

const TOKEN = 'SECRET-7731';
const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const on = (pageIndex: number, rect: Rect): RedactionArea => ({ pageIndex, rect });
const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();

/** Suggested areas of test/fixtures/README.md ("Redaction and text-editing targets"). */
const FIXTURES: Record<string, { url: string; areas: RedactionArea[] }> = {
  'redact-text-runs': {
    url: textRunsUrl,
    areas: [
      on(0, r(163.61, 675.7, 94.58, 17.85)),
      on(0, r(165.93, 635.7, 94.86, 17.85)),
      on(0, r(168.27, 595.7, 94.58, 17.85)),
    ],
  },
  'redact-form-xobject': {
    url: formXObjectUrl,
    areas: [on(0, r(145.69, 705.7, 94.58, 17.85)), on(0, r(155.03, 665.7, 94.58, 17.85))],
  },
  'redact-images': {
    url: imagesUrl,
    areas: [on(0, r(66, 552, 70, 144)), on(0, r(234, 552, 140, 144)), on(0, r(66, 394, 76, 76))],
  },
  'redact-annotations': { url: annotationsUrl, areas: [on(0, r(142.61, 675.7, 94.58, 17.85))] },
  'redact-metadata': { url: metadataUrl, areas: [on(0, r(193.96, 675.7, 94.58, 17.85))] },
  'redact-incremental': { url: incrementalUrl, areas: [on(0, r(170.6, 675.7, 94.58, 17.85))] },
};

let host: HostedEngine;
beforeAll(async () => {
  host = await createHostedEngine({ wasm: wasmUrl });
});
afterAll(async () => {
  await host.engine.destroy?.().toPromise();
});

/** Text of every page of `bytes` (boxed glyphs only). */
async function pageTexts(bytes: ArrayBuffer, password?: string): Promise<string[]> {
  const scratch = await openScratch(host, bytes, password === undefined ? {} : { password });
  try {
    const out: string[] = [];
    for (let i = 0; i < scratch.doc.pageCount; i++) {
      out.push(
        (await scratch.chars(i))
          .filter((c) => c.rect)
          .map((c) => c.text)
          .join(''),
      );
    }
    return out;
  } finally {
    await scratch.close();
  }
}

/** Share of dark pixels in `rect` of a page render. */
async function darkShare(bytes: ArrayBuffer, pageIndex: number, rect: Rect): Promise<number> {
  const scratch = await openScratch(host, bytes);
  try {
    const px = await scratch.renderArea(pageIndex, rect, 2);
    let dark = 0;
    for (let i = 0; i < px.data.length; i += 4) if ((px.data[i] ?? 255) < 128) dark++;
    return dark / (px.data.length / 4);
  } finally {
    await scratch.close();
  }
}

/** A padded user-space area around the first search hit of `query`. */
async function areaOf(
  bytes: ArrayBuffer,
  query: string,
  password?: string,
): Promise<RedactionArea> {
  const scratch = await openScratch(host, bytes, password === undefined ? {} : { password });
  try {
    const hit = (await scratch.search(query))[0];
    if (!hit) throw new Error(`${query} not found`);
    const xs = hit.rects.flatMap((q) => [q.x, q.x + q.width]);
    const ys = hit.rects.flatMap((q) => [q.y, q.y + q.height]);
    const [x0, y0] = [Math.min(...xs) - 1, Math.min(...ys) - 1];
    return on(hit.pageIndex, r(x0, y0, Math.max(...xs) + 1 - x0, Math.max(...ys) + 1 - y0));
  } finally {
    await scratch.close();
  }
}

/** Adds a /Redact mark with a red interior colour (a pending viewer mark) and saves. */
async function engineMark(bytes: ArrayBuffer, area: RedactionArea): Promise<ArrayBuffer> {
  const scratch = await openScratch(host, bytes);
  try {
    const page = scratch.page(area.pageIndex);
    const device = userToDeviceRect(pageGeometry(page), area.rect);
    await host.engine
      .createPageAnnotation(scratch.doc, page, {
        id: '',
        type: PdfAnnotationSubtype.REDACT,
        pageIndex: area.pageIndex,
        rect: device,
        segmentRects: [device],
        color: '#FF0000',
      })
      .toPromise();
    return await host.engine.saveAsCopy(scratch.doc).toPromise();
  } finally {
    await scratch.close();
  }
}

async function build(init: (doc: PDFDocument) => Promise<void> | void): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  await init(doc);
  return (await doc.save({ useObjectStreams: false })).slice().buffer;
}

describe('applyRedactions on the M4 fixtures', () => {
  test.each(Object.keys(FIXTURES))('%s: gate and every forensic check pass', async (name) => {
    const { url, areas } = FIXTURES[name]!;
    const plan: RedactionPlan = { areas, strings: [], overlayText: 'REDACTED' };
    const result = await applyRedactions(host, await fetchBytes(url), plan);
    expect(result.gate.ok).toBe(true);
    expect(result.gate.areas.every((a) => a.blank)).toBe(true);
    expect(result.forensic.checks.filter((c) => !c.passed)).toEqual([]);
    expect(result.engine).toMatchObject({ pages: 1, areas: areas.length, decrypted: false });
    const text = (await pageTexts(result.bytes)).join('\n');
    expect(text).not.toContain(TOKEN);
    if (name !== 'redact-incremental') {
      // The innocuous line (where the fixture has one) survives: over-redaction check.
      if (name !== 'redact-images') expect(text).toContain('PAGE 1 OF');
    }
  });

  test('the token under the areas is captured and scrubbed document-wide', async () => {
    const result = await applyRedactions(host, await fetchBytes(metadataUrl), {
      areas: FIXTURES['redact-metadata']!.areas,
      strings: [],
    });
    expect(result.captured.strings).toEqual([TOKEN]);
    expect(result.plan.strings).toEqual([TOKEN]);
    expect(result.redaction.namesRenamed).toBe(1); // the named destination, found via capture
    const runs = await applyRedactions(host, await fetchBytes(textRunsUrl), {
      areas: FIXTURES['redact-text-runs']!.areas,
      strings: [TOKEN],
    });
    expect(runs.plan.strings).toEqual([TOKEN]); // captured duplicates are not repeated
    expect((await pageTexts(runs.bytes))[0]).toContain(
      'The quick brown fox jumps over the lazy dog',
    );
  });

  test('images: the fully covered image is removed, the untouched one still renders', async () => {
    const bytes = await fetchBytes(imagesUrl);
    const result = await applyRedactions(host, bytes, {
      areas: FIXTURES['redact-images']!.areas,
      strings: [],
    });
    // Im2, and the inline image (the engine turns it into an XObject); Im1 is only half covered.
    expect(result.engine.imagesRemoved).toBe(2);
    const untouched = r(412, 564, 120, 120); // Im3, inside its box
    expect(await darkShare(result.bytes, 0, untouched)).toBeGreaterThan(0.1);
  });
});

describe('pending marks in the input', () => {
  test('marks already in the bytes are not applied: only the plan is', async () => {
    const bytes = await build(async (doc) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([400, 300]);
      page.drawText(`Keep this line ${TOKEN}`, { x: 40, y: 200, size: 14, font });
      page.drawText('KEEP-ME stays here', { x: 40, y: 100, size: 14, font });
    });
    // A viewer-style mark with a red /IC over KEEP-ME, left in the bytes by mistake.
    const withMark = await engineMark(bytes, await areaOf(bytes, 'KEEP-ME'));
    const area = await areaOf(bytes, TOKEN);
    const result = await applyRedactions(host, withMark, { areas: [area], strings: [] });
    expect(result.engine.pendingMarksDropped).toBe(1);
    expect((await pageTexts(result.bytes))[0]).toContain('KEEP-ME stays here');
    expect(result.forensic.ok).toBe(true);
  });
});

describe('vector paths: remove if touched', () => {
  test('paths touching the area go (page and Form XObject), the others stay', async () => {
    const bytes = await build(async (doc) => {
      const ctx = doc.context;
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([400, 300]);
      const form = ctx.register(
        ctx.stream('0 0 0 RG 4 w 100 140 m 300 170 l S 20 250 m 60 250 l S', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 400, 300],
        }),
      );
      page.node.set(
        PDFName.of('Resources'),
        ctx.obj({ Font: { F1: font.ref }, XObject: { Fm1: form } }),
      );
      const ops = [
        '0 0 0 RG 3 w 20 155 m 380 155 l S', // crosses the area: removed whole
        '0 0 0 rg 50 40 100 30 re f', // outside: stays
        'q 1 0 0 1 10 0 cm /Fm1 Do Q', // form: its diagonal crosses the area, its short line does not
        `BT /F1 14 Tf 150 150 Td (${TOKEN}) Tj ET`,
      ].join('\n');
      page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(ops)));
    });
    const area = await areaOf(bytes, TOKEN);
    const result = await applyRedactions(host, bytes, { areas: [area], strings: [] });
    expect(result.engine.pathsRemoved).toBe(2);
    expect(await darkShare(result.bytes, 0, r(330, 150, 40, 10))).toBe(0); // rest of the crossing line
    expect(await darkShare(result.bytes, 0, r(115, 140, 20, 6))).toBe(0); // start of the form's diagonal
    expect(await darkShare(result.bytes, 0, r(55, 45, 90, 20))).toBeGreaterThan(0.9); // outside rect
    expect(await darkShare(result.bytes, 0, r(35, 248, 30, 4))).toBeGreaterThan(0.3); // form's short line
  });
});

describe('failing closed', () => {
  test('a path nested deeper than the removal pass follows stops the gate before the fill', async () => {
    const bytes = await build(async (doc) => {
      const ctx = doc.context;
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([400, 300]);
      // 14 nested Form XObjects; the innermost strokes a line across the token.
      let inner = ctx.register(
        ctx.stream('0 0 0 RG 6 w 100 155 m 300 155 l S', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 400, 300],
        }),
      );
      for (let depth = 0; depth < 13; depth++) {
        inner = ctx.register(
          ctx.stream('/F Do', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 400, 300],
            Resources: { XObject: { F: inner } },
          }),
        );
      }
      page.node.set(
        PDFName.of('Resources'),
        ctx.obj({ Font: { F1: font.ref }, XObject: { F: inner } }),
      );
      const ops = `/F Do\nBT /F1 14 Tf 150 150 Td (${TOKEN}) Tj ET`;
      page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(ops)));
    });
    const area = await areaOf(bytes, TOKEN);
    const error = await applyRedactions(host, bytes, { areas: [area], strings: [] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RedactionFailedError);
    const failed = error as RedactionFailedError;
    expect(failed.stage).toBe('gate');
    expect(failed.code).toBe('unsupported');
    expect(failed.message).toContain('page 1 area 0 (form)');
    expect(failed.failure.gate?.areas[0]).toMatchObject({ blank: false, remaining: ['form'] });
    expect(failed.failure.gate?.areas[0]?.backgroundShare).toBeLessThan(0.9);
    expect(failed.failure.forensic).toBeUndefined(); // stopped before the fill and the check
  });

  test('the gate classifies what is left: text and annotations of an unredacted file', async () => {
    const bytes = await fetchBytes(annotationsUrl);
    const scratch = await openScratch(host, bytes);
    try {
      const gate = await blankRegionGate(host, scratch, {
        areas: FIXTURES['redact-annotations']!.areas,
        strings: [],
      });
      expect(gate.ok).toBe(false);
      expect(gate.areas[0]?.remaining).toEqual(['annotation', 'text']);
    } finally {
      await scratch.close();
    }
  });

  test('the same text left elsewhere fails the check; "area only" (no capture) passes', async () => {
    const bytes = await build(async (doc) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([400, 300]);
      page.drawText(`Marked: ${TOKEN}`, { x: 40, y: 200, size: 14, font });
      page.drawText(`Unmarked: ${TOKEN}`, { x: 40, y: 100, size: 14, font });
    });
    const area = await areaOf(bytes, TOKEN); // the first hit: the marked line
    const error = await applyRedactions(host, bytes, { areas: [area], strings: [] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RedactionFailedError);
    const failed = error as RedactionFailedError;
    expect(failed.stage).toBe('forensic');
    const failing = failed.failure.forensic?.checks.filter((c) => !c.passed).map((c) => c.id);
    expect(failing).toEqual(['no-search-hits', 'object-strings', 'byte-grep']);
    const areaOnly = await applyRedactions(
      host,
      bytes,
      { areas: [area], strings: [] },
      { captureStrings: false },
    );
    expect(areaOnly.forensic.ok).toBe(true);
    expect((await pageTexts(areaOnly.bytes))[0]).toContain(`Unmarked: ${TOKEN}`);
  });
});

describe('rotated pages, encryption and timing', () => {
  test.each([0, 90, 180, 270])('/Rotate %i', async (rotation) => {
    const bytes = await build(async (doc) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([400, 300]);
      page.drawText(`Name: ${TOKEN} end`, { x: 40, y: 150, size: 14, font });
      page.setRotation(degrees(rotation));
    });
    const area = await areaOf(bytes, TOKEN);
    const result = await applyRedactions(host, bytes, {
      areas: [area],
      strings: [],
      overlayText: 'X',
    });
    expect(result.forensic.ok).toBe(true);
    const text = (await pageTexts(result.bytes))[0]!;
    expect(text).toContain('Name:');
    expect(text).toContain('end');
    expect(text).not.toContain('7731');
  });

  test('an encrypted source (AES-128, user password) is redacted into a plain file', async () => {
    const bytes = await fetchBytes(encryptedUrl);
    const area = await areaOf(bytes, 'PAGE 1 OF simple-text', 'user');
    const result = await applyRedactions(
      host,
      bytes,
      { areas: [area], strings: [] },
      { password: 'user' },
    );
    expect(result.engine.decrypted).toBe(true);
    expect(result.captured.strings).toEqual(['PAGE 1 OF simple-text']);
    expect(result.forensic.ok).toBe(true);
    const texts = await pageTexts(result.bytes); // opens without a password
    expect(texts[0]).not.toContain('PAGE 1 OF');
    expect(texts[1]).toContain('PAGE 2 OF simple-text');
    await expect(
      applyRedactions(host, bytes, { areas: [area], strings: [] }),
    ).rejects.toMatchObject({
      code: 'password-required',
    });
  });

  test('many-pages.pdf: one area on each of 400 pages', async () => {
    const bytes = await fetchBytes(manyPagesUrl);
    const scratch = await openScratch(host, bytes);
    const areas: RedactionArea[] = [];
    try {
      for (let i = 0; i < scratch.doc.pageCount; i++) {
        const boxes = (await scratch.chars(i)).flatMap((c) => (c.rect ? [c.rect] : []));
        const x0 = Math.min(...boxes.map((b) => b.x)) - 2;
        const y0 = Math.min(...boxes.map((b) => b.y)) - 2;
        const x1 = Math.max(...boxes.map((b) => b.x + b.width)) + 2;
        const y1 = Math.max(...boxes.map((b) => b.y + b.height)) + 2;
        areas.push(on(i, r(x0, y0, x1 - x0, y1 - y0)));
      }
    } finally {
      await scratch.close();
    }
    expect(areas).toHaveLength(400);
    const started = performance.now();
    const result = await applyRedactions(host, bytes, { areas, strings: [] });
    const total = performance.now() - started;
    console.warn(
      `[redaction timing] many-pages 400 areas: total ${total.toFixed(0)} ms, engine pass ${result.engine.durationMs.toFixed(0)} ms`,
    );
    const passOnly = await engineRedact(host, bytes, { areas, strings: [] });
    console.warn(
      `[redaction timing] engine pass without capture: ${passOnly.report.durationMs.toFixed(0)} ms`,
    );
    expect(result.forensic.ok).toBe(true);
    expect(result.captured.strings).toEqual([]); // page numbers are shorter than 4 characters
    expect(result.captured.skipped.length).toBeGreaterThan(300);
    expect((await pageTexts(result.bytes)).every((t) => t.trim() === '')).toBe(true);
    // A loose bound: the numbers above are the measurement (CI runners are slower).
    expect(total).toBeLessThan(90_000);
  }, 120_000);
});
