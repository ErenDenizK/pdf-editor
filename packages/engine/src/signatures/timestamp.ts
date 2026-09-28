/**
 * RFC 3161 timestamp tokens (spec §3.1 steps 2 and 5, M5 review finding 2). A token is a CMS
 * SignedData whose encapsulated content is a DER `TSTInfo` (id-ct-TSTInfo): the authority's
 * `messageImprint` names what was stamped, `messageDigest` covers the TSTInfo, and the
 * authority signs the signed attributes. Two places carry one:
 *
 * - a document timestamp (`/Type /DocTimeStamp`, `/SubFilter /ETSI.RFC3161`, ISO 32000-2
 *   §12.8.5): the imprint is the digest of the byte ranges; it is validated like a signature
 *   (validate.ts) with this module's digest step, and it is never "not detached";
 * - a signature timestamp (the `timeStampToken` unsigned attribute, RFC 3161 Appendix A):
 *   the imprint is the digest of the signer's signature value; checked as a fact that never
 *   changes the signature's status.
 *
 * The authority is named, never trusted (ADR-0013): nothing is fetched and no trust store is
 * consulted, exactly as for signers.
 */
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

import type { SignatureCheck } from '../types';
import { equalBytes } from './bytes';
import { certificatesOf, formatName } from './certificates';
import { BROKEN_DIGESTS, DIGESTS, type HashName, OID } from './oids';
import { digest, findLeaf, octets, verifySignature } from './verify';

/** id-ct-TSTInfo (RFC 3161 §2.4.2). */
export const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
/** id-kp-timeStamping (RFC 3161 §2.3). */
const OID_KP_TIMESTAMPING = '1.3.6.1.5.5.7.3.8';
const OID_EXT_KEY_USAGE = '2.5.29.37';

export interface TstDigest {
  /** `pass`/`fail` as for the detached digest; `unsupported` for an unknown imprint hash. */
  readonly check: SignatureCheck;
  readonly tst?: pkijs.TSTInfo;
}

/**
 * The digest step of a timestamp token: the TSTInfo's imprint against `imprinted` hashed
 * with the imprint's own algorithm, the eContentType, the contentType attribute, and
 * `messageDigest` against the digest of the TSTInfo DER (with the signer's digest algorithm).
 */
export async function tstDigestCheck(
  signedData: pkijs.SignedData,
  signer: pkijs.SignerInfo,
  signerHash: HashName,
  imprinted: Uint8Array,
  what: string,
): Promise<TstDigest> {
  const fail = (detail: string): TstDigest => ({
    check: { id: 'digest', outcome: 'fail', detail },
  });
  const encap = signedData.encapContentInfo;
  if (encap.eContentType !== OID_TST_INFO || !encap.eContent) {
    return fail(
      `The timestamp token does not carry a TSTInfo (content type ${encap.eContentType}).`,
    );
  }
  const content = octets(encap.eContent);
  let tst: pkijs.TSTInfo;
  try {
    tst = pkijs.TSTInfo.fromBER(content.slice().buffer);
  } catch (error) {
    return fail(
      `The TSTInfo cannot be read (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const imprintOid = tst.messageImprint.hashAlgorithm.algorithmId;
  const imprintHash = DIGESTS[imprintOid];
  if (!imprintHash) {
    const broken = BROKEN_DIGESTS[imprintOid];
    return {
      check: {
        id: 'digest',
        outcome: 'unsupported',
        detail: broken
          ? `${broken} timestamp imprints cannot be checked.`
          : `Timestamp imprint algorithm ${imprintOid} is not supported.`,
      },
      tst,
    };
  }
  const imprintOk = equalBytes(
    tst.messageImprint.hashedMessage.valueBlock.valueHexView,
    await digest(imprintHash, imprinted),
  );
  const attrs = signer.signedAttrs?.attributes ?? [];
  const type: unknown = attrs.find((a) => a.type === OID.contentType)?.values[0];
  const typeOk =
    type instanceof asn1js.ObjectIdentifier && type.valueBlock.toString() === OID_TST_INFO;
  const md: unknown = attrs.find((a) => a.type === OID.messageDigest)?.values[0];
  const mdOk =
    md instanceof asn1js.OctetString && equalBytes(octets(md), await digest(signerHash, content));
  const ok = imprintOk && typeOk && mdOk;
  const parts = [
    `the TSTInfo imprint (${imprintHash}) ${imprintOk ? 'matches' : 'does not match'} ${what}`,
    `messageDigest ${mdOk ? 'matches' : 'does not match'} the TSTInfo`,
  ];
  if (!typeOk) parts.push('the contentType attribute is not id-ct-TSTInfo');
  return {
    check: {
      id: 'digest',
      outcome: ok ? 'pass' : 'fail',
      detail: `${capitalise(parts.join('; '))}.`,
    },
    tst,
  };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Whether the certificate's extended key usage names id-kp-timeStamping. */
export function timeStampingUsage(cert: pkijs.Certificate): SignatureCheck {
  const ext = cert.extensions?.find((e) => e.extnID === OID_EXT_KEY_USAGE);
  const usages = ext?.parsedValue instanceof pkijs.ExtKeyUsage ? ext.parsedValue.keyPurposes : [];
  const ok = usages.includes(OID_KP_TIMESTAMPING);
  return {
    id: 'key-usage',
    outcome: ok ? 'pass' : 'fail',
    detail: ok
      ? `Extended key usage: timeStamping${ext?.critical ? ' (critical)' : ''}.`
      : 'The authority certificate’s extended key usage does not name timeStamping (RFC 3161 §2.3).',
  };
}

/** `{ time, tsa }` of a token: the TSTInfo genTime and the authority certificate's subject. */
export function timestampFacts(
  tst: pkijs.TSTInfo,
  tsa: pkijs.Certificate | undefined,
): { readonly time: string; readonly tsa: string } {
  return {
    time: tst.genTime.toISOString(),
    tsa: tsa ? formatName(tsa.subject) : '(the authority certificate is not in the token)',
  };
}

/**
 * The `timestamp` check for a signature's embedded token: its imprint over the signer's
 * signature value, its messageDigest and the authority's signature. A fact only.
 */
export async function embeddedTimestamp(
  signer: pkijs.SignerInfo,
  pool: readonly pkijs.Certificate[],
): Promise<{
  readonly check: SignatureCheck;
  readonly timestamp?: { readonly time: string; readonly tsa: string };
}> {
  const attr = signer.unsignedAttrs?.attributes.find((x) => x.type === OID.timeStampToken);
  if (!attr) {
    return {
      check: {
        id: 'timestamp',
        outcome: 'not-checked',
        detail: 'No timestamp: the signing time is only claimed by the signer.',
      },
    };
  }
  const failed = (why: string) => ({
    check: {
      id: 'timestamp' as const,
      outcome: 'fail' as const,
      detail: `A timestamp token is embedded but ${why}; the timestamp authority is not trusted.`,
    },
  });
  try {
    const info = new pkijs.ContentInfo({ schema: attr.values[0] });
    if (info.contentType !== OID.signedData) return failed('it is not SignedData');
    const token = new pkijs.SignedData({ schema: info.content });
    const tsaSigner = token.signerInfos[0];
    if (!tsaSigner || token.signerInfos.length !== 1) return failed('it has no single signer');
    const hash = DIGESTS[tsaSigner.digestAlgorithm.algorithmId];
    if (!hash) return failed('its digest algorithm is not supported');
    const imprinted = signer.signature.valueBlock.valueHexView;
    const tstCheck = await tstDigestCheck(token, tsaSigner, hash, imprinted, 'the signature value');
    const certs = [...certificatesOf(token), ...pool];
    const tsa = findLeaf(tsaSigner, certs);
    if (!tstCheck.tst || tstCheck.check.outcome !== 'pass') {
      return failed(tstCheck.check.detail.replace(/\.$/, '').toLowerCase());
    }
    if (!tsa || !tsaSigner.signedAttrs) return failed('its authority certificate is missing');
    const verified = await verifySignature(
      tsaSigner,
      tsa,
      new Uint8Array(tsaSigner.signedAttrs.encodedValue),
      hash,
      [],
    );
    const facts = timestampFacts(tstCheck.tst, tsa);
    const ok = verified.check.outcome === 'pass';
    return {
      check: {
        id: 'timestamp',
        outcome: ok ? 'pass' : 'fail',
        detail: ok
          ? `Timestamp ${facts.time} by ${facts.tsa}: its imprint and signature check out; the timestamp authority is not trusted.`
          : `A timestamp token is embedded but its signature does not verify; the timestamp authority is not trusted.`,
      },
      ...(ok ? { timestamp: facts } : {}),
    };
  } catch (error) {
    return failed(`it cannot be read (${error instanceof Error ? error.message : String(error)})`);
  }
}
