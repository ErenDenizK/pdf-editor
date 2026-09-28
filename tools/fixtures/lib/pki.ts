/**
 * Test PKI and CMS signatures for the signed fixtures (M5). Independent of the
 * product's signer: certificates and CMS SignedData are assembled here with
 * lib/der.ts and signed by Node's crypto with RSASSA-PKCS1-v1_5, which is
 * deterministic, so the same committed keys (tools/fixtures/keys/, test-only)
 * always give byte-identical certificates and signatures. Nothing here is
 * secret or trusted.
 */
import {
  type KeyObject,
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_DIR } from './common.ts';
import {
  TAG,
  type Tlv,
  bits,
  bool,
  child,
  children,
  compareBytes,
  ctx,
  ctxPrim,
  int,
  nul,
  octets,
  oid,
  readOid,
  readTlv,
  seq,
  setOf,
  tlv,
  utcTime,
  utf8,
} from './der.ts';

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha1WithRSA: '1.2.840.113549.1.1.5',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  basicConstraints: '2.5.29.19',
  authorityKeyIdentifier: '2.5.29.35',
} as const;

export const KEYS_DIR = join(TOOL_DIR, 'keys');
export const PKI_ORG = 'pdf-editor test PKI (not trusted)';
const NOT_BEFORE = new Date('2023-01-01T00:00:00Z');

export type PartyId = 'root-ca' | 'intermediate-ca' | 'signer-rsa' | 'signer-p256';

interface PartySpec {
  id: PartyId;
  commonName: string;
  serial: number;
  notAfter: Date;
  issuer: PartyId | null;
  kind: 'root' | 'intermediate' | 'signer';
}

const PARTIES: readonly PartySpec[] = [
  {
    id: 'root-ca',
    commonName: 'pdf-editor Test Root CA',
    serial: 0x1001,
    notAfter: new Date('2045-01-01T00:00:00Z'),
    issuer: null,
    kind: 'root',
  },
  {
    id: 'intermediate-ca',
    commonName: 'pdf-editor Test Intermediate CA',
    serial: 0x2001,
    notAfter: new Date('2040-01-01T00:00:00Z'),
    issuer: 'root-ca',
    kind: 'intermediate',
  },
  {
    id: 'signer-rsa',
    commonName: 'pdf-editor Test Signer',
    serial: 0x3001,
    notAfter: new Date('2036-01-01T00:00:00Z'),
    issuer: 'intermediate-ca',
    kind: 'signer',
  },
  {
    // ECDSA P-256 key; its certificate is still RSA-signed by the intermediate
    // (deterministic). ECDSA signatures are not, so no fixture is signed with it:
    // it exists for signing tests (test/fixtures/pki/signer-p256.p12).
    id: 'signer-p256',
    commonName: 'pdf-editor Test Signer P-256',
    serial: 0x3002,
    notAfter: new Date('2036-01-01T00:00:00Z'),
    issuer: 'intermediate-ca',
    kind: 'signer',
  },
];

export interface Party {
  id: PartyId;
  commonName: string;
  /** RFC 4514 string (most specific RDN first). */
  subject: string;
  issuer: string;
  /** Serial number, lowercase hex without leading zeros. */
  serial: string;
  notBefore: string;
  notAfter: string;
  key: KeyObject;
  /** DER Name of the subject. */
  name: Uint8Array;
  issuerName: Uint8Array;
  serialDer: Uint8Array;
  cert: Uint8Array;
}

function dn(commonName: string): Uint8Array {
  const rdn = (type: string, value: string) => setOf(seq(oid(type), utf8(value)));
  return seq(rdn(OID.organization, PKI_ORG), rdn(OID.commonName, commonName));
}

function rfc4514(commonName: string): string {
  return `CN=${commonName},O=${PKI_ORG}`;
}

const algId = (id: string, params = true) => (params ? seq(oid(id), nul()) : seq(oid(id)));

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}

function keyIdentifier(spki: Uint8Array): Uint8Array {
  const publicKey = child(readTlv(spki), 1).content.subarray(1); // BIT STRING minus unused-bits byte
  return new Uint8Array(createHash('sha1').update(publicKey).digest());
}

function buildParties(): Map<PartyId, Party> {
  const parties = new Map<PartyId, Party>();
  for (const spec of PARTIES) {
    const key = createPrivateKey(readFileSync(join(KEYS_DIR, `${spec.id}.key.pem`)));
    const spki = new Uint8Array(createPublicKey(key).export({ type: 'spki', format: 'der' }));
    const issuer = spec.issuer ? parties.get(spec.issuer) : undefined;
    if (spec.issuer && !issuer) throw new Error(`${spec.id}: issuer ${spec.issuer} not built yet`);
    const name = dn(spec.commonName);
    const issuerName = issuer ? issuer.name : name;
    const signingKey = issuer ? issuer.key : key;
    const ski = keyIdentifier(spki);
    const extensions = [
      extension(
        OID.basicConstraints,
        true,
        spec.kind === 'signer'
          ? seq()
          : spec.kind === 'intermediate'
            ? seq(bool(true), int(0))
            : seq(bool(true)),
      ),
      extension(
        OID.keyUsage,
        true,
        spec.kind === 'signer'
          ? bits(Uint8Array.of(0xc0), 6) // digitalSignature, nonRepudiation
          : bits(Uint8Array.of(0x06), 1), // keyCertSign, cRLSign
      ),
      extension(OID.subjectKeyIdentifier, false, octets(ski)),
    ];
    if (issuer) {
      const issuerSpki = new Uint8Array(
        createPublicKey(issuer.key).export({ type: 'spki', format: 'der' }),
      );
      extensions.push(
        extension(OID.authorityKeyIdentifier, false, seq(ctxPrim(0, keyIdentifier(issuerSpki)))),
      );
    }
    const serialDer = int(spec.serial);
    const tbs = seq(
      ctx(0, int(2)),
      serialDer,
      algId(OID.sha256WithRSA),
      issuerName,
      seq(utcTime(NOT_BEFORE), utcTime(spec.notAfter)),
      name,
      spki,
      ctx(3, seq(...extensions)),
    );
    const signature = new Uint8Array(sign('sha256', tbs, signingKey));
    const cert = seq(tbs, algId(OID.sha256WithRSA), bits(signature));
    parties.set(spec.id, {
      id: spec.id,
      commonName: spec.commonName,
      subject: rfc4514(spec.commonName),
      issuer: rfc4514(issuer ? issuer.commonName : spec.commonName),
      serial: spec.serial.toString(16),
      notBefore: NOT_BEFORE.toISOString(),
      notAfter: spec.notAfter.toISOString(),
      key,
      name,
      issuerName,
      serialDer,
      cert,
    });
  }
  return parties;
}

let cache: Map<PartyId, Party> | undefined;

export function party(id: PartyId): Party {
  cache ??= buildParties();
  const found = cache.get(id);
  if (!found) throw new Error(`unknown party ${id}`);
  return found;
}

/** Signer, intermediate, root: the chain embedded in every CMS signature. */
export function chain(): Party[] {
  return [party('signer-rsa'), party('intermediate-ca'), party('root-ca')];
}

export function pem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

// ---------------------------------------------------------------------------
// CMS SignedData
// ---------------------------------------------------------------------------

export type CmsMode =
  /** /SubFilter /ETSI.CAdES.detached: SHA-256, signingCertificateV2, no signingTime. */
  | 'cades-detached'
  /** /SubFilter /adbe.pkcs7.sha1: the SHA-1 of the ranges encapsulated as id-data content. */
  | 'pkcs7-sha1';

const attribute = (type: string, value: Uint8Array) => seq(oid(type), setOf(value));

/** DER ContentInfo(SignedData) over `signed` (the concatenated /ByteRange bytes). */
export function buildCms(signed: Uint8Array, mode: CmsMode): Uint8Array {
  const [signer, ...rest] = chain();
  if (!signer) throw new Error('no signer');
  const hash = mode === 'pkcs7-sha1' ? 'sha1' : 'sha256';
  const digestOid = mode === 'pkcs7-sha1' ? OID.sha1 : OID.sha256;
  const rangeDigest = new Uint8Array(createHash(hash).update(signed).digest());
  // adbe.pkcs7.sha1 signs the digest as encapsulated content; CAdES is detached.
  const eContent = mode === 'pkcs7-sha1' ? rangeDigest : undefined;
  const messageDigest = eContent
    ? new Uint8Array(createHash(hash).update(eContent).digest())
    : rangeDigest;

  const attrs = [
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.messageDigest, octets(messageDigest)),
  ];
  if (mode === 'cades-detached') {
    const certHash = new Uint8Array(createHash('sha256').update(signer.cert).digest());
    const issuerSerial = seq(seq(ctx(4, signer.issuerName)), signer.serialDer);
    attrs.push(attribute(OID.signingCertificateV2, seq(seq(seq(octets(certHash), issuerSerial)))));
  }
  attrs.sort(compareBytes);
  const signedAttrs = tlv(TAG.set, ...attrs);
  const signature = new Uint8Array(sign(hash, signedAttrs, signer.key));

  const signerInfo = seq(
    int(1),
    seq(signer.issuerName, signer.serialDer),
    algId(digestOid, false),
    tlv(0xa0, ...attrs), // [0] IMPLICIT SET OF Attribute
    algId(OID.rsaEncryption),
    octets(signature),
  );
  const certs = [signer, ...rest].map((p) => p.cert).sort(compareBytes);
  const signedData = seq(
    int(1),
    setOf(algId(digestOid, false)),
    eContent ? seq(oid(OID.data), ctx(0, octets(eContent))) : seq(oid(OID.data)),
    tlv(0xa0, ...certs), // [0] IMPLICIT CertificateSet
    setOf(signerInfo),
  );
  return seq(oid(OID.signedData), ctx(0, signedData));
}

// ---------------------------------------------------------------------------
// Reading a CMS signature back (verify.ts)
// ---------------------------------------------------------------------------

export interface CmsCheck {
  digestAlgorithm: 'SHA-1' | 'SHA-256';
  signatureAlgorithm: string;
  /** Signed attribute types present, as OIDs. */
  signedAttributes: string[];
  /** messageDigest matches the digest of the signed bytes (or of the encapsulated digest). */
  digestMatches: boolean;
  /** For adbe.pkcs7.sha1: the encapsulated content equals the SHA-1 of the signed bytes. */
  encapsulatedDigestMatches?: boolean;
  /** RSA signature over the DER signed attributes verifies with the signer certificate. */
  signatureValid: boolean;
  /** signingCertificateV2 hash matches the signer certificate. */
  signingCertificateMatches?: boolean;
  signerSubject: string;
  certificates: number;
  /** Each certificate's signature verifies with the next one's key (signer to root). */
  chainValid: boolean;
}

const HASH_NAMES: Record<string, string> = { [OID.sha1]: 'sha1', [OID.sha256]: 'sha256' };

/** RFC 4514-style subject of a DER certificate (most specific RDN first). */
export function subjectOf(der: Uint8Array): string {
  return new X509Certificate(der).subject.split('\n').reverse().join(',');
}

function tbsParts(cert: Uint8Array): { issuer: Tlv; serial: Tlv } {
  const tbs = child(readTlv(cert), 0);
  const parts = children(tbs);
  const offset = parts[0]?.tag === 0xa0 ? 1 : 0;
  const serial = parts[offset];
  const issuer = parts[offset + 2];
  if (!serial || !issuer) throw new Error('certificate: TBSCertificate too short');
  return { serial, issuer };
}

export function checkCms(der: Uint8Array, signed: Uint8Array): CmsCheck {
  const contentInfo = readTlv(der);
  if (readOid(child(contentInfo, 0)) !== OID.signedData) throw new Error('not SignedData');
  const signedData = child(child(contentInfo, 1), 0);
  const parts = children(signedData);
  const encap = parts[2];
  const certSet = parts.find((p) => p.tag === 0xa0);
  const signerInfos = parts[parts.length - 1];
  if (!encap || !certSet || !signerInfos) throw new Error('SignedData incomplete');
  const certificates = children(certSet).map((c) => c.raw);
  const info = child(signerInfos, 0);
  const si = children(info);
  const [, sid, digestAlg, attrs, sigAlg, sig] = si;
  if (!sid || !digestAlg || attrs?.tag !== 0xa0 || !sigAlg || !sig) throw new Error('SignerInfo');
  const digestOid = readOid(child(digestAlg, 0));
  const hash = HASH_NAMES[digestOid];
  if (!hash) throw new Error(`unsupported digest ${digestOid}`);

  const attrList = children(attrs).map((a) => ({
    type: readOid(child(a, 0)),
    value: child(child(a, 1), 0),
  }));
  const attr = (type: string) => attrList.find((a) => a.type === type)?.value;
  const md = attr(OID.messageDigest)?.content;
  const eContentWrapper = children(encap)[1];
  const eContent = eContentWrapper ? child(eContentWrapper, 0).content : undefined;
  const rangeDigest = new Uint8Array(createHash(hash).update(signed).digest());
  const digested = eContent
    ? new Uint8Array(createHash(hash).update(eContent).digest())
    : rangeDigest;

  const [issuer, serial] = children(sid);
  const signerCert = certificates.find((c) => {
    const parts = tbsParts(c);
    return (
      !!issuer &&
      !!serial &&
      compareBytes(parts.issuer.raw, issuer.raw) === 0 &&
      compareBytes(parts.serial.raw, serial.raw) === 0
    );
  });
  if (!signerCert) throw new Error('signer certificate not in the CMS');
  const signedAttrs = tlv(TAG.set, attrs.content);
  const signatureValid = verify(
    hash,
    signedAttrs,
    new X509Certificate(signerCert).publicKey,
    sig.content,
  );

  let signingCertificateMatches: boolean | undefined;
  const scv2 = attr(OID.signingCertificateV2);
  if (scv2) {
    const certHash = child(child(child(scv2, 0), 0), 0).content;
    const actual = createHash('sha256').update(signerCert).digest();
    signingCertificateMatches = compareBytes(certHash, actual) === 0;
  }

  // Chain: signer -> ... -> self-signed root, each verified with its issuer's key.
  const x509 = certificates.map((c) => new X509Certificate(c));
  let current = new X509Certificate(signerCert);
  let chainValid = true;
  for (let hops = x509.length; hops > 0; hops--) {
    const issuerCert = x509.find((c) => c.subject === current.issuer);
    if (!issuerCert || !current.verify(issuerCert.publicKey)) {
      chainValid = false;
      break;
    }
    if (issuerCert.subject === issuerCert.issuer) break;
    current = issuerCert;
  }

  const result: CmsCheck = {
    digestAlgorithm: digestOid === OID.sha1 ? 'SHA-1' : 'SHA-256',
    signatureAlgorithm: readOid(child(sigAlg, 0)),
    signedAttributes: attrList.map((a) => a.type),
    digestMatches: !!md && compareBytes(md, digested) === 0,
    signatureValid,
    signerSubject: subjectOf(signerCert),
    certificates: certificates.length,
    chainValid,
  };
  if (eContent) result.encapsulatedDigestMatches = compareBytes(eContent, rangeDigest) === 0;
  if (signingCertificateMatches !== undefined)
    result.signingCertificateMatches = signingCertificateMatches;
  return result;
}
