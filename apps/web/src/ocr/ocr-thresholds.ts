/**
 * The engine's OCR confidence thresholds for the entry chunk (ocr-model.ts `OcrThresholds`):
 * read from the engine module, which the engine service loads with the first document, so by
 * the time a page carries recognised text they are here. Until then the OCR section and J / K
 * wait (they have nothing to show before a run anyway).
 */
import { useEffect, useSyncExternalStore } from 'react';

import { type OcrThresholds, thresholdsOf } from './ocr-model';

let value: OcrThresholds | undefined;
let pending: Promise<OcrThresholds> | undefined;
const listeners = new Set<() => void>();

export function loadOcrThresholds(): Promise<OcrThresholds> {
  if (!pending) {
    pending = import('@pdf-editor/engine').then((engine) => {
      value = thresholdsOf(engine);
      for (const listener of listeners) listener();
      return value;
    });
    pending.catch(() => {
      pending = undefined;
    });
  }
  return pending;
}

/** The thresholds when loaded (commands decide synchronously). */
export function ocrThresholdsNow(): OcrThresholds | undefined {
  if (!value) void loadOcrThresholds();
  return value;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The thresholds, loading them on first use. */
export function useOcrThresholds(): OcrThresholds | undefined {
  const current = useSyncExternalStore(subscribe, () => value);
  useEffect(() => {
    if (!current) void loadOcrThresholds();
  }, [current]);
  return current;
}
