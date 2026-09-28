/**
 * Signatures (M5 W3, spec recognize-and-compare §3, ADR-0013): the validator on the signed
 * fixtures and the whole unsigned corpus, the tamper property, PAdES-B signing round trips
 * (RSA and P-256, classic-table and xref-stream sources), the PKCS#12 refusals, and timing.
 */
import { PDFDocument, PDFName, PDFNumber } from '@cantoo/pdf-lib';
import manifest from '../../../test/fixtures/manifest.json';
import legacyUrl from '../../../test/fixtures/pki/signer-rsa-legacy-3des.p12?url';
import p256Url from '../../../test/fixtures/pki/signer-p256.p12?url';
import rsaUrl from '../../../test/fixtures/pki/signer-rsa.p12?url';
import { describe, expect, test } from 'vitest';
import { commands } from 'vitest/browser';

import { derLength, fromHex, latin1, signedBytes } from '../src/signatures/bytes';
import { loadPkcs12 } from '../src/signatures/pkcs12';
import { signPdf } from '../src/signatures/sign';
import { revisionBytes, validateSignatures } from '../src/signatures/validate';
import { revisionEnds, sourceXrefKind } from '../src/signatures/xref';
import {
  SIGNATURE_HONESTY_LINE,
  type SignatureReport,
  SigningError,
  type SignRequest,
  type SignResult,
} from '../src/types';

declare module 'vitest/browser' {
  interface BrowserCommands {
    /** `openssl cms -verify` in Node (vitest.config.ts); `available: false` without openssl. */
    opensslCmsVerify: (
      cmsBase64: string,
      contentBase64: string,
    ) => Promise<{ available: boolean; ok: boolean; output: string }>;
  }
}

const PASSWORD = 'test-only';
const DATE = '2026-09-28T10:00:00.000Z';

interface ManifestSignature {
  readonly field: string;
  readonly page: number;
  readonly rect: readonly number[];
  readonly signed: boolean;
  readonly status: string;
  readonly filter?: string;
  readonly subFilter?: string;
  readonly revision?: number;
  readonly byteRange?: readonly number[];
  readonly coversWholeFile?: boolean;
  readonly digestAlgorithm?: string;
  readonly signatureAlgorithm?: string;
  readonly signedAttributes?: readonly string[];
  readonly claimedTime?: string;
  readonly reason?: string;
  readonly signer?: {
    readonly subject: string;
    readonly issuer: string;
    readonly serial: string;
    readonly notBefore: string;
    readonly notAfter: string;
  };
  readonly chain?: readonly string[];
  readonly checks?: Readonly<Record<string, string>>;
  readonly laterChanges?: readonly {
    readonly revision: number;
    readonly kind: string;
    readonly pages: readonly number[];
    readonly objects: readonly string[];
  }[];
  readonly weakDigest?: boolean;
}
interface ManifestFixture {
  readonly file: string;
  readonly expect?: {
    readonly signatures?: readonly ManifestSignature[];
    readonly revisions?: { readonly count: number; readonly ends: readonly number[] };
    readonly tamper?: { readonly offset: number };
  };
}
const fixtures = (manifest as unknown as { fixtures: readonly ManifestFixture[] }).fixtures;
const signedFixtures = fixtures.filter((f) => f.expect?.signatures);
const unsignedFixtures = fixtures.filter((f) => !f.expect?.signatures);

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
const fixture = async (name: string) =>
  fromBase64(await commands.readFile(`../../test/fixtures/${name}`, 'base64'));
const fetchBuffer = async (url: string) => (await fetch(url)).arrayBuffer();

const CHECK_IDS: Readonly<Record<string, string>> = {
  byteRange: 'byte-range',
  digest: 'digest',
  signature: 'signature',
  signingCertificate: 'signing-certificate',
  chain: 'chain',
};
const outcome = (r: SignatureReport, id: string) => r.checks.find((c) => c.id === id)?.outcome;

/** Seeded PRNG (mulberry32) for the tamper property. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function sign(
  bytes: Uint8Array,
  p12Url: string,
  extra: Partial<SignRequest> = {},
): Promise<SignResult> {
  return signPdf(bytes.slice(), {
    pkcs12: await fetchBuffer(p12Url),
    password: PASSWORD,
    date: DATE,
    reason: 'Round trip',
    ...extra,
  });
}

/** `openssl cms -verify` of the report's CMS over its ranges (skipped without openssl). */
async function opensslAccepts(
  bytes: Uint8Array,
  range: readonly number[],
): Promise<boolean | undefined> {
  const [, b = 0, c = 0] = range;
  const padded = fromHex(latin1(bytes, b + 1, c - 1));
  const der = padded.subarray(0, derLength(padded) ?? padded.length);
  const r = await commands.opensslCmsVerify(toBase64(der), toBase64(signedBytes(bytes, range)));
  if (!r.available) return undefined;
  if (!r.ok) console.error(r.output);
  return r.ok;
}

describe('validator on the signed fixtures', () => {
  for (const f of signedFixtures) {
    test(`${f.file}: statuses, facts and checks as in manifest.json`, async () => {
      const bytes = await fixture(f.file);
      const reports = await validateSignatures(bytes);
      const expected = (f.expect?.signatures ?? []).filter((s) => s.signed);
      expect(reports.map((r) => r.fieldName)).toEqual(expected.map((s) => s.field));
      expect(revisionEnds(bytes).map((r) => r.end)).toEqual(f.expect?.revisions?.ends);
      for (const [i, want] of expected.entries()) {
        const r = reports[i]!;
        expect(r.status, `${want.field}: ${JSON.stringify(r.checks)}`).toBe(want.status);
        expect(r.honesty).toBe(SIGNATURE_HONESTY_LINE);
        expect(r.subFilter).toBe(want.subFilter);
        expect(r.filter).toBe(want.filter);
        expect(r.byteRange).toEqual(want.byteRange);
        expect(r.coversWholeFile).toBe(want.coversWholeFile);
        expect(r.revision).toBe(want.revision);
        expect(r.revisionCount).toBe(f.expect?.revisions?.count);
        expect(r.pageIndex).toBe(want.page - 1);
        expect(r.digestAlgorithm).toBe(want.digestAlgorithm);
        expect(r.signatureAlgorithm).toBe(want.signatureAlgorithm);
        expect([...r.signedAttributes].sort()).toEqual([...(want.signedAttributes ?? [])].sort());
        expect(r.claimedTime).toBe(want.claimedTime);
        expect(r.reason).toBe(want.reason);
        expect(r.signer).toMatchObject({
          subject: want.signer?.subject,
          issuer: want.signer?.issuer,
          serialNumber: want.signer?.serial,
          notBefore: want.signer?.notBefore,
          notAfter: want.signer?.notAfter,
          publicKey: 'RSA 2048',
        });
        expect(r.chain.map((c) => c.subject)).toEqual(want.chain);
        for (const [key, value] of Object.entries(want.checks ?? {})) {
          expect(outcome(r, CHECK_IDS[key] ?? key), `${want.field} ${key}`).toBe(value);
        }
        expect(r.weak).toBe(want.weakDigest === true);
        const later = want.laterChanges ?? [];
        expect(
          r.laterChanges.map((c) => ({
            ...c,
            pages: c.pages.map((p) => p + 1),
            objects: [...c.objects].sort(),
          })),
        ).toEqual(later.map((c) => ({ ...c, objects: [...c.objects].sort() })));
      }
    });
  }

  test('signed-tampered.pdf: never Intact; the digest fails and the signature still verifies', async () => {
    const [r] = await validateSignatures(await fixture('signed-tampered.pdf'));
    expect(r?.status).toBe('broken');
    expect(outcome(r!, 'digest')).toBe('fail');
    expect(outcome(r!, 'signature')).toBe('pass');
  });

  test('signed-sha1.pdf is flagged weak', async () => {
    const [r] = await validateSignatures(await fixture('signed-sha1.pdf'));
    expect(r?.weak).toBe(true);
    expect(r?.weakReasons.join(' ')).toMatch(/SHA-1/);
  });

  test('"View signed version": the revision a later-changed signature covers is Intact', async () => {
    for (const name of [
      'signed-then-modified.pdf',
      'signed-then-changed.pdf',
      'signed-twice.pdf',
    ]) {
      const signed = revisionBytes(await fixture(name), 2);
      const [r] = await validateSignatures(signed);
      expect(r?.status, name).toBe('intact');
    }
  });

  test('a byte flip anywhere in a covered range is Broken (20 seeded flips per file)', async () => {
    for (const name of ['signed-approval.pdf', 'signed-twice.pdf', 'signed-sha1.pdf']) {
      const bytes = await fixture(name);
      const reports = await validateSignatures(bytes);
      const target = reports[reports.length - 1]!;
      const [, b = 0, c = 0, d = 0] = target.byteRange;
      const covered = b + d;
      const random = prng(0x5eed + name.length);
      for (let i = 0; i < 20; i++) {
        const k = Math.floor(random() * covered);
        const offset = k < b ? k : c + (k - b);
        const flipped = bytes.slice();
        flipped[offset] = (flipped[offset] ?? 0) ^ (1 + Math.floor(random() * 255));
        const after = await validateSignatures(flipped);
        const where = `${name} flip at ${offset}`;
        // The flipped signature is Broken (whatever name or range it now shows); an earlier
        // signature whose range the flip missed may stay intact, changed later.
        expect(
          after.some((r) => r.status === 'broken'),
          where,
        ).toBe(true);
        const same = after.filter((r) => r.byteRange.join() === target.byteRange.join());
        for (const r of same) expect(r.status, `${where}: ${r.fieldName}`).toBe('broken');
      }
    }
  });

  test('a byte range shortened by one byte is Broken (it ends before the final EOL: digest)', async () => {
    const bytes = await fixture('signed-approval.pdf');
    const text = latin1(bytes);
    const at = text.indexOf('/ByteRange [0 3335 19721 552');
    expect(at).toBeGreaterThan(0);
    const edited = bytes.slice();
    const replacement = '/ByteRange [0 3335 19721 551';
    for (let i = 0; i < replacement.length; i++) edited[at + i] = replacement.charCodeAt(i);
    const [r] = await validateSignatures(edited);
    expect(r?.status).toBe('broken');
    expect(outcome(r!, 'digest')).toBe('fail');
    // Shortened into the middle of the last line instead: not a revision end.
    const inside = bytes.slice();
    const mid = '/ByteRange [0 3335 19721 540';
    for (let i = 0; i < mid.length; i++) inside[at + i] = mid.charCodeAt(i);
    const [s] = await validateSignatures(inside);
    expect(s?.status).toBe('broken');
    expect(outcome(s!, 'byte-range')).toBe('fail');
  });

  test('validation takes under 200 ms per fixture', async () => {
    for (const f of signedFixtures) {
      const bytes = await fixture(f.file);
      await validateSignatures(bytes);
      const t0 = performance.now();
      await validateSignatures(bytes);
      const ms = performance.now() - t0;
      expect(ms, `${f.file}: ${ms.toFixed(1)} ms`).toBeLessThan(200);
    }
  });
});

describe('validator on unsigned files', () => {
  test('every unsigned corpus file gives an empty list, never an error', async () => {
    expect(unsignedFixtures.length).toBeGreaterThan(30);
    for (const f of unsignedFixtures) {
      const bytes = await fixture(f.file);
      await expect(validateSignatures(bytes), f.file).resolves.toEqual([]);
    }
  });

  test('garbage and empty inputs give an empty list', async () => {
    await expect(validateSignatures(new Uint8Array())).resolves.toEqual([]);
    const junk = await validateSignatures(
      new TextEncoder().encode('not a pdf /ByteRange [0 1 2 3]'),
    );
    expect(junk.map((r) => r.status)).toEqual(['broken']);
  });
});

describe('PKCS#12', () => {
  test('PBES2 files open with a non-extractable key and the whole chain', async () => {
    for (const [url, kind] of [
      [rsaUrl, 'RSA'],
      [p256Url, 'ECDSA P-256'],
    ] as const) {
      const id = await loadPkcs12(await fetchBuffer(url), PASSWORD);
      expect(id.keyKind).toBe(kind);
      expect(id.key.extractable).toBe(false);
      await expect(crypto.subtle.exportKey('pkcs8', id.key)).rejects.toThrow();
      expect(id.chain).toHaveLength(3);
    }
  });

  test('a legacy 3DES file is refused with the re-export command', async () => {
    const error = await loadPkcs12(await fetchBuffer(legacyUrl), PASSWORD).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SigningError);
    expect((error as SigningError).reason).toBe('legacy-pkcs12');
    expect((error as SigningError).message).toContain('openssl pkcs12');
    expect((error as SigningError).message).toContain('-keypbe AES-256-CBC');
  });

  test('a wrong password is refused', async () => {
    const error = await loadPkcs12(await fetchBuffer(rsaUrl), 'wrong').catch((e: unknown) => e);
    expect((error as SigningError).reason).toBe('bad-password');
    expect((error as SigningError).code).toBe('password-incorrect');
  });

  test('something that is not a PKCS#12 file is refused', async () => {
    const error = await loadPkcs12(new Uint8Array([1, 2, 3]).buffer, PASSWORD).catch(
      (e: unknown) => e,
    );
    expect((error as SigningError).reason).toBe('malformed-pkcs12');
  });
});

describe('signing', () => {
  for (const [source, kind] of [
    ['simple-text.pdf', 'table'],
    ['many-pages.pdf', 'stream'],
  ] as const) {
    for (const [p12, label] of [
      [rsaUrl, 'RSA'],
      [p256Url, 'P-256'],
    ] as const) {
      test(`${source} (${kind} xref) signed with ${label}: Intact, prefix kept, openssl accepts`, async () => {
        const bytes = await fixture(source);
        const result = await sign(bytes, p12);
        const out = new Uint8Array(result.bytes);
        expect(result.xrefKind).toBe(kind);
        expect(await sourceXrefKind(out)).toBe(kind);
        expect(out.subarray(0, bytes.length)).toEqual(bytes);
        expect(latin1(out, out.length - 6)).toBe('%%EOF\n');
        expect(result.report.status).toBe('intact');
        expect(result.report.subFilter).toBe('ETSI.CAdES.detached');
        expect(result.report.signatureAlgorithm).toBe(
          label === 'RSA' ? 'RSASSA-PKCS1-v1_5' : 'ECDSA P-256',
        );
        expect(result.report.claimedTime).toBe(DATE);
        expect(result.report.reason).toBe('Round trip');
        expect(result.reserveBytes).toBe(16_384);
        expect(result.cmsBytes).toBeLessThan(4_096);
        expect(outcome(result.report, 'chain')).toBe('pass');
        expect(outcome(result.report, 'signing-certificate')).toBe('pass');
        const reports = await validateSignatures(out);
        expect(reports.map((r) => [r.fieldName, r.status])).toEqual([['Signature1', 'intact']]);
        // The signing revision adds only a signature (no content change: writer rule 3).
        const again = await sign(out, rsaUrl, { fieldName: 'Second' });
        const [first, second] = await validateSignatures(again.bytes);
        expect(first?.status).toBe('intact-changed-later');
        expect(first?.laterChanges.map((c) => c.kind)).toEqual(['signature']);
        expect(second?.status).toBe('intact');
        const accepted = await opensslAccepts(out, result.byteRange);
        if (accepted !== undefined) expect(accepted).toBe(true);
        (await PDFDocument.load(out, { updateMetadata: false })).getPageCount();
      });
    }
  }

  test('a visible signature on page 2 of a signed export (xref stream, AcroForm in an object stream)', async () => {
    const exported = await (
      await PDFDocument.load(await fixture('forms-b.pdf'), { updateMetadata: false })
    ).save({
      useObjectStreams: true,
      addDefaultPage: false,
    });
    const rect = { x: 72, y: 72, width: 200, height: 50 };
    const result = await sign(exported, p256Url, {
      visible: { pageIndex: 1, rect },
      signerName: 'Ada Lövelace',
    });
    expect(result.report.status).toBe('intact');
    expect(result.report.pageIndex).toBe(1);
    expect(result.report.rect).toEqual(rect);
    expect(result.report.signerName).toBe('Ada Lövelace');
    const accepted = await opensslAccepts(new Uint8Array(result.bytes), result.byteRange);
    if (accepted !== undefined) expect(accepted).toBe(true);
  });

  test('later revisions on our own signature: form fill is allowed, a page rotation is not', async () => {
    const exported = await (
      await PDFDocument.load(await fixture('forms-b.pdf'), { updateMetadata: false })
    ).save({ useObjectStreams: false, addDefaultPage: false });
    const signed = new Uint8Array((await sign(exported, rsaUrl)).bytes);
    const append = async (edit: (doc: PDFDocument) => void) => {
      const doc = await PDFDocument.load(signed, {
        forIncrementalUpdate: true,
        updateMetadata: false,
      });
      edit(doc);
      return doc.commit({ useObjectStreams: false });
    };
    const filled = await append((doc) => {
      doc.getForm().getTextField('name').setText('Filled after signing');
    });
    const [fill] = await validateSignatures(filled);
    expect(fill?.status).toBe('intact-changed-later');
    expect(new Set(fill?.laterChanges.map((c) => c.kind))).toEqual(new Set(['form-fill']));
    const rotated = await append((doc) => {
      doc.getPage(0).node.set(PDFName.of('Rotate'), PDFNumber.of(90));
    });
    const [rotation] = await validateSignatures(rotated);
    expect(rotation?.status).toBe('changed-after-signing');
    expect(rotation?.laterChanges).toEqual([
      expect.objectContaining({ kind: 'pages', pages: [0] }),
    ]);
  });

  test('signing a signed fixture keeps its signature intact, changed later', async () => {
    const result = await sign(await fixture('signed-approval.pdf'), rsaUrl);
    const reports = await validateSignatures(result.bytes);
    expect(reports.map((r) => [r.fieldName, r.status])).toEqual([
      ['Approval', 'intact-changed-later'],
      ['Signature1', 'intact'],
    ]);
  });

  test('refusals: encrypted input, damaged input, taken field name, legacy p12, wrong password', async () => {
    const reason = (p: Promise<unknown>) =>
      p.then(
        () => 'signed',
        (e: unknown) => (e as SigningError).reason,
      );
    const simple = await fixture('simple-text.pdf');
    expect(await reason(sign(await fixture('encrypted-aes-256.pdf'), rsaUrl))).toBe(
      'encrypted-input',
    );
    expect(await reason(sign(await fixture('encrypted-rc4-40.pdf'), rsaUrl))).toBe(
      'encrypted-input',
    );
    expect(await reason(sign(await fixture('truncated.pdf'), rsaUrl))).toBe('damaged-input');
    expect(
      await reason(sign(await fixture('signed-approval.pdf'), rsaUrl, { fieldName: 'Approval' })),
    ).toBe('field-exists');
    expect(await reason(sign(simple, legacyUrl))).toBe('legacy-pkcs12');
    expect(await reason(sign(simple, rsaUrl, { password: 'nope' }))).toBe('bad-password');
    expect(await reason(sign(simple, rsaUrl, { reserveBytes: 100 }))).toBe('bad-request');
  });

  test('a reserve too small for the CMS fails instead of writing a truncated signature', async () => {
    const error = await sign(await fixture('simple-text.pdf'), rsaUrl, { reserveBytes: 4096 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    // RSA with three certificates needs ~3.4 KB: 4 KB fits.
    expect(error).toBeUndefined();
  });
});
