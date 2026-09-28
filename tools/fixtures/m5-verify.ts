/**
 * Verifier checks for the M5 fixtures (called from verify.ts): OCR ground truth
 * against the raster pixels, signature dictionaries, byte ranges and CMS
 * (re-checked with Node's crypto, independent of the generator's own
 * assertions), the tampered byte, the compare pair and the Markdown layout.
 */
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFDict,
  type PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  type PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import {
  type Box,
  FIXTURES_DIR,
  type ManifestEntry,
  type PkiTruth,
  type SignatureTruth,
  sha256,
} from './lib/common.ts';
import { readTlv } from './lib/der.ts';
import { readP12 } from './lib/p12.ts';
import { OID, checkCms, subjectOf } from './lib/pki.ts';

export interface Check {
  ok(condition: boolean, message: string): void;
  eq(actual: unknown, expected: unknown, message: string): void;
}

const N = (value: string) => PDFName.of(value);

function resolve(doc: PDFDocument, obj: PDFObject | undefined): PDFObject | undefined {
  return obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
}

function dictOf(doc: PDFDocument, obj: PDFObject | undefined): PDFDict | undefined {
  const r = resolve(doc, obj);
  if (r instanceof PDFDict) return r;
  if (r instanceof PDFStream) return r.dict;
  return undefined;
}

function textOf(doc: PDFDocument, obj: PDFObject | undefined): string | undefined {
  const r = resolve(doc, obj);
  if (r instanceof PDFString || r instanceof PDFHexString || r instanceof PDFName)
    return r.decodeText();
  return undefined;
}

function numbers(doc: PDFDocument, obj: PDFObject | undefined): number[] {
  const r = resolve(doc, obj);
  if (!(r instanceof PDFArray)) return [];
  return r.asArray().map((v) => {
    const n = resolve(doc, v);
    return n instanceof PDFNumber ? n.asNumber() : Number.NaN;
  });
}

const nameOf = (doc: PDFDocument, obj: PDFObject | undefined) =>
  resolve(doc, obj)?.toString().slice(1);

function content(doc: PDFDocument, page: PDFPage | undefined): string {
  const walk = (obj: PDFObject | undefined): string => {
    const r = resolve(doc, obj);
    if (r instanceof PDFArray) return r.asArray().map(walk).join('\n');
    if (r instanceof PDFRawStream)
      return Buffer.from(decodePDFRawStream(r).decode()).toString('latin1');
    return '';
  };
  return page ? walk(page.node.get(N('Contents'))) : '';
}

function rectToBox([x1 = 0, y1 = 0, x2 = 0, y2 = 0]: number[]): Box {
  const r = (n: number) => Math.round(n * 100) / 100;
  return [r(Math.min(x1, x2)), r(Math.min(y1, y2)), r(Math.abs(x2 - x1)), r(Math.abs(y2 - y1))];
}

/** Literal string as the M5 builders write it (WinAnsi, bullet as \225). */
function lit(value: string): string {
  return `(${value.replace(/[\\()]/g, (ch) => `\\${ch}`).replaceAll('•', '\\225')})`;
}

/** [x, y, w, h] of every `w 0 0 h x y cm /Name Do` in a content stream. */
function paintedAt(stream: string, resource: string): Box[] {
  const re = new RegExp(`([\\d.]+) 0 0 ([\\d.]+) ([\\d.]+) ([\\d.]+) cm /${resource} Do`, 'g');
  return [...stream.matchAll(re)].map((m) => {
    const [w, h, x, y] = m.slice(1, 5).map(Number);
    return [x ?? 0, y ?? 0, w ?? 0, h ?? 0];
  });
}

export async function checkM5(
  entry: ManifestEntry,
  doc: PDFDocument,
  bytes: Uint8Array,
  c: Check,
): Promise<void> {
  const e = entry.expect;
  if (e.ocr) checkOcr(entry, doc, c);
  if (e.signatures) await checkSignatures(entry, doc, bytes, c);
  if (e.tamper) checkTamper(entry, doc, bytes, c);
  if (e.compare) await checkCompare(entry, doc, c);
  if (e.markdown) checkMarkdown(entry, doc, c);
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

function checkOcr(entry: ManifestEntry, doc: PDFDocument, c: Check): void {
  const ocr = entry.expect.ocr;
  if (!ocr) return;
  c.eq(ocr.pages.length, entry.expect.pageCount, 'OCR truth for every page');
  const allText = ocr.pages.map((p) => p.text).join('\n');
  for (const letter of ocr.letters ?? '')
    c.ok(allText.includes(letter), `OCR text contains "${letter}"`);

  for (const truth of ocr.pages) {
    const label = `OCR page ${truth.page}`;
    const page = doc.getPages()[truth.page - 1];
    const stream = content(doc, page);
    const paint = `q ${truth.image.matrix.join(' ')} cm /${truth.image.resource} Do Q`;
    c.eq(page?.getRotation().angle, truth.rotate, `${label}: /Rotate`);
    const layer = truth.foreignLayer;
    if (layer) {
      const objects = stream.split('\n').slice(1);
      c.eq(stream.split('\n')[0], paint, `${label}: image painted first`);
      c.eq(
        objects,
        layer.lines.map(
          (l) =>
            `BT ${layer.renderMode} Tr /F1 ${l.fontSize} Tf ${l.horizontalScale} Tz ${l.x} ${l.baseline} Td ${lit(l.text)} Tj ET`,
        ),
        `${label}: foreign layer text objects (all 3 Tr)`,
      );
      c.eq(
        layer.lines.map((l) => l.text).join('\n'),
        layer.errors.reduce((t, e) => t.replace(e.expected, e.actual), truth.text),
        `${label}: foreign layer = ground truth with the listed errors`,
      );
      const font = dictOf(doc, dictOf(doc, page?.node.Resources()?.get(N('Font')))?.get(N('F1')));
      c.eq(nameOf(doc, font?.get(N('BaseFont'))), layer.font, `${label}: foreign layer font`);
    } else {
      c.ok(!/\bBT\b|\bTj\b|\bTJ\b/.test(stream), `${label}: no text operators`);
      c.eq(stream.trim(), paint, `${label}: content`);
    }
    const xobjects = dictOf(doc, page?.node.Resources()?.get(N('XObject')));
    const image = resolve(doc, xobjects?.get(N(truth.image.resource)));
    c.ok(image instanceof PDFRawStream, `${label}: image XObject present`);
    if (!(image instanceof PDFRawStream)) continue;
    const d = image.dict;
    const num = (key: string) => {
      const v = resolve(doc, d.get(N(key)));
      return v instanceof PDFNumber ? v.asNumber() : undefined;
    };
    const { width, height, dpi } = truth.image;
    c.eq([num('Width'), num('Height')], [width, height], `${label}: image size`);
    const [displayW, displayH] = truth.rotate % 180 ? [792, 612] : [612, 792];
    c.eq(
      [width, height],
      [Math.round((displayW * dpi) / 72), Math.round((displayH * dpi) / 72)],
      `${label}: image size matches ${dpi} dpi on the displayed Letter page`,
    );
    c.eq(nameOf(doc, d.get(N('ColorSpace'))), truth.image.colorSpace, `${label}: /ColorSpace`);
    c.eq(num('BitsPerComponent'), 8, `${label}: /BitsPerComponent`);
    c.eq(nameOf(doc, d.get(N('Filter'))), truth.image.filter, `${label}: /Filter`);

    c.eq(truth.lines.map((l) => l.text).join('\n'), truth.text, `${label}: lines = text`);
    c.eq(
      truth.words.map((w) => w.text),
      truth.lines.flatMap((l) => l.text.split(' ')),
      `${label}: words = text split on spaces`,
    );

    // Pixels: ink inside every word box; on clean pages no ink outside them.
    const grey = decodePDFRawStream(image).decode();
    c.eq(grey.length, width * height, `${label}: decoded pixel count`);
    const k = dpi / 72;
    const inside = new Uint8Array(width * height);
    for (const word of truth.words) {
      const [left, top, w, h] = word.px;
      let darkest = 255;
      for (let y = Math.max(0, top - 1); y < Math.min(height, top + h + 1); y++)
        for (let x = Math.max(0, left - 1); x < Math.min(width, left + w + 1); x++) {
          inside[y * width + x] = 1;
          darkest = Math.min(darkest, grey[y * width + x] ?? 255);
        }
      c.ok(darkest < 64, `${label}: ink inside the box of "${word.text}"`);
      // User space -> displayed pixels: /Rotate 90 shows user y to the right, user x downwards.
      const [bx, by, bw, bh] = word.box;
      const fromBox =
        truth.rotate === 90
          ? [by * k, bx * k, bh * k, bw * k]
          : [bx * k, (792 - by - bh) * k, bw * k, bh * k];
      c.ok(
        fromBox.every((v, i) => Math.abs(v - (word.px[i] ?? 0)) <= 2),
        `${label}: px box of "${word.text}" matches its user-space box`,
      );
    }
    let stray = 0;
    for (let i = 0; i < grey.length; i++) if ((grey[i] ?? 255) < 200 && !inside[i]) stray++;
    if (truth.noise) {
      c.ok(
        stray > 0 && stray <= truth.noise.specks * 4,
        `${label}: dark pixels outside words are specks (${stray})`,
      );
    } else {
      c.eq(stray, 0, `${label}: no ink outside the word boxes`);
    }
  }
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

const ATTRIBUTE_NAMES: Record<string, string> = {
  [OID.contentType]: 'contentType',
  [OID.messageDigest]: 'messageDigest',
  [OID.signingTime]: 'signingTime',
  [OID.signingCertificateV2]: 'signingCertificateV2',
};
const ALLOWED_LATER = new Set(['form-fill', 'annotations', 'signature', 'dss']);

function xrefObjects(latin: string, offset: number): string[] {
  const end = latin.indexOf('trailer', offset);
  const lines = latin.slice(offset, end).split('\n').slice(1);
  const refs: string[] = [];
  let next = 0;
  for (const line of lines) {
    const head = /^(\d+) (\d+)$/.exec(line.trim());
    if (head) {
      next = Number(head[1]);
      continue;
    }
    const entry = /^(\d{10}) (\d{5}) ([nf])/.exec(line);
    if (!entry) continue;
    if (entry[3] === 'n') refs.push(`${next} ${Number(entry[2])} R`);
    next++;
  }
  return refs.sort();
}

async function checkSignatures(
  entry: ManifestEntry,
  doc: PDFDocument,
  bytes: Uint8Array,
  c: Check,
): Promise<void> {
  const e = entry.expect;
  const latin = Buffer.from(bytes).toString('latin1');
  const revs = e.revisions;
  if (revs) {
    // A last revision may end at `startxref N` without %%EOF (signed-no-eof.pdf).
    const startxrefs = [...latin.matchAll(/startxref\s+(\d+)\s+(?:%%EOF\n|$)/g)].map((m) =>
      Number(m[1]),
    );
    c.eq(startxrefs, revs.startxrefs, 'startxref chain');
    const ends = [...latin.matchAll(/%%EOF\n/g)].map((m) => (m.index ?? 0) + m[0].length);
    if (!latin.endsWith('%%EOF\n')) ends.push(latin.length);
    c.eq(ends, revs.ends, 'revision ends');
    c.eq(ends.length, revs.count, 'revision count');
    c.eq(ends.at(-1), bytes.length, 'last revision ends at EOF');
    revs.startxrefs.forEach((x, i) => {
      c.ok(latin.startsWith('xref', x), `revision ${i + 1} startxref points at xref`);
      if (i > 0) {
        const prev = /\/Prev (\d+)/.exec(latin.slice(x, revs.ends[i]));
        c.eq(Number(prev?.[1]), revs.startxrefs[i - 1], `revision ${i + 1} /Prev`);
      }
    });
    const simple = readFileSync(join(FIXTURES_DIR, 'simple-text.pdf'));
    c.ok(
      Buffer.compare(Buffer.from(bytes.subarray(0, simple.length)), simple) === 0 || !!e.tamper,
      'revision 1 is simple-text.pdf byte for byte',
    );
  }

  const acro = dictOf(doc, doc.catalog.get(N('AcroForm')));
  c.ok(!!acro, '/AcroForm present');
  const sigFlags = resolve(doc, acro?.get(N('SigFlags')));
  c.eq(sigFlags instanceof PDFNumber ? sigFlags.asNumber() : undefined, 3, '/SigFlags 3');
  const fields = (resolve(doc, acro?.get(N('Fields'))) as PDFArray | undefined)?.asArray() ?? [];
  c.eq(
    fields.map((f) => textOf(doc, dictOf(doc, f)?.get(N('T')))),
    (e.signatures ?? []).map((s) => s.field),
    'signature fields in /Fields order',
  );
  const pages = doc.getPages();
  for (const truth of e.signatures ?? []) {
    const label = `signature ${truth.field}`;
    const field = fields
      .map((f) => dictOf(doc, f))
      .find((f) => textOf(doc, f?.get(N('T'))) === truth.field);
    if (!field) {
      c.ok(false, `${label}: field missing`);
      continue;
    }
    c.eq(nameOf(doc, field.get(N('FT'))), 'Sig', `${label}: /FT /Sig`);
    c.eq(nameOf(doc, field.get(N('Subtype'))), 'Widget', `${label}: merged widget`);
    c.eq(rectToBox(numbers(doc, field.get(N('Rect')))), truth.rect, `${label}: /Rect`);
    const pageRef = field.get(N('P'));
    c.eq(pages.findIndex((p) => p.ref === pageRef) + 1, truth.page, `${label}: /P`);
    c.ok(
      pages[truth.page - 1]?.node
        .Annots()
        ?.asArray()
        .some((a) => dictOf(doc, a) === field) ?? false,
      `${label}: widget in the page /Annots`,
    );
    const v = dictOf(doc, field.get(N('V')));
    c.eq(!!v, truth.signed, `${label}: /V present`);
    if (!v || !truth.signed) {
      c.eq(truth.status, 'unsigned', `${label}: unsigned status`);
      continue;
    }
    await checkSignature(entry, doc, bytes, truth, v, c);
  }
}

async function checkSignature(
  entry: ManifestEntry,
  doc: PDFDocument,
  bytes: Uint8Array,
  truth: SignatureTruth,
  v: PDFDict,
  c: Check,
): Promise<void> {
  const label = `signature ${truth.field}`;
  const latin = Buffer.from(bytes).toString('latin1');
  const docTimestamp = truth.subFilter === 'ETSI.RFC3161';
  c.eq(
    nameOf(doc, v.get(N('Type'))),
    docTimestamp ? 'DocTimeStamp' : 'Sig',
    `${label}: /Type /${docTimestamp ? 'DocTimeStamp' : 'Sig'}`,
  );
  c.eq(nameOf(doc, v.get(N('Filter'))), truth.filter, `${label}: /Filter`);
  c.eq(nameOf(doc, v.get(N('SubFilter'))), truth.subFilter, `${label}: /SubFilter`);
  c.ok(v.has(N('Contents')), `${label}: /Contents present`);
  const m = textOf(doc, v.get(N('M')));
  const claimed = /^D:(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(m ?? '');
  c.eq(
    claimed
      ? `${claimed[1]}-${claimed[2]}-${claimed[3]}T${claimed[4]}:${claimed[5]}:${claimed[6]}.000Z`
      : m,
    truth.claimedTime,
    `${label}: /M`,
  );
  c.eq(textOf(doc, v.get(N('Reason'))), truth.reason, `${label}: /Reason`);
  const br = numbers(doc, v.get(N('ByteRange')));
  c.eq(br, truth.byteRange, `${label}: /ByteRange`);
  const [start = -1, a = 0, b = 0, len = 0] = br;

  // Byte range rules (spec §3.1 step 1), read from the raw bytes.
  const gap = latin.slice(a, b);
  const hexLength = truth.contentsHexLength ?? 0;
  c.eq(start, 0, `${label}: range starts at 0`);
  c.ok(gap.startsWith('<') && gap.endsWith('>'), `${label}: gap is the /Contents string`);
  c.eq(gap.length, hexLength + 2, `${label}: gap length`);
  c.ok(/^<[0-9A-Fa-f]*>$/.test(gap), `${label}: gap holds only hex digits`);
  c.ok(latin.slice(Math.max(0, a - 10), a) === '/Contents ', `${label}: gap follows /Contents`);
  const revEnd = entry.expect.revisions?.ends[(truth.revision ?? 0) - 1];
  c.eq(b + len, revEnd, `${label}: second range ends at the end of revision ${truth.revision}`);
  c.eq(b + len === bytes.length, truth.coversWholeFile, `${label}: covers the whole file`);

  const der = Buffer.from(gap.slice(1, -1), 'hex');
  let cmsLength: number;
  try {
    cmsLength = readTlv(new Uint8Array(der)).end;
  } catch (error) {
    c.ok(false, `${label}: /Contents is not DER: ${String(error)}`);
    return;
  }
  c.eq(cmsLength, truth.cmsBytes, `${label}: CMS length`);
  c.ok(
    der.subarray(cmsLength).every((x) => x === 0),
    `${label}: zero padding after the CMS`,
  );
  const signed = Buffer.concat([
    Buffer.from(bytes.subarray(0, a)),
    Buffer.from(bytes.subarray(b, b + len)),
  ]);
  const check = checkCms(new Uint8Array(der.subarray(0, cmsLength)), new Uint8Array(signed));
  const pf = (x: boolean | undefined) => (x === undefined ? 'not-checked' : x ? 'pass' : 'fail');
  c.eq(
    {
      byteRange: 'pass',
      digest: pf(check.digestMatches && check.encapsulatedDigestMatches !== false),
      signature: pf(check.signatureValid),
      signingCertificate: pf(check.signingCertificateMatches),
      chain: pf(check.chainValid),
    },
    truth.checks,
    `${label}: CMS checks`,
  );
  c.eq(check.digestAlgorithm, truth.digestAlgorithm, `${label}: digest algorithm`);
  c.eq(check.signatureAlgorithm, OID.rsaEncryption, `${label}: RSA PKCS#1 v1.5`);
  c.eq(
    check.signedAttributes.map((o) => ATTRIBUTE_NAMES[o] ?? o),
    truth.signedAttributes,
    `${label}: signed attributes`,
  );
  c.eq(check.signerSubject, truth.signer?.subject, `${label}: signer subject`);
  c.eq(check.certificates, truth.chain?.length, `${label}: certificates in the CMS`);

  // Later revisions and the status they imply.
  const revs = entry.expect.revisions;
  const later = truth.laterChanges ?? [];
  c.eq(
    [...new Set(later.map((l) => l.revision))],
    Array.from(
      { length: (revs?.count ?? 0) - (truth.revision ?? 0) },
      (_, i) => (truth.revision ?? 0) + i + 1,
    ),
    `${label}: every later revision classified`,
  );
  if (entry.expect.attack) {
    // pdf-lib (and so classifyRevision) ignores the xref, which is what the attack exploits.
    checkAttack(entry, bytes, c);
  }
  for (const l of entry.expect.attack ? [] : later) {
    const x = revs?.startxrefs[l.revision - 1] ?? 0;
    const objects = xrefObjects(latin, x);
    c.eq(objects, l.objects, `${label}: revision ${l.revision} objects`);
    const ends = revs?.ends ?? [];
    c.eq(
      await classifyRevision(bytes, ends[l.revision - 2] ?? 0, ends[l.revision - 1] ?? 0, objects),
      { kind: l.kind, pages: l.pages },
      `${label}: revision ${l.revision} kind`,
    );
  }
  const intact = truth.checks?.digest === 'pass' && truth.checks.signature === 'pass';
  const derived = !intact
    ? 'broken'
    : truth.coversWholeFile
      ? 'intact'
      : later.every((l) => ALLOWED_LATER.has(l.kind))
        ? 'intact-changed-later'
        : 'changed-after-signing';
  c.eq(truth.status, derived, `${label}: status follows from the checks`);
}

/**
 * The incremental-update attacks (M5 review finding 1), checked on the raw bytes: the last
 * revision's xref entry for the target, where it points, and what else the revision holds.
 */
function checkAttack(entry: ManifestEntry, bytes: Uint8Array, c: Check): void {
  const attack = entry.expect.attack;
  const revs = entry.expect.revisions;
  if (!attack || !revs) return;
  const latin = Buffer.from(bytes).toString('latin1');
  const signedEnd = revs.ends[revs.ends.length - 2] ?? 0;
  const xrefAt = revs.startxrefs[revs.startxrefs.length - 1] ?? 0;
  const region = latin.slice(signedEnd, xrefAt);
  const [num = 0] = attack.object.split(' ').map(Number);
  const table = latin.slice(xrefAt, latin.indexOf('trailer', xrefAt));
  const entryLine = new RegExp(`\\n${num} 1\\n(\\d{10}) (\\d{5}) ([nf])`).exec(table);
  c.ok(!!entryLine, `${attack.technique}: the last xref has one entry for ${attack.object}`);
  const headers = [...region.matchAll(new RegExp(`(?:^|\\n)${num} 0 obj\\n`, 'g'))].map(
    (m) => signedEnd + (m.index ?? 0) + (m[0].startsWith('\n') ? 1 : 0),
  );
  const streamAt = (at: number) => {
    const start = latin.indexOf('stream\n', at) + 'stream\n'.length;
    return latin.slice(start, latin.indexOf('\nendstream', start));
  };
  if (attack.technique === 'free-entry') {
    c.eq(entryLine?.[3], 'f', 'the entry is free');
    c.eq(headers.length, 0, 'the revision defines no object');
    c.eq(attack.resolvedContent, null, 'resolved content is none');
  } else {
    c.eq(entryLine?.[3], 'n', 'the entry is in use');
    const offset = Number(entryLine?.[1]);
    c.eq(offset, headers[0], 'the entry points at the first definition');
    c.eq(streamAt(offset), attack.resolvedContent, 'the xref resolves to the new content');
    if (attack.technique === 'duplicate-definition') {
      c.eq(headers.length, 2, 'two definitions');
      const signed = latin.slice(0, signedEnd);
      const original = signed.slice(signed.lastIndexOf(`\n${num} 0 obj\n`) + 1);
      const second = latin.slice(headers[1] ?? 0);
      const body = (s: string) => s.slice(0, s.indexOf('\nendobj') + 7);
      c.eq(body(second), body(original), 'the second definition is the signed one, byte for byte');
    } else {
      c.eq(headers.length, 1, 'one definition');
      c.ok(!latin.slice(xrefAt).includes('%%EOF'), 'no %%EOF after the last xref');
      c.ok(/startxref\n\d+\n$/.test(latin), 'the file ends at startxref N');
    }
  }
}

/**
 * A small, independent classifier for the fixtures' later revisions: compares
 * each redefined object with its previous version (spec §3.1 step 6 kinds).
 */
async function classifyRevision(
  bytes: Uint8Array,
  prevEnd: number,
  end: number,
  objects: string[],
): Promise<{ kind: string; pages: number[] }> {
  const { PDFDocument: Doc } = await import('@cantoo/pdf-lib');
  const before = await Doc.load(bytes.slice(0, prevEnd), { updateMetadata: false });
  const after = await Doc.load(bytes.slice(0, end), { updateMetadata: false });
  const kinds = new Set<string>();
  const pages = new Set<number>();
  const pageRefs = after.getPages().map((p) => p.ref.toString());
  for (const tag of objects) {
    const [n = 0, g = 0] = tag.split(' ').map(Number);
    const ref = PDFRef.of(n, g);
    const obj = after.context.lookup(ref);
    const old = before.context.lookup(ref);
    const dict = obj instanceof PDFDict ? obj : undefined;
    const type = dict ? nameOf(after, dict.get(N('Type'))) : undefined;
    const pageIndex = pageRefs.indexOf(tag);
    if (pageIndex >= 0 && dict && old instanceof PDFDict) {
      const strip = (d: PDFDict) =>
        d
          .entries()
          .filter(([k]) => k.asString() !== '/Annots')
          .map(([k, x]) => `${k.asString()} ${x.toString()}`)
          .join('\n');
      kinds.add(strip(dict) === strip(old) ? 'annotations' : 'pages');
      pages.add(pageIndex + 1);
    } else if (
      type === 'Sig' ||
      type === 'DocTimeStamp' ||
      (type === 'Annot' && nameOf(after, dict?.get(N('FT'))) === 'Sig')
    ) {
      kinds.add('signature');
    } else if (type === 'Annot') {
      kinds.add('annotations');
    } else if (dict?.has(N('Fields'))) {
      kinds.add('signature');
    } else if (obj instanceof PDFStream) {
      const owner = after.getPages().findIndex((p) => {
        const cs = resolve(after, p.node.get(N('Contents')));
        return (
          cs === obj || (cs instanceof PDFArray && cs.asArray().some((x) => x.toString() === tag))
        );
      });
      kinds.add(owner >= 0 ? 'content' : 'other');
      if (owner >= 0) pages.add(owner + 1);
    } else {
      kinds.add('other');
    }
  }
  // A page whose /Annots grew because of a signature widget is part of the signature change.
  if (kinds.has('signature')) kinds.delete('annotations');
  const order = ['content', 'pages', 'other', 'signature', 'annotations'];
  const kind = order.find((k) => kinds.has(k)) ?? 'other';
  return { kind, pages: [...pages].sort((x, y) => x - y) };
}

function checkTamper(entry: ManifestEntry, doc: PDFDocument, bytes: Uint8Array, c: Check): void {
  const t = entry.expect.tamper;
  if (!t || !entry.derivedFrom) return;
  const original = readFileSync(join(FIXTURES_DIR, entry.derivedFrom));
  c.eq(original.length, bytes.length, 'tamper keeps the length');
  const diff: number[] = [];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== original[i]) diff.push(i);
  c.ok(diff.includes(t.offset), 'tampered byte differs');
  c.ok(
    diff.every((i) => i === t.offset || (i >= t.adlerOffset && i < t.adlerOffset + 4)),
    'only the byte and the Adler-32 differ',
  );
  c.eq([original[t.offset], bytes[t.offset]], [t.before, t.after], 'tampered byte values');
  const first = entry.expect.signatures?.find((s) => s.byteRange)?.byteRange?.[1] ?? 0;
  c.ok(t.offset < first, 'tampered byte inside the first signed range');
  const page = doc.getPages()[0];
  const contents = resolve(doc, page?.node.get(N('Contents')));
  const stream = resolve(doc, contents instanceof PDFArray ? contents.get(0) : contents);
  if (stream instanceof PDFRawStream) {
    const text = inflateSync(stream.getContents()).toString('latin1');
    const hex = (s: string) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();
    c.ok(text.includes(hex(t.textAfter)), 'page 1 shows the tampered text (strict inflate)');
    c.ok(!text.includes(hex(t.textBefore)), 'page 1 no longer shows the signed text');
  } else {
    c.ok(false, 'page 1 content stream not found');
  }
}

// ---------------------------------------------------------------------------
// Compare pair
// ---------------------------------------------------------------------------

async function checkCompare(entry: ManifestEntry, doc: PDFDocument, c: Check): Promise<void> {
  const cmp = entry.expect.compare;
  if (!cmp) return;
  c.eq(cmp[cmp.role], entry.file, 'compare role matches the file');
  if (cmp.role !== 'b') return;
  const { PDFDocument: Doc } = await import('@cantoo/pdf-lib');
  const a = await Doc.load(readFileSync(join(FIXTURES_DIR, cmp.a)), { updateMetadata: false });
  const b = doc;
  const pageText = (d: PDFDocument, n: number | null) => (n ? content(d, d.getPages()[n - 1]) : '');
  const paired = cmp.pageMap.filter((p) => p.a !== null && p.b !== null);
  c.eq(
    cmp.pageMap.filter((p) => p.a !== null).map((p) => p.a),
    a.getPages().map((_, i) => i + 1),
    'pageMap covers every page of a',
  );
  c.eq(
    cmp.pageMap.filter((p) => p.b !== null).map((p) => p.b),
    b.getPages().map((_, i) => i + 1),
    'pageMap covers every page of b',
  );
  const changedPairs = new Set(
    cmp.changes.flatMap((ch) =>
      'aPage' in ch && 'bPage' in ch ? [`${ch.aPage}:${ch.bPage}`] : [],
    ),
  );
  for (const p of paired) {
    const same = pageText(a, p.a) === pageText(b, p.b);
    const key = `${p.a}:${p.b}`;
    c.eq(same, !changedPairs.has(key), `pair a${p.a}/b${p.b} identical unless a change is listed`);
    c.eq(
      cmp.identicalPairs.some((x) => x.a === p.a && x.b === p.b),
      same,
      `pair a${p.a}/b${p.b} listed in identicalPairs`,
    );
  }
  for (const ch of cmp.changes) {
    if (ch.kind === 'text-changed') {
      const [ta, tb] = [pageText(a, ch.aPage), pageText(b, ch.bPage)];
      c.ok(ta.includes(lit(ch.lineA)) && tb.includes(lit(ch.lineB)), 'changed line in both pages');
      c.eq(ch.lineA.replace(ch.a.text, ch.b.text), ch.lineB, 'only the one word differs');
      c.eq(
        ta.replace(lit(ch.lineA), ''),
        tb.replace(lit(ch.lineB), ''),
        'rest of the page identical',
      );
    } else if (ch.kind === 'image-moved') {
      c.eq(paintedAt(pageText(a, ch.aPage), ch.resource), [ch.a], 'image rect in a');
      c.eq(paintedAt(pageText(b, ch.bPage), ch.resource), [ch.b], 'image rect in b');
      c.eq([ch.b[0] - ch.a[0], ch.b[1] - ch.a[1]], ch.delta, 'image delta');
    } else if (ch.kind === 'page-deleted') {
      c.ok(pageText(a, ch.aPage).includes(lit(ch.heading)), `a${ch.aPage} has "${ch.heading}"`);
      c.ok(
        b.getPages().every((_, i) => !pageText(b, i + 1).includes(lit(ch.heading))),
        'deleted page absent from b',
      );
    } else if (ch.kind === 'page-inserted') {
      c.ok(pageText(b, ch.bPage).includes(lit(ch.heading)), `b${ch.bPage} has "${ch.heading}"`);
      c.ok(
        a.getPages().every((_, i) => !pageText(a, i + 1).includes(lit(ch.heading))),
        'inserted page absent from a',
      );
    } else {
      c.eq([a.getTitle(), b.getTitle()], [ch.a, ch.b], 'title change');
    }
  }
}

// ---------------------------------------------------------------------------
// Markdown source
// ---------------------------------------------------------------------------

function checkMarkdown(entry: ManifestEntry, doc: PDFDocument, c: Check): void {
  const md = entry.expect.markdown;
  if (!md) return;
  const pages = doc.getPages();
  const drawn = (page: number, font: string, size: number, value: string) =>
    new RegExp(
      `/${font} ${size} Tf [\\d.]+ [\\d.]+ Td ${lit(value).replace(/[\\()[\]{}.*+?^$|]/g, '\\$&')} Tj`,
    ).test(content(doc, pages[page - 1]));
  const outline: string[] = [];
  for (const block of md.blocks) {
    if (block.kind === 'heading') {
      c.eq(md.headingSizes[String(block.level)], block.fontSize, `H${block.level} size`);
      c.ok(
        drawn(block.page, 'F2', block.fontSize, block.text),
        `heading "${block.text}" drawn in bold`,
      );
      outline.push(`${'#'.repeat(block.level)} ${block.text}`);
    } else if (block.kind === 'paragraph') {
      for (const line of block.lines)
        c.ok(drawn(block.page, 'F1', md.bodyFontSize, line), `paragraph line "${line}" drawn`);
    } else if (block.kind === 'list-item') {
      c.ok(drawn(block.page, 'F1', md.bodyFontSize, block.bullet), 'bullet drawn');
      c.ok(drawn(block.page, 'F1', md.bodyFontSize, block.text), `list item "${block.text}" drawn`);
      outline.push(`- ${block.text}`);
    } else {
      c.eq(
        paintedAt(content(doc, pages[block.page - 1]), block.resource),
        [block.box],
        'image rect',
      );
    }
  }
  c.eq(outline, md.outline, 'outline = headings and list items in block order');
  for (const d of md.dropped)
    c.ok(drawn(d.page, 'F1', 9, d.text), `running line "${d.text}" drawn`);
  for (const link of md.links) {
    const annots = pages[link.page - 1]?.node.Annots()?.asArray() ?? [];
    const found = annots
      .map((x) => dictOf(doc, x))
      .find((x) => textOf(doc, dictOf(doc, x?.get(N('A')))?.get(N('URI'))) === link.uri);
    c.ok(!!found, `link ${link.uri} present`);
    if (found) c.eq(rectToBox(numbers(doc, found.get(N('Rect')))), link.rect, 'link rect');
  }
  const paragraphs = md.blocks.filter((b) => b.kind === 'paragraph');
  for (const p of paragraphs)
    c.ok(md.golden.includes(`\n${p.text}\n`), `golden has paragraph "${p.text.slice(0, 30)}..."`);
  for (const line of md.outline) c.ok(md.golden.includes(`${line}\n`), `golden has "${line}"`);
  const goldenLines = md.golden.split('\n');
  for (const d of md.dropped) c.ok(!goldenLines.includes(d.text), `golden drops "${d.text}"`);
}

// ---------------------------------------------------------------------------
// Test PKI (test/fixtures/pki/)
// ---------------------------------------------------------------------------

const rfc4514 = (cert: X509Certificate, field: 'subject' | 'issuer') =>
  cert[field].split('\n').reverse().join(',');

export function checkPki(pki: PkiTruth, c: Check): void {
  const certs = new Map<string, X509Certificate>();
  const keys = new Map<string, ReturnType<typeof createPrivateKey>>();
  for (const f of pki.files) {
    const path = join(FIXTURES_DIR, f.file);
    c.ok(existsSync(path), `${f.file} exists`);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    c.eq(sha256(bytes), f.sha256, `${f.file} sha256`);
    if (f.kind === 'certificate') {
      const cert = new X509Certificate(bytes);
      c.eq(rfc4514(cert, 'subject'), f.subject, `${f.file} subject`);
      c.eq(rfc4514(cert, 'issuer'), f.issuer, `${f.file} issuer`);
      c.eq(cert.serialNumber.toLowerCase().replace(/^0+/, ''), f.serial, `${f.file} serial`);
      c.ok(
        new Date(cert.validFrom) <= new Date('2024-01-01T00:00:00Z'),
        `${f.file} valid at the claimed signing time`,
      );
      c.ok(new Date(cert.validTo) > new Date(), `${f.file} still valid today`);
      if (f.subject) certs.set(f.subject, cert);
    } else if (f.kind === 'private-key') {
      const key = createPrivateKey(bytes);
      c.eq(key.asymmetricKeyType, f.keyType?.startsWith('EC') ? 'ec' : 'rsa', `${f.file} key type`);
      if (f.subject) keys.set(f.subject, key);
    } else if (f.kind === 'certificate-chain') {
      const pems =
        bytes
          .toString('latin1')
          .match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g) ?? [];
      c.eq(pems.length, 3, `${f.file} holds three certificates`);
      c.eq(
        subjectOf(new X509Certificate(pems[0] ?? '').raw),
        f.subject,
        `${f.file} starts with the signer`,
      );
    }
  }
  // Every certificate verifies with its issuer's key; the root is self-signed.
  for (const [subject, cert] of certs) {
    const issuer = certs.get(rfc4514(cert, 'issuer'));
    c.ok(!!issuer && cert.verify(issuer.publicKey), `${subject}: signature by its issuer verifies`);
    // A signer's key pair matches its certificate.
    const key = keys.get(subject);
    if (key) c.ok(cert.checkPrivateKey(key), `${subject}: private key matches the certificate`);
  }
  for (const f of pki.files.filter((x) => x.kind === 'pkcs12')) {
    const path = join(FIXTURES_DIR, f.file);
    if (!existsSync(path)) continue;
    const der = new Uint8Array(readFileSync(path));
    const p12 = readP12(der, f.password ?? '');
    c.ok(p12.macValid, `${f.file} MAC verifies with the password`);
    let refused = false;
    try {
      readP12(der, 'wrong-password');
    } catch {
      refused = true;
    }
    c.ok(refused, `${f.file} MAC fails with a wrong password`);
    c.eq(
      [p12.scheme, p12.macAlgorithm, p12.iterations, p12.friendlyName, p12.certs.length],
      [f.scheme, f.macAlgorithm, f.iterations, f.friendlyName, f.certificates],
      `${f.file} layout`,
    );
    c.eq(subjectOf(p12.certs[0] ?? new Uint8Array()), f.subject, `${f.file} first certificate`);
    const key = createPrivateKey({ key: Buffer.from(p12.key), format: 'der', type: 'pkcs8' });
    const expected = f.subject ? keys.get(f.subject) : undefined;
    c.ok(!!expected && key.equals(expected), `${f.file} key equals the committed key`);
  }
}
