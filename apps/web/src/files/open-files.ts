/**
 * File intake, DOM side (ARCHITECTURE.md §5).
 *
 * Open: `showOpenFilePicker` (Chromium) -> hidden `<input type=file multiple>`.
 * Drop: `getAsFileSystemHandle` (Chromium) -> `webkitGetAsEntry` (recursive folder walk,
 * all engines) -> `getAsFile`. Safari has no handle API, so folder drops use entries.
 *
 * Results are filtered by type or extension (`file-filters.ts`, `images.ts`): PDFs by
 * default; drops and the Open picker also take PNG, JPEG and WebP images (image pages).
 *
 * Where the browser hands out a `FileSystemFileHandle` (the Chromium picker, a dropped
 * file's `getAsFileSystemHandle()`), the handle is kept beside the `File` it produced
 * (`fileHandleOf`), so Recents can reopen the file later (`recents.ts`).
 */
import { m } from '../i18n';
import {
  collectFromEntries,
  collectFromHandles,
  type EntryLike,
  type FileHandleLike,
  type HandleLike,
  isPdfFile,
  type NamedFile,
} from './file-filters';
import { IMAGE_ACCEPT, isImageFile } from './images';

export const PDF_ACCEPT = 'application/pdf,.pdf';

/** PDFs and the image types that can become pages. */
export function isOpenableFile(file: NamedFile): boolean {
  return isPdfFile(file) || isImageFile(file);
}

/** Splits files into PDFs and images, keeping their order within each group. */
export function partitionFiles<T extends NamedFile>(
  files: readonly T[],
): { readonly pdfs: T[]; readonly images: T[] } {
  return {
    pdfs: files.filter(isPdfFile),
    images: files.filter((file) => !isPdfFile(file) && isImageFile(file)),
  };
}

const IMAGE_PICKER_TYPES = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
};

interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  id?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}
interface WindowWithPicker {
  showOpenFilePicker?: (options: OpenFilePickerOptions) => Promise<FileHandleLike[]>;
}
interface DataTransferItemWithHandle {
  getAsFileSystemHandle?: () => Promise<HandleLike | null>;
}

/** The handle each picked or dropped file came from, where the browser gave one. */
const fileHandles = new WeakMap<File, FileHandleLike>();

/** Remembers that `file` was read from `handle` (Recents keeps it to reopen the file). */
export function rememberFileHandle(file: File, handle: FileHandleLike): void {
  fileHandles.set(file, handle);
}

/** The handle `file` was read from, or undefined (an `<input>` pick, a Firefox drop). */
export function fileHandleOf(file: File): FileHandleLike | undefined {
  return fileHandles.get(file);
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
  return pickFiles('pdf');
}

/**
 * Asks for files of a kind: 'pdf', 'images' (PNG, JPEG, WebP) or 'openable' (both).
 * Resolves to an empty array when the user cancels. Needs a user gesture.
 */
export async function pickFiles(kind: 'pdf' | 'images' | 'openable'): Promise<File[]> {
  const accept = kind === 'pdf' ? isPdfFile : kind === 'images' ? isImageFile : isOpenableFile;
  const picker = (window as Window & WindowWithPicker).showOpenFilePicker;
  if (picker) {
    try {
      const types =
        kind === 'pdf'
          ? { 'application/pdf': ['.pdf'] }
          : kind === 'images'
            ? IMAGE_PICKER_TYPES
            : { 'application/pdf': ['.pdf'], ...IMAGE_PICKER_TYPES };
      const handles = await picker.call(window, {
        multiple: true,
        id: kind === 'images' ? 'pdf-editor-images' : 'pdf-editor-open',
        types: [
          {
            description:
              kind === 'pdf'
                ? m.file_picker_description()
                : kind === 'images'
                  ? m.file_picker_images()
                  : m.file_picker_openable(),
            accept: types,
          },
        ],
      });
      const files = await Promise.all(
        handles.map(async (handle) => {
          const file = await handle.getFile();
          rememberFileHandle(file, handle);
          return file;
        }),
      );
      return files.filter(accept);
    } catch (error) {
      if (isAbort(error)) return [];
      // SecurityError (no activation, cross-origin frame) and friends: use the input.
    }
  }
  const inputAccept =
    kind === 'pdf'
      ? PDF_ACCEPT
      : kind === 'images'
        ? IMAGE_ACCEPT
        : `${PDF_ACCEPT},${IMAGE_ACCEPT}`;
  return pickWithInput(inputAccept, accept);
}

function pickWithInput(acceptList: string, accept: (file: NamedFile) => boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = acceptList;
    input.hidden = true;
    const finish = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? []).filter(accept)), {
      once: true,
    });
    input.addEventListener('cancel', () => finish([]), { once: true });
    document.body.append(input);
    input.click();
  });
}

/** True while dragging something that contains files (not text or links). */
export function dragHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (Array.from(dataTransfer.types).includes('Files')) return true;
  // Some engines expose file items without the "Files" type (script-built transfers, some
  // WebKit drops); the item kinds and the file list are the second and third opinion.
  try {
    if (Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file')) return true;
    return (dataTransfer.files?.length ?? 0) > 0;
  } catch {
    return false;
  }
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
export async function filesFromDataTransfer(
  dataTransfer: DataTransfer,
  accept: (file: NamedFile) => boolean = isPdfFile,
): Promise<File[]> {
  return filesFromItems(Array.from(dataTransfer.items ?? []), dataTransfer.files ?? [], accept);
}

/**
 * Same as `filesFromDataTransfer`, from an item list captured during a drop (e.g. the
 * `items` a drag-and-drop library hands its drop handler). Call it synchronously inside the
 * drop handler.
 */
export async function filesFromItems(
  allItems: readonly DataTransferItem[],
  fallback: Iterable<File> | ArrayLike<File> = [],
  accept: (file: NamedFile) => boolean = isPdfFile,
): Promise<File[]> {
  const items = allItems.filter((item) => item.kind === 'file');
  if (items.length === 0) return Array.from(fallback).filter(accept);

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
      const files = await collectFromHandles([handle], { accept });
      const [only] = files;
      if (handle.kind === 'file' && only !== undefined && files.length === 1) {
        rememberFileHandle(only, handle as FileHandleLike);
      }
      results.push(...files);
    } else if (item.entry) {
      results.push(...(await collectFromEntries([item.entry], { accept })));
    } else if (item.file && accept(item.file)) {
      results.push(item.file);
    }
  }
  return results;
}
