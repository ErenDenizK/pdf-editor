/**
 * File intake, DOM side (ARCHITECTURE.md §5).
 *
 * Open: `showOpenFilePicker` (Chromium) -> hidden `<input type=file multiple>`.
 * Drop: `getAsFileSystemHandle` (Chromium) -> `webkitGetAsEntry` (recursive folder walk,
 * all engines) -> `getAsFile`. Safari has no handle API, so folder drops use entries.
 *
 * All results are filtered to PDFs by type or extension (`file-filters.ts`).
 */
import { m } from '../i18n';
import {
  collectFromEntries,
  collectFromHandles,
  type EntryLike,
  filterPdfFiles,
  type HandleLike,
} from './file-filters';

export const PDF_ACCEPT = 'application/pdf,.pdf';

interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  id?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
interface WindowWithPicker {
  showOpenFilePicker?: (options: OpenFilePickerOptions) => Promise<{ getFile(): Promise<File> }[]>;
}
interface DataTransferItemWithHandle {
  getAsFileSystemHandle?: () => Promise<HandleLike | null>;
}

export function supportsOpenFilePicker(win: Window = window): boolean {
  return typeof (win as Window & WindowWithPicker).showOpenFilePicker === 'function';
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Asks the user for PDF files. Resolves to an empty array when the user cancels.
 * Must be called from a user gesture (click or keydown) for the picker to open.
 */
export async function pickPdfFiles(): Promise<File[]> {
  const picker = (window as Window & WindowWithPicker).showOpenFilePicker;
  if (picker) {
    try {
      const handles = await picker.call(window, {
        multiple: true,
        id: 'pdf-editor-open',
        types: [
          { description: m.file_picker_description(), accept: { 'application/pdf': ['.pdf'] } },
        ],
      });
      // TODO(save): keep the handles so "Save" can write back in place on Chromium.
      const files = await Promise.all(handles.map((handle) => handle.getFile()));
      return filterPdfFiles(files);
    } catch (error) {
      if (isAbort(error)) return [];
      // SecurityError (no activation, cross-origin frame) and friends: use the input.
    }
  }
  return pickWithInput();
}

function pickWithInput(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = PDF_ACCEPT;
    input.hidden = true;
    const finish = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(filterPdfFiles(input.files ?? [])), {
      once: true,
    });
    input.addEventListener('cancel', () => finish([]), { once: true });
    document.body.append(input);
    input.click();
  });
}

/** True while dragging something that contains files (not text or links). */
export function dragHasFiles(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer ? Array.from(dataTransfer.types).includes('Files') : false;
}

/** Calls `fn`, mapping a throw to null (some engines throw on unsupported item kinds). */
function attempt<T>(fn: () => T | null): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

interface CapturedItem {
  readonly handle: Promise<HandleLike | null> | null;
  readonly entry: EntryLike | null;
  readonly file: File | null;
}

/**
 * Resolves the PDFs in a drop. Everything that touches `DataTransferItem` happens
 * synchronously before the first `await`: the browser invalidates the item list as soon
 * as the drop handler returns.
 */
export async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  return filesFromItems(Array.from(dataTransfer.items ?? []), dataTransfer.files ?? []);
}

/**
 * Same as `filesFromDataTransfer`, from an item list captured during a drop (e.g. the
 * `items` a drag-and-drop library hands its drop handler). Call it synchronously inside the
 * drop handler.
 */
export async function filesFromItems(
  allItems: readonly DataTransferItem[],
  fallback: Iterable<File> | ArrayLike<File> = [],
): Promise<File[]> {
  const items = allItems.filter((item) => item.kind === 'file');
  if (items.length === 0) return filterPdfFiles(Array.from(fallback));

  const captured: CapturedItem[] = items.map((item) => {
    const withHandle = item as DataTransferItem & DataTransferItemWithHandle;
    return {
      handle: attempt(() => withHandle.getAsFileSystemHandle?.() ?? null),
      entry: attempt(() => item.webkitGetAsEntry?.() ?? null),
      file: attempt(() => item.getAsFile()),
    };
  });

  const results: File[] = [];
  for (const item of captured) {
    const handle = item.handle ? await item.handle.catch(() => null) : null;
    if (handle) {
      results.push(...(await collectFromHandles([handle])));
    } else if (item.entry) {
      results.push(...(await collectFromEntries([item.entry])));
    } else if (item.file) {
      results.push(...filterPdfFiles([item.file]));
    }
  }
  return results;
}
