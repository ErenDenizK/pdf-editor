/**
 * Mounts the Batch dialog while it is open; its code (and the runner, the recipe editor and
 * the storage) loads on first use, outside the entry chunk.
 */
import { lazy, Suspense } from 'react';

import { useBatchStore } from './batch-store';

const BatchDialog = lazy(() => import('./BatchDialog'));

export function BatchDialogHost() {
  const open = useBatchStore((s) => s.open);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <BatchDialog />
    </Suspense>
  );
}
