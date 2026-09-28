/** Q3: PKCS#12 parsing with pkijs for each export flavour; key import as non-extractable. */
import * as pkijs from 'pkijs';
import { expect, test } from 'vitest';

import { loadPkcs12, Pkcs12Error } from '../src/p12';
import { describePkcs12, PASSWORD, PKCS12_CASES, readPki } from '../src/node/pki';
import { table, writeResult } from '../src/node/results';

test('PKCS#12 matrix', async () => {
  const rows: unknown[][] = [];
  const json: unknown[] = [];
  for (const c of PKCS12_CASES) {
    const bytes = readPki(c.file);
    const t0 = performance.now();
    let outcome: string;
    let extractable = '-';
    try {
      const id = await loadPkcs12(bytes.slice().buffer, c.password);
      const ms = performance.now() - t0;
      let exported = false;
      try {
        await crypto.subtle.exportKey('pkcs8', id.key);
        exported = true;
      } catch {
        exported = false;
      }
      expect(exported).toBe(false);
      expect(id.key.extractable).toBe(false);
      extractable = `extractable=${String(id.key.extractable)}, exportKey rejected`;
      outcome = `ok: ${id.keyKind}, chain ${id.chain.length} (${id.protection.bags.join('; ')}; MAC ${id.protection.mac} x${id.protection.iterations}) in ${ms.toFixed(0)} ms`;
      json.push({
        file: c.file,
        ok: true,
        keyKind: id.keyKind,
        chain: id.chain.length,
        protection: id.protection,
        ms,
      });
    } catch (error) {
      const code = error instanceof Pkcs12Error ? error.code : 'unexpected';
      outcome = `refused (${code}): ${(error as Error).message}`;
      json.push({ file: c.file, ok: false, code, message: (error as Error).message });
    }
    rows.push([c.file, c.label, describePkcs12(c) || '-', outcome, extractable]);
  }
  // Wrong password on a good file.
  const wrong = await loadPkcs12(readPki('rsa-openssl3-default.p12').slice().buffer, 'wrong').then(
    () => 'accepted (!)',
    (e: unknown) => `refused (${e instanceof Pkcs12Error ? e.code : 'unexpected'})`,
  );
  rows.push(['rsa-openssl3-default.p12', 'wrong password', '-', wrong, '-']);
  json.push({ file: 'rsa-openssl3-default.p12', wrongPassword: wrong });
  writeResult(
    'pkcs12',
    json,
    `Node ${process.version}, pkijs engine "${pkijs.getEngine().name}" (picked up from globalThis.crypto)\n\n${table(['File', 'Export', 'openssl pkcs12 -info', 'pkijs result', 'Key'], rows)}`,
  );
  expect(wrong).toContain('bad-password');
  expect(PASSWORD).toBeTruthy();
});
