/**
 * The CMS checks every signer needs (spec §3.1 steps 2–3): octet strings, WebCrypto digests,
 * the signature over the signed attributes with the signer certificate's key (RSASSA-PKCS1-v1_5,
 * RSA-PSS, ECDSA P-256/384/521), the signer certificate named by `sid`, and the
 * signing-certificate(-v2) attribute. Shared by signatures and timestamp tokens (timestamp.ts).
 */
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

import type { SignatureCheck } from '../types';
import { equalBytes } from './bytes';
import { nameDer, rsaBits } from './certificates';
import { CURVES, DIGESTS, type HashName, OID, SIGNATURE_ALGORITHMS } from './oids';

export function octets(value: asn1js.OctetString): Uint8Array {
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

export async function digest(hash: HashName, data: Uint8Array): Promise<Uint8Array> {
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

export interface SignatureOutcome {
  readonly check: SignatureCheck;
  readonly algorithm?: string;
}

export async function verifySignature(
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

export function findLeaf(
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

export async function signingCertificateCheck(
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
