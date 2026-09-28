/**
 * Byte-level search for redacted strings (research 06 §4 check 6): the raw file and every
 * inflated stream are searched for each string in the encodings a PDF writer may use.
 *
 * Variants of a string s (whitespace collapsed, then each of s, lower(s), upper(s)):
 * - `ascii`: Latin-1 bytes (UTF-8 when s has characters above U+00FF); `literal-escaped`
 *   when s contains `(`, `)` or `\` (PDF literal-string escapes);
 * - `utf16be` and `utf16be-bom` (FE FF prefix);
 * - `ascii-hex`, `utf16be-hex` and `utf16be-bom-hex`: the hex digits of those bytes, as in
 *   `<…>` strings and PDFium's hex `Tj` operands.
 *
 * Matching folds ASCII letters (so both hex-digit cases and any letter case of the text
 * match). In `ascii` and `utf16be` variants a space matches any run of whitespace, including
 * none, like the text matcher; hex variants are also generated with the whitespace removed.
 */

const encoder = new TextEncoder();

/** One searchable encoding of a string. */
export interface ByteVariant {
  readonly name: string;
  /** Units to match; `null` is a whitespace run of zero or more units. */
  readonly units: readonly (Uint8Array | null)[];
  /** Bytes per unit (1, or 2 for UTF-16BE). */
  readonly unitSize: 1 | 2;
}

/** A match: which variant and where. */
export interface ByteHit {
  readonly variant: string;
  readonly offset: number;
}

function latin1OrUtf8(s: string): Uint8Array {
  let latin1 = true;
  for (let i = 0; i < s.length && latin1; i++) latin1 = s.charCodeAt(i) <= 0xff;
  if (latin1) return Uint8Array.from(s, (c) => c.charCodeAt(0));
  return encoder.encode(s);
}

function utf16be(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    out[i * 2] = s.charCodeAt(i) >> 8;
    out[i * 2 + 1] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Units of a text for a 1- or 2-byte encoding, whitespace as flexible runs. */
function textUnits(s: string, encode: (c: string) => Uint8Array): (Uint8Array | null)[] {
  const units: (Uint8Array | null)[] = [];
  for (const char of s) {
    if (/\s/u.test(char)) {
      if (units[units.length - 1] !== null) units.push(null);
    } else units.push(encode(char));
  }
  return units;
}

function literalUnits(bytes: Uint8Array): Uint8Array[] {
  return [bytes];
}

/** Every byte encoding of `s` worth grepping for (see the module comment). */
export function byteVariants(s: string): ByteVariant[] {
  const collapsed = s.replace(/\s+/gu, ' ').trim();
  if (collapsed === '') return [];
  const out: ByteVariant[] = [];
  const seen = new Set<string>();
  const add = (name: string, units: (Uint8Array | null)[], unitSize: 1 | 2) => {
    const key = `${unitSize}:${units.map((u) => (u === null ? '_' : hex(u).toLowerCase())).join('.')}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, units, unitSize });
  };
  const casings = [collapsed, collapsed.toLowerCase(), collapsed.toUpperCase()];
  const ascii = latin1OrUtf8(collapsed);
  add('ascii', textUnits(collapsed, latin1OrUtf8), 1);
  if (/[()\\]/.test(collapsed)) {
    const escaped = collapsed.replace(/[()\\]/g, (c) => `\\${c}`);
    add('literal-escaped', textUnits(escaped, latin1OrUtf8), 1);
  }
  if (ascii.length !== collapsed.length) add('latin1-utf8', literalUnits(ascii), 1);
  add('utf16be', textUnits(collapsed, utf16be), 2);
  add('utf16be-bom', [new Uint8Array([0xfe, 0xff]), ...textUnits(collapsed, utf16be)], 2);
  for (const casing of casings) {
    for (const form of [casing, casing.replace(/\s/gu, '')]) {
      add('ascii-hex', literalUnits(encoder.encode(hex(latin1OrUtf8(form)))), 1);
      add('utf16be-hex', literalUnits(encoder.encode(hex(utf16be(form)))), 1);
      add('utf16be-bom-hex', literalUnits(encoder.encode(`feff${hex(utf16be(form))}`)), 1);
    }
  }
  return out;
}

const fold = (b: number): number => (b >= 0x41 && b <= 0x5a ? b + 0x20 : b);

function isSpaceUnit(hay: Uint8Array, at: number, unitSize: 1 | 2): boolean {
  if (unitSize === 2 && hay[at] !== 0) return false;
  const b = hay[at + unitSize - 1];
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c;
}

/** Length of the match of `variant` at `at`, or -1. Whitespace runs are greedy. */
function matchAt(hay: Uint8Array, at: number, variant: ByteVariant): number {
  let pos = at;
  for (const unit of variant.units) {
    if (unit === null) {
      while (pos + variant.unitSize <= hay.length && isSpaceUnit(hay, pos, variant.unitSize)) {
        pos += variant.unitSize;
      }
      continue;
    }
    if (pos + unit.length > hay.length) return -1;
    for (let j = 0; j < unit.length; j++) {
      if (fold(hay[pos + j] ?? -1) !== fold(unit[j] ?? -2)) return -1;
    }
    pos += unit.length;
  }
  return pos - at;
}

/** First offset of `variant` in `hay`, or -1. */
export function findVariant(hay: Uint8Array, variant: ByteVariant): number {
  const first = variant.units.find((u) => u !== null);
  if (!first || first.length === 0) return -1;
  const lead = fold(first[0] ?? 0);
  for (let i = 0; i < hay.length; i++) {
    if (fold(hay[i] ?? -1) !== lead) continue;
    if (matchAt(hay, i, variant) >= 0) return i;
  }
  return -1;
}

/** Each variant of `variants` found in `hay`, with its first offset, in variant order. */
export function grepBytes(hay: Uint8Array, variants: readonly ByteVariant[]): ByteHit[] {
  const hits: ByteHit[] = [];
  for (const variant of variants) {
    const offset = findVariant(hay, variant);
    if (offset >= 0) hits.push({ variant: variant.name, offset });
  }
  return hits;
}
