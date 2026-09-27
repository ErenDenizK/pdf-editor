/**
 * Display math for the compression UI with no engine runtime imports, so the export
 * dialog's summary row (main chunk) can use it.
 */
import type { CompressionProgress } from '@pdf-editor/engine';

/** Saved share as a signed whole percentage for display: 1000 → 600 is -40. */
export function deltaPercent(before: number, after: number): number {
  if (before <= 0) return 0;
  const value = Math.round(((after - before) / before) * 100);
  // Never show "-0" for a tiny saving, nor 0 for a real one.
  if (value === 0 && after < before) return -1;
  // Nor -100 while something is left.
  if (value <= -100 && after > 0) return -99;
  return value;
}

/** Share (0–100) of the progress bar for a compression progress report. */
export function progressShare(progress: CompressionProgress | null): number {
  if (progress === null) return 0;
  const part = progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
  switch (progress.phase) {
    case 'analyzing':
      return 5 * part;
    case 'images':
      return 5 + 75 * part;
    case 'lossless':
      return 80 + 15 * part;
    case 'finishing':
      return 95 + 5 * part;
  }
}
