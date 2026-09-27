/**
 * Milestone M4 fixtures (docs/specs/redaction-and-text-editing.md §1.3, §2.4):
 * redaction targets (text runs, Form XObjects, images, annotations, metadata,
 * incremental history) and text-editing targets (font kinds, rotated pages).
 *
 * Content streams are written by hand (uncompressed unless noted) so every
 * glyph position is known exactly; each builder records its targets in
 * `expect.regions` and, for the redaction fixtures, asserts through
 * lib/scan.ts that the token `SECRET-7731` sits exactly where documented.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  type PDFDict,
  type PDFDocument,
  PDFDocument as PDFDocumentClass,
  type PDFFont,
  PDFHexString,
  type PDFPage,
  type PDFRef,
  PDFString,
  StandardFonts,
  degrees,
} from '@cantoo/pdf-lib';
import {
  type Built,
  type FixtureDef,
  LETTER,
  box,
  latin1,
  name,
  newDoc,
  round2,
  save,
  setRawContent,
  str,
} from './lib/build.ts';
import {
  type Box,
  CREATOR,
  FIXED_DATE,
  FIXED_DATE_XMP,
  type FontExpectation,
  type ManifestEntry,
  PRODUCER,
  REPO_ROOT,
  type RegionExpectation,
  type SecretExpectation,
  fileIdFor,
} from './lib/common.ts';
import { findToken } from './lib/scan.ts';
import { withCmap } from './lib/ttf.ts';

export const TOKEN = 'SECRET-7731';
export const FOX = 'The quick brown fox jumps over the lazy dog';

/** Helvetica AFM Ascender / Descender, per unit of font size. */
const HELV = { ascent: 0.718, descent: 0.207 };
const LETTER_BOX = box(0, 0, 612, 792);
const FONT_DIR = join(REPO_ROOT, 'packages', 'engine', 'assets', 'fonts');

type Fontkit = Parameters<PDFDocument['registerFontkit']>[0];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Number as written into content streams (at most 2 decimals). */
function f(n: number): string {
  return String(round2(n));
}

/** PDF literal string. */
function lit(value: string): string {
  return `(${value.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

function bt(font: string, size: number, x: number, y: number, body: string): string {
  return `BT /${font} ${size} Tf ${f(x)} ${f(y)} Td ${body} ET`;
}

/** Horizontal text box: advance width by descender..ascender. */
function textBox(x: number, baseline: number, width: number, size: number, m = HELV): Box {
  return box(x, baseline - m.descent * size, width, (m.ascent + m.descent) * size);
}

/**
 * Suggested area for a horizontal text box: 1 pt wider on each side, 0.1 em
 * lower and 0.25 em higher (PDFium's loose glyph boxes reach about 0.93 em
 * above the baseline for Helvetica, beyond the 0.718 em ascender).
 */
function textArea(b: Box, size: number): Box {
  return box(b[0] - 1, b[1] - 0.1 * size, b[2] + 2, b[3] + 0.35 * size);
}

interface StandardEmbedder {
  encodeTextAsGlyphs(text: string): { name: string }[];
  widthOfGlyph(glyphName: string): number;
}

/**
 * Helvetica with an advance-width function that matches what Tj draws.
 * pdf-lib's own widthOfTextAtSize adds AFM kerning pairs, which Tj never
 * applies (e.g. 1.4 pt too narrow for "Line 1, one Tj: " at 14 pt).
 */
function helvetica(doc: PDFDocument): { font: PDFFont; w: (s: string, size?: number) => number } {
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const embedder = (font as unknown as { embedder: StandardEmbedder }).embedder;
  const w = (s: string, size = 14) =>
    (embedder.encodeTextAsGlyphs(s).reduce((n, g) => n + embedder.widthOfGlyph(g.name), 0) * size) /
    1000;
  return { font, w };
}

const HELVETICA_FONT: FontExpectation = {
  resource: 'F1',
  subtype: 'Type1',
  baseFont: 'Helvetica',
  encoding: 'WinAnsiEncoding',
  embedded: false,
  subset: false,
  toUnicode: false,
};

function tokenRegion(
  id: string,
  x: number,
  baseline: number,
  width: number,
  note: string,
  extra: Partial<RegionExpectation> = {},
): RegionExpectation {
  const b = textBox(x, baseline, width, 14);
  return {
    id,
    page: 1,
    kind: 'text',
    text: TOKEN,
    fontSize: 14,
    baseline,
    box: b,
    area: textArea(b, 14),
    extractable: true,
    note,
    ...extra,
  };
}

function textRegion(
  id: string,
  value: string,
  x: number,
  baseline: number,
  width: number,
  size: number,
  note: string,
  extra: Partial<RegionExpectation> = {},
): RegionExpectation {
  const b = textBox(x, baseline, width, size);
  return {
    id,
    page: 1,
    kind: 'text',
    text: value,
    fontSize: size,
    baseline,
    box: b,
    area: textArea(b, size),
    extractable: true,
    note,
    ...extra,
  };
}

/**
 * Re-opens the saved bytes and asserts that the token occurs in exactly the
 * documented objects (and, or not, in the raw bytes). Throws otherwise, so a
 * builder change that leaks the token somewhere else fails generation.
 */
async function secretFor(
  file: string,
  bytes: Uint8Array,
  locations: string[],
  extracted: SecretExpectation['extracted'],
  inRawBytes: boolean,
): Promise<SecretExpectation> {
  const doc = await PDFDocumentClass.load(bytes, { updateMetadata: false });
  const found = findToken(doc, TOKEN);
  const expected = [...locations].sort();
  if (JSON.stringify(found) !== JSON.stringify(expected)) {
    throw new Error(
      `${file}: token locations ${JSON.stringify(found)}, documented ${JSON.stringify(expected)}`,
    );
  }
  const raw = latin1(bytes).includes(TOKEN);
  if (raw !== inRawBytes) throw new Error(`${file}: token in raw bytes is ${raw}`);
  return { token: TOKEN, locations: expected, extracted, inRawBytes };
}

function pageExpect(
  markers: string[],
  rotate = 0,
): {
  page: number;
  mediaBox: Box;
  rotate: number;
  markers: string[];
} {
  return { page: 1, mediaBox: LETTER_BOX, rotate, markers };
}

// ---------------------------------------------------------------------------
// redact-text-runs
// ---------------------------------------------------------------------------

async function buildTextRuns(): Promise<Built> {
  const file = 'redact-text-runs.pdf';
  const doc = await newDoc('Redaction fixture: text runs');
  const { font, w } = helvetica(doc);
  const page = doc.addPage(LETTER);
  page.node.set(name('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
  const marker = 'PAGE 1 OF redact-text-runs';

  const l1Prefix = 'Line 1, one Tj: ';
  const l1 = `${l1Prefix}${TOKEN} stays`;

  const l2Prefix = 'Line 2, two TJ: ';
  const [k1, k2] = [20, -40]; // TJ adjustments inside the token, thousandths of an em
  const l2 = `[${lit(`${l2Prefix}SE`)} ${k1} ${lit('CR')}] TJ [${lit('ET-')} ${k2} ${lit('7731 stays')}] TJ`;

  const l3Prefix = 'Line 3, two BT: ';
  const l3First = `${l3Prefix}SECRET-`;
  const l3SecondX = round2(72 + w(l3First));

  setRawContent(
    doc,
    page,
    [
      bt('F1', 10, 72, 740, `${lit(marker)} Tj`),
      bt('F1', 14, 72, 680, `${lit(l1)} Tj`),
      bt('F1', 14, 72, 640, l2),
      bt('F1', 14, 72, 600, `${lit(l3First)} Tj`),
      bt('F1', 14, l3SecondX, 600, `${lit('7731 stays')} Tj`),
      bt('F1', 14, 72, 560, `${lit(FOX)} Tj`),
    ].join('\n'),
  );

  const l3x = 72 + w(l3Prefix);
  const regions: RegionExpectation[] = [
    tokenRegion(
      'tj-single',
      72 + w(l1Prefix),
      680,
      w(TOKEN),
      `Inside one Tj string "${l1}" (page content stream).`,
    ),
    tokenRegion(
      'tj-split',
      72 + w(l2Prefix),
      640,
      w(TOKEN) - ((k1 + k2) * 14) / 1000,
      `One text object, two TJ arrays: [(${l2Prefix}SE) ${k1} (CR)] TJ [(ET-) ${k2} (7731 stays)] TJ; the adjustments sit inside the token and are included in the width.`,
    ),
    tokenRegion(
      'bt-split',
      l3x,
      600,
      l3SecondX - l3x + w('7731'),
      `Two text objects on one baseline: "${l3First}" at x 72 and "7731 stays" at x ${l3SecondX}.`,
    ),
    textRegion('innocuous', FOX, 72, 560, w(FOX), 14, 'Innocuous line, one Tj; must survive.'),
  ];

  const bytes = await save(doc, file);
  return {
    bytes,
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 1,
      pages: [pageExpect([marker, l1, FOX])],
      info: { Title: 'Redaction fixture: text runs' },
      regions,
      secret: await secretFor(
        file,
        bytes,
        ['Root/Pages/Kids[0]/Contents (stream)'],
        [{ page: 1, count: 3 }],
        true,
      ),
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// redact-form-xobject
// ---------------------------------------------------------------------------

async function buildFormXObject(): Promise<Built> {
  const file = 'redact-form-xobject.pdf';
  const doc = await newDoc('Redaction fixture: Form XObjects');
  const ctx = doc.context;
  const { font, w } = helvetica(doc);
  const page = doc.addPage(LETTER);
  const marker = 'PAGE 1 OF redact-form-xobject';
  const outerPrefix = 'Outer form: ';
  const nestedPrefix = 'Nested form: ';
  const form = (content: string, bbox: number[], xobjects?: Record<string, PDFRef>) =>
    ctx.register(
      ctx.stream(content, {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: bbox,
        Resources: { Font: { F1: font.ref }, ...(xobjects ? { XObject: xobjects } : {}) },
      }),
    );
  const fm2 = form(
    bt('F1', 14, 0, 20, `${lit(`${nestedPrefix}${TOKEN} stays`)} Tj`),
    [0, 0, 468, 40],
  );
  const fm1 = form(
    [
      bt('F1', 14, 0, 70, `${lit(`${outerPrefix}${TOKEN} stays`)} Tj`),
      'q 1 0 0 1 0 10 cm /Fm2 Do Q',
    ].join('\n'),
    [0, 0, 468, 100],
    { Fm2: fm2 },
  );
  page.node.set(name('Resources'), ctx.obj({ Font: { F1: font.ref }, XObject: { Fm1: fm1 } }));
  setRawContent(
    doc,
    page,
    [
      bt('F1', 10, 72, 740, `${lit(marker)} Tj`),
      'q 1 0 0 1 72 640 cm /Fm1 Do Q',
      bt('F1', 14, 72, 600, `${lit(FOX)} Tj`),
    ].join('\n'),
  );

  const regions = [
    tokenRegion(
      'form-outer',
      72 + w(outerPrefix),
      710,
      w(TOKEN),
      'Form XObject /Fm1 (page: q 1 0 0 1 72 640 cm /Fm1 Do Q; BBox [0 0 468 100]); in form space the line "Outer form: SECRET-7731 stays" starts at (0, 70).',
      { xobject: 'Fm1' },
    ),
    tokenRegion(
      'form-nested',
      72 + w(nestedPrefix),
      670,
      w(TOKEN),
      'Form XObject /Fm2 painted by /Fm1 (q 1 0 0 1 0 10 cm /Fm2 Do Q; BBox [0 0 468 40]); in Fm2 space "Nested form: SECRET-7731 stays" starts at (0, 20).',
      { xobject: 'Fm1/Fm2' },
    ),
    textRegion('innocuous', FOX, 72, 600, w(FOX), 14, 'Directly in the page content stream.'),
  ];

  const bytes = await save(doc, file);
  return {
    bytes,
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 1,
      pages: [pageExpect([marker, FOX])],
      info: { Title: 'Redaction fixture: Form XObjects' },
      regions,
      secret: await secretFor(
        file,
        bytes,
        [
          'Root/Pages/Kids[0]/Resources/XObject/Fm1 (stream)',
          'Root/Pages/Kids[0]/Resources/XObject/Fm1/Resources/XObject/Fm2 (stream)',
        ],
        [{ page: 1, count: 2 }],
        true,
      ),
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// redact-images
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

/** RGB pixels, row 0 at the top (PDF image space). */
function pixels(size: number, colourAt: (x: number, y: number) => Rgb): Uint8Array {
  const px = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) px.set(colourAt(x, y), (y * size + x) * 3);
  }
  return px;
}

const quadrants =
  (size: number, [tl, tr, bl, br]: [Rgb, Rgb, Rgb, Rgb]) =>
  (x: number, y: number): Rgb =>
    y < size / 2 ? (x < size / 2 ? tl : tr) : x < size / 2 ? bl : br;

async function buildImages(): Promise<Built> {
  const file = 'redact-images.pdf';
  const doc = await newDoc('Redaction fixture: images');
  const ctx = doc.context;
  const { font } = helvetica(doc);
  const page = doc.addPage(LETTER);
  const marker = 'PAGE 1 OF redact-images';
  const image = (px: Uint8Array) =>
    ctx.register(
      ctx.flateStream(px, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 64,
        Height: 64,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
      }),
    );
  const red: Rgb = [230, 40, 40];
  const green: Rgb = [40, 180, 60];
  const blue: Rgb = [40, 70, 220];
  const yellow: Rgb = [240, 210, 40];
  const im1 = image(pixels(64, quadrants(64, [red, green, blue, yellow])));
  const bands: Rgb[] = [
    [240, 140, 20],
    [130, 50, 170],
    [20, 150, 150],
    [120, 120, 120],
  ];
  const im2 = image(pixels(64, (_x, y) => bands[Math.floor(y / 16)] ?? [0, 0, 0]));
  const stripes: Rgb[] = [
    [20, 20, 20],
    [250, 250, 250],
    [200, 30, 90],
    [30, 90, 200],
  ];
  const im3 = image(pixels(64, (x) => stripes[Math.floor(x / 16)] ?? [0, 0, 0]));
  page.node.set(
    name('Resources'),
    ctx.obj({ Font: { F1: font.ref }, XObject: { Im1: im1, Im2: im2, Im3: im3 } }),
  );

  // Inline image: 8x8 RGB, no filter. Component levels avoid PDF whitespace
  // and the letters E/I, so no reader can mistake image data for "EI".
  const lo = 0x30;
  const hi = 0xf0;
  const mid = 0xc0;
  const inline = pixels(
    8,
    quadrants(8, [
      [hi, lo, lo],
      [lo, mid, lo],
      [lo, lo, hi],
      [hi, hi, lo],
    ]),
  );
  const labels: [string, number, number][] = [
    ['Im1: left half in area', 72, 540],
    ['Im2: fully in area', 240, 540],
    ['Im3: untouched', 408, 540],
    ['Inline image, fully in area', 160, 428],
  ];
  const before = [
    bt('F1', 10, 72, 740, `${lit(marker)} Tj`),
    'q 128 0 0 128 72 560 cm /Im1 Do Q',
    'q 128 0 0 128 240 560 cm /Im2 Do Q',
    'q 128 0 0 128 408 560 cm /Im3 Do Q',
    ...labels.map(([label, x, y]) => bt('F1', 10, x, y, `${lit(label)} Tj`)),
    bt('F1', 14, 72, 300, `${lit(FOX)} Tj`),
    'q 64 0 0 64 72 400 cm',
    'BI /W 8 /H 8 /BPC 8 /CS /RGB ID ',
  ].join('\n');
  const after = '\nEI\nQ\n';
  const content = new Uint8Array([
    ...Buffer.from(before, 'latin1'),
    ...inline,
    ...Buffer.from(after, 'latin1'),
  ]);
  page.node.set(name('Contents'), ctx.register(ctx.stream(content)));

  const regions: RegionExpectation[] = [
    {
      id: 'image-partial',
      page: 1,
      kind: 'image',
      xobject: 'Im1',
      box: box(72, 560, 128, 128),
      area: box(66, 552, 70, 144),
      note: '64x64 DeviceRGB (FlateDecode), 2 pt per pixel; quadrants red (top-left), green (top-right), blue (bottom-left), yellow (bottom-right). The area spans x 66-136: image columns 0-31 (the red and blue quadrants) are covered, columns 32-63 must keep their pixels.',
    },
    {
      id: 'image-full',
      page: 1,
      kind: 'image',
      xobject: 'Im2',
      box: box(240, 560, 128, 128),
      area: box(234, 552, 140, 144),
      note: '64x64 DeviceRGB (FlateDecode), four horizontal bands; fully covered, so the image can be removed.',
    },
    {
      id: 'image-untouched',
      page: 1,
      kind: 'image',
      xobject: 'Im3',
      box: box(408, 560, 128, 128),
      note: '64x64 DeviceRGB (FlateDecode), four vertical stripes; outside every area, must stay byte-identical.',
    },
    {
      id: 'inline-image',
      page: 1,
      kind: 'inline-image',
      box: box(72, 400, 64, 64),
      area: box(66, 394, 76, 76),
      note: 'BI /W 8 /H 8 /BPC 8 /CS /RGB ID <192 raw bytes> EI in the page content stream (no filter), under q 64 0 0 64 72 400 cm; quadrant colours as Im1.',
    },
  ];

  const bytes = await save(doc, file);
  return {
    bytes,
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 1,
      pages: [pageExpect([marker, FOX])],
      info: { Title: 'Redaction fixture: images' },
      images: [1, 2, 3].map(() => ({
        page: 1,
        filter: 'FlateDecode',
        width: 64,
        height: 64,
        smask: false,
      })),
      regions,
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// redact-annotations
// ---------------------------------------------------------------------------

async function buildAnnotations(): Promise<Built> {
  const file = 'redact-annotations.pdf';
  const doc = await newDoc('Redaction fixture: annotations');
  const ctx = doc.context;
  const { font, w } = helvetica(doc);
  const page = doc.addPage(LETTER);
  page.node.set(name('Resources'), ctx.obj({ Font: { F1: font.ref } }));
  const marker = 'PAGE 1 OF redact-annotations';
  const prefix = 'Annotated: ';
  const line = `${prefix}${TOKEN} stays`;
  const survivorLine = 'Survivor note to the left of this line';
  setRawContent(
    doc,
    page,
    [
      bt('F1', 10, 72, 740, `${lit(marker)} Tj`),
      bt('F1', 14, 72, 680, `${lit(line)} Tj`),
      bt('F1', 14, 72, 600, `${lit(FOX)} Tj`),
      bt('F1', 12, 100, 400, `${lit(survivorLine)} Tj`),
    ].join('\n'),
  );

  const x0 = round2(72 + w(prefix));
  const x1 = round2(x0 + w(TOKEN));
  const tokenArea = textArea(textBox(x0, 680, w(TOKEN), 14), 14);
  const date = PDFString.fromDate(FIXED_DATE);
  const common = (nm: string, extra: Record<string, unknown>) =>
    ctx.obj({
      Type: 'Annot',
      P: page.ref,
      NM: str(nm),
      M: date,
      F: 4,
      ...(extra as Record<string, never>),
    });
  const form = (bbox: number[], content: string, resources?: PDFDict) =>
    ctx.register(
      ctx.stream(content, {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: bbox,
        ...(resources ? { Resources: resources } : {}),
      }),
    );
  const noteAp = form(
    [0, 0, 20, 20],
    '1 0.85 0 rg 0 0 0 RG 0.5 w 0.25 0.25 19.5 19.5 re B 4 14 m 16 14 l 4 10 m 16 10 l 4 6 m 12 6 l S',
  );

  const link = ctx.register(
    common('redact-annot-link', {
      Subtype: 'Link',
      Rect: [x0, 676, x1, 692],
      Border: [0, 0, 0],
      H: 'I',
      A: { S: 'URI', URI: str('https://example.com/redact-annotations') },
    }),
  );
  const noteRef = ctx.nextRef();
  const popupRef = ctx.nextRef();
  const noteRect = [round2(x1 - 6), 684, round2(x1 + 14), 704];
  ctx.assign(
    noteRef,
    common('redact-annot-note', {
      Subtype: 'Text',
      Rect: noteRect,
      Name: 'Comment',
      Open: false,
      C: [1, 0.85, 0],
      F: 28,
      T: str('Fixture Author'),
      CreationDate: date,
      Contents: str(`${TOKEN} in a note`),
      Popup: popupRef,
      AP: { N: noteAp },
    }),
  );
  ctx.assign(
    popupRef,
    common('redact-annot-popup', {
      Subtype: 'Popup',
      Rect: [320, 560, 520, 640],
      Parent: noteRef,
      Open: false,
      F: 28,
    }),
  );
  const quad = [x0, 695, x1, 695, x0, 675, x1, 675];
  const highlight = ctx.register(
    common('redact-annot-highlight', {
      Subtype: 'Highlight',
      Rect: [x0, 675, x1, 695],
      QuadPoints: quad,
      C: [1, 0.92, 0.23],
      T: str('Fixture Author'),
      CreationDate: date,
      Contents: str('Highlight over the token'),
      AP: {
        N: form(
          [x0, 675, x1, 695],
          `/GS0 gs 1 0.92 0.23 rg ${x0} 675 ${round2(x1 - x0)} 20 re f`,
          ctx.obj({ ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 } } }),
        ),
      },
    }),
  );
  const sq = { x: round2(x0 - 24), y: 668, w: 60, h: 32 };
  const square = ctx.register(
    common('redact-annot-square', {
      Subtype: 'Square',
      Rect: [sq.x, sq.y, round2(sq.x + sq.w), sq.y + sq.h],
      BS: { Type: 'Border', W: 2, S: 'S' },
      C: [0, 0, 1],
      T: str('Fixture Author'),
      CreationDate: date,
      Contents: str('Square over the start of the token'),
      AP: { N: form([0, 0, sq.w, sq.h], `0 0 1 RG 2 w 1 1 ${sq.w - 2} ${sq.h - 2} re S`) },
    }),
  );
  const survivor = ctx.register(
    common('redact-annot-survivor', {
      Subtype: 'Text',
      Rect: [72, 394, 92, 414],
      Name: 'Comment',
      Open: false,
      C: [1, 0.85, 0],
      F: 28,
      T: str('Fixture Author'),
      CreationDate: date,
      Contents: str('Survivor note outside the area'),
      AP: { N: noteAp },
    }),
  );
  page.node.set(name('Annots'), ctx.obj([link, noteRef, popupRef, highlight, square, survivor]));

  const regions: RegionExpectation[] = [
    tokenRegion(
      'token',
      x0,
      680,
      w(TOKEN),
      `In the page content ("${line}"). Overlapping the area: Link [${x0} 676 ${x1} 692] (URI), Text note [${noteRect.join(' ')}] whose Popup [320 560 520 640] lies outside the area, Highlight (QuadPoints [${quad.join(' ')}]), Square [${sq.x} ${sq.y} ${round2(sq.x + sq.w)} ${sq.y + sq.h}].`,
      { area: tokenArea },
    ),
    {
      id: 'survivor-note',
      page: 1,
      kind: 'annotations',
      box: box(72, 394, 20, 20),
      note: 'Text note "Survivor note outside the area" (no popup), outside every area: must survive.',
    },
  ];

  const bytes = await save(doc, file);
  const annot = (nm: string, subtype: string, flags: number, extra: object = {}) => ({
    page: 1,
    subtype,
    nm,
    hasAppearance: subtype !== 'Link' && subtype !== 'Popup',
    flags,
    ...extra,
  });
  return {
    bytes,
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 1,
      pages: [pageExpect([marker, line, FOX, survivorLine])],
      info: { Title: 'Redaction fixture: annotations' },
      links: [{ page: 1, kind: 'uri', uri: 'https://example.com/redact-annotations' }],
      annotations: [
        annot('redact-annot-link', 'Link', 4),
        annot('redact-annot-note', 'Text', 28),
        annot('redact-annot-popup', 'Popup', 28, { popupOf: 'redact-annot-note' }),
        annot('redact-annot-highlight', 'Highlight', 4, {
          quadPoints: quad,
          blendMode: 'Multiply',
        }),
        annot('redact-annot-square', 'Square', 4),
        annot('redact-annot-survivor', 'Text', 28),
      ],
      regions,
      secret: await secretFor(
        file,
        bytes,
        ['Root/Pages/Kids[0]/Contents (stream)', 'Root/Pages/Kids[0]/Annots[1]/Contents'],
        [{ page: 1, count: 1 }],
        true,
      ),
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// redact-metadata
// ---------------------------------------------------------------------------

const BOM = String.fromCharCode(0xfeff);

function xmp(title: string, author: string, description: string): string {
  const padding = `${' '.repeat(99)}\n`.repeat(20);
  return `<?xpacket begin="${BOM}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
        xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <dc:format>application/pdf</dc:format>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>${author}</rdf:li></rdf:Seq></dc:creator>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${description}</rdf:li></rdf:Alt></dc:description>
      <pdf:Producer>${PRODUCER}</pdf:Producer>
      <xmp:CreatorTool>${CREATOR}</xmp:CreatorTool>
      <xmp:CreateDate>${FIXED_DATE_XMP}</xmp:CreateDate>
      <xmp:ModifyDate>${FIXED_DATE_XMP}</xmp:ModifyDate>
      <xmp:MetadataDate>${FIXED_DATE_XMP}</xmp:MetadataDate>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
${padding}<?xpacket end="w"?>`;
}

/** 34x44 thumbnail of the page: near-white, with a dark bar per text line. */
function thumbnail(lines: { y: number; x: number; width: number }[]): Uint8Array {
  const [tw, th] = [34, 44];
  const px = new Uint8Array(tw * th * 3).fill(250);
  for (const line of lines) {
    const row = Math.round(((792 - line.y) / 792) * th);
    const from = Math.round((line.x / 612) * tw);
    const to = Math.round(((line.x + line.width) / 612) * tw);
    for (const r of [row - 1, row]) {
      for (let c = from; c < to; c++) px.set([40, 40, 40], (r * tw + c) * 3);
    }
  }
  return px;
}

async function buildMetadata(): Promise<Built> {
  const file = 'redact-metadata.pdf';
  const title = `Metadata scrub fixture: ${TOKEN}`;
  const subject = `Subject line naming ${TOKEN}`;
  const author = 'Jane Q. Fixture';
  const actualText = `Tagged paragraph: ${TOKEN} stays`;
  const alt = `Alternate description mentioning ${TOKEN}`;
  const outlineTitle = `Findings on ${TOKEN}`;
  const destName = `${TOKEN}-dest`;
  const attachment = `Attachment body: ${TOKEN} appears in this embedded file.\n`;

  const doc = await newDoc(title);
  doc.setSubject(subject);
  doc.setAuthor(author);
  doc.setLanguage('en-US');
  const ctx = doc.context;
  const { font, w } = helvetica(doc);
  const page = doc.addPage(LETTER);
  const marker = 'PAGE 1 OF redact-metadata';
  const paragraph = actualText;
  page.node.set(name('Resources'), ctx.obj({ Font: { F1: font.ref } }));
  page.node.set(name('StructParents'), ctx.obj(0));
  setRawContent(
    doc,
    page,
    [
      '/Artifact <</Type /Pagination /Subtype /Header>> BDC',
      bt('F1', 10, 72, 740, `${lit(marker)} Tj`),
      'EMC',
      '/P <</MCID 0>> BDC',
      bt('F1', 14, 72, 680, `${lit(paragraph)} Tj`),
      'EMC',
      '/Artifact BMC',
      bt('F1', 14, 72, 640, `${lit(FOX)} Tj`),
      'EMC',
    ].join('\n'),
  );

  // Page thumbnail: pixels only (the token's line is a dark bar).
  const thumb = thumbnail([
    { y: 740, x: 72, width: w(marker, 10) },
    { y: 680, x: 72, width: w(paragraph) },
    { y: 640, x: 72, width: w(FOX) },
  ]);
  page.node.set(
    name('Thumb'),
    ctx.register(
      ctx.flateStream(thumb, {
        Width: 34,
        Height: 44,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
      }),
    ),
  );

  // Structure tree: StructTreeRoot -> Document -> P (MCID 0) with /ActualText and /Alt.
  doc.catalog.set(name('MarkInfo'), ctx.obj({ Marked: true }));
  const rootRef = ctx.nextRef();
  const documentRef = ctx.nextRef();
  const pRef = ctx.register(
    ctx.obj({
      Type: 'StructElem',
      S: 'P',
      P: documentRef,
      Pg: page.ref,
      K: 0,
      ActualText: str(actualText),
      Alt: str(alt),
    }),
  );
  ctx.assign(documentRef, ctx.obj({ Type: 'StructElem', S: 'Document', P: rootRef, K: pRef }));
  ctx.assign(
    rootRef,
    ctx.obj({
      Type: 'StructTreeRoot',
      K: documentRef,
      ParentTree: ctx.register(ctx.obj({ Nums: [0, [pRef]] })),
      ParentTreeNextKey: 1,
    }),
  );
  doc.catalog.set(name('StructTreeRoot'), rootRef);

  // Outline: an innocuous item and one whose title carries the token.
  const outlinesRef = ctx.nextRef();
  const introRef = ctx.nextRef();
  const findingsRef = ctx.nextRef();
  ctx.assign(
    introRef,
    ctx.obj({
      Title: str('Introduction'),
      Parent: outlinesRef,
      Next: findingsRef,
      Dest: [page.ref, 'XYZ', 72, 760, 0],
    }),
  );
  ctx.assign(
    findingsRef,
    ctx.obj({
      Title: str(outlineTitle),
      Parent: outlinesRef,
      Prev: introRef,
      Dest: [page.ref, 'XYZ', 72, 700, 0],
    }),
  );
  ctx.assign(
    outlinesRef,
    ctx.obj({ Type: 'Outlines', First: introRef, Last: findingsRef, Count: 2 }),
  );
  doc.catalog.set(name('Outlines'), outlinesRef);

  // Named destinations (name tree; keys sorted: uppercase sorts before lowercase).
  const dests = ctx.obj({
    Names: [
      str(destName),
      ctx.obj([page.ref, 'XYZ', 72, 700, 0]),
      str('intro'),
      ctx.obj([page.ref, 'XYZ', 72, 760, 0]),
    ],
  });
  doc.catalog.set(name('Names'), ctx.obj({ Dests: ctx.register(dests) }));

  const packet = new TextEncoder().encode(xmp(title, author, subject));
  doc.catalog.set(
    name('Metadata'),
    ctx.register(ctx.stream(packet, { Type: 'Metadata', Subtype: 'XML' })),
  );

  await doc.attach(new TextEncoder().encode(attachment), 'notes.txt', {
    mimeType: 'text/plain',
    description: 'Plain-text attachment',
    creationDate: FIXED_DATE,
    modificationDate: FIXED_DATE,
  });

  const regions = [
    tokenRegion(
      'token',
      72 + w('Tagged paragraph: '),
      680,
      w(TOKEN),
      `Marked content /P <</MCID 0>> in the page content ("${paragraph}"); the structure element carries the same text as /ActualText.`,
    ),
    textRegion('innocuous', FOX, 72, 640, w(FOX), 14, 'Marked as /Artifact; must survive.'),
  ];

  const bytes = await save(doc, file);
  return {
    bytes,
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 1,
      pages: [pageExpect([marker, paragraph, FOX])],
      info: {
        Title: title,
        Subject: subject,
        Author: author,
        CreationDate: FIXED_DATE.toISOString(),
        ModDate: FIXED_DATE.toISOString(),
      },
      xmp: { 'dc:title': title, 'dc:description': subject, 'dc:creator': author },
      outline: [
        { title: 'Introduction', page: 1, target: 'explicit-dest' },
        { title: outlineTitle, page: 1, target: 'explicit-dest' },
      ],
      outlineVisibleCount: 2,
      namedDests: [
        { name: destName, page: 1, tree: 'Names/Dests' },
        { name: 'intro', page: 1, tree: 'Names/Dests' },
      ],
      attachments: [{ name: 'notes.txt', content: attachment, mimeType: 'text/plain' }],
      tagged: { marked: true, structTypes: ['Document', 'P'], structParents: [0], mcids: [0] },
      regions,
      secret: await secretFor(
        file,
        bytes,
        [
          'Info/Subject',
          'Info/Title',
          'Root/Metadata (stream)',
          'Root/Names/Dests/Names[0]',
          'Root/Names/EmbeddedFiles/Names[1]/EF/F (stream)',
          'Root/Outlines/First/Next/Title',
          'Root/Pages/Kids[0]/Contents (stream)',
          'Root/StructTreeRoot/K/K/ActualText',
          'Root/StructTreeRoot/K/K/Alt',
        ],
        [{ page: 1, count: 1 }],
        true,
      ),
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// redact-incremental
// ---------------------------------------------------------------------------

async function buildIncremental(): Promise<Built> {
  const file = 'redact-incremental.pdf';
  const doc = await newDoc('Redaction fixture: incremental update');
  const { font, w } = helvetica(doc);
  const page = doc.addPage(LETTER);
  page.node.set(name('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
  const marker = 'PAGE 1 OF redact-incremental';
  const prefix = 'Revision 1 text: ';
  const rev1Line = `${prefix}${TOKEN} stays`;
  setRawContent(
    doc,
    page,
    [bt('F1', 10, 72, 740, `${lit(marker)} Tj`), bt('F1', 14, 72, 680, `${lit(rev1Line)} Tj`)].join(
      '\n',
    ),
  );
  const contentRef = page.node.get(name('Contents')) as PDFRef;
  const { Root, Info } = doc.context.trailerInfo;
  const rev1 = await save(doc, file);
  const rev1Text = latin1(rev1);

  // Revision 2, appended by hand: the content stream object is redefined
  // (same object number) without the token; the xref section lists only that
  // object and the trailer chains to revision 1 with /Prev.
  const startxref1 = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(rev1Text)?.[1]);
  const size = Number(/\/Size (\d+)/.exec(rev1Text.slice(rev1Text.lastIndexOf('trailer')))?.[1]);
  if (!startxref1 || !size) throw new Error(`${file}: revision 1 trailer not found`);
  const content = [
    bt('F1', 10, 72, 740, `${lit(marker)} Tj`),
    bt('F1', 14, 72, 680, `${lit(FOX)} Tj`),
  ].join('\n');
  const lead = rev1Text.endsWith('\n') ? '' : '\n';
  const objOffset = rev1.length + lead.length;
  const obj = `${contentRef.objectNumber} ${contentRef.generationNumber} obj\n<<\n/Length ${content.length}\n>>\nstream\n${content}\nendstream\nendobj\n`;
  const xrefOffset = objOffset + obj.length;
  const hex = (id: Uint8Array) => PDFHexString.fromBytes(id).toString();
  const update = [
    lead,
    obj,
    'xref\n',
    `${contentRef.objectNumber} 1\n`,
    `${String(objOffset).padStart(10, '0')} ${String(contentRef.generationNumber).padStart(5, '0')} n \n`,
    'trailer\n',
    `<<\n/Size ${size}\n/Root ${(Root as PDFRef).toString()}\n/Info ${(Info as PDFRef).toString()}\n`,
    `/ID [${hex(fileIdFor(file))} ${hex(fileIdFor(`${file}#revision-2`))}]\n`,
    `/Prev ${startxref1}\n>>\n`,
    `startxref\n${xrefOffset}\n%%EOF\n`,
  ].join('');
  const bytes = new Uint8Array(Buffer.from(rev1Text + update, 'latin1'));

  const rev1Doc = await PDFDocumentClass.load(rev1, { updateMetadata: false });
  const revision1Locations = findToken(rev1Doc, TOKEN);
  const expectedRev1 = ['Root/Pages/Kids[0]/Contents (stream)'];
  if (JSON.stringify(revision1Locations) !== JSON.stringify(expectedRev1)) {
    throw new Error(`${file}: revision 1 token locations ${JSON.stringify(revision1Locations)}`);
  }

  const tokenBox = textBox(72 + w(prefix), 680, w(TOKEN), 14);
  return {
    bytes,
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 1,
      pages: [pageExpect([marker, FOX])],
      info: { Title: 'Redaction fixture: incremental update' },
      regions: [
        {
          id: 'revision-1-token',
          page: 1,
          kind: 'text',
          text: TOKEN,
          fontSize: 14,
          baseline: 680,
          box: tokenBox,
          area: textArea(tokenBox, 14),
          extractable: false,
          note: `Where revision 1 drew "${rev1Line}" (uncompressed, object ${contentRef.objectNumber}); the current revision draws the innocuous line at the same baseline instead, so nothing here is extractable any more.`,
        },
        textRegion('innocuous', FOX, 72, 680, w(FOX), 14, 'Current revision (the update).'),
      ],
      secret: await secretFor(file, bytes, [], [{ page: 1, count: 0 }], true),
      incremental: {
        revisions: 2,
        startxrefs: [startxref1, xrefOffset],
        prev: startxref1,
        revision1Bytes: rev1.length,
        replaced: [contentRef.toString()],
        revision1Locations,
      },
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// text-edit-fonts
// ---------------------------------------------------------------------------

interface FkPathCommand {
  command: 'moveTo' | 'lineTo' | 'quadraticCurveTo' | 'bezierCurveTo' | 'closePath';
  args: number[];
}
interface FkGlyph {
  id: number;
  advanceWidth: number;
  path: { commands: FkPathCommand[] };
}
interface FkFont {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  glyphForCodePoint(cp: number): FkGlyph;
  layout(text: string): { glyphs: FkGlyph[]; positions: { xAdvance: number }[] };
  createSubset(): { includeGlyph(glyph: FkGlyph): number; encode(): Uint8Array };
}

/** @cantoo/fontkit, resolved from the engine package (not a dependency of this tool). */
function loadFontkit(): { fontkit: Fontkit; open: (bytes: Uint8Array) => FkFont } {
  const require = createRequire(join(REPO_ROOT, 'packages', 'engine', 'package.json'));
  const fontkit = require('@cantoo/fontkit') as Fontkit;
  const opener = fontkit as unknown as { create(bytes: Uint8Array): FkFont };
  return { fontkit, open: (bytes) => opener.create(bytes) };
}

/** Glyph outlines of `value` as PDF path operators (quadratics raised to cubics). */
function outlinePath(
  font: FkFont,
  value: string,
  x: number,
  y: number,
  size: number,
): { ops: string; width: number } {
  const scale = size / font.unitsPerEm;
  const run = font.layout(value);
  const out: string[] = [];
  let pen = 0;
  run.glyphs.forEach((glyph, i) => {
    const ox = x + pen * scale;
    const p = (px: number, py: number) => `${f(ox + px * scale)} ${f(y + py * scale)}`;
    let [cx, cy, sx, sy] = [0, 0, 0, 0];
    for (const { command, args } of glyph.path.commands) {
      const [a = 0, b = 0, c = 0, d = 0, e = 0, g = 0] = args;
      if (command === 'moveTo') {
        out.push(`${p(a, b)} m`);
        [cx, cy, sx, sy] = [a, b, a, b];
      } else if (command === 'lineTo') {
        out.push(`${p(a, b)} l`);
        [cx, cy] = [a, b];
      } else if (command === 'quadraticCurveTo') {
        const c1 = p(cx + (2 / 3) * (a - cx), cy + (2 / 3) * (b - cy));
        const c2 = p(c + (2 / 3) * (a - c), d + (2 / 3) * (b - d));
        out.push(`${c1} ${c2} ${p(c, d)} c`);
        [cx, cy] = [c, d];
      } else if (command === 'bezierCurveTo') {
        out.push(`${p(a, b)} ${p(c, d)} ${p(e, g)} c`);
        [cx, cy] = [e, g];
      } else {
        out.push('h');
        [cx, cy] = [sx, sy];
      }
    }
    pen += run.positions[i]?.xAdvance ?? glyph.advanceWidth;
  });
  return { ops: out.join(' '), width: pen * scale };
}

/** Simple /TrueType font, /WinAnsiEncoding, embedded subset with a (3,1) cmap. */
function simpleTrueType(doc: PDFDocument, font: FkFont, chars: string, baseFont: string): PDFRef {
  const ctx = doc.context;
  const subset = font.createSubset();
  const cmap = new Map<number, number>();
  for (const ch of [...new Set(chars)].sort()) {
    const cp = ch.codePointAt(0) ?? 0;
    cmap.set(cp, subset.includeGlyph(font.glyphForCodePoint(cp)));
  }
  const program = withCmap(subset.encode(), cmap);
  const k = 1000 / font.unitsPerEm;
  const [first, last] = [32, 122];
  const widths: number[] = [];
  for (let code = first; code <= last; code++) {
    const ch = String.fromCharCode(code);
    widths.push(chars.includes(ch) ? Math.round(font.glyphForCodePoint(code).advanceWidth * k) : 0);
  }
  const descriptor = ctx.register(
    ctx.obj({
      Type: 'FontDescriptor',
      FontName: baseFont,
      Flags: 32, // Nonsymbolic
      FontBBox: [font.bbox.minX, font.bbox.minY, font.bbox.maxX, font.bbox.maxY].map((v) =>
        Math.round(v * k),
      ),
      ItalicAngle: 0,
      Ascent: Math.round(font.ascent * k),
      Descent: Math.round(font.descent * k),
      CapHeight: Math.round(font.capHeight * k),
      StemV: 80,
      FontFile2: ctx.register(ctx.flateStream(program, { Length1: program.length })),
    }),
  );
  return ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'TrueType',
      BaseFont: baseFont,
      FirstChar: first,
      LastChar: last,
      Widths: widths,
      Encoding: 'WinAnsiEncoding',
      FontDescriptor: descriptor,
    }),
  );
}

/** Type3 font with two path glyphs, A and B (codes 0x41, 0x42), and a ToUnicode CMap. */
function type3Font(doc: PDFDocument): PDFRef {
  const ctx = doc.context;
  const glyphA = [
    '750 0 0 0 700 720 d1',
    '0 0 m 290 720 l 410 720 l 700 0 l 570 0 l 350 560 l 130 0 l h f',
    '210 180 280 90 re f',
  ].join('\n');
  const glyphB = [
    '700 0 0 0 600 720 d1',
    '0 0 m 0 720 l 440 720 l 600 620 l 600 450 l 500 370 l 600 290 l 600 100 l 450 0 l h',
    '120 110 m 420 110 l 480 160 l 480 260 l 420 310 l 120 310 l h',
    '120 420 m 400 420 l 480 470 l 480 560 l 400 610 l 120 610 l h f*',
  ].join('\n');
  const toUnicode = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    '2 beginbfchar',
    '<41> <0041>',
    '<42> <0042>',
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
  return ctx.register(
    ctx.obj({
      Type: 'Font',
      Subtype: 'Type3',
      Name: 'T3',
      FontBBox: [0, 0, 700, 720],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: {
        A: ctx.register(ctx.stream(glyphA)),
        B: ctx.register(ctx.stream(glyphB)),
      },
      Encoding: { Type: 'Encoding', Differences: [65, 'A', 'B'] },
      FirstChar: 65,
      LastChar: 66,
      Widths: [750, 700],
      Resources: {},
      ToUnicode: ctx.register(ctx.stream(toUnicode)),
    }),
  );
}

async function buildTextEditFonts(): Promise<Built> {
  const file = 'text-edit-fonts.pdf';
  const doc = await newDoc('Text editing fixture: font kinds');
  const ctx = doc.context;
  const { fontkit, open } = loadFontkit();
  doc.registerFontkit(fontkit);
  const interBytes = new Uint8Array(readFileSync(join(FONT_DIR, 'Inter-Regular.ttf')));
  const monoBytes = new Uint8Array(readFileSync(join(FONT_DIR, 'JetBrainsMono-Regular.ttf')));
  const inter = open(interBytes);
  const mono = open(monoBytes);

  const { font: helv, w } = helvetica(doc);
  const interSubset = await doc.embedFont(interBytes, {
    subset: true,
    customName: 'FXTAAA+Inter-Regular',
  });
  const monoFull = await doc.embedFont(monoBytes, {
    subset: false,
    customName: 'JetBrainsMono-Regular',
  });
  const trueType = simpleTrueType(doc, inter, FOX, 'FXTAAB+Inter-Regular');
  const t3 = type3Font(doc);

  const page = doc.addPage(LETTER);
  page.node.set(
    name('Resources'),
    ctx.obj({
      Font: { F1: helv.ref, F2: interSubset.ref, F3: monoFull.ref, F4: trueType, F5: t3 },
    }),
  );
  const marker = 'PAGE 1 OF text-edit-fonts';
  const size = 16;
  const x = 72;
  const y = { a: 700, b: 650, c: 600, d: 550, e: 500, f: 450, g: 400 };
  const pathsE = outlinePath(inter, FOX, x, y.f, size);
  const pathsG = outlinePath(inter, FOX, x, y.g, size);
  const tz = round2((100 * pathsG.width) / w(FOX, size));
  const type3Text = 'ABBA';
  // Flate-compressed: the two path lines are ~58 KB of operators uncompressed.
  const content = [
    bt('F1', 10, 72, 740, `${lit(marker)} Tj`),
    bt('F1', size, x, y.a, `${lit(FOX)} Tj`),
    bt('F2', size, x, y.b, `${interSubset.encodeText(FOX).toString()} Tj`),
    bt('F3', size, x, y.c, `${monoFull.encodeText(FOX).toString()} Tj`),
    bt('F4', size, x, y.d, `${lit(FOX)} Tj`),
    bt('F5', size, x, y.e, `${lit(type3Text)} Tj`),
    `q 0 0 0 rg ${pathsE.ops} f Q`,
    `q 0 0 0 rg ${pathsG.ops} f Q`,
    `BT /F1 ${size} Tf 3 Tr ${tz} Tz ${x} ${y.g} Td ${lit(FOX)} Tj ET`,
  ].join('\n');
  page.node.set(name('Contents'), ctx.register(ctx.flateStream(content)));

  const metricsOf = (fk: FkFont) => ({
    ascent: fk.ascent / fk.unitsPerEm,
    descent: -fk.descent / fk.unitsPerEm,
  });
  const interM = metricsOf(inter);
  const region = (
    id: string,
    baseline: number,
    width: number,
    font: FontExpectation | undefined,
    note: string,
    extra: Partial<RegionExpectation> = {},
    m = HELV,
  ): RegionExpectation => {
    const b = textBox(x, baseline, width, size, m);
    return {
      id,
      page: 1,
      kind: 'text',
      text: FOX,
      fontSize: size,
      baseline,
      box: b,
      area: textArea(b, size),
      ...(font ? { font } : {}),
      extractable: true,
      note,
      ...extra,
    };
  };
  const regions: RegionExpectation[] = [
    region(
      'helvetica-winansi',
      y.a,
      w(FOX, size),
      HELVETICA_FONT,
      '(a) Standard 14 Helvetica, /WinAnsiEncoding, not embedded; literal string Tj.',
    ),
    region(
      'type0-subset',
      y.b,
      interSubset.widthOfTextAtSize(FOX, size),
      {
        resource: 'F2',
        subtype: 'Type0',
        baseFont: 'FXTAAA+Inter-Regular',
        encoding: 'Identity-H',
        descendant: 'CIDFontType2',
        embedded: true,
        subset: true,
        toUnicode: true,
      },
      '(b) Inter Regular subset holding only the glyphs of this sentence (pdf-lib embedFont(bytes, { subset: true })): pdf-lib writes every custom font as Type0 / Identity-H over a CIDFontType2 (TrueType outlines); hex glyph-id string. Any character not in the sentence (e.g. capitals other than T, digits) is a missing glyph.',
      {},
      interM,
    ),
    region(
      'type0-full',
      y.c,
      monoFull.widthOfTextAtSize(FOX, size),
      {
        resource: 'F3',
        subtype: 'Type0',
        baseFont: 'JetBrainsMono-Regular',
        encoding: 'Identity-H',
        descendant: 'CIDFontType2',
        embedded: true,
        subset: false,
        toUnicode: true,
      },
      '(c) JetBrains Mono Regular embedded whole (pdf-lib embedFont(bytes, { subset: false })), Type0 / Identity-H / CIDFontType2: the program has every glyph of the bundled file, but /W and /ToUnicode list only the glyphs used here.',
      {},
      metricsOf(mono),
    ),
    region(
      'truetype-winansi-subset',
      y.d,
      inter
        .layout(FOX)
        .glyphs.reduce((n, g) => n + Math.round((g.advanceWidth * 1000) / inter.unitsPerEm), 0) *
        (size / 1000),
      {
        resource: 'F4',
        subtype: 'TrueType',
        baseFont: 'FXTAAB+Inter-Regular',
        encoding: 'WinAnsiEncoding',
        embedded: true,
        subset: true,
        toUnicode: false,
      },
      '(b2) Simple /TrueType font, /WinAnsiEncoding, nonsymbolic, Inter subset with only the glyphs of this sentence plus a (3,1) cmap (built by hand; pdf-lib cannot write simple TrueType fonts). /Widths 32-122 are 0 for codes not in the sentence. The typical "Save as PDF" font of office suites.',
      {},
      interM,
    ),
    {
      ...region(
        'type3',
        y.e,
        ((750 + 700 + 700 + 750) * size) / 1000,
        {
          resource: 'F5',
          subtype: 'Type3',
          encoding: 'Differences',
          embedded: false,
          subset: false,
          toUnicode: true,
        },
        '(d) Type3 font /F5 with two glyphs drawn as filled paths (A = code 0x41, B = 0x42; d1 glyphs, FontMatrix 0.001), /ToUnicode maps them to "A" and "B". Not editable (spec §2.2).',
        {},
        { ascent: 0.72, descent: 0 },
      ),
      text: type3Text,
    },
    {
      ...region(
        'vector-paths',
        y.f,
        pathsE.width,
        undefined,
        '(e) The sentence as filled vector paths (Inter outlines, no font, no text object): nothing to extract, not editable.',
        { kind: 'vector-text', extractable: false },
        interM,
      ),
    },
    region(
      'ocr-invisible',
      y.g,
      pathsG.width,
      HELVETICA_FONT,
      `(f) OCR-style layer: the sentence as vector paths again, with invisible Helvetica text (3 Tr, ${tz} Tz so its width matches the paths) over it. Extractable but invisible; editing must not simply re-show it.`,
      { renderMode: 3 },
      interM,
    ),
  ];

  const bytes = await save(doc, file);
  return {
    bytes,
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 1,
      pages: [pageExpect([marker, FOX, type3Text])],
      info: { Title: 'Text editing fixture: font kinds' },
      regions,
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// text-edit-rotated
// ---------------------------------------------------------------------------

async function buildTextEditRotated(): Promise<Built> {
  const file = 'text-edit-rotated.pdf';
  const doc = await newDoc('Text editing fixture: rotated pages');
  const { font, w } = helvetica(doc);
  const size = 14;
  const [W, H] = LETTER;
  const regions: RegionExpectation[] = [];
  const pages = [90, 270].map((rotation, index) => {
    const n = index + 1;
    const page: PDFPage = doc.addPage(LETTER);
    page.setRotation(degrees(rotation));
    page.node.set(name('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
    const line1 = `Page ${n} rotate ${rotation} line 1: ${FOX}`;
    const line2 = `Page ${n} rotate ${rotation} line 2 reads upright`;
    // Line 2 counter-rotates with the text matrix so it reads upright on screen.
    const tm =
      rotation === 90
        ? { m: '0 1 -1 0', bx: 90, by: 72 } // runs along +y, glyph tops toward -x
        : { m: '0 -1 1 0', bx: W - 90, by: H - 72 }; // runs along -y, glyph tops toward +x
    setRawContent(
      doc,
      page,
      [
        bt('F1', size, 72, 700, `${lit(line1)} Tj`),
        `BT /F1 ${size} Tf ${tm.m} ${tm.bx} ${tm.by} Tm ${lit(line2)} Tj ET`,
      ].join('\n'),
    );
    const w2 = w(line2, size);
    const [asc, desc] = [HELV.ascent * size, HELV.descent * size];
    const box2 =
      rotation === 90
        ? box(tm.bx - asc, tm.by, asc + desc, w2)
        : box(tm.bx - desc, tm.by - w2, asc + desc, w2);
    // Same margins as textArea, turned with the text: 0.25 em beyond the glyph
    // tops (toward -x on /Rotate 90, +x on /Rotate 270), 0.1 em below the baseline.
    const [up, down] = [0.25 * size, 0.1 * size];
    const area2 =
      rotation === 90
        ? box(box2[0] - up, box2[1] - 1, box2[2] + up + down, box2[3] + 2)
        : box(box2[0] - down, box2[1] - 1, box2[2] + up + down, box2[3] + 2);
    regions.push(
      {
        ...textRegion(
          `page${n}-line1`,
          line1,
          72,
          700,
          w(line1, size),
          size,
          `Horizontal in user space (Td 72 700); on screen it runs ${rotation === 90 ? 'top to bottom' : 'bottom to top'}.`,
        ),
        page: n,
      },
      {
        id: `page${n}-line2`,
        page: n,
        kind: 'text',
        text: line2,
        fontSize: size,
        baseline: tm.bx,
        box: box2,
        area: area2,
        extractable: true,
        note: `Text matrix [${tm.m} ${tm.bx} ${tm.by}] Tm: baseline is the vertical line x = ${tm.bx}, the text starts at y = ${tm.by} and runs ${rotation === 90 ? 'up' : 'down'} the user-space page, so it reads left to right on the /Rotate ${rotation} display (landscape 792 x 612).`,
      },
    );
    return {
      page: n,
      mediaBox: LETTER_BOX,
      rotate: rotation,
      displayedSize: [792, 612] as [number, number],
      markers: [line1, line2],
    };
  });

  const bytes = await save(doc, file);
  return {
    bytes,
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 2,
      pages,
      info: { Title: 'Text editing fixture: rotated pages' },
      regions,
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture table and README section
// ---------------------------------------------------------------------------

export const M4_FIXTURES: FixtureDef[] = [
  {
    file: 'redact-text-runs.pdf',
    tags: ['redaction', 'text', 'tj-split'],
    summary: `1 Letter page, Helvetica. ${TOKEN} in one Tj (line 1), split across two TJ arrays with kerning inside one text object (line 2), split across two BT/ET objects on one baseline (line 3); innocuous line 4.`,
    behavior:
      'Redacting each token area removes exactly those glyphs (TJ runs split) and keeps "Line n, ...:" and "stays" on every line; text extraction afterwards finds no token (3 before). A raw grep finds only line 1, so the self-check must extract text.',
    howGenerated: 'Hand-written content stream (m4-fixtures.ts)',
    build: buildTextRuns,
  },
  {
    file: 'redact-form-xobject.pdf',
    tags: ['redaction', 'form-xobject', 'nested-xobject'],
    summary: `${TOKEN} inside Form XObject /Fm1 painted with Do, and inside /Fm2 nested in /Fm1; innocuous text directly on the page.`,
    behavior:
      'Redaction must descend into Form XObjects (and forms inside forms), remove the token glyphs there and keep "Outer form:", "Nested form:", "stays" and the page text.',
    howGenerated: 'Hand-written content and Form XObject streams (m4-fixtures.ts)',
    build: buildFormXObject,
  },
  {
    file: 'redact-images.pdf',
    tags: ['redaction', 'images', 'inline-image'],
    summary:
      'Three 64x64 RGB image XObjects (Im1 left half inside an area, Im2 fully inside, Im3 outside) and an 8x8 uncompressed inline image (BI/ID/EI) inside an area.',
    behavior:
      'Im1 keeps its right half (green/yellow) and loses the left pixels; Im2 is removed or blanked; Im3 is untouched; the inline image is removed or blanked. No token here.',
    howGenerated: 'pdf-lib flateStream image XObjects + raw inline image (m4-fixtures.ts)',
    build: buildImages,
  },
  {
    file: 'redact-annotations.pdf',
    tags: ['redaction', 'annotations', 'links'],
    summary: `${TOKEN} in page text overlapped by a Link (URI), a Text note with Popup (/Contents "${TOKEN} in a note"), a Highlight and a Square; a second note outside the area.`,
    behavior:
      'Redacting the token area deletes the link, the note and its popup (the popup lies outside the area), the highlight and the square; the survivor note stays. Afterwards the token is absent from every annotation string.',
    howGenerated: 'Hand-written content + pdf-lib low-level annotation dicts (m4-fixtures.ts)',
    build: buildAnnotations,
  },
  {
    file: 'redact-metadata.pdf',
    tags: ['redaction', 'metadata', 'xmp', 'outline', 'named-dests', 'tagged', 'attachments'],
    summary: `${TOKEN} in page text (tagged /P, MCID 0), an outline title, Info /Title and /Subject, XMP dc:title and dc:description, a named destination, /ActualText and /Alt, and an embedded file (Flate-compressed). The page also has a /Thumb.`,
    behavior:
      'Document-level scrub (spec §1.2 step 3) must clear every listed location; the attachment must be dropped or rewritten; /Thumb must be dropped or regenerated (it shows the token line as a dark bar, pixels only). Info /Title is UTF-16 hex and the attachment is compressed, so a raw-byte grep misses them.',
    howGenerated:
      'pdf-lib setters, low-level outline/name tree/structure tree, attach() (m4-fixtures.ts)',
    build: buildMetadata,
  },
  {
    file: 'redact-incremental.pdf',
    tags: ['redaction', 'incremental-update', 'history'],
    summary: `Two revisions: revision 1 draws "${TOKEN}" (uncompressed); an appended update redefines that content stream without it (xref section + trailer with /Prev).`,
    behavior:
      'Viewers show only the innocuous line, but the file bytes still hold the token. Export after redaction must be a full rewrite: no /Prev, token absent from the bytes. Truncating the file at revision1Bytes gives the original PDF.',
    howGenerated: 'pdf-lib revision 1 + hand-appended incremental section (m4-fixtures.ts)',
    build: buildIncremental,
  },
  {
    file: 'text-edit-fonts.pdf',
    tags: ['text-editing', 'fonts', 'type0', 'truetype', 'type3', 'ocr-layer'],
    summary:
      'The same sentence in Helvetica (WinAnsi), a Type0/Identity-H Inter subset, a Type0/Identity-H JetBrains Mono (whole font), a simple TrueType WinAnsi Inter subset, a Type3 font ("ABBA"), vector paths, and paths under invisible (3 Tr) text.',
    behavior:
      'Tier 2 applies to lines whose font has every new glyph; the subsets lack most glyphs, so edits with new characters fall back to Tier 1. Type3 and path text are marked not editable; the invisible line is detected as an OCR layer.',
    howGenerated:
      'pdf-lib embedFont (fontkit), hand-built TrueType and Type3 dicts, fontkit outlines (m4-fixtures.ts)',
    build: buildTextEditFonts,
  },
  {
    file: 'text-edit-rotated.pdf',
    tags: ['text-editing', 'rotation'],
    summary:
      'Page 1 /Rotate 90, page 2 /Rotate 270 (Letter); each has one line horizontal in user space and one line counter-rotated by its text matrix so it reads upright.',
    behavior:
      'Hover boxes and the inline editor must follow the display rotation; edited text keeps the original text matrix orientation; coordinates are stored in unrotated user space.',
    howGenerated: 'Hand-written content streams + setRotation (m4-fixtures.ts)',
    build: buildTextEditRotated,
  },
];

function fmtBox(b: Box | undefined): string {
  return b ? `[${b.join(', ')}]` : '-';
}

/** README section with every documented coordinate of the M4 fixtures. */
export function renderM4Readme(entries: ManifestEntry[]): string {
  const files = new Set(M4_FIXTURES.map((d) => d.file));
  const sections = entries
    .filter((e) => files.has(e.file))
    .map((e) => {
      const rows = (e.expect.regions ?? []).map((r) => {
        const what = r.text ? `"${r.text}"` : (r.xobject ?? r.kind);
        const font = r.font ? `${r.font.subtype} /${r.font.resource}` : r.kind;
        return `| \`${r.id}\` | ${r.page} | ${what.replaceAll('|', '\\|')} | ${font} | ${r.baseline ?? '-'} | ${fmtBox(r.box)} | ${fmtBox(r.area)} | ${r.note.replaceAll('|', '\\|')} |`;
      });
      const lines = [
        `### \`${e.file}\``,
        '',
        '| id | page | content | font / kind | baseline | box | area | notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
      ];
      const s = e.expect.secret;
      if (s) {
        const where = s.locations.length
          ? s.locations.map((l) => `\`${l}\``).join(', ')
          : 'none in the current revision';
        const counts = s.extracted.map((x) => `page ${x.page}: ${x.count}`).join(', ');
        lines.push(
          '',
          `Token objects (decoded value contains \`${s.token}\` contiguously): ${where}. Text extraction finds it ${counts}. Raw bytes contain it: ${s.inRawBytes ? 'yes' : 'no'}.`,
        );
      }
      const inc = e.expect.incremental;
      if (inc) {
        lines.push(
          '',
          `Revisions: ${inc.revisions}; startxref ${inc.startxrefs.join(' then ')}; newest trailer /Prev ${inc.prev}; revision 1 is the first ${inc.revision1Bytes} bytes; update redefines ${inc.replaced.join(', ')}; revision 1 token objects: ${inc.revision1Locations.map((l) => `\`${l}\``).join(', ')}.`,
        );
      }
      return lines.join('\n');
    });
  return `## Redaction and text-editing targets (M4)

Token \`${TOKEN}\` (appears only where listed); innocuous text "${FOX}".
Coordinates are unrotated user space in points; boxes are \`[x, y, width, height]\`.
A text box spans the advance width (TJ adjustments included) and the font's
descender..ascender (Helvetica 207/718 per 1000) and matches the glyph
positions PDFium reports; \`area\` is a suggested redaction or selection
rectangle: the box 1 pt wider on each side (into the neighbouring spaces, no
other glyph), 0.1 em lower and 0.25 em higher, because PDFium's loose glyph
boxes reach about 0.93 em above the baseline. The same data is in \`manifest.json\`
(\`expect.regions\`, \`expect.secret\`, \`expect.incremental\`); token objects are
paths from the trailer as reported by \`tools/fixtures/lib/scan.ts\`.

${sections.join('\n\n')}
`;
}
