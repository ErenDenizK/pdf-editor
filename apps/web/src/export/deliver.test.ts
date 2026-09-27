import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deliverPdf,
  forgetSaveLocation,
  pendingDownloadCount,
  REVOKE_DELAY_MS,
  revokePendingDownloads,
} from './deliver';

function fakeDocument() {
  const clicks: { href: string; download: string }[] = [];
  const anchor = {
    href: '',
    download: '',
    rel: '',
    hidden: false,
    click: () => clicks.push({ href: anchor.href, download: anchor.download }),
    remove: () => undefined,
  };
  const doc = {
    createElement: () => anchor,
    body: { append: () => undefined },
    defaultView: { addEventListener: () => undefined },
  };
  return { doc: doc as unknown as Document, clicks };
}

afterEach(() => {
  revokePendingDownloads();
  forgetSaveLocation();
  vi.useRealTimers();
});

describe('deliverPdf', () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 45]).buffer;

  it('downloads through an object URL that is revoked after the grace period', async () => {
    vi.useFakeTimers();
    const { doc, clicks } = fakeDocument();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const outcome = await deliverPdf(bytes, 'out.pdf', { document: doc } as unknown as Window);
    expect(outcome).toBe('downloaded');
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.download).toBe('out.pdf');
    expect(clicks[0]?.href).toMatch(/^blob:/);
    expect(pendingDownloadCount()).toBe(1);
    vi.advanceTimersByTime(REVOKE_DELAY_MS);
    expect(revoke).toHaveBeenCalledWith(clicks[0]?.href);
    expect(pendingDownloadCount()).toBe(0);
  });

  it('streams to the save picker, remembers the handle in memory, and honours cancel', async () => {
    const written: number[] = [];
    const handle = {
      name: 'out.pdf',
      createWritable: () =>
        Promise.resolve({
          write: (data: Uint8Array) => {
            written.push(data.byteLength);
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
          abort: () => Promise.resolve(),
        }),
    };
    const picker = vi
      .fn()
      .mockResolvedValueOnce(handle)
      .mockRejectedValueOnce(new DOMException('dismissed', 'AbortError'));
    const win = { showSaveFilePicker: picker, document: fakeDocument().doc } as unknown as Window;
    expect(await deliverPdf(bytes, 'out.pdf', win)).toBe('saved');
    expect(written).toEqual([5]);
    expect(picker.mock.calls[0]?.[0]).toMatchObject({
      suggestedName: 'out.pdf',
      startIn: 'documents',
    });
    expect(await deliverPdf(bytes, 'again.pdf', win)).toBe('cancelled');
    expect(picker.mock.calls[1]?.[0]).toMatchObject({ startIn: handle });
    expect(pendingDownloadCount()).toBe(0);
  });

  it('aborts the writable on a write failure so no truncated file remains', async () => {
    const abort = vi.fn(() => Promise.resolve());
    const win = {
      showSaveFilePicker: () =>
        Promise.resolve({
          name: 'x.pdf',
          createWritable: () =>
            Promise.resolve({
              write: () => Promise.reject(new DOMException('disk full', 'QuotaExceededError')),
              close: () => Promise.resolve(),
              abort,
            }),
        }),
      document: fakeDocument().doc,
    } as unknown as Window;
    await expect(deliverPdf(bytes, 'x.pdf', win)).rejects.toThrow('disk full');
    expect(abort).toHaveBeenCalled();
  });
});
