/**
 * Keymap parsing, matching and formatting.
 *
 * Shortcut strings use `+` separated tokens, modifiers first: `Mod+K`, `Mod+Alt+B`, `?`,
 * `Shift+R`, `Mod+=`. `Mod` resolves to Cmd on macOS and Ctrl elsewhere. Key sequences
 * (`g g`) are intentionally not supported.
 *
 * Matching rules:
 * - Modifiers must match exactly (Ctrl, Meta, Alt). Shift must match exactly for letters,
 *   digits and named keys. For printable symbols (`?`, `=`, `-`) Shift is part of how the
 *   character is typed on a given layout, so it is ignored unless the shortcut names it.
 * - Letters and digits compare on `event.key`, falling back to `event.code` only when Alt is
 *   held, because macOS Option turns `B` into `∫`. Using `key` first keeps non-QWERTY
 *   layouts correct.
 * - `=` also matches `+` and `-` also matches `_` so zoom shortcuts work with or without
 *   Shift on US-style layouts.
 */

export type Platform = 'mac' | 'other';

export interface ParsedShortcut {
  /** Normalized key: lowercase letter, digit, symbol, or a `KeyboardEvent.key` name. */
  readonly key: string;
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/** The subset of `KeyboardEvent` the matcher reads; lets tests pass plain objects. */
export interface KeyboardEventLike {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export class ShortcutParseError extends Error {
  override readonly name = 'ShortcutParseError';
}

const MODIFIER_ALIASES: Record<string, 'mod' | 'ctrl' | 'meta' | 'alt' | 'shift'> = {
  mod: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
};

const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: ' ',
  del: 'Delete',
  delete: 'Delete',
  backspace: 'Backspace',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  plus: '+',
  minus: '-',
};

const SYMBOL_EQUIVALENTS: Record<string, readonly string[]> = {
  '=': ['=', '+'],
  '+': ['+', '='],
  '-': ['-', '_'],
};

function normalizeKey(raw: string): string {
  if (raw.length === 1) return raw.toLowerCase();
  const alias = KEY_ALIASES[raw.toLowerCase()];
  if (alias !== undefined) return alias;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  throw new ShortcutParseError(`Unknown key "${raw}"`);
}

/** Parses `Mod+Shift+K` style strings. Throws `ShortcutParseError` on malformed input. */
export function parseShortcut(input: string): ParsedShortcut {
  const source = input.trim();
  if (source === '') throw new ShortcutParseError('Empty shortcut');
  // A trailing "++" means the key itself is "+".
  let tokens: string[];
  if (source === '+') tokens = ['+'];
  else if (source.endsWith('++')) tokens = [...source.slice(0, -2).split('+'), '+'];
  else tokens = source.split('+');
  if (tokens.some((t) => t.trim() === '')) {
    throw new ShortcutParseError(`Malformed shortcut "${input}"`);
  }

  const flags = { mod: false, ctrl: false, meta: false, alt: false, shift: false };
  const keyToken = tokens.pop();
  if (keyToken === undefined) throw new ShortcutParseError(`Missing key in "${input}"`);
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token.trim().toLowerCase()];
    if (modifier === undefined) {
      throw new ShortcutParseError(`Unknown modifier "${token}" in "${input}"`);
    }
    if (flags[modifier]) throw new ShortcutParseError(`Duplicate modifier in "${input}"`);
    flags[modifier] = true;
  }
  const trimmedKey = keyToken.length === 1 ? keyToken : keyToken.trim();
  if (MODIFIER_ALIASES[trimmedKey.toLowerCase()] !== undefined) {
    throw new ShortcutParseError(`Shortcut "${input}" has no non-modifier key`);
  }
  return { key: normalizeKey(trimmedKey), ...flags };
}

/** Resolves `Mod` to the concrete modifier for a platform. */
export function resolveModifiers(
  shortcut: ParsedShortcut,
  platform: Platform,
): { ctrl: boolean; meta: boolean; alt: boolean; shift: boolean } {
  return {
    ctrl: shortcut.ctrl || (shortcut.mod && platform === 'other'),
    meta: shortcut.meta || (shortcut.mod && platform === 'mac'),
    alt: shortcut.alt,
    shift: shortcut.shift,
  };
}

function isLetter(key: string): boolean {
  return key.length === 1 && key >= 'a' && key <= 'z';
}

function isDigit(key: string): boolean {
  return key.length === 1 && key >= '0' && key <= '9';
}

function isSymbol(key: string): boolean {
  return key.length === 1 && !isLetter(key) && !isDigit(key) && key !== ' ';
}

export function matchShortcut(
  event: KeyboardEventLike,
  shortcut: ParsedShortcut,
  platform: Platform,
): boolean {
  const expected = resolveModifiers(shortcut, platform);
  if (event.ctrlKey !== expected.ctrl) return false;
  if (event.metaKey !== expected.meta) return false;
  if (event.altKey !== expected.alt) return false;

  const key = shortcut.key;
  if (isSymbol(key)) {
    if (expected.shift && !event.shiftKey) return false;
    const accepted = SYMBOL_EQUIVALENTS[key] ?? [key];
    return accepted.includes(event.key);
  }

  if (event.shiftKey !== expected.shift) return false;
  if (isLetter(key)) {
    if (event.key.toLowerCase() === key) return true;
    return event.altKey && event.code === `Key${key.toUpperCase()}`;
  }
  if (isDigit(key)) {
    if (event.key === key) return true;
    return (event.altKey || event.shiftKey) && event.code === `Digit${key}`;
  }
  return event.key === key;
}

const MAC_MODIFIER_GLYPHS = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' } as const;
const OTHER_MODIFIER_LABELS = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' } as const;

const KEY_LABELS: Record<string, { mac: string; other: string }> = {
  Escape: { mac: 'Esc', other: 'Esc' },
  Enter: { mac: '↵', other: 'Enter' },
  Tab: { mac: '⇥', other: 'Tab' },
  ' ': { mac: 'Space', other: 'Space' },
  Delete: { mac: '⌦', other: 'Del' },
  Backspace: { mac: '⌫', other: 'Backspace' },
  ArrowUp: { mac: '↑', other: '↑' },
  ArrowDown: { mac: '↓', other: '↓' },
  ArrowLeft: { mac: '←', other: '←' },
  ArrowRight: { mac: '→', other: '→' },
  PageUp: { mac: 'PgUp', other: 'PgUp' },
  PageDown: { mac: 'PgDn', other: 'PgDn' },
  Home: { mac: 'Home', other: 'Home' },
  End: { mac: 'End', other: 'End' },
};

function keyLabel(key: string, platform: Platform): string {
  const label = KEY_LABELS[key];
  if (label) return label[platform];
  return key.length === 1 ? key.toUpperCase() : key;
}

/** Returns one label per keycap, in platform order (macOS: ⌃ ⌥ ⇧ ⌘ key). */
export function formatShortcut(shortcut: ParsedShortcut, platform: Platform): string[] {
  const m = resolveModifiers(shortcut, platform);
  const caps: string[] = [];
  if (platform === 'mac') {
    if (m.ctrl) caps.push(MAC_MODIFIER_GLYPHS.ctrl);
    if (m.alt) caps.push(MAC_MODIFIER_GLYPHS.alt);
    if (m.shift) caps.push(MAC_MODIFIER_GLYPHS.shift);
    if (m.meta) caps.push(MAC_MODIFIER_GLYPHS.meta);
  } else {
    if (m.ctrl) caps.push(OTHER_MODIFIER_LABELS.ctrl);
    if (m.meta) caps.push(OTHER_MODIFIER_LABELS.meta);
    if (m.alt) caps.push(OTHER_MODIFIER_LABELS.alt);
    if (m.shift) caps.push(OTHER_MODIFIER_LABELS.shift);
  }
  caps.push(keyLabel(shortcut.key, platform));
  return caps;
}

/** Value for the `aria-keyshortcuts` attribute (WAI-ARIA 1.2 syntax). */
export function toAriaKeyShortcut(shortcut: ParsedShortcut, platform: Platform): string {
  const m = resolveModifiers(shortcut, platform);
  const parts: string[] = [];
  if (m.ctrl) parts.push('Control');
  if (m.meta) parts.push('Meta');
  if (m.alt) parts.push('Alt');
  if (m.shift) parts.push('Shift');
  const key = shortcut.key === ' ' ? 'Space' : shortcut.key;
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
}

interface NavigatorWithUAData {
  userAgentData?: { platform?: string };
}

/** Best-effort platform detection; `Mod` only needs to know "Apple or not". */
export function detectPlatform(nav: Navigator | undefined = globalThis.navigator): Platform {
  if (!nav) return 'other';
  const hint = (nav as Navigator & NavigatorWithUAData).userAgentData?.platform ?? nav.platform;
  return /mac|iphone|ipad|ipod/i.test(hint ?? '') ? 'mac' : 'other';
}

export const currentPlatform: Platform = detectPlatform();
