/**
 * Appearance settings (spec craft §7, §8): "Glass panels" (the docked frame becomes the tier-2
 * glass while a page passes beneath it; default off, a trial measured by spike S2) and
 * "Reduce transparency" (every glass tier paints its solid token, the in-app twin of
 * `prefers-reduced-transparency`, which Safari does not report). Persisted in
 * `pdf-editor:appearance:v1`, validated field by field; both default to off.
 *
 * The settings reach CSS as attributes on the document element: `data-glass-panels` and
 * `data-transparency="reduced"` (`tokens.css`, `global.css`), applied by `useAppearanceRoot`.
 */
import { useLayoutEffect } from 'react';
import { create } from 'zustand';

import { readJson, writeJson } from './safe-storage';

export const APPEARANCE_STORAGE_KEY = 'pdf-editor:appearance:v1';

export interface AppearanceSettings {
  readonly glassPanels: boolean;
  readonly reduceTransparency: boolean;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  glassPanels: false,
  reduceTransparency: false,
};

interface AppearanceState extends AppearanceSettings {
  setGlassPanels(on: boolean): void;
  setReduceTransparency(on: boolean): void;
}

/** Stored settings, field by field: anything but a boolean falls back to the default. */
export function parseAppearance(value: unknown): AppearanceSettings {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const flag = (key: keyof AppearanceSettings): boolean => {
    const field = record[key];
    return typeof field === 'boolean' ? field : DEFAULT_APPEARANCE[key];
  };
  return { glassPanels: flag('glassPanels'), reduceTransparency: flag('reduceTransparency') };
}

export function loadAppearance(): AppearanceSettings {
  return parseAppearance(readJson(APPEARANCE_STORAGE_KEY));
}

export const useAppearanceStore = create<AppearanceState>()((set) => ({
  ...loadAppearance(),
  setGlassPanels: (on) => set({ glassPanels: on }),
  setReduceTransparency: (on) => set({ reduceTransparency: on }),
}));

useAppearanceStore.subscribe((state, previous) => {
  if (
    state.glassPanels === previous.glassPanels &&
    state.reduceTransparency === previous.reduceTransparency
  ) {
    return;
  }
  const settings: AppearanceSettings = {
    glassPanels: state.glassPanels,
    reduceTransparency: state.reduceTransparency,
  };
  writeJson(APPEARANCE_STORAGE_KEY, settings);
});

/** Writes the settings onto `root` as the attributes the style sheets read. */
export function applyAppearance(root: HTMLElement, settings: AppearanceSettings): void {
  root.toggleAttribute('data-glass-panels', settings.glassPanels);
  if (settings.reduceTransparency) root.setAttribute('data-transparency', 'reduced');
  else root.removeAttribute('data-transparency');
}

/**
 * Keeps the document element's attributes in step with the settings while the caller is
 * mounted (the app shell); before the first paint, so the frame never flashes.
 */
export function useAppearanceRoot(): void {
  const glassPanels = useAppearanceStore((s) => s.glassPanels);
  const reduceTransparency = useAppearanceStore((s) => s.reduceTransparency);
  useLayoutEffect(() => {
    const root = document.documentElement;
    applyAppearance(root, { glassPanels, reduceTransparency });
    return () => applyAppearance(root, DEFAULT_APPEARANCE);
  }, [glassPanels, reduceTransparency]);
}
