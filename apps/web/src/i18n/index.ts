/**
 * i18n entry point (ADR-0010). Import messages from here, never from `./paraglide`
 * directly: this module installs the locale resolution before any message is called.
 *
 *   import { m } from '../i18n';
 *   m.open_files();                 // "Open files" / "Dosya aç"
 *   m.pages_count({ count: 3 });    // "3 pages" / "3 sayfa"
 */
export {
  applyDocumentLocale,
  detectLocale,
  getLocale,
  LOCALE_NAMES,
  type Locale,
  locales,
  matchLocale,
  setLocale,
  subscribeLocale,
} from './locale';
export { m } from './paraglide/messages.js';
export { formatNumber, formatPercent } from './format';
export { useLocale } from './use-locale';
