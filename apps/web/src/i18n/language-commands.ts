/**
 * Palette commands to switch the UI language at runtime (persisted). The active language
 * is shown dimmed; names are always in their own language.
 */
import type { CommandRegistry } from '../commands/registry';
import { announce } from '../shell/announcer';
import { getLocale, LOCALE_NAMES, type Locale, locales, setLocale } from './locale';
import { m } from './paraglide/messages.js';

const KEYWORDS: Readonly<Record<Locale, readonly string[]>> = {
  en: ['english', 'ingilizce'],
  tr: ['turkish', 'türkçe', 'turkce'],
};

export function registerLanguageCommands(registry: CommandRegistry): () => void {
  const disposers = locales.map((locale) =>
    registry.register({
      id: `language.${locale}`,
      title: LOCALE_NAMES[locale],
      group: m.group_language(),
      keywords: ['language', 'dil', 'locale', 'lang', ...KEYWORDS[locale]],
      when: () => getLocale() !== locale,
      run: () => {
        if (!setLocale(locale)) return;
        // After the shell has remounted in the new language, so the live region exists.
        setTimeout(() => {
          announce(m.announce_language({ language: LOCALE_NAMES[locale] }));
        }, 100);
      },
    }),
  );
  return () => {
    for (const dispose of disposers) dispose();
  };
}
