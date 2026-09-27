/**
 * Presets, skip rules and the size estimate (spec §5). Pure functions shared by the UI
 * (instant estimate while the user picks a preset) and the image pass (the same rules
 * decide what really runs), so the estimate and the result never disagree about which
 * images are touched.
 */
import type {
  CompressionAnalysis,
  CompressionPresetId,
  CompressionSettings,
  ImageInfo,
  ImagePlan,
  ImageSkipReason,
} from './types';

export const COMPRESSION_PRESETS: Readonly<
  Record<Exclude<CompressionPresetId, 'custom'>, { readonly dpi: number; readonly quality: number }>
> = {
  screen: { dpi: 96, quality: 60 },
  ebook: { dpi: 150, quality: 75 },
  print: { dpi: 300, quality: 85 },
};

export function presetSettings(
  preset: CompressionPresetId,
  custom: { readonly dpi: number; readonly quality: number } = COMPRESSION_PRESETS.ebook,
): CompressionSettings {
  const base = preset === 'custom' ? custom : COMPRESSION_PRESETS[preset];
  return {
    preset,
    dpi: clamp(Math.round(base.dpi), MIN_DPI, MAX_DPI),
    quality: clamp(Math.round(base.quality), 1, 100),
    images: true,
    flattenAlpha: false,
  };
}

export const MIN_DPI = 36;
export const MAX_DPI = 1200;
/** Downsample only when the image is this much above the target (avoids tiny resamples). */
export const DOWNSAMPLE_THRESHOLD = 1.1;
/** Images smaller than this (either side, pixels) are left alone. */
export const MIN_IMAGE_SIDE = 16;
/** Streams smaller than this are not worth a re-encode. */
export const MIN_IMAGE_BYTES = 2048;
/** Decoding needs width × height × 4 bytes in PDFium's heap; bound it. */
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;

const UNSUPPORTED_FILTERS: ReadonlySet<string> = new Set([
  'CCITTFaxDecode',
  'JBIG2Decode',
  'JPXDecode',
]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

const skip = (reason: ImageSkipReason): ImagePlan => ({ action: 'skip', reason });

/** What the image pass does with one image under `settings`. */
export function planImage(image: ImageInfo, settings: CompressionSettings): ImagePlan {
  if (image.filters.some((f) => UNSUPPORTED_FILTERS.has(f))) return skip('filter-unsupported');
  if (image.imageMask) return skip('image-mask');
  if (image.bitsPerComponent === 1) return skip('bilevel');
  if (image.hasMask) return skip('has-mask');
  if (image.hasSMask && !settings.flattenAlpha) return skip('has-alpha');
  if (image.width < MIN_IMAGE_SIDE || image.height < MIN_IMAGE_SIDE) return skip('too-small');
  if (image.bytes < MIN_IMAGE_BYTES) return skip('too-small');
  if (image.width * image.height > MAX_IMAGE_PIXELS) return skip('too-large');
  const { width, height } = targetSize(image, settings.dpi);
  const downsample = width < image.width || height < image.height;
  // A JPEG at or below the target stays as it is: re-encoding it only loses quality.
  if (!downsample && image.filter === 'DCTDecode') return skip('at-target');
  return { action: 'encode', width, height, downsample, flattenAlpha: image.hasSMask };
}

/** Pixel size after downsampling to `dpi` (per axis; unknown placement = no resample). */
export function targetSize(
  image: Pick<ImageInfo, 'width' | 'height' | 'dpi'>,
  dpi: number,
): { readonly width: number; readonly height: number } {
  if (image.dpi === null) return { width: image.width, height: image.height };
  const axis = (pixels: number, current: number) =>
    current > dpi * DOWNSAMPLE_THRESHOLD
      ? Math.max(1, Math.round((pixels * dpi) / current))
      : pixels;
  return { width: axis(image.width, image.dpi.x), height: axis(image.height, image.dpi.y) };
}

/**
 * Typical baseline-JPEG cost in bytes per pixel at a quality (photographic content, 4:2:0
 * as browsers encode): ~0.1 B/px at q50, ~0.19 at q75, ~0.33 at q90. A rough model; the
 * result screen reports measured sizes.
 */
export function jpegBytesPerPixel(quality: number): number {
  const q = clamp(quality, 1, 100);
  return 0.04 + 0.0028 * q + 0.00002 * Math.max(0, q - 70) ** 2 * 5;
}

export interface CompressionEstimate {
  readonly before: number;
  /** Estimated output size. */
  readonly after: number;
  /** Share of `before` saved, 0–1. */
  readonly ratio: number;
  readonly losslessSaved: number;
  readonly imagesSaved: number;
  readonly candidates: number;
  readonly skipped: number;
  /** Spec §5 honesty rule: under 3 % the dialog says so before running. */
  readonly worthwhile: boolean;
}

export const WORTHWHILE_RATIO = 0.03;

export function estimateCompression(
  analysis: CompressionAnalysis,
  settings: CompressionSettings,
): CompressionEstimate {
  const before = analysis.totalBytes;
  const losslessAfter = Math.min(before, analysis.losslessBytes ?? before);
  const losslessSaved = before - losslessAfter;
  let imagesSaved = 0;
  let candidates = 0;
  let skipped = 0;
  if (settings.images) {
    for (const image of analysis.images) {
      const plan = planImage(image, settings);
      if (plan.action === 'skip') {
        skipped += 1;
        continue;
      }
      candidates += 1;
      const estimated = plan.width * plan.height * jpegBytesPerPixel(settings.quality);
      imagesSaved += Math.max(0, image.bytes - Math.min(image.bytes, estimated));
    }
  }
  const after = Math.max(0, losslessAfter - imagesSaved);
  const ratio = before > 0 ? (before - after) / before : 0;
  return {
    before,
    after: Math.round(after),
    ratio,
    losslessSaved,
    imagesSaved: Math.round(imagesSaved),
    candidates,
    skipped,
    worthwhile: ratio >= WORTHWHILE_RATIO,
  };
}
