/**
 * Certificates as facts: RFC 4514 names, validity, key and signature algorithms, key usage,
 * and a chain built only from certificates embedded in the file (no trust store, nothing
 * fetched). Nothing here changes a signature's status (ADR-0013 §4).
 */
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

import type { SignatureCheck, SignerFacts } from '../types';
import { equalBytes, toHex } from './bytes';
import {
  CURVES,
  DIGESTS,
  KEY_USAGE_BITS,
  NAME_ATTRIBUTES,
  OID,
  SIGNATURE_ALGORITHMS,
} from './oids';

export function nameDer(name: pkijs.RelativeDistinguishedNames): Uint8Array {
  return new Uint8Array(name.toSchema().toBER());
}

export function sameName(
  a: pkijs.RelativeDistinguishedNames,
  b: pkijs.RelativeDistinguishedNames,
): boolean {
  return equalBytes(nameDer(a), nameDer(b));
}

function attributeText(value: unknown): string {
  const block = (value as { valueBlock?: { value?: unknown } } | undefined)?.valueBlock;
  if (typeof block?.value === 'string') return block.value;
  if (value instanceof asn1js.BaseBlock) return `#${toHex(new Uint8Array(value.toBER()))}`;
  return '';
}

function escapeRdnValue(value: string): string {
  let out = value.replace(/[\\,+"<>;=]/g, (c) => `\\${c}`);
  if (out.startsWith('#') || out.startsWith(' ')) out = `\\${out}`;
  if (out.endsWith(' ') && out.length > 0) out = `${out.slice(0, -1)}\\ `;
  return out;
}

/** RFC 4514: the RDN sequence in reverse, `,` between RDNs, `+` inside a multi-valued RDN. */
export function formatName(name: pkijs.RelativeDistinguishedNames): string {
  // pkijs flattens every RDN SET into `typesAndValues`; read the SETs to keep multi-valued RDNs.
  const rdns: string[][] = [];
  // toSchema() re-reads the original encoding when the name was parsed from DER.
  const sets = name.toSchema().valueBlock.value;
  for (const set of sets) {
    const parts: string[] = [];
    for (const item of (set as asn1js.Set).valueBlock.value) {
      const tv = new pkijs.AttributeTypeAndValue({ schema: item });
      parts.push(
        `${NAME_ATTRIBUTES[tv.type] ?? tv.type}=${escapeRdnValue(attributeText(tv.value))}`,
      );
    }
    rdns.push(parts);
  }
  return rdns
    .reverse()
    .map((parts) => parts.join('+'))
    .join(',');
}

export function commonName(name: pkijs.RelativeDistinguishedNames): string | undefined {
  const cn = name.typesAndValues.filter((tv) => tv.type === '2.5.4.3').pop();
  return cn ? attributeText(cn.value) : undefined;
}

function integerHex(value: asn1js.Integer): string {
  let bytes = value.valueBlock.valueHexView;
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
  return toHex(bytes).toUpperCase();
}

/** `RSA 2048`, `ECDSA P-256`, … */
export function publicKeyName(cert: pkijs.Certificate): string {
  const spki = cert.subjectPublicKeyInfo;
  const oid = spki.algorithm.algorithmId;
  if (oid === OID.rsaEncryption || oid === OID.rsaPss) {
    const bits = rsaBits(cert);
    return `${oid === OID.rsaPss ? 'RSA-PSS' : 'RSA'}${bits ? ` ${bits}` : ''}`;
  }
  if (oid === OID.ecPublicKey) {
    const params = spki.algorithm.algorithmParams as unknown;
    const curveOid =
      params instanceof asn1js.ObjectIdentifier ? params.valueBlock.toString() : 'unknown';
    return `ECDSA ${CURVES[curveOid] ?? curveOid}`;
  }
  if (oid === '1.3.101.112') return 'Ed25519';
  return oid;
}

export function rsaBits(cert: pkijs.Certificate): number | undefined {
  try {
    const key = cert.subjectPublicKeyInfo.parsedKey;
    if (!(key instanceof pkijs.RSAPublicKey)) return undefined;
    let modulus = key.modulus.valueBlock.valueHexView;
    while (modulus.length > 0 && modulus[0] === 0) modulus = modulus.subarray(1);
    const top = modulus[0] ?? 0;
    return (modulus.length - 1) * 8 + (top === 0 ? 0 : Math.floor(Math.log2(top)) + 1);
  } catch {
    return undefined;
  }
}

/** A signature algorithm identifier in words, e.g. `RSASSA-PKCS1-v1_5 with SHA-256`. */
export function signatureAlgorithmName(algorithm: pkijs.AlgorithmIdentifier): string {
  const known = SIGNATURE_ALGORITHMS[algorithm.algorithmId];
  if (!known) return algorithm.algorithmId;
  if (known.family === 'RSA-PSS') {
    try {
      const pss = new pkijs.RSASSAPSSParams({ schema: algorithm.algorithmParams });
      return `RSA-PSS with ${DIGESTS[pss.hashAlgorithm.algorithmId] ?? pss.hashAlgorithm.algorithmId}`;
    } catch {
      return 'RSA-PSS';
    }
  }
  const family = known.family === 'RSA' ? 'RSASSA-PKCS1-v1_5' : 'ECDSA';
  return known.hash ? `${family} with ${known.hash}` : family;
}

function keyUsage(cert: pkijs.Certificate): string[] | undefined {
  const ext = cert.extensions?.find((e) => e.extnID === OID.keyUsage);
  if (!ext) return undefined;
  const bits = ext.parsedValue instanceof asn1js.BitString ? ext.parsedValue : undefined;
  if (!bits) return [];
  const view = bits.valueBlock.valueHexView;
  const names: string[] = [];
  KEY_USAGE_BITS.forEach((name, i) => {
    const byte = view[i >> 3] ?? 0;
    if (byte & (0x80 >> (i & 7))) names.push(name);
  });
  return names;
}

export async function certificateFacts(cert: pkijs.Certificate): Promise<SignerFacts> {
  const der = cert.toSchema().toBER();
  const fingerprint = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
  const cn = commonName(cert.subject);
  const usage = keyUsage(cert);
  return {
    subject: formatName(cert.subject),
    issuer: formatName(cert.issuer),
    ...(cn === undefined ? {} : { commonName: cn }),
    serialNumber: integerHex(cert.serialNumber),
    notBefore: cert.notBefore.value.toISOString(),
    notAfter: cert.notAfter.value.toISOString(),
    publicKey: publicKeyName(cert),
    signatureAlgorithm: signatureAlgorithmName(cert.signatureAlgorithm),
    selfSigned: sameName(cert.subject, cert.issuer),
    ...(usage === undefined ? {} : { keyUsage: usage }),
    sha256: toHex(fingerprint),
  };
}

/**
 * Builds the path from `leaf` through the embedded certificates. Each link's signature is
 * verified; the best outcome is "complete to a root included in the file" (never trusted).
 */
export async function buildChain(
  leaf: pkijs.Certificate,
  pool: readonly pkijs.Certificate[],
): Promise<{ readonly path: pkijs.Certificate[]; readonly check: SignatureCheck }> {
  const path = [leaf];
  let current = leaf;
  for (let i = 0; i < 12; i++) {
    if (sameName(current.issuer, current.subject)) {
      const selfOk = await current.verify().catch(() => false);
      return {
        path,
        check: selfOk
          ? {
              id: 'chain',
              outcome: 'pass',
              detail: `Complete to a root included in the file (${path.length} certificate${path.length === 1 ? '' : 's'}); the root is not trusted by this check.`,
            }
          : {
              id: 'chain',
              outcome: 'fail',
              detail: 'The root certificate’s self-signature does not verify.',
            },
      };
    }
    const candidates = pool.filter((c) => !path.includes(c) && sameName(c.subject, current.issuer));
    let issuer: pkijs.Certificate | undefined;
    for (const candidate of candidates) {
      if (await current.verify(candidate).catch(() => false)) {
        issuer = candidate;
        break;
      }
    }
    if (!issuer) {
      return {
        path,
        check: {
          id: 'chain',
          outcome: 'fail',
          detail:
            candidates.length > 0
              ? `"${commonName(current.subject) ?? formatName(current.subject)}" is not signed by the issuer certificate in the file.`
              : `Incomplete: the issuer of "${commonName(current.subject) ?? formatName(current.subject)}" is not in the file (${path.length} certificate${path.length === 1 ? '' : 's'} found).`,
        },
      };
    }
    path.push(issuer);
    current = issuer;
  }
  return { path, check: { id: 'chain', outcome: 'fail', detail: 'The path is too long.' } };
}

export function validityCheck(leaf: pkijs.Certificate, claimed: Date | undefined): SignatureCheck {
  const inside = (d: Date): boolean => d >= leaf.notBefore.value && d <= leaf.notAfter.value;
  const now = inside(new Date());
  const atClaim = claimed ? inside(claimed) : undefined;
  const period = `${leaf.notBefore.value.toISOString().slice(0, 10)} to ${leaf.notAfter.value.toISOString().slice(0, 10)}`;
  return {
    id: 'validity',
    outcome: now && atClaim !== false ? 'pass' : 'fail',
    detail: `Signer certificate period ${period}; the claimed signing time is ${
      atClaim === undefined ? 'absent' : atClaim ? 'inside' : 'outside'
    } it and today is ${now ? 'inside' : 'outside'} it.`,
  };
}

export function keyUsageCheck(leaf: pkijs.Certificate): SignatureCheck {
  const usage = keyUsage(leaf);
  if (usage === undefined) {
    return { id: 'key-usage', outcome: 'pass', detail: 'No keyUsage extension (any use allowed).' };
  }
  const ok = usage.includes('digitalSignature') || usage.includes('nonRepudiation');
  return {
    id: 'key-usage',
    outcome: ok ? 'pass' : 'fail',
    detail: ok
      ? `keyUsage: ${usage.join(', ')}.`
      : `keyUsage (${usage.join(', ') || 'none'}) allows neither digitalSignature nor nonRepudiation.`,
  };
}

/** Parses the certificates of a CMS (other certificate formats are skipped). */
export function certificatesOf(signedData: pkijs.SignedData): pkijs.Certificate[] {
  return (signedData.certificates ?? []).filter(
    (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
  );
}
