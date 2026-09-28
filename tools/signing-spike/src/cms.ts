/**
 * CMS SignedData for PAdES-B (SubFilter ETSI.CAdES.detached, ETSI EN 319 142-1): detached
 * content, signed attributes contentType, messageDigest and signingCertificateV2 (RFC 5035),
 * no signingTime (the claimed time is the signature dictionary's /M), certificates = chain.
 */
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  sha256: '2.16.840.1.101.3.4.2.1',
} as const;

export async function sha256(data: BufferSource): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

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

/** ESSCertIDv2 with the default hash (SHA-256, so hashAlgorithm is omitted) and IssuerSerial. */
export async function signingCertificateV2(cert: pkijs.Certificate): Promise<asn1js.Sequence> {
  const certHash = await sha256(cert.toSchema().toBER());
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

export interface CmsOptions {
  /** Adds a signingTime signed attribute (not PAdES baseline; for comparison only). */
  readonly signingTime?: Date;
}

/** Returns the DER of a ContentInfo(SignedData) over `digest` (SHA-256 of the byte ranges). */
export async function buildCadesDetached(
  digest: Uint8Array,
  key: CryptoKey,
  chain: readonly pkijs.Certificate[],
  options: CmsOptions = {},
): Promise<Uint8Array> {
  const leaf = chain[0];
  if (!leaf) throw new Error('empty chain');
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
  if (options.signingTime) {
    attributes.push(
      new pkijs.Attribute({
        type: OID.signingTime,
        values: [new asn1js.UTCTime({ valueDate: options.signingTime })],
      }),
    );
  }
  // DER: SET OF sorted by encoding. OpenSSL re-encodes signedAttrs before verifying, so an
  // unsorted set would fail there even though the signature matches our own encoding.
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
