/**
 * Q1 (+ Q2 per file): Cantoo's incremental writer on every corpus file. Two commits on one
 * loaded document: (1) an empty /Sig field widget, (2) an approval signature (placeholder,
 * patched /ByteRange, real CMS). Each appended section is checked byte by byte; the result is
 * re-opened by pdf-lib, PDFium, pdf.js, our validator and `openssl cms -verify`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument } from '@cantoo/pdf-lib';
import { expect, test } from 'vitest';

import { isPrefix } from '../src/bytes';
import { loadPkcs12 } from '../src/p12';
import {
  addEmptySignatureField,
  addSignaturePlaceholder,
  loadIncremental,
  options,
  reloadFieldNames,
} from '../src/pdf-edits';
import { finishSignature, signPdf, sourceXrefKind } from '../src/sign';
import { classifyLaterChanges, validatePdf } from '../src/validate';
import { badOffsets, lastStartxref, parseSection, walkChain, type XrefKind } from '../src/xref';
import { opensslVerify, pdfium, pdfjsOpen } from '../src/node/checks';
import { PASSWORD, readPki } from '../src/node/pki';
import { table, writeResult } from '../src/node/results';

const FIXTURES = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));

interface CommitCheck {
  readonly prefix: boolean;
  readonly prevOk: boolean;
  readonly prev?: number;
  readonly expectedPrev?: number;
  readonly kind?: XrefKind;
  readonly badOffsets: number;
  readonly written: number[];
  readonly fromObjStm: number;
  readonly appended: number;
  readonly error?: string;
}

async function compressedInSource(bytes: Uint8Array): Promise<Set<number>> {
  const { sections } = await walkChain(bytes);
  const out = new Set<number>();
  for (const s of sections) for (const e of s.entries) if (e.type === 2) out.add(e.num);
  return out;
}

async function checkCommit(
  prev: Uint8Array,
  out: Uint8Array,
  objStm: Set<number>,
): Promise<CommitCheck> {
  const prefix = isPrefix(prev, out);
  const expectedPrev = lastStartxref(prev);
  const at = lastStartxref(out);
  try {
    if (at === undefined || at < prev.length) throw new Error('startxref not in the new section');
    const s = await parseSection(out, at);
    const written = s.entries
      .filter((e) => e.type !== 0 && e.num !== s.streamObject)
      .map((e) => e.num);
    return {
      prefix,
      prevOk: s.prev !== undefined && s.prev === expectedPrev,
      ...(s.prev === undefined ? {} : { prev: s.prev }),
      ...(expectedPrev === undefined ? {} : { expectedPrev }),
      kind: s.kind,
      badOffsets: badOffsets(out, s).length,
      written,
      fromObjStm: written.filter((n) => objStm.has(n)).length,
      appended: out.length - prev.length,
    };
  } catch (error) {
    return {
      prefix,
      prevOk: false,
      badOffsets: -1,
      written: [],
      fromObjStm: 0,
      appended: out.length - prev.length,
      error: (error as Error).message,
    };
  }
}

const yes = (b: boolean): string => (b ? 'yes' : '**no**');

test('Cantoo incremental writer on the corpus', async () => {
  const identity = await loadPkcs12(readPki('rsa-openssl3-default.p12').slice().buffer, PASSWORD);
  const probe = await pdfium();
  // The 30 committed fixtures (workstream F adds files to test/fixtures in parallel).
  const files = execFileSync('git', ['ls-files', '*.pdf'], { cwd: FIXTURES, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort();
  const rows: unknown[][] = [];
  const json: unknown[] = [];
  let defaultMismatch = 0;
  for (const file of files) {
    const src = new Uint8Array(readFileSync(join(FIXTURES, file)));
    const password = file.startsWith('encrypted-') ? 'owner' : undefined;
    const srcKind = await sourceXrefKind(src);
    const objStm = await compressedInSource(src);
    const srcSections = (await walkChain(src)).sections.length;
    const row: Record<string, unknown> = {
      file,
      bytes: src.length,
      srcKind,
      objStm: objStm.size,
      srcSections,
    };
    try {
      // Cantoo's default (no option): what kind does it append?
      const probeDoc = await loadIncremental(src, password);
      addEmptySignatureField(probeDoc, 'Probe');
      const def = await probeDoc.commit();
      const defKind = (await parseSection(def, lastStartxref(def) ?? 0).catch(() => undefined))
        ?.kind;
      row.defaultKind = defKind;
      if (defKind !== srcKind) defaultMismatch++;

      const useObjectStreams = srcKind === 'stream';
      const doc = await loadIncremental(src, password);
      addEmptySignatureField(doc, 'Empty1');
      const out1 = await doc.commit({ useObjectStreams });
      const c1 = await checkCommit(src, out1, objStm);
      addSignaturePlaceholder(doc, {
        name: 'Signature1',
        reserveBytes: 16_384,
        date: new Date('2026-09-28T10:00:00Z'),
      });
      const out2 = await doc.commit({ useObjectStreams });
      const c2 = await checkCommit(out1, out2, objStm);
      const signed = await finishSignature(out2, out1.length, identity);
      const chain = await walkChain(out2);
      const names = await reloadFieldNames(out2, password).catch((e: unknown) => [
        `error: ${String(e)}`,
      ]);
      const pdfiumReport = probe(out2, password ?? '');
      const pdfiumSig = pdfiumReport.signatures.find(
        (s) => s.byteRange.join() === signed.byteRange.join(),
      );
      const validation = await validatePdf(out2);
      const ours = validation.find((v) => v.byteRange.join() === signed.byteRange.join());
      const ossl = opensslVerify(out2, signed.byteRange, `corpus-${file.replace(/\.pdf$/, '')}`);
      const pdfjs = await pdfjsOpen(out2, password).catch((e: unknown) => ({
        pages: -1,
        sigFields: [String(e)],
      }));
      const kinds = (await classifyLaterChanges(out2, src.length)).map((k) => k.kind).sort();
      // The same two changes through Cantoo's high-level PDFPageLeaf.addAnnot.
      options.useAddAnnot = true;
      const hl = await loadIncremental(src, password);
      addEmptySignatureField(hl, 'Empty1');
      await hl.commit({ useObjectStreams });
      addSignaturePlaceholder(hl, {
        name: 'Signature1',
        reserveBytes: 16_384,
        date: new Date('2026-09-28T10:00:00Z'),
      });
      const hlOut = await hl.commit({ useObjectStreams });
      options.useAddAnnot = false;
      const hlKinds = (await classifyLaterChanges(hlOut, src.length)).map((k) => k.kind).sort();
      // The product path: sign the export output (a full Cantoo save with object streams,
      // as pdflib-assembler writes unencrypted exports).
      let exportCell = 'n/a (encrypted export refused)';
      if (!password) {
        const full = await PDFDocument.load(src, { updateMetadata: false, preserveXFA: true });
        const exported = await full.save({
          useObjectStreams: true,
          addDefaultPage: false,
          updateFieldAppearances: false,
        });
        const signedExport = await signPdf(exported, identity, {
          date: new Date('2026-09-28T10:00:00Z'),
        });
        const exportedObjStm = await compressedInSource(exported);
        const ce = await checkCommit(exported, signedExport.bytes, exportedObjStm);
        const v = (await validatePdf(signedExport.bytes))[0];
        const pr = probe(signedExport.bytes);
        const pj = await pdfjsOpen(signedExport.bytes).catch(() => ({
          pages: -1,
          sigFields: [] as string[],
        }));
        const os = opensslVerify(
          signedExport.bytes,
          signedExport.byteRange,
          `export-${file.replace(/\.pdf$/, '')}`,
        );
        const ok =
          ce.prefix &&
          ce.prevOk &&
          ce.kind === 'stream' &&
          ce.badOffsets === 0 &&
          v?.status === 'intact' &&
          pr.validXref === true &&
          pr.signatures.length === 1 &&
          pj.sigFields.includes('Signature1') &&
          os.ok;
        exportCell = ok
          ? `ok (+${signedExport.appendedWithoutContents} B; ${ce.written.length} objects, ${ce.fromObjStm} were in an ObjStm of ${exportedObjStm.size})`
          : `**${String(v?.status)} ${String(pr.validXref)} ${pj.pages} ${String(os.ok)}**`;
        row.export = {
          status: v?.status,
          pdfiumValidXref: pr.validXref,
          pdfjs: pj,
          openssl: os.ok,
          appended: signedExport.appendedWithoutContents,
          kind: signedExport.xrefKind,
        };
      }
      Object.assign(row, {
        c1,
        c2,
        chainSections: chain.sections.length,
        chainError: chain.error,
        reloadNames: names,
        pdfium: {
          ...pdfiumReport,
          signatures: pdfiumReport.signatures.length,
          sigMatches: pdfiumSig !== undefined,
          subFilter: pdfiumSig?.subFilter,
        },
        validator: ours?.status ?? 'not found',
        validatorChecks: ours?.checks,
        openssl: ossl.ok,
        opensslOutput: ossl.output.trim().slice(0, 200),
        pdfjs,
        cmsBytes: signed.cmsBytes,
        kinds,
        highLevelKinds: hlKinds,
      });
      rows.push([
        file,
        `${srcKind}${objStm.size ? ` (${objStm.size} in ObjStm)` : ''}`,
        defKind === srcKind ? defKind : `**${String(defKind)}**`,
        `${yes(c1.prefix)} / ${yes(c2.prefix)}`,
        `${yes(c1.prevOk)} / ${yes(c2.prevOk)}`,
        `${c1.kind === srcKind ? 'yes' : `**${String(c1.kind)}**`} / ${c2.kind === srcKind ? 'yes' : `**${String(c2.kind)}**`}`,
        `${c1.badOffsets} / ${c2.badOffsets}`,
        `${c1.written.length}+${c2.written.length} (${c1.fromObjStm + c2.fromObjStm} from ObjStm)`,
        `${c1.appended} / ${c2.appended - 32_768}`,
        `${chain.sections.length}${chain.error ? ` (${chain.error})` : ''}`,
        names.includes('Empty1') && names.includes('Signature1') ? 'yes' : `**${names.join(',')}**`,
        pdfiumReport.opened
          ? `${pdfiumReport.validXref ? 'xref ok' : '**rebuilt**'}, ${pdfiumReport.trailerEnds?.length ?? 0} ends, ${pdfiumSig ? 'range ok' : '**no range**'}`
          : `**not opened (${pdfiumReport.error ?? '?'})**`,
        pdfjs.pages > 0
          ? pdfjs.sigFields.includes('Signature1')
            ? 'yes'
            : '**no field**'
          : '**failed**',
        ours?.status ?? '**none**',
        ossl.ok ? 'ok' : '**fail**',
        kinds.join(', '),
        hlKinds.join(', '),
        exportCell,
      ]);
    } catch (error) {
      row.error = (error as Error).message;
      rows.push([
        file,
        srcKind,
        '-',
        `**load/commit failed: ${(error as Error).message.slice(0, 80)}**`,
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ]);
    }
    json.push(row);
  }
  writeResult(
    'corpus',
    { defaultMismatch, files: json },
    table(
      [
        'File',
        'Source xref',
        'Cantoo default kind',
        'Prefix identical (c1/c2)',
        '/Prev right',
        'Kind matches',
        'Bad offsets',
        'Objects written',
        'Bytes appended (c1 / c2 w/o Contents)',
        'Sections in chain',
        'pdf-lib reopen',
        'PDFium',
        'pdf.js sig field',
        'Validator',
        'openssl cms',
        'Classifier: c1+c2',
        'Same via addAnnot',
        'Sign export output',
      ],
      rows,
    ),
  );
  expect(json.length).toBe(30);
  expect(json.filter((r) => (r as { error?: string }).error !== undefined)).toEqual([]);
});
