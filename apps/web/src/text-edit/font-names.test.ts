import { describe, expect, it } from 'vitest';

import { humanFontName } from './font-names';

describe('humanFontName', () => {
  it.each([
    ['TimesNewRomanPSMT', 'Times New Roman'],
    ['ABCDEF+Inter-Regular', 'Inter Regular'],
    ['Arial-BoldMT', 'Arial Bold'],
    ['Helvetica', 'Helvetica'],
    ['NotoSerif-Bold', 'Noto Serif Bold'],
    ['ArialMT', 'Arial'],
    ['Arial,BoldItalic', 'Arial Bold Italic'],
    ['TimesNewRomanPS-BoldItalicMT', 'Times New Roman Bold Italic'],
    ['Helvetica-Oblique', 'Helvetica Oblique'],
    ['Calibri-Identity-H', 'Calibri'],
    ['MSGothic', 'MS Gothic'],
    ['Code128_Regular', 'Code 128 Regular'],
  ])('%s → %s', (raw, human) => {
    expect(humanFontName(raw)).toBe(human);
  });

  it('keeps a first word that looks like a suffix or a style', () => {
    expect(humanFontName('MT-Extra')).toBe('MT Extra');
    expect(humanFontName('Bold')).toBe('Bold');
  });

  it('never returns an empty name', () => {
    expect(humanFontName('')).toBe('?');
    expect(humanFontName('ABCDEF+')).toBe('?');
  });
});
