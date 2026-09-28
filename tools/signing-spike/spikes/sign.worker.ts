/** Q5: the whole pipeline inside a dedicated module worker (the planned signature worker). */
import * as pkijs from 'pkijs';

import { loadPkcs12 } from '../src/p12';
import { signPdf } from '../src/sign';
import { validatePdf } from '../src/validate';

export interface WorkerRequest {
  readonly p12: ArrayBuffer;
  readonly password: string;
  readonly pdf: ArrayBuffer;
}

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void (async () => {
    try {
      const { p12, password, pdf } = event.data;
      const t0 = performance.now();
      const id = await loadPkcs12(p12, password);
      const parseMs = performance.now() - t0;
      const exported = await crypto.subtle.exportKey('pkcs8', id.key).then(
        () => true,
        () => false,
      );
      const signed = await signPdf(new Uint8Array(pdf), id, {
        date: new Date('2026-09-28T10:00:00Z'),
      });
      const t1 = performance.now();
      const [v] = await validatePdf(signed.bytes);
      const validateMs = performance.now() - t1;
      self.postMessage({
        scope: self.constructor.name,
        secureContext: self.isSecureContext,
        subtle: typeof crypto.subtle,
        pkijsEngine: pkijs.getEngine().name,
        keyExtractable: id.key.extractable,
        exportKeySucceeded: exported,
        parseMs,
        signMs: signed.ms.total,
        validateMs,
        status: v?.status,
        bytes: signed.bytes.length,
      });
    } catch (error) {
      self.postMessage({ error: String(error) });
    }
  })();
});
