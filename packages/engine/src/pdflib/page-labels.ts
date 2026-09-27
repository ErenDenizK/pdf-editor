/**
 * Page label formatting (ISO 32000-1 §12.4.2) used for the `{label}` overlay token and for
 * writing /PageLabels.
 */

import type { PageLabelRange, PageLabelStyle } from '@pdf-editor/document-model';

const ROMAN: readonly [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

export function toRoman(n: number): string {
  let rest = Math.max(0, Math.floor(n));
  let out = '';
  for (const [value, symbol] of ROMAN) {
    while (rest >= value) {
      out += symbol;
      rest -= value;
    }
  }
  return out;
}

/** PDF alphabetic numbering: a..z, then aa..zz, then aaa..zzz (letters repeat). */
export function toAlpha(n: number): string {
  if (n < 1) return '';
  const letter = String.fromCharCode(97 + ((n - 1) % 26));
  return letter.repeat(Math.floor((n - 1) / 26) + 1);
}

export function formatNumber(style: PageLabelStyle, n: number): string {
  switch (style) {
    case 'decimal':
      return String(n);
    case 'roman-upper':
      return toRoman(n).toUpperCase();
    case 'roman-lower':
      return toRoman(n);
    case 'alpha-upper':
      return toAlpha(n).toUpperCase();
    case 'alpha-lower':
      return toAlpha(n);
    case 'none':
      return '';
  }
}

/** Ranges that apply to a document of `pageCount` pages, sorted by start index. */
export function effectiveRanges(
  ranges: readonly PageLabelRange[],
  pageCount: number,
): PageLabelRange[] {
  return ranges
    .filter((r) => Number.isInteger(r.startIndex) && r.startIndex >= 0 && r.startIndex < pageCount)
    .sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * Label of page `index`. Pages before the first range (or all pages without ranges) get
 * their 1-based position.
 */
export function labelForIndex(ranges: readonly PageLabelRange[], index: number): string {
  let range: PageLabelRange | undefined;
  for (const r of ranges) {
    if (r.startIndex <= index) range = r;
    else break;
  }
  if (!range) return String(index + 1);
  const n = (range.firstNumber ?? 1) + (index - range.startIndex);
  return `${range.prefix ?? ''}${formatNumber(range.style, n)}`;
}

export const PDF_LABEL_STYLE: Readonly<Record<PageLabelStyle, string | undefined>> = {
  decimal: 'D',
  'roman-upper': 'R',
  'roman-lower': 'r',
  'alpha-upper': 'A',
  'alpha-lower': 'a',
  none: undefined,
};
