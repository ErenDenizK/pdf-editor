/**
 * PKCS#12 (.p12/.pfx) → non-extractable WebCrypto signing key + certificate chain, with pkijs.
 * pkijs decrypts PBES2 (PBKDF2 + AES-CBC) only; legacy PKCS#12 PBE (3DES, RC2) is refused
 * with `code: 'legacy-encryption'` and re-export instructions.
 */
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

const BAG_KEY = '1.2.840.113549.1.12.10.1.1';
const BAG_SHROUDED_KEY = '1.2.840.113549.1.12.10.1.2';
const BAG_CERT = '1.2.840.113549.1.12.10.1.3';
const CERT_X509 = '1.2.840.113549.1.9.22.1';
const PBES2 = '1.2.840.113549.1.5.13';
const DATA = '1.2.840.113549.1.7.1';
const ENCRYPTED_DATA = '1.2.840.113549.1.7.6';
const RSA = '1.2.840.113549.1.1.1';
const EC = '1.2.840.10045.2.1';
const CURVES: Record<string, 'P-256' | 'P-384' | 'P-521'> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
};
const LEGACY_PBE: Record<string, string> = {
  '1.2.840.113549.1.12.1.1': 'pbeWithSHAAnd128BitRC4',
  '1.2.840.113549.1.12.1.2': 'pbeWithSHAAnd40BitRC4',
  '1.2.840.113549.1.12.1.3': 'pbeWithSHAAnd3-KeyTripleDES-CBC',
  '1.2.840.113549.1.12.1.4': 'pbeWithSHAAnd2-KeyTripleDES-CBC',
  '1.2.840.113549.1.12.1.5': 'pbeWithSHAAnd128BitRC2-CBC',
  '1.2.840.113549.1.12.1.6': 'pbewithSHAAnd40BitRC2-CBC',
};

export type Pkcs12ErrorCode = 'malformed' | 'bad-password' | 'legacy-encryption' | 'no-key';

export class Pkcs12Error extends Error {
  constructor(
    readonly code: Pkcs12ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type KeyKind = 'RSA' | 'ECDSA P-256' | 'ECDSA P-384' | 'ECDSA P-521';

export interface SigningIdentity {
  readonly key: CryptoKey;
  /** Leaf first, then issuers as found in the file (not a verified path). */
  readonly chain: pkijs.Certificate[];
  readonly keyKind: KeyKind;
  /** Algorithms found in the file, for the report. */
  readonly protection: { mac: string; iterations: number; bags: string[] };
}

const REEXPORT =
  'Re-export it with AES-256, e.g. `openssl pkcs12 -export -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg SHA256`, or the Windows option "AES256-SHA256".';

function algorithmOf(encrypted: pkijs.EncryptedContentInfo | undefined): string {
  const oid = encrypted?.contentEncryptionAlgorithm.algorithmId ?? '';
  if (oid === PBES2) {
    const params = new pkijs.PBES2Params({
      schema: encrypted?.contentEncryptionAlgorithm.algorithmParams,
    });
    return `PBES2(${params.encryptionScheme.algorithmId})`;
  }
  return LEGACY_PBE[oid] ?? oid;
}

function refuseLegacy(oid: string): void {
  const legacy = LEGACY_PBE[oid];
  if (legacy) {
    throw new Pkcs12Error(
      'legacy-encryption',
      `This certificate file uses legacy encryption (${legacy}), which is not supported. ${REEXPORT}`,
    );
  }
}

export async function loadPkcs12(bytes: ArrayBuffer, password: string): Promise<SigningIdentity> {
  const asn = asn1js.fromBER(bytes);
  if (asn.offset === -1) throw new Pkcs12Error('malformed', 'Not a PKCS#12 file');
  let pfx: pkijs.PFX;
  try {
    pfx = new pkijs.PFX({ schema: asn.result });
  } catch {
    throw new Pkcs12Error('malformed', 'Not a PKCS#12 file');
  }
  const pwd = new TextEncoder().encode(password).buffer;
  try {
    await pfx.parseInternalValues({ password: pwd, checkIntegrity: true });
  } catch (error) {
    throw new Pkcs12Error('bad-password', `Wrong password or damaged file (${String(error)})`);
  }
  const safe = pfx.parsedValue?.authenticatedSafe;
  if (!safe) throw new Pkcs12Error('malformed', 'No authenticated safe');
  const bags: string[] = [];
  for (const info of safe.safeContents) {
    if (info.contentType === ENCRYPTED_DATA) {
      // pkijs rewrites implicit tags while parsing, so inspect a fresh copy of the schema.
      const copy = asn1js.fromBER((info.content as asn1js.Sequence).toBER()).result;
      const enc = new pkijs.EncryptedData({ schema: copy });
      refuseLegacy(enc.encryptedContentInfo.contentEncryptionAlgorithm.algorithmId);
      bags.push(`certs: ${algorithmOf(enc.encryptedContentInfo)}`);
    } else if (info.contentType === DATA) {
      bags.push('Data SafeContents');
    }
  }
  try {
    await safe.parseInternalValues({
      safeContents: safe.safeContents.map(() => ({ password: pwd })),
    });
  } catch (error) {
    throw new Pkcs12Error('bad-password', `Could not decrypt the certificates (${String(error)})`);
  }
  const certs: pkijs.Certificate[] = [];
  let keyInfo: pkijs.PrivateKeyInfo | undefined;
  // pkijs types `parsedValue` as any: after parseInternalValues it holds SafeContents values.
  const parsed = safe.parsedValue as { safeContents: { value: pkijs.SafeContents }[] } | undefined;
  for (const contents of parsed?.safeContents ?? []) {
    for (const bag of contents.value.safeBags) {
      if (bag.bagId === BAG_SHROUDED_KEY) {
        const shrouded = bag.bagValue as pkijs.PKCS8ShroudedKeyBag;
        const oid = shrouded.encryptionAlgorithm.algorithmId;
        refuseLegacy(oid);
        bags.push(
          `key: ${oid === PBES2 ? algorithmOf(new pkijs.EncryptedContentInfo({ contentEncryptionAlgorithm: shrouded.encryptionAlgorithm })) : oid}`,
        );
        // PKCS8ShroudedKeyBag.parseInternalValues is typed protected in pkijs 3.4.1; this is
        // exactly what it does, through public API.
        const encrypted = new pkijs.EncryptedData({
          encryptedContentInfo: new pkijs.EncryptedContentInfo({
            contentEncryptionAlgorithm: shrouded.encryptionAlgorithm,
            encryptedContent: shrouded.encryptedData,
          }),
        });
        try {
          keyInfo = pkijs.PrivateKeyInfo.fromBER(await encrypted.decrypt({ password: pwd }));
        } catch (error) {
          throw new Pkcs12Error('bad-password', `Could not decrypt the key (${String(error)})`);
        }
      } else if (bag.bagId === BAG_KEY) {
        bags.push('key: unencrypted KeyBag');
        keyInfo = bag.bagValue as pkijs.PrivateKeyInfo;
      } else if (bag.bagId === BAG_CERT) {
        const certBag = bag.bagValue as pkijs.CertBag;
        if (certBag.certId === CERT_X509) certs.push(certBag.parsedValue as pkijs.Certificate);
      }
    }
  }
  if (!keyInfo) throw new Pkcs12Error('no-key', 'The file contains no private key');

  const keyOid = keyInfo.privateKeyAlgorithm.algorithmId;
  let algorithm: RsaHashedImportParams | EcKeyImportParams;
  let keyKind: KeyKind;
  if (keyOid === RSA) {
    algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    keyKind = 'RSA';
  } else if (keyOid === EC) {
    const curveOid = (
      keyInfo.privateKeyAlgorithm.algorithmParams as asn1js.ObjectIdentifier
    ).valueBlock.toString();
    const curve = CURVES[curveOid];
    if (!curve) throw new Pkcs12Error('no-key', `Unsupported curve ${curveOid}`);
    algorithm = { name: 'ECDSA', namedCurve: curve };
    keyKind = `ECDSA ${curve}`;
  } else {
    throw new Pkcs12Error('no-key', `Unsupported key algorithm ${keyOid}`);
  }
  // Non-extractable: the key can sign, never leave WebCrypto.
  const key = await crypto.subtle.importKey('pkcs8', keyInfo.toSchema().toBER(), algorithm, false, [
    'sign',
  ]);
  const chain = await orderChain(certs, key, keyKind);
  return {
    key,
    chain,
    keyKind,
    protection: {
      mac: pfx.macData?.mac.digestAlgorithm.algorithmId ?? 'none',
      iterations: pfx.macData?.iterations ?? 0,
      bags,
    },
  };
}

/** Finds the certificate whose public key matches the private key, then its issuers. */
async function orderChain(
  certs: pkijs.Certificate[],
  key: CryptoKey,
  keyKind: KeyKind,
): Promise<pkijs.Certificate[]> {
  const probe = new TextEncoder().encode('pkcs12 key/certificate match');
  const params =
    keyKind === 'RSA' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' as const };
  const signature = await crypto.subtle.sign(params, key, probe);
  let leaf: pkijs.Certificate | undefined;
  for (const cert of certs) {
    const spki = cert.subjectPublicKeyInfo.toSchema().toBER();
    const importParams =
      keyKind === 'RSA'
        ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
        : { name: 'ECDSA', namedCurve: keyKind.slice(6) };
    try {
      const pub = await crypto.subtle.importKey('spki', spki, importParams, false, ['verify']);
      if (await crypto.subtle.verify(params, pub, signature, probe)) {
        leaf = cert;
        break;
      }
    } catch {
      // A certificate of another key type.
    }
  }
  if (!leaf) throw new Pkcs12Error('no-key', 'No certificate matches the private key');
  const chain = [leaf];
  const derName = (n: pkijs.RelativeDistinguishedNames): string =>
    Array.from(new Uint8Array(n.toSchema().toBER())).join(',');
  let current = leaf;
  while (chain.length < 10) {
    const issuerName = derName(current.issuer);
    if (issuerName === derName(current.subject)) break;
    const issuer = certs.find((c) => !chain.includes(c) && derName(c.subject) === issuerName);
    if (!issuer) break;
    chain.push(issuer);
    current = issuer;
  }
  return chain;
}
