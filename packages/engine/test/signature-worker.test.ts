/**
 * The signature worker across Comlink (M5 W3): transferred buffers, progress, abort, errors
 * with their reason, terminate; and the `listFormFields` pairing of signatures by /V.
 */
import p256Url from '../../../test/fixtures/pki/signer-p256.p12?url';
import legacyUrl from '../../../test/fixtures/pki/signer-rsa-legacy-3des.p12?url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { commands } from 'vitest/browser';

import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import { signPdf } from '../src/signatures/sign';
import { EngineError, SigningError } from '../src/types';
import { createSignatureProxy, type SignatureProxy } from '../src/worker/signature-proxy';
import { sid, wasmUrl } from './helpers';

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const fixture = async (name: string) =>
  fromBase64(await commands.readFile(`../../test/fixtures/${name}`, 'base64')).buffer;
const fetchBuffer = async (url: string) => (await fetch(url)).arrayBuffer();

const newProxy = () =>
  createSignatureProxy(
    new Worker(new URL('../src/worker/signature.worker.ts', import.meta.url), { type: 'module' }),
  );

describe('signature worker', () => {
  let proxy: SignatureProxy;
  beforeAll(() => {
    proxy = newProxy();
  });
  afterAll(() => {
    proxy.terminate();
  });

  test('validates transferred bytes; unsigned files give an empty list', async () => {
    const bytes = await fixture('signed-twice.pdf');
    const reports = await proxy.validateSignatures(bytes);
    expect(bytes.byteLength).toBe(0);
    expect(reports.map((r) => [r.fieldName, r.status])).toEqual([
      ['Approval', 'intact-changed-later'],
      ['Second approval', 'intact'],
    ]);
    await expect(proxy.validateSignatures(await fixture('simple-text.pdf'))).resolves.toEqual([]);
    const signed = await proxy.revisionBytes(await fixture('signed-twice.pdf'), 2);
    expect(signed.byteLength).toBe(20273);
  });

  test('signs with progress; the .p12 and PDF buffers are transferred', async () => {
    const pdf = await fixture('simple-text.pdf');
    const pkcs12 = await fetchBuffer(p256Url);
    const progress: [number, number][] = [];
    const result = await proxy.signPdf(
      pdf,
      {
        pkcs12,
        password: 'test-only',
        reason: 'Worker',
        visible: { pageIndex: 0, rect: { x: 350, y: 40, width: 200, height: 40 } },
      },
      { onProgress: (done, total) => progress.push([done, total]) },
    );
    expect(pdf.byteLength).toBe(0);
    expect(pkcs12.byteLength).toBe(0);
    expect(result.report.status).toBe('intact');
    expect(result.report.signatureAlgorithm).toBe('ECDSA P-256');
    expect(progress.at(-1)).toEqual([5, 5]);
    const reports = await proxy.validateSignatures(result.bytes.slice(0));
    expect(reports.map((r) => r.status)).toEqual(['intact']);
  });

  test('refusals arrive as SigningError with their reason', async () => {
    const error = await proxy
      .signPdf(await fixture('simple-text.pdf'), {
        pkcs12: await fetchBuffer(legacyUrl),
        password: 'test-only',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SigningError);
    expect((error as SigningError).reason).toBe('legacy-pkcs12');
    expect((error as SigningError).code).toBe('unsupported');
    const encrypted = await proxy
      .signPdf(await fixture('encrypted-aes-128.pdf'), {
        pkcs12: await fetchBuffer(p256Url),
        password: 'test-only',
      })
      .catch((e: unknown) => e);
    expect((encrypted as SigningError).reason).toBe('encrypted-input');
  });

  test('abort before and during a call', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const before = await proxy
      .validateSignatures(await fixture('signed-approval.pdf'), { signal: aborted.signal })
      .catch((e: unknown) => e);
    expect((before as EngineError).code).toBe('aborted');
    const controller = new AbortController();
    const pending = proxy
      .signPdf(
        await fixture('many-pages.pdf'),
        { pkcs12: await fetchBuffer(p256Url), password: 'test-only' },
        { signal: controller.signal },
      )
      .catch((e: unknown) => e);
    controller.abort();
    const during = await pending;
    expect(during).toBeInstanceOf(EngineError);
    expect((during as EngineError).code).toBe('aborted');
  });

  test('terminate ends the worker (a fresh one is needed afterwards)', async () => {
    const own = newProxy();
    await expect(
      own.validateSignatures(await fixture('signed-approval.pdf')),
    ).resolves.toHaveLength(1);
    own.terminate();
  });
});

describe('listFormFields pairs signatures by /V', () => {
  let adapter: PdfiumAdapter;
  beforeAll(() => {
    adapter = new PdfiumAdapter({ wasmUrl });
  });
  afterAll(async () => {
    await adapter.destroy();
  });

  test('signed-empty-field.pdf: the unsigned field is not reported as signed', async () => {
    const opened = await adapter.open(sid('empty'), await fixture('signed-empty-field.pdf'));
    expect(opened.flags.hasSignatures).toBe(true);
    const fields = await adapter.listFormFields(sid('empty'));
    const reviewer = fields.find((f) => f.name === 'Reviewer');
    const approval = fields.find((f) => f.name === 'Approval');
    expect(reviewer?.kind).toBe('signature');
    expect(reviewer?.signature).toBeUndefined();
    expect(approval?.signature).toEqual({
      signer: 'pdf-editor Test Signer',
      date: 'D:20240101000000Z',
      reason: 'Approved (pdf-editor test fixture)',
    });
    await adapter.close(sid('empty'));
  });

  test('signed-twice.pdf: each field gets its own signature', async () => {
    await adapter.open(sid('twice'), await fixture('signed-twice.pdf'));
    const fields = await adapter.listFormFields(sid('twice'));
    expect(fields.map((f) => [f.name, f.signature?.date])).toEqual([
      ['Approval', 'D:20240101000000Z'],
      ['Second approval', 'D:20240102000000Z'],
    ]);
    await adapter.close(sid('twice'));
  });

  test('an unsigned field listed before a signed one on a later page (order differs from /Fields)', async () => {
    // Sign page 2 of a file whose page 1 has an unsigned /Sig field listed after it in /Fields.
    const base = new Uint8Array(await fixture('signed-empty-field.pdf'));
    const signed = await signPdf(base, {
      pkcs12: await fetchBuffer(p256Url),
      password: 'test-only',
      fieldName: 'Late',
      date: '2026-09-28T10:00:00.000Z',
      visible: { pageIndex: 2, rect: { x: 72, y: 72, width: 180, height: 40 } },
    });
    await adapter.open(sid('late'), signed.bytes);
    const fields = await adapter.listFormFields(sid('late'));
    expect(fields.map((f) => [f.name, f.pageIndex, f.signature !== undefined])).toEqual([
      ['Reviewer', 0, false],
      ['Approval', 0, true],
      ['Late', 2, true],
    ]);
    expect(fields.find((f) => f.name === 'Late')?.signature?.signer).toBe(
      'pdf-editor Test Signer P-256',
    );
    await adapter.close(sid('late'));
  });
});
