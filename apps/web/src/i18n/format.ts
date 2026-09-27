/** Locale-aware number formatting for the chrome (tabular numerals stay in CSS). */
import { getLocale } from './locale';

/** `1.25` → "125%" (en) / "%125" (tr). */
export function formatPercent(ratio: number): string {
  return new Intl.NumberFormat(getLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(
    ratio,
  );
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getLocale(), options).format(value);
}
