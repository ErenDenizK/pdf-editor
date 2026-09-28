/**
 * Signature validator (spec §3.1, ADR-0013). For every signature dictionary: the byte range
 * (from 0, the gap exactly the /Contents hex string read from the raw bytes, ending at a
 * revision end), the digest of the ranges against the CMS, the CMS signature over the signed
 * attributes with the signer's key (WebCrypto), the signing-certificate(-v2) attribute, the
 * chain as embedded, validity and key usage as facts, and what later revisions changed.
 * Nothing is fetched and nothing is trusted: the best status is "Intact", never "valid".
 *
 * Signature dictionaries are found three ways, so damage cannot hide one: the AcroForm field
 * tree (and /Perms), every indirect object pdf-lib reads that is a signature dictionary, and a
 * raw scan for /ByteRange (for what pdf-lib cannot parse). No signatures → an empty list.
 */
import type { PDFDocument } from '@cantoo/pdf-lib';
import { PDFDict, PDFName, type PDFObject, type PDFRef } from '@cantoo/pdf-lib';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

import {
  type EngineCallOptions,
  EngineError,
  type RevisionChange,
  SIGNATURE_HONESTY_LINE,
  type SignatureCheck,
  type SignatureReport,
  type SignatureStatus,
  type SignerFacts,
  type ValidateSignaturesOptions,
} from '../types';
import { derLength, equalBytes, fromHex, latin1, signedBytes } from './bytes';
import {
  buildChain,
  certificateFacts,
  certificatesOf,
  keyUsageCheck,
  nameDer,
  rsaBits,
  validityCheck,
} from './certificates';
import {
  loadForSignatures,
  parsePdfDate,
  readSignatureDictionary,
  readSignatureFields,
  type SignatureDictionary,
  type SignatureFieldInfo,
} from './fields';
import {
  ATTRIBUTE_NAMES,
  BROKEN_DIGESTS,
  CURVES,
  DIGESTS,
  type HashName,
  OID,
  SIGNATURE_ALGORITHMS,
} from './oids';
import { allowedKinds, classifyLaterChanges } from './revisions';
import { type RevisionEnd, revisionEndingAt, revisionEnds } from './xref';

/**
 * A file with none of these cannot hold a signature: signature dictionaries have /ByteRange
 * and /Type /Sig (either may be damaged, not both), or sit in an object stream.
 */
const SIGNATURE_TOKENS = ['/ByteRange', '/Sig', '/DocTimeStamp', '/ObjStm'];

const SUPPORTED_SUBFILTERS = new Set([
  'ETSI.CAdES.detached',
  'adbe.pkcs7.detached',
  'adbe.pkcs7.sha1',
]);

function throwIfAborted(options: EngineCallOptions | undefined): void {
  if (options?.signal?.aborted) {
    throw new EngineError('aborted', 'Signature validation aborted', {
      cause: options.signal.reason,
    });
  }
}

/** One signature to check, however it was found. */
interface Candidate {
  readonly fieldName: string;
  readonly pageIndex?: number;
  readonly rect?: SignatureFieldInfo['rect'];
  readonly sig: SignatureDictionary;
}

interface Context {
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly ends: readonly RevisionEnd[];
  readonly doc: PDFDocument | undefined;
  readonly password: string | undefined;
  readonly before: Map<number, Promise<PDFDocument>>;
}

function octets(value: asn1js.OctetString): Uint8Array {
  if (!value.idBlock.isConstructed) return value.valueBlock.valueHexView;
  const parts = value.valueBlock.value.map((p) => octets(p as asn1js.OctetString));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function digest(hash: HashName, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(hash, data.slice()));
}

/** DER ECDSA-Sig-Value → IEEE P1363 r||s, which WebCrypto verifies. */
function ecdsaRaw(signature: Uint8Array, size: number): Uint8Array {
  const parsed = asn1js.fromBER(signature.slice().buffer);
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) {
    throw new Error('ECDSA signature is not a DER sequence');
  }
  const out = new Uint8Array(2 * size);
  parsed.result.valueBlock.value.slice(0, 2).forEach((part, i) => {
    let v = (part as asn1js.Integer).valueBlock.valueHexView;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new Error('ECDSA integer too long');
    out.set(v, i * size + size - v.length);
  });
  return out;
}

const CURVE_BYTES = { 'P-256': 32, 'P-384': 48, 'P-521': 66 } as const;

interface SignatureOutcome {
  readonly check: SignatureCheck;
  readonly algorithm?: string;
}

async function verifySignature(
  signer: pkijs.SignerInfo,
  leaf: pkijs.Certificate,
  data: Uint8Array,
  digestHash: HashName,
  weakReasons: string[],
): Promise<SignatureOutcome> {
  const sigOid = signer.signatureAlgorithm.algorithmId;
  const known = SIGNATURE_ALGORITHMS[sigOid];
  if (!known) {
    return {
      check: {
        id: 'signature',
        outcome: 'unsupported',
        detail: `Signature algorithm ${sigOid} is not supported.`,
      },
    };
  }
  if (known.hash === 'MD5') {
    return {
      check: {
        id: 'signature',
        outcome: 'unsupported',
        detail: 'MD5 signatures cannot be checked.',
      },
    };
  }
  const spki = leaf.subjectPublicKeyInfo;
  const keyOid = spki.algorithm.algorithmId;
  let signature = signer.signature.valueBlock.valueHexView;
  let importParams: RsaHashedImportParams | EcKeyImportParams;
  let verifyParams: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
  let algorithm: string;
  let hash: HashName = known.hash ?? digestHash;
  try {
    if (known.family === 'RSA-PSS') {
      const pss = new pkijs.RSASSAPSSParams({ schema: signer.signatureAlgorithm.algorithmParams });
      const pssHash = DIGESTS[pss.hashAlgorithm.algorithmId];
      if (!pssHash) {
        return {
          check: { id: 'signature', outcome: 'unsupported', detail: 'RSA-PSS hash not supported.' },
        };
      }
      hash = pssHash;
      importParams = { name: 'RSA-PSS', hash };
      verifyParams = { name: 'RSA-PSS', saltLength: pss.saltLength };
      algorithm = 'RSA-PSS';
    } else if (known.family === 'RSA') {
      if (keyOid !== OID.rsaEncryption) {
        return {
          check: {
            id: 'signature',
            outcome: 'unsupported',
            detail: `An RSA signature with a ${keyOid} key.`,
          },
        };
      }
      importParams = { name: 'RSASSA-PKCS1-v1_5', hash };
      verifyParams = { name: 'RSASSA-PKCS1-v1_5' };
      algorithm = 'RSASSA-PKCS1-v1_5';
    } else {
      if (keyOid !== OID.ecPublicKey) {
        return {
          check: {
            id: 'signature',
            outcome: 'unsupported',
            detail: `An ECDSA signature with a ${keyOid} key.`,
          },
        };
      }
      const params = spki.algorithm.algorithmParams as unknown;
      const curveOid =
        params instanceof asn1js.ObjectIdentifier ? params.valueBlock.toString() : '';
      const curve = CURVES[curveOid];
      if (!curve) {
        return {
          check: {
            id: 'signature',
            outcome: 'unsupported',
            detail: `Curve ${curveOid || 'unknown'} is not supported.`,
          },
        };
      }
      importParams = { name: 'ECDSA', namedCurve: curve };
      verifyParams = { name: 'ECDSA', hash };
      algorithm = `ECDSA ${curve}`;
      signature = ecdsaRaw(signature, CURVE_BYTES[curve]);
    }
  } catch (error) {
    return {
      check: {
        id: 'signature',
        outcome: 'fail',
        detail: `The signature value cannot be read (${error instanceof Error ? error.message : String(error)}).`,
      },
    };
  }
  if (hash === 'SHA-1' && !weakReasons.some((r) => r.includes('signature'))) {
    weakReasons.push('The signature uses SHA-1, which is weak.');
  }
  if (algorithm.startsWith('RSA')) {
    const bits = rsaBits(leaf);
    if (bits !== undefined && bits < 2048) weakReasons.push(`The RSA key has only ${bits} bits.`);
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('spki', spki.toSchema().toBER(), importParams, false, [
      'verify',
    ]);
  } catch {
    return {
      check: {
        id: 'signature',
        outcome: 'unsupported',
        detail: `The signer's ${algorithm} key cannot be used here.`,
      },
      algorithm,
    };
  }
  const ok = await crypto.subtle
    .verify(verifyParams, key, signature.slice(), data.slice())
    .catch(() => false);
  return {
    check: {
      id: 'signature',
      outcome: ok ? 'pass' : 'fail',
      detail: `${algorithm} with ${hash} ${ok ? 'verifies' : 'does not verify'} with the signer certificate's key.`,
    },
    algorithm,
  };
}

function findLeaf(
  signer: pkijs.SignerInfo,
  certs: readonly pkijs.Certificate[],
): pkijs.Certificate | undefined {
  // pkijs types `sid` as any: IssuerAndSerialNumber or a [0] subjectKeyIdentifier.
  const sid = signer.sid as unknown;
  if (sid instanceof pkijs.IssuerAndSerialNumber) {
    const issuer = nameDer(sid.issuer);
    return certs.find(
      (c) => equalBytes(nameDer(c.issuer), issuer) && c.serialNumber.isEqual(sid.serialNumber),
    );
  }
  const view = (sid as { valueBlock?: { valueHexView?: Uint8Array } } | undefined)?.valueBlock
    ?.valueHexView;
  if (!view) return undefined;
  return certs.find((c) => {
    const ski = c.extensions?.find((e) => e.extnID === '2.5.29.14')?.parsedValue as unknown;
    return ski instanceof asn1js.OctetString && equalBytes(ski.valueBlock.valueHexView, view);
  });
}

async function signingCertificateCheck(
  signer: pkijs.SignerInfo,
  leaf: pkijs.Certificate,
  subFilter: string,
): Promise<SignatureCheck> {
  const attrs = signer.signedAttrs?.attributes ?? [];
  const v2 = attrs.find((a) => a.type === OID.signingCertificateV2);
  const v1 = attrs.find((a) => a.type === OID.signingCertificate);
  const attr = v2 ?? v1;
  if (!attr) {
    return subFilter === 'ETSI.CAdES.detached'
      ? {
          id: 'signing-certificate',
          outcome: 'fail',
          detail: 'The signingCertificateV2 attribute PAdES requires is absent.',
        }
      : {
          id: 'signing-certificate',
          outcome: 'not-checked',
          detail: `Not required for ${subFilter || 'this SubFilter'}.`,
        };
  }
  try {
    // SigningCertificate(V2) ::= SEQUENCE { certs SEQUENCE OF ESSCertID(v2), ... }
    const certs = (attr.values[0] as asn1js.Sequence).valueBlock.value[0] as asn1js.Sequence;
    const first = certs.valueBlock.value[0] as asn1js.Sequence;
    let hashName: HashName | undefined = v2 ? 'SHA-256' : 'SHA-1';
    let idx = 0;
    const head = first.valueBlock.value[0];
    if (v2 && head instanceof asn1js.Sequence) {
      hashName = DIGESTS[new pkijs.AlgorithmIdentifier({ schema: head }).algorithmId];
      idx = 1;
    }
    if (!hashName) {
      return {
        id: 'signing-certificate',
        outcome: 'unsupported',
        detail: 'The certificate hash algorithm is not supported.',
      };
    }
    const certHash = (first.valueBlock.value[idx] as asn1js.OctetString).valueBlock.valueHexView;
    const actual = await digest(hashName, new Uint8Array(leaf.toSchema().toBER()));
    const ok = equalBytes(certHash, actual);
    return {
      id: 'signing-certificate',
      outcome: ok ? 'pass' : 'fail',
      detail: `${v2 ? 'signingCertificateV2' : 'signingCertificate'} (${hashName}) ${ok ? 'matches' : 'does not match'} the signer certificate.`,
    };
  } catch {
    return {
      id: 'signing-certificate',
      outcome: 'fail',
      detail: 'The signing-certificate attribute cannot be read.',
    };
  }
}

function isoOrUndefined(m: string | undefined): string | undefined {
  return parsePdfDate(m)?.toISOString();
}

async function laterChanges(
  ctx: Context,
  end: number,
  docMdp: 1 | 2 | 3 | undefined,
): Promise<{ check: SignatureCheck; changes: RevisionChange[]; allowed: boolean }> {
  const fail = (detail: string) => ({
    check: { id: 'later-changes' as const, outcome: 'fail' as const, detail },
    changes: [] as RevisionChange[],
    allowed: false,
  });
  if (!ctx.doc) return fail('The later revisions cannot be read, so what they change is unknown.');
  let before = ctx.before.get(end);
  if (!before) {
    before = loadForSignatures(ctx.bytes.subarray(0, end), ctx.password).then((r) => r.doc);
    ctx.before.set(end, before);
  }
  try {
    const { changes } = await classifyLaterChanges(ctx.bytes, end, ctx.ends, await before, ctx.doc);
    const allowedSet = allowedKinds(docMdp);
    const allowed = changes.every((c) => allowedSet.has(c.kind));
    const listed =
      changes
        .map((c) => `revision ${c.revision}: ${c.kind} (${c.objects.join(', ')})`)
        .join('; ') || 'they change nothing a reader shows';
    return {
      check: {
        id: 'later-changes',
        outcome: allowed ? 'pass' : 'fail',
        detail: `Later revisions: ${listed}.${docMdp ? ` DocMDP permissions ${docMdp} decide what is allowed.` : ''}`,
      },
      changes,
      allowed,
    };
  } catch (error) {
    return fail(
      `The later revisions cannot be read (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

async function validateOne(ctx: Context, candidate: Candidate): Promise<SignatureReport> {
  const { bytes } = ctx;
  const sig = candidate.sig;
  const checks: SignatureCheck[] = [];
  const weakReasons: string[] = [];
  const claimedTime = isoOrUndefined(sig.m);
  let signerFacts: SignerFacts | undefined;
  let chain: SignerFacts[] = [];
  let digestAlgorithm: string | undefined = undefined;
  let signatureAlgorithm: string | undefined;
  let signedAttributes: string[] = [];
  let changes: RevisionChange[] = [];
  let revision: number | undefined;
  let coversWholeFile = false;

  const report = (status: SignatureStatus): SignatureReport => ({
    fieldName: candidate.fieldName,
    ...(candidate.pageIndex === undefined ? {} : { pageIndex: candidate.pageIndex }),
    ...(candidate.rect === undefined ? {} : { rect: candidate.rect }),
    ...(sig.filter === undefined ? {} : { filter: sig.filter }),
    subFilter: sig.subFilter,
    byteRange: sig.byteRange,
    ...(revision === undefined ? {} : { revision }),
    revisionCount: ctx.ends.length,
    coversWholeFile,
    status,
    honesty: SIGNATURE_HONESTY_LINE,
    checks,
    laterChanges: changes,
    ...(signerFacts ? { signer: signerFacts } : {}),
    chain,
    ...(claimedTime === undefined ? {} : { claimedTime }),
    ...(sig.reason === undefined ? {} : { reason: sig.reason }),
    ...(sig.location === undefined ? {} : { location: sig.location }),
    ...(sig.contactInfo === undefined ? {} : { contactInfo: sig.contactInfo }),
    ...(sig.name === undefined ? {} : { signerName: sig.name }),
    ...(digestAlgorithm === undefined ? {} : { digestAlgorithm }),
    ...(signatureAlgorithm === undefined ? {} : { signatureAlgorithm }),
    signedAttributes,
    weak: weakReasons.length > 0,
    weakReasons,
    ...(sig.docMdp === undefined ? {} : { docMdpPermissions: sig.docMdp }),
  });

  // 1. Byte range: [0 b c d], the gap exactly the hex string, inside the file, at a revision end.
  const range = sig.byteRange;
  const [a = -1, b = -1, c = -1, d = -1] = range;
  const wellFormed =
    range.length === 4 &&
    range.every((n) => Number.isInteger(n)) &&
    a === 0 &&
    b > 0 &&
    c > b + 1 &&
    d >= 0 &&
    c + d <= bytes.length;
  const gap = wellFormed ? ctx.text.slice(b, c) : '';
  const hexGap = /^<[0-9A-Fa-f]*>$/.test(gap);
  const end = c + d;
  // Only end-of-line or other whitespace after the range (e.g. the EOL after %%EOF): whole file.
  coversWholeFile = wellFormed && /^[\t\n\f\r \0]*$/.test(ctx.text.slice(end));
  const atRevision = wellFormed ? revisionEndingAt(ctx.ends, end) : undefined;
  if (atRevision) revision = atRevision.revision;
  else if (coversWholeFile) revision = ctx.ends.length || undefined;
  const padded = hexGap ? fromHex(gap.slice(1, -1)) : new Uint8Array();
  const gapIsThisContents = sig.contents === undefined || equalBytes(sig.contents, padded);
  if (!wellFormed || !hexGap || !gapIsThisContents || (!coversWholeFile && !atRevision)) {
    checks.push({
      id: 'byte-range',
      outcome: 'fail',
      detail: !wellFormed
        ? `The byte range [${range.join(' ')}] is malformed or outside the file.`
        : !hexGap
          ? 'The gap in the byte range is not exactly the /Contents hex string.'
          : !gapIsThisContents
            ? 'The gap in the byte range is not this signature’s /Contents.'
            : `The byte range ends at ${end}, which is not the end of a revision.`,
    });
    return report('broken');
  }
  checks.push({
    id: 'byte-range',
    outcome: 'pass',
    detail: coversWholeFile
      ? 'Covers the whole file except the signature value.'
      : `Covers revision ${revision ?? '?'} of ${ctx.ends.length} (bytes 0–${end}) except the signature value.`,
  });

  // 2. The CMS.
  const subFilterSupported = SUPPORTED_SUBFILTERS.has(sig.subFilter);
  let signedData: pkijs.SignedData;
  try {
    const der = padded.subarray(0, derLength(padded) ?? padded.length);
    const asn = asn1js.fromBER(der.slice().buffer);
    if (asn.offset === -1) throw new Error(asn.result.error);
    const info = new pkijs.ContentInfo({ schema: asn.result });
    if (info.contentType !== OID.signedData) throw new Error(`content type ${info.contentType}`);
    signedData = new pkijs.SignedData({ schema: info.content });
  } catch (error) {
    checks.push({
      id: 'digest',
      outcome: 'unsupported',
      detail: subFilterSupported
        ? `The CMS cannot be read (${error instanceof Error ? error.message : String(error)}).`
        : `SubFilter ${sig.subFilter || '(none)'} is not supported.`,
    });
    return report('cannot-check');
  }
  const certs = certificatesOf(signedData);
  const signer = signedData.signerInfos[0];
  if (!signer) {
    checks.push({ id: 'digest', outcome: 'unsupported', detail: 'The CMS names no signer.' });
    return report('cannot-check');
  }
  signedAttributes = (signer.signedAttrs?.attributes ?? []).map(
    (x) => ATTRIBUTE_NAMES[x.type] ?? x.type,
  );
  const leaf = findLeaf(signer, certs);
  // Facts about the signer; appended after the integrity checks, never change the status.
  let deferredChecks: SignatureCheck[] = [];
  if (leaf) {
    signerFacts = await certificateFacts(leaf);
    const built = await buildChain(leaf, certs);
    chain = await Promise.all(built.path.map(certificateFacts));
    const embeddedTst = signer.unsignedAttrs?.attributes.some((x) => x.type === OID.timeStampToken);
    deferredChecks = [
      built.check,
      validityCheck(leaf, parsePdfDate(sig.m)),
      keyUsageCheck(leaf),
      {
        id: 'timestamp',
        outcome: 'not-checked',
        detail: embeddedTst
          ? 'A timestamp token is embedded; it is not evaluated, and the timestamp authority is not trusted.'
          : 'No timestamp: the signing time is only claimed by the signer.',
      },
    ];
  }

  const digestOid = signer.digestAlgorithm.algorithmId;
  const digestHash = DIGESTS[digestOid];
  const broken = BROKEN_DIGESTS[digestOid];
  const unsupported: string[] = [];
  if (!subFilterSupported)
    unsupported.push(`SubFilter ${sig.subFilter || '(none)'} is not supported.`);
  if (!digestHash) {
    checks.push({
      id: 'digest',
      outcome: 'unsupported',
      detail: broken
        ? `${broken} digests cannot be checked.`
        : `Digest algorithm ${digestOid} is not supported.`,
    });
    checks.push(...deferredChecks);
    return report('cannot-check');
  }
  digestAlgorithm = digestHash;
  if (digestHash === 'SHA-1') weakReasons.push('The document digest is SHA-1, which is weak.');

  // 3. Digest of the byte ranges.
  const ranges = signedBytes(bytes, range);
  const messageDigestAttr = signer.signedAttrs?.attributes.find(
    (x) => x.type === OID.messageDigest,
  );
  const messageDigest =
    messageDigestAttr?.values[0] instanceof asn1js.OctetString
      ? octets(messageDigestAttr.values[0])
      : undefined;
  let digestOk: boolean | undefined;
  let signedContent: Uint8Array;
  const eContent = signedData.encapContentInfo.eContent;
  if (sig.subFilter === 'adbe.pkcs7.sha1') {
    const inner = eContent ? octets(eContent) : undefined;
    const sha1 = await digest('SHA-1', ranges);
    const innerOk = inner !== undefined && equalBytes(inner, sha1);
    if (!weakReasons.some((r) => r.includes('SHA-1')))
      weakReasons.push('adbe.pkcs7.sha1 digests the document with SHA-1, which is weak.');
    let outerOk = true;
    if (signer.signedAttrs && inner) {
      outerOk =
        messageDigest !== undefined && equalBytes(messageDigest, await digest(digestHash, inner));
    }
    digestOk = innerOk && outerOk;
    signedContent = inner ?? new Uint8Array();
    checks.push({
      id: 'digest',
      outcome: digestOk ? 'pass' : 'fail',
      detail: `SHA-1 of the byte ranges ${innerOk ? 'matches' : 'does not match'} the signed content${signer.signedAttrs ? `; messageDigest ${outerOk ? 'matches' : 'does not match'} it` : ''}.`,
    });
  } else {
    signedContent = ranges;
    if (eContent && octets(eContent).length > 0) {
      // A detached signature must not carry content; a non-detached one signs that content.
      checks.push({
        id: 'digest',
        outcome: 'fail',
        detail: 'The CMS is not detached: it signs content of its own, not the document.',
      });
      digestOk = false;
    } else if (signer.signedAttrs) {
      const actual = await digest(digestHash, ranges);
      digestOk = messageDigest !== undefined && equalBytes(messageDigest, actual);
      checks.push({
        id: 'digest',
        outcome: digestOk ? 'pass' : 'fail',
        detail: `${digestHash} of the byte ranges ${digestOk ? 'matches' : 'does not match'} messageDigest.`,
      });
    } else {
      checks.push({
        id: 'digest',
        outcome: 'not-checked',
        detail: 'No signed attributes: the signature covers the byte ranges directly.',
      });
    }
  }

  // 4. Signature over the signed attributes (or the content), and the signing certificate.
  let sigOk: boolean | undefined;
  let sigUnsupported: boolean;
  let certMismatch = false;
  if (!leaf) {
    checks.push({
      id: 'signature',
      outcome: 'unsupported',
      detail: 'The signer certificate is not in the CMS.',
    });
    sigUnsupported = true;
  } else {
    const data = signer.signedAttrs
      ? new Uint8Array(signer.signedAttrs.encodedValue)
      : signedContent;
    const outcome = await verifySignature(signer, leaf, data, digestHash, weakReasons);
    checks.push(outcome.check);
    if (outcome.algorithm) signatureAlgorithm = outcome.algorithm;
    sigOk = outcome.check.outcome === 'pass';
    sigUnsupported = outcome.check.outcome === 'unsupported';
    if (!signer.signedAttrs && outcome.check.outcome === 'fail') {
      // Without signed attributes a changed document shows up here.
      digestOk = false;
    }
    const certCheck = await signingCertificateCheck(signer, leaf, sig.subFilter);
    checks.push(certCheck);
    // An absent attribute is reported; a present one that names another certificate is Broken.
    certMismatch =
      certCheck.outcome === 'fail' &&
      (signer.signedAttrs?.attributes ?? []).some(
        (x) => x.type === OID.signingCertificateV2 || x.type === OID.signingCertificate,
      );
    checks.push(...deferredChecks);
  }
  if (digestOk === false || (sigOk === false && !sigUnsupported) || certMismatch)
    return report('broken');
  if (unsupported.length > 0 || sigUnsupported) {
    if (unsupported.length > 0)
      checks.push({ id: 'later-changes', outcome: 'not-checked', detail: unsupported.join(' ') });
    return report('cannot-check');
  }

  // 5. Later revisions.
  if (coversWholeFile) {
    checks.push({ id: 'later-changes', outcome: 'pass', detail: 'No later revisions.' });
    return report('intact');
  }
  const later = await laterChanges(ctx, end, sig.docMdp);
  checks.push(later.check);
  changes = later.changes;
  return report(later.allowed ? 'intact-changed-later' : 'changed-after-signing');
}

function safeEnumerate(doc: PDFDocument): [PDFRef, PDFObject][] {
  try {
    return doc.context.enumerateIndirectObjects();
  } catch {
    return [];
  }
}

/** Raw `/ByteRange` dictionaries (for signatures pdf-lib cannot reach or parse). */
function rawSignatures(
  text: string,
): { object?: number; generation?: number; sig: SignatureDictionary }[] {
  const out: { object?: number; generation?: number; sig: SignatureDictionary }[] = [];
  const re = /\/ByteRange\s*\[([^\]]*)\]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const parsed = (m[1] ?? '').trim().split(/\s+/).filter(Boolean).map(Number);
    // A damaged array is kept as malformed (Broken), never dropped.
    const numbers = parsed.some((n) => !Number.isInteger(n)) ? [] : parsed;
    // The nearest object header before /ByteRange, unless an `endobj` closes it first.
    const head = text.slice(Math.max(0, m.index - 64 * 1024), m.index);
    const header = /(?<!\d)(\d+)\s+(\d+)\s+obj\b/g;
    let obj: RegExpExecArray | null = null;
    for (let h = header.exec(head); h; h = header.exec(head)) obj = h;
    if (obj && head.includes('endobj', obj.index)) obj = null;
    const dictEnd = text.indexOf('endobj', m.index);
    const dict =
      (obj ? head.slice(obj.index) : '') +
      text.slice(m.index, dictEnd < 0 ? m.index + 4096 : dictEnd);
    const nameAfter = (key: string) =>
      new RegExp(`/${key}\\s*/([^\\s/<>\\[\\]()]+)`).exec(dict)?.[1];
    const m2 = /\/M\s*\(([^)]*)\)/.exec(dict)?.[1];
    const filter = nameAfter('Filter');
    out.push({
      ...(obj ? { object: Number(obj[1]), generation: Number(obj[2]) } : {}),
      sig: {
        ...(obj ? { object: Number(obj[1]) } : {}),
        ...(filter === undefined ? {} : { filter }),
        subFilter: nameAfter('SubFilter') ?? '',
        byteRange: numbers,
        ...(m2 === undefined ? {} : { m: m2 }),
      },
    });
  }
  return out;
}

function candidates(doc: PDFDocument | undefined, decrypted: boolean, text: string): Candidate[] {
  const out: Candidate[] = [];
  const knownObjects = new Set<number>();
  const knownRanges = new Set<string>();
  const remember = (sig: SignatureDictionary) => {
    if (sig.object !== undefined) knownObjects.add(sig.object);
    knownRanges.add(sig.byteRange.join(' '));
  };
  const currentSigObjects = new Map<number, string>();
  if (doc) {
    let fields: SignatureFieldInfo[] = [];
    try {
      fields = readSignatureFields(doc, decrypted);
    } catch {
      // A damaged field tree: the object enumeration and the raw scan below still find them.
    }
    for (const field of fields) {
      if (!field.signed || !field.sig) continue;
      out.push({
        fieldName: field.name,
        ...(field.pageIndex === undefined ? {} : { pageIndex: field.pageIndex }),
        ...(field.rect === undefined ? {} : { rect: field.rect }),
        sig: field.sig,
      });
      remember(field.sig);
    }
    // Signature dictionaries no field reaches (damaged tree, removed field, ...).
    for (const [ref, obj] of safeEnumerate(doc)) {
      if (!(obj instanceof PDFDict)) continue;
      const type = obj.lookup(PDFName.of('Type'));
      const isSig =
        (type instanceof PDFName &&
          (type.decodeText() === 'Sig' || type.decodeText() === 'DocTimeStamp')) ||
        (obj.has(PDFName.of('ByteRange')) && obj.has(PDFName.of('Contents')));
      if (!isSig) continue;
      const sig = readSignatureDictionary(obj, ref, decrypted);
      currentSigObjects.set(ref.objectNumber, sig.byteRange.join(' '));
      if (knownObjects.has(ref.objectNumber)) continue;
      out.push({
        fieldName: `(signature dictionary ${ref.objectNumber} ${ref.generationNumber} R, in no field)`,
        sig,
      });
      remember(sig);
    }
  }
  for (const raw of rawSignatures(text)) {
    const key = raw.sig.byteRange.join(' ');
    // A field whose /V pdf-lib could not read: use what the raw bytes say.
    const unreadable = out.findIndex(
      (c) => c.sig.unreadable === true && raw.object !== undefined && c.sig.object === raw.object,
    );
    if (unreadable >= 0) {
      const found = out[unreadable] as Candidate;
      out[unreadable] = { ...found, sig: raw.sig };
      knownRanges.add(key);
      continue;
    }
    if (key !== '' && knownRanges.has(key)) continue;
    // An older version of an object pdf-lib reads as a signature dictionary: superseded.
    if (raw.object !== undefined && currentSigObjects.has(raw.object)) continue;
    out.push({
      fieldName:
        raw.object === undefined
          ? '(unreadable signature dictionary)'
          : `(signature dictionary ${raw.object} ${raw.generation ?? 0} R, unreadable)`,
      sig: raw.sig,
    });
    knownRanges.add(key);
  }
  return out;
}

/**
 * Validates every signature in `input` (not modified, not detached). Resolves to an empty list
 * for unsigned files; never rejects for damaged ones (a signature that cannot be read is
 * reported as Broken or Cannot check), only on abort.
 */
export async function validateSignatures(
  input: ArrayBuffer | Uint8Array,
  options: ValidateSignaturesOptions = {},
): Promise<SignatureReport[]> {
  throwIfAborted(options);
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const text = latin1(bytes);
  // A signature dictionary has /ByteRange, raw or inside an object stream.
  if (!SIGNATURE_TOKENS.some((t) => text.includes(t))) return [];
  let doc: PDFDocument | undefined;
  let decrypted = false;
  try {
    const loaded = await loadForSignatures(bytes, options.password);
    doc = loaded.doc;
    decrypted = loaded.decrypted;
  } catch {
    doc = undefined;
  }
  throwIfAborted(options);
  const found = candidates(doc, decrypted, text);
  if (found.length === 0) return [];
  const ctx: Context = {
    bytes,
    text,
    ends: revisionEnds(bytes),
    doc,
    password: options.password,
    before: new Map(),
  };
  const reports: SignatureReport[] = [];
  for (const candidate of found) {
    throwIfAborted(options);
    try {
      reports.push(await validateOne(ctx, candidate));
    } catch (error) {
      reports.push(unexpectedFailure(ctx, candidate, error));
    }
  }
  return reports;
}

function unexpectedFailure(ctx: Context, candidate: Candidate, error: unknown): SignatureReport {
  return {
    fieldName: candidate.fieldName,
    subFilter: candidate.sig.subFilter,
    byteRange: candidate.sig.byteRange,
    revisionCount: ctx.ends.length,
    coversWholeFile: false,
    status: 'cannot-check',
    honesty: SIGNATURE_HONESTY_LINE,
    checks: [
      {
        id: 'signature',
        outcome: 'unsupported',
        detail: `The signature could not be checked (${error instanceof Error ? error.message : String(error)}).`,
      },
    ],
    laterChanges: [],
    chain: [],
    signedAttributes: [],
    weak: false,
    weakReasons: [],
  };
}

/** The file as it was when revision `revision` (1-based) was saved: "View signed version". */
export function revisionBytes(input: ArrayBuffer | Uint8Array, revision: number): ArrayBuffer {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const ends = revisionEnds(bytes);
  const found = ends[revision - 1];
  if (!found) throw new EngineError('internal', `The file has no revision ${revision}`);
  return bytes.slice(0, found.end).buffer;
}
