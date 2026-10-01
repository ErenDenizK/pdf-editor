/**
 * Milestone M7 demo fixtures (docs/specs/presentation.md §2.2): four fictional documents
 * that the README GIFs and the about page are recorded from, so they have to look like
 * finished documents rather than test scaffolding.
 *
 *   demo/demo-report-v1.pdf, demo/demo-report-v2.pdf  annual report of a fictional club
 *   demo/demo-agreement.pdf                           room-hire agreement with a form
 *   demo/demo-letter-scan.pdf                         a letter "scanned" in greyscale
 *
 * The club, people, addresses and figures are invented; the e-mail uses example.com, the
 * phone number is in Ofcom's range reserved for drama (020 7946 0xxx), and the IBAN is
 * the documentation example GB82 WEST 1234 5698 7654 32. Every page says "Demo document,
 * fictional data". Text is set in subsets of the bundled OFL fonts (Inter, Noto Serif);
 * charts and the cover illustration are pdf-lib path operators; the scan is rasterised
 * by lib/raster.ts from Inter's glyph outlines. Determinism follows the rest of the
 * corpus (fixed dates, /ID from the file name, seeded PRNG for the scan noise).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  type PDFDocument,
  type PDFFont,
  PDFHexString,
  type PDFOperator,
  type PDFPage,
  type PDFRef,
  PDFString,
  appendBezierCurve,
  beginText,
  closePath,
  endText,
  fill,
  fillAndStroke,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setDashPattern,
  setFillingRgbColor,
  setFontAndSize,
  setLineCap,
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  showText,
  stroke,
} from '@cantoo/pdf-lib';
import { A4, type Built, type FixtureDef, box, name, newDoc, round2, save } from './lib/build.ts';
import {
  type Box,
  type DemoChangeTruth,
  type DemoChartTruth,
  type DemoCompareTruth,
  type DemoHeadingTruth,
  type DemoLineTruth,
  type DemoSensitiveTruth,
  type DemoTableTruth,
  type FieldExpectation,
  type ManifestEntry,
  type OcrLineTruth,
  type OcrMarkTruth,
  type OcrPageTruth,
  type OcrWordTruth,
  type OutlineExpectation,
  type PageExpectation,
  REPO_ROOT,
  seededRandom,
} from './lib/common.ts';
import { Canvas, type PathCommand } from './lib/raster.ts';

export const DEMO_FOOTER = 'Demo document, fictional data';
const CLUB = 'Harbourlight Rowing Club';
const FONT_DIR = join(REPO_ROOT, 'packages', 'engine', 'assets', 'fonts');
const [PAGE_W, PAGE_H] = A4;
const A4_BOX = box(0, 0, PAGE_W, PAGE_H);
const MARGIN = { left: 64, right: 64 };
const RIGHT = PAGE_W - MARGIN.right;
const CONTENT_W = RIGHT - MARGIN.left;

const REPORT = {
  a: 'demo/demo-report-v1.pdf',
  b: 'demo/demo-report-v2.pdf',
  title: 'Harbourlight Rowing Club: Annual Report 2024',
};
const AGREEMENT = 'demo/demo-agreement.pdf';
const LETTER_SCAN = 'demo/demo-letter-scan.pdf';
const IBAN = 'GB82 WEST 1234 5698 7654 32';
const EMAIL = 'elena.marsh@example.com';
const PHONE = '+44 20 7946 0958';

// ---------------------------------------------------------------------------
// Colours and fonts
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];
const INK: Rgb = [0.12, 0.14, 0.18];
const NAVY: Rgb = [0.09, 0.2, 0.33];
const NAVY_DARK: Rgb = [0.05, 0.13, 0.23];
const TEAL: Rgb = [0.11, 0.47, 0.51];
const TEAL_LIGHT: Rgb = [0.6, 0.82, 0.83];
const MUTED: Rgb = [0.4, 0.43, 0.48];
const RULE: Rgb = [0.82, 0.84, 0.87];
const PALE: Rgb = [0.945, 0.955, 0.968];
const WHITE: Rgb = [1, 1, 1];
const GREY_SERIES: Rgb = [0.6, 0.63, 0.68];

type FaceId = 'sans' | 'bold' | 'serif';

/** Fixed resource names and subset tags, so both report versions write the same bytes. */
const FACES: Record<FaceId, { file: string; key: string; tag: string }> = {
  sans: { file: 'Inter-Regular.ttf', key: 'F1', tag: 'DEMOAA' },
  bold: { file: 'Inter-Bold.ttf', key: 'F2', tag: 'DEMOAB' },
  serif: { file: 'NotoSerif-Regular.ttf', key: 'F3', tag: 'DEMOAC' },
};

/**
 * Glyphs every subset gets up front, in this order: printable ASCII, the typographic
 * characters the prose uses, and the ligatures and contextual forms fontkit substitutes.
 * Fixing the subset (a) gives glyph ids that do not depend on which text comes first, so
 * the pages v1 and v2 share are byte-identical, and (b) lets the text-edit clip change
 * "2024" to "2025" (or any ASCII edit) in the same font.
 */
const CHARSET = `${Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')}£–—‘’“”•·×…`;
const PRESET_RUNS = ['ff', 'fi', 'fl', 'ffi', 'ffl', '0:0', '1:1', '18:00', '23:00', '22:30'];

interface FkGlyph {
  id: number;
  codePoints: number[];
  advanceWidth: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  path: { commands: PathCommand[] };
}
interface FkFont {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  postscriptName: string;
  layout(text: string): {
    glyphs: FkGlyph[];
    positions: { xAdvance: number; xOffset: number; yOffset: number }[];
  };
}
type Fontkit = Parameters<PDFDocument['registerFontkit']>[0];

/** @cantoo/fontkit, resolved from the engine package (as in m4-fixtures.ts). */
function loadFontkit(): Fontkit {
  const require = createRequire(join(REPO_ROOT, 'packages', 'engine', 'package.json'));
  return require('@cantoo/fontkit') as Fontkit;
}

function openFont(file: string): FkFont {
  const fontkit = loadFontkit() as unknown as { create(bytes: Uint8Array): FkFont };
  return fontkit.create(new Uint8Array(readFileSync(join(FONT_DIR, file))));
}

interface Face {
  id: FaceId;
  key: string;
  font: PDFFont;
  /** BaseFont without the subset tag. */
  postscript: string;
  /** Ascender and descender per unit of font size (descent is negative). */
  ascent: number;
  descent: number;
  /** Glyphs in the subset (pdf-lib's embedder), to prove the preset covered everything. */
  glyphCount: () => number;
}

interface SubsetEmbedder {
  font: FkFont;
  glyphs: unknown[];
}

async function embedFaces(doc: PDFDocument, ids: FaceId[]): Promise<Record<FaceId, Face>> {
  doc.registerFontkit(loadFontkit());
  const faces = {} as Record<FaceId, Face>;
  for (const id of ids) {
    const spec = FACES[id];
    const bytes = new Uint8Array(readFileSync(join(FONT_DIR, spec.file)));
    const probe = openFont(spec.file);
    const font = await doc.embedFont(bytes, {
      subset: true,
      customName: `${spec.tag}+${probe.postscriptName}`,
      // Inter's contextual alternates swap "-", "+" and brackets for raised forms next to
      // capitals and digits; off, so the preset covers every glyph the text can use.
      features: { calt: false },
    });
    const embedder = (font as unknown as { embedder: SubsetEmbedder }).embedder;
    for (const ch of CHARSET) font.encodeText(ch);
    for (const run of PRESET_RUNS) font.encodeText(run);
    faces[id] = {
      id,
      key: spec.key,
      font,
      postscript: probe.postscriptName,
      ascent: probe.ascent / probe.unitsPerEm,
      descent: probe.descent / probe.unitsPerEm,
      glyphCount: () => embedder.glyphs.length,
    };
  }
  return faces;
}

// ---------------------------------------------------------------------------
// Typesetting
// ---------------------------------------------------------------------------

interface Style {
  face: FaceId;
  size: number;
  color: Rgb;
}

const r2 = round2;

/**
 * Writes text and paths straight into page content streams with fixed font resource
 * names (pdf-lib's drawText adds a new /Font key on every font switch) and records every
 * line it draws, which becomes the manifest's ground truth.
 */
class Setter {
  readonly drawn: DemoLineTruth[] = [];
  /** Uncompressed operators per page, to find the pages two versions share. */
  readonly log = new Map<number, string[]>();
  readonly faces: Record<FaceId, Face>;
  private readonly presetCounts: Map<FaceId, number>;

  constructor(faces: Record<FaceId, Face>) {
    this.faces = faces;
    this.presetCounts = new Map(Object.values(faces).map((f) => [f.id, f.glyphCount()]));
  }

  face(id: FaceId): Face {
    return this.faces[id];
  }

  width(style: Pick<Style, 'face' | 'size'>, value: string): number {
    return this.face(style.face).font.widthOfTextAtSize(value, style.size);
  }

  /** Registers the fonts under their fixed names on a new page. */
  prepare(page: PDFPage): void {
    for (const f of Object.values(this.faces)) page.node.setFontDictionary(name(f.key), f.font.ref);
  }

  push(page: PDFPage, pageNo: number, ...ops: PDFOperator[]): void {
    page.pushOperators(...ops);
    const log = this.log.get(pageNo) ?? [];
    log.push(...ops.map((op) => op.toString()));
    this.log.set(pageNo, log);
  }

  text(
    page: PDFPage,
    pageNo: number,
    style: Style,
    x: number,
    y: number,
    value: string,
    align: 'left' | 'right' | 'center' = 'left',
  ): DemoLineTruth {
    const face = this.face(style.face);
    const width = this.width(style, value);
    const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
    this.push(
      page,
      pageNo,
      setFillingRgbColor(...style.color),
      beginText(),
      setFontAndSize(face.key, style.size),
      setTextMatrix(1, 0, 0, 1, r2(left), r2(y)),
      showText(face.font.encodeText(value)),
      endText(),
    );
    const line: DemoLineTruth = {
      page: pageNo,
      text: value,
      font: face.postscript,
      size: style.size,
      x: r2(left),
      baseline: r2(y),
      box: this.textBox(style, left, y, value),
    };
    this.drawn.push(line);
    return line;
  }

  textBox(style: Pick<Style, 'face' | 'size'>, x: number, y: number, value: string): Box {
    const face = this.face(style.face);
    return box(
      x,
      y + face.descent * style.size,
      this.width(style, value),
      (face.ascent - face.descent) * style.size,
    );
  }

  /** Greedy word wrap; `keep` phrases (IBAN, phone) never break across lines. */
  wrap(
    style: Pick<Style, 'face' | 'size'>,
    value: string,
    width: number,
    keep: string[] = [],
  ): string[] {
    let protectedText = value;
    for (const phrase of keep)
      protectedText = protectedText.replace(phrase, phrase.replaceAll(' ', '\u0000'));
    const words = protectedText.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && this.width(style, candidate.replaceAll('\u0000', ' ')) > width) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    return lines.map((l) => l.replaceAll('\u0000', ' '));
  }

  /** Throws if any text drew a glyph outside the preset subset (ids would then shift). */
  assertPresetCovered(): void {
    for (const f of Object.values(this.faces)) {
      const before = this.presetCounts.get(f.id);
      if (f.glyphCount() !== before)
        throw new Error(
          `${f.postscript}: text used glyphs outside the preset (${before} -> ${f.glyphCount()})`,
        );
    }
  }
}

function union(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return box(x0, y0, x1 - x0, y1 - y0);
}

// Path helpers (pdf-lib operators). Coordinates are rounded so streams stay short.

function fillRect(x: number, y: number, w: number, h: number, color: Rgb): PDFOperator[] {
  return [setFillingRgbColor(...color), rectangle(r2(x), r2(y), r2(w), r2(h)), fill()];
}

function strokeLine(
  points: [number, number][],
  color: Rgb,
  width: number,
  dash?: number[],
  roundCap = false,
): PDFOperator[] {
  const [first, ...rest] = points;
  if (!first) return [];
  return [
    pushGraphicsState(),
    setStrokingRgbColor(...color),
    setLineWidth(width),
    ...(dash ? [setDashPattern(dash, 0)] : []),
    ...(roundCap ? [setLineCap(1)] : []),
    moveTo(r2(first[0]), r2(first[1])),
    ...rest.map(([x, y]) => lineTo(r2(x), r2(y))),
    stroke(),
    popGraphicsState(),
  ];
}

function fillPolygon(points: [number, number][], color: Rgb): PDFOperator[] {
  const [first, ...rest] = points;
  if (!first) return [];
  return [
    setFillingRgbColor(...color),
    moveTo(r2(first[0]), r2(first[1])),
    ...rest.map(([x, y]) => lineTo(r2(x), r2(y))),
    closePath(),
    fill(),
  ];
}

/** Circle as four Bézier arcs. */
function circlePath(cx: number, cy: number, r: number): PDFOperator[] {
  const k = 0.5523 * r;
  return [
    moveTo(r2(cx + r), r2(cy)),
    appendBezierCurve(r2(cx + r), r2(cy + k), r2(cx + k), r2(cy + r), r2(cx), r2(cy + r)),
    appendBezierCurve(r2(cx - k), r2(cy + r), r2(cx - r), r2(cy + k), r2(cx - r), r2(cy)),
    appendBezierCurve(r2(cx - r), r2(cy - k), r2(cx - k), r2(cy - r), r2(cx), r2(cy - r)),
    appendBezierCurve(r2(cx + k), r2(cy - r), r2(cx + r), r2(cy - k), r2(cx + r), r2(cy)),
    closePath(),
  ];
}

/** A smooth band from `bottom` up to a wavy top edge (cubic segments of `period` width). */
function waveBand(
  bottom: number,
  top: number,
  amplitude: number,
  period: number,
  phase: number,
  color: Rgb,
): PDFOperator[] {
  const ops: PDFOperator[] = [setFillingRgbColor(...color), moveTo(0, r2(bottom))];
  let x = -phase;
  ops.push(lineTo(r2(x), r2(top)));
  let up = true;
  while (x < PAGE_W) {
    const half = period / 2;
    const y = top + (up ? amplitude : -amplitude);
    ops.push(
      appendBezierCurve(
        r2(x + half * 0.35),
        r2(y),
        r2(x + half * 0.65),
        r2(y),
        r2(x + half),
        r2(top),
      ),
    );
    x += half;
    up = !up;
  }
  ops.push(lineTo(r2(x), r2(bottom)), closePath(), fill());
  return ops;
}

// ---------------------------------------------------------------------------
// Document furniture shared by the report and the agreement
// ---------------------------------------------------------------------------

const STYLE = {
  body: { face: 'serif', size: 10.5, color: INK },
  h1: { face: 'bold', size: 24, color: NAVY },
  h2: { face: 'bold', size: 12, color: NAVY },
  kicker: { face: 'bold', size: 8.5, color: TEAL },
  small: { face: 'sans', size: 7.5, color: MUTED },
  label: { face: 'sans', size: 8.5, color: MUTED },
  caption: { face: 'sans', size: 8, color: MUTED },
} satisfies Record<string, Style>;
const BODY_LEADING = 15.5;
const PARAGRAPH_GAP = 7;
const FLOW_BOTTOM = 72;

function footer(set: Setter, page: PDFPage, pageNo: number, right: string): void {
  set.push(
    page,
    pageNo,
    ...strokeLine(
      [
        [MARGIN.left, 50],
        [RIGHT, 50],
      ],
      RULE,
      0.5,
    ),
  );
  set.text(page, pageNo, STYLE.small, MARGIN.left, 36, DEMO_FOOTER);
  if (right) set.text(page, pageNo, STYLE.small, RIGHT, 36, right, 'right');
}

function runningHeader(
  set: Setter,
  page: PDFPage,
  pageNo: number,
  left: string,
  right: string,
): void {
  set.text(page, pageNo, STYLE.small, MARGIN.left, PAGE_H - 40, left);
  set.text(page, pageNo, STYLE.small, RIGHT, PAGE_H - 40, right, 'right');
  set.push(
    page,
    pageNo,
    ...strokeLine(
      [
        [MARGIN.left, PAGE_H - 48],
        [RIGHT, PAGE_H - 48],
      ],
      RULE,
      0.5,
    ),
  );
}

/** Vertical text flow on one page: paragraphs, subheadings and bullet lists. */
class Flow {
  y: number;
  readonly headings: DemoHeadingTruth[];
  private readonly set: Setter;
  private readonly page: PDFPage;
  private readonly pageNo: number;

  constructor(
    set: Setter,
    page: PDFPage,
    pageNo: number,
    top: number,
    headings: DemoHeadingTruth[],
  ) {
    this.set = set;
    this.page = page;
    this.pageNo = pageNo;
    this.y = top;
    this.headings = headings;
  }

  private check(): void {
    if (this.y < FLOW_BOTTOM) throw new Error(`page ${this.pageNo}: text runs into the footer`);
  }

  paragraph(
    value: string,
    opts: { style?: Style; x?: number; width?: number; keep?: string[]; leading?: number } = {},
  ): { lines: DemoLineTruth[]; box: Box } {
    const style = opts.style ?? STYLE.body;
    const x = opts.x ?? MARGIN.left;
    const leading = opts.leading ?? BODY_LEADING;
    const lines = this.set.wrap(style, value, opts.width ?? CONTENT_W, opts.keep);
    const drawn = lines.map((line, i) =>
      this.set.text(this.page, this.pageNo, style, x, this.y - i * leading, line),
    );
    this.y -= lines.length * leading + PARAGRAPH_GAP;
    this.check();
    return { lines: drawn, box: union(drawn.map((d) => d.box)) };
  }

  heading(value: string): void {
    this.y -= 8;
    const line = this.set.text(this.page, this.pageNo, STYLE.h2, MARGIN.left, this.y, value);
    this.headings.push({
      page: this.pageNo,
      level: 2,
      text: value,
      size: STYLE.h2.size,
      box: line.box,
    });
    this.y -= 21;
  }

  bullets(items: string[]): void {
    for (const item of items) {
      const lines = this.set.wrap(STYLE.body, item, CONTENT_W - 16);
      this.set.push(
        this.page,
        this.pageNo,
        setFillingRgbColor(...TEAL),
        ...circlePath(MARGIN.left + 4, this.y + 3.4, 2),
        fill(),
      );
      lines.forEach((line, i) =>
        this.set.text(
          this.page,
          this.pageNo,
          STYLE.body,
          MARGIN.left + 16,
          this.y - i * BODY_LEADING,
          line,
        ),
      );
      this.y -= lines.length * BODY_LEADING + 4;
    }
    this.y -= PARAGRAPH_GAP - 4;
    this.check();
  }

  space(points: number): void {
    this.y -= points;
  }
}

// ---------------------------------------------------------------------------
// Outline, named destinations, page labels
// ---------------------------------------------------------------------------

interface OutlineNode {
  title: string;
  dest: string;
  page: number;
  children?: OutlineNode[];
}

/** Writes /Outlines with every item pointing at a named destination (string form). */
function writeOutline(
  doc: PDFDocument,
  items: OutlineNode[],
): { expect: OutlineExpectation[]; visible: number } {
  const ctx = doc.context;
  const level = (nodes: OutlineNode[], parent: PDFRef) => {
    const refs = nodes.map(() => ctx.nextRef());
    const expect: OutlineExpectation[] = [];
    let visible = 0;
    nodes.forEach((node, i) => {
      const ref = refs[i];
      if (!ref) return;
      const dict = ctx.obj({
        Title: PDFHexString.fromText(node.title),
        Parent: parent,
        Dest: PDFString.of(node.dest),
      });
      const prev = refs[i - 1];
      const next = refs[i + 1];
      if (prev) dict.set(name('Prev'), prev);
      if (next) dict.set(name('Next'), next);
      const item: OutlineExpectation = {
        title: node.title,
        page: node.page,
        target: 'named-dest-string',
        destName: node.dest,
      };
      if (node.children?.length) {
        const sub = level(node.children, ref);
        dict.set(name('First'), sub.first);
        dict.set(name('Last'), sub.last);
        dict.set(name('Count'), ctx.obj(sub.visible));
        visible += sub.visible;
        item.open = true;
        item.children = sub.expect;
      }
      visible += 1;
      ctx.assign(ref, dict);
      expect.push(item);
    });
    const first = refs[0];
    const last = refs[refs.length - 1];
    if (!first || !last) throw new Error('empty outline level');
    return { first, last, visible, expect };
  };
  const root = ctx.nextRef();
  const top = level(items, root);
  ctx.assign(
    root,
    ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.visible }),
  );
  doc.catalog.set(name('Outlines'), root);
  return { expect: top.expect, visible: top.visible };
}

interface DestSpec {
  name: string;
  page: number;
  top: number;
}

/** /Names /Dests name tree (keys sorted) with /XYZ destinations. */
function writeNamedDests(doc: PDFDocument, dests: DestSpec[]): void {
  const pages = doc.getPages();
  const sorted = [...dests].sort((a, b) => (a.name < b.name ? -1 : 1));
  const names = sorted.flatMap((d) => {
    const page = pages[d.page - 1];
    if (!page) throw new Error(`dest ${d.name}: no page ${d.page}`);
    return [PDFString.of(d.name), doc.context.obj([page.ref, name('XYZ'), 0, r2(d.top), null])];
  });
  doc.catalog.set(
    name('Names'),
    doc.context.obj({ Dests: doc.context.obj({ Names: doc.context.obj(names) }) }),
  );
}

function addLink(doc: PDFDocument, page: PDFPage, rect: Box, dest: string): void {
  const [x, y, w, h] = rect;
  const ref = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [r2(x), r2(y), r2(x + w), r2(y + h)],
      Border: [0, 0, 0],
      Dest: PDFString.of(dest),
      P: page.ref,
    }),
  );
  page.node.addAnnot(ref);
}

function pageExpects(count: number): PageExpectation[] {
  return Array.from({ length: count }, (_, i) => ({
    page: i + 1,
    mediaBox: A4_BOX,
    rotate: 0,
    displayedSize: [r2(PAGE_W), r2(PAGE_H)] as [number, number],
  }));
}

// ---------------------------------------------------------------------------
// Annual report: content
// ---------------------------------------------------------------------------

type Variant = 'a' | 'b';

/** The three places where v2 differs from v1. */
const REVISION = {
  paragraph: {
    a: 'The highlight of the summer was the Port Allery Regatta, which we hosted for the first time in eleven years. More than four hundred crews raced over two days, and the weather held until the final prize-giving. I would like to thank the regatta committee, who planned the event for almost a year and ran it without a single protest.',
    b: 'The highlight of the summer was the Port Allery Regatta, which we hosted for the first time in eleven years. Over two days, 412 crews raced on a course that the harbour authority had widened for us. The rain held off until the very last race. I would like to thank the regatta committee, who planned the event for almost a year and ran it without a single protest.',
    sentences: {
      a: 'More than four hundred crews raced over two days, and the weather held until the final prize-giving.',
      b: 'Over two days, 412 crews raced on a course that the harbour authority had widened for us. The rain held off until the very last race.',
    },
  },
  /** Fleet register: outings of Cormorant (v1 had the digits swapped). */
  cell: { row: 'Cormorant', column: 'Outings', a: '156', b: '165' },
  /** Figure 1: October outings (v1 plotted 186, the corrected v2 plots 168). */
  bar: { label: 'Oct', a: 186, b: 168 },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function outingsPerMonth(variant: Variant): number[] {
  const values = [92, 88, 41, 146, 189, 214, 236, 228, 197, 0, 141, 121];
  values[9] = REVISION.bar[variant];
  return values;
}

const MEMBERS = {
  '2023': [176, 178, 180, 183, 186, 190, 193, 192, 190, 189, 188, 188],
  '2024': [188, 189, 187, 192, 199, 205, 210, 212, 213, 213, 214, 214],
};

function fleetRows(variant: Variant): string[][] {
  return [
    ['Kittiwake', 'Coxed four', '2012', '214', 'Good'],
    ['Grey Heron', 'Eight', '2016', '187', 'Good'],
    ['Tern', 'Double scull', '2019', '243', 'Very good'],
    ['Cormorant', 'Coxed four', '2008', REVISION.cell[variant], 'Fair'],
    ['Dunlin', 'Single scull', '2021', '198', 'Very good'],
    ['Curlew', 'Single scull', '2014', '172', 'Good'],
    ['Shearwater', 'Quad scull', '2018', '205', 'Good'],
    ['Puffin', 'Coastal four', '2022', '131', 'Very good'],
  ];
}

interface SectionSpec {
  n: number;
  dest: string;
  title: string;
}

const SECTIONS: SectionSpec[] = [
  { n: 1, dest: 'foreword', title: 'Chair’s foreword' },
  { n: 2, dest: 'year-in-numbers', title: 'The year in numbers' },
  { n: 3, dest: 'membership', title: 'Membership' },
  { n: 4, dest: 'racing', title: 'Racing and regattas' },
  { n: 5, dest: 'fleet', title: 'Fleet and boathouse' },
  { n: 6, dest: 'finances', title: 'Finances' },
  { n: 7, dest: 'community', title: 'Community and juniors' },
  { n: 8, dest: 'year-ahead', title: 'The year ahead' },
];
const FIGURES = [
  { dest: 'figure-1', title: 'Figure 1. Outings per month, 2024', section: 2 },
  { dest: 'figure-2', title: 'Figure 2. Members at month end', section: 3 },
  { dest: 'table-1', title: 'Table 1. Fleet register', section: 5 },
];
/** Physical page of section n: cover and contents come first. */
const sectionPage = (n: number) => n + 2;

interface ReportRender {
  doc: PDFDocument;
  set: Setter;
  headings: DemoHeadingTruth[];
  charts: DemoChartTruth[];
  table: DemoTableTruth;
  revisedParagraph: { lines: DemoLineTruth[]; box: Box };
  dests: DestSpec[];
  links: { page: number; dest: string; target: number }[];
}

// ---------------------------------------------------------------------------
// Annual report: drawing
// ---------------------------------------------------------------------------

function drawCover(set: Setter, page: PDFPage): void {
  const p = 1;
  const bandBottom = 300;
  set.push(page, p, ...fillRect(0, bandBottom, PAGE_W, PAGE_H - bandBottom, NAVY));

  // Lighthouse on a headland, its beam sweeping left: flat shapes in the palette.
  const lx = 452;
  const base = 398; // sits into the headland
  const lamp = base + 132;
  set.push(
    page,
    p,
    ...fillPolygon(
      [
        [lx, lamp + 9],
        [0, lamp + 70],
        [0, lamp - 22],
      ],
      [0.13, 0.27, 0.41],
    ),
    ...fillPolygon(
      [
        [lx, lamp + 9],
        [PAGE_W, lamp + 44],
        [PAGE_W, lamp - 8],
      ],
      [0.12, 0.25, 0.39],
    ),
    setFillingRgbColor(...NAVY_DARK),
    moveTo(350, bandBottom),
    appendBezierCurve(380, 380, 410, 402, 452, 404),
    appendBezierCurve(500, 406, 540, 392, PAGE_W, 372),
    lineTo(PAGE_W, bandBottom),
    closePath(),
    fill(),
  );
  const tower = (y: number) => 22 - ((y - base) / 120) * 8; // half width tapers 22 -> 14
  const stripe = (y0: number, y1: number, color: Rgb) =>
    fillPolygon(
      [
        [lx - tower(y0), y0],
        [lx + tower(y0), y0],
        [lx + tower(y1), y1],
        [lx - tower(y1), y1],
      ],
      color,
    );
  set.push(
    page,
    p,
    ...stripe(base, base + 120, [0.95, 0.96, 0.97]),
    ...stripe(base + 24, base + 44, TEAL),
    ...stripe(base + 72, base + 92, TEAL),
    ...fillRect(lx - 20, base + 120, 40, 5, NAVY_DARK),
    ...fillRect(lx - 10, base + 125, 20, 16, [0.99, 0.84, 0.42]),
    ...strokeLine(
      [
        [lx - 10, base + 133],
        [lx + 10, base + 133],
      ],
      NAVY_DARK,
      0.8,
    ),
    ...fillPolygon(
      [
        [lx - 13, base + 141],
        [lx + 13, base + 141],
        [lx, base + 156],
      ],
      NAVY_DARK,
    ),
  );

  // Water and a coxed four crossing it.
  set.push(
    page,
    p,
    ...waveBand(bandBottom, 362, 5, 120, 30, [0.12, 0.29, 0.44]),
    ...waveBand(bandBottom, 336, 4, 90, 10, [0.16, 0.37, 0.52]),
  );
  const hullY = 372;
  set.push(
    page,
    p,
    setFillingRgbColor(0.95, 0.96, 0.97),
    moveTo(96, hullY),
    appendBezierCurve(150, hullY - 7, 260, hullY - 7, 318, hullY),
    appendBezierCurve(260, hullY - 2.5, 150, hullY - 2.5, 96, hullY),
    closePath(),
    fill(),
  );
  for (let i = 0; i < 4; i++) {
    const rx = 150 + i * 34;
    set.push(
      page,
      p,
      ...strokeLine(
        [
          [rx + 12, hullY - 3],
          [rx - 16, hullY - 13],
        ],
        [0.85, 0.88, 0.9],
        1.1,
        undefined,
        true,
      ),
      ...strokeLine(
        [
          [rx, hullY - 2],
          [rx + 3, hullY + 9],
        ],
        [0.95, 0.96, 0.97],
        3.2,
        undefined,
        true,
      ),
      setFillingRgbColor(0.95, 0.96, 0.97),
      ...circlePath(rx + 4, hullY + 13.5, 3),
      fill(),
    );
  }
  set.push(page, p, setFillingRgbColor(...TEAL_LIGHT), ...circlePath(286, hullY + 4, 2.6), fill());

  // Title block.
  set.text(
    page,
    p,
    { face: 'bold', size: 10, color: TEAL_LIGHT },
    MARGIN.left,
    760,
    'HARBOURLIGHT ROWING CLUB',
  );
  set.text(page, p, { face: 'bold', size: 44, color: WHITE }, MARGIN.left, 690, 'Annual Report');
  set.text(page, p, { face: 'bold', size: 44, color: TEAL_LIGHT }, MARGIN.left, 640, '2024');
  set.text(
    page,
    p,
    { face: 'serif', size: 13, color: [0.84, 0.88, 0.92] },
    MARGIN.left,
    606,
    'Our 87th season on the river at Port Allery',
  );

  set.text(
    page,
    p,
    { face: 'serif', size: 11, color: INK },
    MARGIN.left,
    250,
    'Presented to members at the Annual General Meeting on 15 February 2025.',
  );
  set.text(page, p, { face: 'bold', size: 9, color: INK }, MARGIN.left, 196, CLUB);
  set.text(page, p, STYLE.label, MARGIN.left, 182, 'The Boathouse, Quay Road');
  set.text(page, p, STYLE.label, MARGIN.left, 169, 'Port Allery PA3 7RW');
  footer(set, page, p, '');
}

function drawContents(
  doc: PDFDocument,
  set: Setter,
  page: PDFPage,
  r: Pick<ReportRender, 'headings' | 'links'>,
): void {
  const p = 2;
  runningHeader(set, page, p, CLUB, 'Annual Report 2024');
  const h = set.text(
    page,
    p,
    { face: 'bold', size: 26, color: NAVY },
    MARGIN.left,
    730,
    'Contents',
  );
  r.headings.push({ page: p, level: 1, text: 'Contents', size: 26, box: h.box });
  set.push(page, p, ...fillRect(MARGIN.left, 714, 36, 3, TEAL));

  const entry = (
    y: number,
    num: string,
    title: string,
    label: string,
    dest: string,
    target: number,
    size: number,
  ) => {
    if (num) set.text(page, p, { face: 'bold', size, color: TEAL }, MARGIN.left, y, num);
    const t = set.text(page, p, { face: 'serif', size, color: INK }, MARGIN.left + 28, y, title);
    const l = set.text(page, p, { face: 'sans', size, color: INK }, RIGHT, y, label, 'right');
    const from = t.x + t.box[2] + 8;
    const to = l.x - 8;
    set.push(
      page,
      p,
      ...strokeLine(
        [
          [from, y + 2],
          [to, y + 2],
        ],
        GREY_SERIES,
        1,
        [0.1, 3.4],
        true,
      ),
    );
    addLink(doc, page, box(MARGIN.left - 4, y - 6, CONTENT_W + 8, size + 10), dest);
    r.links.push({ page: p, dest, target });
  };
  let y = 670;
  for (const s of SECTIONS) {
    entry(y, String(s.n), s.title, String(s.n), s.dest, sectionPage(s.n), 12);
    y -= 30;
  }
  y -= 18;
  const sub = set.text(page, p, STYLE.h2, MARGIN.left, y, 'Figures and table');
  r.headings.push({
    page: p,
    level: 2,
    text: 'Figures and table',
    size: STYLE.h2.size,
    box: sub.box,
  });
  y -= 28;
  for (const f of FIGURES) {
    entry(y, '', f.title, String(f.section), f.dest, sectionPage(f.section), 11);
    y -= 24;
  }
  footer(set, page, p, 'ii');
}

/** Section page skeleton: header, kicker, H1, footer. Returns the flow below the title. */
function sectionPageStart(
  set: Setter,
  page: PDFPage,
  s: SectionSpec,
  headings: DemoHeadingTruth[],
): Flow {
  const p = sectionPage(s.n);
  runningHeader(set, page, p, CLUB, 'Annual Report 2024');
  set.text(page, p, STYLE.kicker, MARGIN.left, 762, `SECTION ${s.n}`);
  const h = set.text(page, p, STYLE.h1, MARGIN.left, 734, s.title);
  headings.push({ page: p, level: 1, text: s.title, size: STYLE.h1.size, box: h.box });
  set.push(page, p, ...fillRect(MARGIN.left, 718, 36, 3, TEAL));
  footer(set, page, p, String(s.n));
  return new Flow(set, page, p, 690, headings);
}

function niceTicks(min: number, max: number, step: number): number[] {
  const ticks: number[] = [];
  for (let v = min; v <= max + 1e-9; v += step) ticks.push(v);
  return ticks;
}

/** Axes, gridlines and labels shared by both charts; returns the value -> y mapping. */
function chartFrame(
  set: Setter,
  page: PDFPage,
  p: number,
  plot: Box,
  yRange: [number, number],
  step: number,
  categories: string[],
): (v: number) => number {
  const [x, y, w, h] = plot;
  const toY = (v: number) => y + ((v - yRange[0]) / (yRange[1] - yRange[0])) * h;
  for (const tick of niceTicks(yRange[0], yRange[1], step)) {
    const ty = toY(tick);
    if (tick !== yRange[0])
      set.push(
        page,
        p,
        ...strokeLine(
          [
            [x, ty],
            [x + w, ty],
          ],
          RULE,
          0.5,
        ),
      );
    set.text(
      page,
      p,
      { face: 'sans', size: 7, color: MUTED },
      x - 6,
      ty - 2.5,
      String(tick),
      'right',
    );
  }
  set.push(
    page,
    p,
    ...strokeLine(
      [
        [x, y],
        [x + w, y],
      ],
      INK,
      0.75,
    ),
  );
  const band = w / categories.length;
  categories.forEach((c, i) =>
    set.text(
      page,
      p,
      { face: 'sans', size: 7, color: MUTED },
      x + band * (i + 0.5),
      y - 12,
      c,
      'center',
    ),
  );
  return toY;
}

function drawBarChart(
  set: Setter,
  page: PDFPage,
  p: number,
  top: number,
  variant: Variant,
): DemoChartTruth {
  const title = 'Outings per month, 2024';
  set.text(page, p, { face: 'bold', size: 9.5, color: INK }, MARGIN.left, top, title);
  set.text(page, p, STYLE.caption, RIGHT, top, 'Crews on the water, by month', 'right');
  const plot = box(MARGIN.left + 28, top - 196, CONTENT_W - 28, 174);
  const yRange: [number, number] = [0, 250];
  const toY = chartFrame(set, page, p, plot, yRange, 50, MONTHS);
  const values = outingsPerMonth(variant);
  const band = plot[2] / values.length;
  const bars = values.map((v, i) => {
    const bw = band * 0.58;
    return box(plot[0] + band * i + (band - bw) / 2, plot[1], bw, toY(v) - plot[1]);
  });
  // Bars sit on the axis; the axis line is drawn again on top so they share one edge.
  for (const b of bars) set.push(page, p, ...fillRect(b[0], b[1], b[2], b[3], TEAL));
  set.push(
    page,
    p,
    ...strokeLine(
      [
        [plot[0], plot[1]],
        [plot[0] + plot[2], plot[1]],
      ],
      INK,
      0.75,
    ),
  );
  return {
    id: 'figure-1',
    page: p,
    kind: 'bar',
    title,
    plot,
    categories: MONTHS,
    yRange,
    series: [{ name: '2024', values }],
    bars,
  };
}

function drawLineChart(set: Setter, page: PDFPage, p: number, top: number): DemoChartTruth {
  const title = 'Members at month end';
  set.text(page, p, { face: 'bold', size: 9.5, color: INK }, MARGIN.left, top, title);
  // Legend, laid out from the right margin leftwards: swatch, gap, label per series.
  let legendRight = RIGHT;
  const legend = (label: string, color: Rgb, width: number) => {
    const labelX = legendRight - set.width(STYLE.caption, label);
    const swatch = labelX - 5;
    set.push(
      page,
      p,
      ...strokeLine(
        [
          [swatch - 16, top + 3],
          [swatch, top + 3],
        ],
        color,
        width,
        undefined,
        true,
      ),
    );
    set.text(page, p, STYLE.caption, labelX, top, label);
    legendRight = swatch - 16 - 14;
  };
  legend('2024', TEAL, 2.2);
  legend('2023', GREY_SERIES, 1.5);
  const plot = box(MARGIN.left + 28, top - 176, CONTENT_W - 28, 154);
  const yRange: [number, number] = [170, 220];
  const toY = chartFrame(set, page, p, plot, yRange, 10, MONTHS);
  const band = plot[2] / 12;
  const pts = (values: number[]) =>
    values.map((v, i) => [plot[0] + band * (i + 0.5), toY(v)] as [number, number]);
  set.push(page, p, ...strokeLine(pts(MEMBERS['2023']), GREY_SERIES, 1.5));
  const p24 = pts(MEMBERS['2024']);
  set.push(page, p, ...strokeLine(p24, TEAL, 2.2));
  for (const [x, y] of p24) {
    set.push(
      page,
      p,
      pushGraphicsState(),
      setFillingRgbColor(...WHITE),
      setStrokingRgbColor(...TEAL),
      setLineWidth(1.4),
      ...circlePath(x, y, 2.6),
      fillAndStroke(),
      popGraphicsState(),
    );
  }
  return {
    id: 'figure-2',
    page: p,
    kind: 'line',
    title,
    plot,
    categories: MONTHS,
    yRange,
    series: [
      { name: '2023', values: MEMBERS['2023'] },
      { name: '2024', values: MEMBERS['2024'] },
    ],
  };
}

function drawStatTiles(set: Setter, page: PDFPage, p: number, top: number): void {
  const tiles = [
    ['214', 'members at year end'],
    ['1,861', 'outings on the water'],
    ['23,940', 'kilometres rowed'],
    ['17', 'regatta medals'],
  ];
  const gap = 10;
  const w = (CONTENT_W - gap * (tiles.length - 1)) / tiles.length;
  tiles.forEach(([value = '', label = ''], i) => {
    const x = MARGIN.left + i * (w + gap);
    set.push(page, p, ...fillRect(x, top - 58, w, 58, PALE), ...fillRect(x, top - 58, 3, 58, TEAL));
    set.text(page, p, { face: 'bold', size: 20, color: NAVY }, x + 14, top - 28, value);
    set.text(page, p, STYLE.caption, x + 14, top - 44, label);
  });
}

const FLEET_COLUMNS = [
  { title: 'Boat', width: 112, align: 'left' },
  { title: 'Type', width: 118, align: 'left' },
  { title: 'Built', width: 62, align: 'right' },
  { title: 'Outings', width: 78, align: 'right' },
  { title: 'Condition', width: 0, align: 'left' },
] as const;

function drawTable(
  set: Setter,
  page: PDFPage,
  p: number,
  top: number,
  variant: Variant,
): { truth: DemoTableTruth; cells: DemoLineTruth[][] } {
  const title = 'Table 1. Fleet register: the eight most used boats, 2024';
  set.text(page, p, { face: 'bold', size: 9.5, color: INK }, MARGIN.left, top, title);
  const rows = fleetRows(variant);
  const rowH = 20;
  const headTop = top - 10;
  const lefts: number[] = [];
  let x = MARGIN.left;
  for (const c of FLEET_COLUMNS) {
    lefts.push(x);
    x += c.width;
  }
  // The last column (width 0) takes what is left up to the right margin.
  const widthOf = (i: number) => {
    const width = FLEET_COLUMNS[i]?.width ?? 0;
    return width > 0 ? width : RIGHT - (lefts[i] ?? 0);
  };
  const cellX = (i: number) => {
    const left = lefts[i] ?? 0;
    // Numbers align right; the column after them gets extra room so they do not crowd it.
    if (FLEET_COLUMNS[i]?.align === 'right') return left + widthOf(i) - 10;
    return left + (i === 4 ? 26 : 10);
  };
  set.push(page, p, ...fillRect(MARGIN.left, headTop - rowH, CONTENT_W, rowH, NAVY));
  FLEET_COLUMNS.forEach((c, i) =>
    set.text(
      page,
      p,
      { face: 'bold', size: 8.5, color: WHITE },
      cellX(i),
      headTop - 13.5,
      c.title,
      c.align,
    ),
  );
  const cells: DemoLineTruth[][] = [];
  rows.forEach((row, r) => {
    const rowTop = headTop - rowH * (r + 1);
    if (r % 2 === 1)
      set.push(page, p, ...fillRect(MARGIN.left, rowTop - rowH, CONTENT_W, rowH, PALE));
    cells.push(
      row.map((value, i) =>
        set.text(
          page,
          p,
          { face: i === 0 ? 'bold' : 'sans', size: 9, color: INK },
          cellX(i),
          rowTop - 13.5,
          value,
          FLEET_COLUMNS[i]?.align ?? 'left',
        ),
      ),
    );
  });
  const bottom = headTop - rowH * (rows.length + 1);
  set.push(
    page,
    p,
    ...strokeLine(
      [
        [MARGIN.left, bottom],
        [RIGHT, bottom],
      ],
      INK,
      0.75,
    ),
  );
  return {
    truth: {
      id: 'table-1',
      page: p,
      title,
      box: box(MARGIN.left, bottom, CONTENT_W, headTop - bottom),
      columns: FLEET_COLUMNS.map((c) => c.title),
      rows,
    },
    cells,
  };
}

const FOREWORD = [
  '2024 was a year of steady water and full boats. We began the season with a waiting list for the learn-to-row course and ended it with more active members than at any time since the boathouse was rebuilt in 2009. None of that happens by accident: it is the work of coaches, captains, boat repairers, bar volunteers and the many members who simply turn up, carry a boat and get on with it.',
  // index 1 is REVISION.paragraph
  'Not everything went to plan. A spring flood closed the river for nineteen days in March, and the boathouse doors needed an urgent repair that used most of the contingency budget. The committee has since agreed a maintenance plan, so that repairs of this kind are funded in advance rather than found at short notice.',
  'This report sets out what we did, what it cost and what we intend to do next. The accounts summarised in section 6 were approved by the committee on 9 January 2025 and will be presented at the Annual General Meeting, where every member can ask questions about them.',
  'Thank you all for a remarkable season. I look forward to seeing you on the water in the spring.',
];

async function renderReport(
  variant: Variant,
): Promise<ReportRender & { cells: DemoLineTruth[][] }> {
  const doc = await newDoc(REPORT.title);
  doc.setAuthor(`${CLUB} (fictional)`);
  doc.setSubject(`${DEMO_FOOTER}: annual report of a fictional rowing club`);
  doc.setLanguage('en-GB');
  const set = new Setter(await embedFaces(doc, ['sans', 'bold', 'serif']));
  const pages = Array.from({ length: 10 }, () => {
    const page = doc.addPage(A4);
    set.prepare(page);
    return page;
  });
  const pageAt = (n: number): PDFPage => {
    const page = pages[n - 1];
    if (!page) throw new Error(`no page ${n}`);
    return page;
  };
  const headings: DemoHeadingTruth[] = [];
  const links: ReportRender['links'] = [];
  const charts: DemoChartTruth[] = [];
  const dests: DestSpec[] = [
    { name: 'cover', page: 1, top: PAGE_H },
    { name: 'contents', page: 2, top: PAGE_H },
  ];

  drawCover(set, pageAt(1));
  drawContents(doc, set, pageAt(2), { headings, links });
  const flows = new Map<number, Flow>();
  for (const s of SECTIONS) {
    flows.set(s.n, sectionPageStart(set, pageAt(sectionPage(s.n)), s, headings));
    dests.push({ name: s.dest, page: sectionPage(s.n), top: 790 });
  }
  const flow = (n: number): Flow => {
    const f = flows.get(n);
    if (!f) throw new Error(`no section ${n}`);
    return f;
  };

  // 1. Foreword (holds the revised paragraph).
  const f1 = flow(1);
  f1.paragraph(FOREWORD[0] ?? '');
  const revisedParagraph = f1.paragraph(REVISION.paragraph[variant]);
  for (const text of FOREWORD.slice(1)) f1.paragraph(text);
  f1.space(14);
  set.text(
    pageAt(3),
    3,
    { face: 'bold', size: 10.5, color: INK },
    MARGIN.left,
    f1.y,
    'Margaret Okafor',
  );
  set.text(pageAt(3), 3, STYLE.label, MARGIN.left, f1.y - 14, `Chair, ${CLUB}`);

  // 2. The year in numbers (bar chart).
  const f2 = flow(2);
  f2.paragraph(
    'The figures below come from the club’s booking system, which records every outing, and from the membership register at the end of each month. An outing is one crew taking one boat on the water, whatever the size of the boat.',
  );
  drawStatTiles(set, pageAt(4), 4, f2.y + 4);
  f2.space(86);
  dests.push({ name: 'figure-1', page: 4, top: r2(f2.y + 16) });
  charts.push(drawBarChart(set, pageAt(4), 4, f2.y, variant));
  f2.space(234);
  f2.paragraph(
    'Figure 1. Outings per month, 2024. The river was closed from 4 to 22 March after the spring flood.',
    { style: STYLE.caption, leading: 12 },
  );
  f2.space(6);
  f2.paragraph(
    'Summer remains our busiest time, but the winter months are catching up: November and December outings rose by a quarter compared with 2023, helped by the new lights on the landing stage and a winter training plan for the recreational squad.',
  );

  // 3. Membership (line chart).
  const f3 = flow(3);
  f3.paragraph(
    'Membership grew from 188 to 214 over the year. Most of the growth came from adults who completed the learn-to-row course and stayed on: 31 of the 36 course graduates joined as full members.',
  );
  f3.space(8);
  dests.push({ name: 'figure-2', page: 5, top: r2(f3.y + 16) });
  charts.push(drawLineChart(set, pageAt(5), 5, f3.y));
  f3.space(214);
  f3.paragraph(
    'Figure 2. Members at month end, 2023 and 2024. Each point is the register count on the last day of the month.',
    { style: STYLE.caption, leading: 12 },
  );
  f3.heading('Who our members are');
  f3.paragraph(
    'Juniors aged 12 to 18 make up a fifth of the club. Our oldest active member turned 84 in June and still sculls twice a week. Just under half of the membership now rows recreationally, without racing, and this is the fastest-growing group.',
  );
  f3.heading('Fees');
  f3.paragraph(
    'Fees for 2024 were unchanged. The committee proposes a rise of 4 percent from April 2025, the first since 2021, to cover higher insurance premiums and the fuel for the coaching launch.',
  );

  // 4. Racing.
  const f4 = flow(4);
  f4.paragraph(
    'Our crews raced at fourteen events, from small local heads to the national masters championships. They brought home 17 medals: six gold, five silver and six bronze, the best haul since 2016.',
  );
  f4.heading('Port Allery Regatta');
  f4.paragraph(
    'After eleven years away, the regatta returned to our stretch of the river in July. Crews came from 38 clubs, and the course ran from the old swing bridge to the boathouse, finishing in front of a crowded bank. The event made a surplus of £17,900, which goes into the boat replacement fund.',
  );
  f4.paragraph(
    'Running a regatta takes more than a hundred volunteers. Umpires, marshals, timekeepers and the catering team worked long days, and many of them were parents of juniors who had never been to a regatta before.',
  );
  f4.heading('Highlights');
  f4.bullets([
    'Women’s masters coxed four: gold at the Northern Masters, winning by two lengths.',
    'Junior double sculls: silver at the regional championships in their first season together.',
    'Men’s eight: fastest club crew at the Autumn Head on 12 October.',
    'Adaptive single sculls: two wins at the inclusive regatta in Westerby.',
  ]);
  f4.paragraph(
    'Racing costs are met by the racing squad itself through crew fees and sponsorship, so racing is not subsidised by the wider membership.',
  );

  // 5. Fleet (the table).
  const f5 = flow(5);
  f5.paragraph(
    'The club owns 22 boats. Eight of them do most of the work, and the table shows how often each was taken out. Outings are counted from the booking system; a boat used for a coaching session counts once per session.',
  );
  f5.space(6);
  dests.push({ name: 'table-1', page: 7, top: r2(f5.y + 16) });
  const table = drawTable(set, pageAt(7), 7, f5.y, variant);
  f5.space(214);
  f5.heading('Boathouse');
  f5.paragraph(
    'The spring flood left 30 centimetres of water in the lower bay. The boats had been lifted in time, but the doors and the electrics needed repair. The work was finished in May at a cost of £7,860, of which insurance covered £5,200.',
  );
  f5.paragraph(
    'In the autumn, volunteers fitted new racks for the single sculls and repainted the landing stage. A grant from the Port Allery Community Fund paid for the new lights.',
  );

  // 6. Finances.
  const f6 = flow(6);
  f6.paragraph(
    'The club ended the year with a small surplus of £2,140, against a budgeted surplus of £4,500. Income rose to £96,300, mainly from membership fees and the regatta; spending rose to £94,160, mainly because of the flood repairs.',
  );
  f6.heading('Income');
  f6.paragraph(
    'Membership fees brought in £58,400 and the regatta £17,900 after costs. Room hire, now offered on Friday and Saturday evenings, added £8,700. The remaining £11,300 came from grants, donations and the bar.',
  );
  f6.heading('Spending');
  f6.paragraph(
    'The largest costs were coaching (£21,900), the boathouse (£27,460 including repairs), insurance (£14,800) and boat maintenance (£12,600). Utilities, the coaching launch and administration made up the remaining £17,400.',
  );
  f6.heading('Reserves');
  f6.paragraph(
    'Reserves stand at £41,800, which covers about five months of running costs. The committee aims to keep at least four months in reserve and to set aside £6,000 a year for boat replacement, starting in 2025.',
  );
  f6.paragraph(
    'The full accounts, with the independent examiner’s report, are available from the Treasurer and will be on display at the boathouse in the two weeks before the meeting.',
  );

  // 7. Community.
  const f7 = flow(7);
  f7.paragraph(
    'The junior squad trained three times a week with 42 regular rowers. Two juniors were selected for the regional development squad, and four took their first coaching qualification.',
  );
  f7.heading('Schools and open days');
  f7.paragraph(
    'We ran rowing taster sessions for three local schools and held two open days, in May and September, which together brought 260 visitors to the boathouse. The adaptive rowing group, launched in 2023, now meets every Saturday morning with its own specially fitted boat.',
  );
  f7.heading('Volunteers');
  f7.paragraph(
    'Volunteers gave an estimated 6,400 hours to the club this year. Without them there would be no coaching, no regatta and no tea after Sunday outings. Our thanks go to every one of them.',
  );

  // 8. The year ahead.
  const f8 = flow(8);
  f8.paragraph(
    'The committee’s priorities for 2025 are a replacement for Cormorant, the oldest four in the fleet, better changing rooms, and a second learn-to-row course in the autumn.',
  );
  f8.heading('Plans');
  f8.bullets([
    'Order a new coxed four by June, funded from the boat reserve and a members’ appeal.',
    'Refurbish the changing rooms over the winter, subject to a grant decision in March.',
    'Run two learn-to-row courses, in April and September.',
  ]);
  f8.heading('Officers for 2025');
  const officers = [
    ['Chair', 'Margaret Okafor'],
    ['Secretary', 'Tom Ashdown'],
    ['Treasurer', 'Priya Raman'],
    ['Captain', 'Daniel Whitlock'],
    ['Junior coordinator', 'Aylin Demir'],
  ];
  for (const [role = '', person = ''] of officers) {
    set.text(pageAt(10), 10, STYLE.label, MARGIN.left, f8.y, role);
    set.text(pageAt(10), 10, STYLE.body, MARGIN.left + 120, f8.y, person);
    f8.space(17);
  }
  f8.space(10);
  f8.paragraph(
    'The Annual General Meeting will be held at the boathouse on 15 February 2025 at 7 pm. All members are welcome, and nominations for the committee close a week before.',
  );

  set.assertPresetCovered();
  doc.catalog.set(name('PageLabels'), doc.context.obj({ Nums: [0, { S: 'r' }, 2, { S: 'D' }] }));
  doc.catalog.set(name('PageMode'), name('UseOutlines'));
  writeNamedDests(doc, dests);
  return {
    doc,
    set,
    headings,
    charts,
    table: table.truth,
    cells: table.cells,
    revisedParagraph,
    dests,
    links,
  };
}

const REPORT_OUTLINE: OutlineNode[] = [
  { title: 'Cover', dest: 'cover', page: 1 },
  { title: 'Contents', dest: 'contents', page: 2 },
  ...SECTIONS.map((s): OutlineNode => {
    const children = FIGURES.filter((f) => f.section === s.n).map((f) => ({
      title: f.title,
      dest: f.dest,
      page: sectionPage(s.n),
    }));
    const node: OutlineNode = { title: `${s.n}. ${s.title}`, dest: s.dest, page: sectionPage(s.n) };
    if (children.length) node.children = children;
    return node;
  }),
];

const lineKey = (l: DemoLineTruth) => `${l.font} ${l.size} ${l.x} ${l.baseline} ${l.text}`;

/** The v1 -> v2 differences, checked against a line-by-line diff of both renders. */
function reportChanges(a: Awaited<ReturnType<typeof renderReport>>, b: typeof a): DemoCompareTruth {
  const pages = Array.from({ length: 10 }, (_, i) => i + 1);
  const linesOf = (r: typeof a, p: number) => r.set.drawn.filter((l) => l.page === p).map(lineKey);
  const textDiff = new Map<number, { a: string[]; b: string[] }>();
  for (const p of pages) {
    const la = linesOf(a, p);
    const lb = linesOf(b, p);
    const onlyA = la.filter((l) => !lb.includes(l));
    const onlyB = lb.filter((l) => !la.includes(l));
    if (onlyA.length || onlyB.length) textDiff.set(p, { a: onlyA, b: onlyB });
  }
  const para = { a: a.revisedParagraph.lines, b: b.revisedParagraph.lines };
  if (para.a.length !== para.b.length)
    throw new Error(`revised paragraph: ${para.a.length} vs ${para.b.length} lines`);
  const changedLines = para.a.flatMap((l, i) => (l.text === para.b[i]?.text ? [] : [i]));
  const row = fleetRows('a').findIndex((r) => r[0] === REVISION.cell.row);
  const col = FLEET_COLUMNS.findIndex((c) => c.title === REVISION.cell.column);
  const cellA = a.cells[row]?.[col];
  const cellB = b.cells[row]?.[col];
  const bar = MONTHS.indexOf(REVISION.bar.label);
  const barA = a.charts[0]?.bars?.[bar];
  const barB = b.charts[0]?.bars?.[bar];
  if (!cellA || !cellB || !barA || !barB) throw new Error('revision targets not drawn');

  // Self-check: the text differs exactly in the paragraph lines and the table cell.
  const expectedText = new Map([
    [
      3,
      {
        a: changedLines.map((i) => lineKey(para.a[i] as DemoLineTruth)),
        b: changedLines.map((i) => lineKey(para.b[i] as DemoLineTruth)),
      },
    ],
    [7, { a: [lineKey(cellA)], b: [lineKey(cellB)] }],
  ]);
  if (JSON.stringify([...textDiff]) !== JSON.stringify([...expectedText]))
    throw new Error(`report v1/v2 text differs unexpectedly: ${JSON.stringify([...textDiff])}`);
  const identicalPages = pages.filter(
    (p) => (a.set.log.get(p) ?? []).join('\n') === (b.set.log.get(p) ?? []).join('\n'),
  );
  if (identicalPages.join() !== '1,2,5,6,8,9,10')
    throw new Error(`unexpected identical pages ${identicalPages.join()}`);

  const changes: DemoChangeTruth[] = [
    {
      kind: 'paragraph',
      page: 3,
      section: SECTIONS[0]?.title ?? '',
      sentences: REVISION.paragraph.sentences,
      changedLines,
      a: { lines: para.a.map((l) => l.text), box: a.revisedParagraph.box },
      b: { lines: para.b.map((l) => l.text), box: b.revisedParagraph.box },
    },
    {
      kind: 'chart-bar',
      page: 4,
      chart: 'figure-1',
      bar: REVISION.bar.label,
      a: { value: REVISION.bar.a, rect: barA },
      b: { value: REVISION.bar.b, rect: barB },
    },
    {
      kind: 'table-cell',
      page: 7,
      table: 'table-1',
      row: REVISION.cell.row,
      column: REVISION.cell.column,
      a: cellA,
      b: cellB,
    },
  ];
  return {
    role: 'a',
    a: REPORT.a,
    b: REPORT.b,
    pageMap: pages.map((p) => ({ a: p, b: p })),
    changes,
    identicalPages,
  };
}

function fontNames(set: Setter): string[] {
  return Object.values(set.faces).map((f) => `${FACES[f.id].tag}+${f.postscript}`);
}

async function buildReport(variant: Variant): Promise<Built> {
  const file = REPORT[variant];
  // Both versions are rendered so that either file can carry the full change list.
  const a = await renderReport('a');
  const b = await renderReport('b');
  const mine = variant === 'a' ? a : b;
  const compare = { ...reportChanges(a, b), role: variant };
  const outline = writeOutline(mine.doc, REPORT_OUTLINE);
  const editTarget = mine.set.drawn.find(
    (l) => l.page >= 3 && l.font === 'NotoSerif-Regular' && l.text.includes('2024'),
  );
  if (!editTarget) throw new Error('no body line with 2024');
  return {
    bytes: await save(mine.doc, file),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 10,
      pages: pageExpects(10),
      pageLabels: ['i', 'ii', '1', '2', '3', '4', '5', '6', '7', '8'],
      outline: outline.expect,
      outlineVisibleCount: outline.visible,
      namedDests: mine.dests.map((d) => ({ name: d.name, page: d.page, tree: 'Names/Dests' })),
      links: mine.links.map((l) => ({
        page: l.page,
        kind: 'dest-named',
        targetPage: l.target,
        destName: l.dest,
      })),
      info: { Title: REPORT.title, Author: `${CLUB} (fictional)` },
      xref: 'table',
      fileIdDeterministic: true,
      demo: {
        footer: DEMO_FOOTER,
        clips: [1, 2, 5, 6, 8],
        fonts: fontNames(mine.set),
        headings: mine.headings,
        charts: mine.charts,
        table: mine.table,
        compare,
        editTarget,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Room-hire agreement
// ---------------------------------------------------------------------------

const AGREEMENT_NO = 'HRC-RH-2024-031';

const CLAUSES: [string, string][] = [
  [
    'Booking and confirmation',
    'The booking is confirmed when the Club has received this agreement, signed by the Hirer, and the deposit. Until then the Club may offer the room to someone else, after telling the Hirer.',
  ],
  [
    'Payment',
    `The Hirer pays the deposit within seven days of signing and the hire fee no later than 14 days before the event, by bank transfer to the Club’s account, IBAN ${IBAN}, quoting the agreement number as the reference. The Club does not accept cash at the boathouse.`,
  ],
  [
    'Deposit',
    'The Club returns the deposit within 14 days after the event, less the cost of any cleaning or repair that the Hirer’s use of the room made necessary. The Club explains any deduction in writing.',
  ],
  [
    'Access and hours',
    'The Hirer may use the room during the hours booked, including the time needed to set up and clear away. The boat bays and the landing stage are not part of the hire and stay closed to guests.',
  ],
  [
    'Numbers and safety',
    'The Hirer makes sure that no more than 60 people are in the room at any time, that fire exits stay clear and that guests know where the assembly point is. A member of the Club is on site during the hire.',
  ],
  [
    'Food and drink',
    'The Hirer may bring food and soft drinks. Alcohol may only be served by the Club’s licensed bar, and glass must not be taken onto the balcony.',
  ],
  [
    'Noise and neighbours',
    'Amplified music must end by 22:30, and the windows on the river side stay closed after 21:00. The Hirer asks guests to leave quietly, as the boathouse has neighbours on both sides.',
  ],
  [
    'Damage and cleaning',
    'The Hirer leaves the room clean and tidy and reports any damage to the Club’s representative before leaving. Decorations must not be fixed to the walls with nails, pins or tape.',
  ],
  [
    'Cancellation',
    'If the Hirer cancels more than 28 days before the event, the Club refunds all payments. If the Hirer cancels later, the Club keeps the deposit. If the Club has to cancel, for example because of flooding, it refunds all payments in full.',
  ],
  [
    'Liability',
    'The Hirer is responsible for the conduct of guests. The Club is not liable for loss of or damage to property brought into the boathouse, except where the Club’s negligence caused it.',
  ],
  [
    'Personal data',
    'The Club keeps the Hirer’s contact details only to manage this booking and deletes them twelve months after the event.',
  ],
];

const FIELD_BG = rgb(0.93, 0.955, 0.99);

async function buildAgreement(): Promise<Built> {
  const title = `Room Hire Agreement ${AGREEMENT_NO}`;
  const doc = await newDoc(title);
  doc.setAuthor(`${CLUB} (fictional)`);
  doc.setSubject(
    `${DEMO_FOOTER}: room-hire agreement between a fictional club and a fictional hirer`,
  );
  doc.setLanguage('en-GB');
  const set = new Setter(await embedFaces(doc, ['sans', 'bold', 'serif']));
  const pages = Array.from({ length: 4 }, () => {
    const page = doc.addPage(A4);
    set.prepare(page);
    return page;
  });
  const pageAt = (n: number): PDFPage => {
    const page = pages[n - 1];
    if (!page) throw new Error(`no page ${n}`);
    return page;
  };
  const headings: DemoHeadingTruth[] = [];
  pages.forEach((page, i) => {
    if (i > 0) runningHeader(set, page, i + 1, CLUB, `Room hire agreement ${AGREEMENT_NO}`);
    footer(set, page, i + 1, `Page ${i + 1} of 4`);
  });
  const h1 = (p: number, y: number, value: string) => {
    const line = set.text(pageAt(p), p, STYLE.h1, MARGIN.left, y, value);
    headings.push({ page: p, level: 1, text: value, size: STYLE.h1.size, box: line.box });
    set.push(pageAt(p), p, ...fillRect(MARGIN.left, y - 16, 36, 3, TEAL));
  };

  // Page 1: letterhead, parties, booking.
  const p1 = pageAt(1);
  set.text(p1, 1, { face: 'bold', size: 15, color: NAVY }, MARGIN.left, 782, CLUB);
  set.text(p1, 1, STYLE.label, MARGIN.left, 768, 'The Boathouse, Quay Road, Port Allery PA3 7RW');
  set.text(p1, 1, STYLE.label, RIGHT, 782, `Agreement no. ${AGREEMENT_NO}`, 'right');
  set.text(p1, 1, STYLE.label, RIGHT, 768, 'Prepared 19 August 2024', 'right');
  set.push(
    p1,
    1,
    ...strokeLine(
      [
        [MARGIN.left, 754],
        [RIGHT, 754],
      ],
      RULE,
      0.75,
    ),
  );
  h1(1, 716, 'Room Hire Agreement');
  const f1 = new Flow(set, p1, 1, 672, headings);
  f1.paragraph(
    'This agreement sets out the terms on which the Club lets the Riverside Room to the Hirer. Please read all four pages, choose any options and sign on page 4, then return one signed copy to the Club Secretary.',
  );
  f1.heading('The parties');
  const colW = (CONTENT_W - 14) / 2;
  const parties: [string, string[]][] = [
    [
      'THE CLUB',
      [
        CLUB,
        'The Boathouse, Quay Road',
        'Port Allery PA3 7RW',
        'Represented by Tom Ashdown,',
        'Club Secretary',
      ],
    ],
    ['THE HIRER', ['Elena Marsh', '14 Quayside Terrace', 'Port Allery PA2 4LN', EMAIL, PHONE]],
  ];
  const partyTop = f1.y + 6;
  parties.forEach(([label, lines], i) => {
    const x = MARGIN.left + i * (colW + 14);
    set.push(p1, 1, ...fillRect(x, partyTop - 116, colW, 116, PALE));
    set.text(p1, 1, STYLE.kicker, x + 14, partyTop - 20, label);
    lines.forEach((line, k) => set.text(p1, 1, STYLE.body, x + 14, partyTop - 40 - k * 15, line));
  });
  f1.space(128);
  f1.heading('The booking');
  const booking: [string, string][] = [
    ['Room', 'The Riverside Room, first floor'],
    ['Event', 'Private family celebration'],
    ['Date', 'Saturday 14 September 2024'],
    ['Hours', '18:00 to 23:00, including setting up and clearing away'],
    ['Guests', 'Up to 60'],
    ['Hire fee', '£320'],
    ['Deposit', '£150, refundable (see clause 3)'],
  ];
  set.push(
    p1,
    1,
    ...strokeLine(
      [
        [MARGIN.left, f1.y + 14],
        [RIGHT, f1.y + 14],
      ],
      RULE,
      0.5,
    ),
  );
  for (const [key, value] of booking) {
    set.text(p1, 1, STYLE.label, MARGIN.left, f1.y, key);
    set.text(p1, 1, STYLE.body, MARGIN.left + 110, f1.y, value);
    set.push(
      p1,
      1,
      ...strokeLine(
        [
          [MARGIN.left, f1.y - 9],
          [RIGHT, f1.y - 9],
        ],
        RULE,
        0.5,
      ),
    );
    f1.space(23);
  }

  // Pages 2-3: the terms, numbered clauses with a hanging number.
  const clause = (flow: Flow, page: PDFPage, p: number, n: number) => {
    const [heading = '', text = ''] = CLAUSES[n - 1] ?? [];
    set.text(page, p, { face: 'bold', size: 10.5, color: TEAL }, MARGIN.left, flow.y, `${n}.`);
    set.text(page, p, { face: 'bold', size: 10.5, color: INK }, MARGIN.left + 24, flow.y, heading);
    flow.space(16);
    flow.paragraph(text, { x: MARGIN.left + 24, width: CONTENT_W - 24, keep: [`IBAN ${IBAN}`] });
    flow.space(8);
  };
  h1(2, 734, 'Terms of hire');
  const f2 = new Flow(set, pageAt(2), 2, 690, headings);
  for (let n = 1; n <= 6; n++) clause(f2, pageAt(2), 2, n);
  set.text(pageAt(3), 3, STYLE.kicker, MARGIN.left, 762, 'TERMS OF HIRE, CONTINUED');
  const f3 = new Flow(set, pageAt(3), 3, 730, headings);
  for (let n = 7; n <= CLAUSES.length; n++) clause(f3, pageAt(3), 3, n);

  // Page 4: options (checkboxes) and signatures (text fields).
  const p4 = pageAt(4);
  h1(4, 734, 'Options and signatures');
  const f4 = new Flow(set, p4, 4, 690, headings);
  f4.paragraph(
    'Tick any extras you would like. The Club adds them to the hire fee and confirms the total by e-mail.',
  );
  f4.heading('Options');
  const form = doc.getForm();
  const fields: FieldExpectation[] = [];
  const options: [string, string][] = [
    ['option_kitchen', 'Use of the kitchen (£40)'],
    ['option_projector', 'Projector and screen (£25)'],
    ['option_bar', 'Bar service by the Club’s licensed volunteers (no charge)'],
  ];
  for (const [field, label] of options) {
    const cb = form.createCheckBox(field);
    cb.addToPage(p4, {
      x: MARGIN.left,
      y: r2(f4.y - 2),
      width: 12,
      height: 12,
      borderWidth: 1,
      borderColor: rgb(...MUTED),
      backgroundColor: rgb(1, 1, 1),
    });
    set.text(p4, 4, STYLE.body, MARGIN.left + 22, f4.y, label);
    fields.push({ name: field, type: 'checkbox', value: false, page: 4, hasAppearance: true });
    f4.space(24);
  }
  f4.heading('Signatures');
  f4.paragraph(
    'By signing, the Hirer confirms having read and accepted the terms on pages 2 and 3.',
  );
  f4.space(6);
  const sigTop = f4.y;
  set.text(p4, 4, STYLE.kicker, MARGIN.left, sigTop, 'THE HIRER');
  set.text(p4, 4, STYLE.kicker, MARGIN.left + colW + 14, sigTop, 'FOR THE CLUB');
  const textField = (field: string, label: string, y: number, width: number, height: number) => {
    set.text(p4, 4, STYLE.label, MARGIN.left, y, label);
    const tf = form.createTextField(field);
    tf.addToPage(p4, {
      x: MARGIN.left,
      y: r2(y - 8 - height),
      width,
      height,
      borderWidth: 0,
      backgroundColor: FIELD_BG,
    });
    tf.setFontSize(11);
    set.push(
      p4,
      4,
      ...strokeLine(
        [
          [MARGIN.left, y - 8 - height],
          [MARGIN.left + width, y - 8 - height],
        ],
        INK,
        0.75,
      ),
    );
    fields.push({ name: field, type: 'text', value: '', page: 4, hasAppearance: true });
  };
  textField('hirer_name', 'Name in capitals', sigTop - 24, colW, 22);
  textField('hirer_signature', 'Signature', sigTop - 80, colW, 34);
  textField('hirer_date', 'Date', sigTop - 148, 120, 22);
  // The Club's side is already signed on paper: a drawn signature and printed details.
  const cx = MARGIN.left + colW + 14;
  set.text(p4, 4, STYLE.label, cx, sigTop - 24, 'Name');
  set.text(p4, 4, STYLE.body, cx, sigTop - 46, 'Tom Ashdown, Club Secretary');
  set.text(p4, 4, STYLE.label, cx, sigTop - 80, 'Signature');
  const sy = sigTop - 112;
  set.push(
    p4,
    4,
    pushGraphicsState(),
    setStrokingRgbColor(...NAVY),
    setLineWidth(1.1),
    setLineCap(1),
    moveTo(cx + 4, sy + 2),
    appendBezierCurve(cx + 12, sy + 22, cx + 20, sy + 26, cx + 18, sy + 6),
    appendBezierCurve(cx + 16, sy - 6, cx + 30, sy + 18, cx + 38, sy + 8),
    appendBezierCurve(cx + 44, sy, cx + 50, sy + 14, cx + 58, sy + 6),
    appendBezierCurve(cx + 66, sy - 2, cx + 74, sy + 12, cx + 86, sy + 4),
    appendBezierCurve(cx + 96, sy - 2, cx + 110, sy + 6, cx + 124, sy + 3),
    stroke(),
    popGraphicsState(),
  );
  set.push(
    p4,
    4,
    ...strokeLine(
      [
        [cx, sigTop - 122],
        [cx + colW, sigTop - 122],
      ],
      INK,
      0.75,
    ),
  );
  set.text(p4, 4, STYLE.label, cx, sigTop - 148, 'Date');
  set.text(p4, 4, STYLE.body, cx, sigTop - 170, '19 August 2024');
  f4.y = sigTop - 196;
  f4.paragraph(
    'Please return the signed copy to the Club Secretary at the boathouse or by post. Keep the second copy for your records.',
    { style: STYLE.caption, leading: 12 },
  );
  set.assertPresetCovered();

  // Sensitive-data targets: each written once, on one line.
  const sensitive: DemoSensitiveTruth[] = (
    [
      ['iban', IBAN],
      ['email', EMAIL],
      ['phone', PHONE],
    ] as const
  ).map(([kind, token]) => {
    const hits = set.drawn.filter((l) => l.text.includes(token));
    const line = hits[0];
    if (hits.length !== 1 || !line) throw new Error(`${kind}: ${hits.length} lines hold ${token}`);
    const style = {
      face: (line.font === 'NotoSerif-Regular' ? 'serif' : 'sans') as FaceId,
      size: line.size,
    };
    const x = line.x + set.width(style, line.text.slice(0, line.text.indexOf(token)));
    return {
      kind,
      text: token,
      occurrences: 1,
      page: line.page,
      box: set.textBox(style, x, line.baseline, token),
      line,
    };
  });

  return {
    bytes: await save(doc, AGREEMENT),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 4,
      pages: pageExpects(4),
      fields,
      info: { Title: title, Author: `${CLUB} (fictional)` },
      xref: 'table',
      fileIdDeterministic: true,
      demo: {
        footer: DEMO_FOOTER,
        clips: [1, 2, 3, 7],
        fonts: [...fontNames(set), 'Helvetica (form field appearances, standard font)'],
        headings,
        sensitive,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Letter scan (rasterised like the M5 scans, plus a rule and a rubber stamp)
// ---------------------------------------------------------------------------

const SCAN_DPI = 200;
const PX = SCAN_DPI / 72;
const SCAN_LEFT = 72;
const SCAN_WIDTH = PAGE_W - 2 * SCAN_LEFT;
/** Paper is not pure white on a scan: a light, even tone (grey 247). */
const PAPER_TONE = 0.03;
const STAMP_INK = 0.62;

type Point = [number, number];

interface ScanFonts {
  regular: FkFont;
  bold: FkFont;
}

interface ScanLine {
  text: string;
  size: number;
  x: number;
  /** Baseline y in display space before skew. */
  baseline: number;
  bold?: boolean;
}

interface LetterText {
  language: 'eng' | 'tur';
  date: string;
  recipient: string[];
  salutation: string;
  subject: string;
  paragraphs: string[];
  closing: string;
  signer: string[];
}

interface StampSpec {
  centre: Point;
  radius: number;
  /** Degrees, counter-clockwise; stamps are rarely straight. */
  rotation: number;
  top: string;
  middle: string;
  bottom: string;
}

const STAMP: Omit<StampSpec, 'rotation'> = {
  // In the blank space below the signature, so OCR does not merge it with text lines.
  centre: [440, 200],
  radius: 48,
  top: 'RECEIVED',
  middle: '18 MAR 2024',
  bottom: 'PORT ALLERY COUNCIL',
};

const LETTER_EN: LetterText = {
  language: 'eng',
  date: '12 March 2024',
  recipient: [
    'The Licensing Officer',
    'Port Allery Town Council',
    'Market Street',
    'Port Allery PA1 2AB',
  ],
  salutation: 'Dear Sir or Madam,',
  subject: 'Temporary event notice: Autumn Head, 12 October 2024',
  paragraphs: [
    'The Harbourlight Rowing Club will hold its annual Autumn Head race on Saturday 12 October 2024, between 8 am and 4 pm. We expect around 300 rowers and 200 visitors at the boathouse on Quay Road.',
    'We would like to run a refreshments tent on the club lawn during the event and to sell soft drinks, tea and cakes. No alcohol will be sold. Please let us know whether a temporary event notice is needed for this, and which form we should use.',
    'Our marshals will keep the towpath clear for walkers and cyclists throughout the day. A site plan and our risk assessment are enclosed.',
    'Thank you for your help.',
  ],
  closing: 'Yours faithfully,',
  signer: ['Tom Ashdown', 'Club Secretary'],
};

const LETTER_TR: LetterText = {
  language: 'tur',
  date: '12 Mart 2024',
  recipient: ['Ruhsat Birimi', 'Port Allery Belediyesi', 'Market Street', 'Port Allery PA1 2AB'],
  salutation: 'Sayın Yetkili,',
  subject: 'Geçici etkinlik bildirimi: Autumn Head, 12 Ekim 2024',
  paragraphs: [
    'Harbourlight Kürek Kulübü, yıllık Autumn Head yarışını 12 Ekim 2024 Cumartesi günü saat 08.00 ile 16.00 arasında düzenleyecektir. Quay Road’daki kayıkhanede yaklaşık 300 kürekçi ve 200 ziyaretçi bekliyoruz.',
    'Etkinlik süresince kulübün çimenliğinde bir ikram çadırı kurmak ve meşrubat, çay ve kek satmak istiyoruz. Alkollü içki satılmayacaktır. Bunun için geçici etkinlik bildirimi gerekip gerekmediğini ve hangi formu kullanmamız gerektiğini bildirmenizi rica ederiz.',
    'Görevlilerimiz gün boyunca yürüyüş ve bisiklet yolunu açık tutacaktır. Alan planı ve risk değerlendirmemiz ektedir.',
    'İlginiz ve yardımınız için teşekkür ederiz.',
  ],
  closing: 'Saygılarımla,',
  signer: ['Tom Ashdown', 'Kulüp Sekreteri'],
};

function fkWidth(font: FkFont, size: number, text: string): number {
  const run = font.layout(text);
  return (
    run.glyphs.reduce((n, g, i) => n + (run.positions[i]?.xAdvance ?? g.advanceWidth), 0) *
    (size / font.unitsPerEm)
  );
}

function fkWrap(font: FkFont, size: number, text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && fkWidth(font, size, candidate) > width) {
      lines.push(current);
      current = word;
    } else current = candidate;
  }
  if (current) lines.push(current);
  return lines;
}

/** Places the letter's lines on the page (display space, before skew). */
function letterLines(fonts: ScanFonts, letter: LetterText): { lines: ScanLine[]; ruleY: number } {
  const lines: ScanLine[] = [
    { text: 'HARBOURLIGHT ROWING CLUB', size: 15, x: SCAN_LEFT, baseline: 770, bold: true },
    { text: 'The Boathouse, Quay Road, Port Allery PA3 7RW', size: 9, x: SCAN_LEFT, baseline: 755 },
    { text: letter.date, size: 11, x: SCAN_LEFT, baseline: 712 },
    ...letter.recipient.map((text, i) => ({
      text,
      size: 11,
      x: SCAN_LEFT,
      baseline: 682 - i * 16,
    })),
    { text: letter.salutation, size: 11, x: SCAN_LEFT, baseline: 598 },
    { text: letter.subject, size: 11, x: SCAN_LEFT, baseline: 572, bold: true },
  ];
  let y = 546;
  for (const paragraph of letter.paragraphs) {
    for (const text of fkWrap(fonts.regular, 11, paragraph, SCAN_WIDTH)) {
      lines.push({ text, size: 11, x: SCAN_LEFT, baseline: y });
      y -= 16;
    }
    y -= 8;
  }
  lines.push({ text: letter.closing, size: 11, x: SCAN_LEFT, baseline: y - 4 });
  y -= 58; // room for a handwritten signature (left blank)
  for (const text of letter.signer) {
    lines.push({ text, size: 11, x: SCAN_LEFT, baseline: y, bold: text === letter.signer[0] });
    y -= 16;
  }
  lines.push({ text: DEMO_FOOTER, size: 8, x: SCAN_LEFT, baseline: 40 });
  return { lines, ruleY: 744 };
}

/** Rasterises one letter page; returns its grey pixels and the OCR ground truth. */
function scanLetterPage(
  fonts: ScanFonts,
  letter: LetterText,
  page: { n: number; skew: number; specks: number; stampRotation: number },
  seed: string,
): { grey: Uint8Array; truth: OcrPageTruth; width: number; height: number } {
  const width = Math.round(PAGE_W * PX);
  const height = Math.round(PAGE_H * PX);
  const canvas = new Canvas(width, height);
  const theta = (page.skew * Math.PI) / 180;
  const [cos, sin] = [Math.cos(theta), Math.sin(theta)];
  const [cx, cy] = [PAGE_W / 2, PAGE_H / 2];
  /** Display space (unskewed) -> as printed and scanned (rotated about the page centre). */
  const rot = (x: number, y: number): Point => [
    cx + (x - cx) * cos - (y - cy) * sin,
    cy + (x - cx) * sin + (y - cy) * cos,
  ];
  const toPx = ([x, y]: Point): Point => [x * PX, (PAGE_H - y) * PX];
  const bounds = (rect: [number, number, number, number]) => {
    const [x0, y0, x1, y1] = rect;
    const shown = [rot(x0, y0), rot(x1, y0), rot(x1, y1), rot(x0, y1)];
    const xs = shown.map((p) => p[0]);
    const ys = shown.map((p) => p[1]);
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

  const { lines: specLines, ruleY } = letterLines(fonts, letter);
  const lines: OcrLineTruth[] = [];
  const words: OcrWordTruth[] = [];
  for (const line of specLines) {
    const font = line.bold ? fonts.bold : fonts.regular;
    const scale = line.size / font.unitsPerEm;
    const run = font.layout(line.text);
    const expectedWords = line.text.split(' ');
    const wordInk: [number, number, number, number][] = [];
    let current: [number, number, number, number] | null = null;
    let pen = 0;
    for (const [i, glyph] of run.glyphs.entries()) {
      const pos = run.positions[i];
      const ox = line.x + (pen + (pos?.xOffset ?? 0)) * scale;
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

  // The printed rule under the letterhead.
  const rule: [number, number, number, number] = [
    SCAN_LEFT,
    ruleY - 0.4,
    PAGE_W - SCAN_LEFT,
    ruleY + 0.4,
  ];
  canvas.fillPolygons([
    [
      rot(rule[0], rule[1]),
      rot(rule[2], rule[1]),
      rot(rule[2], rule[3]),
      rot(rule[0], rule[3]),
    ].map(toPx),
  ]);
  const marks: OcrMarkTruth[] = [
    { kind: 'rule', ...bounds([rule[0], rule[1] - 1, rule[2], rule[3] + 1]) },
  ];

  // The rubber stamp, inked on a canvas of its own and blended in with patchy ink.
  const stamp: StampSpec = { ...STAMP, rotation: page.stampRotation };
  const ink = new Canvas(width, height);
  drawStamp(ink, fonts.bold, stamp, (p) => toPx(rot(...p)));
  const [sx, sy] = stamp.centre;
  const reach = stamp.radius + 2;
  const stampBounds = bounds([sx - reach, sy - reach, sx + reach, sy + reach]);
  marks.push({
    kind: 'stamp',
    text: `${stamp.top} ${stamp.middle} ${stamp.bottom}`,
    ...stampBounds,
  });
  const patch = valueNoise(seededRandom(`${seed}#stamp`), 14);
  const [left, top, w, h] = stampBounds.px;
  for (let y = Math.max(0, top); y < Math.min(height, top + h); y++)
    for (let x = Math.max(0, left); x < Math.min(width, left + w); x++) {
      const i = y * width + x;
      const c = Math.min(1, ink.coverage[i] ?? 0);
      if (c)
        canvas.coverage[i] =
          (canvas.coverage[i] ?? 0) + c * STAMP_INK * (0.62 + 0.38 * patch(x, y));
    }

  const truth: OcrPageTruth = {
    page: page.n,
    language: letter.language,
    rotate: 0,
    image: {
      resource: 'Im1',
      width,
      height,
      dpi: SCAN_DPI,
      colorSpace: 'DeviceGray',
      bitsPerComponent: 8,
      filter: 'FlateDecode',
      matrix: [r2(PAGE_W), 0, 0, r2(PAGE_H), 0, 0],
    },
    skewDegrees: page.skew,
    marks,
    text: specLines.map((l) => l.text).join('\n'),
    lines,
    words,
  };
  // Dust: seeded 1-2 px specks of 25-70 % grey anywhere on the page (as in M5).
  const random = seededRandom(seed);
  for (let n = 0; n < page.specks; n++) {
    const x = Math.floor(random() * width);
    const y = Math.floor(random() * height);
    const size = random() < 0.8 ? 1 : 2;
    const amount = 0.25 + random() * 0.45;
    for (let dy = 0; dy < size; dy++)
      for (let dx = 0; dx < size; dx++) {
        const i = Math.min(height - 1, y + dy) * width + Math.min(width - 1, x + dx);
        canvas.coverage[i] = (canvas.coverage[i] ?? 0) + amount;
      }
  }
  truth.noise = { kind: 'speckle', specks: page.specks, seed };
  for (let i = 0; i < canvas.coverage.length; i++)
    canvas.coverage[i] = (canvas.coverage[i] ?? 0) + PAPER_TONE;
  return { grey: canvas.toGrey(), truth, width, height };
}

/** Smooth seeded noise in [0, 1] on a grid of `cell` pixels (bilinear), for uneven stamp ink. */
function valueNoise(random: () => number, cell: number): (x: number, y: number) => number {
  const cols = 512;
  const grid = Array.from({ length: cols * cols }, () => random());
  const at = (gx: number, gy: number) => grid[(gy % cols) * cols + (gx % cols)] ?? 0;
  return (x, y) => {
    const fx = x / cell;
    const fy = y / cell;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  };
}

/**
 * A round "RECEIVED" stamp: two rings, the top text on an arc reading clockwise, the
 * bottom text on an arc reading counter-clockwise (upright), the date across the middle.
 * `place` maps page points (display space) to pixels.
 */
function drawStamp(ink: Canvas, font: FkFont, stamp: StampSpec, place: (p: Point) => Point): void {
  const [cx, cy] = stamp.centre;
  const phi = (stamp.rotation * Math.PI) / 180;
  const local = (u: number, v: number): Point => [
    cx + u * Math.cos(phi) - v * Math.sin(phi),
    cy + u * Math.sin(phi) + v * Math.cos(phi),
  ];
  const circle = (r: number, reverse: boolean): Point[] => {
    const pts = Array.from({ length: 160 }, (_, i) => {
      const a = (2 * Math.PI * i) / 160;
      return place(local(r * Math.cos(a), r * Math.sin(a)));
    });
    return reverse ? pts.reverse() : pts;
  };
  const ring = (inner: number, outer: number) =>
    ink.fillPolygons([circle(outer, false), circle(inner, true)]);
  // Outer ring 45.4-48 pt, inner ring 35.2-36.2 pt: the arc text sits in the band between.
  ring(stamp.radius - 2.6, stamp.radius);
  ring(stamp.radius - 12.8, stamp.radius - 11.8);

  const glyphs = (text: string, size: number, tracking: number) => {
    const run = font.layout(text);
    const scale = size / font.unitsPerEm;
    return run.glyphs.map((g, i) => ({
      glyph: g,
      width: (run.positions[i]?.xAdvance ?? g.advanceWidth) * scale,
      scale,
      tracking,
    }));
  };
  const arc = (text: string, size: number, radius: number, top: boolean, tracking: number) => {
    const gs = glyphs(text, size, tracking);
    const total = gs.reduce((n, g) => n + g.width + tracking, -tracking);
    let theta = top ? Math.PI / 2 + total / radius / 2 : -Math.PI / 2 - total / radius / 2;
    for (const g of gs) {
      const mid = top ? theta - g.width / 2 / radius : theta + g.width / 2 / radius;
      const xhat: Point = top ? [Math.sin(mid), -Math.cos(mid)] : [-Math.sin(mid), Math.cos(mid)];
      const yhat: Point = top ? [Math.cos(mid), Math.sin(mid)] : [-Math.cos(mid), -Math.sin(mid)];
      const ox = radius * Math.cos(mid) - (g.width / 2) * xhat[0];
      const oy = radius * Math.sin(mid) - (g.width / 2) * xhat[1];
      ink.fillPath(g.glyph.path.commands, (gx, gy) =>
        place(
          local(
            ox + gx * g.scale * xhat[0] + gy * g.scale * yhat[0],
            oy + gx * g.scale * xhat[1] + gy * g.scale * yhat[1],
          ),
        ),
      );
      const step = (g.width + tracking) / radius;
      theta = top ? theta - step : theta + step;
    }
  };
  arc(stamp.top, 8.5, stamp.radius - 10.6, true, 1.5); // caps reach 43.6 pt
  arc(stamp.bottom, 6.8, stamp.radius - 3.8, false, 0.9); // caps reach down to 39.2 pt
  // Date across the middle between two short bars.
  const middle = glyphs(stamp.middle, 10, 0.4);
  let pen = -middle.reduce((n, g) => n + g.width + 0.4, -0.4) / 2;
  for (const g of middle) {
    const x0 = pen;
    ink.fillPath(g.glyph.path.commands, (gx, gy) =>
      place(local(x0 + gx * g.scale, -3.6 + gy * g.scale)),
    );
    pen += g.width + 0.4;
  }
  for (const v of [9.5, -8.5]) {
    const bar = [local(-26, v), local(26, v), local(26, v + 1.1), local(-26, v + 1.1)].map(place);
    ink.fillPolygons([bar]);
  }
}

async function buildLetterScan(): Promise<Built> {
  const title = 'Letter to Port Allery Town Council, 12 March 2024 (scan)';
  const doc = await newDoc(title);
  doc.setAuthor(`${CLUB} (fictional)`);
  doc.setSubject(`${DEMO_FOOTER}: scanned letter, English and Turkish`);
  const fonts: ScanFonts = {
    regular: openFont('Inter-Regular.ttf'),
    bold: openFont('Inter-Bold.ttf'),
  };
  const specs = [
    { letter: LETTER_EN, n: 1, skew: 0.7, specks: 700, stampRotation: -12 },
    { letter: LETTER_TR, n: 2, skew: -0.5, specks: 700, stampRotation: 9 },
  ];
  const pages: OcrPageTruth[] = [];
  const images: NonNullable<Built['expect']['images']> = [];
  for (const spec of specs) {
    const { grey, truth, width, height } = scanLetterPage(
      fonts,
      spec.letter,
      spec,
      `${LETTER_SCAN}#page-${spec.n}`,
    );
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
    const page = doc.addPage(A4);
    page.node.set(name('Resources'), doc.context.obj({ XObject: { Im1: image } }));
    page.node.set(
      name('Contents'),
      doc.context.register(doc.context.stream(`q ${truth.image.matrix.join(' ')} cm /Im1 Do Q`)),
    );
    pages.push(truth);
    images.push({ page: spec.n, filter: 'FlateDecode', width, height, smask: false });
  }
  return {
    bytes: await save(doc, LETTER_SCAN),
    expect: {
      pdfLibLoad: 'ok',
      pageCount: 2,
      pages: pageExpects(2),
      info: { Title: title },
      images,
      ocr: {
        languages: ['eng', 'tur'],
        font: 'Inter Regular and Bold (Inter-Regular.ttf, Inter-Bold.ttf), glyph outlines rasterised by lib/raster.ts',
        letters: 'çğıöşüİ',
        pages,
      },
      xref: 'table',
      fileIdDeterministic: true,
      demo: { footer: DEMO_FOOTER, clips: [1, 4], fonts: [] },
    },
  };
}

// ---------------------------------------------------------------------------
// Definitions and README section
// ---------------------------------------------------------------------------

const REPORT_SUMMARY =
  '10 A4 pages, fictional club annual report: cover, contents with links, 8 sections in Inter / Noto Serif subsets, bar and line charts (vector), one table, outline with named destinations, page labels i-ii, 1-8.';

export const DEMO_FIXTURES: FixtureDef[] = [
  {
    file: REPORT.a,
    tags: ['demo', 'outline', 'named-dests', 'page-labels', 'links', 'compare', 'type0-subset'],
    summary: `${REPORT_SUMMARY} Version 1 of the compare pair.`,
    behavior:
      'Demo clips 1, 2, 5, 6, 8. Opens with the outline shown; contents links and outline items land on the right pages; labels show i, ii, 1-8. Compare against v2 finds exactly the three changes in expect.demo.compare.',
    howGenerated: 'demo-fixtures.ts: pdf-lib operators, Type0 subsets with a fixed glyph preset',
    build: () => buildReport('a'),
  },
  {
    file: REPORT.b,
    tags: ['demo', 'outline', 'named-dests', 'page-labels', 'links', 'compare', 'type0-subset'],
    summary: `${REPORT_SUMMARY} Version 2: one paragraph, one table figure and one chart bar differ from v1.`,
    behavior:
      'Compare v1 -> v2: a rewritten paragraph (page 3), the October bar of figure 1 (page 4) and one table figure (page 7); pages 1, 2, 5, 6, 8, 9, 10 are byte-identical in content.',
    howGenerated: 'demo-fixtures.ts (same builder, variant b)',
    build: () => buildReport('b'),
  },
  {
    file: AGREEMENT,
    tags: ['demo', 'acroform', 'redaction', 'sensitive-data', 'type0-subset'],
    summary:
      '4 A4 pages, room-hire agreement: parties with a fictional e-mail and phone, 11 clauses with the documentation IBAN in clause 2 (once), 3 checkboxes and 3 text fields on page 4.',
    behavior:
      'Demo clips 1, 2, 3, 7. The sensitive-data finder hits the IBAN (mod-97 valid), the e-mail and the phone at the recorded boxes; after redaction a search for the IBAN finds nothing. Fields fill and save; signing adds a new signature field.',
    howGenerated: 'demo-fixtures.ts: pdf-lib operators + PDFForm (Helvetica appearances)',
    build: buildAgreement,
  },
  {
    file: LETTER_SCAN,
    tags: ['demo', 'ocr', 'scan', 'image-only', 'turkish'],
    summary:
      '2 A4 pages, image-only greyscale scans (200 dpi) of a letter: page 1 English, page 2 Turkish; slight skew, dust specks, a printed rule and a round RECEIVED stamp.',
    behavior:
      'Demo clips 1 and 4. OCR (eng on page 1, tur on page 2) should match expect.ocr; words inside the stamp mark are not part of the ground truth.',
    howGenerated: 'demo-fixtures.ts: lib/raster.ts (Inter outlines), seeded noise',
    build: buildLetterScan,
  },
];

const esc = (s: string) => s.replaceAll('|', '\\|');
const fmt = (b: Box) => `[${b.join(', ')}]`;

export function renderDemoReadme(entries: ManifestEntry[]): string {
  const get = (file: string) => {
    const e = entries.find((x) => x.file === file);
    if (!e?.expect.demo) throw new Error(`${file} missing`);
    return e;
  };
  const report = get(REPORT.b).expect;
  const agreement = get(AGREEMENT).expect;
  const scan = get(LETTER_SCAN).expect;
  const sizes = DEMO_FIXTURES.map(
    (d) => `\`${d.file}\` ${(get(d.file).bytes / 1024).toFixed(1)} KB`,
  ).join(', ');
  const headingRows = (report.demo?.headings ?? []).map(
    (h) =>
      `| ${h.page} | ${report.pageLabels?.[h.page - 1] ?? ''} | H${h.level} | ${esc(h.text)} | ${h.size} |`,
  );
  const changeRows = (report.demo?.compare?.changes ?? []).map((c) => {
    switch (c.kind) {
      case 'paragraph':
        return `| ${c.page} | paragraph in "${c.section}", lines ${c.changedLines.map((i) => i + 1).join(', ')} of ${c.a.lines.length} | "${esc(c.sentences.a)}" | "${esc(c.sentences.b)}" |`;
      case 'chart-bar':
        return `| ${c.page} | ${c.chart}, bar "${c.bar}" | ${c.a.value}, rect ${fmt(c.a.rect)} | ${c.b.value}, rect ${fmt(c.b.rect)} |`;
      default:
        return `| ${c.page} | ${c.table}, ${c.row} / ${c.column} | "${c.a.text}" ${fmt(c.a.box)} | "${c.b.text}" ${fmt(c.b.box)} |`;
    }
  });
  const sensitiveRows = (agreement.demo?.sensitive ?? []).map(
    (s) => `| ${s.kind} | \`${s.text}\` | ${s.occurrences} | ${s.page} | ${fmt(s.box)} |`,
  );
  const fieldRows = (agreement.fields ?? []).map((f) => `\`${f.name}\` (${f.type})`).join(', ');
  const ocrRows = (scan.ocr?.pages ?? []).flatMap((p) =>
    p.lines.map(
      (l) =>
        `| ${p.page} (${p.language ?? ''}) | ${esc(l.text)} | ${l.fontSize} | ${l.baseline} | ${fmt(l.box)} |`,
    ),
  );
  const marks = (scan.ocr?.pages ?? []).map(
    (p) =>
      `page ${p.page}: skew ${p.skewDegrees}°, ${p.noise?.specks ?? 0} specks, ${(p.marks ?? []).map((m) => `${m.kind} ${fmt(m.box)} (px ${fmt(m.px)})`).join(', ')}`,
  );
  const edit = report.demo?.editTarget;

  return `## Demo documents (M7)

Built by \`tools/fixtures/demo-fixtures.ts\` into \`test/fixtures/demo/\` for the README GIFs
and the about page (docs/specs/presentation.md §2.2 and §6). They are meant to look like
real documents: a fictional club's annual report in two versions, a room-hire agreement
with a form, and a scanned letter. Everything in them is invented and every page says
"${DEMO_FOOTER}". The club name "${CLUB}" was searched for before use (October 2026)
and no organisation of that name was found. The e-mail uses \`example.com\`, the phone
number \`${PHONE}\` is in Ofcom's range for drama (020 7946 0xxx), and the IBAN
\`${IBAN}\` is the well-known documentation example (it passes the mod-97 check).

Text is set in subsets of Inter Regular, Inter Bold and Noto Serif Regular from
\`packages/engine/assets/fonts\` (Type0 / Identity-H, /ToUnicode), with fixed resource
names (/F1-/F3) and fixed subset tags. Every subset holds the same preset glyphs up front
(printable ASCII, £ – — ‘ ’ “ ” • · × … and the ligatures fontkit substitutes), so glyph
ids do not depend on which text comes first: the pages that v1 and v2 share are
byte-identical, and editing a line ("2024" -> "2025") stays in the same font. Charts, the
cover illustration and the drawn signature are pdf-lib path operators. Facts for tests are
in \`manifest.json\` under \`expect.demo\` (footer, headings, charts with bar rectangles,
the table, sensitive-data boxes, the v1/v2 changes, a text-edit target) and, for the
scan, \`expect.ocr\`. Sizes: ${sizes}.

### \`demo-report-v1.pdf\` / \`demo-report-v2.pdf\`

Outline: ${REPORT_OUTLINE.map((o) => o.title).join(' / ')} (figure and table entries
nested under their sections), every item a named destination (\`/Names /Dests\`, /XYZ).
The contents page links each line to the same destinations. Text-edit target:
page ${edit?.page ?? ''}, "${esc(edit?.text ?? '')}" (${edit?.font ?? ''} ${edit?.size ?? ''} pt, baseline ${edit?.baseline ?? ''}).

| page | label | level | heading | size |
| --- | --- | --- | --- | --- |
${headingRows.join('\n')}

Changes from v1 to v2 (\`expect.demo.compare\`; identical pages ${report.demo?.compare?.identicalPages.join(', ') ?? ''}):

| page | where | v1 | v2 |
| --- | --- | --- | --- |
${changeRows.join('\n')}

### \`demo-agreement.pdf\`

Fields on page 4: ${fieldRows}; all empty or unchecked, with appearances. Sensitive data
(\`expect.demo.sensitive\`, box = the token's advance width by ascender..descender):

| kind | text | occurrences | page | box |
| --- | --- | --- | --- | --- |
${sensitiveRows.join('\n')}

### \`demo-letter-scan.pdf\` (languages: eng, tur)

Image-only pages like the M5 scans, but A4 (1654x2339 px at ${SCAN_DPI} dpi), Inter
Regular and Bold, paper tone grey 247. Besides the text, each page has a printed rule
under the letterhead and a round stamp ("${STAMP.top}", "${STAMP.middle}", "${STAMP.bottom}")
in patchy grey ink; both are listed in \`ocr.pages[].marks\` and are not part of the
ground truth (an OCR engine may read the stamp; tests should ignore words inside it).
${marks.map((m) => `- ${m}`).join('\n')}

| page | line | size | baseline (display) | ink box (user space) |
| --- | --- | --- | --- | --- |
${ocrRows.join('\n')}
`;
}
