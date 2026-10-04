/**
 * Plug-in points of the tool bar for the pen (experience-redesign spec §6.2). Until the pen
 * presets register, the Draw group shows one Pen button and the options tier shows the
 * pen's tool style.
 *
 *   // annotations/pen/index.ts
 *   registerPenSlots({ Bar: PenPresets, Tier: PenPresetEditor });
 *
 * `Bar` renders in the Draw group where the Pen button is: buttons (or a radiogroup) that
 * take part in the bar's roving tabindex, which moves over every enabled button in the bar
 * in DOM order. A slot that uses the arrow keys itself (a radiogroup) calls
 * `preventDefault()` on them and the bar leaves them alone. `Tier` renders in the options
 * tier while the pen is armed and nothing is selected.
 */
import { type ComponentType, useSyncExternalStore } from 'react';

export interface PenBarProps {
  /** Whether the pen tool is armed. */
  readonly armed: boolean;
  /** Arms the pen the way its shortcut does (P). */
  readonly arm: () => void;
}

export interface PenSlots {
  readonly Bar?: ComponentType<PenBarProps>;
  readonly Tier?: ComponentType;
  /** The eraser's options tier (Stroke or Partial, size; craft spec §5.6) while it is armed. */
  readonly EraserTier?: ComponentType;
}

let slots: PenSlots = {};
const listeners = new Set<() => void>();

/** Registers the pen's bar and tier components; returns a disposer that restores the defaults. */
export function registerPenSlots(next: PenSlots): () => void {
  const registered = { ...next };
  slots = registered;
  for (const listener of listeners) listener();
  return () => {
    if (slots !== registered) return;
    slots = {};
    for (const listener of listeners) listener();
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function usePenSlots(): PenSlots {
  return useSyncExternalStore(
    subscribe,
    () => slots,
    () => slots,
  );
}
