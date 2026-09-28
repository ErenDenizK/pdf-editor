/**
 * PAdES-B approval signing on the fork's incremental writer (spec §3.2, ADR-0013 §2–3). The
 * writer rules from spike S2 are binding here:
 * 1. `useObjectStreams` is always passed and matches the source's xref kind (D1);
 * 2. exactly one `commit()` per `load()` (D2);
 * 3. only low-level `/Annots` and `/Fields` edits, never `PDFPageLeaf.addAnnot` (D3);
 * 4. a newline is appended after the final `%%EOF` before the byte range is patched (T1);
 * 5. damaged or encrypted inputs are refused: sign the verified export output (T2);
 * and the CMS signed attributes are sorted as DER requires (cms.ts). The /ByteRange is patched
 * inside the appended section only, the CMS goes into a zero-filled /Contents reserve (16 KB by
 * default) or signing fails, and the output must pass our own validator as Intact.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRef,
  PDFString,
  ParseSpeeds,
} from '@cantoo/pdf-lib';

import {
  EngineError,
  type SignOptions,
  type SignRequest,
  type SignResult,
  SigningError,
} from '../types';
import { signatureAppearance } from './appearance';
import { ascii, concat, latin1, signedBytes, toHex } from './bytes';
import { certificateFacts, commonName } from './certificates';
import { buildCadesDetached } from './cms';
import { readSignatureFields } from './fields';
import { loadPkcs12, type SigningIdentity } from './pkcs12';
import { validateSignatures } from './validate';
import { walkChain, type XrefKind } from './xref';

/** Ten digits each: patched in place (same width, space padded) after serialisation. */
const BYTE_RANGE_PLACEHOLDER = [0, 9_999_999_999, 9_999_999_999, 9_999_999_999] as const;
export const DEFAULT_RESERVE_BYTES = 16_384;
const MIN_RESERVE_BYTES = 4_096;
const MAX_RESERVE_BYTES = 262_144;
const STEPS = 5;

interface Placeholder {
  /** Offset of '[' and of the byte after ']' of the placeholder /ByteRange array. */
  readonly rangeStart: number;
  readonly rangeEnd: number;
  /** Offset of '<' and of the byte after '>' of /Contents. */
  readonly contentsStart: number;
  readonly contentsEnd: number;
}

function throwIfAborted(options: SignOptions): void {
  if (options.signal?.aborted) {
    throw new EngineError('aborted', 'Signing aborted', { cause: options.signal.reason });
  }
}

/** Looks only after `from` (the end of the source): the appended section. */
function findPlaceholder(bytes: Uint8Array, from: number, reserveBytes: number): Placeholder {
  const text = latin1(bytes, from);
  const range = /\/ByteRange\s*(\[\s*0\s+9999999999\s+9999999999\s+9999999999\s*\])/.exec(text);
  const contents = new RegExp(`/Contents\\s*<(0{${reserveBytes * 2}})>`).exec(text);
  if (!range?.[1] || !contents?.[1]) {
    throw new SigningError(
      'verification-failed',
      'The signature placeholder was not written as expected.',
    );
  }
  const rangeStart = from + range.index + range[0].length - range[1].length;
  const contentsStart = from + contents.index + contents[0].indexOf('<');
  return {
    rangeStart,
    rangeEnd: rangeStart + range[1].length,
    contentsStart,
    contentsEnd: contentsStart + contents[1].length + 2,
  };
}

function patchByteRange(bytes: Uint8Array, p: Placeholder): [number, number, number, number] {
  const range: [number, number, number, number] = [
    0,
    p.contentsStart,
    p.contentsEnd,
    bytes.length - p.contentsEnd,
  ];
  const width = p.rangeEnd - p.rangeStart;
  const text = `[${range.join(' ')}`.padEnd(width - 1, ' ') + ']';
  if (text.length !== width) {
    throw new SigningError('verification-failed', 'The byte range does not fit its placeholder.');
  }
  bytes.set(ascii(text), p.rangeStart);
  return range;
}

function embedContents(bytes: Uint8Array, p: Placeholder, cms: Uint8Array): void {
  const room = (p.contentsEnd - p.contentsStart - 2) / 2;
  if (cms.length > room) {
    throw new SigningError(
      'reserve-too-small',
      `The signature needs ${cms.length} bytes but only ${room} are reserved; sign again with a larger reserve.`,
    );
  }
  bytes.set(ascii(toHex(cms).toUpperCase()), p.contentsStart + 1);
}

/** Appends a widget to a page's /Annots without `PDFPageLeaf.addAnnot` (rule 3). */
function appendAnnot(doc: PDFDocument, pageIndex: number, ref: PDFRef): void {
  const page = doc.getPage(pageIndex);
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (annots instanceof PDFArray) annots.push(ref);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
}

/** Appends a field to /AcroForm /Fields, creating the dictionaries when absent (rule 3). */
function appendField(doc: PDFDocument, ref: PDFRef): void {
  const existing = doc.catalog.lookup(PDFName.of('AcroForm'));
  let acroForm: PDFDict;
  if (existing instanceof PDFDict) {
    acroForm = existing;
  } else {
    acroForm = doc.context.obj({ Fields: [] });
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acroForm));
  }
  const fields = acroForm.lookup(PDFName.of('Fields'));
  if (fields instanceof PDFArray) fields.push(ref);
  else acroForm.set(PDFName.of('Fields'), doc.context.obj([ref]));
  const flags = acroForm.lookup(PDFName.of('SigFlags'));
  const value = flags instanceof PDFNumber ? flags.asNumber() : 0;
  if ((value & 3) !== 3) acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(value | 3));
}

function textOf(obj: PDFObject | undefined): string | undefined {
  return obj instanceof PDFString || obj instanceof PDFHexString ? obj.decodeText() : undefined;
}

/** Fully qualified names of every field (terminal or not). */
function fieldNames(doc: PDFDocument): Set<string> {
  const names = new Set<string>();
  const seen = new Set<string>();
  const visit = (entry: PDFObject | undefined, parent: string | undefined, depth: number): void => {
    if (depth > 32) return;
    if (entry instanceof PDFRef) {
      if (seen.has(entry.toString())) return;
      seen.add(entry.toString());
    }
    const dict = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    if (!(dict instanceof PDFDict)) return;
    const partial = textOf(dict.lookup(PDFName.of('T')));
    const name = partial === undefined ? parent : parent ? `${parent}.${partial}` : partial;
    if (name !== undefined) names.add(name);
    const kids = dict.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (const kid of kids.asArray()) visit(kid, name, depth + 1);
  };
  const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'));
  const fields = acroForm instanceof PDFDict ? acroForm.lookup(PDFName.of('Fields')) : undefined;
  if (fields instanceof PDFArray) for (const f of fields.asArray()) visit(f, undefined, 0);
  return names;
}

function checkRequest(request: SignRequest, reserveBytes: number): void {
  if (
    !Number.isInteger(reserveBytes) ||
    reserveBytes < MIN_RESERVE_BYTES ||
    reserveBytes > MAX_RESERVE_BYTES
  ) {
    throw new SigningError(
      'bad-request',
      `The signature reserve must be ${MIN_RESERVE_BYTES}–${MAX_RESERVE_BYTES} bytes.`,
    );
  }
  if (
    request.fieldName !== undefined &&
    (request.fieldName === '' || request.fieldName.includes('.'))
  ) {
    throw new SigningError('bad-request', 'A field name must be non-empty and contain no period.');
  }
  const rect = request.visible?.rect;
  if (
    rect &&
    !(
      rect.width > 0 &&
      rect.height > 0 &&
      [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    )
  ) {
    throw new SigningError('bad-request', 'The visible signature box must have a positive size.');
  }
}

/** The source's xref kind, or a refusal when its cross-reference chain is damaged (rule 5). */
async function sourceKind(bytes: Uint8Array): Promise<XrefKind> {
  const { sections, error } = await walkChain(bytes);
  const newest = sections[0];
  if (error !== undefined || !newest) {
    throw new SigningError(
      'damaged-input',
      `The file's cross-reference data is damaged (${error ?? 'no sections'}); sign the exported copy instead.`,
    );
  }
  return newest.kind;
}

async function loadIncremental(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, {
    forIncrementalUpdate: true,
    updateMetadata: false,
    preserveXFA: true,
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    parseSpeed: ParseSpeeds.Fastest,
  });
}

/**
 * Adds a PAdES-B approval signature as one incremental update. `input` is not modified.
 * Refuses encrypted or damaged inputs, legacy (3DES/RC2) PKCS#12 files and wrong passwords
 * with a `SigningError`; the key is imported non-extractable and dropped when this returns.
 */
export async function signPdf(
  input: ArrayBuffer | Uint8Array,
  request: SignRequest,
  options: SignOptions = {},
): Promise<SignResult> {
  const progress = (done: number) => options.onProgress?.(done, STEPS);
  const reserveBytes = request.reserveBytes ?? DEFAULT_RESERVE_BYTES;
  checkRequest(request, reserveBytes);
  throwIfAborted(options);
  const source = input instanceof Uint8Array ? input : new Uint8Array(input);

  // 1. The source: not damaged, not encrypted, the page exists, the name is free.
  const xrefKind = await sourceKind(source);
  let doc: PDFDocument;
  try {
    doc = await loadIncremental(source);
  } catch (error) {
    throw new SigningError('damaged-input', 'The file cannot be read for signing.', {
      cause: error,
    });
  }
  if (doc.isEncrypted) {
    throw new SigningError(
      'encrypted-input',
      'Encrypted files cannot be signed here: export without a password, then sign.',
    );
  }
  const pageIndex = request.visible?.pageIndex ?? 0;
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.getPageCount()) {
    throw new SigningError('bad-request', `The file has no page ${pageIndex + 1}.`);
  }
  if (readSignatureFields(doc, true).some((f) => f.sig?.docMdp === 1)) {
    throw new SigningError(
      'bad-request',
      'The file is certified with "no changes allowed"; another signature would break that certification.',
    );
  }
  const names = fieldNames(doc);
  let fieldName = request.fieldName;
  if (fieldName === undefined) {
    let n = 1;
    while (names.has(`Signature${n}`)) n++;
    fieldName = `Signature${n}`;
  } else if (names.has(fieldName)) {
    throw new SigningError('field-exists', `A field named "${fieldName}" already exists.`);
  }
  progress(1);
  throwIfAborted(options);

  // 2. The identity. (The worker wipes the transferred .p12 bytes when the call ends.)
  const identity: SigningIdentity = await loadPkcs12(request.pkcs12, request.password);
  const leaf = identity.chain[0];
  if (!leaf) throw new SigningError('no-key', 'The certificate file has no certificate.');
  const signerFacts = await certificateFacts(leaf);
  progress(2);
  throwIfAborted(options);

  // 3. Placeholder, widget and field; one commit matching the source's xref kind.
  const date = request.date === undefined ? new Date() : new Date(request.date);
  if (Number.isNaN(date.getTime()))
    throw new SigningError('bad-request', 'The signing date is invalid.');
  const signerName = request.signerName ?? commonName(leaf.subject) ?? signerFacts.subject;
  const context = doc.context;
  const sig = context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'ETSI.CAdES.detached',
    ByteRange: [...BYTE_RANGE_PLACEHOLDER],
    Contents: PDFHexString.of('0'.repeat(reserveBytes * 2)),
    M: PDFString.fromDate(date),
    Name: PDFHexString.fromText(signerName),
    ...(request.reason === undefined ? {} : { Reason: PDFHexString.fromText(request.reason) }),
    ...(request.location === undefined
      ? {}
      : { Location: PDFHexString.fromText(request.location) }),
    ...(request.contactInfo === undefined
      ? {}
      : { ContactInfo: PDFHexString.fromText(request.contactInfo) }),
  } as never);
  const sigRef = context.register(sig);
  const page = doc.getPage(pageIndex);
  const box = request.visible?.rect;
  const widget = context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    T: PDFHexString.fromText(fieldName),
    V: sigRef,
    Rect: box ? [box.x, box.y, box.x + box.width, box.y + box.height] : [0, 0, 0, 0],
    F: 132, // Print + Locked
    P: page.ref,
  } as never) as unknown as PDFDict;
  if (box) {
    const ap = signatureAppearance(context, box.width, box.height, {
      signer: signerName,
      date,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    });
    widget.set(PDFName.of('AP'), context.obj({ N: ap }));
  }
  const widgetRef = context.register(widget);
  appendAnnot(doc, pageIndex, widgetRef);
  appendField(doc, widgetRef);
  let committed: Uint8Array;
  try {
    committed = await doc.commit({
      useObjectStreams: xrefKind === 'stream',
      objectsPerTick: Number.POSITIVE_INFINITY,
    });
  } catch (error) {
    throw new SigningError('damaged-input', 'The incremental update could not be written.', {
      cause: error,
    });
  }
  // Rule 4: an end-of-line after %%EOF, so the signed revision ends where readers expect.
  const out = concat([committed, ascii('\n')]);
  progress(3);
  throwIfAborted(options);

  // 4. Byte range, digest, CMS.
  const placeholder = findPlaceholder(out, source.length, reserveBytes);
  const byteRange = patchByteRange(out, placeholder);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', signedBytes(out, byteRange)));
  const cms = await buildCadesDetached(digest, identity.key, identity.chain);
  embedContents(out, placeholder, cms);
  progress(4);
  throwIfAborted(options);

  // 5. Our own validator must call the new signature Intact over the whole file.
  const reports = await validateSignatures(out);
  const report = reports.find((r) => r.fieldName === fieldName);
  if (report?.status !== 'intact' || !report.coversWholeFile) {
    throw new SigningError(
      'verification-failed',
      `The signed file did not verify (${report ? report.status : 'signature not found'}).`,
    );
  }
  progress(5);
  return {
    bytes: out.buffer,
    report,
    fieldName,
    byteRange,
    xrefKind,
    cmsBytes: cms.length,
    reserveBytes,
    signer: signerFacts,
  };
}
