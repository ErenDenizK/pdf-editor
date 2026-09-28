/**
 * SPIKE S1 (M5): not product code. Browser-side helpers shared by ocr-accuracy.spike.ts and
 * ocr-layer.spike.ts: synthetic pages with known words, "scans" made from them, PDFium
 * rasterisation to 8-bit greyscale (PGM), a tesseract.js recognizer served from our origin,
 * word-accuracy metrics, and a prototype of the invisible text layer (spec §1.2) with
 * Tesseract's glyphless pdf.ttf.
 */
import fontkit from '@cantoo/fontkit';
import {
  type PDFContext,
  PDFDocument,
  PDFName,
  type PDFRef,
  PDFString,
  rgb,
} from '@cantoo/pdf-lib';
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import type { SourceId } from '@pdf-editor/document-model';
import { PdfiumAdapter, PdfLibAssembler } from '@pdf-editor/engine';
import Tesseract from 'tesseract.js';

import notoSerifUrl from '../../packages/engine/assets/fonts/NotoSerif-Regular.ttf?url';

// ---------------------------------------------------------------------------
// Known text
// ---------------------------------------------------------------------------

export const SENTENCES_EN = [
  'The committee reviewed the annual budget on Tuesday and approved most of the proposed changes.',
  'Several members asked for a clearer breakdown of travel costs, which rose by 14% compared with 2023.',
  'Printed forms are still accepted, but electronic submissions are processed about three days faster.',
  'Please return the signed agreement no later than 30 June, together with a copy of your identity card.',
  'The quick brown fox jumps over the lazy dog while the farmer counts his sheep in the valley.',
  'Our laboratory measured the samples twice; the second series confirmed the original results.',
  'If you have questions about this notice, call the help desk between 9:00 and 17:00 on weekdays.',
  'Temperatures in the northern region dropped sharply overnight, and several roads were closed.',
  'A detailed invoice, including taxes and delivery charges, is attached to this letter.',
  'The library will extend its opening hours during the examination period in January.',
  'Researchers found that regular exercise improves both memory and concentration in older adults.',
  'Minutes of the meeting were distributed to all participants and archived in the shared folder.',
];

export const SENTENCES_TR = [
  'Günümüzde bilgisayarların çoğu, İnternet üzerinden güvenli bir şekilde çalışır.',
  'Öğretmenimiz sınıfta ödevlerimizi dikkatle inceledi ve bize yeni sorular sordu.',
  "İstanbul Boğazı'nın kıyısında yürüyüş yapmak, şehrin en güzel deneyimlerinden biridir.",
  'Çocuklar bahçede oynarken büyükler çay içip gazete okuyordu.',
  'Şirketin yıllık raporu, üretimin yüzde on iki arttığını gösteriyor.',
  'Ağaçların yaprakları sonbaharda sararır ve rüzgarla birlikte yere düşer.',
  'Ülkemizin doğusunda kış mevsimi uzun ve oldukça soğuk geçer.',
  'Işık hızıyla ilgili ölçümler, fizik laboratuvarında özenle tekrarlandı.',
  "Güneşli bir öğleden sonra, İzmir'deki küçük bir kafede buluştuk.",
  'Müşteri hizmetleri, şikayetleri üç iş günü içinde yanıtlamayı taahhüt ediyor.',
  'Belediye, Çarşamba günü yapılacak toplantının saatini değiştirdiğini duyurdu.',
  'ÇOK ÖNEMLİ: ŞUBAT AYINDA ÖDEME GÜNÜ DEĞİŞTİ, LÜTFEN İŞLEMLERİNİZİ KONTROL EDİNİZ.',
];

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Geometry and page fixtures
// ---------------------------------------------------------------------------

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TruthWord {
  readonly text: string;
  /** Unrotated user space of the digital page. */
  readonly rect: Box;
}

export interface TextPage {
  readonly bytes: Uint8Array;
  readonly words: readonly TruthWord[];
  readonly size: readonly [number, number];
}

const A4: readonly [number, number] = [595.28, 841.89];

let notoSerif: Promise<Uint8Array> | undefined;
async function serifBytes(): Promise<Uint8Array> {
  notoSerif ??= fetch(notoSerifUrl).then(async (r) => new Uint8Array(await r.arrayBuffer()));
  return notoSerif;
}

/**
 * A dense A4 page: 11 pt Noto Serif (a bundled engine font), 15 pt leading, 56 pt margins,
 * sentences drawn in seeded order until `lines` lines are filled. Word boxes come from the
 * layout (advance widths, ascender/descender of the font).
 */
export async function denseTextPage(
  sentences: readonly string[],
  seed: number,
  lines = 42,
  title?: string,
): Promise<TextPage> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await serifBytes(), { subset: false });
  const page = doc.addPage([A4[0], A4[1]]);
  const size = 11;
  const leading = 15;
  const margin = 56;
  const maxWidth = A4[0] - 2 * margin;
  const ascent = font.heightAtSize(size, { descender: false });
  const full = font.heightAtSize(size);
  const descent = full - ascent;
  const space = font.widthOfTextAtSize(' ', size);
  const words: TruthWord[] = [];
  const random = rng(seed);
  let y = A4[1] - margin - size;
  if (title) {
    page.drawText(title, { x: margin, y, size: 16, font, color: rgb(0, 0, 0) });
    let x = margin;
    for (const w of title.split(' ')) {
      const width = font.widthOfTextAtSize(w, 16);
      const h = font.heightAtSize(16, { descender: false });
      const d = font.heightAtSize(16) - h;
      words.push({ text: w, rect: { x, y: y - d, width, height: h + d } });
      x += width + font.widthOfTextAtSize(' ', 16);
    }
    y -= 28;
  }
  const queue: string[] = [];
  let line: string[] = [];
  let lineWidth = 0;
  let drawn = 0;
  const flush = (): void => {
    let x = margin;
    for (const w of line) {
      const width = font.widthOfTextAtSize(w, size);
      words.push({ text: w, rect: { x, y: y - descent, width, height: full } });
      x += width + space;
    }
    page.drawText(line.join(' '), { x: margin, y, size, font, color: rgb(0, 0, 0) });
    line = [];
    lineWidth = 0;
    y -= leading;
    drawn++;
  };
  while (drawn < lines) {
    if (queue.length === 0) {
      const sentence = sentences[Math.floor(random() * sentences.length)] ?? '';
      queue.push(...sentence.split(' '));
    }
    const w = queue.shift() ?? '';
    const width = font.widthOfTextAtSize(w, size);
    const next = line.length === 0 ? width : lineWidth + space + width;
    if (next > maxWidth) {
      flush();
      if (drawn >= lines) break;
      line = [w];
      lineWidth = width;
    } else {
      line.push(w);
      lineWidth = next;
    }
  }
  return { bytes: await doc.save(), words, size: A4 };
}

// ---------------------------------------------------------------------------
// PDFium (the app's adapter)
// ---------------------------------------------------------------------------

let adapter: PdfiumAdapter | undefined;
let nextId = 0;

export function pdfium(): PdfiumAdapter {
  adapter ??= new PdfiumAdapter({ wasmUrl, inspector: new PdfLibAssembler() });
  return adapter;
}

export async function openPdf(bytes: Uint8Array): Promise<SourceId> {
  const id = `ocr-spike-${nextId++}` as SourceId;
  await pdfium().open(id, bytes.slice().buffer);
  return id;
}

export interface Grey {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly dpi: number;
}

async function imageData(id: SourceId, page: number, dpi: number): Promise<ImageData> {
  const { bitmap, width, height } = await pdfium().renderPage(id, page, {
    scale: dpi / 72,
    withAnnotations: false,
    withForms: false,
  });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

/** PDFium render → 8-bit luminance (Rec. 601), as the PDFium worker would return it. */
export async function renderGrey(id: SourceId, page: number, dpi: number): Promise<Grey> {
  const image = await imageData(id, page, dpi);
  const { width, height } = image;
  const data = new Uint8Array(width * height);
  const rgba = image.data;
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = (299 * (rgba[j] ?? 0) + 587 * (rgba[j + 1] ?? 0) + 114 * (rgba[j + 2] ?? 0)) / 1000;
  }
  return { data, width, height, dpi };
}

/** Binary PGM (P5): a 15-byte header in front of the pixels; Leptonica reads it natively. */
export function pgm(grey: Grey): Uint8Array {
  const header = new TextEncoder().encode(`P5\n${grey.width} ${grey.height}\n255\n`);
  const out = new Uint8Array(header.length + grey.data.length);
  out.set(header);
  out.set(grey.data, header.length);
  return out;
}

export async function png(grey: Grey): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(grey.width, grey.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  const image = ctx.createImageData(grey.width, grey.height);
  for (let i = 0; i < grey.data.length; i++) {
    const v = grey.data[i] ?? 0;
    image.data[i * 4] = v;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

export interface ScanOptions {
  /** DPI the "scanner" sampled the page at. */
  readonly dpi: number;
  /** Skew in degrees, clockwise as seen on screen. */
  readonly skew: number;
  /** Standard deviation of the added grey noise (0–255 scale). */
  readonly noise: number;
  /** Box-blur radius in pixels (0 = none). */
  readonly blur: number;
  readonly seed: number;
  readonly jpegQuality: number;
}

/**
 * A "scan" of page 0: rendered by PDFium at `dpi`, rotated about the page centre, blurred,
 * noised, JPEG-encoded and placed as the only content of a same-size page. Also returns
 * where each truth word ended up (axis-aligned box of its rotated rectangle), in the scan
 * page's user space.
 */
export async function makeScan(
  source: TextPage,
  o: ScanOptions,
): Promise<{ bytes: Uint8Array; words: TruthWord[] }> {
  const id = await openPdf(source.bytes);
  const image = await imageData(id, 0, o.dpi);
  await pdfium().close(id);
  const { width, height } = image;
  const src = new OffscreenCanvas(width, height);
  src.getContext('2d')?.putImageData(image, 0, 0);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  const theta = (o.skew * Math.PI) / 180;
  ctx.translate(width / 2, height / 2);
  ctx.rotate(theta);
  ctx.translate(-width / 2, -height / 2);
  if (o.blur > 0) ctx.filter = `blur(${o.blur}px)`;
  ctx.drawImage(src, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  const out = ctx.getImageData(0, 0, width, height);
  const random = rng(o.seed);
  for (let i = 0; i < out.data.length; i += 4) {
    // Box–Muller.
    const n = Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
    const lum = (out.data[i] ?? 255) + n * o.noise;
    const v = Math.max(0, Math.min(255, lum));
    out.data[i] = v;
    out.data[i + 1] = v;
    out.data[i + 2] = v;
  }
  ctx.putImageData(out, 0, 0);
  const jpeg = new Uint8Array(
    await (
      await canvas.convertToBlob({ type: 'image/jpeg', quality: o.jpegQuality })
    ).arrayBuffer(),
  );
  const doc = await PDFDocument.create();
  const [pw, ph] = source.size;
  const page = doc.addPage([pw, ph]);
  const embedded = await doc.embedJpg(jpeg);
  page.drawImage(embedded, { x: 0, y: 0, width: pw, height: ph });
  // Rotation on screen (y down) by theta about the centre, expressed in user space (y up).
  const cx = pw / 2;
  const cy = ph / 2;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const map = (x: number, y: number): [number, number] => {
    const dx = x - cx;
    const dy = cy - y; // down
    return [cx + dx * cos - dy * sin, cy - (dx * sin + dy * cos)];
  };
  const words = source.words.map((w) => {
    const r = w.rect;
    const pts = [
      map(r.x, r.y),
      map(r.x + r.width, r.y),
      map(r.x, r.y + r.height),
      map(r.x + r.width, r.y + r.height),
    ];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return {
      text: w.text,
      rect: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
    };
  });
  return { bytes: await doc.save(), words };
}

// ---------------------------------------------------------------------------
// tesseract.js from our origin (assets.ts PUBLIC_DIR is Vite's public dir)
// ---------------------------------------------------------------------------

export type Pack = 'fast' | 'best_int';

const OCR_BASE = new URL('/ocr/', location.href).href;
const RELAXED_SIMD = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15,
  65, 2, 253, 15, 253, 128, 2, 11,
]);
const SIMD = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

/** The core variant a browser gets: the probes of wasm-feature-detect, run by us. */
export function coreVariant(): string {
  if (WebAssembly.validate(RELAXED_SIMD)) return 'relaxedsimd-lstm';
  if (WebAssembly.validate(SIMD)) return 'simd-lstm';
  return 'lstm';
}

const packCache = new Map<string, Promise<Uint8Array>>();

/**
 * Our loader: fetch the gzip pack from our origin, inflate with DecompressionStream. Vite's
 * dev server (and other hosts) serve `*.gz` with `Content-Encoding: gzip`, so the browser
 * may already have inflated it: sniff the gzip magic instead of trusting the name.
 */
export function packBytes(pack: Pack, lang: string): Promise<Uint8Array> {
  const key = `${pack}/${lang}`;
  let pending = packCache.get(key);
  if (!pending) {
    pending = fetch(`${OCR_BASE}lang/${key}.traineddata.gz`).then(async (response) => {
      if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
      const raw = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Uint8Array(await new Response(raw).arrayBuffer());
    });
    packCache.set(key, pending);
  }
  return pending;
}

export async function createRecognizer(
  pack: Pack,
  langs: readonly string[],
): Promise<Tesseract.Worker> {
  const data = await Promise.all(
    langs.map(async (code) => ({ code, data: (await packBytes(pack, code)).slice() })),
  );
  return Tesseract.createWorker(data, Tesseract.OEM.LSTM_ONLY, {
    workerBlobURL: false,
    // assets.ts: one-token fix for `{ code, data }` languages.
    workerPath: `${OCR_BASE}tesseract-7.0.0/worker.patched.min.js`,
    corePath: `${OCR_BASE}tesseract-7.0.0/tesseract-core-${coreVariant()}.js`,
    cacheMethod: 'none',
  });
}

// ---------------------------------------------------------------------------
// Recognition output
// ---------------------------------------------------------------------------

export interface OcrWord {
  readonly text: string;
  readonly confidence: number;
  /** Pixel box of the raster. */
  readonly bbox: { x0: number; y0: number; x1: number; y1: number };
  /** Baseline of the word's line, pixels. */
  readonly baseline: { x0: number; y0: number; x1: number; y1: number };
  readonly rowHeight: number;
  readonly descenders: number;
  readonly lineIndex: number;
  readonly lastInLine: boolean;
}

export interface OcrPage {
  readonly words: readonly OcrWord[];
  readonly meanConfidence: number;
  readonly rotateRadians: number;
  readonly ms: number;
}

export async function recognize(
  worker: Tesseract.Worker,
  image: Uint8Array,
  options: { rotateAuto?: boolean } = {},
): Promise<OcrPage> {
  const t0 = performance.now();
  // tesseract.js's typings omit Uint8Array, which loadImage accepts (it wraps any other
  // input in a Uint8Array); `ImageLike` itself names Node's Buffer, unknown here.
  const input = image as unknown as Blob;
  const { data } = await worker.recognize(
    input,
    { rotateAuto: options.rotateAuto ?? false },
    {
      text: true,
      blocks: true,
    },
  );
  const ms = performance.now() - t0;
  const words: OcrWord[] = [];
  let lineIndex = 0;
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        line.words.forEach((word, i) => {
          if (word.text.trim() === '') return;
          words.push({
            text: word.text,
            confidence: word.confidence,
            bbox: word.bbox,
            baseline: line.baseline,
            rowHeight: line.rowAttributes.rowHeight,
            descenders: line.rowAttributes.descenders,
            lineIndex,
            lastInLine: i === line.words.length - 1,
          });
        });
        lineIndex++;
      }
    }
  }
  const meanConfidence =
    words.length === 0 ? 0 : words.reduce((sum, w) => sum + w.confidence, 0) / words.length;
  return { words, meanConfidence, rotateRadians: data.rotateRadians ?? 0, ms };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const EDGE_PUNCTUATION = /^[\s.,;:!?"'()“”‘’«»\-–—]+|[\s.,;:!?"'()“”‘’«»\-–—]+$/gu;

export function normalizeWord(word: string): string {
  return word.normalize('NFC').replace(EDGE_PUNCTUATION, '');
}

/** A longest common subsequence of `truth` and `ocr`: OCR index → truth index. */
export function lcsMatches(truth: readonly string[], ocr: readonly string[]): Map<number, number> {
  const n = truth.length;
  const m = ocr.length;
  const table = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] =
        truth[i] === ocr[j]
          ? (table[(i + 1) * (m + 1) + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * (m + 1) + j] ?? 0, table[i * (m + 1) + j + 1] ?? 0);
    }
  }
  const matched = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (truth[i] === ocr[j]) {
      matched.set(j, i);
      i++;
      j++;
    } else if ((table[(i + 1) * (m + 1) + j] ?? 0) >= (table[i * (m + 1) + j + 1] ?? 0)) i++;
    else j++;
  }
  return matched;
}

export function levenshtein(a: string, b: string): number {
  let prev = new Uint32Array(b.length + 1).map((_, j) => j);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] ?? 0;
}

export interface Accuracy {
  /** Truth words found, in order (LCS), after trimming edge punctuation. */
  readonly wordAccuracy: number;
  /** Character error rate over the space-joined texts (punctuation kept). */
  readonly cer: number;
  /** Per OCR word: confidence and whether it matched. */
  readonly perWord: readonly { confidence: number; correct: boolean }[];
}

export function accuracy(truth: readonly TruthWord[], page: OcrPage): Accuracy {
  const t = truth.map((w) => normalizeWord(w.text)).filter((w) => w !== '');
  const o = page.words.map((w) => normalizeWord(w.text));
  const matched = lcsMatches(t, o);
  const truthText = truth.map((w) => w.text.normalize('NFC')).join(' ');
  const ocrText = page.words.map((w) => w.text.normalize('NFC')).join(' ');
  return {
    wordAccuracy: t.length === 0 ? 0 : matched.size / t.length,
    cer: levenshtein(truthText, ocrText) / Math.max(1, truthText.length),
    perWord: page.words.map((w, j) => ({ confidence: w.confidence, correct: matched.has(j) })),
  };
}

// ---------------------------------------------------------------------------
// Invisible text layer (prototype of spec §1.2)
// ---------------------------------------------------------------------------

export interface LayerWord {
  readonly text: string;
  /** Baseline origin in user space, points. */
  readonly x: number;
  readonly y: number;
  /** Baseline angle in radians (counter-clockwise, user space). */
  readonly angle: number;
  readonly width: number;
  readonly fontSize: number;
  /** OCR line index: words of one line share a text object in `line` mode. */
  readonly line: number;
}

/**
 * `word`: one BT … ET per word, its own Tm (on the line's baseline) and Tz (Tesseract's
 * pdfrenderer does the same). `line`: one BT … ET and one TJ per OCR line, one Tz for the
 * line, word starts placed with TJ offsets; word ends are then only approximately right.
 */
export type LayerMode = 'word' | 'line';

/**
 * OCR words (pixels of a raster at `dpi` of an unrotated page of height `pageHeight`) to
 * layer words: baseline from the line's baseline, font size = row height, origin at the
 * descender line so that the glyph box (0..1 em above the origin in pdf.ttf) spans
 * descender to ascender, advance stretched to the box width.
 */
export function layerWords(
  words: readonly OcrWord[],
  dpi: number,
  pageHeight: number,
): LayerWord[] {
  const s = 72 / dpi;
  return words.map((w) => {
    const b = w.baseline;
    const slope = b.x1 === b.x0 ? 0 : (b.y1 - b.y0) / (b.x1 - b.x0);
    const baselineY = b.y0 + slope * (w.bbox.x0 - b.x0);
    const descent = Math.abs(w.descenders);
    const fontSize = Math.max(1, w.rowHeight) * s;
    return {
      text: w.text,
      x: w.bbox.x0 * s,
      y: pageHeight - (baselineY + descent) * s,
      angle: -Math.atan(slope),
      width: (w.bbox.x1 - w.bbox.x0) * s,
      fontSize,
      line: w.lineIndex,
    };
  });
}

function utf16Hex(text: string): string {
  let hex = '';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0');
  return hex.toUpperCase();
}

const n = (v: number): string => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(3).replace(/\.?0+$/, ''));

/** The glyphless Type0 font of Tesseract's pdfrenderer.cpp, with pdf.ttf embedded. */
function glyphlessFont(context: PDFContext, ttf: Uint8Array): PDFRef {
  const fontFile = context.register(context.flateStream(ttf, { Length1: ttf.length }));
  const descriptor = context.register(
    context.obj({
      Type: 'FontDescriptor',
      FontName: 'GlyphLessFont',
      Flags: 5,
      FontBBox: [0, 0, 500, 1000],
      ItalicAngle: 0,
      Ascent: 1000,
      Descent: -1,
      CapHeight: 1000,
      StemV: 80,
      FontFile2: fontFile,
    }),
  );
  const map = new Uint8Array(65536 * 2);
  for (let i = 1; i < map.length; i += 2) map[i] = 1;
  const cidToGid = context.register(context.flateStream(map));
  const cidFont = context.register(
    context.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: 'GlyphLessFont',
      CIDSystemInfo: {
        Registry: PDFString.of('Adobe'),
        Ordering: PDFString.of('Identity'),
        Supplement: 0,
      },
      FontDescriptor: descriptor,
      DW: 500,
      CIDToGIDMap: cidToGid,
    }),
  );
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '1 beginbfrange',
    '<0000> <FFFF> <0000>',
    'endbfrange',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
  const toUnicode = context.register(context.flateStream(cmap));
  return context.register(
    context.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'GlyphLessFont',
      Encoding: 'Identity-H',
      DescendantFonts: [cidFont],
      ToUnicode: toUnicode,
    }),
  );
}

/**
 * Appends one Form XObject of render-mode-3 words to page 0, drawn from a content stream
 * appended in `q … Q` after the existing content (wrapped in `q … Q` too). The source
 * objects are untouched; pdf-lib rewrites the file (the app would append incrementally).
 */
export async function addInvisibleLayer(
  bytes: Uint8Array,
  words: readonly LayerWord[],
  ttf: Uint8Array,
  lang: string,
  mode: LayerMode = 'word',
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const context = doc.context;
  const page = doc.getPage(0);
  const { width, height } = page.getSize();
  const font = glyphlessFont(context, ttf);
  const ops: string[] = [];
  // Every word but the page's last carries a trailing space (see the report: without it at
  // line ends, pdf.js glues words when OCR splits one visual line into two).
  const shown = (i: number): string => {
    const text = words[i]?.text ?? '';
    return i === words.length - 1 ? text : `${text} `;
  };
  if (mode === 'word') {
    words.forEach((w, i) => {
      const units = w.text.length;
      if (units === 0) return;
      const tz = (100 * w.width) / (units * 0.5 * w.fontSize);
      const cos = Math.cos(w.angle);
      const sin = Math.sin(w.angle);
      ops.push(
        'BT',
        '3 Tr',
        `/F0 ${n(w.fontSize)} Tf`,
        `${n(cos)} ${n(sin)} ${n(-sin)} ${n(cos)} ${n(w.x)} ${n(w.y)} Tm`,
        `${n(tz)} Tz`,
        `<${utf16Hex(shown(i))}> Tj`,
        'ET',
      );
    });
  } else {
    let start = 0;
    while (start < words.length) {
      let end = start;
      while (end + 1 < words.length && words[end + 1]?.line === words[start]?.line) end++;
      const first = words[start];
      if (!first) break;
      const lineWords = words.slice(start, end + 1);
      const fs = first.fontSize;
      const units = lineWords.reduce((sum, w) => sum + w.text.length, 0);
      const tz = (100 * lineWords.reduce((sum, w) => sum + w.width, 0)) / (units * 0.5 * fs);
      const unit = (0.5 * fs * tz) / 100; // advance of one glyph, points
      const cos = Math.cos(first.angle);
      const sin = Math.sin(first.angle);
      const parts: string[] = [];
      let pen = 0;
      lineWords.forEach((w, k) => {
        const target = (w.x - first.x) * cos + (w.y - first.y) * sin;
        const shift = target - pen;
        if (k > 0 && Math.abs(shift) > 1e-3) parts.push(n((-shift * 1000) / ((fs * tz) / 100)));
        const text = shown(start + k);
        parts.push(`<${utf16Hex(text)}>`);
        pen = target + text.length * unit;
      });
      ops.push(
        'BT',
        '3 Tr',
        `/F0 ${n(fs)} Tf`,
        `${n(cos)} ${n(sin)} ${n(-sin)} ${n(cos)} ${n(first.x)} ${n(first.y)} Tm`,
        `${n(tz)} Tz`,
        `[${parts.join(' ')}] TJ`,
        'ET',
      );
      start = end + 1;
    }
  }
  const form = context.register(
    context.flateStream(ops.join('\n'), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, width, height],
      Resources: { Font: { F0: font } },
      PdfEditorOCR: { Engine: PDFString.of('tesseract.js 7.0.0'), Lang: PDFString.of(lang) },
    }),
  );
  // setXObject normalises the page first, which wraps the existing content in q … Q
  // (pdf-lib's autoNormalizeCTM), so our stream starts from the default CTM.
  page.node.setXObject(PDFName.of('PdfEditorOCR0'), form);
  page.node.addContentStream(context.register(context.stream('q /PdfEditorOCR0 Do Q\n')));
  if (!doc.catalog.has(PDFName.of('Lang'))) doc.catalog.set(PDFName.of('Lang'), PDFString.of(lang));
  return doc.save({ useObjectStreams: false });
}
