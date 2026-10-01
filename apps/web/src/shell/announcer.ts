/**
 * Live-region announcements (DESIGN.md §5, experience-redesign §10): opened files, closed
 * tabs, mode changes, the tool bar's group, the armed preset, a closed burst, a lasso count.
 * The `LiveRegion` component renders the latest message of each politeness.
 *
 * Messages said in the same task are joined, in order and once each, so a change that
 * causes another (a tool change closes a burst: "Pen: 5 strokes on page 1. Lasso tool") is
 * said whole rather than the last word only. A message with a `key` replaces an earlier
 * one with the same key in that task: the armed preset ("Blue pen, 1.5 pt") says what the
 * generic tool name ("Pen tool") would, so only the preset is said.
 *
 * Polite by default; `assertive` is for a failure the person did not see happen (a stroke
 * that could not be saved).
 */
import { create } from 'zustand';

export type Politeness = 'polite' | 'assertive';

interface AnnouncerState {
  /** The polite message (`role="status"`). */
  message: string;
  /** Bumped per announcement so repeating the same text is re-announced. */
  serial: number;
  /** The assertive message (`role="alert"`). */
  alert: string;
  alertSerial: number;
}

export interface AnnounceOptions {
  readonly politeness?: Politeness;
  /** Replaces an earlier message with this key said in the same task. */
  readonly key?: string;
}

export const useAnnouncer = create<AnnouncerState>()(() => ({
  message: '',
  serial: 0,
  alert: '',
  alertSerial: 0,
}));

interface Said {
  readonly key: string | undefined;
  readonly text: string;
}

/** What has been said in the current task, per politeness; cleared in a microtask. */
const batches: Record<Politeness, Said[] | null> = { polite: null, assertive: null };

function joined(items: readonly Said[]): string {
  return items
    .map((item, i) =>
      i === items.length - 1 || /[.!?…:]$/.test(item.text) ? item.text : `${item.text}.`,
    )
    .join(' ');
}

export function announce(message: string, options: AnnounceOptions = {}): void {
  const politeness = options.politeness ?? 'polite';
  let batch = batches[politeness];
  if (batch === null) {
    batch = [];
    batches[politeness] = batch;
    queueMicrotask(() => {
      batches[politeness] = null;
    });
  }
  const key = options.key;
  const replaced = key === undefined ? -1 : batch.findIndex((item) => item.key === key);
  if (replaced >= 0) batch.splice(replaced, 1);
  // Said once: the same words again in the same task add nothing.
  if (!batch.some((item) => item.text === message)) batch.push({ key, text: message });
  const text = joined(batch);
  if (politeness === 'assertive') {
    useAnnouncer.setState((s) => ({ alert: text, alertSerial: s.alertSerial + 1 }));
  } else {
    useAnnouncer.setState((s) => ({ message: text, serial: s.serial + 1 }));
  }
}
