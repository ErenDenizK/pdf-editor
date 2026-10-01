/**
 * Open state of the About dialog. Opened from the palette ("About PDF Editor") and from the
 * version line in the privacy popover.
 */
import { create } from 'zustand';

interface AboutState {
  readonly open: boolean;
  /**
   * Where focus goes when the dialog closes. The privacy popover closes as the dialog
   * opens, so the button that opened it is gone by then; the popover passes its trigger.
   */
  readonly returnFocus: HTMLElement | null;
}

export const useAboutStore = create<AboutState>()(() => ({ open: false, returnFocus: null }));

export function openAbout(returnFocus: HTMLElement | null = null): void {
  useAboutStore.setState({ open: true, returnFocus });
}

export function closeAbout(): void {
  useAboutStore.setState({ open: false });
}
