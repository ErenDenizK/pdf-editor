import { describe, expect, it } from 'vitest';

import { exportFileName } from './filename';

describe('exportFileName', () => {
  it('keeps ordinary titles and adds the extension once', () => {
    expect(exportFileName('Annual report 2026')).toBe('Annual report 2026.pdf');
    expect(exportFileName('scan.PDF')).toBe('scan.pdf');
  });

  it('replaces reserved characters and strips control characters and trailing dots', () => {
    expect(exportFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j.pdf');
    expect(exportFileName('tab\there\u0007. . ')).toBe('tab here.pdf');
  });

  it('falls back for empty names and Windows device names, and bounds the length', () => {
    expect(exportFileName('   ')).toBe('document.pdf');
    expect(exportFileName('CON')).toBe('CON-document.pdf');
    expect(exportFileName('x'.repeat(300))).toHaveLength(124);
  });
});
