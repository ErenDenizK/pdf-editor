/**
 * Compression analysis with pdf-lib (spec §5): every image XObject with its encoding,
 * colour space, soft mask and effective DPI (from `content-scan.ts`), every font with its
 * embedding state, and the object count. Soft masks and stencil masks referenced by other
 * images are not listed on their own: they travel with their image.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  type PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from '@cantoo/pdf-lib';

import { findPlacements, placementDpi, refKey } from './content-scan';
import type { FontInfo, ImageFilter, ImageInfo } from './types';

const KNOWN_FILTERS: ReadonlySet<string> = new Set([
  'DCTDecode',
  'FlateDecode',
  'LZWDecode',
  'RunLengthDecode',
  'CCITTFaxDecode',
  'JBIG2Decode',
  'JPXDecode',
  'ASCIIHexDecode',
  'ASCII85Decode',
]);

const FILTER_ABBREVIATIONS: Readonly<Record<string, string>> = {
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  Fl: 'FlateDecode',
  RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
  DCT: 'DCTDecode',
};

const nameOf = (value: PDFObject | undefined): string | undefined =>
  value instanceof PDFName ? value.decodeText() : undefined;

function filtersOf(dict: PDFDict): string[] {
  const raw = dict.lookup(PDFName.of('Filter'));
  const names: string[] = [];
  if (raw instanceof PDFName) names.push(raw.decodeText());
  else if (raw instanceof PDFArray) {
    for (let i = 0; i < raw.size(); i++) {
      const n = nameOf(raw.lookup(i));
      if (n) names.push(n);
    }
  }
  return names.map((n) => FILTER_ABBREVIATIONS[n] ?? n);
}

function intOf(dict: PDFDict, key: string, fallback = 0): number {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFNumber ? value.asNumber() : fallback;
}

/** Colour space family name and component count. */
export function describeColorSpace(
  value: PDFObject | undefined,
  depth = 0,
): { readonly name: string; readonly components: number } {
  if (value instanceof PDFName) {
    const name = value.decodeText();
    const components =
      name === 'DeviceRGB' || name === 'RGB' || name === 'CalRGB'
        ? 3
        : name === 'DeviceCMYK' || name === 'CMYK'
          ? 4
          : name === 'DeviceGray' || name === 'G' || name === 'CalGray'
            ? 1
            : 0;
    return { name, components };
  }
  if (value instanceof PDFArray && value.size() > 0 && depth < 4) {
    const family = nameOf(value.lookup(0)) ?? 'unknown';
    switch (family) {
      case 'ICCBased': {
        const stream = value.lookup(1);
        const n = stream instanceof PDFStream ? intOf(stream.dict, 'N') : 0;
        return { name: 'ICCBased', components: n };
      }
      case 'Indexed':
      case 'I':
        return { name: 'Indexed', components: 1 };
      case 'CalRGB':
      case 'Lab':
        return { name: family, components: 3 };
      case 'CalGray':
      case 'Separation':
        return { name: family, components: 1 };
      case 'DeviceN': {
        const names = value.lookup(1);
        return { name: family, components: names instanceof PDFArray ? names.size() : 0 };
      }
      default:
        return describeColorSpace(value.lookup(0), depth + 1);
    }
  }
  return { name: 'unknown', components: 0 };
}

export interface ImageAnalysis {
  readonly images: ImageInfo[];
  readonly imageBytes: number;
}

export function analyzeImages(doc: PDFDocument): ImageAnalysis {
  const { context } = doc;
  const streams: [PDFRef, PDFStream][] = [];
  const masks = new Set<string>();
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue;
    if (object.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    streams.push([ref, object]);
    for (const key of ['SMask', 'Mask']) {
      const mask = object.dict.get(PDFName.of(key));
      if (mask instanceof PDFRef) masks.add(refKey(mask));
    }
  }

  // Placements: the largest one (lowest DPI) decides, so downsampling never goes below
  // the target where the image is shown biggest.
  const placed = new Map<
    string,
    { page: number; count: number; dpi: { x: number; y: number } | null }
  >();
  const sizes = new Map(
    streams.map(([ref, s]) => [refKey(ref), [intOf(s.dict, 'Width'), intOf(s.dict, 'Height')]]),
  );
  for (const placement of findPlacements(doc)) {
    const size = sizes.get(placement.ref);
    if (!size) continue;
    const dpi = placementDpi(size[0] ?? 0, size[1] ?? 0, placement.ctm);
    const entry = placed.get(placement.ref);
    if (!entry) {
      placed.set(placement.ref, { page: placement.page, count: 1, dpi });
      continue;
    }
    entry.count += 1;
    if (dpi && entry.dpi) {
      entry.dpi = { x: Math.min(entry.dpi.x, dpi.x), y: Math.min(entry.dpi.y, dpi.y) };
    } else if (dpi && !entry.dpi) entry.dpi = dpi;
  }

  const images: ImageInfo[] = [];
  let imageBytes = 0;
  for (const [ref, stream] of streams) {
    const key = refKey(ref);
    if (masks.has(key)) continue;
    const dict = stream.dict;
    const filters = filtersOf(dict);
    const last = filters.at(-1);
    const filter: ImageFilter =
      last === undefined ? 'none' : KNOWN_FILTERS.has(last) ? (last as ImageFilter) : 'other';
    const imageMask = dict.lookup(PDFName.of('ImageMask')) === PDFBool.True;
    const cs = imageMask
      ? { name: 'ImageMask', components: 1 }
      : describeColorSpace(dict.lookup(PDFName.of('ColorSpace')));
    const bytes = stream instanceof PDFRawStream ? stream.contents.length : 0;
    const where = placed.get(key);
    const bits = imageMask ? 1 : intOf(dict, 'BitsPerComponent', filter === 'JPXDecode' ? 8 : 0);
    images.push({
      ref: key,
      page: where?.page ?? null,
      width: intOf(dict, 'Width'),
      height: intOf(dict, 'Height'),
      colorSpace: cs.name,
      components: cs.components,
      bitsPerComponent: bits,
      filter,
      filters,
      hasSMask: dict.get(PDFName.of('SMask')) !== undefined,
      hasMask: dict.get(PDFName.of('Mask')) !== undefined,
      imageMask,
      bytes,
      dpi: where?.dpi ? { x: Math.round(where.dpi.x), y: Math.round(where.dpi.y) } : null,
      placements: where?.count ?? 0,
    });
    imageBytes += bytes;
  }
  images.sort((a, b) => (a.page ?? Infinity) - (b.page ?? Infinity) || b.bytes - a.bytes);
  return { images, imageBytes };
}

export function analyzeFonts(doc: PDFDocument): { fonts: FontInfo[]; fontBytes: number } {
  const { context } = doc;
  const fonts: FontInfo[] = [];
  let fontBytes = 0;
  const describe = (dict: PDFDict): { embedded: boolean; bytes: number } => {
    const descriptor = dict.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    if (!descriptor) return { embedded: false, bytes: 0 };
    for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
      const file = descriptor.lookup(PDFName.of(key));
      if (file instanceof PDFRawStream) return { embedded: true, bytes: file.contents.length };
    }
    return { embedded: false, bytes: 0 };
  };
  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (object.get(PDFName.of('Type')) !== PDFName.of('Font')) continue;
    const subtype = nameOf(object.get(PDFName.of('Subtype'))) ?? 'unknown';
    // Descendant CIDFonts are reported through their Type0 parent.
    if (subtype === 'CIDFontType0' || subtype === 'CIDFontType2') continue;
    const name = nameOf(object.lookup(PDFName.of('BaseFont'))) ?? '(unnamed)';
    let facts = { embedded: subtype === 'Type3', bytes: 0 };
    if (subtype === 'Type0') {
      const descendants = object.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
      const first = descendants?.lookup(0);
      if (first instanceof PDFDict) facts = describe(first);
    } else if (subtype !== 'Type3') {
      facts = describe(object);
    }
    fonts.push({
      ref: refKey(ref),
      name,
      subtype,
      embedded: facts.embedded,
      subset: /^[A-Z]{6}\+/.test(name),
      bytes: facts.bytes,
    });
    fontBytes += facts.bytes;
  }
  return { fonts, fontBytes };
}
