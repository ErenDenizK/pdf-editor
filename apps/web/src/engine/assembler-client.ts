/**
 * The app's assembly worker (pdf-lib): assembles exports and inspects sources for the
 * PDFium adapter (page labels, /Lang). One long-lived worker, created on first use.
 *
 * Vite's `?worker` import bundles the engine's worker entry as a same-origin module worker
 * (`worker.format: 'es'`), which the CSP allows (`worker-src 'self'`). A bare specifier in
 * `new URL(…, import.meta.url)` is not resolved by Vite, so the documented `?worker` form is
 * used. The engine code is loaded lazily so it stays out of the entry chunk.
 */
import AssemblerWorker from '@pdf-editor/engine/assembler.worker?worker';
import type { AssemblerProxy } from '@pdf-editor/engine';

let shared: Promise<AssemblerProxy> | undefined;

export function getAssembler(): Promise<AssemblerProxy> {
  if (shared === undefined) {
    const created = import('@pdf-editor/engine').then(({ createAssemblerProxy }) =>
      createAssemblerProxy(new AssemblerWorker({ name: 'recto assembler' })),
    );
    created.catch(() => {
      if (shared === created) shared = undefined;
    });
    shared = created;
  }
  return shared;
}

/** Terminates the worker (tests, teardown). */
export async function disposeAssembler(): Promise<void> {
  const current = shared;
  shared = undefined;
  (await current)?.dispose();
}
