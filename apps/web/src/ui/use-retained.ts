import { useState } from 'react';

/**
 * Keeps the last non-null value while a dialog animates closed. Base UI finishes a
 * dialog's exit transition on its popup; unmounting the popup as soon as the dialog's
 * subject goes away leaves the backdrop stuck in its ending style, blocking clicks. Render
 * from the returned value and call `release` from `onOpenChangeComplete(false)`.
 */
export function useRetained<T>(value: T | null): readonly [T | null, () => void] {
  const [retained, setRetained] = useState<T | null>(value);
  if (value !== null && value !== retained) setRetained(value);
  return [value ?? retained, () => setRetained(null)] as const;
}
