/**
 * Unit tests: the redacted-string normaliser and matcher, and the encodings of the byte
 * grep (research 06 §4 check 6).
 */

import { describe, expect, test } from 'vitest';

import { byteVariants, grepBytes } from './byte-grep';
import { normalizeForMatch, RedactedStringMatcher } from './strings';

const TOKEN = 'SECRET-7731';
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const utf16be = (s: string) => {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    out[i * 2] = s.charCodeAt(i) >> 8;
    out[i * 2 + 1] = s.charCodeAt(i) & 0xff;
  }
  return out;
};
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const found = (hay: Uint8Array, s = TOKEN) => grepBytes(hay, byteVariants(s)).map((h) => h.variant);

describe('normalizeForMatch', () => {
  test('folds case and drops whitespace and invisible characters', () => {
    expect(normalizeForMatch('  Secret -\t7731\n')).toBe('secret-7731');
    expect(normalizeForMatch('SECRET\u00a0-\u200b7731\u00ad')).toBe('secret-7731');
    expect(normalizeForMatch('\ufeffSECRET-7731')).toBe('secret-7731');
  });

  test('drops joiners, invisible operators and directional marks (a copy with one inside)', () => {
    for (const cp of [0x200c, 0x200d, 0x2060, 0x034f, 0x2062, 0x200e, 0x202c, 0x2066]) {
      expect(normalizeForMatch(`SECRET-77${String.fromCodePoint(cp)}31`)).toBe('secret-7731');
    }
  });

  test('the ASCII fast path agrees with the general normalisation', () => {
    for (const s of ['  Secret -\t7731\n', 'A\x0bB\x0cC', 'MiXeD CaSe 123 !?', '']) {
      expect(normalizeForMatch(s)).toBe(normalizeForMatch(`${s}\u200b`));
    }
  });

  test('applies NFKC, so compatibility forms match', () => {
    expect(normalizeForMatch('ＳＥＣＲＥＴ－７７３１')).toBe('secret-7731');
    expect(normalizeForMatch('ﬁle')).toBe('file');
  });
});

describe('RedactedStringMatcher', () => {
  const m = new RedactedStringMatcher([TOKEN, '  ', '']);

  test('ignores empty strings and matches regardless of case and spacing', () => {
    expect(m.needles).toEqual(['secret-7731']);
    expect(m.matches('Findings on secret - 7731.')).toBe(true);
    expect(m.matches('SECRET-7732')).toBe(false);
    expect(new RedactedStringMatcher([]).matches(TOKEN)).toBe(false);
    expect(new RedactedStringMatcher([' ']).empty).toBe(true);
  });

  test('replaces every occurrence and keeps the text around it', () => {
    expect(m.replace('Findings on Secret - 7731, see SECRET-7731!', '[redacted]')).toBe(
      'Findings on [redacted], see [redacted]!',
    );
    expect(m.replace('nothing here', 'X')).toBe('nothing here');
  });

  test('maps matches back through NFKC and case changes', () => {
    expect(m.replace('a ＳＥＣＲＥＴ－７７３１ b', '#')).toBe('a # b');
  });

  test('repeats until no match is left (a removal can join two halves)', () => {
    expect(m.replace('SECSECRET-7731RET-7731', '')).toBe('');
    expect(m.matches(m.replace('SECSECRET-7731RET-7731 tail', ''))).toBe(false);
  });

  test('picks a placeholder that does not contain a redacted string', () => {
    expect(m.placeholder()).toBe('[redacted]');
    expect(m.placeholder('XXX')).toBe('XXX');
    expect(m.placeholder('secret-7731 removed')).toBe('[redacted]');
    expect(new RedactedStringMatcher(['redacted']).placeholder()).toBe('[…]');
  });
});

describe('byte grep encodings', () => {
  const pad = latin1('<< /Junk (abc) >> ');

  test('finds ASCII in any letter case', () => {
    expect(found(concat(pad, latin1(TOKEN), pad))).toContain('ascii');
    expect(found(concat(pad, latin1('secret-7731'), pad))).toContain('ascii');
  });

  test('finds UTF-16BE with and without a byte-order mark', () => {
    expect(found(concat(pad, utf16be(TOKEN), pad))).toEqual(['utf16be']);
    expect(found(concat(pad, new Uint8Array([0xfe, 0xff]), utf16be(TOKEN), pad))).toEqual([
      'utf16be',
      'utf16be-bom',
    ]);
  });

  test('finds hex-encoded ASCII and UTF-16BE in both digit cases', () => {
    expect(found(latin1(`<${hex(latin1(TOKEN))}> Tj`))).toEqual(['ascii-hex']);
    expect(found(latin1(`<${hex(latin1(TOKEN)).toUpperCase()}> Tj`))).toEqual(['ascii-hex']);
    expect(found(latin1(`<${hex(latin1('secret-7731'))}>`))).toEqual(['ascii-hex']);
    expect(found(latin1(`<${hex(utf16be(TOKEN)).toUpperCase()}>`))).toEqual(['utf16be-hex']);
    expect(found(latin1(`<FEFF${hex(utf16be(TOKEN))}>`))).toEqual([
      'utf16be-hex',
      'utf16be-bom-hex',
    ]);
  });

  test('matches whitespace runs in the text, and hex without the spaces', () => {
    const s = 'SECRET 7731';
    expect(found(latin1('xx SECRET\r\n   7731 xx'), s)).toContain('ascii');
    expect(found(latin1('xxSECRET7731xx'), s)).toContain('ascii');
    expect(found(concat(utf16be('SECRET'), utf16be('\t\t'), utf16be('7731')), s)).toContain(
      'utf16be',
    );
    expect(found(latin1(`<${hex(latin1('SECRET7731'))}>`), s)).toEqual(['ascii-hex']);
  });

  test('finds literal-string escapes of parentheses and backslashes', () => {
    expect(found(latin1('(a \\(SECRET\\) b) Tj'), '(SECRET)')).toContain('literal-escaped');
  });

  test('does not match a different string or a partial one', () => {
    expect(found(latin1('SECRET-7732 SECRET-773 ECRET-7731'))).toEqual([]);
    expect(found(utf16be('SECRET-7732'))).toEqual([]);
    expect(found(new Uint8Array(0))).toEqual([]);
    expect(byteVariants('   ')).toEqual([]);
  });
});
