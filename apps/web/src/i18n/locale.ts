/**
 * Locale state for the compiled Paraglide messages (ADR-0010).
 *
 * Resolution order, once at startup: `?lang=` override → saved choice (localStorage) →
 * `navigator.languages` (exact tag, then base language) → `en`. The `?lang=` override is
 * not persisted; an explicit choice (the Language commands) is, and it drops `lang` from
 * the address so the choice sticks on reload.
 *
 * Paraglide's `getLocale`/`setLocale` are overwritten so every `m.*()` call reads one
 * in-memory value (no storage or URL parsing per message) and never reloads the page.
 * Components re-render on a change because `LocaleBoundary` remounts the tree.
 */
import { readJson, writeJson } from '../state/safe-storage';
import {
  baseLocale,
  getTextDirection,
  isLocale,
  type Locale,
  locales,
  overwriteGetLocale,
  overwriteSetLocale,
} from './paraglide/runtime.js';

export type { Locale } from './paraglide/runtime.js';
export { baseLocale, locales } from './paraglide/runtime.js';

export const LOCALE_STORAGE_KEY = 'pdf-editor:locale:v1';
export const LOCALE_QUERY_PARAM = 'lang';

/** Language names in their own language, as shown in the Language commands. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  en: 'English',
  tr: 'Türkçe',
};

/** Canonical locale for a BCP 47 tag, matching the full tag first, then its language. */
export function matchLocale(tag: string | null | undefined): Locale | undefined {
  if (!tag) return undefined;
  const lower = tag.trim().toLowerCase();
  const exact = locales.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  const language = lower.split(/[-_]/)[0];
  return locales.find((l) => l.toLowerCase() === language);
}

export interface LocaleSources {
  /** `location.search`, e.g. `?lang=tr`. */
  readonly search?: string;
  /** The saved choice, as read from storage (any type; validated here). */
  readonly stored?: unknown;
  /** `navigator.languages`. */
  readonly languages?: readonly string[];
}

/** Pure locale detection; see the module comment for the order. */
export function detectLocale({ search = '', stored, languages = [] }: LocaleSources): Locale {
  const fromQuery = matchLocale(new URLSearchParams(search).get(LOCALE_QUERY_PARAM));
  if (fromQuery) return fromQuery;
  if (typeof stored === 'string' && isLocale(stored)) return stored;
  for (const tag of languages) {
    const match = matchLocale(tag);
    if (match) return match;
  }
  return baseLocale;
}

function detectFromEnvironment(): Locale {
  return detectLocale({
    search: globalThis.location?.search ?? '',
    stored: readJson(LOCALE_STORAGE_KEY),
    languages: globalThis.navigator?.languages ?? [],
  });
}

let current: Locale = detectFromEnvironment();
const listeners = new Set<() => void>();

/** Mirrors the locale on `<html lang dir>` for assistive tech, hyphenation and fonts. */
export function applyDocumentLocale(locale: Locale = current): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  root.lang = locale;
  root.dir = getTextDirection(locale);
}

export function getLocale(): Locale {
  return current;
}

/**
 * Switches the UI language at runtime and persists the choice. Returns false when
 * `locale` is already active.
 */
export function setLocale(locale: Locale): boolean {
  if (locale === current) return false;
  current = locale;
  writeJson(LOCALE_STORAGE_KEY, locale);
  dropQueryOverride();
  applyDocumentLocale(locale);
  for (const listener of listeners) listener();
  return true;
}

function dropQueryOverride(): void {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has(LOCALE_QUERY_PARAM)) return;
    url.searchParams.delete(LOCALE_QUERY_PARAM);
    history.replaceState(history.state, '', url);
  } catch {
    // Sandboxed or opaque origins: the override simply stays in the address.
  }
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

overwriteGetLocale(() => current);
overwriteSetLocale((locale) => {
  setLocale(locale);
});
applyDocumentLocale();
