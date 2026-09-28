/**
 * Validator prototype (seed of W3's validator, spec §3.1): byte range, digest, CMS signature
 * over the signed attributes, signingCertificateV2, chain to a root inside the file (no trust
 * store), validity, key usage, and a classification of later incremental sections.
 * Spike shortcut: signature dictionaries are found by scanning the raw bytes for /ByteRange;
 * the product walks the AcroForm field tree instead.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';
import type { PDFObject } from '@cantoo/pdf-lib';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

import { equalBytes, fromHex, latin1, revisionEnds } from './bytes';
import { OID } from './cms';
import { signedBytes } from './sign';
import { walkChain } from './xref';

export type SignatureStatus =
  | 'intact'
  | 'intact-changed-later'
  | 'changed-after-signing'
  | 'broken'
  | 'cannot-check';
export type CheckId =
  | 'byte-range'
  | 'digest'
  | 'signature'
  | 'signing-certificate'
  | 'chain'
  | 'validity'
  | 'key-usage'
  | 'later-changes';
export type Outcome = 'pass' | 'fail' | 'not-checked' | 'unsupported';
export type ChangeKind =
  | 'form-fill'
  | 'annotations'
  | 'signature'
  | 'dss'
  | 'metadata'
  | 'pages'
  | 'content'
  | 'other';

export interface SignatureCheck {
  readonly id: CheckId;
  readonly outcome: Outcome;
  readonly detail: string;
}
export interface LaterChange {
  readonly kind: ChangeKind;
  readonly objects: number[];
}
export interface SignatureValidation {
  readonly byteRange: number[];
  readonly subFilter: string;
  readonly claimedTime?: string;
  readonly signer?: string;
  readonly status: SignatureStatus;
  readonly checks: SignatureCheck[];
  readonly laterChanges: LaterChange[];
}

const ALLOWED: ReadonlySet<ChangeKind> = new Set(['form-fill', 'annotations', 'signature', 'dss']);
const DIGESTS: Record<string, string> = {
  '1.3.14.3.2.26': 'SHA-1',
  [OID.sha256]: 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};
const CURVES: Record<string, string> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
};

const nameDer = (n: pkijs.RelativeDistinguishedNames): Uint8Array =>
  new Uint8Array(n.toSchema().toBER());
const cn = (n: pkijs.RelativeDistinguishedNames): string =>
  n.typesAndValues
    .map((tv) => `${tv.type === '2.5.4.3' ? 'CN' : tv.type}=${tv.value.valueBlock.value}`)
    .join(', ');

/** DER ECDSA-Sig-Value → IEEE P1363 r||s, which WebCrypto verifies. */
function ecdsaRaw(signature: Uint8Array, curve: string): Uint8Array {
  const size = curve === 'P-256' ? 32 : curve === 'P-384' ? 48 : 66;
  const seq = asn1js.fromBER(signature.slice().buffer).result as asn1js.Sequence;
  const out = new Uint8Array(2 * size);
  seq.valueBlock.value.forEach((part, i) => {
    let v = (part as asn1js.Integer).valueBlock.valueHexView;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    out.set(v, i * size + size - v.length);
  });
  return out;
}

async function verifySignerSignature(
  signer: pkijs.SignerInfo,
  leaf: pkijs.Certificate,
  hash: string,
): Promise<SignatureCheck> {
  const signed = signer.signedAttrs?.encodedValue;
  if (!signed) return { id: 'signature', outcome: 'unsupported', detail: 'no signed attributes' };
  const sigOid = signer.signatureAlgorithm.algorithmId;
  const spki = leaf.subjectPublicKeyInfo;
  const keyOid = spki.algorithm.algorithmId;
  let sigValue = signer.signature.valueBlock.valueHexView;
  let importParams: RsaHashedImportParams | EcKeyImportParams;
  let verifyParams: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
  if (sigOid === '1.2.840.113549.1.1.10') {
    const pss = new pkijs.RSASSAPSSParams({ schema: signer.signatureAlgorithm.algorithmParams });
    const pssHash = DIGESTS[pss.hashAlgorithm.algorithmId] ?? 'SHA-1';
    importParams = { name: 'RSA-PSS', hash: pssHash };
    verifyParams = { name: 'RSA-PSS', saltLength: pss.saltLength };
  } else if (keyOid === '1.2.840.113549.1.1.1') {
    importParams = { name: 'RSASSA-PKCS1-v1_5', hash };
    verifyParams = { name: 'RSASSA-PKCS1-v1_5' };
  } else if (keyOid === '1.2.840.10045.2.1') {
    const curveOid = (
      spki.algorithm.algorithmParams as asn1js.ObjectIdentifier
    ).valueBlock.toString();
    const curve = CURVES[curveOid];
    if (!curve) return { id: 'signature', outcome: 'unsupported', detail: `curve ${curveOid}` };
    importParams = { name: 'ECDSA', namedCurve: curve };
    verifyParams = { name: 'ECDSA', hash };
    sigValue = ecdsaRaw(sigValue, curve);
  } else {
    return { id: 'signature', outcome: 'unsupported', detail: `key algorithm ${keyOid}` };
  }
  const key = await crypto.subtle.importKey('spki', spki.toSchema().toBER(), importParams, false, [
    'verify',
  ]);
  const ok = await crypto.subtle.verify(verifyParams, key, sigValue.slice(), signed);
  return {
    id: 'signature',
    outcome: ok ? 'pass' : 'fail',
    detail: `${importParams.name} over signed attributes`,
  };
}

async function checkSigningCertificate(
  signer: pkijs.SignerInfo,
  leaf: pkijs.Certificate,
): Promise<SignatureCheck> {
  const attr = signer.signedAttrs?.attributes.find((a) => a.type === OID.signingCertificateV2);
  if (!attr) {
    return { id: 'signing-certificate', outcome: 'fail', detail: 'signingCertificateV2 absent' };
  }
  // SigningCertificateV2 ::= SEQUENCE { certs SEQUENCE OF ESSCertIDv2, ... }
  const certs = (attr.values[0] as asn1js.Sequence).valueBlock.value[0] as asn1js.Sequence;
  const first = certs.valueBlock.value[0] as asn1js.Sequence;
  let hashName = 'SHA-256';
  let idx = 0;
  const head = first.valueBlock.value[0];
  if (head instanceof asn1js.Sequence) {
    hashName = DIGESTS[new pkijs.AlgorithmIdentifier({ schema: head }).algorithmId] ?? '?';
    idx = 1;
  }
  const certHash = (first.valueBlock.value[idx] as asn1js.OctetString).valueBlock.valueHexView;
  const actual = new Uint8Array(await crypto.subtle.digest(hashName, leaf.toSchema().toBER()));
  const ok = equalBytes(certHash, actual);
  return {
    id: 'signing-certificate',
    outcome: ok ? 'pass' : 'fail',
    detail: `ESSCertIDv2 ${hashName} ${ok ? 'matches' : 'does not match'} the signer certificate`,
  };
}

async function checkChain(
  leaf: pkijs.Certificate,
  pool: pkijs.Certificate[],
): Promise<SignatureCheck> {
  let current = leaf;
  const path = [leaf];
  for (let i = 0; i < 10; i++) {
    if (equalBytes(nameDer(current.issuer), nameDer(current.subject))) {
      const selfOk = await current.verify();
      return selfOk
        ? {
            id: 'chain',
            outcome: 'pass',
            detail: `complete to a root included in the file (${path.length} certificates; not trusted)`,
          }
        : { id: 'chain', outcome: 'fail', detail: 'root self-signature does not verify' };
    }
    const issuer = pool.find((c) => equalBytes(nameDer(c.subject), nameDer(current.issuer)));
    if (!issuer) {
      return {
        id: 'chain',
        outcome: 'fail',
        detail: `incomplete: issuer of "${cn(current.subject)}" not in the file`,
      };
    }
    if (!(await current.verify(issuer))) {
      return {
        id: 'chain',
        outcome: 'fail',
        detail: `"${cn(current.subject)}" not signed by its issuer`,
      };
    }
    path.push(issuer);
    current = issuer;
  }
  return { id: 'chain', outcome: 'fail', detail: 'path too long' };
}

function checkValidity(leaf: pkijs.Certificate, claimed: Date | undefined): SignatureCheck {
  const inside = (d: Date): boolean => d >= leaf.notBefore.value && d <= leaf.notAfter.value;
  const now = new Date();
  const atClaim = claimed ? inside(claimed) : undefined;
  const ok = inside(now) && atClaim !== false;
  return {
    id: 'validity',
    outcome: ok ? 'pass' : 'fail',
    detail: `claimed time ${atClaim === undefined ? 'absent' : atClaim ? 'inside' : 'outside'}, now ${inside(now) ? 'inside' : 'outside'} the validity period`,
  };
}

function checkKeyUsage(leaf: pkijs.Certificate): SignatureCheck {
  const ext = leaf.extensions?.find((e) => e.extnID === '2.5.29.15');
  if (!ext) return { id: 'key-usage', outcome: 'pass', detail: 'no keyUsage extension' };
  const bits = (ext.parsedValue as asn1js.BitString).valueBlock.valueHexView;
  const first = bits[0] ?? 0;
  const ok = (first & 0x80) !== 0 || (first & 0x40) !== 0;
  return {
    id: 'key-usage',
    outcome: ok ? 'pass' : 'fail',
    detail: ok
      ? 'digitalSignature or nonRepudiation set'
      : 'neither digitalSignature nor nonRepudiation',
  };
}

function objectsByNumber(doc: PDFDocument): Map<number, PDFObject> {
  const map = new Map<number, PDFObject>();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) map.set(ref.objectNumber, obj);
  return map;
}

function nameOf(dict: PDFDict, key: string): string | undefined {
  return dict.lookupMaybe(PDFName.of(key), PDFName)?.decodeText();
}

function refsIn(obj: PDFObject | undefined): Set<number> {
  const out = new Set<number>();
  if (obj instanceof PDFArray)
    for (const v of obj.asArray()) if (v instanceof PDFRef) out.add(v.objectNumber);
  return out;
}

function isSigWidget(obj: PDFObject | undefined): boolean {
  return (
    obj instanceof PDFDict && nameOf(obj, 'Subtype') === 'Widget' && nameOf(obj, 'FT') === 'Sig'
  );
}

function changedKeys(before: PDFDict, after: PDFDict): string[] {
  const keys = new Set([...before.keys(), ...after.keys()].map((k) => k.decodeText()));
  return [...keys].filter(
    (k) => String(before.get(PDFName.of(k)) ?? '') !== String(after.get(PDFName.of(k)) ?? ''),
  );
}

/** Classifies every object written by the sections appended after `signedEnd`. */
export async function classifyLaterChanges(
  bytes: Uint8Array,
  signedEnd: number,
): Promise<LaterChange[]> {
  const { sections } = await walkChain(bytes);
  const later = sections.filter((s) => s.offset >= signedEnd);
  const skip = new Set(later.map((s) => s.streamObject ?? -1));
  const nums = new Set<number>();
  for (const s of later)
    for (const e of s.entries) if (e.type !== 0 && !skip.has(e.num)) nums.add(e.num);
  const load = (b: Uint8Array) =>
    PDFDocument.load(b, { updateMetadata: false, ignoreEncryption: true, preserveXFA: true });
  const [beforeDoc, afterDoc] = await Promise.all([load(bytes.slice(0, signedEnd)), load(bytes)]);
  const before = objectsByNumber(beforeDoc);
  const after = objectsByNumber(afterDoc);
  const infoRef = afterDoc.context.trailerInfo.Info;
  const infoNum = infoRef instanceof PDFRef ? infoRef.objectNumber : -1;
  const acroRef = afterDoc.catalog.get(PDFName.of('AcroForm'));
  const acroNum = acroRef instanceof PDFRef ? acroRef.objectNumber : -1;
  // Streams referenced from a page's /Contents are page content.
  const contentStreams = new Set<number>();
  for (const page of afterDoc.getPages()) {
    const contents = page.node.get(PDFName.of('Contents'));
    if (contents instanceof PDFRef) contentStreams.add(contents.objectNumber);
    for (const r of refsIn(page.node.lookup(PDFName.of('Contents')))) contentStreams.add(r);
  }
  // Appearance streams of new or changed annotations count with their annotation.
  const annotAppearances = new Set<number>();
  for (const n of nums) {
    const obj = after.get(n);
    if (obj instanceof PDFDict && nameOf(obj, 'Type') === 'Annot') {
      const ap = obj.lookupMaybe(PDFName.of('AP'), PDFDict);
      for (const k of ['N', 'R', 'D']) {
        const v = ap?.get(PDFName.of(k));
        if (v instanceof PDFRef) annotAppearances.add(v.objectNumber);
      }
    }
  }
  const kinds = new Map<ChangeKind, number[]>();
  const add = (kind: ChangeKind, n: number): void => {
    kinds.set(kind, [...(kinds.get(kind) ?? []), n]);
  };
  for (const n of [...nums].sort((a, b) => a - b)) {
    const now = after.get(n);
    const was = before.get(n);
    if (was !== undefined && was.toString() === now?.toString()) continue;
    if (now instanceof PDFRawStream && nameOf(now.dict, 'Type') === 'ObjStm') continue;
    if (n === infoNum) {
      add('metadata', n);
      continue;
    }
    if (annotAppearances.has(n)) {
      add('annotations', n);
      continue;
    }
    if (contentStreams.has(n)) {
      add('content', n);
      continue;
    }
    if (now instanceof PDFDict) {
      const type = nameOf(now, 'Type');
      if (type === 'Sig' || type === 'DocTimeStamp') add('signature', n);
      else if (type === 'Annot')
        add(
          isSigWidget(now)
            ? 'signature'
            : nameOf(now, 'Subtype') === 'Widget'
              ? 'form-fill'
              : 'annotations',
          n,
        );
      else if (n === acroNum) {
        const added = [...refsIn(now.lookup(PDFName.of('Fields')))].filter(
          (r) => !(was instanceof PDFDict) || !refsIn(was.lookup(PDFName.of('Fields'))).has(r),
        );
        add(added.every((r) => isSigWidget(after.get(r))) ? 'signature' : 'form-fill', n);
      } else if (type === 'Catalog' && was instanceof PDFDict) {
        const keys = changedKeys(was, now);
        add(
          keys.every((k) => k === 'DSS')
            ? 'dss'
            : keys.every((k) => k === 'AcroForm')
              ? 'signature'
              : keys.every((k) => k === 'Metadata')
                ? 'metadata'
                : 'other',
          n,
        );
      } else if (type === 'Page' && was instanceof PDFDict) {
        const keys = changedKeys(was, now);
        if (keys.every((k) => k === 'Annots')) {
          const old = refsIn(was.lookup(PDFName.of('Annots')));
          const added = [...refsIn(now.lookup(PDFName.of('Annots')))].filter((r) => !old.has(r));
          add(added.every((r) => isSigWidget(after.get(r))) ? 'signature' : 'annotations', n);
        } else
          add(keys.some((k) => k === 'Contents' || k === 'Resources') ? 'content' : 'pages', n);
      } else if (type === 'DSS') add('dss', n);
      else add(was === undefined ? 'content' : 'other', n);
    } else if (now instanceof PDFArray) {
      add('annotations', n);
    } else {
      add(was === undefined ? 'content' : 'other', n);
    }
  }
  return [...kinds].map(([kind, objects]) => ({ kind, objects }));
}

interface FoundSignature {
  readonly byteRange: number[];
  readonly subFilter: string;
  readonly claimed?: string;
}

function findSignatures(bytes: Uint8Array): FoundSignature[] {
  const text = latin1(bytes);
  const out: FoundSignature[] = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const objStart = text.lastIndexOf(' obj', m.index);
    const objEnd = text.indexOf('endobj', m.index);
    const dict = text
      .slice(objStart, objEnd < 0 ? undefined : objEnd)
      .replace(/<[0-9A-Fa-f\s]{64,}>/, '<…>');
    const claimed = /\/M\s*\(([^)]*)\)/.exec(dict)?.[1];
    out.push({
      byteRange: m.slice(1, 5).map(Number),
      subFilter: /\/SubFilter\s*\/([^\s/<>[\]]+)/.exec(dict)?.[1] ?? '?',
      ...(claimed === undefined ? {} : { claimed }),
    });
  }
  return out;
}

function pdfDate(s: string | undefined): Date | undefined {
  const m = s && /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(s);
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(y, mo - 1, d, h, mi, se));
}

export async function validatePdf(bytes: Uint8Array): Promise<SignatureValidation[]> {
  const results: SignatureValidation[] = [];
  const ends = new Set(revisionEnds(bytes));
  for (const found of findSignatures(bytes)) {
    results.push(await validateOne(bytes, found, ends));
  }
  return results;
}

async function validateOne(
  bytes: Uint8Array,
  found: FoundSignature,
  ends: ReadonlySet<number>,
): Promise<SignatureValidation> {
  const checks: SignatureCheck[] = [];
  const base = {
    byteRange: found.byteRange,
    subFilter: found.subFilter,
    ...(found.claimed === undefined ? {} : { claimedTime: found.claimed }),
  };
  const done = (status: SignatureStatus, laterChanges: LaterChange[] = [], signer?: string) => ({
    ...base,
    status,
    checks,
    laterChanges,
    ...(signer === undefined ? {} : { signer }),
  });
  // 1. Byte range: starts at 0, gap is exactly the hex string, inside the file, ends a revision.
  const [a = -1, b = -1, c = -1, d = -1] = found.byteRange;
  const gap = b >= 0 && c <= bytes.length ? latin1(bytes, b, c) : '';
  const end = c + d;
  const rangeOk =
    a === 0 && b > 0 && c > b && d >= 0 && end <= bytes.length && /^<[0-9A-Fa-f]*>$/.test(gap);
  const endsRevision = end === bytes.length || ends.has(end);
  checks.push({
    id: 'byte-range',
    outcome: rangeOk && endsRevision ? 'pass' : 'fail',
    detail: rangeOk
      ? endsRevision
        ? `covers ${end === bytes.length ? 'the whole file' : `revision ending at ${end}`} except /Contents`
        : `ends at ${end}, not at a revision end`
      : 'malformed or not exactly the /Contents string',
  });
  if (!rangeOk || !endsRevision) return done('broken');

  // 2. CMS.
  let signedData: pkijs.SignedData;
  try {
    const der = fromHex(gap.slice(1, -1));
    const asn = asn1js.fromBER(der.buffer);
    if (asn.offset === -1) throw new Error(asn.result.error);
    const ci = new pkijs.ContentInfo({ schema: asn.result });
    if (ci.contentType !== OID.signedData) throw new Error(`content type ${ci.contentType}`);
    signedData = new pkijs.SignedData({ schema: ci.content });
  } catch (error) {
    checks.push({
      id: 'digest',
      outcome: 'unsupported',
      detail: `CMS unreadable: ${String(error)}`,
    });
    return done('cannot-check');
  }
  const signer = signedData.signerInfos[0];
  const hash = signer && DIGESTS[signer.digestAlgorithm.algorithmId];
  if (!signer || !hash) {
    checks.push({ id: 'digest', outcome: 'unsupported', detail: 'digest algorithm not supported' });
    return done('cannot-check');
  }
  const certs = (signedData.certificates ?? []).filter(
    (x): x is pkijs.Certificate => x instanceof pkijs.Certificate,
  );
  // pkijs types `sid` as any (IssuerAndSerialNumber or a [0] subjectKeyIdentifier).
  const sid = signer.sid as unknown;
  const leaf =
    sid instanceof pkijs.IssuerAndSerialNumber
      ? certs.find(
          (x) =>
            equalBytes(nameDer(x.issuer), nameDer(sid.issuer)) &&
            x.serialNumber.isEqual(sid.serialNumber),
        )
      : undefined;

  // 3. Digest of the byte ranges against messageDigest. adbe.pkcs7.sha1: the encapsulated
  // content is SHA-1(ranges) and messageDigest is the digest of that content.
  const md = signer.signedAttrs?.attributes.find((x) => x.type === OID.messageDigest);
  const expected = (md?.values[0] as asn1js.OctetString | undefined)?.valueBlock.valueHexView;
  const ranges = signedBytes(bytes, found.byteRange).slice();
  let digestOk: boolean;
  let digestDetail: string;
  if (found.subFilter === 'adbe.pkcs7.sha1') {
    const eContent = signedData.encapContentInfo.eContent?.valueBlock.valueHexView;
    const sha1 = new Uint8Array(await crypto.subtle.digest('SHA-1', ranges));
    const inner = eContent !== undefined && equalBytes(eContent, sha1);
    const outer =
      eContent !== undefined &&
      expected !== undefined &&
      equalBytes(expected, new Uint8Array(await crypto.subtle.digest(hash, eContent.slice())));
    digestOk = inner && outer;
    digestDetail = `SHA-1 (weak) of the byte ranges ${inner ? 'matches' : 'does not match'} the encapsulated digest; messageDigest ${outer ? 'matches' : 'does not match'} it`;
  } else {
    const actual = new Uint8Array(await crypto.subtle.digest(hash, ranges));
    digestOk = expected !== undefined && equalBytes(expected, actual);
    digestDetail = `${hash}${hash === 'SHA-1' ? ' (weak)' : ''} of the byte ranges ${digestOk ? 'matches' : 'does not match'} messageDigest`;
  }
  checks.push({ id: 'digest', outcome: digestOk ? 'pass' : 'fail', detail: digestDetail });
  if (!leaf) {
    checks.push({
      id: 'signature',
      outcome: 'unsupported',
      detail: 'signer certificate not in the CMS',
    });
    return done(digestOk ? 'cannot-check' : 'broken');
  }
  // 4. Signature, signing certificate, chain, validity, key usage.
  const sig = await verifySignerSignature(signer, leaf, hash);
  checks.push(sig);
  checks.push(
    found.subFilter === 'ETSI.CAdES.detached'
      ? await checkSigningCertificate(signer, leaf)
      : {
          id: 'signing-certificate',
          outcome: 'not-checked',
          detail: `not required for ${found.subFilter}`,
        },
  );
  checks.push(await checkChain(leaf, certs));
  checks.push(checkValidity(leaf, pdfDate(found.claimed)));
  checks.push(checkKeyUsage(leaf));
  const signerName = cn(leaf.subject);
  if (!digestOk || sig.outcome === 'fail') return done('broken', [], signerName);
  if (sig.outcome !== 'pass') return done('cannot-check', [], signerName);

  // 5. Later changes.
  if (end === bytes.length) {
    checks.push({ id: 'later-changes', outcome: 'pass', detail: 'no later revisions' });
    return done('intact', [], signerName);
  }
  const later = await classifyLaterChanges(bytes, end);
  const allowed = later.every((x) => ALLOWED.has(x.kind));
  checks.push({
    id: 'later-changes',
    outcome: allowed ? 'pass' : 'fail',
    detail:
      later.map((x) => `${x.kind} (objects ${x.objects.join(', ')})`).join('; ') ||
      'no-op rewrite only',
  });
  return done(allowed ? 'intact-changed-later' : 'changed-after-signing', later, signerName);
}
