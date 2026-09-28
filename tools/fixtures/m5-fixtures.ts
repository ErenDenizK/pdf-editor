/**
 * Milestone M5 fixtures (docs/specs/recognize-and-compare.md §1.5, §2.3, §3.4, §4):
 * image-only scans with OCR ground truth, a compare pair, signed files made by
 * an independent CMS signer (lib/pki.ts) with incremental updates written by
 * hand, and a layout fixture for PDF -> Markdown.
 *
 * Everything is deterministic: scans are rasterised here from Inter's glyph
 * outlines (lib/raster.ts) with a seeded noise generator, and signatures use
 * RSASSA-PKCS1-v1_5 (deterministic) with committed test-only keys
 * (tools/fixtures/keys/) and a fixed claimed time.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';
import {
  PDFArray,
  type PDFDocument,
  PDFDocument as PDFDocumentClass,
  type PDFRef,
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
  type CertificateTruth,
  type CompareChangeTruth,
  type CompareTruth,
  FIXED_DATE,
  type LaterChangeTruth,
  type ManifestEntry,
  type MarkdownBlockTruth,
  type MarkdownTruth,
  type OcrExpectation,
  type OcrLineTruth,
  type OcrPageTruth,
  type OcrWordTruth,
  type PageExpectation,
  type PkiFileTruth,
  type PkiTruth,
  REPO_ROOT,
  type RevisionsTruth,
  type SignatureStatusTruth,
  type SignatureTruth,
  type TamperTruth,
  fileIdFor,
  seededRandom,
  sha256,
} from './lib/common.ts';
import { type P12Scheme, buildP12 } from './lib/p12.ts';
import {
  type CmsMode,
  KEYS_DIR,
  type Party,
  buildCms,
  chain,
  checkCms,
  party,
  pem,
} from './lib/pki.ts';
import { Canvas, type PathCommand } from './lib/raster.ts';

const FONT_DIR = join(REPO_ROOT, 'packages', 'engine', 'assets', 'fonts');
const LETTER_BOX = box(0, 0, 612, 792);
/** Helvetica AFM Ascender / Descender, per unit of font size. */
const HELV = { ascent: 0.718, descent: 0.207 };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function f(n: number): string {
  return String(round2(n));
}

const WIN_ANSI_ESCAPES: Record<string, string> = { '•': '\\225' };

/** PDF literal string in WinAnsiEncoding (ASCII plus the few escapes above). */
function lit(value: string): string {
  let out = '';
  for (const ch of value) {
    const escaped = WIN_ANSI_ESCAPES[ch];
    if (escaped) out += escaped;
    else if (ch.charCodeAt(0) > 0x7e) throw new Error(`lit: no WinAnsi escape for ${ch}`);
    else out += /[\\()]/.test(ch) ? `\\${ch}` : ch;
  }
  return `(${out})`;
}

function bt(font: string, size: number, x: number, y: number, value: string): string {
  return `BT /${font} ${size} Tf ${f(x)} ${f(y)} Td ${lit(value)} Tj ET`;
}

function textBox(x: number, baseline: number, width: number, size: number): Box {
  return box(x, baseline - HELV.descent * size, width, (HELV.ascent + HELV.descent) * size);
}

interface StandardEmbedder {
  encodeTextAsGlyphs(text: string): { name: string }[];
  widthOfGlyph(glyphName: string): number;
}

/** A standard 14 font with an advance-width function that matches Tj (no kerning). */
function standard(
  doc: PDFDocument,
  font: StandardFonts,
): { ref: PDFRef; w: (s: string, size: number) => number } {
  const embedded = doc.embedStandardFont(font);
  const embedder = (embedded as unknown as { embedder: StandardEmbedder }).embedder;
  const w = (s: string, size: number) =>
    (embedder.encodeTextAsGlyphs(s).reduce((n, g) => n + embedder.widthOfGlyph(g.name), 0) * size) /
    1000;
  return { ref: embedded.ref, w };
}

/** Small RGB test image: four coloured bands with a diagonal. */
function bandImage(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  const bands: [number, number, number][] = [
    [214, 69, 65],
    [242, 176, 53],
    [76, 159, 112],
    [58, 110, 180],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const band = bands[Math.min(3, Math.floor((4 * x) / width))] ?? [0, 0, 0];
      const onDiagonal = Math.abs(x * height - y * width) < width;
      const i = (y * width + x) * 3;
      out.set(onDiagonal ? [20, 20, 20] : band, i);
    }
  }
  return out;
}

function registerImage(
  doc: PDFDocument,
  pixels: Uint8Array,
  width: number,
  height: number,
): PDFRef {
  return doc.context.register(
    doc.context.flateStream(pixels, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: width,
      Height: height,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
    }),
  );
}

function pageExpect(page: number, markers: string[] = []): PageExpectation {
  const pe: PageExpectation = {
    page,
    mediaBox: LETTER_BOX,
    rotate: 0,
    displayedSize: [612, 792],
  };
  if (markers.length) pe.markers = markers;
  return pe;
}

// ---------------------------------------------------------------------------
// Scans (OCR ground truth)
// ---------------------------------------------------------------------------

interface FkGlyph {
  id: number;
  codePoints: number[];
  advanceWidth: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  path: { commands: PathCommand[] };
}
interface FkFont {
  unitsPerEm: number;
  layout(text: string): {
    glyphs: FkGlyph[];
    positions: { xAdvance: number; xOffset: number; yOffset: number }[];
  };
}

function openFont(file: string): FkFont {
  const require = createRequire(join(REPO_ROOT, 'packages', 'engine', 'package.json'));
  const fontkit = require('@cantoo/fontkit') as { create(bytes: Uint8Array): FkFont };
  return fontkit.create(new Uint8Array(readFileSync(join(FONT_DIR, file))));
}

const SCAN_DPI = 200;
const PX = SCAN_DPI / 72;

interface ScanLine {
  text: string;
  size: number;
  /** Baseline y in display space (y up, before skew). */
  baseline: number;
}
interface ScanPage {
  lines: ScanLine[];
  skew: number;
  specks: number;
  /** Page /Rotate: 90 stores the image sideways so that the displayed page reads upright. */
  rotate?: 0 | 90;
  /** Adds another tool's invisible (3 Tr) Helvetica layer with these deliberate errors. */
  foreign?: { expected: string; actual: string }[];
}

type Point = [number, number];

/** Display size in points and the display -> user space mapping for a Letter page. */
function orientation(rotate: 0 | 90): {
  width: number;
  height: number;
  toUser: (p: Point) => Point;
  matrix: number[];
} {
  return rotate === 90
    ? {
        width: 792,
        height: 612,
        toUser: ([x, y]) => [612 - y, x],
        matrix: [0, 792, -612, 0, 612, 0],
      }
    : { width: 612, height: 792, toUser: (p) => p, matrix: [612, 0, 0, 792, 0, 0] };
}

/** Rasterises one page; returns its grey pixels and the ground truth. */
function scanPage(
  font: FkFont,
  spec: ScanPage,
  pageNumber: number,
  seed: string,
): { grey: Uint8Array; truth: OcrPageTruth; width: number; height: number } {
  const o = orientation(spec.rotate ?? 0);
  const width = Math.round(o.width * PX);
  const height = Math.round(o.height * PX);
  const canvas = new Canvas(width, height);
  const theta = (spec.skew * Math.PI) / 180;
  const [cos, sin] = [Math.cos(theta), Math.sin(theta)];
  const [cx, cy] = [o.width / 2, o.height / 2];
  /** Display space (unskewed) -> display space as printed (rotated about the page centre). */
  const rot = (x: number, y: number): Point => [
    cx + (x - cx) * cos - (y - cy) * sin,
    cy + (x - cx) * sin + (y - cy) * cos,
  ];
  const toPx = ([x, y]: Point): Point => [x * PX, (o.height - y) * PX];
  const bounds = (rect: [number, number, number, number]) => {
    const [x0, y0, x1, y1] = rect;
    const shown = [rot(x0, y0), rot(x1, y0), rot(x1, y1), rot(x0, y1)];
    const user = shown.map(o.toUser);
    const xs = user.map((p) => p[0]);
    const ys = user.map((p) => p[1]);
    const pxs = shown.map(toPx);
    const left = Math.floor(Math.min(...pxs.map((p) => p[0])));
    const top = Math.floor(Math.min(...pxs.map((p) => p[1])));
    const right = Math.ceil(Math.max(...pxs.map((p) => p[0])));
    const bottom = Math.ceil(Math.max(...pxs.map((p) => p[1])));
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      box: box(minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY),
      px: [left, top, right - left, bottom - top] as Box,
    };
  };

  const lines: OcrLineTruth[] = [];
  const words: OcrWordTruth[] = [];
  for (const line of spec.lines) {
    const scale = line.size / font.unitsPerEm;
    const run = font.layout(line.text);
    const expectedWords = line.text.split(' ');
    const wordInk: [number, number, number, number][] = [];
    let current: [number, number, number, number] | null = null;
    let pen = 0;
    const x0 = 72;
    for (const [i, glyph] of run.glyphs.entries()) {
      const pos = run.positions[i];
      const ox = x0 + (pen + (pos?.xOffset ?? 0)) * scale;
      const oy = line.baseline + (pos?.yOffset ?? 0) * scale;
      if (glyph.codePoints.includes(32)) {
        if (current) wordInk.push(current);
        current = null;
      } else {
        canvas.fillPath(glyph.path.commands, (gx, gy) =>
          toPx(rot(ox + gx * scale, oy + gy * scale)),
        );
        const b = glyph.bbox;
        if (b.minX <= b.maxX && b.minY <= b.maxY) {
          const g: [number, number, number, number] = [
            ox + b.minX * scale,
            oy + b.minY * scale,
            ox + b.maxX * scale,
            oy + b.maxY * scale,
          ];
          current = current
            ? [
                Math.min(current[0], g[0]),
                Math.min(current[1], g[1]),
                Math.max(current[2], g[2]),
                Math.max(current[3], g[3]),
              ]
            : g;
        }
      }
      pen += pos?.xAdvance ?? glyph.advanceWidth;
    }
    if (current) wordInk.push(current);
    if (wordInk.length !== expectedWords.length)
      throw new Error(
        `scan: ${wordInk.length} ink groups for ${expectedWords.length} words in "${line.text}"`,
      );
    wordInk.forEach((ink, i) => words.push({ text: expectedWords[i] ?? '', ...bounds(ink) }));
    const lineInk: [number, number, number, number] = [
      Math.min(...wordInk.map((r) => r[0])),
      Math.min(...wordInk.map((r) => r[1])),
      Math.max(...wordInk.map((r) => r[2])),
      Math.max(...wordInk.map((r) => r[3])),
    ];
    lines.push({
      text: line.text,
      fontSize: line.size,
      baseline: line.baseline,
      box: bounds(lineInk).box,
    });
  }

  const truth: OcrPageTruth = {
    page: pageNumber,
    rotate: spec.rotate ?? 0,
    image: {
      resource: 'Im1',
      width,
      height,
      dpi: SCAN_DPI,
      colorSpace: 'DeviceGray',
      bitsPerComponent: 8,
      filter: 'FlateDecode',
      matrix: o.matrix,
    },
    skewDegrees: spec.skew,
    text: spec.lines.map((l) => l.text).join('\n'),
    lines,
    words,
  };
  if (spec.specks) {
    // Dust: seeded 1-2 px specks of 25-70 % grey anywhere on the page.
    const random = seededRandom(seed);
    for (let n = 0; n < spec.specks; n++) {
      const x = Math.floor(random() * width);
      const y = Math.floor(random() * height);
      const size = random() < 0.8 ? 1 : 2;
      const ink = 0.25 + random() * 0.45;
      for (let dy = 0; dy < size; dy++)
        for (let dx = 0; dx < size; dx++) {
          const i = Math.min(height - 1, y + dy) * width + Math.min(width - 1, x + dx);
          canvas.coverage[i] = (canvas.coverage[i] ?? 0) + ink;
        }
    }
    truth.noise = { kind: 'speckle', specks: spec.specks, seed };
  }
  return { grey: canvas.toGrey(), truth, width, height };
}

async function buildScan(
  file: string,
  title: string,
  fontFile: string,
  specs: ScanPage[],
  ocr: Omit<OcrExpectation, 'pages' | 'font'>,
): Promise<Built> {
  const doc = await newDoc(title);
  const font = openFont(fontFile);
  const pages: OcrPageTruth[] = [];
  const pageExpects: PageExpectation[] = [];
  const images: NonNullable<Built['expect']['images']> = [];
  for (const [i, spec] of specs.entries()) {
    const n = i + 1;
    const { grey, truth, width, height } = scanPage(font, spec, n, `${file}#page-${n}`);
    const image = doc.context.register(
      doc.context.flateStream(grey, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      }),
    );
    const page = doc.addPage(LETTER);
    const ops = [`q ${truth.image.matrix.join(' ')} cm /Im1 Do Q`];
    if (spec.foreign) {
      if (truth.rotate)
        throw new Error(`${file}: foreign layers are drawn on unrotated pages only`);
      const helv = standard(doc, StandardFonts.Helvetica);
      page.node.set(
        name('Resources'),
        doc.context.obj({ XObject: { Im1: image }, Font: { F1: helv.ref } }),
      );
      const layer: NonNullable<OcrPageTruth['foreignLayer']> = {
        font: 'Helvetica',
        renderMode: 3,
        lines: [],
        errors: spec.foreign,
      };
      for (const line of truth.lines) {
        let value = line.text;
        for (const e of spec.foreign) value = value.replace(e.expected, e.actual);
        // Stretched with Tz so that each line spans its ink box, as OCR layers do.
        const scale = round2((100 * line.box[2]) / helv.w(value, line.fontSize));
        const x = line.box[0];
        ops.push(
          `BT 3 Tr /F1 ${line.fontSize} Tf ${scale} Tz ${f(x)} ${line.baseline} Td ${lit(value)} Tj ET`,
        );
        layer.lines.push({
          text: value,
          x,
          baseline: line.baseline,
          fontSize: line.fontSize,
          horizontalScale: scale,
        });
      }
      const drawn = layer.lines.map((l) => l.text).join('\n');
      for (const e of spec.foreign)
        if (!drawn.includes(e.actual)) throw new Error(`${file}: error "${e.actual}" not placed`);
      truth.foreignLayer = layer;
    } else {
      page.node.set(name('Resources'), doc.context.obj({ XObject: { Im1: image } }));
    }
    if (truth.rotate) page.setRotation(degrees(truth.rotate));
    setRawContent(doc, page, ops.join('\n'));
    pages.push(truth);
    const pe = pageExpect(n);
    pe.rotate = truth.rotate;
    pe.displayedSize = truth.rotate ? [792, 612] : [612, 792];
    pageExpects.push(pe);
    images.push({ page: n, filter: 'FlateDecode', width, height, smask: false });
  }
  if (ocr.letters) {
    const all = pages.map((p) => p.text).join('\n');
    const missing = Array.from(ocr.letters).filter((ch) => !all.includes(ch));
    if (missing.length) throw new Error(`${file}: text lacks ${missing.join(' ')}`);
  }
  return {
    bytes: await save(doc, file),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: specs.length,
      pages: pageExpects,
      info: { Title: title },
      images,
      ocr: {
        ...ocr,
        font: `Inter Regular (${fontFile}), glyph outlines rasterised by lib/raster.ts`,
        pages,
      },
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

function lines(size: number, start: number, step: number, texts: string[]): ScanLine[] {
  return texts.map((text, i) => ({ text, size, baseline: start - i * step }));
}

const SCAN_TEXT_PAGE_1: ScanPage = {
  skew: 0,
  specks: 0,
  lines: [
    { text: 'Scanned Document Test', size: 20, baseline: 700 },
    ...lines(14, 664, 24, [
      'This page is an image of printed text with no text layer.',
      'Optical character recognition should find every word here.',
      'The quick brown fox jumps over the lazy dog near the river.',
      'Numbers such as 2024 and 7731 must be read correctly too.',
      'Each line is set in Inter at fourteen points and scanned.',
    ]),
  ],
};

const SCAN_TEXT_PAGES: ScanPage[] = [
  SCAN_TEXT_PAGE_1,
  {
    skew: 1.5,
    specks: 2500,
    lines: [
      { text: 'Second Page, Slightly Skewed', size: 20, baseline: 700 },
      ...lines(14, 664, 24, [
        'This page was turned by one and a half degrees.',
        'Light speckle noise imitates dust on the scanner glass.',
        'A good recognizer straightens the page and still reads it.',
        'Pack my box with five dozen liquor jugs.',
      ]),
    ],
  },
];

const TURKISH_LETTERS = 'çğıöşüÇĞIİÖŞÜ';

const SCAN_TURKISH_PAGES: ScanPage[] = [
  {
    skew: 0,
    specks: 0,
    lines: [
      { text: 'Türkçe Metin Taraması', size: 22, baseline: 700 },
      ...lines(16, 660, 28, [
        'Pijamalı hasta yağız şoföre çabucak güvendi.',
        'İSTANBUL, ÇANAKKALE, ÖDEMİŞ, ŞİLE, ÜRGÜP VE IĞDIR',
        'Işık ılık, iğne iplik; göz, söz, üzüm.',
      ]),
    ],
  },
];

const SCAN_ROTATED_PAGES: ScanPage[] = [
  {
    skew: 0,
    specks: 0,
    rotate: 90,
    lines: [
      { text: 'Sideways Page', size: 20, baseline: 540 },
      ...lines(14, 504, 24, [
        'This page has a Rotate entry of ninety degrees.',
        'The image is stored sideways and displayed upright.',
        'Recognition must run on the page as it is displayed.',
      ]),
    ],
  },
];

/** scan-text page 1 plus another tool's invisible layer with two typical OCR errors. */
const SCAN_FOREIGN_PAGES: ScanPage[] = [
  {
    ...SCAN_TEXT_PAGE_1,
    foreign: [
      { expected: 'recognition', actual: 'recognitlon' },
      { expected: 'lazy', actual: 'Iazy' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Compare pair
// ---------------------------------------------------------------------------

interface ComparePageSpec {
  heading: string;
  lines: string[];
  image?: { x: number; y: number };
}

const COMPARE_IMAGE = { width: 48, height: 32, w: 144, h: 96 };
const COMPARE_TITLE = { a: 'Quarterly report', b: 'Quarterly report (revised)' };
const CHANGED = {
  prefix: 'The committee approved the budget on ',
  a: 'Monday',
  b: 'Tuesday',
  suffix: ' after a short debate.',
};

function comparePages(variant: 'a' | 'b'): ComparePageSpec[] {
  const p1: ComparePageSpec = {
    heading: 'Quarterly report: summary',
    lines: [
      `${CHANGED.prefix}${CHANGED[variant]}${CHANGED.suffix}`,
      'Spending on maintenance rises by four percent next quarter.',
      'The new library opens in spring and needs twelve volunteers.',
    ],
  };
  const p2: ComparePageSpec = {
    heading: 'Figures and images',
    lines: [
      'The picture below stands in for a chart of visitor numbers.',
      'It is a placeholder image drawn by the fixture generator.',
    ],
    image: { x: variant === 'a' ? 72 : 92, y: 480 },
  };
  const p3: ComparePageSpec = {
    heading: 'Appendix to be removed',
    lines: [
      'This page exists only in the first document.',
      'The second document deletes it, so it has no counterpart.',
    ],
  };
  const p4: ComparePageSpec = {
    heading: 'Contacts',
    lines: [
      'Questions about this report go to the planning office.',
      'Office hours are Tuesday to Thursday, nine to five.',
    ],
  };
  const p5: ComparePageSpec = {
    heading: 'Added in revision',
    lines: [
      'This page was added at the end of the second document.',
      'It has no counterpart in the first document.',
    ],
  };
  return variant === 'a' ? [p1, p2, p3, p4] : [p1, p2, p4, p5];
}

const wordCount = (spec: ComparePageSpec) =>
  [spec.heading, ...spec.lines].join(' ').split(/\s+/).filter(Boolean).length;

async function buildCompare(variant: 'a' | 'b'): Promise<Built> {
  const file = `compare-${variant}.pdf`;
  const doc = await newDoc(COMPARE_TITLE[variant]);
  const regular = standard(doc, StandardFonts.Helvetica);
  const bold = standard(doc, StandardFonts.HelveticaBold);
  const image = registerImage(
    doc,
    bandImage(COMPARE_IMAGE.width, COMPARE_IMAGE.height),
    COMPARE_IMAGE.width,
    COMPARE_IMAGE.height,
  );
  const specs = comparePages(variant);
  for (const spec of specs) {
    const page = doc.addPage(LETTER);
    const fonts = { F1: regular.ref, F2: bold.ref };
    page.node.set(
      name('Resources'),
      spec.image
        ? doc.context.obj({ Font: fonts, XObject: { Im1: image } })
        : doc.context.obj({ Font: fonts }),
    );
    const ops = [
      bt('F2', 18, 72, 720, spec.heading),
      ...spec.lines.map((line, i) => bt('F1', 12, 72, 690 - 18 * i, line)),
    ];
    if (spec.image)
      ops.push(
        `q ${COMPARE_IMAGE.w} 0 0 ${COMPARE_IMAGE.h} ${spec.image.x} ${spec.image.y} cm /Im1 Do Q`,
      );
    setRawContent(doc, page, ops.join('\n'));
  }

  const wordBox = (word: string) =>
    textBox(72 + regular.w(CHANGED.prefix, 12), 690, regular.w(word, 12), 12);
  const imageBox = (x: number): Box => box(x, 480, COMPARE_IMAGE.w, COMPARE_IMAGE.h);
  const a = comparePages('a');
  const b = comparePages('b');
  const changes: CompareChangeTruth[] = [
    {
      kind: 'text-changed',
      aPage: 1,
      bPage: 1,
      a: { text: CHANGED.a, box: wordBox(CHANGED.a) },
      b: { text: CHANGED.b, box: wordBox(CHANGED.b) },
      lineA: a[0]?.lines[0] ?? '',
      lineB: b[0]?.lines[0] ?? '',
    },
    {
      kind: 'image-moved',
      aPage: 2,
      bPage: 2,
      resource: 'Im1',
      a: imageBox(72),
      b: imageBox(92),
      delta: [20, 0],
    },
    {
      kind: 'page-deleted',
      aPage: 3,
      heading: a[2]?.heading ?? '',
      words: a[2] ? wordCount(a[2]) : 0,
    },
    {
      kind: 'page-inserted',
      bPage: 4,
      heading: b[3]?.heading ?? '',
      words: b[3] ? wordCount(b[3]) : 0,
    },
    { kind: 'metadata', key: 'Title', a: COMPARE_TITLE.a, b: COMPARE_TITLE.b },
  ];
  const compare: CompareTruth = {
    role: variant,
    a: 'compare-a.pdf',
    b: 'compare-b.pdf',
    pageMap: [
      { a: 1, b: 1 },
      { a: 2, b: 2 },
      { a: 3, b: null },
      { a: 4, b: 3 },
      { a: null, b: 4 },
    ],
    changes,
    identicalPairs: [{ a: 4, b: 3 }],
  };
  return {
    bytes: await save(doc, file),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 4,
      pages: specs.map((s, i) => pageExpect(i + 1, [s.heading])),
      info: { Title: COMPARE_TITLE[variant] },
      images: [
        {
          page: 2,
          filter: 'FlateDecode',
          width: COMPARE_IMAGE.width,
          height: COMPARE_IMAGE.height,
          smask: false,
        },
      ],
      compare,
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Markdown source
// ---------------------------------------------------------------------------

const MD = {
  body: 11,
  leading: 15,
  heading: { 1: 24, 2: 18, 3: 14 } as Record<1 | 2 | 3, number>,
  header: 'Fixture Handbook',
  link: { text: 'example.org', uri: 'https://example.org/fixtures' },
  image: { width: 80, height: 50, x: 72, y: 300, w: 160, h: 100 },
};

/** Joins drawn lines as Markdown text: a line-end hyphen before a lowercase letter joins the word. */
function joinLines(drawn: string[]): string {
  let out = '';
  for (const line of drawn) {
    if (!out) out = line;
    else if (/[a-z]-$/.test(out) && /^[a-z]/.test(line)) out = out.slice(0, -1) + line;
    else out = `${out} ${line}`;
  }
  return out;
}

async function buildMarkdown(): Promise<Built> {
  const file = 'markdown-source.pdf';
  const doc = await newDoc('Working with PDF Fixtures');
  const ctx = doc.context;
  const regular = standard(doc, StandardFonts.Helvetica);
  const bold = standard(doc, StandardFonts.HelveticaBold);
  const image = registerImage(
    doc,
    bandImage(MD.image.width, MD.image.height),
    MD.image.width,
    MD.image.height,
  );
  const blocks: MarkdownBlockTruth[] = [];
  const ops: string[][] = [[], []];
  const dropped: MarkdownTruth['dropped'] = [];
  const links: MarkdownTruth['links'] = [];

  const heading = (page: number, level: 1 | 2 | 3, text: string, y: number) => {
    const size = MD.heading[level];
    ops[page - 1]?.push(bt('F2', size, 72, y, text));
    blocks.push({
      kind: 'heading',
      page,
      level,
      text,
      fontSize: size,
      box: textBox(72, y, bold.w(text, size), size),
    });
  };
  const paragraph = (
    page: number,
    drawn: string[],
    x: number,
    y: number,
    extra: { column?: 'left' | 'right'; markdown?: string } = {},
  ) => {
    drawn.forEach((line, i) => ops[page - 1]?.push(bt('F1', MD.body, x, y - i * MD.leading, line)));
    const width = Math.max(...drawn.map((l) => regular.w(l, MD.body)));
    const top = y + HELV.ascent * MD.body;
    const bottom = y - (drawn.length - 1) * MD.leading - HELV.descent * MD.body;
    const block: MarkdownBlockTruth = {
      kind: 'paragraph',
      page,
      text: extra.markdown ?? joinLines(drawn),
      lines: drawn,
      box: box(x, bottom, width, top - bottom),
    };
    if (extra.column) block.column = extra.column;
    blocks.push(block);
  };
  const running = (page: number) => {
    ops[page - 1]?.push(bt('F1', 9, 72, 752, MD.header));
    const number = `Page ${page}`;
    ops[page - 1]?.push(bt('F1', 9, 306 - regular.w(number, 9) / 2, 40, number));
    dropped.push(
      { page, text: MD.header, reason: 'running-header' },
      { page, text: number, reason: 'page-number' },
    );
  };

  // Page 1
  running(1);
  heading(1, 1, 'Working with PDF Fixtures', 690);
  paragraph(
    1,
    [
      'Test fixtures are small PDF files with known content. Each one is gener-',
      'ated by a script, so its text, fonts and positions are documented and can',
      'be checked by tests without looking at the pages.',
    ],
    72,
    660,
  );
  heading(1, 2, 'Why fixtures matter', 596);
  const para2 = [
    'Real documents are messy and rarely redistributable. The project site at',
    `${MD.link.text} explains how the corpus is regenerated and verified.`,
  ];
  paragraph(1, para2, 72, 570, {
    markdown: joinLines(para2).replace(MD.link.text, `[${MD.link.text}](${MD.link.uri})`),
  });
  const linkY = 570 - MD.leading;
  const linkRect = textBox(72, linkY, regular.w(MD.link.text, MD.body), MD.body);
  links.push({ page: 1, text: MD.link.text, uri: MD.link.uri, rect: linkRect });
  heading(1, 3, 'What a good fixture has', 522);
  const items = [
    'Known text in a known place',
    'A documented reason to exist',
    'A size of a few kilobytes',
  ];
  items.forEach((item, i) => {
    const y = 498 - i * 18;
    ops[0]?.push(bt('F1', MD.body, 80, y, '•'), bt('F1', MD.body, 94, y, item));
    blocks.push({
      kind: 'list-item',
      page: 1,
      level: 1,
      text: item,
      bullet: '•',
      box: textBox(80, y, 14 + regular.w(item, MD.body), MD.body),
    });
  });
  const img = MD.image;
  ops[0]?.push(`q ${img.w} 0 0 ${img.h} ${img.x} ${img.y} cm /Im1 Do Q`);
  blocks.push({
    kind: 'image',
    page: 1,
    resource: 'Im1',
    box: box(img.x, img.y, img.w, img.h),
    markdown: '![Page 1, image 1](images/p1-1.png)',
  });

  // Page 2
  running(2);
  heading(2, 2, 'Two columns', 690);
  paragraph(
    2,
    [
      'The left column is read first,',
      'from top to bottom, before the',
      'reader moves to the right column.',
    ],
    72,
    660,
    {
      column: 'left',
    },
  );
  paragraph(
    2,
    [
      'The right column comes second.',
      'Its lines sit on the same',
      'baselines as the left column.',
    ],
    324,
    660,
    {
      column: 'right',
    },
  );

  for (const [i, content] of ops.entries()) {
    const page = doc.addPage(LETTER);
    const fonts = { F1: regular.ref, F2: bold.ref };
    page.node.set(
      name('Resources'),
      i === 0 ? ctx.obj({ Font: fonts, XObject: { Im1: image } }) : ctx.obj({ Font: fonts }),
    );
    setRawContent(doc, page, content.join('\n'));
    if (i === 0) {
      const [lx, ly, lw, lh] = linkRect;
      const annot = ctx.register(
        ctx.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [lx, ly, round2(lx + lw), round2(ly + lh)],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: str(MD.link.uri) },
          P: page.ref,
        }),
      );
      page.node.set(name('Annots'), ctx.obj([annot]));
    }
  }

  const outline = blocks.flatMap((b) =>
    b.kind === 'heading'
      ? [`${'#'.repeat(b.level)} ${b.text}`]
      : b.kind === 'list-item'
        ? [`- ${b.text}`]
        : [],
  );
  const md: string[] = [];
  blocks.forEach((b, i) => {
    const prev = blocks[i - 1];
    if (i > 0 && !(b.kind === 'list-item' && prev?.kind === 'list-item')) md.push('');
    if (b.kind === 'heading') md.push(`${'#'.repeat(b.level)} ${b.text}`);
    else if (b.kind === 'paragraph') md.push(b.text);
    else if (b.kind === 'list-item') md.push(`- ${b.text}`);
    else md.push(b.markdown);
  });
  const markdown: MarkdownTruth = {
    bodyFontSize: MD.body,
    headingSizes: { '1': MD.heading[1], '2': MD.heading[2], '3': MD.heading[3] },
    outline,
    blocks,
    dropped,
    links,
    golden: `${md.join('\n')}\n`,
  };
  return {
    bytes: await save(doc, file),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 2,
      pages: [pageExpect(1, ['Working with PDF Fixtures']), pageExpect(2, ['Two columns'])],
      info: { Title: 'Working with PDF Fixtures' },
      links: [{ page: 1, kind: 'uri', uri: MD.link.uri }],
      images: [
        { page: 1, filter: 'FlateDecode', width: img.width, height: img.height, smask: false },
      ],
      markdown,
      xref: 'table',
      fileIdDeterministic: true,
    },
  };
}

// ---------------------------------------------------------------------------
// Signed files: hand-written incremental updates over simple-text.pdf
// ---------------------------------------------------------------------------

const SIG_HEX = 16384; // 8 KB reserved for the CMS
const BYTE_RANGE_PLACEHOLDER = '[0 0000000000 0000000000 0000000000]';
const SIGNED_1 = FIXED_DATE;
const SIGNED_2 = new Date('2024-01-02T00:00:00Z');
const REASON = 'Approved (pdf-editor test fixture)';

function pdfDate(d: Date): string {
  return `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
}

function objectBody(text: string, num: number): string {
  const head = `${num} 0 obj\n`;
  const at = text.lastIndexOf(`\n${head}`);
  if (at < 0) throw new Error(`object ${num} not found`);
  const start = at + 1 + head.length;
  return text.slice(start, text.indexOf('\nendobj', start));
}

/** Sets a top-level key of a dictionary body written by pdf-lib or by this file. */
function withKey(body: string, key: string, value: string): string {
  const existing = new RegExp(`\\n/${key} (\\[[^\\]]*\\]|\\d+ \\d+ R)`);
  if (existing.test(body)) return body.replace(existing, `\n/${key} ${value}`);
  const end = body.lastIndexOf('>>');
  return `${body.slice(0, end)}/${key} ${value}\n>>`;
}

const ref = (n: number) => `${n} 0 R`;
const hexId = (bytes: Uint8Array) => `<${Buffer.from(bytes).toString('hex')}>`;

interface Base {
  text: string;
  size: number;
  root: number;
  info: string;
  id0: string;
  page: number;
  content: number;
}

async function baseOf(simple: Uint8Array): Promise<Base> {
  const doc = await PDFDocumentClass.load(simple, { updateMetadata: false });
  const text = latin1(simple);
  const trailer = text.slice(text.lastIndexOf('trailer'));
  const size = Number(/\/Size (\d+)/.exec(trailer)?.[1]);
  const id0 = /\/ID \[ (<[0-9a-f]+>)/i.exec(trailer)?.[1];
  const page = doc.getPage(0);
  const contents = page.node.Contents();
  const content =
    contents instanceof PDFArray ? (contents.get(0) as PDFRef | undefined) : undefined;
  const { Root, Info } = doc.context.trailerInfo;
  if (!size || !id0 || !content || !Root || !Info)
    throw new Error('simple-text.pdf trailer not understood');
  return {
    text,
    size,
    root: (Root as PDFRef).objectNumber,
    info: (Info as PDFRef).toString(),
    id0,
    page: page.ref.objectNumber,
    content: content.objectNumber,
  };
}

interface Revision {
  text: string;
  startxref: number;
}

/** Appends one revision (objects, xref section, trailer with /Prev). */
function appendRevision(
  base: Base,
  prev: string,
  objects: { num: number; body: string }[],
  file: string,
  revision: number,
): Revision {
  const prevStart = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(prev)?.[1]);
  const prevSize = Number(/\/Size (\d+)/.exec(prev.slice(prev.lastIndexOf('trailer')))?.[1]);
  if (!prevStart || !prevSize) throw new Error(`${file}: previous trailer not found`);
  const sorted = [...objects].sort((x, y) => x.num - y.num);
  let text = prev.endsWith('\n') ? prev : `${prev}\n`;
  const offsets = new Map<number, number>();
  for (const obj of sorted) {
    offsets.set(obj.num, text.length);
    text += `${obj.num} 0 obj\n${obj.body}\nendobj\n`;
  }
  const startxref = text.length;
  const sections: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && (sorted[j + 1]?.num ?? 0) === (sorted[j]?.num ?? 0) + 1) j++;
    const run = sorted.slice(i, j + 1);
    sections.push(
      `${run[0]?.num ?? 0} ${run.length}\n${run.map((o) => `${String(offsets.get(o.num)).padStart(10, '0')} 00000 n \n`).join('')}`,
    );
    i = j + 1;
  }
  const size = Math.max(prevSize, ...sorted.map((o) => o.num + 1));
  text +=
    `xref\n${sections.join('')}trailer\n<<\n/Size ${size}\n/Root ${ref(base.root)}\n/Info ${base.info}\n` +
    `/ID [${base.id0} ${hexId(fileIdFor(`${file}#revision-${revision}`))}]\n/Prev ${prevStart}\n>>\nstartxref\n${startxref}\n%%EOF\n`;
  return { text, startxref };
}

function sigDict(subFilter: string, when: Date): string {
  return [
    '<<',
    '/Type /Sig',
    '/Filter /Adobe.PPKLite',
    `/SubFilter /${subFilter}`,
    `/ByteRange ${BYTE_RANGE_PLACEHOLDER}`,
    `/Contents <${'0'.repeat(SIG_HEX)}>`,
    `/M (${pdfDate(when)})`,
    `/Name (${party('signer-rsa').commonName})`,
    `/Reason (${REASON})`,
    '>>',
  ].join('\n');
}

function widget(field: string, page: number, v: number | null, rect = '[0 0 0 0]'): string {
  return [
    '<<',
    '/Type /Annot',
    '/Subtype /Widget',
    '/FT /Sig',
    `/T (${field})`,
    ...(v === null ? [] : [`/V ${ref(v)}`]),
    `/F ${v === null ? 4 : 132}`,
    `/Rect ${rect}`,
    `/P ${ref(page)}`,
    '>>',
  ].join('\n');
}

/** Fills /ByteRange and /Contents of signature object `sigNum` in the last revision. */
function sign(
  text: string,
  sigNum: number,
  mode: CmsMode,
): { text: string; byteRange: [number, number, number, number]; cms: Uint8Array } {
  const objStart = text.lastIndexOf(`\n${sigNum} 0 obj\n`);
  const brAt = text.indexOf('/ByteRange [', objStart) + '/ByteRange '.length;
  const a = text.indexOf('/Contents <', objStart) + '/Contents '.length;
  const b = a + SIG_HEX + 2;
  const byteRange: [number, number, number, number] = [0, a, b, text.length - b];
  const brText = `[${byteRange.join(' ')}]`.padEnd(BYTE_RANGE_PLACEHOLDER.length, ' ');
  let out = text.slice(0, brAt) + brText + text.slice(brAt + BYTE_RANGE_PLACEHOLDER.length);
  const bytes = Buffer.from(out, 'latin1');
  const signed = Buffer.concat([bytes.subarray(0, a), bytes.subarray(b)]);
  const cms = buildCms(new Uint8Array(signed), mode);
  const hex = Buffer.from(cms).toString('hex').toUpperCase();
  if (hex.length > SIG_HEX)
    throw new Error(`CMS (${cms.length} bytes) does not fit the placeholder`);
  out = out.slice(0, a + 1) + hex.padEnd(SIG_HEX, '0') + out.slice(a + 1 + SIG_HEX);
  return { text: out, byteRange, cms };
}

function certTruth(p: Party): CertificateTruth {
  return {
    subject: p.subject,
    issuer: p.issuer,
    serial: p.serial,
    notBefore: p.notBefore,
    notAfter: p.notAfter,
  };
}

interface SignedSpec {
  field: string;
  mode: CmsMode;
  revision: number;
  byteRange: [number, number, number, number];
  cms: Uint8Array;
  when: Date;
  status: SignatureStatusTruth;
  digest?: 'pass' | 'fail';
  laterChanges?: LaterChangeTruth[];
}

/** Manifest entry for a signed field; asserts it against an independent re-check of `bytes`. */
function signatureTruth(file: string, bytes: Uint8Array, s: SignedSpec): SignatureTruth {
  const [, a, b, c] = s.byteRange;
  const signed = Buffer.concat([bytes.subarray(0, a), bytes.subarray(b, b + c)]);
  const check = checkCms(s.cms, new Uint8Array(signed));
  const digest = s.digest ?? 'pass';
  if ((digest === 'pass') !== check.digestMatches || !check.signatureValid || !check.chainValid)
    throw new Error(`${file}: ${s.field} self-check ${JSON.stringify(check)}`);
  const cades = s.mode === 'cades-detached';
  const truth: SignatureTruth = {
    field: s.field,
    page: 1,
    rect: [0, 0, 0, 0],
    signed: true,
    status: s.status,
    filter: 'Adobe.PPKLite',
    subFilter: cades ? 'ETSI.CAdES.detached' : 'adbe.pkcs7.sha1',
    revision: s.revision,
    byteRange: s.byteRange,
    contentsHexLength: SIG_HEX,
    cmsBytes: s.cms.length,
    coversWholeFile: b + c === bytes.length,
    digestAlgorithm: cades ? 'SHA-256' : 'SHA-1',
    signatureAlgorithm: 'RSASSA-PKCS1-v1_5',
    signedAttributes: cades
      ? ['contentType', 'messageDigest', 'signingCertificateV2']
      : ['contentType', 'messageDigest'],
    claimedTime: s.when.toISOString(),
    reason: REASON,
    signer: certTruth(party('signer-rsa')),
    chain: chain().map((p) => p.subject),
    checks: {
      byteRange: 'pass',
      digest,
      signature: 'pass',
      signingCertificate: cades ? 'pass' : 'not-checked',
      chain: 'pass',
    },
  };
  if (!cades) truth.weakDigest = true;
  if (s.laterChanges) truth.laterChanges = s.laterChanges;
  return truth;
}

function revisionsOf(text: string): RevisionsTruth {
  const startxrefs = [...text.matchAll(/startxref\s+(\d+)\s+%%EOF\n/g)].map((m) => Number(m[1]));
  const ends = [...text.matchAll(/%%EOF\n/g)].map((m) => (m.index ?? 0) + m[0].length);
  return { count: ends.length, startxrefs, ends };
}

const SIMPLE_PAGES = [1, 2, 3].map((n) => pageExpect(n, [`PAGE ${n} OF simple-text`]));

function signedExpect(bytes: Uint8Array, signatures: SignatureTruth[]): Built['expect'] {
  return {
    pdfLibLoad: 'ok',
    pageCount: 3,
    pages: SIMPLE_PAGES,
    info: { Title: 'Simple text fixture' },
    signatures,
    revisions: revisionsOf(latin1(bytes)),
    xref: 'table',
    fileIdDeterministic: true,
  };
}

interface Approval {
  base: Base;
  text: string;
  byteRange: [number, number, number, number];
  cms: Uint8Array;
  sig: number;
  widget: number;
  acroForm: number;
  empty?: number;
}

/**
 * Revision 2: signature dictionary, invisible approval widget, /AcroForm
 * (/SigFlags 3) and the catalog and page 1 redefined to reference them.
 * `emptyField` adds an unsigned /Sig field listed before the signed one.
 */
async function approval(
  simple: Uint8Array,
  file: string,
  mode: CmsMode,
  emptyField = false,
): Promise<Approval> {
  const base = await baseOf(simple);
  const [sig, wid, acro, empty] = [base.size, base.size + 1, base.size + 2, base.size + 3];
  const fields = emptyField ? [empty, wid] : [wid];
  const objects = [
    {
      num: sig,
      body: sigDict(
        mode === 'cades-detached' ? 'ETSI.CAdES.detached' : 'adbe.pkcs7.sha1',
        SIGNED_1,
      ),
    },
    { num: wid, body: widget('Approval', base.page, sig) },
    { num: acro, body: `<<\n/Fields [${fields.map(ref).join(' ')}]\n/SigFlags 3\n>>` },
    { num: base.root, body: withKey(objectBody(base.text, base.root), 'AcroForm', ref(acro)) },
    {
      num: base.page,
      body: withKey(objectBody(base.text, base.page), 'Annots', `[${fields.map(ref).join(' ')}]`),
    },
  ];
  if (emptyField)
    objects.push({ num: empty, body: widget('Reviewer', base.page, null, '[72 520 272 580]') });
  const rev = appendRevision(base, base.text, objects, file, 2);
  const signed = sign(rev.text, sig, mode);
  const result: Approval = {
    base,
    text: signed.text,
    byteRange: signed.byteRange,
    cms: signed.cms,
    sig,
    widget: wid,
    acroForm: acro,
  };
  if (emptyField) result.empty = empty;
  return result;
}

const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'));

function need(built: Map<string, Uint8Array>, file: string): Uint8Array {
  const bytes = built.get(file);
  if (!bytes) throw new Error(`${file} must be built first`);
  return bytes;
}

/** Rebuilds signed-approval.pdf and checks it is byte-identical to the built one. */
async function approvalFor(built: Map<string, Uint8Array>): Promise<Approval> {
  const ap = await approval(
    need(built, 'simple-text.pdf'),
    'signed-approval.pdf',
    'cades-detached',
  );
  if (
    Buffer.compare(
      Buffer.from(ap.text, 'latin1'),
      Buffer.from(need(built, 'signed-approval.pdf')),
    ) !== 0
  )
    throw new Error('signed-approval.pdf is not reproducible');
  return ap;
}

async function buildSignedApproval(built: Map<string, Uint8Array>): Promise<Built> {
  const file = 'signed-approval.pdf';
  const ap = await approval(need(built, 'simple-text.pdf'), file, 'cades-detached');
  const bytes = bytesOf(ap.text);
  return {
    bytes,
    expect: signedExpect(bytes, [
      signatureTruth(file, bytes, {
        field: 'Approval',
        mode: 'cades-detached',
        revision: 2,
        byteRange: ap.byteRange,
        cms: ap.cms,
        when: SIGNED_1,
        status: 'intact',
      }),
    ]),
  };
}

async function buildSignedSha1(built: Map<string, Uint8Array>): Promise<Built> {
  const file = 'signed-sha1.pdf';
  const ap = await approval(need(built, 'simple-text.pdf'), file, 'pkcs7-sha1');
  const bytes = bytesOf(ap.text);
  return {
    bytes,
    expect: signedExpect(bytes, [
      signatureTruth(file, bytes, {
        field: 'Approval',
        mode: 'pkcs7-sha1',
        revision: 2,
        byteRange: ap.byteRange,
        cms: ap.cms,
        when: SIGNED_1,
        status: 'intact',
      }),
    ]),
  };
}

async function buildSignedEmptyField(built: Map<string, Uint8Array>): Promise<Built> {
  const file = 'signed-empty-field.pdf';
  const ap = await approval(need(built, 'simple-text.pdf'), file, 'cades-detached', true);
  const bytes = bytesOf(ap.text);
  return {
    bytes,
    expect: signedExpect(bytes, [
      {
        field: 'Reviewer',
        page: 1,
        rect: box(72, 520, 200, 60),
        signed: false,
        status: 'unsigned',
      },
      signatureTruth(file, bytes, {
        field: 'Approval',
        mode: 'cades-detached',
        revision: 2,
        byteRange: ap.byteRange,
        cms: ap.cms,
        when: SIGNED_1,
        status: 'intact',
      }),
    ]),
  };
}

async function buildSignedThenModified(built: Map<string, Uint8Array>): Promise<Built> {
  const file = 'signed-then-modified.pdf';
  const ap = await approvalFor(built);
  const note = ap.base.size + 3;
  const noteBody = [
    '<<',
    '/Type /Annot',
    '/Subtype /Text',
    '/Rect [400 700 420 720]',
    '/Contents (Added after signing)',
    '/NM (note-after-signing)',
    `/M (${pdfDate(SIGNED_2)})`,
    '/F 4',
    '/Name /Comment',
    `/P ${ref(ap.base.page)}`,
    '>>',
  ].join('\n');
  const rev = appendRevision(
    ap.base,
    ap.text,
    [
      { num: note, body: noteBody },
      {
        num: ap.base.page,
        body: withKey(
          objectBody(ap.base.text, ap.base.page),
          'Annots',
          `[${ref(ap.widget)} ${ref(note)}]`,
        ),
      },
    ],
    file,
    3,
  );
  const bytes = bytesOf(rev.text);
  return {
    bytes,
    expect: signedExpect(bytes, [
      signatureTruth(file, bytes, {
        field: 'Approval',
        mode: 'cades-detached',
        revision: 2,
        byteRange: ap.byteRange,
        cms: ap.cms,
        when: SIGNED_1,
        status: 'intact-changed-later',
        laterChanges: [
          {
            revision: 3,
            kind: 'annotations',
            pages: [1],
            objects: [ref(ap.base.page), ref(note)].sort(),
          },
        ],
      }),
    ]),
  };
}

async function buildSignedThenChanged(built: Map<string, Uint8Array>): Promise<Built> {
  const file = 'signed-then-changed.pdf';
  const ap = await approvalFor(built);
  const stream = streamOf(ap.text, ap.base.content);
  const decoded = inflateSync(stream.data).toString('latin1');
  const from = Buffer.from('The quick brown fox jumps over the lazy dog.', 'latin1')
    .toString('hex')
    .toUpperCase();
  const to = Buffer.from('This sentence was changed after signing.', 'latin1')
    .toString('hex')
    .toUpperCase();
  if (!decoded.includes(from)) throw new Error(`${file}: page 1 sentence not found`);
  const content = decoded.replace(from, to);
  const rev = appendRevision(
    ap.base,
    ap.text,
    [
      {
        num: ap.base.content,
        body: `<<\n/Length ${content.length}\n>>\nstream\n${content}\nendstream`,
      },
    ],
    file,
    3,
  );
  const bytes = bytesOf(rev.text);
  return {
    bytes,
    expect: signedExpect(bytes, [
      signatureTruth(file, bytes, {
        field: 'Approval',
        mode: 'cades-detached',
        revision: 2,
        byteRange: ap.byteRange,
        cms: ap.cms,
        when: SIGNED_1,
        status: 'changed-after-signing',
        laterChanges: [
          { revision: 3, kind: 'content', pages: [1], objects: [ref(ap.base.content)] },
        ],
      }),
    ]),
  };
}

async function buildSignedTwice(built: Map<string, Uint8Array>): Promise<Built> {
  const file = 'signed-twice.pdf';
  const ap = await approvalFor(built);
  const [sig2, wid2] = [ap.base.size + 3, ap.base.size + 4];
  const rev = appendRevision(
    ap.base,
    ap.text,
    [
      { num: sig2, body: sigDict('ETSI.CAdES.detached', SIGNED_2) },
      { num: wid2, body: widget('Second approval', ap.base.page, sig2) },
      { num: ap.acroForm, body: `<<\n/Fields [${ref(ap.widget)} ${ref(wid2)}]\n/SigFlags 3\n>>` },
      {
        num: ap.base.page,
        body: withKey(
          objectBody(ap.base.text, ap.base.page),
          'Annots',
          `[${ref(ap.widget)} ${ref(wid2)}]`,
        ),
      },
    ],
    file,
    3,
  );
  const second = sign(rev.text, sig2, 'cades-detached');
  const bytes = bytesOf(second.text);
  const objects = [ap.acroForm, ap.base.page, sig2, wid2].map(ref).sort();
  return {
    bytes,
    expect: signedExpect(bytes, [
      signatureTruth(file, bytes, {
        field: 'Approval',
        mode: 'cades-detached',
        revision: 2,
        byteRange: ap.byteRange,
        cms: ap.cms,
        when: SIGNED_1,
        status: 'intact-changed-later',
        laterChanges: [{ revision: 3, kind: 'signature', pages: [1], objects }],
      }),
      signatureTruth(file, bytes, {
        field: 'Second approval',
        mode: 'cades-detached',
        revision: 3,
        byteRange: second.byteRange,
        cms: second.cms,
        when: SIGNED_2,
        status: 'intact',
      }),
    ]),
  };
}

function streamOf(text: string, num: number): { start: number; data: Buffer } {
  const objStart = text.indexOf(`\n${num} 0 obj\n`);
  const start = text.indexOf('stream\n', objStart) + 'stream\n'.length;
  const end = text.indexOf('\nendstream', start);
  return { start, data: Buffer.from(text.slice(start, end), 'latin1') };
}

function adler32(data: Uint8Array): number {
  let [a, b] = [1, 0];
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * One bit of page 1's compressed content stream (inside the first signed
 * range) flipped so that "fox" becomes "box"; the stream's Adler-32 is
 * updated so that strict inflaters still decode it.
 */
async function buildSignedTampered(built: Map<string, Uint8Array>): Promise<Built> {
  const file = 'signed-tampered.pdf';
  const ap = await approvalFor(built);
  const { start, data } = streamOf(ap.text, ap.base.content);
  const original = inflateSync(data).toString('latin1');
  const hex = (s: string) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();
  const [textBefore, textAfter] = [
    'The quick brown fox jumps over the lazy dog.',
    'The quick brown box jumps over the lazy dog.',
  ];
  const target = original.replace(hex(textBefore), hex(textAfter));
  let found: { index: number; value: number } | undefined;
  search: for (let i = 2; i < data.length - 4; i++) {
    for (let bit = 0; bit < 8; bit++) {
      const copy = Buffer.from(data);
      copy[i] = (copy[i] ?? 0) ^ (1 << bit);
      let out: string;
      try {
        out = inflateRawSync(copy.subarray(2, copy.length - 4)).toString('latin1');
      } catch {
        continue;
      }
      if (out === target) {
        found = { index: i, value: copy[i] ?? 0 };
        break search;
      }
    }
  }
  if (!found) throw new Error(`${file}: no single-bit edit gives "${textAfter}"`);
  const tampered = Buffer.from(data);
  tampered[found.index] = found.value;
  tampered.writeUInt32BE(adler32(Buffer.from(target, 'latin1')), tampered.length - 4);
  inflateSync(tampered); // must decode cleanly, checksum included
  const bytes = bytesOf(ap.text);
  bytes.set(tampered, start);
  const offset = start + found.index;
  if (offset >= ap.byteRange[1]) throw new Error(`${file}: edit outside the first signed range`);
  const tamper: TamperTruth = {
    offset,
    before: data[found.index] ?? 0,
    after: found.value,
    object: `${ref(ap.base.content)} (page 1 content stream, FlateDecode)`,
    adlerOffset: start + data.length - 4,
    textBefore,
    textAfter,
  };
  return {
    bytes,
    expect: {
      ...signedExpect(bytes, [
        signatureTruth(file, bytes, {
          field: 'Approval',
          mode: 'cades-detached',
          revision: 2,
          byteRange: ap.byteRange,
          cms: ap.cms,
          when: SIGNED_1,
          status: 'broken',
          digest: 'fail',
        }),
      ]),
      tamper,
    },
  };
}

export const P12_PASSWORD = 'test-only';

/**
 * Test PKI files written next to the fixtures (test/fixtures/pki/) and their
 * manifest entries: certificates, the signers' PKCS#8 keys and PKCS#12 files.
 */
export function pkiOutputs(): { files: Map<string, string | Uint8Array>; truth: PkiTruth } {
  const files = new Map<string, string | Uint8Array>();
  const entries: PkiFileTruth[] = [];
  const add = (
    file: string,
    content: string | Uint8Array,
    entry: Omit<PkiFileTruth, 'file' | 'sha256'>,
  ) => {
    files.set(`pki/${file}`, content);
    entries.push({ file: `pki/${file}`, sha256: sha256(content), ...entry });
  };
  const all = [
    party('root-ca'),
    party('intermediate-ca'),
    party('signer-rsa'),
    party('signer-p256'),
  ];
  for (const p of all)
    add(`${p.id}.cert.pem`, pem('CERTIFICATE', p.cert), {
      kind: 'certificate',
      subject: p.subject,
      issuer: p.issuer,
      serial: p.serial,
      keyType: p.id === 'signer-p256' ? 'EC P-256' : 'RSA-2048',
    });
  add(
    'chain.pem',
    chain()
      .map((p) => pem('CERTIFICATE', p.cert))
      .join(''),
    {
      kind: 'certificate-chain',
      subject: party('signer-rsa').subject,
      note: 'signer-rsa, intermediate, root (PEM, in that order)',
    },
  );
  const intermediate = party('intermediate-ca');
  const root = party('root-ca');
  const p12s: { file: string; signer: Party; scheme: P12Scheme; keyType: string }[] = [
    { file: 'signer-rsa.p12', signer: party('signer-rsa'), scheme: 'pbes2', keyType: 'RSA-2048' },
    { file: 'signer-p256.p12', signer: party('signer-p256'), scheme: 'pbes2', keyType: 'EC P-256' },
    {
      file: 'signer-rsa-legacy-3des.p12',
      signer: party('signer-rsa'),
      scheme: 'legacy-3des',
      keyType: 'RSA-2048',
    },
  ];
  for (const s of [party('signer-rsa'), party('signer-p256')])
    add(`${s.id}.key.pem`, readFileSync(join(KEYS_DIR, `${s.id}.key.pem`), 'utf8'), {
      kind: 'private-key',
      subject: s.subject,
      keyType: s.id === 'signer-p256' ? 'EC P-256' : 'RSA-2048',
      note: 'PKCS#8 PEM, unencrypted (copy of tools/fixtures/keys/)',
    });
  for (const p of p12s) {
    const friendlyName = p.signer.commonName;
    add(
      p.file,
      buildP12({
        password: P12_PASSWORD,
        key: p.signer.key,
        certs: [p.signer.cert, intermediate.cert, root.cert],
        friendlyName,
        scheme: p.scheme,
        seed: `pdf-editor-fixture:${p.file}`,
      }),
      {
        kind: 'pkcs12',
        subject: p.signer.subject,
        keyType: p.keyType,
        password: P12_PASSWORD,
        scheme: p.scheme,
        macAlgorithm: p.scheme === 'pbes2' ? 'SHA-256' : 'SHA-1',
        iterations: 2048,
        friendlyName,
        certificates: 3,
        note:
          p.scheme === 'pbes2'
            ? 'OpenSSL 3 default layout: PBES2 (PBKDF2-HMAC-SHA256, AES-256-CBC) for key and certificates; pkijs can open it'
            : 'pbeWithSHAAnd3-KeyTripleDES-CBC for key and certificates, SHA-1 MAC; pkijs cannot decrypt it, so the product refuses it with re-export instructions (spec §3.2)',
      },
    );
  }
  return {
    files,
    truth: {
      $comment:
        'Test-only PKI (tools/fixtures/keys/, lib/pki.ts): nothing here is secret or trusted. Validity starts 2023-01-01.',
      password: P12_PASSWORD,
      files: entries,
    },
  };
}

// ---------------------------------------------------------------------------
// Definitions and README
// ---------------------------------------------------------------------------

const SIGNED_HOW =
  'simple-text.pdf + hand-written incremental update(s); CMS from lib/pki.ts (m5-fixtures.ts)';

export const M5_FIXTURES: FixtureDef[] = [
  {
    file: 'scan-text.pdf',
    tags: ['ocr', 'scan', 'image-only'],
    summary:
      '2 Letter pages, each one 1700x2200 DeviceGray image at 200 dpi and no text: English text in Inter (20/14 pt). Page 1 clean; page 2 skewed 1.5° counter-clockwise with 2500 seeded dust specks.',
    behavior:
      'OCR finds the words in expect.ocr (spec §1.5: ≥ 98 % on page 1), with hit rects within 2 pt of the ink boxes; page 2 needs deskew (rotateAuto). Before OCR, search finds nothing and the page is listed as "no text".',
    howGenerated:
      'Inter outlines rasterised by lib/raster.ts, seeded noise, pdf-lib image XObject (m5-fixtures.ts)',
    build: () =>
      buildScan(
        'scan-text.pdf',
        'Scan fixture: English text',
        'Inter-Regular.ttf',
        SCAN_TEXT_PAGES,
        {
          languages: ['eng'],
        },
      ),
  },
  {
    file: 'scan-turkish.pdf',
    tags: ['ocr', 'scan', 'image-only', 'turkish'],
    summary: `1 Letter page, one 1700x2200 DeviceGray image at 200 dpi: a Turkish pangram, a capitals line and a dotted/dotless i line in Inter (22/16 pt), covering ${TURKISH_LETTERS}.`,
    behavior:
      'OCR with tur finds ≥ 95 % of the words (spec §1.5) and every Turkish letter in some hit; the invisible layer round-trips ı/İ and ğ ş through PDFium and pdf.js.',
    howGenerated:
      'Inter outlines rasterised by lib/raster.ts, pdf-lib image XObject (m5-fixtures.ts)',
    build: () =>
      buildScan(
        'scan-turkish.pdf',
        'Scan fixture: Turkish text',
        'Inter-Regular.ttf',
        SCAN_TURKISH_PAGES,
        {
          languages: ['tur'],
          letters: TURKISH_LETTERS,
        },
      ),
  },
  {
    file: 'scan-rotated.pdf',
    tags: ['ocr', 'scan', 'image-only', 'rotation'],
    summary:
      '1 Letter page with /Rotate 90: one 2200x1700 DeviceGray image at 200 dpi painted sideways (cm 0 792 -612 0 612 0), so the displayed landscape page reads upright. English text in Inter (20/14 pt).',
    behavior:
      'OCR renders the page in display orientation and reads it upright; the invisible layer is written in unrotated user space (expect.ocr boxes) and search hits land on the displayed words.',
    howGenerated:
      'Inter outlines rasterised by lib/raster.ts, pdf-lib image XObject + setRotation (m5-fixtures.ts)',
    build: () =>
      buildScan(
        'scan-rotated.pdf',
        'Scan fixture: rotated page',
        'Inter-Regular.ttf',
        SCAN_ROTATED_PAGES,
        { languages: ['eng'] },
      ),
  },
  {
    file: 'scan-foreign-ocr.pdf',
    tags: ['ocr', 'scan', 'ocr-layer', 'render-mode-3'],
    summary:
      'scan-text page 1 (same pixels) plus another tool\'s invisible text layer: one Helvetica line per text line, 3 Tr, stretched with Tz to the ink width, no /PdfEditorOCR tag, with two deliberate errors ("recognitlon", "Iazy").',
    behavior:
      'ocrPageFacts reports invisibleText "foreign"; search finds the layer\'s words (including the errors); "Replace existing invisible text" removes the 3 Tr objects and the new layer has the correct words; without it the layer is kept.',
    howGenerated: 'scan-text page 1 raster + hand-written 3 Tr content (m5-fixtures.ts)',
    derivedFrom: 'scan-text.pdf',
    build: () =>
      buildScan(
        'scan-foreign-ocr.pdf',
        'Scan fixture: foreign OCR layer',
        'Inter-Regular.ttf',
        SCAN_FOREIGN_PAGES,
        { languages: ['eng'] },
      ),
  },
  {
    file: 'compare-a.pdf',
    tags: ['compare'],
    summary:
      '4 Letter pages (Helvetica, raw content): summary, figures with a 144x96 pt image at (72, 480), an appendix, contacts. Title "Quarterly report". The "before" side of the compare pair.',
    behavior:
      'Compared with itself: no changes. Compared with compare-b.pdf: exactly the changes in expect.compare.',
    howGenerated: 'Hand-written content streams, shared builder with compare-b (m5-fixtures.ts)',
    build: () => buildCompare('a'),
  },
  {
    file: 'compare-b.pdf',
    tags: ['compare'],
    summary:
      'compare-a with one word changed on page 1 (Monday -> Tuesday), the image moved 20 pt right on page 2, page 3 deleted, a new page added at the end and the title changed to "Quarterly report (revised)".',
    behavior:
      'Best-match alignment gives pageMap (a3 deleted, b4 inserted, a4 = b3 unchanged); the text diff reports only Monday -> Tuesday plus the deleted and inserted pages; the pixel diff finds the moved image on page 2; the facts list shows the title change.',
    howGenerated: 'Hand-written content streams, shared builder with compare-a (m5-fixtures.ts)',
    build: () => buildCompare('b'),
  },
  {
    file: 'markdown-source.pdf',
    tags: ['markdown', 'reading-order', 'headings', 'lists', 'columns', 'links'],
    summary:
      '2 Letter pages: H1/H2/H3 in Helvetica-Bold 24/18/14 pt, two 11 pt paragraphs (one line-end hyphen, one URI link), a 3-item bulleted list, an image; page 2 an H2 and a two-column block on shared baselines; running header and page number on both pages.',
    behavior:
      'Converts to expect.markdown.golden: headings by size, list items, the hyphen joined, the link as [text](uri), the image at its position, the left column before the right one, header and page numbers dropped.',
    howGenerated: 'Hand-written content streams + Link annotation (m5-fixtures.ts)',
    build: buildMarkdown,
  },
  {
    file: 'signed-approval.pdf',
    tags: ['signatures', 'pades', 'incremental-update'],
    summary:
      'simple-text.pdf plus one incremental update with an invisible approval signature: /ETSI.CAdES.detached, SHA-256, RSA PKCS#1 v1.5, signingCertificateV2, chain signer -> intermediate -> root in the CMS; the /ByteRange covers the whole file.',
    behavior:
      'Status Intact; every check passes; chain complete to a root included in the file (not trusted).',
    howGenerated: SIGNED_HOW,
    derivedFrom: 'simple-text.pdf',
    build: buildSignedApproval,
  },
  {
    file: 'signed-then-modified.pdf',
    tags: ['signatures', 'pades', 'incremental-update', 'annotations'],
    summary:
      'signed-approval.pdf plus a third revision that adds a /Text note to page 1 (page redefined, new annotation), so the signature no longer covers the whole file.',
    behavior:
      'Status "Intact, changed later": the later change is an annotation (allowed without DocMDP); "View signed version" gives signed-approval.pdf.',
    howGenerated: SIGNED_HOW,
    derivedFrom: 'signed-approval.pdf',
    build: buildSignedThenModified,
  },
  {
    file: 'signed-then-changed.pdf',
    tags: ['signatures', 'pades', 'incremental-update'],
    summary:
      "signed-approval.pdf plus a third revision that redefines page 1's content stream (the fox sentence replaced, uncompressed).",
    behavior: 'Status "Changed after signing", page 1; the signed revision still verifies.',
    howGenerated: SIGNED_HOW,
    derivedFrom: 'signed-approval.pdf',
    build: buildSignedThenChanged,
  },
  {
    file: 'signed-tampered.pdf',
    tags: ['signatures', 'pades', 'tampered'],
    summary:
      'signed-approval.pdf with one bit flipped inside the first signed range: page 1 now reads "brown box" instead of "brown fox" (compressed stream, Adler-32 fixed so it still inflates).',
    behavior:
      'Status Broken (digest mismatch); the CMS signature itself still verifies over its signed attributes.',
    howGenerated: 'Byte surgery on signed-approval.pdf (m5-fixtures.ts)',
    derivedFrom: 'signed-approval.pdf',
    build: buildSignedTampered,
  },
  {
    file: 'signed-twice.pdf',
    tags: ['signatures', 'pades', 'incremental-update'],
    summary:
      'signed-approval.pdf plus a third revision with a second approval signature (claimed 2024-01-02) covering the whole file.',
    behavior: 'First signature "Intact, changed later" (a signature was added); second Intact.',
    howGenerated: SIGNED_HOW,
    derivedFrom: 'signed-approval.pdf',
    build: buildSignedTwice,
  },
  {
    file: 'signed-sha1.pdf',
    tags: ['signatures', 'pkcs7', 'sha1'],
    summary:
      'Like signed-approval.pdf but /adbe.pkcs7.sha1: the SHA-1 of the ranges is the encapsulated content; SHA-1 signed attributes.',
    behavior:
      'Status Intact with the digest flagged weak (SHA-1); messageDigest is checked against the encapsulated digest.',
    howGenerated: SIGNED_HOW,
    derivedFrom: 'simple-text.pdf',
    build: buildSignedSha1,
  },
  {
    file: 'signed-empty-field.pdf',
    tags: ['signatures', 'pades', 'acroform'],
    summary:
      'simple-text.pdf plus a revision with two /Sig fields: "Reviewer" (unsigned, visible box, listed first) and "Approval" (signed, whole file).',
    behavior:
      'listFormFields pairs signatures by /V: Reviewer is an empty signature field, Approval is Intact (the M4 count-based pairing got this wrong).',
    howGenerated: SIGNED_HOW,
    derivedFrom: 'simple-text.pdf',
    build: buildSignedEmptyField,
  },
];

function fmtBox(b: Box | undefined): string {
  return b ? `[${b.join(', ')}]` : '-';
}

const esc = (s: string) => s.replaceAll('|', '\\|');

export function renderM5Readme(entries: ManifestEntry[], pki: PkiTruth): string {
  const byFile = new Map(entries.map((e) => [e.file, e]));
  const get = (file: string) => {
    const e = byFile.get(file);
    if (!e) throw new Error(`${file} missing`);
    return e.expect;
  };

  const ocrFiles = [
    'scan-text.pdf',
    'scan-turkish.pdf',
    'scan-rotated.pdf',
    'scan-foreign-ocr.pdf',
  ];
  const ocr = ocrFiles.map((file) => {
    const o = get(file).ocr;
    const rows = (o?.pages ?? []).flatMap((p) =>
      p.lines.map(
        (l) =>
          `| ${p.page} | ${esc(l.text)} | ${l.fontSize} | ${l.baseline} | ${fmtBox(l.box)} | ${p.rotate} | ${p.skewDegrees}° | ${p.noise ? `${p.noise.specks} specks` : '-'} |`,
      ),
    );
    const layer = (o?.pages ?? []).flatMap((p) =>
      p.foreignLayer
        ? [
            '',
            `Foreign layer on page ${p.page}: ${p.foreignLayer.font}, ${p.foreignLayer.renderMode} Tr, one text object per line at the line's ink x and baseline, Tz ${p.foreignLayer.lines.map((l) => l.horizontalScale).join(' / ')}; deliberate errors ${p.foreignLayer.errors.map((e) => `"${e.expected}" -> "${e.actual}"`).join(', ')}.`,
          ]
        : [],
    );
    return [
      `#### \`${file}\` (languages: ${o?.languages.join(', ') ?? ''})`,
      '',
      '| page | line | size | baseline (display) | ink box (user space) | /Rotate | skew | noise |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows,
      ...layer,
    ].join('\n');
  });

  const sigRows = entries
    .filter((e) => e.expect.signatures)
    .flatMap((e) =>
      (e.expect.signatures ?? []).map(
        (s) =>
          `| \`${e.file}\` | ${s.field} | ${s.subFilter ?? '-'} | ${s.revision ?? '-'} | ${s.byteRange ? `[${s.byteRange.join(' ')}]` : '-'} | ${s.coversWholeFile === undefined ? '-' : s.coversWholeFile ? 'yes' : 'no'} | ${s.digestAlgorithm ?? '-'} | **${s.status}** |`,
      ),
    );
  const revRows = entries
    .filter((e) => e.expect.revisions)
    .map((e) => {
      const r = e.expect.revisions;
      return `| \`${e.file}\` | ${r?.count ?? 0} | ${r?.ends.join(', ') ?? ''} | ${
        (e.expect.signatures ?? [])
          .flatMap((s) => s.laterChanges ?? [])
          .map((l) => `rev ${l.revision}: ${l.kind} (${l.objects.join(', ')})`)
          .join('; ') || '-'
      } |`;
    });
  const tamper = get('signed-tampered.pdf').tamper;
  const signer = party('signer-rsa');

  const cmp = get('compare-b.pdf').compare;
  const cmpRows = (cmp?.changes ?? []).map((c) => {
    switch (c.kind) {
      case 'text-changed':
        return `| text changed | a${c.aPage} / b${c.bPage} | "${c.a.text}" ${fmtBox(c.a.box)} -> "${c.b.text}" ${fmtBox(c.b.box)} |`;
      case 'image-moved':
        return `| image moved | a${c.aPage} / b${c.bPage} | /${c.resource} ${fmtBox(c.a)} -> ${fmtBox(c.b)} (dx ${c.delta[0]}, dy ${c.delta[1]}) |`;
      case 'page-deleted':
        return `| page deleted | a${c.aPage} | "${c.heading}", ${c.words} words |`;
      case 'page-inserted':
        return `| page inserted | b${c.bPage} | "${c.heading}", ${c.words} words |`;
      default:
        return `| metadata | - | /${c.key}: "${c.a}" -> "${c.b}" |`;
    }
  });
  const pageMap = (cmp?.pageMap ?? []).map((p) => `${p.a ?? '-'}:${p.b ?? '-'}`).join(', ');

  const md = get('markdown-source.pdf').markdown;
  const mdRows = (md?.blocks ?? []).map((b) => {
    const what =
      b.kind === 'heading'
        ? `H${b.level} ${b.fontSize} pt`
        : b.kind === 'paragraph' && b.column
          ? `paragraph (${b.column} column)`
          : b.kind;
    const text = b.kind === 'image' ? `/${b.resource}` : b.text;
    return `| ${b.page} | ${what} | ${esc(text)} | ${fmtBox(b.box)} |`;
  });

  return `## Recognize-and-compare fixtures (M5)

Coordinates are unrotated user space in points, boxes \`[x, y, width, height]\`.
Everything below is also in \`manifest.json\` (\`expect.ocr\`, \`expect.signatures\`,
\`expect.revisions\`, \`expect.tamper\`, \`expect.compare\`, \`expect.markdown\`).
Batch recipes (spec §5) need no fixtures of their own: the batch tests run over
existing files (\`simple-text\`, \`rotated-pages\`, \`mixed-sizes\`, \`images\`,
\`encrypted-*\`, \`xfa-stub\`, \`scan-text\`, ...), so there is no \`batch-set/\`.

### OCR scans

Each page holds one 8-bit DeviceGray image (FlateDecode, ${SCAN_DPI} dpi: 1700x2200 px
on portrait pages, 2200x1700 px on the \`/Rotate 90\` page, whose image is painted
sideways so the displayed page reads upright) over the whole Letter MediaBox and
no visible text. The text is drawn by \`tools/fixtures/lib/raster.ts\`: Inter
Regular glyph outlines from fontkit, flattened with a fixed number of segments,
filled non-zero with 16 sub-scanlines of anti-aliasing, so the pixels are identical
on every machine; no renderer is involved and no PNGs are committed (rerunning the
generator reproduces the images). Page 2 of \`scan-text.pdf\` is rotated 1.5°
counter-clockwise about the page centre (lines rise to the right) and carries 2500
seeded dust specks (1-2 px, 25-70 % grey). \`expect.ocr.pages[].words\` lists every
word (punctuation attached) with its ink box in unrotated user space (\`box\`, union
of the glyph bounding boxes; on the skewed page the axis-aligned bounds of the
rotated box) and in image pixels (\`px\`, top-left origin, display orientation);
\`text\` is the exact ground truth (lines joined with a newline). The spec's
\`scan-simple\` (300 dpi from simple-text) and \`scan-skewed\` are covered by
\`scan-text.pdf\` pages 1 and 2 at 200 dpi.

${ocr.join('\n\n')}

### Signatures

Signed files are \`simple-text.pdf\` byte for byte plus hand-written incremental
updates (classic xref sections, \`/Prev\`), so revision 1 is always simple-text.
The CMS is built by \`tools/fixtures/lib/pki.ts\` (its own DER code, independent
of the product's signer): SignedData v1, signer identified by issuer and serial,
signed attributes contentType, messageDigest and (CAdES) signingCertificateV2,
**no signingTime** (PAdES), RSASSA-PKCS1-v1_5 with SHA-256 (SHA-1 for
\`adbe.pkcs7.sha1\`), and the three certificates. RSA PKCS#1 v1.5 signatures are
deterministic, so rebuilding gives the same bytes. \`/Contents\` reserves
${SIG_HEX} hex digits (zero-padded after the DER); \`/M\` is the claimed time
(2024-01-01, the second signature 2024-01-02); \`/Reason\` is "${REASON}".

**Test PKI (test-only, not trusted by anything).** The keys (RSA-2048 root,
intermediate and signer; an EC P-256 signer) are committed in
\`tools/fixtures/keys/\`; \`lib/pki.ts\` builds the certificates from them (fixed
serials, validity from 2023-01-01, every certificate RSA-signed so the bytes are
reproducible) and \`lib/p12.ts\` writes PKCS#12 files with salts and IVs derived
from the file name. Signer: \`${signer.subject}\`, serial ${signer.serial}, issued by
\`${signer.issuer}\`; validity ${signer.notBefore.slice(0, 10)} to ${signer.notAfter.slice(0, 10)};
key usage digitalSignature + nonRepudiation (critical), CA:FALSE. No fixture is
signed with the P-256 key (ECDSA signatures are randomised); it is there for
signing tests. \`manifest.json\` \`pki\` lists every file with its sha256.

| file | kind | subject / contents | password, scheme |
| --- | --- | --- | --- |
${pki.files.map((f) => `| \`${f.file}\` | ${f.kind}${f.keyType ? ` (${f.keyType})` : ''} | ${esc(f.note ?? f.subject ?? '')} | ${f.password ? `\`${f.password}\`, ${f.scheme ?? ''}, MAC ${f.macAlgorithm ?? ''}, ${f.iterations ?? ''} iterations` : '-'} |`).join('\n')}

Cross-check a signature with OpenSSL: extract the \`/Contents\` hex (trailing zeros
removed) to \`sig.der\` and the two ranges to \`data.bin\`, then \`openssl cms -verify
-inform DER -in sig.der -binary -content data.bin -CAfile
test/fixtures/pki/root-ca.cert.pem -purpose any\` (for \`adbe.pkcs7.sha1\` omit
\`-content\`: the output is the encapsulated SHA-1 of the ranges). PKCS#12:
\`openssl pkcs12 -info -in test/fixtures/pki/signer-rsa.p12 -passin pass:${pki.password} -noenc\`.

| file | field | /SubFilter | revision | /ByteRange | whole file | digest | expected status |
| --- | --- | --- | --- | --- | --- | --- | --- |
${sigRows.join('\n')}

| file | revisions | revision ends (bytes) | later changes |
| --- | --- | --- | --- |
${revRows.join('\n')}

\`signed-tampered.pdf\`: byte ${tamper?.offset} (inside the first range) changed from
0x${tamper?.before.toString(16)} to 0x${tamper?.after.toString(16)} in ${tamper?.object}, turning "${tamper?.textBefore}"
into "${tamper?.textAfter}"; the stream's Adler-32 at byte ${tamper?.adlerOffset} is updated so the
stream inflates cleanly. The digest check fails; the signature over the signed
attributes still verifies.

Revision ends include the newline after each \`%%EOF\` (simple-text.pdf itself has
none, so revision 1 is its ${(get('signed-approval.pdf').revisions?.ends[0] ?? 1) - 1} bytes plus the newline the update starts with).
The spec's \`signed-pades\` and \`signed-then-annotated\` are \`signed-approval.pdf\` and
\`signed-then-modified.pdf\`. Cross-checks while building: OpenSSL 3.0 \`cms -verify\`
accepts every signature except the tampered one (content verification failure),
pkijs 3.4.1 verifies the CMS (tampered: "Message digest doesn't match"), opens both
PBES2 \`.p12\` files and rejects the 3DES one ("Unknown contentEncryptionAlgorithm"),
and PDFium reads every /ByteRange, /SubFilter and /M. PDFium's
\`FPDF_GetSignatureCount\` counts the unsigned "Reviewer" field of
\`signed-empty-field.pdf\` as a signature with an empty byte range (2, not 1).

### Compare pair

Page map (a:b) ${pageMap}; pages a4 and b3 are byte-identical content. Nothing else differs
(dates, fonts, image bytes and all other text are shared; only the trailer /ID
differs, as for every fixture). This follows the fixture brief (one changed word,
no page-size change); spec §2.3 also mentions three changed words and an enlarged
page, which are not in this pair.

| change | pages | detail |
| --- | --- | --- |
${cmpRows.join('\n')}

### Markdown source

Body 11 pt Helvetica; headings Helvetica-Bold ${md?.headingSizes['1']}/${md?.headingSizes['2']}/${md?.headingSizes['3']} pt. Dropped: the running header
"${MD.header}" (9 pt at y 752) and the page numbers "Page 1", "Page 2" (9 pt, centred at y 40).
The two columns on page 2 share baselines (left x 72, right x 324), so a
line-by-line reader interleaves them. Each page's content stream draws the header
and the page number first, so content order is not reading order (PDFium's
\`FPDFText_GetText\` returns "Page 1" as the second line). The line-end hyphen of
"gener-" comes out of PDFium as U+FFFE (its soft-hyphen marker) followed by the
next line.

| page | block | text | box |
| --- | --- | --- | --- |
${mdRows.join('\n')}

Expected Markdown (\`expect.markdown.golden\`, default options, page breaks as nothing):

\`\`\`markdown
${md?.golden.trimEnd() ?? ''}
\`\`\`
`;
}
