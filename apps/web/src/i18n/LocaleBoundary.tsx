import { Fragment, type ReactNode } from 'react';

import { useLocale } from './use-locale';

/**
 * Remounts its subtree when the locale changes. The React Compiler caches JSX whose inputs
 * do not change, and a message call such as `m.open_files()` has no reactive input, so a
 * plain re-render would keep the old language. App state lives in stores outside React,
 * so a remount only costs a repaint; the language changes rarely.
 */
export function LocaleBoundary({ children }: { readonly children: ReactNode }) {
  const locale = useLocale();
  return <Fragment key={locale}>{children}</Fragment>;
}
