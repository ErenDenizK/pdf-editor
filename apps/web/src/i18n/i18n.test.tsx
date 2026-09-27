import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { App } from '../app';
import { commandRegistry } from '../commands/registry';
import { currentPlatform } from '../commands/shortcuts';
import { useUiStore } from '../state/ui-store';
import { resetWorkspace } from '../state/workspace-store';
import { detectLocale, getLocale, m, matchLocale, setLocale } from '.';
import { LOCALE_STORAGE_KEY } from './locale';
import en from '../../messages/en.json';
import tr from '../../messages/tr.json';

const MOD = currentPlatform === 'mac' ? 'Meta' : 'Control';

afterEach(() => {
  setLocale('en');
  localStorage.removeItem(LOCALE_STORAGE_KEY);
});

describe('locale detection', () => {
  it('prefers ?lang=, then the saved choice, then navigator.languages, then en', () => {
    const languages = ['tr-TR', 'en-US'];
    expect(detectLocale({ search: '?lang=en', stored: 'tr', languages })).toBe('en');
    expect(detectLocale({ search: '?lang=TR' })).toBe('tr');
    expect(detectLocale({ search: '?lang=xx', stored: 'tr', languages: ['en'] })).toBe('tr');
    expect(detectLocale({ stored: 'de', languages })).toBe('tr');
    expect(detectLocale({ stored: 42, languages: ['de-DE', 'en-GB'] })).toBe('en');
    expect(detectLocale({ languages: ['de', 'fr'] })).toBe('en');
    expect(detectLocale({})).toBe('en');
  });

  it('matches full tags and base languages', () => {
    expect(matchLocale('tr')).toBe('tr');
    expect(matchLocale('tr-CY')).toBe('tr');
    expect(matchLocale('EN_gb')).toBe('en');
    expect(matchLocale('de')).toBeUndefined();
    expect(matchLocale(null)).toBeUndefined();
  });
});

describe('messages', () => {
  it('has the same keys in every catalog', () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
  });

  it('pluralizes English and keeps Turkish uninflected', () => {
    expect(m.pages_count({ count: 1 })).toBe('1 page');
    expect(m.pages_count({ count: 3 })).toBe('3 pages');
    expect(m.privacy_external_requests({ count: 0 })).toBe('No external requests');
    expect(m.privacy_external_requests({ count: 2 })).toBe('2 external requests');
    expect(m.pages_count({ count: 1 }, { locale: 'tr' })).toBe('1 sayfa');
    expect(m.pages_count({ count: 3 }, { locale: 'tr' })).toBe('3 sayfa');
    expect(m.privacy_external_requests({ count: 0 }, { locale: 'tr' })).toBe('Dış istek yok');
  });

  it('switches at runtime, persists, and updates <html lang dir>', () => {
    expect(setLocale('tr')).toBe(true);
    expect(getLocale()).toBe('tr');
    expect(m.open_files()).toBe('Dosya aç');
    expect(document.documentElement.lang).toBe('tr');
    expect(document.documentElement.dir).toBe('ltr');
    expect(JSON.parse(localStorage.getItem(LOCALE_STORAGE_KEY) ?? 'null')).toBe('tr');
    expect(setLocale('tr')).toBe(false);
  });
});

describe('Language command', () => {
  it('switches the shell to Turkish from the palette', async () => {
    useUiStore.setState({ paletteOpen: false, shortcutsOpen: false, recents: [] });
    resetWorkspace();
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Drop PDFs to start' })).toBeVisible();
    await userEvent.keyboard(`{${MOD}>}k{/${MOD}}`);
    const input = await screen.findByRole('combobox', { name: 'Search commands' });
    await userEvent.type(input, 'türkçe');
    await waitFor(() => {
      expect(screen.getAllByRole('option')[0]).toHaveTextContent('Türkçe');
    });
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Başlamak için PDF bırakın' })).toBeVisible();
    expect(screen.getByText('Yalnızca yerel')).toBeVisible();
    expect(document.documentElement.lang).toBe('tr');

    // Command titles follow the language too.
    await userEvent.keyboard(`{${MOD}>}k{/${MOD}}`);
    expect(await screen.findByRole('combobox', { name: 'Komut ara' })).toBeVisible();
    expect(screen.getByRole('option', { name: /Sol paneli aç\/kapat/ })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
  });
});

describe('command groups', () => {
  it('registers every palette group through messages, once per language', async () => {
    resetWorkspace();
    render(<App />);
    const groups = () => [...new Set(commandRegistry.list().map((c) => c.group))].sort();
    expect(groups()).toEqual(
      [
        'Document',
        'Documents',
        'Edit',
        'File',
        'General',
        'Language',
        'Navigate',
        'Pages',
        'Tools',
        'View',
        'Zoom',
      ].sort(),
    );
    setLocale('tr');
    await waitFor(() => {
      expect(groups()).toEqual(
        [
          'Araçlar',
          'Belge',
          'Belgeler',
          'Dil',
          'Dosya',
          'Düzen',
          'Genel',
          'Gezinme',
          'Görünüm',
          'Sayfalar',
          'Yakınlaştırma',
        ].sort(),
      );
    });
    expect(commandRegistry.get('section.split')?.title).toBe('Belgeyi böl…');
    expect(commandRegistry.get('pages.cut')?.group).toBe('Sayfalar');
  });
});
