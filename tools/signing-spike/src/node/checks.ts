/** Node-only cross-checks: PDFium from its wasm file, `openssl cms -verify`, pdf.js. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { concat, fromHex, latin1 } from '../bytes';
import { createPdfiumProbe, type PdfiumProbe } from '../pdfium-probe';
import { opensslStatus, PKI, RESULTS } from './pki';

const require = createRequire(import.meta.url);

let probe: Promise<PdfiumProbe> | undefined;
export function pdfium(): Promise<PdfiumProbe> {
  probe ??= createPdfiumProbe(
    new Uint8Array(readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'))).buffer,
  );
  return probe;
}

/**
 * `openssl cms -verify -binary` of the embedded CMS over the bytes outside /Contents, chain
 * checked against the test root (`-purpose any`: the test leaf has no extendedKeyUsage).
 */
export function opensslVerify(
  bytes: Uint8Array,
  byteRange: readonly number[],
  tag: string,
): { ok: boolean; output: string } {
  const [a = 0, b = 0, c = 0, d = 0] = byteRange;
  const dir = join(RESULTS, 'openssl');
  mkdirSync(dir, { recursive: true });
  // Strip the zero padding by the DER length (the DER itself may end in 00 bytes).
  const padded = fromHex(latin1(bytes, b + 1, c - 1));
  writeFileSync(join(dir, `${tag}.p7s`), padded.subarray(0, derLength(padded) ?? padded.length));
  writeFileSync(
    join(dir, `${tag}.content`),
    concat([bytes.subarray(a, a + b), bytes.subarray(c, c + d)]),
  );
  return opensslStatus([
    'cms',
    '-verify',
    '-binary',
    '-inform',
    'DER',
    '-in',
    join(dir, `${tag}.p7s`),
    '-content',
    join(dir, `${tag}.content`),
    '-CAfile',
    join(PKI, 'root.crt'),
    '-purpose',
    'any',
    '-out',
    join(dir, `${tag}.out`),
  ]);
}

/** Signed attributes as openssl prints them (`cms -cmsout -print`). */
export function opensslSignedAttributes(tag: string): string[] {
  const r = opensslStatus([
    'cms',
    '-cmsout',
    '-print',
    '-inform',
    'DER',
    '-in',
    join(RESULTS, 'openssl', `${tag}.p7s`),
  ]);
  return [...r.output.matchAll(/object: ([A-Za-z0-9-]+) \(([\d.]+)\)/g)].map((m) => m[1] ?? '');
}

function derLength(der: Uint8Array): number | undefined {
  if (der[0] !== 0x30) return undefined;
  const first = der[1] ?? 0;
  if (first < 0x80) return 2 + first;
  const n = first & 0x7f;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + (der[2 + i] ?? 0);
  return 2 + n + len;
}

/** pdf.js (legacy build, fake worker in Node): page count and signature field names. */
export async function pdfjsOpen(
  bytes: Uint8Array,
  password?: string,
): Promise<{ pages: number; sigFields: string[] }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    ...(password === undefined ? {} : { password }),
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const annots = (await page.getAnnotations()) as { fieldType?: string; fieldName?: string }[];
    const sigFields = annots.filter((a) => a.fieldType === 'Sig').map((a) => a.fieldName ?? '?');
    return { pages: doc.numPages, sigFields };
  } finally {
    await task.destroy();
  }
}
