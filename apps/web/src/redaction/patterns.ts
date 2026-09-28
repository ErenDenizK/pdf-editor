/**
 * Offline pattern helpers for finding sensitive data (redaction spec §1.1): e-mail
 * addresses, phone numbers (international and Turkish), IBANs (mod-97), Turkish national
 * ids (TCKN checksum), payment card numbers (Luhn) and dates. Pure functions over plain
 * text; nothing leaves the page. A candidate found by a regular expression only counts
 * when its checksum or structure validates, so the review list stays short.
 *
 * Where matches of different patterns overlap (a card number inside an IBAN), the pattern
 * earlier in `PATTERN_IDS` wins.
 */

export const PATTERN_IDS = ['email', 'iban', 'card', 'tckn', 'phone', 'date'] as const;
export type PatternId = (typeof PATTERN_IDS)[number];

export interface PatternMatch {
  readonly pattern: PatternId;
  /** UTF-16 offsets into the searched text, `end` exclusive. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const digitsOf = (value: string): string => value.replace(/\D/g, '');

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/** Luhn (mod 10) check over the digits of `value`. */
export function luhnValid(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length === 0) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Payment card number: 13 to 19 digits, a known issuer prefix (Visa, Mastercard, American
 * Express, Discover, JCB, Diners, UnionPay, Maestro, Troy) and a valid Luhn check digit.
 */
export function isCardNumber(value: string): boolean {
  const d = digitsOf(value);
  if (d.length < 13 || d.length > 19) return false;
  const p2 = Number(d.slice(0, 2));
  const p3 = Number(d.slice(0, 3));
  const p4 = Number(d.slice(0, 4));
  const p6 = Number(d.slice(0, 6));
  const len = d.length;
  const known =
    (d.startsWith('4') && (len === 13 || len === 16 || len === 19)) || // Visa
    (((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) && len === 16) || // Mastercard
    ((p2 === 34 || p2 === 37) && len === 15) || // American Express
    ((p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649) || (p6 >= 622126 && p6 <= 622925)) &&
      len >= 16) || // Discover
    (p4 >= 3528 && p4 <= 3589 && len >= 16) || // JCB
    ((p2 === 36 || p2 === 38 || p2 === 39 || (p3 >= 300 && p3 <= 305)) && len >= 14) || // Diners
    (p2 === 62 && len >= 16) || // UnionPay
    ((p2 === 50 || (p2 >= 56 && p2 <= 69)) && len >= 12) || // Maestro
    (p4 === 9792 && len === 16); // Troy (Türkiye)
  return known && luhnValid(d);
}

/**
 * Turkish national identity number (T.C. Kimlik No): 11 digits, the first not zero,
 * digit 10 = ((d1 + d3 + d5 + d7 + d9) × 7 − (d2 + d4 + d6 + d8)) mod 10 and
 * digit 11 = (d1 + … + d10) mod 10.
 */
export function isTckn(value: string): boolean {
  if (!/^[1-9]\d{10}$/.test(value)) return false;
  const d = Array.from(value, Number);
  const at = (i: number) => d[i] ?? 0;
  const odd = at(0) + at(2) + at(4) + at(6) + at(8);
  const even = at(1) + at(3) + at(5) + at(7);
  const tenth = (((odd * 7 - even) % 10) + 10) % 10;
  if (tenth !== at(9)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += at(i);
  return sum % 10 === at(10);
}

/** IBAN lengths by country (SWIFT IBAN registry): country code followed by length. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.fromEntries(
  (
    'AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BR29 BY28 CH21 CR22 CY28 CZ24 ' +
    'DE22 DK18 DO28 EE20 EG29 ES24 FI18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 ' +
    'HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20 ' +
    'LV21 MC27 MD24 ME22 MK19 MR27 MT31 MU30 NL18 NO15 PK24 PL28 PS29 PT25 QA29 ' +
    'RO24 RS22 SA24 SC31 SE24 SI19 SK24 SM27 ST25 SV28 TL23 TN24 TR26 UA29 VA22 ' +
    'VG24 XK20'
  )
    .split(' ')
    .map((entry) => [entry.slice(0, 2), Number(entry.slice(2))]),
);

/** IBAN: known country, its exact length, and the ISO 13616 mod-97 check (remainder 1). */
export function isIban(value: string): boolean {
  const compact = value.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) return false;
  if (IBAN_LENGTHS[compact.slice(0, 2)] !== compact.length) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const part = code >= 65 ? String(code - 55) : ch;
    for (const digit of part) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/**
 * Phone number, from the text of a candidate (digits with single separators):
 * - international: `+` or `00`, then 8 to 15 digits with a country code not starting with
 *   0; for +90 the national number must be a Turkish one (10 digits, 2–5 or 8 first);
 * - Turkish national: trunk 0 and 10 more digits whose first is 2, 3, 4, 5 or 8
 *   (landlines, mobiles, 850 / 800 numbers);
 * - a Turkish mobile without the trunk (5xx xxx xx xx), only when written in groups.
 *
 * Groups may be separated by a space (also a no-break space), `.`, `-` or `/`.
 */
export function isPhoneNumber(value: string): boolean {
  const text = value.trim();
  const opens = (text.match(/\(/g) ?? []).length;
  const closes = (text.match(/\)/g) ?? []).length;
  if (opens !== closes || opens > 1) return false;
  const turkish = (national: string) => /^[2-58]\d{9}$/.test(national);
  if (text.startsWith('+') || text.startsWith('00')) {
    // A trunk 0 in brackets after the country code ("+44 (0)20 …", "+90 (0532) …") is
    // not dialled from abroad.
    const digits = digitsOf(text.replace(/\(0/, '('));
    const rest = text.startsWith('+') ? digits : digits.slice(2);
    if (rest.length < 8 || rest.length > 15 || rest.startsWith('0')) return false;
    if (rest.startsWith('90')) return turkish(rest.slice(2));
    return true;
  }
  const digits = digitsOf(text);
  if (digits.startsWith('0')) return digits.length === 11 && turkish(digits.slice(1));
  return /[\s./()-]/.test(text) && /^5\d{9}$/.test(digits);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Whether day / month / year form a real calendar date (years 1000–2999). */
export function isCalendarDate(day: number, month: number, year: number): boolean {
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return false;
  if (year < 1000 || year > 2999 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function fullYear(text: string): number {
  const year = Number(text);
  if (text.length === 4) return year;
  // Two-digit years: 00–49 → 2000s, 50–99 → 1900s.
  return year < 50 ? 2000 + year : 1900 + year;
}

/** English and Turkish month names (and English abbreviations) → month number. */
const MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  ocak: 1,
  şubat: 2,
  mart: 3,
  nisan: 4,
  mayıs: 5,
  haziran: 6,
  temmuz: 7,
  ağustos: 8,
  eylül: 9,
  ekim: 10,
  kasım: 11,
  aralık: 12,
};
const MONTH_NAMES = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

function monthNumber(name: string): number | undefined {
  return MONTHS[name.toLocaleLowerCase('tr').replace(/\.$/, '')] ?? MONTHS[name.toLowerCase()];
}

// ---------------------------------------------------------------------------
// Finders
// ---------------------------------------------------------------------------

// Candidates; boundaries keep them from starting or ending inside a longer token.
/** A blank inside a grouped number: a space, a no-break space (U+00A0, U+202F) or a tab. */
const GAP = String.raw`[ \t\u00A0\u202F]`;
const EMAIL =
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}-]|\.[\p{L}\p{N}])/gu;
// Groups may be separated by up to three blanks (justified text); the finder cuts the
// candidate at its country's length.
const IBAN = new RegExp(
  String.raw`(?<![\p{L}\p{N}])[A-Z]{2}\d{2}(?:${GAP}{0,3}[A-Z0-9]){11,32}`,
  'giu',
);
const CARD = /(?<![\p{N}])\d(?:[ -]?\d){11,18}(?![\p{N}])/gu;
// Eleven digits, compact or in the 3-3-3-2 groups used on forms ("100 000 001 46").
const TCKN = new RegExp(
  String.raw`(?<!\p{N})[1-9]\d{10}(?!\p{N})|(?<!\p{N}${GAP}?)[1-9]\d{2}(?:${GAP}\d{3}){2}${GAP}\d{2}(?!${GAP}?\p{N})`,
  'gu',
);
const PHONE_GROUP = String.raw`(?:\(\d{1,4}\)|\d{1,4})`;
const PHONE = new RegExp(
  String.raw`(?<![\p{L}\p{N}+])(?:\+|00)?${GAP}?${PHONE_GROUP}(?:(?:${GAP}|[.\/-])?${PHONE_GROUP}){1,7}(?![\p{L}\p{N}])`,
  'gu',
);
const NUMERIC_DATE =
  /(?<![\p{N}./-])(?:(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})|(\d{4})-(\d{1,2})-(\d{1,2}))(?![\p{N}]|[./-]\p{N})/gu;
const NAMED_DATE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:(\d{1,2})\.?\s+(${MONTH_NAMES})\.?,?\s+(\d{4})|(${MONTH_NAMES})\.?\s+(\d{1,2}),?\s+(\d{4}))(?![\p{L}\p{N}])`,
  'giu',
);

function* matches(regex: RegExp, text: string): Generator<RegExpExecArray> {
  regex.lastIndex = 0;
  for (let m = regex.exec(text); m !== null; m = regex.exec(text)) {
    yield m;
    if (m[0].length === 0) regex.lastIndex += 1;
  }
}

function match(pattern: PatternId, text: string, start: number, end: number): PatternMatch {
  return { pattern, start, end, text: text.slice(start, end) };
}

/** The IBAN at the start of a candidate: exactly its country's length of characters. */
function ibanPrefix(candidate: string): number | undefined {
  const length = IBAN_LENGTHS[candidate.slice(0, 2).toUpperCase()];
  if (length === undefined) return undefined;
  let count = 0;
  for (let i = 0; i < candidate.length; i++) {
    if (!/\s/.test(candidate[i] ?? ' ')) count += 1;
    if (count === length) return isIban(candidate.slice(0, i + 1)) ? i + 1 : undefined;
  }
  return undefined;
}

function findEmails(text: string): PatternMatch[] {
  return [...matches(EMAIL, text)].map((m) => match('email', text, m.index, m.index + m[0].length));
}

function findIbans(text: string): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const m of matches(IBAN, text)) {
    const length = ibanPrefix(m[0]);
    if (length !== undefined) out.push(match('iban', text, m.index, m.index + length));
    // The candidate is greedy and may run into the next IBAN on the line: resume right
    // after the IBAN found, or after the country code of a candidate that is not one.
    IBAN.lastIndex = m.index + (length ?? 1);
  }
  return out;
}

function findCards(text: string): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const m of matches(CARD, text)) {
    if (isCardNumber(m[0])) out.push(match('card', text, m.index, m.index + m[0].length));
  }
  return out;
}

function findTckns(text: string): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const m of matches(TCKN, text)) {
    if (isTckn(digitsOf(m[0]))) out.push(match('tckn', text, m.index, m.index + m[0].length));
  }
  return out;
}

function findPhones(text: string): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const m of matches(PHONE, text)) {
    const lead = m[0].length - m[0].trimStart().length;
    const value = m[0].trim();
    if (isPhoneNumber(value))
      out.push(match('phone', text, m.index + lead, m.index + lead + value.length));
  }
  return out;
}

function findDates(text: string): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const m of matches(NUMERIC_DATE, text)) {
    let ok: boolean;
    if (m[5] !== undefined) {
      ok = isCalendarDate(Number(m[7]), Number(m[6]), Number(m[5]));
    } else {
      const a = Number(m[1]);
      const b = Number(m[3]);
      const year = fullYear(m[4] ?? '');
      // Day first (Türkiye, most of Europe) or month first (US).
      ok = isCalendarDate(a, b, year) || isCalendarDate(b, a, year);
    }
    if (ok) out.push(match('date', text, m.index, m.index + m[0].length));
  }
  for (const m of matches(NAMED_DATE, text)) {
    const day = Number(m[1] ?? m[5]);
    const month = monthNumber(m[2] ?? m[4] ?? '');
    const year = Number(m[3] ?? m[6]);
    if (month !== undefined && isCalendarDate(day, month, year)) {
      out.push(match('date', text, m.index, m.index + m[0].length));
    }
  }
  return out;
}

const FINDERS: Readonly<Record<PatternId, (text: string) => PatternMatch[]>> = {
  email: findEmails,
  iban: findIbans,
  card: findCards,
  tckn: findTckns,
  phone: findPhones,
  date: findDates,
};

/**
 * Every match of `patterns` in `text`, sorted by position. Overlapping matches keep the
 * one whose pattern comes first in `PATTERN_IDS`.
 */
export function findPatterns(
  text: string,
  patterns: readonly PatternId[] = PATTERN_IDS,
): PatternMatch[] {
  const kept: PatternMatch[] = [];
  for (const id of PATTERN_IDS) {
    if (!patterns.includes(id)) continue;
    for (const found of FINDERS[id](text)) {
      if (kept.some((k) => found.start < k.end && k.start < found.end)) continue;
      kept.push(found);
    }
  }
  return kept.sort((a, b) => a.start - b.start || a.end - b.end);
}
