/**
 * Q2, Q4, Q5 (Node half): PAdES-B signing with pkijs + WebCrypto (RSA PKCS#1 v1.5 and ECDSA
 * P-256), cross-checked with openssl, pkijs' own verify, PDFium and pdf.js; modification
 * detection after signing; sizes and times.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument } from '@cantoo/pdf-lib';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { beforeAll, expect, test } from 'vitest';

import { ascii, concat, fromHex, latin1 } from '../src/bytes';
import { loadPkcs12, type SigningIdentity } from '../src/p12';
import {
  addContentChange,
  addEmptySignatureField,
  addSignaturePlaceholder,
  addTextAnnotation,
  loadIncremental,
  options,
} from '../src/pdf-edits';
import { finishSignature, signedBytes, signPdf } from '../src/sign';
import { validatePdf, type SignatureValidation } from '../src/validate';
import { walkChain } from '../src/xref';
import { opensslSignedAttributes, opensslVerify, pdfium, pdfjsOpen } from '../src/node/checks';
import { PASSWORD, readPki } from '../src/node/pki';
import { table, writeResult } from '../src/node/results';

const FIXTURES = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const DATE = new Date('2026-09-28T10:00:00Z');

let rsa: SigningIdentity;
let ec: SigningIdentity;
const evidence: Record<string, unknown> = {};
const rows: unknown[][] = [];

beforeAll(async () => {
  rsa = await loadPkcs12(readPki('rsa-openssl3-default.p12').slice().buffer, PASSWORD);
  ec = await loadPkcs12(readPki('ec-openssl3-default.p12').slice().buffer, PASSWORD);
});

const summary = (v: SignatureValidation | undefined): string =>
  v
    ? `${v.status}${v.laterChanges.length ? ` [${v.laterChanges.map((c) => c.kind).join(', ')}]` : ''}`
    : 'none';

/** pkijs' own SignedData.verify over the byte ranges: an implementation independent of ours. */
async function pkijsVerify(bytes: Uint8Array, range: readonly number[]): Promise<boolean> {
  const [, b = 0, c = 0] = range;
  const der = fromHex(latin1(bytes, b + 1, c - 1));
  const ci = new pkijs.ContentInfo({ schema: asn1js.fromBER(der.buffer).result });
  const sd = new pkijs.SignedData({ schema: ci.content });
  const r = await sd.verify({
    signer: 0,
    data: signedBytes(bytes, range).slice().buffer,
    checkChain: false,
    extendedMode: true,
  });
  return r.signatureVerified === true;
}

async function signAnnotate(
  src: Uint8Array,
  change: (doc: PDFDocument) => unknown,
): Promise<Uint8Array> {
  const doc = await loadIncremental(src);
  await change(doc);
  return doc.commit({ useObjectStreams: (await walkChain(src)).sections[0]?.kind === 'stream' });
}

test('Q2: sign and cross-check (RSA and ECDSA, table and xref-stream sources)', async () => {
  const probe = await pdfium();
  const exportOf = async (name: string): Promise<Uint8Array> =>
    (await PDFDocument.load(fixture(name), { updateMetadata: false })).save({
      useObjectStreams: true,
      addDefaultPage: false,
    });
  const cases: [string, () => Promise<Uint8Array>][] = [
    ['simple-text.pdf', () => Promise.resolve(fixture('simple-text.pdf'))],
    ['many-pages.pdf', () => Promise.resolve(fixture('many-pages.pdf'))],
    ['forms-b.pdf (export output)', () => exportOf('forms-b.pdf')],
  ];
  for (const [name, get] of cases) {
    for (const [label, id] of [
      ['RSA-2048', rsa],
      ['ECDSA P-256', ec],
    ] as const) {
      const src = await get();
      const r = await signPdf(src, id, { date: DATE, reason: 'S2 spike' });
      const [v] = await validatePdf(r.bytes);
      const tag = `q2-${name.replace(/\W+/g, '-')}-${label.replace(/\W+/g, '-')}`;
      const ossl = opensslVerify(r.bytes, r.byteRange, tag);
      const attrs = opensslSignedAttributes(tag);
      const pk = await pkijsVerify(r.bytes, r.byteRange);
      const pr = probe(r.bytes);
      const pj = await pdfjsOpen(r.bytes);
      const sig = pr.signatures[0];
      rows.push([
        name,
        label,
        r.xrefKind,
        summary(v),
        (v?.checks ?? [])
          .filter((x) => x.outcome !== 'pass')
          .map((x) => `${x.id}:${x.outcome}`)
          .join(' ') || 'all pass',
        ossl.ok ? 'Verification successful' : `**${ossl.output.trim()}**`,
        attrs.join(', '),
        pk ? 'yes' : '**no**',
        sig
          ? `${sig.subFilter}, range ${sig.byteRange.join(' ') === r.byteRange.join(' ') ? '=' : '≠'}, /M ${sig.time}`
          : '**none**',
        pj.sigFields.join(','),
        r.cmsBytes,
        r.appendedWithoutContents,
        `${r.ms.load.toFixed(0)}/${r.ms.commit.toFixed(0)}/${r.ms.digest.toFixed(0)}/${r.ms.cms.toFixed(0)} = ${r.ms.total.toFixed(0)}`,
      ]);
      evidence[tag] = {
        validation: v,
        openssl: ossl.output.trim(),
        attrs,
        pkijs: pk,
        pdfium: pr,
        pdfjs: pj,
        sizes: {
          cms: r.cmsBytes,
          appended: r.appended,
          withoutContents: r.appendedWithoutContents,
        },
        ms: r.ms,
      };
      expect(v?.status).toBe('intact');
      expect(ossl.ok).toBe(true);
      expect(pk).toBe(true);
      expect(attrs).not.toContain('signingTime');
    }
  }
});

test('Q4: changes after signing, tampering, signing twice', async () => {
  const q4: unknown[][] = [];
  const base = (await signPdf(fixture('simple-text.pdf'), rsa, { date: DATE })).bytes;

  const annotated = await signAnnotate(base, (doc) => addTextAnnotation(doc));
  const [va] = await validatePdf(annotated);
  q4.push([
    'signed, then a text annotation (incremental)',
    summary(va),
    opensslVerify(annotated, va?.byteRange ?? [], 'q4-annot').ok ? 'ok' : 'fail',
  ]);
  expect(va?.status).toBe('intact-changed-later');

  const signedEnd = (va?.byteRange[2] ?? 0) + (va?.byteRange[3] ?? 0);
  const [vt] = await validatePdf(annotated.slice(0, signedEnd));
  q4.push([
    'the above, truncated at the signed revision ("View signed version")',
    summary(vt),
    '-',
  ]);
  expect(vt?.status).toBe('intact');

  const changed = await signAnnotate(base, (doc) => addContentChange(doc));
  const [vc] = await validatePdf(changed);
  q4.push([
    'signed, then drawText on page 1 (incremental)',
    summary(vc),
    opensslVerify(changed, vc?.byteRange ?? [], 'q4-content').ok ? 'ok' : 'fail',
  ]);
  expect(vc?.status).toBe('changed-after-signing');

  const twice = (await signPdf(base, ec, { date: DATE, name: 'Signature2' })).bytes;
  const vs = await validatePdf(twice);
  q4.push([
    'signed twice (RSA, then ECDSA in a new revision)',
    vs.map(summary).join(' / '),
    vs
      .map((x, i) => (opensslVerify(twice, x.byteRange, `q4-twice-${i}`).ok ? 'ok' : 'fail'))
      .join(' / '),
  ]);
  expect(vs.map((x) => x.status)).toEqual(['intact-changed-later', 'intact']);

  options.useAddAnnot = true;
  const twiceHighLevel = (await signPdf(base, ec, { date: DATE, name: 'Signature2' })).bytes;
  options.useAddAnnot = false;
  const vh = await validatePdf(twiceHighLevel);
  q4.push([
    'signed twice, second via Cantoo PDFPageLeaf.addAnnot',
    vh.map(summary).join(' / '),
    '-',
  ]);

  // 20 seeded random single-byte flips inside the signed ranges.
  let seed = 20260928;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const [v0] = await validatePdf(base);
  const [, b = 0, c = 0, d = 0] = v0?.byteRange ?? [];
  const statuses = new Map<string, number>();
  let osslAccepted = 0;
  for (let i = 0; i < 20; i++) {
    const pos = Math.floor(rand() * (b + d));
    const at = pos < b ? pos : c + (pos - b);
    const t = base.slice();
    t[at] = (t[at] ?? 0) ^ 0x01;
    const vf = await validatePdf(t);
    const key = vf.length ? vf.map((x) => x.status).join('+') : 'no signature found';
    statuses.set(key, (statuses.get(key) ?? 0) + 1);
    if (vf[0] && opensslVerify(t, vf[0].byteRange, `q4-flip-${i}`).ok) osslAccepted++;
    expect(vf.some((x) => x.status === 'intact' || x.status === 'intact-changed-later')).toBe(
      false,
    );
  }
  q4.push([
    '20 random 1-bit flips inside the byte ranges',
    [...statuses].map(([k, n]) => `${k} ×${n}`).join(', '),
    `openssl accepted ${osslAccepted}/20`,
  ]);

  const text = latin1(base);
  const m = /\/ByteRange\s*\[0 (\d+) (\d+) (\d+)/.exec(text);
  const forged = base.slice();
  if (m)
    forged.set(
      ascii(`[0 ${m[1] ?? ''} ${m[2] ?? ''} ${Number(m[3]) - 1}`),
      m.index + m[0].indexOf('['),
    );
  const [vr] = await validatePdf(forged);
  q4.push(['/ByteRange shortened by one byte (last range)', summary(vr), '-']);
  expect(vr?.status).toBe('broken');

  const withTime = await signPdf(fixture('simple-text.pdf'), rsa, {
    date: DATE,
    signingTime: DATE,
  });
  const [vw] = await validatePdf(withTime.bytes);
  opensslVerify(withTime.bytes, withTime.byteRange, 'q4-signingtime');
  q4.push([
    'signingTime as a signed attribute (not PAdES-B)',
    summary(vw),
    opensslSignedAttributes('q4-signingtime').join(', '),
  ]);

  const small = await signPdf(fixture('simple-text.pdf'), rsa, { reserveBytes: 1024 }).then(
    () => 'fitted (!)',
    (e: unknown) => String(e),
  );
  q4.push(['/Contents reserve 1 KB with a 3-certificate chain', small, '-']);
  evidence.q4 = q4;
  writeResult('q4', q4, table(['Scenario', 'Validator', 'openssl'], q4));
});

test('Two commits in a row with object streams; EOL after %%EOF', async () => {
  const probe = await pdfium();
  const src = fixture('many-pages.pdf');
  const out: unknown[][] = [];
  for (const mode of ['same doc, streams', 'reload between, streams', 'same doc, classic table']) {
    let doc = await loadIncremental(src);
    addEmptySignatureField(doc, 'Empty1');
    const first = await doc.commit({ useObjectStreams: mode !== 'same doc, classic table' });
    if (mode.startsWith('reload')) doc = await loadIncremental(first);
    addSignaturePlaceholder(doc, { name: 'Signature1', reserveBytes: 16_384, date: DATE });
    const second = await doc.commit({ useObjectStreams: mode !== 'same doc, classic table' });
    await finishSignature(second, first.length, rsa);
    const chain = await walkChain(second);
    const pj = await pdfjsOpen(second).then(
      (r) => r.sigFields.join(','),
      (e: unknown) => `**${String(e)}**`,
    );
    const pr = probe(second);
    const objStms = chain.sections
      .map((s) =>
        s.entries
          .filter((e) => e.type === 2)
          .map((e) => `${e.num}→${e.field2}`)
          .join(' '),
      )
      .slice(0, 2);
    out.push([
      mode,
      chain.sections.map((s) => `${s.kind}#${s.streamObject ?? '-'}`).join(' ← '),
      objStms.join(' | '),
      pj,
      `${pr.signatures.length} sig objects, validXref ${String(pr.validXref)}`,
      (await validatePdf(second)).map(summary).join('/'),
    ]);
  }
  // PDFium's FPDF_GetTrailerEnds only counts a %%EOF followed by an end-of-line.
  const signed = await signPdf(fixture('simple-text.pdf'), rsa, { date: DATE });
  const withEol = await (async () => {
    const doc = await loadIncremental(fixture('simple-text.pdf'));
    addSignaturePlaceholder(doc, { name: 'Signature1', reserveBytes: 16_384, date: DATE });
    const o = concat([await doc.commit({ useObjectStreams: false }), ascii('\n')]);
    await finishSignature(o, fixture('simple-text.pdf').length, rsa);
    return o;
  })();
  out.push([
    'FPDF_GetTrailerEnds, Cantoo output (no EOL after %%EOF)',
    `file ${signed.bytes.length}`,
    JSON.stringify(probe(signed.bytes).trailerEnds),
    '-',
    '-',
    summary((await validatePdf(signed.bytes))[0]),
  ]);
  out.push([
    'FPDF_GetTrailerEnds, "\\n" appended before patching',
    `file ${withEol.length}`,
    JSON.stringify(probe(withEol).trailerEnds),
    '-',
    '-',
    summary((await validatePdf(withEol))[0]),
  ]);
  writeResult(
    'commits',
    out,
    table(
      [
        'Mode',
        'Xref chain (newest first)',
        'Compressed entries (newest 2 sections)',
        'pdf.js sig fields',
        'PDFium',
        'Validator',
      ],
      out,
    ),
  );
});

test('Validator on workstream F fixtures signed by an independent signer (if present)', async () => {
  const files = existsSync(FIXTURES)
    ? readdirSync(FIXTURES)
        .filter((f) => f.startsWith('signed-') && f.endsWith('.pdf'))
        .sort()
    : [];
  const out: unknown[][] = [];
  for (const f of files) {
    const vs = await validatePdf(fixture(f)).catch((e: unknown) => String(e));
    out.push([
      f,
      typeof vs === 'string'
        ? vs
        : vs
            .map(
              (v) =>
                `${v.subFilter}: ${summary(v)}${v.checks
                  .filter((x) => x.outcome !== 'pass')
                  .map((x) => ` ${x.id}=${x.outcome} (${x.detail})`)
                  .join('')}`,
            )
            .join(' / '),
    ]);
  }
  writeResult(
    'independent',
    out,
    table(['Fixture (F, untracked at run time)', 'Our validator'], out),
  );
});

test('write Q2 table', () => {
  writeResult(
    'signing',
    evidence,
    table(
      [
        'Source',
        'Key',
        'Xref appended',
        'Validator',
        'Non-pass checks',
        'openssl cms -verify',
        'Signed attrs (openssl)',
        'pkijs verify',
        'PDFium',
        'pdf.js',
        'CMS bytes',
        'Added w/o Contents',
        'ms load/commit/digest/cms = total',
      ],
      rows,
    ),
  );
});
