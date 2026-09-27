/**
 * QpdfPlumber (ADR-0008): repair, object streams, encryption and linearization through
 * qpdf built from source (packages/engine/qpdf/build.sh). Outputs are re-parsed with
 * pdf-lib and PDFium.
 */
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import qpdfWasmUrl from '../qpdf/dist/qpdf.wasm?url';
import brokenXrefUrl from '../../../test/fixtures/broken-xref.pdf?url';
import garbagePrefixUrl from '../../../test/fixtures/garbage-prefix.pdf?url';
import manyPagesUrl from '../../../test/fixtures/many-pages.pdf?url';
import simpleTextUrl from '../../../test/fixtures/simple-text.pdf?url';
import truncatedUrl from '../../../test/fixtures/truncated.pdf?url';
import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import { QpdfPlumber } from '../src/plumber/qpdf-plumber';
import { qpdfArgs } from '../src/plumber/qpdf-args';
import type { SourceId } from '@pdf-editor/document-model';
import { wasmUrl } from './helpers';

const fetchBytes = async (url: string) => (await fetch(url)).arrayBuffer();

let plumber: QpdfPlumber;
let adapter: PdfiumAdapter;
let counter = 0;

beforeAll(() => {
  plumber = new QpdfPlumber({ wasmUrl: qpdfWasmUrl });
  adapter = new PdfiumAdapter({ wasmUrl });
});
afterAll(async () => {
  await adapter.destroy();
});

async function pdfiumPages(bytes: ArrayBuffer, password?: string) {
  const id = `plumb-${++counter}` as SourceId;
  const opened = await adapter.open(id, bytes.slice(0), password === undefined ? {} : { password });
  await adapter.close(id);
  return opened;
}

describe('qpdf arguments', () => {
  it('maps every option to qpdf flags', () => {
    const args = qpdfArgs({
      objectStreams: 'generate',
      recompressFlate: true,
      removeUnreferencedResources: true,
      linearize: true,
      decrypt: { password: 'pw' },
    });
    expect(args).toEqual([
      '--password=pw',
      '--decrypt',
      '--object-streams=generate',
      '--recompress-flate',
      '--compression-level=9',
      '--remove-unreferenced-resources=yes',
      '--linearize',
      '/work/in.pdf',
      '/work/out.pdf',
    ]);
    const encrypt = qpdfArgs({
      encrypt: {
        algorithm: 'aes-256',
        userPassword: 'u',
        ownerPassword: 'o',
        permissions: {
          print: true,
          printHighQuality: false,
          modify: false,
          copy: false,
          annotate: true,
          fillForms: true,
          accessibility: true,
          assemble: false,
        },
      },
    });
    expect(encrypt.slice(0, -2)).toEqual([
      '--encrypt',
      '--user-password=u',
      '--owner-password=o',
      '--bits=256',
      '--print=low',
      '--modify=none',
      '--extract=n',
      '--annotate=y',
      '--form=y',
      '--assemble=n',
      '--accessibility=y',
      '--',
    ]);
  });
});

describe('QpdfPlumber', () => {
  it.each([
    ['broken-xref.pdf', brokenXrefUrl],
    ['garbage-prefix.pdf', garbagePrefixUrl],
    ['truncated.pdf', truncatedUrl],
  ])('repairs %s into a file pdf-lib and PDFium read cleanly', async (_name, url) => {
    const result = await plumber.process(await fetchBytes(url));
    expect(result.repaired).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    const doc = await PDFDocument.load(result.bytes.slice(0), { updateMetadata: false });
    expect(doc.getPageCount()).toBe(3);
    const opened = await pdfiumPages(result.bytes);
    expect(opened.pageCount).toBe(3);
    // The rewrite has a sound xref chain: our own check no longer flags it.
    expect(opened.flags.repaired).toBe(false);
    // And qpdf itself finds nothing left to fix.
    const check = await plumber.check(result.bytes.slice(0));
    expect(check.ok, check.warnings.join('\n')).toBe(true);
  });

  it('reports a sound file as not repaired', async () => {
    const result = await plumber.process(await fetchBytes(simpleTextUrl), {
      objectStreams: 'generate',
    });
    expect(result.repaired).toBe(false);
    expect(result.warnings).toEqual([]);
    const check = await plumber.check(await fetchBytes(simpleTextUrl));
    expect(check).toMatchObject({ ok: true, repaired: false, encrypted: false, version: '1.7' });
  });

  it('check lists structural warnings of a damaged file', async () => {
    const check = await plumber.check(await fetchBytes(brokenXrefUrl));
    expect(check.repaired).toBe(true);
    expect(check.ok).toBe(false);
    expect(check.warnings.join('\n')).toMatch(/xref|damaged|reconstruct/i);
  });

  it('round-trips AES-256 encryption with permissions', async () => {
    const encrypted = await plumber.process(await fetchBytes(simpleTextUrl), {
      encrypt: {
        algorithm: 'aes-256',
        userPassword: 'user',
        ownerPassword: 'owner',
        permissions: {
          print: true,
          printHighQuality: true,
          modify: false,
          copy: false,
          annotate: false,
          fillForms: true,
          accessibility: true,
          assemble: false,
        },
      },
    });
    await expect(pdfiumPages(encrypted.bytes)).rejects.toMatchObject({
      code: 'password-required',
    });
    const opened = await pdfiumPages(encrypted.bytes, 'user');
    expect(opened.pageCount).toBe(3);
    expect(opened.flags.encrypted).toBe(true);
    const viaPdfLib = await PDFDocument.load(encrypted.bytes.slice(0), {
      updateMetadata: false,
      password: 'user',
    });
    expect(viaPdfLib.getPageCount()).toBe(3);
    const check = await plumber.check(encrypted.bytes.slice(0), 'owner');
    expect(check.encrypted).toBe(true);

    await expect(
      plumber.process(encrypted.bytes.slice(0), { decrypt: { password: 'wrong' } }),
    ).rejects.toMatchObject({ code: 'password-incorrect' });
    const decrypted = await plumber.process(encrypted.bytes.slice(0), {
      decrypt: { password: 'user' },
    });
    const plain = await pdfiumPages(decrypted.bytes);
    expect(plain.flags.encrypted).toBe(false);
    expect(plain.pageCount).toBe(3);
  });

  it('linearizes (qpdf --check agrees and PDFium reads the hint stream file)', async () => {
    const result = await plumber.process(await fetchBytes(manyPagesUrl), { linearize: true });
    const head = new TextDecoder('latin1').decode(new Uint8Array(result.bytes, 0, 1024));
    expect(head).toMatch(/\/Linearized\s+1/);
    const check = await plumber.check(result.bytes.slice(0));
    expect(check.linearized).toBe(true);
    expect(check.ok, check.warnings.join('\n')).toBe(true);
    const opened = await pdfiumPages(result.bytes);
    expect(opened.pageCount).toBe(400);
    expect(opened.flags.linearized).toBe(true);
  });

  it('refuses inputs above the size bound without loading them', async () => {
    const huge = { byteLength: 513 * 1024 * 1024 } as ArrayBuffer;
    await expect(plumber.process(huge)).rejects.toMatchObject({ code: 'out-of-memory' });
  });
});
