/**
 * Q5 (browser half): PKCS#12 → non-extractable key → sign → validate in Chromium, on the page
 * and in a dedicated module worker; WebCrypto availability; medians of repeated runs.
 */
import * as pkijs from 'pkijs';
import { expect, test } from 'vitest';
import { commands } from 'vitest/browser';

import { loadPkcs12 } from '../src/p12';
import { signPdf } from '../src/sign';
import { validatePdf } from '../src/validate';

const PKI = 'test-results/pki/';
const FIXTURES = '../../test/fixtures/';

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const read = async (path: string) => fromBase64(await commands.readFile(path, 'base64'));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;

test('page and worker pipeline in Chromium', async () => {
  const rows: string[] = [];
  const results: Record<string, unknown> = {
    userAgent: navigator.userAgent,
    secureContext: isSecureContext,
    pkijsEngine: pkijs.getEngine().name,
  };
  for (const [p12Name, label] of [
    ['rsa-openssl3-default.p12', 'RSA-2048'],
    ['ec-openssl3-default.p12', 'ECDSA P-256'],
  ] as const) {
    const p12 = await read(PKI + p12Name);
    for (const pdfName of ['simple-text.pdf', 'many-pages.pdf', 'images.pdf']) {
      const pdf = await read(FIXTURES + pdfName);
      const parse: number[] = [];
      const sign: number[] = [];
      const validate: number[] = [];
      let status = '';
      let extractable = true;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const id = await loadPkcs12(p12.slice().buffer, 'spike-password');
        parse.push(performance.now() - t0);
        extractable = id.key.extractable;
        const r = await signPdf(pdf, id, { date: new Date('2026-09-28T10:00:00Z') });
        sign.push(r.ms.total);
        const t1 = performance.now();
        const [v] = await validatePdf(r.bytes);
        validate.push(performance.now() - t1);
        status = v?.status ?? 'none';
      }
      expect(status).toBe('intact');
      expect(extractable).toBe(false);
      rows.push(
        `| page | ${label} | ${pdfName} (${(pdf.length / 1024).toFixed(1)} KB) | ${median(parse).toFixed(0)} | ${median(sign).toFixed(0)} | ${median(validate).toFixed(0)} | ${status} |`,
      );
    }
    // The same in a dedicated module worker.
    const worker = new Worker(new URL('./sign.worker.ts', import.meta.url), { type: 'module' });
    const pdf = await read(FIXTURES + 'many-pages.pdf');
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<Record<string, unknown>>) => resolve(e.data);
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage({
        p12: p12.slice().buffer,
        password: 'spike-password',
        pdf: pdf.slice().buffer,
      });
    });
    worker.terminate();
    results[`worker-${label}`] = reply;
    expect(reply.error).toBeUndefined();
    expect(reply.status).toBe('intact');
    expect(reply.exportKeySucceeded).toBe(false);
    rows.push(
      `| worker (${String(reply.scope)}) | ${label} | many-pages.pdf | ${Number(reply.parseMs).toFixed(0)} | ${Number(reply.signMs).toFixed(0)} | ${Number(reply.validateMs).toFixed(0)} | ${String(reply.status)} |`,
    );
  }
  const md = [
    `Chromium: ${navigator.userAgent}; secure context ${String(isSecureContext)}; pkijs engine "${pkijs.getEngine().name}"`,
    '',
    '| Where | Key | PDF | p12 parse ms | sign ms | validate ms | status |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
  await commands.writeFile('test-results/browser.md', `${md}\n`);
  await commands.writeFile('test-results/browser.json', `${JSON.stringify(results, null, 2)}\n`);
});
