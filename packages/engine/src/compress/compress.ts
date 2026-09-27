/**
 * The compression pipeline (spec §5), run inside the compress worker:
 *
 * 1. Decrypt (qpdf) when the input is encrypted and a password is given.
 * 2. pdf-lib: merge duplicate streams; image pass (when enabled): for each image the
 *    shared rules in `presets.ts` accept, decode through PDFium (`pdfium-decoder.ts`),
 *    downsample by area averaging to the target DPI, encode as JPEG (or palette + Flate
 *    for ≤ 256 colours) and replace the stream only when the result is smaller.
 * 3. qpdf lossless pass: object streams, Flate level 9, unreferenced resources removed,
 *    optional linearization, optional re-encryption (AES-256).
 * 4. Never enlarge: when nothing got smaller the original bytes come back (`unchanged`).
 *
 * pdf-lib only re-serializes when step 2 changed something, so a lossless-only run is a
 * pure qpdf rewrite (research 04 §12: pdf-lib is not a repair engine).
 */
import {
  type PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from '@cantoo/pdf-lib';
import type { SecurityPolicy } from '@pdf-editor/document-model';

import { EngineError, type PlumberOptions, type PlumberResult } from '../types';
import { analyzeFonts, analyzeImages } from './analyze';
import { dedupeStreams, findDuplicateStreams } from './dedupe';
import {
  encodeGray,
  encodeIndexed,
  grayLevels,
  type ImageEncoder,
  isGray,
  LINE_ART_COLOURS,
  palette,
} from './encode';
import type { DecodedImage } from './pdfium-decoder';
import { planImage } from './presets';
import { buildProbe } from './probe';
import { downsampleArea } from './resample';
import type {
  CompressionAnalysis,
  CompressionProgress,
  CompressionResult,
  CompressionSettings,
  ImageInfo,
  ImageReport,
  PageDelta,
} from './types';

export interface CompressionDependencies {
  readonly plumber: {
    process(
      bytes: ArrayBuffer,
      options?: PlumberOptions & { readonly password?: string },
    ): Promise<PlumberResult>;
    /** Shares one qpdf instance across the jobs `task` runs (see `QpdfPlumber.batch`). */
    batch?<T>(task: () => Promise<T>): Promise<T>;
  };
  readonly decoder: {
    decode(
      probe: Uint8Array,
      options: { readonly composite: boolean; readonly width: number; readonly height: number },
    ): Promise<DecodedImage | null>;
  };
  readonly encoder: ImageEncoder;
}

export interface CompressionRunOptions {
  /** Password of an encrypted input (it is decrypted first). */
  readonly password?: string;
  /** Encrypt the output with this policy (e.g. the export's security settings). */
  readonly encrypt?: SecurityPolicy;
  /** PDF 1.4-compatible output: no object streams or xref streams. */
  readonly compatibility?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CompressionProgress) => void;
}

/** The lossless qpdf flags (spec §5 stage 1). */
export const LOSSLESS_OPTIONS: PlumberOptions = {
  objectStreams: 'generate',
  recompressFlate: true,
  removeUnreferencedResources: true,
};

const toBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new EngineError('aborted', 'Compression cancelled');
}

async function load(bytes: ArrayBuffer): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes.slice(0), {
      updateMetadata: false,
      throwOnInvalidObject: false,
      preserveXFA: true,
    });
  } catch (error) {
    throw new EngineError(
      'corrupt',
      `Could not read the document: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function decrypted(
  bytes: ArrayBuffer,
  deps: CompressionDependencies,
  password: string | undefined,
): Promise<ArrayBuffer> {
  if (password === undefined) return bytes;
  return (await deps.plumber.process(bytes, { decrypt: { password } })).bytes;
}

/** Analysis for the dialog's first stage, including the measured lossless size. */
export function analyzeCompression(
  bytes: ArrayBuffer,
  deps: Pick<CompressionDependencies, 'plumber'>,
  options: Pick<CompressionRunOptions, 'password' | 'signal'> = {},
): Promise<CompressionAnalysis> {
  const run = () => analyzeNow(bytes, deps, options);
  return deps.plumber.batch ? deps.plumber.batch(run) : run();
}

async function analyzeNow(
  bytes: ArrayBuffer,
  deps: Pick<CompressionDependencies, 'plumber'>,
  options: Pick<CompressionRunOptions, 'password' | 'signal'>,
): Promise<CompressionAnalysis> {
  const totalBytes = bytes.byteLength;
  const plain = await decrypted(bytes, deps as CompressionDependencies, options.password);
  const doc = await load(plain);
  throwIfAborted(options.signal);
  const { images, imageBytes } = analyzeImages(doc);
  const { fonts, fontBytes } = analyzeFonts(doc);
  const duplicates = await findDuplicateStreams(doc);
  let losslessBytes: number | null = null;
  try {
    let input = plain;
    if (duplicates.size > 0) {
      await dedupeStreams(doc);
      input = toBuffer(await doc.save({ useObjectStreams: true }));
    }
    losslessBytes = (await deps.plumber.process(input, LOSSLESS_OPTIONS)).bytes.byteLength;
  } catch (error) {
    if (error instanceof EngineError && error.code === 'aborted') throw error;
    // qpdf could not rewrite it: no lossless estimate (the analysis still stands).
  }
  return {
    totalBytes,
    pageCount: doc.getPageCount(),
    objectCount: doc.context.enumerateIndirectObjects().length,
    images,
    fonts,
    imageBytes,
    fontBytes,
    losslessBytes,
    duplicateStreams: duplicates.size,
  };
}

interface Candidate {
  readonly contents: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly colorSpace: PDFName | PDFArray;
  readonly filter: 'DCTDecode' | 'FlateDecode';
  readonly encoding: NonNullable<ImageReport['encoding']>;
}

/** Keys of an image dictionary that survive re-encoding. */
const KEPT_KEYS = ['Intent', 'Interpolate', 'OC', 'Metadata', 'Name', 'StructParent', 'ID'];

function replaceImage(
  doc: PDFDocument,
  ref: PDFRef,
  original: PDFStream,
  contents: Uint8Array,
  width: number,
  height: number,
  colorSpace: PDFName | PDFArray,
  filter: 'DCTDecode' | 'FlateDecode',
): void {
  const { context } = doc;
  const dict = context.obj({});
  dict.set(PDFName.of('Type'), PDFName.of('XObject'));
  dict.set(PDFName.of('Subtype'), PDFName.of('Image'));
  dict.set(PDFName.of('Width'), PDFNumber.of(width));
  dict.set(PDFName.of('Height'), PDFNumber.of(height));
  dict.set(PDFName.of('ColorSpace'), colorSpace);
  dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
  dict.set(PDFName.of('Filter'), PDFName.of(filter));
  dict.set(PDFName.of('Length'), PDFNumber.of(contents.length));
  for (const key of KEPT_KEYS) {
    const value = original.dict.get(PDFName.of(key));
    if (value !== undefined) dict.set(PDFName.of(key), value);
  }
  context.assign(ref, PDFRawStream.of(dict, contents));
}

function parseRef(key: string): PDFRef {
  const [num, gen] = key.split(' ');
  return PDFRef.of(Number(num), Number(gen));
}

async function compressImage(
  doc: PDFDocument,
  image: ImageInfo,
  settings: CompressionSettings,
  deps: CompressionDependencies,
): Promise<ImageReport> {
  const base = {
    ref: image.ref,
    page: image.page,
    before: image.bytes,
    width: image.width,
    height: image.height,
  };
  const skipped = (reason: ImageReport['reason']): ImageReport => ({
    ...base,
    action: 'skipped',
    ...(reason ? { reason } : {}),
    after: image.bytes,
  });
  const plan = planImage(image, settings);
  if (plan.action === 'skip') return skipped(plan.reason);
  const ref = parseRef(image.ref);
  const stream = doc.context.lookup(ref);
  if (!(stream instanceof PDFStream)) return skipped('decode-failed');

  let decoded: DecodedImage | null;
  try {
    const probe = await buildProbe(doc, stream, image.width, image.height, plan.flattenAlpha);
    decoded = await deps.decoder.decode(probe, {
      composite: plan.flattenAlpha,
      width: image.width,
      height: image.height,
    });
  } catch {
    decoded = null;
  }
  if (!decoded) return skipped('decode-failed');

  const candidates: Candidate[] = [];
  const gray = isGray(decoded.data);
  const colours = gray ? null : palette(decoded.data);
  // Lossless candidate at full resolution: 8-bit gray, or a palette for ≤ 256 colours.
  if (gray) {
    candidates.push({
      contents: encodeGray(decoded.data),
      width: decoded.width,
      height: decoded.height,
      colorSpace: PDFName.of('DeviceGray'),
      filter: 'FlateDecode',
      encoding: 'flate-gray',
    });
  } else if (colours !== null) {
    const indexed = encodeIndexed(decoded.data, colours);
    candidates.push({
      contents: indexed.data,
      width: decoded.width,
      height: decoded.height,
      colorSpace: doc.context.obj([
        PDFName.of('Indexed'),
        PDFName.of('DeviceRGB'),
        PDFNumber.of(indexed.hival),
        PDFHexString.of(
          Array.from(indexed.lookup, (b) => b.toString(16).padStart(2, '0')).join(''),
        ),
      ]),
      filter: 'FlateDecode',
      encoding: 'flate-indexed',
    });
  }
  // Line art (few colours or grey levels) stays lossless: JPEG rings around sharp edges.
  // Everything else also gets a downsampled JPEG candidate; the smaller one wins.
  const levels = gray ? grayLevels(decoded.data, LINE_ART_COLOURS) : colours?.length;
  if (levels === undefined || levels > LINE_ART_COLOURS) {
    let width = decoded.width;
    let height = decoded.height;
    let pixels = decoded.data;
    if (plan.downsample && (plan.width < width || plan.height < height)) {
      const w = Math.min(plan.width, width);
      const h = Math.min(plan.height, height);
      pixels = downsampleArea(decoded.data, width, height, w, h);
      width = w;
      height = h;
    }
    candidates.push({
      contents: await deps.encoder.jpeg(pixels, width, height, settings.quality),
      width,
      height,
      colorSpace: PDFName.of('DeviceRGB'),
      filter: 'DCTDecode',
      encoding: 'jpeg',
    });
  }
  const best = candidates.reduce<Candidate | undefined>(
    (min, c) => (min === undefined || c.contents.length < min.contents.length ? c : min),
    undefined,
  );
  if (!best) return skipped('not-smaller');
  const { contents, width, height, colorSpace, filter, encoding } = best;
  // A soft mask flattened onto white goes away with the old stream; count its bytes too.
  let before = image.bytes;
  if (plan.flattenAlpha) {
    const smask = stream.dict.lookup(PDFName.of('SMask'));
    if (smask instanceof PDFRawStream) before += smask.contents.length;
  }
  if (contents.length >= before) return skipped('not-smaller');
  replaceImage(doc, ref, stream, contents, width, height, colorSpace, filter);
  return {
    ...base,
    before,
    action: width !== image.width || height !== image.height ? 'downsampled' : 'recompressed',
    after: contents.length,
    newWidth: width,
    newHeight: height,
    encoding,
  };
}

export function compressPdf(
  bytes: ArrayBuffer,
  settings: CompressionSettings,
  deps: CompressionDependencies,
  options: CompressionRunOptions = {},
): Promise<CompressionResult> {
  // One qpdf instance for the whole job (decrypt, rewrite, re-encrypt).
  const run = () => compressNow(bytes, settings, deps, options);
  return deps.plumber.batch ? deps.plumber.batch(run) : run();
}

async function compressNow(
  bytes: ArrayBuffer,
  settings: CompressionSettings,
  deps: CompressionDependencies,
  options: CompressionRunOptions,
): Promise<CompressionResult> {
  const started = performance.now();
  const { signal, onProgress } = options;
  const before = bytes.byteLength;
  const original = bytes.slice(0);
  onProgress?.({ phase: 'analyzing', done: 0, total: 1 });
  const plain = await decrypted(bytes, deps, options.password);
  const doc = await load(plain);
  throwIfAborted(signal);

  const merged = await dedupeStreams(doc);
  const reports: ImageReport[] = [];
  if (settings.images) {
    const { images } = analyzeImages(doc);
    for (const [index, image] of images.entries()) {
      throwIfAborted(signal);
      onProgress?.({ phase: 'images', done: index, total: images.length });
      reports.push(await compressImage(doc, image, settings, deps));
    }
    onProgress?.({ phase: 'images', done: images.length, total: images.length });
  }
  const changed = merged > 0 || reports.some((r) => r.action !== 'skipped');
  const compatibility = options.compatibility === true;
  const intermediate = changed
    ? toBuffer(await doc.save({ useObjectStreams: !compatibility }))
    : plain;
  throwIfAborted(signal);

  onProgress?.({ phase: 'lossless', done: 0, total: 1 });
  const warnings: string[] = [];
  let output: ArrayBuffer;
  try {
    const result = await deps.plumber.process(intermediate, {
      ...LOSSLESS_OPTIONS,
      ...(compatibility ? { objectStreams: 'disable' as const } : {}),
      ...(settings.linearize ? { linearize: true } : {}),
      ...(options.encrypt ? { encrypt: options.encrypt } : {}),
    });
    output = result.bytes;
    warnings.push(...result.warnings);
  } catch (error) {
    if (error instanceof EngineError && error.code === 'aborted') throw error;
    if (options.encrypt || settings.linearize) throw error;
    warnings.push(
      `Lossless pass skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    output = intermediate;
  }
  onProgress?.({ phase: 'finishing', done: 1, total: 1 });

  const imagesSaved = reports.reduce((sum, r) => sum + (r.before - r.after), 0);
  const mustRewrite = options.encrypt !== undefined || settings.linearize === true;
  const unchanged = !mustRewrite && output.byteLength >= before;
  const finalBytes = unchanged ? original : output;
  const after = finalBytes.byteLength;
  return {
    bytes: finalBytes,
    before,
    after,
    losslessSaved: unchanged ? 0 : Math.max(0, before - after - imagesSaved),
    imagesSaved: unchanged ? 0 : imagesSaved,
    images: unchanged ? reports.map((r) => ({ ...r, after: r.before })) : reports,
    pages: pageDeltas(reports, doc.getPageCount(), unchanged),
    unchanged,
    warnings,
    durationMs: performance.now() - started,
  };
}

function pageDeltas(
  reports: readonly ImageReport[],
  pageCount: number,
  unchanged: boolean,
): PageDelta[] {
  const pages = new Map<number, { before: number; after: number }>();
  for (const report of reports) {
    if (report.page === null || report.page >= pageCount) continue;
    const entry = pages.get(report.page) ?? { before: 0, after: 0 };
    entry.before += report.before;
    entry.after += unchanged ? report.before : report.after;
    pages.set(report.page, entry);
  }
  return [...pages.entries()]
    .sort(([a], [b]) => a - b)
    .map(([page, sizes]) => ({ page, ...sizes }));
}
