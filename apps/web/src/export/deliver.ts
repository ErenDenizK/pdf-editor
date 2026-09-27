/**
 * Delivery of an export (ARCHITECTURE.md §4 step 6, research 03 §3):
 *
 * - Chromium: `showSaveFilePicker` → `createWritable()` → chunked writes. Must run inside a
 *   user gesture, which is why the dialog asks for a second click after verification. The
 *   last chosen file handle is remembered in memory only (never persisted) and offered as
 *   `startIn`, so the picker opens in the same folder next time.
 * - Elsewhere: a Blob behind an object URL and `<a download>`. The URL is revoked after a
 *   grace period (Firefox reads it asynchronously after the click) and at the latest when
 *   the page is hidden, so no object URL outlives its use.
 */

export type DeliveryOutcome = 'saved' | 'downloaded' | 'cancelled';

interface WritableLike {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
interface SaveHandleLike {
  readonly name: string;
  createWritable(): Promise<WritableLike>;
}
interface SaveFilePickerOptions {
  suggestedName?: string;
  startIn?: SaveHandleLike | 'documents' | 'downloads';
  types?: { description: string; accept: Record<string, string[]> }[];
}
interface WindowWithSavePicker {
  showSaveFilePicker?: (options: SaveFilePickerOptions) => Promise<SaveHandleLike>;
}

const CHUNK = 4 * 1024 * 1024;
/** How long an object URL stays valid after the download click. */
export const REVOKE_DELAY_MS = 60_000;

let lastHandle: SaveHandleLike | undefined;
const pendingUrls = new Map<string, ReturnType<typeof setTimeout>>();
let pagehideInstalled = false;

export function supportsSavePicker(win: Window = window): boolean {
  return typeof (win as Window & WindowWithSavePicker).showSaveFilePicker === 'function';
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function saveWithPicker(
  picker: NonNullable<WindowWithSavePicker['showSaveFilePicker']>,
  win: Window,
  bytes: ArrayBuffer,
  filename: string,
): Promise<DeliveryOutcome> {
  let handle: SaveHandleLike;
  try {
    handle = await picker.call(win, {
      suggestedName: filename,
      startIn: lastHandle ?? 'documents',
      types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }],
    });
  } catch (error) {
    if (isAbort(error)) return 'cancelled';
    throw error;
  }
  const writable = await handle.createWritable();
  try {
    const view = new Uint8Array(bytes);
    for (let offset = 0; offset < view.byteLength; offset += CHUNK) {
      await writable.write(view.subarray(offset, Math.min(view.byteLength, offset + CHUNK)));
    }
    await writable.close();
  } catch (error) {
    // Discard the partial file rather than leaving a truncated PDF behind.
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
  lastHandle = handle;
  return 'saved';
}

function revoke(url: string): void {
  const timer = pendingUrls.get(url);
  if (timer !== undefined) clearTimeout(timer);
  pendingUrls.delete(url);
  URL.revokeObjectURL(url);
}

function downloadWithAnchor(bytes: ArrayBuffer, filename: string, doc: Document): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  try {
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.hidden = true;
    doc.body.append(anchor);
    anchor.click();
    anchor.remove();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  pendingUrls.set(
    url,
    setTimeout(() => {
      revoke(url);
    }, REVOKE_DELAY_MS),
  );
  if (!pagehideInstalled) {
    pagehideInstalled = true;
    doc.defaultView?.addEventListener('pagehide', revokePendingDownloads);
  }
}

/** Revokes every object URL still waiting for its grace period (pagehide, tests). */
export function revokePendingDownloads(): void {
  for (const url of [...pendingUrls.keys()]) revoke(url);
}

/** Number of object URLs not yet revoked (diagnostics, tests). */
export function pendingDownloadCount(): number {
  return pendingUrls.size;
}

/** Forgets the remembered save location (tests). */
export function forgetSaveLocation(): void {
  lastHandle = undefined;
}

/**
 * Hands `bytes` to the user as `filename`. Call from a user gesture. Resolves to
 * 'cancelled' when the user dismisses the save picker; rejects on write failures.
 */
export async function deliverPdf(
  bytes: ArrayBuffer,
  filename: string,
  win: Window = window,
): Promise<DeliveryOutcome> {
  const picker = (win as Window & WindowWithSavePicker).showSaveFilePicker;
  if (picker) {
    try {
      return await saveWithPicker(picker, win, bytes, filename);
    } catch (error) {
      // No user activation, cross-origin frame, or a blocked system folder: fall back.
      if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error;
    }
  }
  downloadWithAnchor(bytes, filename, win.document);
  return 'downloaded';
}
