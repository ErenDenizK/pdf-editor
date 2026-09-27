/**
 * Polite live-region announcements (DESIGN.md §5): opened files, closed tabs, mode
 * changes. The `LiveRegion` component renders the latest message.
 */
import { create } from 'zustand';

interface AnnouncerState {
  message: string;
  /** Bumped per announcement so repeating the same text is re-announced. */
  serial: number;
}

export const useAnnouncer = create<AnnouncerState>()(() => ({ message: '', serial: 0 }));

export function announce(message: string): void {
  useAnnouncer.setState((s) => ({ message, serial: s.serial + 1 }));
}
