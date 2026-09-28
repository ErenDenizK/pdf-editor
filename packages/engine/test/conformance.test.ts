/**
 * `checkAnnotationConformance` on hand-built annotations: every rule has a failing case.
 */

import type { PDFArray, PDFDict, PDFNumber } from '@cantoo/pdf-lib';
import { PDFDocument, PDFName, type PDFRef, PDFString } from '@cantoo/pdf-lib';
import { describe, expect, test } from 'vitest';

import { checkAnnotationConformance, describeProblems } from '../src/annotations/conformance';
import { finalizeAnnotations } from '../src/annotations/finalize';

interface Built {
  readonly bytes: Uint8Array;
}

/** A page with the annotations `add` registers (given the page ref and a form factory). */
async function build(
  add: (ctx: {
    doc: PDFDocument;
    page: PDFRef;
    form: (bbox: number[], resources?: Record<string, unknown>, matrix?: number[]) => PDFRef;
    annot: (entries: Record<string, unknown>) => PDFRef;
  }) => void,
): Promise<Built> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const refs: PDFRef[] = [];
  const form = (bbox: number[], resources: Record<string, unknown> = {}, matrix?: number[]) =>
    doc.context.register(
      doc.context.stream('0 0 m 1 1 l S', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: bbox,
        Resources: resources as never,
        ...(matrix ? { Matrix: matrix } : {}),
      }),
    );
  const annot = (entries: Record<string, unknown>) => {
    const dict = doc.context.obj({ Type: 'Annot', ...entries } as never) as unknown as PDFDict;
    const ref = doc.context.register(dict);
    refs.push(ref);
    return ref;
  };
  add({ doc, page: page.ref, form, annot });
  page.node.set(PDFName.of('Annots'), doc.context.obj(refs));
  return { bytes: await doc.save() };
}

function good(extra: Record<string, unknown> = {}) {
  return {
    F: 4,
    M: PDFString.of('D:20260927120000Z'),
    ...extra,
  };
}

describe('checkAnnotationConformance', () => {
  test('passes a conformant square and reports per-page counts', async () => {
    const { bytes } = await build(({ page, form, annot }) => {
      annot(
        good({
          Subtype: 'Square',
          Rect: [10, 10, 60, 60],
          P: page,
          NM: PDFString.of('sq-1'),
          AP: { N: form([10, 10, 60, 60]) },
        }),
      );
    });
    expect(await checkAnnotationConformance(bytes)).toEqual({
      ok: true,
      counts: [1],
      problems: [],
    });
  });

  test('flags each rule', async () => {
    const { bytes } = await build(({ page, form, annot }) => {
      // Reversed quad order (LL, LR, UL, UR), no /P, Normal blend, /CA without ExtGState.
      annot(
        good({
          Subtype: 'Highlight',
          Rect: [10, 10, 110, 30],
          NM: PDFString.of('hl-1'),
          CA: 0.5,
          QuadPoints: [10, 10, 110, 10, 10, 30, 110, 30],
          AP: { N: form([10, 10, 110, 30], { ExtGState: { G: { BM: 'Normal' } } }) },
        }),
      );
      // No appearance, no /NM, no Print flag, no /M.
      annot({ Subtype: 'Circle', Rect: [0, 0, 5, 5], P: page, F: 0 });
      // Appearance larger than /Rect after its /Matrix (scaled 2x).
      annot(
        good({
          Subtype: 'Square',
          Rect: [0, 0, 50, 50],
          P: page,
          NM: PDFString.of('sq-big'),
          AP: { N: form([0, 0, 50, 50], {}, [2, 0, 0, 2, 0, 0]) },
        }),
      );
      // Duplicate /NM and a quad outside /Rect.
      annot(
        good({
          Subtype: 'Underline',
          Rect: [10, 10, 50, 20],
          P: page,
          NM: PDFString.of('sq-big'),
          QuadPoints: [10, 40, 90, 40, 10, 30, 90, 30],
          AP: { N: form([10, 10, 50, 20]) },
        }),
      );
      // FreeText whose /DA font is not in the appearance resources.
      annot(
        good({
          Subtype: 'FreeText',
          Rect: [0, 100, 100, 130],
          P: page,
          NM: PDFString.of('ft-1'),
          DA: PDFString.of('0 g /Helv 12 Tf'),
          AP: { N: form([0, 100, 100, 130]) },
        }),
      );
    });
    const report = await checkAnnotationConformance(bytes);
    const rules = report.problems.map((p) => `${p.nm ?? p.subtype}:${p.rule}`);
    expect(rules).toEqual(
      expect.arrayContaining([
        'hl-1:quad-points',
        'hl-1:page',
        'hl-1:opacity',
        'hl-1:blend',
        'Circle:ap',
        'Circle:nm',
        'Circle:print',
        'Circle:modified',
        'sq-big:rect',
        'sq-big:quad-points',
        'sq-big:nm',
        'ft-1:font',
      ]),
    );
    expect(report.ok).toBe(false);
    expect(describeProblems(report.problems, 2)).toHaveLength(3);
  });

  test('checks popup links both ways and scopes to given ids', async () => {
    const { bytes } = await build(({ page, annot }) => {
      const popup = annot({ Subtype: 'Popup', Rect: [100, 100, 200, 200], P: page });
      annot({
        Subtype: 'Text',
        Rect: [10, 10, 30, 30],
        P: page,
        NM: PDFString.of('note-1'),
        Popup: popup,
      });
      // The popup's /Parent is missing: both directions are broken.
    });
    const all = await checkAnnotationConformance(bytes);
    expect(all.problems.filter((p) => p.rule === 'popup')).toHaveLength(2);
    // Scoped to another id: nothing is judged, everything is counted.
    const scoped = await checkAnnotationConformance(bytes, { ids: ['other'] });
    expect(scoped).toEqual({ ok: true, counts: [1], problems: [] });
  });

  test('finalizeAnnotations fixes what PDFium leaves out', async () => {
    const { bytes } = await build(({ form, annot }) => {
      annot({
        Subtype: 'Text',
        Rect: [10, 10, 30, 30],
        NM: PDFString.of('note-1'),
        Contents: PDFString.of('hello'),
        AP: { N: form([10, 10, 30, 30]) },
      });
      annot({
        Subtype: 'Stamp',
        Rect: [100, 100, 150, 150],
        NM: PDFString.of('stamp-1'),
        AP: { N: form([0, 0, 50, 50]) },
      });
    });
    const before = await checkAnnotationConformance(bytes);
    expect(before.ok).toBe(false);
    const fixed = await finalizeAnnotations(bytes, {
      touched: ['note-1', 'stamp-1'],
      noteOpen: { 'note-1': true },
      opacity: { 'stamp-1': 0.4 },
      includeComments: true,
      now: '2026-09-27T12:00:00Z',
    });
    expect(await checkAnnotationConformance(fixed)).toEqual({
      ok: true,
      counts: [2],
      problems: [],
    });
    const doc = await PDFDocument.load(fixed);
    const annots = doc.getPage(0).node.Annots();
    expect(annots?.size()).toBe(3);
    const stamp = doc.context.lookup(annots?.get(2)) as PDFDict;
    expect(String(stamp.get(PDFName.of('CA')))).toBe('0.4');
  });
  test('finalizeAnnotations gives a touched link without /C its appearance colour', async () => {
    const { bytes } = await build(({ doc, annot }) => {
      const underline = (rgb: string) =>
        doc.context.register(
          doc.context.stream(`q ${rgb} RG 2 w 0 1 m 120 1 l S Q`, {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 120, 20],
          }),
        );
      const link = (nm: string, ap: PDFRef | undefined, extra: Record<string, unknown> = {}) =>
        annot({
          Subtype: 'Link',
          Rect: [10, 10, 130, 30],
          NM: PDFString.of(nm),
          BS: { S: 'U', W: 2 },
          ...(ap ? { AP: { N: ap } } : {}),
          ...extra,
        });
      link('blue', underline('0 0 1'));
      link('red', underline('1 0 0'));
      link('none', undefined);
      link('kept', underline('0 0 1'), { C: [0, 0.5, 0] });
      link('untouched', underline('0 0 1'));
    });
    const fixed = await finalizeAnnotations(bytes, {
      touched: ['blue', 'red', 'none', 'kept'],
      noteOpen: {},
      opacity: {},
      includeComments: true,
      now: '2026-09-27T12:00:00Z',
    });
    const doc = await PDFDocument.load(fixed);
    const colors = (doc.getPage(0).node.Annots()?.asArray() ?? []).map((ref) => {
      const dict = doc.context.lookup(ref) as PDFDict;
      const c = dict.lookup(PDFName.of('C')) as PDFArray | undefined;
      return c?.asArray().map((n) => (n as PDFNumber).asNumber());
    });
    expect(colors).toEqual([[0, 0, 1], [1, 0, 0], [0, 0, 1], [0, 0.5, 0], undefined]);
  });
});
