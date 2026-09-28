/**
 * Handing the batch outputs to the user (spec §5 "Output as a ZIP or, on Chromium, into a
 * folder"): one ZIP (the default with more than one output), each file on its own (the
 * save picker for the first, then downloads: the picker needs a fresh user gesture each
 * time), or every file into a folder the user picks (`showDirectoryPicker`, Chromium).
 */
import { m } from '../i18n';
import { deliverFile, type FileDeliveryOutcome } from '../tools/deliver-file';
import type { BatchOutput } from './runner';
import { buildZip } from './zip';

interface WritableLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
interface DirectoryHandleLike {
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<{ createWritable(): Promise<WritableLike> }>;
}
type DirectoryPicker = (options?: {
  mode?: 'read' | 'readwrite';
  id?: string;
}) => Promise<DirectoryHandleLike>;

export function supportsFolderDelivery(win: Window = window): boolean {
  return (
    typeof (win as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker ===
    'function'
  );
}

/** `text` without the characters file systems refuse (Windows is the strictest). */
export function safeFileStem(text: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const stem = text.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, '_').trim();
  return stem === '' ? fallback : stem;
}

/** File name of the ZIP for a run of `recipeName`. */
export function zipName(recipeName: string): string {
  return `${safeFileStem(recipeName, 'batch')}.zip`;
}

export function deliverZip(
  outputs: readonly BatchOutput[],
  name: string,
  win: Window = window,
): Promise<FileDeliveryOutcome> {
  return deliverFile(buildZip(outputs.map((o) => o.entry)), name, 'application/zip', win);
}

/** Each output as its own file; stops at the first the user cancels. */
export async function deliverEach(
  outputs: readonly BatchOutput[],
  win: Window = window,
): Promise<FileDeliveryOutcome> {
  let last: FileDeliveryOutcome = 'cancelled';
  for (const output of outputs) {
    last = await deliverFile(output.entry.data, output.name, output.type, win);
    if (last === 'cancelled') break;
  }
  return last;
}

/** Every output into a folder the user picks; 'cancelled' when they close the picker. */
export async function deliverToFolder(
  outputs: readonly BatchOutput[],
  win: Window = window,
): Promise<'saved' | 'cancelled'> {
  const picker = (win as Window & { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (typeof picker !== 'function') throw new Error(m.batch_error_folders_unsupported());
  let dir: DirectoryHandleLike;
  try {
    dir = await picker.call(win, { mode: 'readwrite', id: 'batch-output' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    throw error;
  }
  for (const output of outputs) {
    const handle = await dir.getFileHandle(output.name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(output.entry.data);
      await writable.close();
    } catch (error) {
      await writable.abort(error).catch(() => undefined);
      throw error;
    }
  }
  return 'saved';
}
