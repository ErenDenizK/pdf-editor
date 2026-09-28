/** Object identifiers the signature code reads or writes. */

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  encryptedData: '1.2.840.113549.1.7.6',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  timeStampToken: '1.2.840.113549.1.9.16.2.14',
  revocationInfoArchival: '1.2.840.113583.1.1.8',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
  md5: '1.2.840.113549.2.5',
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  ecPublicKey: '1.2.840.10045.2.1',
  keyUsage: '2.5.29.15',
  basicConstraints: '2.5.29.19',
  pbes2: '1.2.840.113549.1.5.13',
} as const;

export type HashName = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

export const DIGESTS: Readonly<Record<string, HashName>> = {
  [OID.sha1]: 'SHA-1',
  [OID.sha256]: 'SHA-256',
  [OID.sha384]: 'SHA-384',
  [OID.sha512]: 'SHA-512',
};

/** Digests we refuse to evaluate at all (Cannot check). */
export const BROKEN_DIGESTS: Readonly<Record<string, string>> = {
  [OID.md5]: 'MD5',
  '1.2.840.113549.2.2': 'MD2',
};

export type CurveName = 'P-256' | 'P-384' | 'P-521';

export const CURVES: Readonly<Record<string, CurveName>> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
};

/** Signature algorithm OIDs → the key family and the hash they imply (undefined: see digest). */
export const SIGNATURE_ALGORITHMS: Readonly<
  Record<string, { readonly family: 'RSA' | 'RSA-PSS' | 'ECDSA'; readonly hash?: HashName | 'MD5' }>
> = {
  [OID.rsaEncryption]: { family: 'RSA' },
  '1.2.840.113549.1.1.4': { family: 'RSA', hash: 'MD5' },
  '1.2.840.113549.1.1.5': { family: 'RSA', hash: 'SHA-1' },
  '1.2.840.113549.1.1.11': { family: 'RSA', hash: 'SHA-256' },
  '1.2.840.113549.1.1.12': { family: 'RSA', hash: 'SHA-384' },
  '1.2.840.113549.1.1.13': { family: 'RSA', hash: 'SHA-512' },
  [OID.rsaPss]: { family: 'RSA-PSS' },
  [OID.ecPublicKey]: { family: 'ECDSA' },
  '1.2.840.10045.4.1': { family: 'ECDSA', hash: 'SHA-1' },
  '1.2.840.10045.4.3.2': { family: 'ECDSA', hash: 'SHA-256' },
  '1.2.840.10045.4.3.3': { family: 'ECDSA', hash: 'SHA-384' },
  '1.2.840.10045.4.3.4': { family: 'ECDSA', hash: 'SHA-512' },
};

export const ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
  [OID.contentType]: 'contentType',
  [OID.messageDigest]: 'messageDigest',
  [OID.signingTime]: 'signingTime',
  [OID.signingCertificate]: 'signingCertificate',
  [OID.signingCertificateV2]: 'signingCertificateV2',
  [OID.revocationInfoArchival]: 'adbe-revocationInfoArchival',
  '1.2.840.113549.1.9.52': 'cmsAlgorithmProtection',
  '1.2.840.113549.1.9.16.2.15': 'signaturePolicyIdentifier',
};

/** RFC 4514 short names. */
export const NAME_ATTRIBUTES: Readonly<Record<string, string>> = {
  '2.5.4.3': 'CN',
  '2.5.4.4': 'SN',
  '2.5.4.5': 'SERIALNUMBER',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.9': 'STREET',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.12': 'T',
  '2.5.4.42': 'GN',
  '2.5.4.97': 'organizationIdentifier',
  '0.9.2342.19200300.100.1.1': 'UID',
  '0.9.2342.19200300.100.1.25': 'DC',
  '1.2.840.113549.1.9.1': 'emailAddress',
};

export const KEY_USAGE_BITS = [
  'digitalSignature',
  'nonRepudiation',
  'keyEncipherment',
  'dataEncipherment',
  'keyAgreement',
  'keyCertSign',
  'cRLSign',
  'encipherOnly',
  'decipherOnly',
] as const;
