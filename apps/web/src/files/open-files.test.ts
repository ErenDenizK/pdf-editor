import { describe, expect, it } from 'vitest';

import { dragHasFiles, filesFromDataTransfer } from './open-files';

describe('filesFromDataTransfer (real browser DataTransfer)', () => {
  it('falls back through the tiers and keeps only PDFs', async () => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' }));
    transfer.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    transfer.items.add(new File(['%PDF-1.4'], 'B.PDF', { type: '' }));
    transfer.items.add('just text', 'text/plain');
    const files = await filesFromDataTransfer(transfer);
    expect(files.map((f) => f.name)).toEqual(['a.pdf', 'B.PDF']);
  });

  it('detects file drags', () => {
    const transfer = new DataTransfer();
    expect(dragHasFiles(transfer)).toBe(false);
    transfer.items.add(new File(['x'], 'x.pdf', { type: 'application/pdf' }));
    expect(dragHasFiles(transfer)).toBe(true);
    expect(dragHasFiles(null)).toBe(false);
  });
});
