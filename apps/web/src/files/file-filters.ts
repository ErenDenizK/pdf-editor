/**
 * Pure helpers for file intake. No DOM globals: everything here runs in unit tests with
 * plain objects and fakes for the File System / Entries APIs.
 */

export interface NamedFile {
  readonly name: string;
  readonly type: string;
}

const PDF_TYPES = new Set(['application/pdf', 'application/x-pdf', 'application/acrobat']);

/** macOS AppleDouble (`._report.pdf`) and other dot files are metadata, not documents. */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}

/**
 * A file counts as a PDF when its MIME type says so or its name ends in `.pdf`. Type
 * checks alone are not enough: files from some folders and OSes arrive with an empty or
 * generic type. Bytes are verified later by the engine (`%PDF-` header).
 */
export function isPdfFile(file: NamedFile): boolean {
  if (isHiddenName(file.name)) return false;
  if (PDF_TYPES.has(file.type.toLowerCase())) return true;
  return /\.pdf$/i.test(file.name);
}

export function filterPdfFiles<T extends NamedFile>(files: Iterable<T>): T[] {
  return [...files].filter(isPdfFile);
}

/** Minimal structural view of `FileSystemEntry` (webkitGetAsEntry). */
export interface EntryLike {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly name: string;
}
export interface FileEntryLike extends EntryLike {
  file(success: (file: File) => void, failure?: (error: unknown) => void): void;
}
export interface DirectoryEntryLike extends EntryLike {
  createReader(): {
    readEntries(success: (entries: EntryLike[]) => void, failure?: (error: unknown) => void): void;
  };
}

/** Minimal structural view of `FileSystemHandle` (getAsFileSystemHandle). */
export interface HandleLike {
  readonly kind: 'file' | 'directory';
  readonly name: string;
}
export interface FileHandleLike extends HandleLike {
  readonly kind: 'file';
  getFile(): Promise<File>;
}
export interface DirectoryHandleLike extends HandleLike {
  readonly kind: 'directory';
  values(): AsyncIterable<HandleLike>;
}

export interface WalkOptions {
  /** Stop after this many files; guards against dropping a home directory. */
  readonly maxFiles?: number;
  readonly maxDepth?: number;
  /** Which files to keep; PDFs by default. */
  readonly accept?: (file: NamedFile) => boolean;
}

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_DEPTH = 16;

function isFileEntry(entry: EntryLike): entry is FileEntryLike {
  return entry.isFile;
}
function isDirectoryEntry(entry: EntryLike): entry is DirectoryEntryLike {
  return entry.isDirectory;
}

function readFileEntry(entry: FileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

/** `readEntries` returns batches (100 in Chromium) until it yields an empty array. */
async function readAllEntries(entry: DirectoryEntryLike): Promise<EntryLike[]> {
  const reader = entry.createReader();
  const all: EntryLike[] = [];
  for (;;) {
    const batch = await new Promise<EntryLike[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

/** Walks `webkitGetAsEntry()` entries recursively, collecting PDF files in order. */
export async function collectFromEntries(
  entries: readonly EntryLike[],
  options: WalkOptions = {},
): Promise<File[]> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const accept = options.accept ?? isPdfFile;
  const out: File[] = [];
  const visit = async (entry: EntryLike, depth: number): Promise<void> => {
    if (out.length >= maxFiles || isHiddenName(entry.name)) return;
    if (isFileEntry(entry)) {
      const file = await readFileEntry(entry).catch(() => null);
      if (file && accept(file)) out.push(file);
    } else if (isDirectoryEntry(entry) && depth < maxDepth) {
      const children = await readAllEntries(entry).catch(() => []);
      children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const child of children) await visit(child, depth + 1);
    }
  };
  for (const entry of entries) await visit(entry, 0);
  return out;
}

/** Walks File System Access handles recursively, collecting PDF files in order. */
export async function collectFromHandles(
  handles: readonly HandleLike[],
  options: WalkOptions = {},
): Promise<File[]> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const accept = options.accept ?? isPdfFile;
  const out: File[] = [];
  const visit = async (handle: HandleLike, depth: number): Promise<void> => {
    if (out.length >= maxFiles || isHiddenName(handle.name)) return;
    if (handle.kind === 'file') {
      const file = await (handle as FileHandleLike).getFile().catch(() => null);
      if (file && accept(file)) out.push(file);
    } else if (depth < maxDepth) {
      const children: HandleLike[] = [];
      try {
        for await (const child of (handle as DirectoryHandleLike).values()) children.push(child);
      } catch {
        return;
      }
      children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const child of children) await visit(child, depth + 1);
    }
  };
  for (const handle of handles) await visit(handle, 0);
  return out;
}

/** Human-readable byte size, e.g. `1.2 MB`. Binary multiples, decimal-looking units. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
