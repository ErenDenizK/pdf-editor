/** Pattern helpers (redaction spec §1.1): every pattern with positives and negatives. */
import { describe, expect, it } from 'vitest';

import {
  findPatterns,
  isCalendarDate,
  isCardNumber,
  isIban,
  isPhoneNumber,
  isTckn,
  luhnValid,
  type PatternId,
} from './patterns';

function found(text: string, pattern: PatternId): string[] {
  return findPatterns(text, [pattern]).map((m) => m.text);
}

/** A valid TCKN from its first nine digits (the checksum rules, computed independently). */
function tcknFrom(nine: string): string {
  const d = Array.from(nine, Number);
  const odd = (d[0] ?? 0) + (d[2] ?? 0) + (d[4] ?? 0) + (d[6] ?? 0) + (d[8] ?? 0);
  const even = (d[1] ?? 0) + (d[3] ?? 0) + (d[5] ?? 0) + (d[7] ?? 0);
  const tenth = (((odd * 7 - even) % 10) + 10) % 10;
  const eleventh = (d.reduce((a, b) => a + b, 0) + tenth) % 10;
  return `${nine}${tenth}${eleventh}`;
}

describe('e-mail addresses', () => {
  it('finds addresses in running text', () => {
    expect(found('Write to jane.doe+pdf@example.com.tr or ali@şirket.com.', 'email')).toEqual([
      'jane.doe+pdf@example.com.tr',
      'ali@şirket.com',
    ]);
    expect(found('(Contact: ops@mail.example.org)', 'email')).toEqual(['ops@mail.example.org']);
  });

  it('ignores what only looks like one', () => {
    expect(found('a@b', 'email')).toEqual([]);
    expect(found('user@localhost and @example.com and name@.com', 'email')).toEqual([]);
    expect(found('price 5@3.00', 'email')).toEqual([]);
  });
});

describe('phone numbers', () => {
  it('accepts international and Turkish formats', () => {
    for (const phone of [
      '+90 532 123 45 67',
      '+90 (532) 123-45-67',
      '0090 212 555 12 34',
      '0532 123 45 67',
      '0 (532) 123 45 67',
      '(0212) 555 12 34',
      '0850 222 03 33',
      '05321234567',
      '532 123 45 67',
      '+44 20 7946 0958',
      '+1 415 555 2671',
      '+49 30 901820',
    ]) {
      expect(isPhoneNumber(phone), phone).toBe(true);
      expect(found(`Tel: ${phone}.`, 'phone'), phone).toEqual([phone]);
    }
  });

  it('rejects numbers that are not phone numbers', () => {
    for (const text of [
      '5321234567', // a bare 10-digit number without grouping
      '0132 123 45 67', // no Turkish area code starts with 1
      '0532 123 45', // too short
      '+90 132 123 45 67', // +90 with an invalid national number
      '+0 123 456 789',
      '+123 45',
      '12.03.2024',
      '(0532 123 45 67',
    ]) {
      expect(isPhoneNumber(text), text).toBe(false);
    }
    expect(found('Invoice 2024-000123, total 1.234.567', 'phone')).toEqual([]);
  });
});

describe('IBAN', () => {
  it('accepts valid IBANs, grouped or compact', () => {
    for (const iban of [
      'TR33 0006 1005 1978 6457 8413 26',
      'TR330006100519786457841326',
      'DE89 3704 0044 0532 0130 00',
      'GB82 WEST 1234 5698 7654 32',
      'NL91ABNA0417164300',
    ]) {
      expect(isIban(iban), iban).toBe(true);
      expect(found(`IBAN: ${iban} (main account)`, 'iban'), iban).toEqual([iban]);
    }
  });

  it('stops at the country length and rejects a wrong check', () => {
    expect(found('TR33 0006 1005 1978 6457 8413 26 99 more', 'iban')).toEqual([
      'TR33 0006 1005 1978 6457 8413 26',
    ]);
    expect(isIban('TR33 0006 1005 1978 6457 8413 27')).toBe(false);
    expect(isIban('DE89 3704 0044 0532 0130 0')).toBe(false); // wrong length
    expect(isIban('XX89 3704 0044 0532 0130 00')).toBe(false); // unknown country
    expect(found('TR34 0006 1005 1978 6457 8413 26', 'iban')).toEqual([]);
  });
});

describe('Turkish national id (TCKN)', () => {
  it('accepts numbers with valid check digits', () => {
    expect(isTckn('10000000146')).toBe(true);
    for (const nine of ['123456789', '987654321', '555666777']) {
      const id = tcknFrom(nine);
      expect(isTckn(id), id).toBe(true);
      expect(found(`T.C. Kimlik No: ${id}`, 'tckn')).toEqual([id]);
    }
  });

  it('rejects wrong check digits, a leading zero and other lengths', () => {
    expect(isTckn('10000000147')).toBe(false);
    expect(isTckn('10000000156')).toBe(false);
    expect(isTckn('01234567890')).toBe(false);
    expect(isTckn('1000000014')).toBe(false);
    expect(found('Order 100000001460', 'tckn')).toEqual([]); // part of a longer number
  });
});

describe('payment cards (Luhn)', () => {
  it('accepts well-known test numbers, grouped or not', () => {
    for (const card of [
      '4111 1111 1111 1111',
      '4111-1111-1111-1111',
      '5555555555554444',
      '3782 822463 10005',
      '6011 1111 1111 1117',
      '2223 0031 2200 3222',
    ]) {
      expect(isCardNumber(card), card).toBe(true);
      expect(found(`Card: ${card}.`, 'card'), card).toEqual([card]);
    }
  });

  it('rejects a failed Luhn check and unknown issuers', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(isCardNumber('4111 1111 1111 1112')).toBe(false);
    expect(isCardNumber('1234 5678 9012 3452')).toBe(false); // Luhn-valid, no issuer
    expect(isCardNumber('4111 1111 1111')).toBe(false); // too short
    expect(found('Reference 4111111111111112', 'card')).toEqual([]);
  });
});

describe('dates', () => {
  it('finds numeric and named dates in English and Turkish', () => {
    expect(
      found(
        'Born 03.07.1985, issued 2024-02-29, due 12/31/2025, on 5 Mart 2024, 29 Şubat 2024, March 12, 2024 and 1 Jan 2020.',
        'date',
      ),
    ).toEqual([
      '03.07.1985',
      '2024-02-29',
      '12/31/2025',
      '5 Mart 2024',
      '29 Şubat 2024',
      'March 12, 2024',
      '1 Jan 2020',
    ]);
    expect(found('Tarih: 15.06.24', 'date')).toEqual(['15.06.24']);
  });

  it('rejects impossible dates and version numbers', () => {
    expect(isCalendarDate(29, 2, 2023)).toBe(false);
    expect(isCalendarDate(29, 2, 2000)).toBe(true);
    expect(isCalendarDate(29, 2, 1900)).toBe(false);
    expect(
      found('32.01.2024, 2024-13-01, 31.02.2024, 31 Nisan 2024, v1.2.3, 1.2.2024.5', 'date'),
    ).toEqual([]);
  });
});

describe('findPatterns', () => {
  it('reports every pattern, sorted, and resolves overlaps by priority', () => {
    const text =
      'Ali Veli, TCKN 10000000146, ali@example.com, +90 532 123 45 67, IBAN TR33 0006 1005 1978 6457 8413 26, card 4111 1111 1111 1111, 01.02.2024';
    const all = findPatterns(text);
    expect(all.map((m) => [m.pattern, m.text])).toEqual([
      ['tckn', '10000000146'],
      ['email', 'ali@example.com'],
      ['phone', '+90 532 123 45 67'],
      ['iban', 'TR33 0006 1005 1978 6457 8413 26'],
      ['card', '4111 1111 1111 1111'],
      ['date', '01.02.2024'],
    ]);
    for (const m of all) expect(text.slice(m.start, m.end)).toBe(m.text);
    expect(findPatterns('nothing to see here')).toEqual([]);
  });
});
