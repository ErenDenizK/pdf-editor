/**
 * Delivery of tool outputs that are not PDFs (images, ZIPs): the save picker when the
 * browser has one, else a Blob behind an object URL and `<a download>` (revoked after a
 * grace period, as export/deliver.ts does for PDFs). PDFs go through `deliverPdf`.
 */
export type FileDeliveryOutcome = 'saved' | 'downloaded' | 'cancelled';

const REVOKE_DELAY_MS = 60_000;

interface Writable {
  write(data: BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
type SavePicker = (options: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ createWritable(): Promise<Writable> }>;

export async function deliverFile(
  data: Blob | ArrayBuffer,
  name: string,
  type: string,
  win: Window = window,
): Promise<FileDeliveryOutcome> {
  const picker = (win as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (typeof picker === 'function') {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot) : '';
    try {
      const handle = await picker.call(win, {
        suggestedName: name,
        ...(extension ? { types: [{ description: type, accept: { [type]: [extension] } }] } : {}),
      });
      const writable = await handle.createWritable();
      try {
        await writable.write(data);
        await writable.close();
      } catch (error) {
        await writable.abort(error).catch(() => undefined);
        throw error;
      }
      return 'saved';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
      if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error;
    }
  }
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const anchor = win.document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.hidden = true;
  win.document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  return 'downloaded';
}

/** Whether a PNG can be put on the clipboard (async Clipboard API with ClipboardItem). */
export function canCopyImage(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function' &&
    typeof ClipboardItem !== 'undefined'
  );
}

/**
 * Copies a PNG to the clipboard. Call synchronously from the click handler with a
 * promise of the blob: Chromium and Safari keep the user activation for the pending item.
 */
export async function copyImage(png: Promise<Blob>): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
