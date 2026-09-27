/**
 * Compression contracts (spec document-tools.md §5). The analysis and the result are plain
 * data so they cross the worker boundary unchanged.
 */

export type CompressionPresetId = 'screen' | 'ebook' | 'print' | 'custom';

export interface CompressionSettings {
  readonly preset: CompressionPresetId;
  /** Target resolution for downsampling, in pixels per inch of the placed image. */
  readonly dpi: number;
  /** JPEG quality, 1–100. */
  readonly quality: number;
  /** Run the image pass (downsample and re-encode). Off = lossless only. */
  readonly images: boolean;
  /**
   * Images with a soft mask (alpha) are skipped unless this is set; then they are
   * composited onto white and the mask is dropped (visible change on non-white pages).
   */
  readonly flattenAlpha: boolean;
  /** Linearize the output ("fast web view"); off by default (research 04 §7). */
  readonly linearize?: boolean;
}

/** Filters as written in the image dictionary; `none` for unfiltered data. */
export type ImageFilter =
  | 'DCTDecode'
  | 'FlateDecode'
  | 'LZWDecode'
  | 'RunLengthDecode'
  | 'CCITTFaxDecode'
  | 'JBIG2Decode'
  | 'JPXDecode'
  | 'ASCIIHexDecode'
  | 'ASCII85Decode'
  | 'none'
  | 'other';

export interface ImageInfo {
  /** Object reference, e.g. "12 0". */
  readonly ref: string;
  /** First page (0-based) that shows the image; null when no page content draws it. */
  readonly page: number | null;
  readonly width: number;
  readonly height: number;
  /** Colour space family: DeviceRGB, DeviceGray, DeviceCMYK, ICCBased, Indexed, … */
  readonly colorSpace: string;
  /** Components of the colour space (1, 3, 4), 0 when unknown. */
  readonly components: number;
  readonly bitsPerComponent: number;
  /** The last filter of the chain (the one that decides the codec). */
  readonly filter: ImageFilter;
  readonly filters: readonly string[];
  readonly hasSMask: boolean;
  /** /Mask (colour key or explicit stencil). */
  readonly hasMask: boolean;
  /** /ImageMask true (a stencil). */
  readonly imageMask: boolean;
  /** Encoded stream length in bytes. */
  readonly bytes: number;
  /**
   * Effective resolution at the largest placement found in page content, in pixels per
   * inch (horizontal, vertical); null when no placement was found ("unknown").
   */
  readonly dpi: { readonly x: number; readonly y: number } | null;
  /** Number of placements found in page content (all pages). */
  readonly placements: number;
}

export interface FontInfo {
  readonly ref: string;
  readonly name: string;
  readonly subtype: string;
  readonly embedded: boolean;
  readonly subset: boolean;
  /** Bytes of the embedded font program, 0 when not embedded. */
  readonly bytes: number;
}

export interface CompressionAnalysis {
  readonly totalBytes: number;
  readonly pageCount: number;
  readonly objectCount: number;
  readonly images: readonly ImageInfo[];
  readonly fonts: readonly FontInfo[];
  /** Encoded bytes of all image streams listed in `images`. */
  readonly imageBytes: number;
  readonly fontBytes: number;
  /**
   * Size after the lossless pass alone (object streams, Flate level 9, unreferenced
   * resources removed, duplicate streams merged), measured by running it; null when qpdf
   * could not run.
   */
  readonly losslessBytes: number | null;
  /** Streams with identical bytes that the lossless pass merges. */
  readonly duplicateStreams: number;
}

export type ImageSkipReason =
  | 'filter-unsupported'
  | 'image-mask'
  | 'bilevel'
  | 'has-alpha'
  | 'has-mask'
  | 'at-target'
  | 'too-small'
  | 'too-large'
  | 'not-smaller'
  | 'decode-failed'
  | 'not-placed';

export type ImagePlan =
  | { readonly action: 'skip'; readonly reason: ImageSkipReason }
  | {
      readonly action: 'encode';
      /** Pixel size after downsampling (equal to the source when not downsampled). */
      readonly width: number;
      readonly height: number;
      readonly downsample: boolean;
      /** Composite a soft mask onto white first. */
      readonly flattenAlpha: boolean;
    };

export type ImageAction = 'downsampled' | 'recompressed' | 'skipped';

export interface ImageReport {
  readonly ref: string;
  readonly page: number | null;
  readonly action: ImageAction;
  readonly reason?: ImageSkipReason;
  readonly before: number;
  readonly after: number;
  readonly width: number;
  readonly height: number;
  readonly newWidth?: number;
  readonly newHeight?: number;
  /** Encoding written: 'jpeg' or 'flate-indexed' (few colours, lossless). */
  readonly encoding?: 'jpeg' | 'flate-indexed';
}

export interface PageDelta {
  readonly page: number;
  /** Image bytes attributed to this page (first page showing each image). */
  readonly before: number;
  readonly after: number;
}

export interface CompressionResult {
  readonly bytes: ArrayBuffer;
  readonly before: number;
  readonly after: number;
  /** After the lossless pass alone (for the result screen breakdown). */
  readonly losslessSaved: number;
  readonly imagesSaved: number;
  readonly images: readonly ImageReport[];
  readonly pages: readonly PageDelta[];
  /** True when nothing got smaller and the original bytes were returned. */
  readonly unchanged: boolean;
  readonly warnings: readonly string[];
  readonly durationMs: number;
}

export type CompressionPhase = 'analyzing' | 'lossless' | 'images' | 'finishing';

export interface CompressionProgress {
  readonly phase: CompressionPhase;
  readonly done: number;
  readonly total: number;
}
