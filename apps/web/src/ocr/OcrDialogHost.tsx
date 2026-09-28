/**
 * Mounts the OCR dialog while it is open; its code (and the engine helpers it uses) loads
 * on first use, outside the entry chunk. tesseract.js loads later still, on the first run.
 */
import { lazy, Suspense } from 'react';

import { useOcrStore } from './ocr-store';

const OcrDialog = lazy(() => import('./OcrDialog'));

export function OcrDialogHost() {
  const open = useOcrStore((s) => s.dialog !== null);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <OcrDialog />
    </Suspense>
  );
}
