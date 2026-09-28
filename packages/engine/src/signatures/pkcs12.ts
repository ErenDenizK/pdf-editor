/**
 * PKCS#12 (.p12/.pfx) → a non-extractable WebCrypto signing key and its certificate chain,
 * with pkijs. pkijs decrypts PBES2 (PBKDF2 + AES-CBC) only; legacy PKCS#12 PBE (3DES, RC2,
 * RC4) is refused with re-export instructions (spec §3.2, decision 8.7.2). Lifted from spike
 * S2 (`src/p12.ts`).
 */
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

import { SigningError } from '../types';
import { CURVES, OID } from './oids';

const BAG_KEY = '1.2.840.113549.1.12.10.1.1';
const BAG_SHROUDED_KEY = '1.2.840.113549.1.12.10.1.2';
const BAG_CERT = '1.2.840.113549.1.12.10.1.3';
const CERT_X509 = '1.2.840.113549.1.9.22.1';
const LEGACY_PBE: Readonly<Record<string, string>> = {
  '1.2.840.113549.1.12.1.1': 'pbeWithSHAAnd128BitRC4',
  '1.2.840.113549.1.12.1.2': 'pbeWithSHAAnd40BitRC4',
  '1.2.840.113549.1.12.1.3': 'pbeWithSHAAnd3-KeyTripleDES-CBC',
  '1.2.840.113549.1.12.1.4': 'pbeWithSHAAnd2-KeyTripleDES-CBC',
  '1.2.840.113549.1.12.1.5': 'pbeWithSHAAnd128BitRC2-CBC',
  '1.2.840.113549.1.12.1.6': 'pbewithSHAAnd40BitRC2-CBC',
  '1.2.840.113549.1.5.3': 'pbeWithMD5AndDES-CBC',
  '1.2.840.113549.1.5.10': 'pbeWithSHA1AndDES-CBC',
};

/** The re-export command named in the legacy refusal. */
export const PKCS12_REEXPORT_COMMAND =
  'openssl pkcs12 -legacy -in old.p12 -nodes | openssl pkcs12 -export -keypbe AES-256-CBC -certpbe AES-256-CBC -macalg SHA256 -out new.p12';

export type SigningKeyKind = 'RSA' | 'ECDSA P-256' | 'ECDSA P-384' | 'ECDSA P-521';

export interface SigningIdentity {
  /** Non-extractable, usage `sign` only. */
  readonly key: CryptoKey;
  /** Leaf first, then its issuers as found in the file (not a verified path). */
  readonly chain: readonly pkijs.Certificate[];
  readonly keyKind: SigningKeyKind;
}

function refuseLegacy(oid: string): void {
  const legacy = LEGACY_PBE[oid];
  if (legacy) {
    throw new SigningError(
      'legacy-pkcs12',
      `This certificate file uses legacy encryption (${legacy}), which cannot be opened here. Re-export it with AES-256, for example: ${PKCS12_REEXPORT_COMMAND} (on Windows, choose "AES256-SHA256" when exporting).`,
    );
  }
}

function malformed(cause?: unknown): SigningError {
  return new SigningError('malformed-pkcs12', 'This is not a readable PKCS#12 (.p12/.pfx) file.', {
    cause,
  });
}

function badPassword(cause?: unknown): SigningError {
  return new SigningError(
    'bad-password',
    'The password is wrong, or the certificate file is damaged.',
    { cause },
  );
}

export async function loadPkcs12(bytes: ArrayBuffer, password: string): Promise<SigningIdentity> {
  const asn = asn1js.fromBER(bytes);
  if (asn.offset === -1) throw malformed();
  let pfx: pkijs.PFX;
  try {
    pfx = new pkijs.PFX({ schema: asn.result });
  } catch (error) {
    throw malformed(error);
  }
  const pwd = new TextEncoder().encode(password).buffer;
  try {
    await pfx.parseInternalValues({ password: pwd, checkIntegrity: pfx.macData !== undefined });
  } catch (error) {
    throw badPassword(error);
  }
  const safe = pfx.parsedValue?.authenticatedSafe;
  if (!safe) throw malformed();
  for (const info of safe.safeContents) {
    if (info.contentType === OID.encryptedData) {
      // pkijs rewrites implicit tags while parsing, so inspect a fresh copy of the schema.
      const copy = asn1js.fromBER((info.content as asn1js.Sequence).toBER()).result;
      const enc = new pkijs.EncryptedData({ schema: copy });
      refuseLegacy(enc.encryptedContentInfo.contentEncryptionAlgorithm.algorithmId);
    }
  }
  try {
    await safe.parseInternalValues({
      safeContents: safe.safeContents.map(() => ({ password: pwd })),
    });
  } catch (error) {
    throw badPassword(error);
  }
  const certs: pkijs.Certificate[] = [];
  let keyInfo: pkijs.PrivateKeyInfo | undefined;
  // pkijs types `parsedValue` as any: after parseInternalValues it holds SafeContents values.
  const parsed = safe.parsedValue as { safeContents: { value: pkijs.SafeContents }[] } | undefined;
  for (const contents of parsed?.safeContents ?? []) {
    for (const bag of contents.value.safeBags) {
      if (bag.bagId === BAG_SHROUDED_KEY) {
        const shrouded = bag.bagValue as pkijs.PKCS8ShroudedKeyBag;
        refuseLegacy(shrouded.encryptionAlgorithm.algorithmId);
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
          throw badPassword(error);
        }
      } else if (bag.bagId === BAG_KEY) {
        keyInfo = bag.bagValue as pkijs.PrivateKeyInfo;
      } else if (bag.bagId === BAG_CERT) {
        const certBag = bag.bagValue as pkijs.CertBag;
        if (certBag.certId === CERT_X509 && certBag.parsedValue instanceof pkijs.Certificate) {
          certs.push(certBag.parsedValue);
        }
      }
    }
  }
  if (!keyInfo) throw new SigningError('no-key', 'The certificate file contains no private key.');

  const keyOid = keyInfo.privateKeyAlgorithm.algorithmId;
  let algorithm: RsaHashedImportParams | EcKeyImportParams;
  let keyKind: SigningKeyKind;
  if (keyOid === OID.rsaEncryption) {
    algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    keyKind = 'RSA';
  } else if (keyOid === OID.ecPublicKey) {
    const params = keyInfo.privateKeyAlgorithm.algorithmParams as unknown;
    const curveOid = params instanceof asn1js.ObjectIdentifier ? params.valueBlock.toString() : '';
    const curve = CURVES[curveOid];
    if (!curve) {
      throw new SigningError('unsupported-key', `The key's curve (${curveOid}) is not supported.`);
    }
    algorithm = { name: 'ECDSA', namedCurve: curve };
    keyKind = `ECDSA ${curve}`;
  } else {
    throw new SigningError('unsupported-key', `The key type (${keyOid}) is not supported.`);
  }
  let key: CryptoKey;
  try {
    // Non-extractable: the key can sign, never leave WebCrypto.
    key = await crypto.subtle.importKey('pkcs8', keyInfo.toSchema().toBER(), algorithm, false, [
      'sign',
    ]);
  } catch (error) {
    throw new SigningError('unsupported-key', 'The private key could not be imported.', {
      cause: error,
    });
  }
  return { key, chain: await orderChain(certs, key, keyKind), keyKind };
}

function nameKey(n: pkijs.RelativeDistinguishedNames): string {
  return Array.from(new Uint8Array(n.toSchema().toBER())).join(',');
}

/** Finds the certificate whose public key matches the private key, then its issuers. */
async function orderChain(
  certs: readonly pkijs.Certificate[],
  key: CryptoKey,
  keyKind: SigningKeyKind,
): Promise<pkijs.Certificate[]> {
  const probe = new TextEncoder().encode('pkcs12 key/certificate match');
  const params =
    keyKind === 'RSA' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' };
  const signature = await crypto.subtle.sign(params, key, probe);
  const importParams =
    keyKind === 'RSA'
      ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
      : { name: 'ECDSA', namedCurve: keyKind.slice(6) };
  let leaf: pkijs.Certificate | undefined;
  for (const cert of certs) {
    try {
      const spki = cert.subjectPublicKeyInfo.toSchema().toBER();
      const pub = await crypto.subtle.importKey('spki', spki, importParams, false, ['verify']);
      if (await crypto.subtle.verify(params, pub, signature, probe)) {
        leaf = cert;
        break;
      }
    } catch {
      // A certificate for another key type.
    }
  }
  if (!leaf) {
    throw new SigningError('no-key', 'No certificate in the file matches its private key.');
  }
  const chain = [leaf];
  let current = leaf;
  while (chain.length < 10) {
    const issuerName = nameKey(current.issuer);
    if (issuerName === nameKey(current.subject)) break;
    const issuer = certs.find((c) => !chain.includes(c) && nameKey(c.subject) === issuerName);
    if (!issuer) break;
    chain.push(issuer);
    current = issuer;
  }
  return chain;
}
