import { useSyncExternalStore } from 'react';

import { getLocale, type Locale, subscribeLocale } from './locale';

/** The active locale; re-renders the caller when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}
