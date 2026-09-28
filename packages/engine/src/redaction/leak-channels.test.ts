/**
 * Regression tests of the independent M4 engine review (redaction findings B1, M1, m1, m2),
 * derived from the reviewer's probes: channels a redacted string or an embedded file could
 * leave the file through, each either removed by the apply or stopping it (fail closed).
 *
 * - B1: embedded files outside /Names /EmbeddedFiles and /AF (GoToR/GoToE actions,
 *   /Collection, RichMedia assets, bare /Type /EmbeddedFile streams);
 * - M1: the redacted string drawn by other content streams, kerned, octal-escaped or as
 *   spaced hex (annotation appearances, Form XObjects on other pages, Type3 glyph
 *   procedures, tiling patterns);
 * - m1: a copy with a zero-width character inside (normalised page text);
 * - m2: Flate streams with a PNG predictor, and streams that cannot be decoded.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFStream,
  StandardFonts,
  type PDFFont,
} from '@cantoo/pdf-lib';
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import type { Rect } from '@pdf-editor/document-model';
import { deflateSync, zlibSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { forEachDict } from '../pdflib/metadata-walk';
import { createHostedEngine, type HostedEngine } from '../pdfium/host';
import type { ApplyRedactionsResult, ForensicReport, RedactionArea, RedactionPlan } from '../types';
import { applyRedactions, RedactionFailedError } from './apply';
import { normalizedShownText } from './content-text';
import { openScratch, withForensicDeps } from './engine-session';
import { forensicCheck } from './forensic';
import { decodeStream, embeddedFileStreams } from './pdf-util';
import { scrubRedactedDocument } from './scrub';

const TOKEN = 'SECRET-7731';
const NEEDLE = 'secret-7731';
const KERNED = '[(SECRET-)-10(7731)] TJ';

let host: HostedEngine;
beforeAll(async () => {
  host = await createHostedEngine({ wasm: wasmUrl });
});
afterAll(async () => {
  await host.engine.destroy?.().toPromise();
});

async function build(
  init: (doc: PDFDocument, font: PDFFont) => Promise<void> | void,
): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  await init(doc, font);
  return (await doc.save({ useObjectStreams: false })).slice().buffer;
}

/** A page with the marked line `Name: SECRET-7731 end`. */
function markedPage(doc: PDFDocument, font: PDFFont) {
  const page = doc.addPage([400, 300]);
  page.drawText(`Name: ${TOKEN} end`, { x: 40, y: 200, size: 14, font });
  return page;
}

/** A padded user-space area around the first search hit of `query`. */
async function areaOf(bytes: ArrayBuffer, query = TOKEN): Promise<RedactionArea> {
  const scratch = await openScratch(host, bytes);
  try {
    const hit = (await scratch.search(query))[0];
    if (!hit) throw new Error(`${query} not found`);
    const xs = hit.rects.flatMap((q) => [q.x, q.x + q.width]);
    const ys = hit.rects.flatMap((q) => [q.y, q.y + q.height]);
    const [x0, y0] = [Math.min(...xs) - 1, Math.min(...ys) - 1];
    const rect: Rect = {
      x: x0,
      y: y0,
      width: Math.max(...xs) + 1 - x0,
      height: Math.max(...ys) + 1 - y0,
    };
    return { pageIndex: hit.pageIndex, rect };
  } finally {
    await scratch.close();
  }
}

async function apply(
  bytes: ArrayBuffer,
  plan: Partial<RedactionPlan> = {},
): Promise<ApplyRedactionsResult> {
  return applyRedactions(host, bytes, { areas: [await areaOf(bytes)], strings: [], ...plan });
}

async function applyFailure(bytes: ArrayBuffer): Promise<RedactionFailedError> {
  const error = await apply(bytes).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RedactionFailedError);
  return error as RedactionFailedError;
}

const failing = (report: ForensicReport | undefined) =>
  report?.checks.filter((c) => !c.passed).map((c) => c.id) ?? [];
const findingsOf = (report: ForensicReport | undefined, id: string) =>
  report?.checks.find((c) => c.id === id)?.findings ?? [];

/** Every stream of `bytes` whose shown text (content lexer) contains the token. */
async function streamsShowingToken(bytes: ArrayBuffer): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out: string[] = [];
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue;
    const data = decodeStream(doc.context, object);
    if (data && normalizedShownText(data).some((t) => t.includes(NEEDLE))) out.push(ref.toString());
  }
  return out;
}

/** /EF dictionaries and embedded file streams left in `bytes`. */
async function embeddedLeft(bytes: ArrayBuffer): Promise<{ ef: number; streams: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let ef = 0;
  forEachDict(doc, ({ dict }) => {
    if (dict.has(PDFName.of('EF'))) ef++;
  });
  return { ef, streams: embeddedFileStreams(doc).length };
}

/** An embedded file stream (raw deflate body, as inside a .zip) and a filespec holding it. */
function embeddedSpec(doc: PDFDocument, name = 'payroll.zip') {
  const ctx = doc.context;
  const body = deflateSync(new TextEncoder().encode(`payroll for ${TOKEN}: 120000`));
  const ef = ctx.register(ctx.stream(body, { Type: 'EmbeddedFile', Subtype: 'application#2Fzip' }));
  return ctx.obj({ Type: 'Filespec', F: name, UF: name, EF: { F: ef } });
}

describe('B1: embedded files outside /EmbeddedFiles and /AF', () => {
  /** P2: a Link outside the area with a GoToR action whose filespec embeds the file. */
  const goToRLink = () =>
    build((doc, font) => {
      const page = markedPage(doc, font);
      const ctx = doc.context;
      const link = ctx.register(
        ctx.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [40, 40, 140, 60],
          Border: [0, 0, 0],
          A: { S: 'GoToR', F: embeddedSpec(doc), D: [0, 'Fit'] },
        }),
      );
      page.node.set(PDFName.of('Annots'), ctx.obj([link]));
    });

  test('a GoToR link embedding its target (P2): the file and the action go, the link stays', async () => {
    const result = await apply(await goToRLink());
    expect(result.forensic.ok).toBe(true);
    expect(await embeddedLeft(result.bytes)).toEqual({ ef: 0, streams: 0 });
    expect(result.redaction.attachments.removed).toBeGreaterThan(0);
    expect(result.forensic.unverifiedAttachments).toEqual([]);
    const doc = await PDFDocument.load(result.bytes);
    const annots = doc.getPages()[0]!.node.lookup(PDFName.of('Annots'), PDFArray);
    const link = annots.lookup(0, PDFDict);
    expect(link.get(PDFName.of('Subtype'))).toBe(PDFName.of('Link'));
    expect(link.has(PDFName.of('A'))).toBe(false); // a no-op link, like dropped script actions
  });

  test.each([
    [
      'a GoToE /OpenAction',
      (doc: PDFDocument) => {
        doc.catalog.set(
          PDFName.of('OpenAction'),
          doc.context.obj({ S: 'GoToE', T: { R: 'C', N: 'inner.pdf' }, D: [0, 'Fit'] }),
        );
        doc.catalog.set(
          PDFName.of('Names'),
          doc.context.obj({
            EmbeddedFiles: { Names: ['inner.pdf', embeddedSpec(doc, 'inner.pdf')] },
          }),
        );
      },
    ],
    [
      'a GoToR in a /Next chain of an outline-like action',
      (doc: PDFDocument) => {
        const action = doc.context.obj({
          S: 'URI',
          URI: 'https://example.org',
          Next: [doc.context.obj({ S: 'GoToR', F: embeddedSpec(doc), D: [0, 'Fit'] })],
        });
        doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(action));
      },
    ],
    [
      'a portfolio (/Collection) and a bare /Type /EmbeddedFile stream under a custom key',
      (doc: PDFDocument) => {
        const ctx = doc.context;
        doc.catalog.set(PDFName.of('Collection'), ctx.obj({ Type: 'Collection', View: 'D' }));
        const bare = ctx.register(
          ctx.stream(`bare ${TOKEN}`.split('').reverse().join(''), { Type: 'EmbeddedFile' }),
        );
        doc.catalog.set(PDFName.of('PrivateFile'), bare);
      },
    ],
    [
      'a RichMedia annotation with an asset',
      (doc: PDFDocument) => {
        const ctx = doc.context;
        const annot = ctx.register(
          ctx.obj({
            Type: 'Annot',
            Subtype: 'RichMedia',
            Rect: [200, 40, 300, 100],
            RichMediaContent: { Assets: { Names: ['movie.swf', embeddedSpec(doc, 'movie.swf')] } },
          }),
        );
        doc.getPages()[0]!.node.set(PDFName.of('Annots'), ctx.obj([annot]));
      },
    ],
  ])('%s: removed, and the check passes', async (_name, add) => {
    const bytes = await build((doc, font) => {
      markedPage(doc, font);
      add(doc);
    });
    const result = await apply(bytes);
    expect(result.forensic.ok).toBe(true);
    expect(await embeddedLeft(result.bytes)).toEqual({ ef: 0, streams: 0 });
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.catalog.has(PDFName.of('Collection'))).toBe(false);
    const open = doc.context.lookup(doc.catalog.get(PDFName.of('OpenAction')));
    if (open instanceof PDFDict) {
      expect(open.get(PDFName.of('S'))).toBe(PDFName.of('URI')); // only the GoToR went
      expect(open.has(PDFName.of('Next'))).toBe(false);
    }
    expect(result.redaction.attachments.removed).toBeGreaterThan(0);
  });

  test('keepAttachments: every embedded file stream is listed as unverified', async () => {
    const result = await apply(await goToRLink(), { keepAttachments: true });
    expect(result.forensic.ok).toBe(true);
    expect(await embeddedLeft(result.bytes)).toMatchObject({ streams: 1 });
    expect(result.forensic.unverifiedAttachments).toEqual([
      expect.stringMatching(/^payroll\.zip \(embedded file, object \d+\)$/),
    ]);
    expect(result.redaction.attachments.unverified).toEqual([
      expect.stringMatching(/^payroll\.zip \(embedded file, object \d+\)$/),
    ]);
  });

  test('the check fails when an embedded file is left although attachments were to go', async () => {
    const bytes = await goToRLink();
    const plan: RedactionPlan = { areas: [await areaOf(bytes)], strings: [] };
    // A broken scrub: attachments kept although the plan removes them.
    const { bytes: scrubbed } = await scrubRedactedDocument(bytes, plan, { skip: ['attachments'] });
    const report = await withForensicDeps(host, scrubbed, (deps) =>
      forensicCheck(scrubbed, plan, deps),
    );
    expect(failing(report)).toContain('object-strings');
    const found = findingsOf(report, 'object-strings').filter((f) => f.channel === 'embedded file');
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain('payroll.zip');
    expect(report.unverifiedAttachments).toEqual([
      expect.stringMatching(/^payroll\.zip \(embedded file/),
    ]);
  });
});

/** An appearance (Form XObject) drawing `ops` with Helvetica as /Helv. */
function stampOutsideArea(doc: PDFDocument, font: PDFFont, ops: string) {
  const ctx = doc.context;
  const ap = ctx.register(
    ctx.stream(ops, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 200, 30],
      Resources: { Font: { Helv: font.ref } },
    }),
  );
  const stamp = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [40, 40, 240, 70], F: 4, AP: { N: ap } }),
  );
  doc.getPages()[0]!.node.set(PDFName.of('Annots'), ctx.obj([stamp]));
}

describe('M1: the redacted string drawn by other content streams', () => {
  test.each([
    ['kerned TJ (P1)', `BT /Helv 14 Tf 5 8 Td ${KERNED} ET`],
    [
      'spaced hex and an octal escape (P1b)',
      'BT /Helv 14 Tf 5 8 Td <53 45 43 52 45 54 2D 37 37 33 31> Tj 0 12 Td (\\123ECRET-7731) Tj ET',
    ],
    ['one glyph at a time', "BT /Helv 14 Tf 5 8 Td (SECR) Tj 30 0 Td (ET-7) Tj (731) ' ET"],
  ])('a Stamp outside the area drawing the token, %s: the annotation goes', async (_name, ops) => {
    const bytes = await build((doc, font) => {
      markedPage(doc, font);
      stampOutsideArea(doc, font, ops);
    });
    const result = await apply(bytes);
    expect(result.forensic.ok).toBe(true);
    expect(result.redaction.annotationsRemoved).toBe(1);
    expect(await streamsShowingToken(result.bytes)).toEqual([]);
  });

  test('the check sees a kerned token in an appearance the scrub left (object-strings)', async () => {
    const bytes = await build((doc, font) => {
      markedPage(doc, font);
      stampOutsideArea(doc, font, `BT /Helv 14 Tf 5 8 Td ${KERNED} ET`);
    });
    const plan: RedactionPlan = { areas: [await areaOf(bytes)], strings: [TOKEN] };
    const { bytes: scrubbed } = await scrubRedactedDocument(bytes, plan, { skip: ['annotations'] });
    const report = await withForensicDeps(host, scrubbed, (deps) =>
      forensicCheck(scrubbed, plan, deps),
    );
    const shown = findingsOf(report, 'object-strings').filter((f) => f.channel === 'content text');
    expect(shown.map((f) => f.detail)).toContainEqual(expect.stringMatching(/redacted string 0$/));
  });

  /** Page 2 (not redacted) uses `resources` and draws `ops`. */
  const secondPage = (
    setup: (doc: PDFDocument, font: PDFFont) => { resources: object; ops: string },
  ) =>
    build((doc, font) => {
      const first = markedPage(doc, font);
      first.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
      const page = doc.addPage([400, 300]);
      const { resources, ops } = setup(doc, font);
      page.node.set(PDFName.of('Resources'), doc.context.obj(resources as never));
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(ops)));
    });

  test.each([
    [
      'an unused Form XObject on another page (P18b)',
      'form XObject',
      (doc: PDFDocument, font: PDFFont) => {
        const fm = doc.context.register(
          doc.context.stream(`BT /F1 14 Tf 10 10 Td ${KERNED} ET`, {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 400, 300],
            Resources: { Font: { F1: font.ref } },
          }),
        );
        return {
          resources: { Font: { F1: font.ref }, XObject: { Old: fm } },
          ops: 'BT /F1 14 Tf 40 200 Td (Page two) Tj ET',
        };
      },
    ],
    [
      'a Type3 glyph procedure drawing the token as text',
      'Type3 glyph procedure',
      (doc: PDFDocument, font: PDFFont) => {
        const ctx = doc.context;
        const proc = ctx.register(ctx.stream(`1000 0 d0 BT /F1 90 Tf 0 0 Td ${KERNED} ET`));
        const t3 = ctx.register(
          ctx.obj({
            Type: 'Font',
            Subtype: 'Type3',
            FontBBox: [0, 0, 1000, 1000],
            FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
            CharProcs: { a: proc },
            Encoding: { Type: 'Encoding', Differences: [97, PDFName.of('a')] },
            FirstChar: 97,
            LastChar: 97,
            Widths: [1000],
            Resources: { Font: { F1: font.ref } },
          } as never),
        );
        return { resources: { Font: { T3: t3 } }, ops: 'BT /T3 12 Tf 40 100 Td (a) Tj ET' };
      },
    ],
    [
      'a tiling pattern drawing the token',
      'tiling pattern',
      (doc: PDFDocument, font: PDFFont) => {
        const pattern = doc.context.register(
          doc.context.stream(`BT /F1 12 Tf 2 4 Td ${KERNED} ET`, {
            Type: 'Pattern',
            PatternType: 1,
            PaintType: 1,
            TilingType: 1,
            BBox: [0, 0, 200, 20],
            XStep: 200,
            YStep: 20,
            Resources: { Font: { F1: font.ref } },
          }),
        );
        return {
          resources: { Pattern: { P1: pattern } },
          ops: '/Pattern cs /P1 scn 0 0 400 300 re f',
        };
      },
    ],
  ])('%s: the apply fails closed (object-strings)', async (_name, kind, setup) => {
    const failed = await applyFailure(await secondPage(setup));
    expect(failed.stage).toBe('forensic');
    expect(failing(failed.failure.forensic)).toContain('object-strings');
    const shown = findingsOf(failed.failure.forensic, 'object-strings').filter(
      (f) => f.channel === 'content text',
    );
    expect(shown.map((f) => f.detail)).toEqual([`${kind}: redacted string 0`]);
    expect(failed.failure.redaction?.warnings).toContainEqual(
      expect.stringContaining(`(${kind}) still shows a redacted string`),
    );
  });
});

describe('m1: a copy with a zero-width character inside', () => {
  test('the normalised page text finds it (P20): the apply fails closed', async () => {
    // Helvetica with code 0x81 mapped to U+200B by /ToUnicode: "SECRET-77<ZWSP>31".
    const bytes = await build((doc) => {
      const ctx = doc.context;
      const toUnicode = [
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
        '/CMapName /Adobe-Identity-UCS def /CMapType 2 def',
        '1 begincodespacerange <00> <FF> endcodespacerange',
        '1 beginbfchar <81> <200B> endbfchar',
        'endcmap CMapName currentdict /CMap defineresource pop end end',
      ].join('\n');
      const f1 = ctx.register(
        ctx.obj({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Helvetica',
          Encoding: {
            Type: 'Encoding',
            BaseEncoding: 'WinAnsiEncoding',
            Differences: [129, PDFName.of('.notdef')],
          },
          ToUnicode: ctx.register(ctx.stream(toUnicode)),
        } as never),
      );
      const page = doc.addPage([400, 300]);
      page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: f1 } }));
      const ops = `BT /F1 14 Tf 40 200 Td (Top: ${TOKEN}) Tj ET\nBT /F1 14 Tf 40 100 Td (Copy: SECRET-77\\20131) Tj ET`;
      page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(ops)));
    });
    const failed = await applyFailure(bytes);
    expect(failed.stage).toBe('forensic');
    const found = findingsOf(failed.failure.forensic, 'no-search-hits');
    expect(found).toContainEqual(expect.objectContaining({ channel: 'page text', pageIndex: 0 }));
  });
});

describe('m2: predictors and streams that cannot be decoded', () => {
  test('a Flate stream with a PNG predictor holding the token (P16): the apply fails closed', async () => {
    const cols = 4;
    const payload = new TextEncoder().encode(`notes: ${TOKEN} (keep private)`.padEnd(40, ' '));
    const rows: number[] = [];
    for (let i = 0; i < payload.length; i += cols) rows.push(0, ...payload.slice(i, i + cols));
    const bytes = await build((doc, font) => {
      markedPage(doc, font);
      const s = doc.context.register(
        doc.context.stream(zlibSync(Uint8Array.from(rows)), {
          Filter: 'FlateDecode',
          DecodeParms: { Predictor: 12, Columns: cols },
        }),
      );
      doc.catalog.set(PDFName.of('PrivateNotes'), s);
    });
    const failed = await applyFailure(bytes);
    expect(failing(failed.failure.forensic)).toEqual(['object-strings', 'byte-grep']);
  });

  test('a stream that cannot be decoded is listed in notSearched with the reason', async () => {
    const bytes = await build((doc, font) => {
      markedPage(doc, font);
      const ctx = doc.context;
      const junk = PDFRawStream.of(ctx.obj({ Filter: 'JBIG2Decode' }), new Uint8Array([1, 2, 3]));
      const badPredictor = ctx.flateStream(new Uint8Array([7, 7, 7]), {
        DecodeParms: { Predictor: 12, Colors: 99 },
      });
      doc.catalog.set(PDFName.of('Junk'), ctx.register(junk));
      doc.catalog.set(PDFName.of('BadPredictor'), ctx.register(badPredictor));
    });
    const result = await apply(bytes);
    expect(result.forensic.ok).toBe(true);
    expect(result.forensic.notSearched).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^object \d+ \(JBIG2Decode not decodable here\)$/),
        expect.stringMatching(/^object \d+ \(FlateDecode: predictor 12 with Colors 99/),
      ]),
    );
  });
});
