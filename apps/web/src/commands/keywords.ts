/**
 * Palette keywords from the message catalogs (spec experience-redesign §8). A command
 * `tool.ink` reads `cmd_tool_ink_keywords`, a comma-separated list, in **every** UI
 * language: a bilingual user can type "kalem" in the English UI or "draw" in the Turkish
 * one. The registry adds these to a command's own `keywords`; matching folds case and
 * diacritics (`fuzzy.ts`), so "ciz" finds "çiz".
 */
import { type Locale, locales, m } from '../i18n';

type KeywordMessage = (inputs?: Record<string, never>, options?: { locale?: Locale }) => string;

const messages = m as unknown as Readonly<Record<string, KeywordMessage | undefined>>;

/**
 * The message key holding a command's keywords: dots, dashes and camel case become
 * underscores. `documents.mergeAll` -> `cmd_documents_merge_all_keywords`.
 */
export function keywordMessageKey(commandId: string): string {
  const snake = commandId
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
  return `cmd_${snake}_keywords`;
}

/** Splits a catalog entry ("draw, pencil, el yazısı") into trimmed, non-empty keywords. */
export function splitKeywords(text: string): string[] {
  return text
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '');
}

/** A command's catalog keywords for one language; empty when it has none. */
export function catalogKeywords(commandId: string, locale: Locale): string[] {
  const message = messages[keywordMessageKey(commandId)];
  return typeof message === 'function' ? splitKeywords(message({}, { locale })) : [];
}

/** A command's catalog keywords in every UI language, without duplicates. */
export function messageKeywords(commandId: string): string[] {
  const all = new Set<string>();
  for (const locale of locales) {
    for (const keyword of catalogKeywords(commandId, locale)) all.add(keyword);
  }
  return [...all];
}
