/** Shared helpers and manifest types for the fixture generator and verifier. */
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(TOOL_DIR, '..', '..');
export const FIXTURES_DIR = resolve(REPO_ROOT, 'test', 'fixtures');

/** Every fixture carries this CreationDate/ModDate (and XMP dates). */
export const FIXED_DATE = new Date('2024-01-01T00:00:00Z');
export const FIXED_DATE_PDF = 'D:20240101000000Z';
export const FIXED_DATE_XMP = '2024-01-01T00:00:00Z';

export const PDF_LIB_VERSION = '2.11.1';
export const PRODUCER = `@cantoo/pdf-lib ${PDF_LIB_VERSION}`;
export const CREATOR = 'pdf-editor fixture generator (tools/fixtures/generate.ts)';

export const MAX_CORPUS_BYTES = 6 * 1024 * 1024;

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Stable 16-byte file identifier derived from the fixture name. */
export function fileIdFor(name: string): Uint8Array {
  return new Uint8Array(createHash('md5').update(`pdf-editor-fixture:${name}`).digest());
}

/** mulberry32 seeded from the fixture name: deterministic, not secure. */
export function seededRandom(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Runs `fn` with `Math.random` and `crypto.getRandomValues` replaced by a PRNG
 * seeded from `seed`. pdf-lib's encryption draws file IDs, keys, salts and AES
 * IVs from `crypto.getRandomValues`; seeding it makes encrypted fixtures
 * byte-reproducible. This deliberately makes the fixtures' keys predictable,
 * which is fine for test data and must never be copied into product code.
 */
export async function withDeterministicRandom<T>(seed: string, fn: () => Promise<T>): Promise<T> {
  const random = seededRandom(seed);
  const webCrypto = globalThis.crypto;
  const originalMathRandom = Math.random;
  const originalGetRandomValues = Object.getOwnPropertyDescriptor(webCrypto, 'getRandomValues');
  Math.random = random;
  Object.defineProperty(webCrypto, 'getRandomValues', {
    configurable: true,
    writable: true,
    value: <A extends ArrayBufferView | null>(array: A): A => {
      if (array) {
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
      }
      return array;
    },
  });
  try {
    return await fn();
  } finally {
    Math.random = originalMathRandom;
    if (originalGetRandomValues) {
      Object.defineProperty(webCrypto, 'getRandomValues', originalGetRandomValues);
    } else {
      delete (webCrypto as { getRandomValues?: unknown }).getRandomValues;
    }
  }
}

// ---------------------------------------------------------------------------
// Manifest types (test/fixtures/manifest.json)
// ---------------------------------------------------------------------------

/** [x, y, width, height] in PDF user space units (1/72 in). */
export type Box = [number, number, number, number];

export interface PageExpectation {
  /** 1-based physical page number. */
  page: number;
  mediaBox: Box;
  cropBox?: Box;
  trimBox?: Box;
  bleedBox?: Box;
  /** Effective /Rotate (after inheritance). */
  rotate: number;
  /** Size as displayed after applying /Rotate to the CropBox. */
  displayedSize?: [number, number];
  /** Strings that appear in the page content stream (text-extraction targets). */
  markers?: string[];
}

export interface PageRangeExpectation {
  first: number;
  last: number;
  mediaBox: Box;
  rotate: number;
  /** How the attributes reach the leaves. */
  inheritedFrom?: string;
}

export interface OutlineExpectation {
  title: string;
  /** 1-based target page. */
  page: number;
  /** How the item addresses its target. */
  target: 'explicit-dest' | 'named-dest-string' | 'named-dest-name' | 'goto-action-named';
  destName?: string;
  /** Whether the item's children are shown (positive /Count); omitted for leaves. */
  open?: boolean;
  children?: OutlineExpectation[];
}

export interface LinkExpectation {
  page: number;
  kind: 'goto-explicit' | 'dest-named' | 'uri';
  /** 1-based target page for internal links. */
  targetPage?: number;
  destName?: string;
  uri?: string;
}

export interface FieldExpectation {
  /** Fully qualified field name. */
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'dropdown';
  value: string | boolean;
  page: number;
  options?: string[];
  /** Whether the widget(s) carry an /AP dictionary. */
  hasAppearance: boolean;
}

export interface EncryptionExpectation {
  algorithm: 'RC4-40' | 'RC4-128' | 'AES-128' | 'AES-256';
  filter: 'Standard';
  v: number;
  r: number;
  lengthBits: number;
  /** Signed 32-bit /P value as stored in the file. */
  p: number;
  permissions: { print: boolean; modify: boolean; copy: boolean };
  userPassword: string;
  ownerPassword: string;
}

export interface AnnotationExpectation {
  page: number;
  subtype: string;
  nm: string;
  hasAppearance: boolean;
  flags: number;
  quadPoints?: number[];
  inkStrokes?: number;
  popupOf?: string;
  blendMode?: string;
}

/** Font behind a text region (text-editing fixtures). */
export interface FontExpectation {
  /** Resource name in the page (or form) /Font dictionary, without the slash. */
  resource: string;
  subtype: 'Type1' | 'TrueType' | 'Type0' | 'Type3';
  baseFont?: string;
  /** /Encoding as a name (WinAnsiEncoding, Identity-H) or "Differences" for a dict. */
  encoding: string;
  /** /Subtype of the descendant CIDFont (Type0 only). */
  descendant?: 'CIDFontType0' | 'CIDFontType2';
  /** A FontFile/FontFile2/FontFile3 program is embedded. */
  embedded: boolean;
  /** BaseFont carries a six-letter subset tag (ABCDEF+Name). */
  subset: boolean;
  /** /ToUnicode CMap present. */
  toUnicode: boolean;
}

/**
 * A documented target on a page (M4 redaction and text-editing fixtures). All
 * coordinates are unrotated user space, [x, y, width, height].
 */
export interface RegionExpectation {
  /** Stable id for tests, e.g. "tj-single". */
  id: string;
  page: number;
  kind: 'text' | 'image' | 'inline-image' | 'annotations' | 'vector-text';
  /** Exact string the region shows (text kinds). */
  text?: string;
  fontSize?: number;
  /** Baseline: y for horizontal text, x for text rotated by a text matrix. */
  baseline?: number;
  /**
   * Tight box. Text: advance width (TJ adjustments included) by font
   * descender..ascender; images: the painted rectangle.
   */
  box: Box;
  /** Suggested redaction / selection area. Covers the box and nothing unrelated. */
  area?: Box;
  /** Image XObject resource name or Form XObject path. */
  xobject?: string;
  font?: FontExpectation;
  /** Text render mode (Tr) when not 0. */
  renderMode?: number;
  /** Whether a text extractor returns `text` here. */
  extractable?: boolean;
  /** How the region is encoded, in words. */
  note: string;
}

/** Where a sensitive token lives (redaction fixtures). */
export interface SecretExpectation {
  token: string;
  /**
   * Objects of the current revision whose decoded value contains the token
   * contiguously, as paths from the trailer (lib/scan.ts). Text split across
   * TJ arrays or text objects is not found this way; see `extracted`.
   */
  locations: string[];
  /** Occurrences a text extractor finds per page (split runs included). */
  extracted: { page: number; count: number }[];
  /** Whether the raw file bytes contain the token (strings in hex/UTF-16 or compressed streams do not). */
  inRawBytes: boolean;
}

/** Incremental-update history (redaction fixtures). */
export interface IncrementalExpectation {
  revisions: number;
  /** startxref value of each revision, oldest first. */
  startxrefs: number[];
  /** /Prev of the newest trailer (= the first revision's startxref). */
  prev: number;
  /** Length of revision 1: the file truncated here is the original, complete PDF. */
  revision1Bytes: number;
  /** Objects redefined by the update ("n g R"). */
  replaced: string[];
  /** Token locations in revision 1 alone (same format as SecretExpectation.locations). */
  revision1Locations: string[];
}

export interface Expectations {
  /** What `PDFDocument.load` from @cantoo/pdf-lib does with this file. */
  pdfLibLoad: 'ok' | 'throws';
  pdfLibLoadOptions?: { password?: string; preserveXFA?: boolean };
  /** Count after a correct open (or after repair, for the broken fixtures). */
  pageCount: number;
  pages?: PageExpectation[];
  pageRanges?: PageRangeExpectation[];
  pageLabels?: string[];
  outline?: OutlineExpectation[];
  outlineVisibleCount?: number;
  namedDests?: { name: string; page: number; tree: 'Names/Dests' | 'Catalog/Dests' }[];
  links?: LinkExpectation[];
  fields?: FieldExpectation[];
  needAppearances?: boolean;
  xfa?: boolean;
  encryption?: EncryptionExpectation;
  info?: Record<string, string>;
  xmp?: Record<string, string>;
  attachments?: { name: string; content: string; mimeType: string }[];
  images?: { page: number; filter: string; width: number; height: number; smask: boolean }[];
  annotations?: AnnotationExpectation[];
  tagged?: { marked: boolean; structTypes: string[]; structParents: number[]; mcids: number[] };
  regions?: RegionExpectation[];
  secret?: SecretExpectation;
  incremental?: IncrementalExpectation;
  /** For the damaged fixtures: what was done to the source bytes. */
  damage?: Record<string, string | number>;
  xref?: 'table' | 'stream';
  fileIdDeterministic: boolean;
}

export interface ManifestEntry {
  file: string;
  bytes: number;
  sha256: string;
  pageCount: number;
  tags: string[];
  summary: string;
  derivedFrom?: string;
  passwords?: { user: string; owner: string };
  expect: Expectations;
}

export interface Manifest {
  $comment: string;
  generator: string;
  pdfLib: string;
  fixedDate: string;
  fixtures: ManifestEntry[];
}
