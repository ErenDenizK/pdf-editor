/**
 * Signature validator (spec §3.1, ADR-0013). For every signature dictionary: the byte range
 * (from 0, the gap exactly the /Contents hex string read from the raw bytes, ending at a
 * revision end), the digest of the ranges against the CMS, the CMS signature over the signed
 * attributes with the signer's key (WebCrypto), the signing-certificate(-v2) attribute, the
 * chain as embedded (CMS and /DSS), validity and key usage as facts, what later revisions
 * changed (read through their cross-reference chain, later.ts) and, when a renderer is
 * configured, which pages look different from the signed version (visual.ts). Nothing is
 * fetched and nothing is trusted: the best status is "Intact", never "valid".
 *
 * Document timestamps (`/SubFilter /ETSI.RFC3161`) are validated the same way with the RFC
 * 3161 digest step (timestamp.ts); other unknown SubFilters are Cannot check before any
 * integrity decision, so a format we do not understand is never called Broken.
 *
 * Signature dictionaries are found three ways, so damage cannot hide one: the AcroForm field
 * tree (and /Perms), every indirect object pdf-lib reads that is a signature dictionary, and a
 * raw scan for /ByteRange (for what pdf-lib cannot parse). No signatures → an empty list.
 */
import type { PDFDocument } from '@cantoo/pdf-lib';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFName,
  type PDFObject,
  PDFRawStream,
  type PDFRef,
} from '@cantoo/pdf-lib';
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
import { ATTRIBUTE_NAMES, BROKEN_DIGESTS, DIGESTS, OID } from './oids';
import { allowedKinds, classifyLaterChanges } from './revisions';
import {
  embeddedTimestamp,
  OID_TST_INFO,
  timeStampingUsage,
  timestampFacts,
  tstDigestCheck,
} from './timestamp';
import { digest, findLeaf, octets, signingCertificateCheck, verifySignature } from './verify';
import { VISUAL_DPI, VisualComparer } from './visual';
import { type RevisionEnd, revisionEndingAt, revisionEnds } from './xref';

/**
 * A file with none of these cannot hold a signature: signature dictionaries have /ByteRange
 * and /Type /Sig (either may be damaged, not both), or sit in an object stream.
 */
const SIGNATURE_TOKENS = ['/ByteRange', '/Sig', '/DocTimeStamp', '/ObjStm'];

/** SubFilters of approval and certification signatures (a detached or SHA-1 CMS). */
const SUPPORTED_SUBFILTERS = new Set([
  'ETSI.CAdES.detached',
  'adbe.pkcs7.detached',
  'adbe.pkcs7.sha1',
]);
/** A document timestamp (ISO 32000-2 §12.8.5): an RFC 3161 token over the byte ranges. */
const DOC_TIMESTAMP = 'ETSI.RFC3161';

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
  /** Certificates of the document security store (`/DSS /Certs`), for chain building. */
  readonly dss: readonly pkijs.Certificate[];
  readonly visual: VisualComparer | undefined;
  readonly dpi: number;
}

function isoOrUndefined(m: string | undefined): string | undefined {
  return parsePdfDate(m)?.toISOString();
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The certificates in `/DSS /Certs` (streams of DER); unreadable entries are skipped. */
function dssCertificates(doc: PDFDocument | undefined): pkijs.Certificate[] {
  const out: pkijs.Certificate[] = [];
  try {
    const dss = doc?.catalog.lookup(PDFName.of('DSS'));
    const certs = dss instanceof PDFDict ? dss.lookup(PDFName.of('Certs')) : undefined;
    if (!(certs instanceof PDFArray)) return out;
    for (let i = 0; i < certs.size(); i++) {
      try {
        const stream = certs.lookup(i);
        if (!(stream instanceof PDFRawStream)) continue;
        out.push(pkijs.Certificate.fromBER(decodePDFRawStream(stream).decode().slice().buffer));
      } catch {
        // Not a certificate: nothing to build with.
      }
    }
  } catch {
    // A damaged /DSS: the CMS certificates alone.
  }
  return out;
}

const pageList = (pages: readonly number[]) =>
  `page${pages.length === 1 ? '' : 's'} ${pages.map((p) => p + 1).join(', ')}`;

async function laterChanges(
  ctx: Context,
  end: number,
  signedRevision: number,
  docMdp: 1 | 2 | 3 | undefined,
): Promise<{
  check: SignatureCheck;
  changes: RevisionChange[];
  allowed: boolean;
  visuallyChangedPages?: number[];
}> {
  const fail = (detail: string) => ({
    check: { id: 'later-changes' as const, outcome: 'fail' as const, detail },
    changes: [] as RevisionChange[],
    allowed: false,
  });
  const cut = ctx.bytes.subarray(0, end);
  let before = ctx.before.get(end);
  if (!before) {
    before = loadForSignatures(cut, ctx.password).then((r) => r.doc);
    ctx.before.set(end, before);
  }
  let changes: RevisionChange[];
  let informational: readonly RevisionChange[];
  let notes: readonly string[];
  let lastRevision: number;
  try {
    // A second copy of the signed revision becomes the file as a reader resolves it.
    const afterCopy = (await loadForSignatures(cut, ctx.password)).doc;
    const later = await classifyLaterChanges(
      ctx.bytes,
      ctx.text,
      end,
      signedRevision,
      await before,
      afterCopy,
    );
    ({ changes, informational, notes, lastRevision } = later);
  } catch (error) {
    return fail(`The later revisions cannot be read (${errorText(error)}).`);
  }
  // Defence in depth: a page that looks different must be explained by a listed change.
  let visuallyChangedPages: number[] | undefined;
  let visualNote = '';
  if (ctx.visual) {
    try {
      visuallyChangedPages = await ctx.visual.changedPages(end);
      const unexplained = visuallyChangedPages.filter(
        (p) => !changes.some((c) => c.pages.includes(p)),
      );
      visualNote = ` Compared with the signed version at ${ctx.dpi} dpi, ${
        visuallyChangedPages.length === 0
          ? 'no page looks different'
          : `${pageList(visuallyChangedPages)} look${visuallyChangedPages.length === 1 ? 's' : ''} different`
      }.`;
      if (unexplained.length > 0) {
        visualNote += ` No listed change explains ${pageList(unexplained)}, so ${unexplained.length === 1 ? 'it counts' : 'they count'} as changed content.`;
        const existing = changes.find((c) => c.revision === lastRevision && c.kind === 'content');
        const merged: RevisionChange = {
          revision: lastRevision,
          kind: 'content',
          pages: [...new Set([...(existing?.pages ?? []), ...unexplained])].sort((a, b) => a - b),
          objects: existing?.objects ?? [],
        };
        changes = [...changes.filter((c) => c !== existing), merged].sort(
          (a, b) => a.revision - b.revision || a.kind.localeCompare(b.kind),
        );
      }
    } catch (error) {
      if (error instanceof EngineError && error.code === 'aborted') throw error;
      visualNote = ` The signed version could not be compared visually (${errorText(error)}).`;
    }
  }
  const allowedSet = allowedKinds(docMdp);
  // Unreferenced objects readers ignore are listed but allowed (ADR-0013, notes after review).
  const allowed = changes.every((c) => allowedSet.has(c.kind) || informational.includes(c));
  const listed =
    changes
      .map(
        (c) =>
          `revision ${c.revision}: ${c.kind}${c.objects.length > 0 ? ` (${c.objects.join(', ')})` : ''}${c.pages.length > 0 ? ` on ${pageList(c.pages)}` : ''}`,
      )
      .join('; ') || 'they change nothing a reader shows';
  const why = notes.length > 0 ? ` ${notes.join(' ')}` : '';
  return {
    check: {
      id: 'later-changes',
      outcome: allowed ? 'pass' : 'fail',
      detail: `Later revisions: ${listed}.${why}${docMdp ? ` DocMDP permissions ${docMdp} decide what is allowed.` : ''}${visualNote}`,
    },
    changes,
    allowed,
    ...(visuallyChangedPages ? { visuallyChangedPages } : {}),
  };
}

/**
 * How the CMS digests the document: `detached` (messageDigest of the byte ranges), `sha1`
 * (adbe.pkcs7.sha1: the SHA-1 of the ranges encapsulated as content) or `tst` (an RFC 3161
 * TSTInfo whose imprint is the digest of the ranges). A known SubFilter decides; for another
 * one the CMS shape does, and `undefined` means a shape this validator does not know.
 */
type DigestMode = 'detached' | 'sha1' | 'tst';

function digestMode(subFilter: string, signedData: pkijs.SignedData): DigestMode | undefined {
  if (subFilter === DOC_TIMESTAMP) return 'tst';
  if (subFilter === 'adbe.pkcs7.sha1') return 'sha1';
  if (SUPPORTED_SUBFILTERS.has(subFilter)) return 'detached';
  const { eContentType, eContent } = signedData.encapContentInfo;
  const content = eContent ? octets(eContent) : new Uint8Array();
  if (content.length === 0) return 'detached';
  if (eContentType === OID_TST_INFO) return 'tst';
  if (eContentType === OID.data && content.length === 20) return 'sha1';
  return undefined;
}

/** What checking one SignerInfo found (a PDF signature has exactly one; see validateOne). */
interface SignerOutcome {
  /** digest, signature, signing-certificate, then chain, validity, key-usage, timestamp. */
  readonly checks: SignatureCheck[];
  readonly integrity: 'ok' | 'broken' | 'unsupported';
  readonly signer?: SignerFacts;
  readonly chain: SignerFacts[];
  readonly digestAlgorithm?: string;
  readonly signatureAlgorithm?: string;
  readonly signedAttributes: string[];
  readonly weakReasons: string[];
  readonly timestamp?: { readonly time: string; readonly tsa: string };
}

/**
 * Steps 2–5 of spec §3.1 for one SignerInfo: digest (detached, SHA-1 encapsulated, or the
 * RFC 3161 imprint for a document timestamp), the signature over the signed attributes, the
 * signing-certificate attribute, and the certificate facts.
 */
async function checkSigner(
  ctx: Context,
  sig: SignatureDictionary,
  mode: DigestMode,
  signedData: pkijs.SignedData,
  signer: pkijs.SignerInfo,
  ranges: Uint8Array,
): Promise<SignerOutcome> {
  const checks: SignatureCheck[] = [];
  const weakReasons: string[] = [];
  const isTimestamp = mode === 'tst';
  const cmsCerts = certificatesOf(signedData);
  const der = (c: pkijs.Certificate) => new Uint8Array(c.toSchema().toBER());
  const cmsDer = cmsCerts.map(der);
  const pool = [...cmsCerts, ...ctx.dss.filter((d) => !cmsDer.some((c) => equalBytes(c, der(d))))];
  const signedAttributes = (signer.signedAttrs?.attributes ?? []).map(
    (x) => ATTRIBUTE_NAMES[x.type] ?? x.type,
  );
  const leaf = findLeaf(signer, pool);
  let signerFacts: SignerFacts | undefined;
  let chain: SignerFacts[] = [];
  let signatureAlgorithm: string | undefined;
  let timestamp: SignerOutcome['timestamp'];
  const outcome = (integrity: SignerOutcome['integrity'], extra: SignatureCheck[] = []) => {
    checks.push(...extra);
    return {
      checks,
      integrity,
      ...(signerFacts ? { signer: signerFacts } : {}),
      chain,
      ...(digestHash ? { digestAlgorithm: digestHash } : {}),
      ...(signatureAlgorithm ? { signatureAlgorithm } : {}),
      signedAttributes,
      weakReasons,
      ...(timestamp ? { timestamp } : {}),
    };
  };

  const digestOid = signer.digestAlgorithm.algorithmId;
  const digestHash = DIGESTS[digestOid];
  // The document timestamp's TSTInfo (its genTime is the time the validity facts use).
  const tst =
    isTimestamp && digestHash
      ? await tstDigestCheck(signedData, signer, digestHash, ranges, 'the byte ranges')
      : undefined;

  // Facts about the signer; appended after the integrity checks, never change the status.
  let deferred: SignatureCheck[] = [];
  if (leaf) {
    signerFacts = await certificateFacts(leaf);
    const built = await buildChain(leaf, pool, new Set(pool.filter((c) => !cmsCerts.includes(c))));
    chain = await Promise.all(built.path.map(certificateFacts));
    const issuers = built.path.slice(1);
    if (isTimestamp) {
      const genTime = tst?.tst?.genTime;
      deferred = [
        built.check,
        validityCheck(leaf, genTime, issuers, 'the timestamp time'),
        timeStampingUsage(leaf),
      ];
    } else {
      const embedded = await embeddedTimestamp(signer, pool);
      if (embedded.timestamp) timestamp = embedded.timestamp;
      deferred = [
        built.check,
        validityCheck(leaf, parsePdfDate(sig.m), issuers),
        keyUsageCheck(leaf),
        embedded.check,
      ];
    }
  }

  if (!digestHash) {
    const broken = BROKEN_DIGESTS[digestOid];
    checks.push({
      id: 'digest',
      outcome: 'unsupported',
      detail: broken
        ? `${broken} digests cannot be checked.`
        : `Digest algorithm ${digestOid} is not supported.`,
    });
    return outcome('unsupported', deferred);
  }
  if (digestHash === 'SHA-1') weakReasons.push('The document digest is SHA-1, which is weak.');

  // 3. Digest of the byte ranges.
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
  if (tst) {
    checks.push(tst.check);
    if (tst.check.outcome === 'unsupported') return outcome('unsupported', deferred);
    digestOk = tst.check.outcome === 'pass';
    signedContent = eContent ? octets(eContent) : new Uint8Array();
    if (!signer.signedAttrs) digestOk = false; // RFC 3161 §2.4.2: signed attributes are required.
  } else if (mode === 'sha1') {
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
    const verified = await verifySignature(signer, leaf, data, digestHash, weakReasons);
    checks.push(verified.check);
    if (verified.algorithm) signatureAlgorithm = verified.algorithm;
    sigOk = verified.check.outcome === 'pass';
    sigUnsupported = verified.check.outcome === 'unsupported';
    if (!signer.signedAttrs && verified.check.outcome === 'fail') {
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
  }
  const broken = digestOk === false || (sigOk === false && !sigUnsupported) || certMismatch;
  if (isTimestamp && tst?.tst && !broken && !sigUnsupported) {
    timestamp = timestampFacts(tst.tst, leaf);
    deferred.push({
      id: 'timestamp',
      outcome: 'pass',
      detail: `Document timestamp ${timestamp.time} by ${timestamp.tsa}; the timestamp authority is not trusted.`,
    });
  }
  return outcome(broken ? 'broken' : sigUnsupported ? 'unsupported' : 'ok', deferred);
}

async function validateOne(ctx: Context, candidate: Candidate): Promise<SignatureReport> {
  const { bytes } = ctx;
  const sig = candidate.sig;
  const checks: SignatureCheck[] = [];
  let weakReasons: string[] = [];
  const claimedTime = isoOrUndefined(sig.m);
  let signerFacts: SignerFacts | undefined;
  let chain: SignerFacts[] = [];
  let digestAlgorithm: string | undefined = undefined;
  let signatureAlgorithm: string | undefined = undefined;
  let signedAttributes: string[] = [];
  let changes: RevisionChange[] = [];
  let revision: number | undefined;
  let coversWholeFile = false;
  let timestamp: SignerOutcome['timestamp'] = undefined;
  let visuallyChangedPages: number[] | undefined = undefined;

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
    ...(timestamp ? { timestamp } : {}),
    ...(visuallyChangedPages ? { visuallyChangedPages } : {}),
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
  const isTimestamp = sig.subFilter === DOC_TIMESTAMP;
  const subFilterSupported = isTimestamp || SUPPORTED_SUBFILTERS.has(sig.subFilter);
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
        ? `The CMS cannot be read (${errorText(error)}).`
        : `SubFilter ${sig.subFilter || '(none)'} is not supported.`,
    });
    return report('cannot-check');
  }
  const signers = signedData.signerInfos;
  const first = signers[0];
  if (!first) {
    checks.push({ id: 'digest', outcome: 'unsupported', detail: 'The CMS names no signer.' });
    return report('cannot-check');
  }
  const mode = digestMode(sig.subFilter, signedData);
  if (!mode) {
    // A CMS shape we do not know under a SubFilter we do not know (content of its own that is
    // neither a TSTInfo nor a SHA-1 digest): what it covers is unknown, so it is never judged.
    const leaf = findLeaf(first, certificatesOf(signedData));
    if (leaf) signerFacts = await certificateFacts(leaf);
    checks.push({
      id: 'digest',
      outcome: 'unsupported',
      detail: `SubFilter ${sig.subFilter || '(none)'} is not supported and its CMS signs content of its own, so the signature is not checked.`,
    });
    return report('cannot-check');
  }

  // 3–5. Each SignerInfo. A PDF signature has exactly one (ISO 32000-2 §12.8.3.3.1); more is
  // never Intact: Broken when any of them fails, Cannot check otherwise.
  const ranges = signedBytes(bytes, range);
  const outcomes: SignerOutcome[] = [];
  for (const signer of signers) {
    outcomes.push(await checkSigner(ctx, sig, mode, signedData, signer, ranges));
  }
  const primary = outcomes[0] as SignerOutcome;
  checks.push(...primary.checks);
  signerFacts = primary.signer;
  chain = primary.chain;
  digestAlgorithm = primary.digestAlgorithm;
  signatureAlgorithm = primary.signatureAlgorithm;
  signedAttributes = primary.signedAttributes;
  weakReasons = [...new Set(outcomes.flatMap((o) => o.weakReasons))];
  timestamp = primary.timestamp;
  if (outcomes.length > 1) {
    const worst = outcomes.findIndex((o) => o.integrity === 'broken');
    checks.push({
      id: 'signature',
      outcome: worst >= 0 ? 'fail' : 'unsupported',
      detail: `The CMS has ${outcomes.length} signers; a PDF signature has exactly one (ISO 32000-2 §12.8.3.3.1). ${
        worst >= 0
          ? `Signer ${worst + 1} does not verify.`
          : 'Each verifies, but which one signed is ambiguous, so the signature is not judged.'
      }`,
    });
    return report(worst >= 0 ? 'broken' : 'cannot-check');
  }
  if (primary.integrity === 'broken') return report('broken');
  if (primary.integrity === 'unsupported') return report('cannot-check');
  if (!subFilterSupported) {
    // A CMS of a shape we know whose digest and signature match, under a SubFilter we do not
    // know. (A mismatch above is Broken under that shape's reading whatever the name says, so
    // a byte flipped in the /SubFilter name stays Broken.)
    checks.push({
      id: 'later-changes',
      outcome: 'not-checked',
      detail: `SubFilter ${sig.subFilter || '(none)'} is not supported.`,
    });
    return report('cannot-check');
  }

  // 6. Later revisions.
  if (coversWholeFile) {
    checks.push({ id: 'later-changes', outcome: 'pass', detail: 'No later revisions.' });
    return report('intact');
  }
  const later = await laterChanges(ctx, end, revision ?? 1, sig.docMdp);
  checks.push(later.check);
  changes = later.changes;
  visuallyChangedPages = later.visuallyChangedPages;
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
  const dpi = options.visual?.dpi ?? VISUAL_DPI;
  const ctx: Context = {
    bytes,
    text,
    ends: revisionEnds(bytes),
    doc,
    password: options.password,
    before: new Map(),
    dss: dssCertificates(doc),
    visual: options.visual
      ? new VisualComparer(bytes, {
          pdfiumWasm: options.visual.pdfiumWasm,
          dpi,
          ...(options.password === undefined ? {} : { password: options.password }),
          ...(options.signal ? { signal: options.signal } : {}),
        })
      : undefined,
    dpi,
  };
  const reports: SignatureReport[] = [];
  for (const candidate of found) {
    throwIfAborted(options);
    try {
      reports.push(await validateOne(ctx, candidate));
    } catch (error) {
      if (error instanceof EngineError && error.code === 'aborted') throw error;
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
