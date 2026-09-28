/**
 * CMS SignedData for PAdES-B (SubFilter ETSI.CAdES.detached, ETSI EN 319 142-1): detached
 * content, signed attributes contentType, messageDigest and signingCertificateV2 (RFC 5035)
 * sorted as DER requires, no signingTime (the claimed time is the dictionary's /M), and the
 * chain as certificates. Lifted from spike S2 (`src/cms.ts`), which openssl, PDFium and pkijs
 * accepted.
 */
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

import { OID } from './oids';

function der(schema: asn1js.AsnType): Uint8Array {
  return new Uint8Array(schema.toBER());
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** SigningCertificateV2 with one ESSCertIDv2: SHA-256 (the default, so omitted) and IssuerSerial. */
export async function signingCertificateV2(cert: pkijs.Certificate): Promise<asn1js.Sequence> {
  const certHash = await crypto.subtle.digest('SHA-256', cert.toSchema().toBER());
  const issuerSerial = new pkijs.IssuerSerial({
    issuer: new pkijs.GeneralNames({
      names: [new pkijs.GeneralName({ type: 4, value: cert.issuer })],
    }),
    serialNumber: cert.serialNumber,
  });
  const essCertIdV2 = new asn1js.Sequence({
    value: [new asn1js.OctetString({ valueHex: certHash }), issuerSerial.toSchema()],
  });
  return new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertIdV2] })] });
}

/** The DER of a ContentInfo(SignedData) whose messageDigest is `digest` (SHA-256 of the ranges). */
export async function buildCadesDetached(
  digest: Uint8Array,
  key: CryptoKey,
  chain: readonly pkijs.Certificate[],
): Promise<Uint8Array> {
  const leaf = chain[0];
  if (!leaf) throw new Error('empty certificate chain');
  const attributes = [
    new pkijs.Attribute({
      type: OID.contentType,
      values: [new asn1js.ObjectIdentifier({ value: OID.data })],
    }),
    new pkijs.Attribute({
      type: OID.messageDigest,
      values: [new asn1js.OctetString({ valueHex: digest.slice().buffer })],
    }),
    new pkijs.Attribute({
      type: OID.signingCertificateV2,
      values: [await signingCertificateV2(leaf)],
    }),
  ];
  // DER: a SET OF is sorted by encoding. OpenSSL re-encodes signedAttrs before verifying, so
  // an unsorted set fails there even though the signature matches our own encoding.
  attributes.sort((a, b) => compareBytes(der(a.toSchema()), der(b.toSchema())));

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: leaf.issuer, serialNumber: leaf.serialNumber }),
    signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes }),
  });
  const signedData = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    signerInfos: [signerInfo],
    certificates: [...chain],
  });
  await signedData.sign(key, 0, 'SHA-256');
  const contentInfo = new pkijs.ContentInfo({
    contentType: OID.signedData,
    content: signedData.toSchema(true),
  });
  return der(contentInfo.toSchema());
}
