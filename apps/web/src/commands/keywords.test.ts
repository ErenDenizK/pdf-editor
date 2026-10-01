/**
 * Bilingual palette keywords (experience-redesign §8, decision 11): every command's
 * `cmd_<id>_keywords` is read in both UI languages and matched without diacritics, and the
 * catalogs carry an English list wherever they carry a Turkish one.
 */
import { afterEach, describe, expect, it } from 'vitest';

import en from '../../messages/en.json';
import tr from '../../messages/tr.json';
import { registerDocumentCommands } from '../document/document-commands';
import { setLocale } from '../i18n';
import { registerOutlineCommands } from '../outline/outline-commands';
import { buildSections } from '../shell/CommandPalette';
import { registerSignatureCommands } from '../signatures/signature-commands';
import { registerArrangeCommands } from '../stage/arrange-commands';
import { registerAppCommands } from './app-commands';
import { catalogKeywords, keywordMessageKey, messageKeywords, splitKeywords } from './keywords';
import { CommandRegistry } from './registry';

const KEYWORD_KEY = /^cmd_.+_keywords$/;

/** Every command the app registers, as `app.tsx` does. */
function allCommands(): CommandRegistry {
  const registry = new CommandRegistry();
  registerAppCommands(registry);
  registerArrangeCommands(registry);
  registerDocumentCommands(registry);
  registerOutlineCommands(registry);
  registerSignatureCommands(registry);
  return registry;
}

/** Palette results in order, as the palette lists them for a query. */
function search(registry: CommandRegistry, query: string): string[] {
  return buildSections(query, registry.list(), [], () => true).flatMap((s) =>
    s.rows.map((r) => r.command.id),
  );
}

afterEach(() => {
  setLocale('en');
});

describe('keyword message keys', () => {
  it('derives the message key from the command id', () => {
    expect(keywordMessageKey('tool.ink')).toBe('cmd_tool_ink_keywords');
    expect(keywordMessageKey('tool.text-box')).toBe('cmd_tool_text_box_keywords');
    expect(keywordMessageKey('documents.mergeAll')).toBe('cmd_documents_merge_all_keywords');
    expect(keywordMessageKey('view.show.comments')).toBe('cmd_view_show_comments_keywords');
  });

  it('splits a catalog entry into trimmed keywords', () => {
    expect(splitKeywords(' draw,pencil ,, el yazısı ')).toEqual(['draw', 'pencil', 'el yazısı']);
  });
});

describe('keyword catalogs', () => {
  const enKeys = Object.keys(en).filter((k) => KEYWORD_KEY.test(k));
  const trKeys = Object.keys(tr).filter((k) => KEYWORD_KEY.test(k));
  const enCatalog = en as Record<string, unknown>;
  const trCatalog = tr as Record<string, unknown>;

  it('has an English keyword list for every Turkish one, and the other way round', () => {
    expect(trKeys.length).toBeGreaterThan(0);
    for (const key of trKeys) {
      expect(splitKeywords(String(trCatalog[key])), `tr ${key}`).not.toEqual([]);
      expect(typeof enCatalog[key], `en ${key}`).toBe('string');
      expect(splitKeywords(String(enCatalog[key])), `en ${key}`).not.toEqual([]);
    }
    for (const key of enKeys) expect(typeof trCatalog[key], `tr ${key}`).toBe('string');
  });

  it('names only commands that exist', () => {
    const registry = allCommands();
    const known = new Set(registry.list().map((c) => keywordMessageKey(c.id)));
    expect(enKeys.filter((key) => !known.has(key))).toEqual([]);
  });

  it('carries the minimum sets of the spec', () => {
    const has = (id: string, words: readonly string[]) => {
      const all = messageKeywords(id);
      for (const word of words) expect(all, id).toContain(word);
    };
    has('tool.ink', ['draw', 'pencil', 'handwriting', 'scribble', 'sketch']);
    has('tool.ink', ['kalem', 'çiz', 'çizim', 'el yazısı']);
    has('documents.mergeAll', ['combine', 'join', 'append', 'birleştir']);
    has('section.split', ['separate', 'böl', 'ayır']);
    has('mode.compare', ['diff', 'karşılaştır']);
    has('tool.signature', ['signature', 'imza']);
    has('document.sign', ['digital signature', 'certificate', 'dijital imza', 'sertifika']);
    has('document.ocr', ['OCR', 'scan', 'metin tanı']);
    has('tool.redact', ['black out', 'karart']);
    has('pages.rotateRight', ['döndür']);
    has('pages.rotateLeft', ['döndür']);
  });

  it('reads both languages whatever the UI language', () => {
    expect(catalogKeywords('tool.ink', 'en')).toContain('draw');
    expect(catalogKeywords('tool.ink', 'tr')).toContain('kalem');
    setLocale('tr');
    expect(messageKeywords('tool.ink')).toEqual(
      expect.arrayContaining(['draw', 'pencil', 'kalem', 'çiz']),
    );
    expect(messageKeywords('no.such.command')).toEqual([]);
  });
});

describe('palette keyword search', () => {
  it('adds catalog keywords to registered commands, after their own', () => {
    const registry = new CommandRegistry();
    registry.register({
      id: 'tool.ink',
      title: 'Pen tool',
      group: 'Tools',
      keywords: ['annotate'],
      run: () => undefined,
    });
    const keywords = registry.get('tool.ink')?.keywords ?? [];
    expect(keywords[0]).toBe('annotate');
    expect(keywords).toEqual(expect.arrayContaining(['draw', 'kalem', 'çiz']));
  });

  it('finds Pen with English and Turkish words, with or without diacritics', () => {
    const registry = allCommands();
    for (const query of ['draw', 'pencil', 'kalem', 'çiz', 'ciz', 'cizim', 'el yazisi']) {
      expect(search(registry, query)[0], query).toBe('tool.ink');
    }
  });

  it('finds Merge with combine, join and birleştir typed either way', () => {
    const registry = allCommands();
    for (const query of ['combine', 'join', 'birleştir', 'birlestir', 'BIRLESTIR']) {
      expect(['documents.mergeAll', 'section.merge'], query).toContain(search(registry, query)[0]);
    }
  });

  it('finds the other renamed and keyworded commands', () => {
    const registry = allCommands();
    expect(search(registry, 'karart')[0]).toBe('tool.redact');
    expect(search(registry, 'karsilastir')[0]).toBe('mode.compare');
    expect(search(registry, 'sertifika')[0]).toBe('document.sign');
    expect(search(registry, 'imza')).toEqual(
      expect.arrayContaining(['tool.signature', 'document.sign']),
    );
    expect(search(registry, 'metin tani')[0]).toBe('document.ocr');
    expect(search(registry, 'bol')[0]).toBe('section.split');
  });

  it('matches Turkish keywords in the Turkish UI too, and English ones', () => {
    setLocale('tr');
    const registry = allCommands();
    expect(search(registry, 'kalem')[0]).toBe('tool.ink');
    expect(search(registry, 'draw')[0]).toBe('tool.ink');
    expect(['documents.mergeAll', 'section.merge']).toContain(search(registry, 'combine')[0]);
  });
});
