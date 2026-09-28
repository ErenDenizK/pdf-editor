/**
 * Golden tests of the redaction post-pass and the forensic self-check on the M4 fixtures
 * (test/fixtures/README.md, "Redaction and text-editing targets"): engine pass as in the
 * spike (test-helpers.ts), then `scrubRedactedDocument`, then `forensicCheck` on the exact
 * output. Every fixture must pass every check, and each deliberately skipped step must be
 * caught by the check that covers it.
 */

import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import type { Rect } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import annotationsUrl from '../../../../test/fixtures/redact-annotations.pdf?url';
import formXObjectUrl from '../../../../test/fixtures/redact-form-xobject.pdf?url';
import incrementalUrl from '../../../../test/fixtures/redact-incremental.pdf?url';
import metadataUrl from '../../../../test/fixtures/redact-metadata.pdf?url';
import type { ForensicReport, RedactionArea, RedactionPlan } from '../types';
import { byteVariants } from './byte-grep';
import { forensicCheck } from './forensic';
import { byteGrepFindings, readRawFile } from './forensic-file';
import { type ScrubStep, scrubRedactedDocument } from './scrub';
import { createRedactionHarness, type RedactionHarness } from './test-helpers';

const TOKEN = 'SECRET-7731';
const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});
/** Suggested areas from the fixture README (unrotated user space, page 1). */
const AREAS: Record<string, readonly RedactionArea[]> = {
  metadata: [{ pageIndex: 0, rect: rect(193.96, 675.7, 94.58, 17.85) }],
  annotations: [{ pageIndex: 0, rect: rect(142.61, 675.7, 94.58, 17.85) }],
  incremental: [{ pageIndex: 0, rect: rect(170.6, 675.7, 94.58, 17.85) }],
  formXObject: [
    { pageIndex: 0, rect: rect(145.69, 705.7, 94.58, 17.85) },
    { pageIndex: 0, rect: rect(155.03, 665.7, 94.58, 17.85) },
  ],
};
const URLS: Record<string, string> = {
  metadata: metadataUrl,
  annotations: annotationsUrl,
  incremental: incrementalUrl,
  formXObject: formXObjectUrl,
};

let h: RedactionHarness;
const engineOutput = new Map<string, ArrayBuffer>();

beforeAll(async () => {
  h = await createRedactionHarness(wasmUrl);
  for (const [name, url] of Object.entries(URLS)) {
    const bytes = await (await fetch(url)).arrayBuffer();
    engineOutput.set(name, await h.engineRedact(bytes, AREAS[name] ?? []));
  }
});
afterAll(async () => {
  await h.destroy();
});

const planFor = (name: string, extra: Partial<RedactionPlan> = {}): RedactionPlan => ({
  areas: AREAS[name] ?? [],
  strings: [TOKEN],
  ...extra,
});

async function check(bytes: ArrayBuffer, plan: RedactionPlan): Promise<ForensicReport> {
  const opened = await h.open(bytes);
  try {
    return await forensicCheck(bytes, plan, opened.deps);
  } finally {
    await opened.close();
  }
}

async function pipeline(name: string, extra: Partial<RedactionPlan> = {}, skip: ScrubStep[] = []) {
  const plan = planFor(name, extra);
  const input = engineOutput.get(name);
  if (!input) throw new Error(`no engine output for ${name}`);
  const { bytes, report } = await scrubRedactedDocument(input, plan, { skip });
  return { plan, bytes, report, forensic: await check(bytes, plan) };
}

const failing = (r: ForensicReport) => r.checks.filter((c) => !c.passed).map((c) => c.id);
const findingsOf = (r: ForensicReport, id: string) =>
  r.checks.find((c) => c.id === id)?.findings ?? [];

describe('scrub + forensic check on the M4 fixtures', () => {
  test.each(Object.keys(URLS))('%s: the scrubbed output passes every check', async (name) => {
    const { forensic, report } = await pipeline(name, { overlayText: 'REDACTED' });
    expect(failing(forensic)).toEqual([]);
    expect(forensic.ok).toBe(true);
    expect(forensic.checks.map((c) => c.id)).toEqual([
      'parse',
      'single-revision',
      'no-unreachable-objects',
      'no-text-in-areas',
      'no-search-hits',
      'object-strings',
      'byte-grep',
      'no-annotations-in-areas',
      'fill-pixels',
    ]);
    expect(report.warnings).toEqual([]);
    expect(report.unreachableObjectsRemoved).toBeGreaterThan(0); // the engine's in-session orphans
  });

  test('metadata: every document-level channel is scrubbed, the tree stays tagged', async () => {
    const { report, bytes } = await pipeline('metadata');
    expect(report).toMatchObject({
      stringsReplaced: 3, // Info /Title, Info /Subject, outline /Title
      namesRenamed: 1, // the named destination
      metadata: { xmpRegenerated: true, thumbnails: 1 },
      structure: 'intact', // the engine keeps MCID 0 (the rest of the paragraph)
      attachments: { removed: 2, unverified: [] }, // /EmbeddedFiles entry and catalog /AF
    });
    const opened = await h.adapter.open('meta-out' as never, bytes.slice(0));
    expect(opened.metadata.title).toBe('Metadata scrub fixture: [redacted]');
    expect(opened.outline.map((o) => o.title)).toEqual(['Introduction', 'Findings on [redacted]']);
    await h.adapter.close('meta-out' as never);
  });

  test('annotations: everything over the token goes, the survivor stays', async () => {
    const { report, bytes } = await pipeline('annotations');
    expect(report).toMatchObject({ annotationsRemoved: 5, linksRemoved: 1 }); // link, note, popup, highlight, square
    await h.adapter.open('ann-out' as never, bytes.slice(0));
    const left = await h.adapter.listAnnotations('ann-out' as never, 0);
    await h.adapter.close('ann-out' as never);
    expect(left.map((a) => a.contents)).toEqual(['Survivor note outside the area']);
  });

  test('overlay text renders centred in the fill colour pair, and extracts as itself', async () => {
    const { bytes, plan } = await pipeline('formXObject', {
      fillColor: '#b71c1c',
      overlayText: 'REDACTED',
    });
    const opened = await h.open(bytes);
    try {
      const area = plan.areas[0]!.rect;
      const px = await opened.deps.renderArea(0, area, 2);
      let red = 0;
      let light = 0;
      for (let i = 0; i < px.data.length; i += 4) {
        const [r, g, b] = [px.data[i]!, px.data[i + 1]!, px.data[i + 2]!];
        if (Math.abs(r - 0xb7) < 20 && g < 50 && b < 50) red++;
        if (r > 200 && g > 200 && b > 200) light++;
      }
      const n = px.data.length / 4;
      expect(red / n).toBeGreaterThan(0.5);
      expect(light / n).toBeGreaterThan(0.05); // white text on the dark red fill
      const glyphs = (await opened.deps.getPageText(0))
        .flatMap((r) => r.glyphs)
        .filter((g) => g.rect.x >= area.x && g.rect.x + g.rect.width <= area.x + area.width + 1)
        .filter(
          (g) => g.rect.y >= area.y - 1 && g.rect.y + g.rect.height <= area.y + area.height + 1,
        );
      expect(glyphs.map((g) => g.text).join('')).toBe('REDACTED');
      // Centred: equal margins left and right (within the 1 pt rounding of glyph boxes).
      const left = glyphs[0]!.rect.x - area.x;
      const right = area.x + area.width - (glyphs.at(-1)!.rect.x + glyphs.at(-1)!.rect.width);
      expect(Math.abs(left - right)).toBeLessThan(2.5);
    } finally {
      await opened.close();
    }
  });

  test('keepAttachments: the attachment is reported unverified, and its leak is still caught', async () => {
    const { report, forensic } = await pipeline('metadata', { keepAttachments: true });
    expect(report.attachments).toEqual({ removed: 0, unverified: ['notes.txt'] });
    expect(forensic.unverifiedAttachments).toEqual(['notes.txt']);
    // The kept body contains the token (the fixture says so): the check must say where.
    expect(failing(forensic)).toEqual(['object-strings', 'byte-grep']);
    expect(findingsOf(forensic, 'object-strings').map((f) => f.channel)).toEqual(['stream']);
  });
});

describe('the incremental fixture', () => {
  test('the source has two revisions, and the check says so', async () => {
    const source = await (await fetch(incrementalUrl)).arrayBuffer();
    const report = await check(source, planFor('incremental'));
    const revisions = findingsOf(report, 'single-revision');
    expect(revisions.map((f) => f.channel).sort()).toEqual(['%%EOF', 'startxref', 'trailer']);
    expect(failing(report)).toContain('byte-grep'); // revision 1 still holds the token
  });

  test.each([
    ['engine output', true],
    ['the source itself', false],
  ])('the full rewrite of %s drops revision 1', async (_label, viaEngine) => {
    const source = await (await fetch(incrementalUrl)).arrayBuffer();
    const input = viaEngine ? (engineOutput.get('incremental') as ArrayBuffer) : source;
    const { bytes } = await scrubRedactedDocument(input, planFor('incremental'));
    const file = readRawFile(new Uint8Array(bytes));
    expect(file.skeleton.match(/startxref/g)).toHaveLength(1);
    expect(file.skeleton).not.toMatch(/\/Prev\b/);
    const gone = (s: string) =>
      byteGrepFindings(file, [{ stringIndex: 0, variants: byteVariants(s) }]);
    expect(gone(TOKEN)).toEqual([]);
    expect(gone('Revision 1 text')).toEqual([]); // the old content stream itself
    const report = await check(bytes, planFor('incremental'));
    expect(findingsOf(report, 'single-revision')).toEqual([]);
    expect(findingsOf(report, 'byte-grep')).toEqual([]);
  });
});

describe('a deliberately broken redaction is caught', () => {
  test('strings not scrubbed: outline, Info, XMP and dest keys leak', async () => {
    const { forensic } = await pipeline('metadata', {}, ['strings']);
    expect(failing(forensic)).toEqual(['object-strings', 'byte-grep']);
    const where = findingsOf(forensic, 'object-strings').map((f) => f.where);
    expect(where.some((w) => w.endsWith('/Title'))).toBe(true);
    expect(where.some((w) => /\/Names\[\d+\]$/.test(w))).toBe(true);
  });

  test('metadata not scrubbed: the source XMP packet and the attachment leak', async () => {
    const { forensic } = await pipeline('metadata', {}, ['metadata']);
    expect(failing(forensic)).toEqual(['object-strings', 'byte-grep']);
  });

  test('annotations not removed', async () => {
    const { forensic } = await pipeline('annotations', {}, ['annotations']);
    // The string step still scrubs the note's /Contents; what is left is the annotations
    // themselves, and the highlight and square painting over the fill.
    expect(failing(forensic)).toEqual(['no-annotations-in-areas', 'fill-pixels']);
    expect(findingsOf(forensic, 'no-annotations-in-areas')).toHaveLength(4); // popup is outside
  });

  test('no fill drawn', async () => {
    const { forensic } = await pipeline('formXObject', {}, ['fill']);
    expect(failing(forensic)).toEqual(['fill-pixels']);
    expect(findingsOf(forensic, 'fill-pixels').map((f) => f.areaIndex)).toEqual([0, 1]);
  });

  test('no garbage collection: the removed annotations stay in the file', async () => {
    const { forensic } = await pipeline('annotations', {}, ['gc']);
    expect(failing(forensic)).toEqual(['no-unreachable-objects']);
    expect(findingsOf(forensic, 'no-unreachable-objects').length).toBeGreaterThanOrEqual(5);
  });

  test('no engine pass: text under the area is found by every text channel', async () => {
    const source = await (await fetch(annotationsUrl)).arrayBuffer();
    const plan = planFor('annotations');
    const { bytes } = await scrubRedactedDocument(source, plan);
    const report = await check(bytes, plan);
    expect(failing(report)).toEqual([
      'no-text-in-areas',
      'no-search-hits',
      'object-strings',
      'byte-grep',
    ]);
  });

  test('an incremental update appended afterwards', async () => {
    const { bytes, plan } = await pipeline('annotations');
    const text = new TextDecoder('latin1').decode(bytes);
    const startxref = /startxref\s+(\d+)/.exec(text.slice(text.lastIndexOf('startxref')))?.[1];
    const update = `\n99 0 obj\n(${TOKEN})\nendobj\ntrailer\n<< /Size 100 /Prev ${startxref} >>\nstartxref\n${bytes.byteLength + 1}\n%%EOF\n`;
    const broken = new Uint8Array([
      ...new Uint8Array(bytes),
      ...Uint8Array.from(update, (c) => c.charCodeAt(0)),
    ]);
    const report = await check(broken.buffer, plan);
    expect(
      findingsOf(report, 'single-revision')
        .map((f) => f.channel)
        .sort(),
    ).toEqual(['%%EOF', 'startxref', 'trailer']);
    expect(failing(report)).toContain('byte-grep');
  });

  test('malformed input never throws: parse failures are failing checks', async () => {
    const deps = {
      getPageText: () => Promise.reject(new Error('not a PDF')),
      search: () => Promise.reject(new Error('not a PDF')),
      renderArea: () => Promise.reject(new Error('not a PDF')),
    };
    for (const input of [
      new Uint8Array(0),
      Uint8Array.from('%PDF-1.7\n1 0 obj <<', (c) => c.charCodeAt(0)),
    ]) {
      const report = await forensicCheck(input, planFor('annotations'), deps);
      expect(report.ok).toBe(false);
      expect(report.checks).toHaveLength(9);
      expect(failing(report)).toContain('parse');
      expect(findingsOf(report, 'fill-pixels')[0]?.detail).toBe('not a PDF');
    }
    const { bytes } = await pipeline('annotations');
    const truncated = new Uint8Array(bytes).slice(0, bytes.byteLength / 2);
    const report = await forensicCheck(truncated, planFor('annotations'), deps);
    expect(report.ok).toBe(false);
    expect(failing(report)).toContain('single-revision');
  });
});
