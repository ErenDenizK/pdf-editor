import { describe, expect, it } from 'vitest';

import { foldForSearch, fuzzyFilter, fuzzyMatch } from './fuzzy';

describe('fuzzyMatch', () => {
  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyMatch('xyz', 'Zoom in')).toBeNull();
    expect(fuzzyMatch('zoom in please', 'Zoom in')).toBeNull();
  });

  it('matches case-insensitively and reports positions', () => {
    expect(fuzzyMatch('ZI', 'Zoom in')?.positions).toEqual([0, 5]);
  });

  it('prefers word starts over the first greedy occurrence', () => {
    // Greedy would take the "l" inside "Toggle"; the word start "left" scores higher.
    expect(fuzzyMatch('tl', 'Toggle left panel')?.positions).toEqual([0, 7]);
    // A consecutive run at the start still beats a distant word start.
    expect(fuzzyMatch('to', 'Toggle outline')?.positions).toEqual([0, 1]);
  });

  it('scores prefixes and consecutive runs above scattered matches', () => {
    const prefix = fuzzyMatch('open', 'Open files…')?.score ?? 0;
    const scattered = fuzzyMatch('open', 'Show outline panel now')?.score ?? 0;
    expect(prefix).toBeGreaterThan(scattered);
  });

  it('treats an empty query as a neutral match', () => {
    expect(fuzzyMatch('  ', 'Anything')).toEqual({ score: 0, positions: [] });
  });

  it('gives an exact match the highest score', () => {
    const exact = fuzzyMatch('zoom in', 'Zoom in')?.score ?? 0;
    const longer = fuzzyMatch('zoom in', 'Zoom in further')?.score ?? 0;
    expect(exact).toBeGreaterThan(longer);
  });
});

describe('diacritic-insensitive matching', () => {
  it('folds Turkish letters and accents without changing the length', () => {
    expect(foldForSearch('Çizim BİRLEŞTİR ığüöş')).toBe('cizim birlestir iguos');
    expect(foldForSearch('Café Ålesund')).toBe('cafe alesund');
    for (const text of ['İİİ', 'el yazısı', 'Dışa aktar…']) {
      expect(foldForSearch(text)).toHaveLength(text.length);
    }
  });

  it('finds Turkish words typed without diacritics, and the other way round', () => {
    expect(fuzzyMatch('ciz', 'çiz')).not.toBeNull();
    expect(fuzzyMatch('birlestir', 'birleştir')).not.toBeNull();
    expect(fuzzyMatch('karsilastir', 'karşılaştır')).not.toBeNull();
    expect(fuzzyMatch('el yazisi', 'el yazısı')).not.toBeNull();
    expect(fuzzyMatch('çiz', 'Ciz')).not.toBeNull();
    expect(fuzzyMatch('İMZA', 'imza')).not.toBeNull();
    // A query in decomposed form (c + combining cedilla) matches too.
    expect(fuzzyMatch('c\u0327iz', 'çiz')).not.toBeNull();
  });

  it('scores a folded exact match like an exact match and keeps positions', () => {
    const folded = fuzzyMatch('birlestir', 'birleştir');
    const plain = fuzzyMatch('birlestir', 'birlestir');
    expect(folded?.score).toBe(plain?.score);
    expect(fuzzyMatch('dondur', 'Sayfayı döndür')?.positions).toEqual([8, 9, 10, 11, 12, 13]);
  });
});

describe('fuzzyFilter', () => {
  const items = [
    { title: 'Toggle left panel', keywords: ['sidebar'] },
    { title: 'Zoom in', keywords: [] },
    { title: 'Zoom out', keywords: [] },
    { title: 'Open files…', keywords: ['import'] },
  ];
  const run = (q: string) =>
    fuzzyFilter(
      q,
      items,
      (i) => i.title,
      (i) => i.keywords,
    ).map((r) => r.item.title);

  it('returns everything in order for an empty query', () => {
    expect(run('')).toEqual(items.map((i) => i.title));
  });

  it('ranks by score and drops non-matches', () => {
    expect(run('zo')).toEqual(['Zoom in', 'Zoom out']);
    expect(run('zout')[0]).toBe('Zoom out');
  });

  it('matches keywords when the title does not', () => {
    expect(run('sidebar')).toEqual(['Toggle left panel']);
    expect(run('import')).toEqual(['Open files…']);
  });

  it('matches keywords without diacritics', () => {
    const tools = [
      { title: 'Pen', keywords: ['draw', 'kalem', 'çiz'] },
      { title: 'Merge all open documents…', keywords: ['combine', 'birleştir'] },
    ];
    const find = (q: string) =>
      fuzzyFilter(
        q,
        tools,
        (t) => t.title,
        (t) => t.keywords,
      ).map((r) => r.item.title);
    expect(find('ciz')[0]).toBe('Pen');
    expect(find('birlestir')).toEqual(['Merge all open documents…']);
  });
});
