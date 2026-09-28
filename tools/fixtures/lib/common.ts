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

// ---------------------------------------------------------------------------
// M5 expectations (docs/specs/recognize-and-compare.md)
// ---------------------------------------------------------------------------

/** One word of OCR ground truth. */
export interface OcrWordTruth {
  text: string;
  /**
   * Ink bounding box in user space [x, y, width, height] (union of the glyph
   * outlines' bounding boxes; on a skewed page the axis-aligned bounds of the
   * rotated box).
   */
  box: Box;
  /**
   * The same box in image pixels [left, top, width, height], top-left origin,
   * rounded outwards. The raster is in display orientation (/Rotate applied).
   */
  px: Box;
}

export interface OcrLineTruth {
  text: string;
  fontSize: number;
  /** Baseline y in user space before any skew. */
  baseline: number;
  /** Ink bounding box of the line (same conventions as OcrWordTruth.box). */
  box: Box;
}

export interface OcrPageTruth {
  page: number;
  /** Page /Rotate; the raster is drawn so that the displayed page reads upright. */
  rotate: number;
  /** One image XObject painted over the whole MediaBox (the only visible content). */
  image: {
    resource: string;
    width: number;
    height: number;
    dpi: number;
    colorSpace: 'DeviceGray';
    bitsPerComponent: 8;
    filter: 'FlateDecode';
    /** The `cm` matrix that paints it, [a b c d e f]. */
    matrix: number[];
  };
  /** An invisible (3 Tr) text layer written by "another tool", if any (spec §1.2: foreign). */
  foreignLayer?: {
    font: string;
    renderMode: 3;
    lines: {
      text: string;
      x: number;
      baseline: number;
      fontSize: number;
      horizontalScale: number;
    }[];
    /** Words the layer gets wrong on purpose, so replacing it is observable. */
    errors: { expected: string; actual: string }[];
  };
  /** Rotation of the printed text in degrees, counter-clockwise as displayed (lines rise to the right). */
  skewDegrees: number;
  /** Seeded speckle noise added after rasterising, if any. */
  noise?: { kind: 'speckle'; specks: number; seed: string };
  /** Exact text, lines joined with "\n", words with one space. */
  text: string;
  lines: OcrLineTruth[];
  /** Words in reading order (punctuation stays attached, as OCR engines report it). */
  words: OcrWordTruth[];
}

export interface OcrExpectation {
  /** Tesseract language codes that cover the text. */
  languages: string[];
  font: string;
  /** Letters the text is guaranteed to contain (scan-turkish: every Turkish letter). */
  letters?: string;
  pages: OcrPageTruth[];
}

export type SignatureStatusTruth =
  | 'intact'
  | 'intact-changed-later'
  | 'changed-after-signing'
  | 'broken'
  | 'cannot-check'
  | 'unsigned';

export interface CertificateTruth {
  /** RFC 4514 (most specific RDN first). */
  subject: string;
  issuer: string;
  /** Lowercase hex. */
  serial: string;
  notBefore: string;
  notAfter: string;
}

export interface LaterChangeTruth {
  revision: number;
  kind:
    | 'form-fill'
    | 'annotations'
    | 'signature'
    | 'dss'
    | 'metadata'
    | 'pages'
    | 'content'
    | 'other';
  pages: number[];
  /** Objects the revision's xref section defines ("n g R"). */
  objects: string[];
}

export interface SignatureTruth {
  /** Field /T. */
  field: string;
  /** 1-based page of the widget. */
  page: number;
  /** Widget /Rect as [x, y, width, height] ([0, 0, 0, 0]: invisible). */
  rect: Box;
  /** Whether the field has a /V signature dictionary. */
  signed: boolean;
  status: SignatureStatusTruth;
  filter?: string;
  subFilter?: string;
  /** 1-based revision whose end the /ByteRange reaches. */
  revision?: number;
  byteRange?: [number, number, number, number];
  /** Hex digits reserved in /Contents (the gap is this plus the two angle brackets). */
  contentsHexLength?: number;
  /** DER length of the CMS object (the rest of /Contents is zero padding). */
  cmsBytes?: number;
  coversWholeFile?: boolean;
  digestAlgorithm?: 'SHA-256' | 'SHA-1';
  /** SHA-1 is flagged weak by the validator (spec §3.1). */
  weakDigest?: boolean;
  signatureAlgorithm?: 'RSASSA-PKCS1-v1_5';
  signedAttributes?: string[];
  /** /M, the time claimed by the signer (ISO 8601). */
  claimedTime?: string;
  reason?: string;
  signer?: CertificateTruth;
  /** Subjects from the signer to the root, all embedded in the CMS. */
  chain?: string[];
  checks?: {
    byteRange: 'pass' | 'fail';
    digest: 'pass' | 'fail';
    signature: 'pass' | 'fail';
    signingCertificate: 'pass' | 'fail' | 'not-checked';
    chain: 'pass' | 'fail';
  };
  laterChanges?: LaterChangeTruth[];
}

export interface RevisionsTruth {
  count: number;
  startxrefs: number[];
  /** Byte length of the file at the end of each revision (after its %%EOF line). */
  ends: number[];
}

/** A deliberate edit of signed bytes (signed-tampered). */
export interface TamperTruth {
  /** File offset of the changed byte (inside the first signed range). */
  offset: number;
  before: number;
  after: number;
  /** Where that byte lives. */
  object: string;
  /** Offset of the stream's Adler-32, updated so the stream still inflates without error. */
  adlerOffset: number;
  textBefore: string;
  textAfter: string;
}

export type CompareChangeTruth =
  | {
      kind: 'text-changed';
      aPage: number;
      bPage: number;
      a: { text: string; box: Box };
      b: { text: string; box: Box };
      /** The whole line, before and after. */
      lineA: string;
      lineB: string;
    }
  | {
      kind: 'image-moved';
      aPage: number;
      bPage: number;
      resource: string;
      a: Box;
      b: Box;
      delta: [number, number];
    }
  | { kind: 'page-deleted'; aPage: number; heading: string; words: number }
  | { kind: 'page-inserted'; bPage: number; heading: string; words: number }
  | { kind: 'metadata'; key: 'Title'; a: string; b: string };

export interface CompareTruth {
  role: 'a' | 'b';
  a: string;
  b: string;
  /** Best-match pairing, 1-based; null marks an unpaired (deleted or inserted) page. */
  pageMap: { a: number | null; b: number | null }[];
  changes: CompareChangeTruth[];
  /** Page pairs with no difference at all (same content stream bytes). */
  identicalPairs: { a: number; b: number }[];
}

export type MarkdownBlockTruth =
  | { kind: 'heading'; page: number; level: 1 | 2 | 3; text: string; fontSize: number; box: Box }
  | {
      kind: 'paragraph';
      page: number;
      /** The joined text as Markdown should give it (hyphen joined, link as [text](uri)). */
      text: string;
      /** The lines as drawn. */
      lines: string[];
      box: Box;
      column?: 'left' | 'right';
    }
  | { kind: 'list-item'; page: number; level: 1; text: string; bullet: string; box: Box }
  | { kind: 'image'; page: number; resource: string; box: Box; markdown: string };

export interface MarkdownTruth {
  bodyFontSize: number;
  headingSizes: Record<string, number>;
  /** Headings and list items in reading order, as Markdown lines. */
  outline: string[];
  /** Every block in reading order. */
  blocks: MarkdownBlockTruth[];
  /** Lines the converter should drop (repeated at the same place on every page). */
  dropped: { page: number; text: string; reason: 'running-header' | 'page-number' }[];
  links: { page: number; text: string; uri: string; rect: Box }[];
  /** Expected Markdown with default options (page breaks as nothing). */
  golden: string;
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
  /** M5: OCR ground truth for image-only pages. */
  ocr?: OcrExpectation;
  /** M5: signature fields, in /AcroForm /Fields order. */
  signatures?: SignatureTruth[];
  revisions?: RevisionsTruth;
  tamper?: TamperTruth;
  /** M5: expected differences between compare-a.pdf and compare-b.pdf. */
  compare?: CompareTruth;
  /** M5: expected PDF -> Markdown conversion. */
  markdown?: MarkdownTruth;
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

/** One file of the test PKI in test/fixtures/pki/ (M5 signatures). */
export interface PkiFileTruth {
  /** Path relative to test/fixtures/. */
  file: string;
  kind: 'certificate' | 'certificate-chain' | 'private-key' | 'pkcs12';
  sha256: string;
  subject?: string;
  issuer?: string;
  serial?: string;
  keyType?: string;
  password?: string;
  scheme?: 'pbes2' | 'legacy-3des';
  macAlgorithm?: 'SHA-1' | 'SHA-256';
  iterations?: number;
  friendlyName?: string;
  certificates?: number;
  note?: string;
}

export interface PkiTruth {
  $comment: string;
  password: string;
  files: PkiFileTruth[];
}

export interface Manifest {
  $comment: string;
  generator: string;
  pdfLib: string;
  fixedDate: string;
  fixtures: ManifestEntry[];
  /** M5: the test PKI written next to the fixtures. */
  pki?: PkiTruth;
}
