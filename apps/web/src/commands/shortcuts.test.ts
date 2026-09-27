import { describe, expect, it } from 'vitest';

import {
  detectPlatform,
  formatShortcut,
  type KeyboardEventLike,
  matchShortcut,
  parseShortcut,
  ShortcutParseError,
  toAriaKeyShortcut,
} from './shortcuts';

function key(k: string, mods: Partial<KeyboardEventLike> = {}): KeyboardEventLike {
  return { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

describe('parseShortcut', () => {
  it('parses modifiers and normalizes the key', () => {
    expect(parseShortcut('Mod+Shift+K')).toEqual({
      key: 'k',
      mod: true,
      ctrl: false,
      meta: false,
      alt: false,
      shift: true,
    });
    expect(parseShortcut('cmd+option+b')).toMatchObject({ key: 'b', meta: true, alt: true });
    expect(parseShortcut('Esc').key).toBe('Escape');
    expect(parseShortcut('Space').key).toBe(' ');
    expect(parseShortcut('f5').key).toBe('F5');
    expect(parseShortcut('?').key).toBe('?');
  });

  it('parses symbol keys, including a literal plus', () => {
    expect(parseShortcut('Mod+=')).toMatchObject({ key: '=', mod: true });
    expect(parseShortcut('Mod+-')).toMatchObject({ key: '-', mod: true });
    expect(parseShortcut('Mod++')).toMatchObject({ key: '+', mod: true });
    expect(parseShortcut('+')).toMatchObject({ key: '+', mod: false });
  });

  it.each(['', 'Mod+', 'Mod+Shift', 'Hyper+K', 'Mod+Mod+K', 'Mod+Banana'])(
    'rejects %j',
    (input) => {
      expect(() => parseShortcut(input)).toThrow(ShortcutParseError);
    },
  );
});

describe('matchShortcut', () => {
  const modK = parseShortcut('Mod+K');

  it('resolves Mod to Cmd on macOS and Ctrl elsewhere', () => {
    expect(matchShortcut(key('k', { metaKey: true }), modK, 'mac')).toBe(true);
    expect(matchShortcut(key('k', { ctrlKey: true }), modK, 'mac')).toBe(false);
    expect(matchShortcut(key('k', { ctrlKey: true }), modK, 'other')).toBe(true);
    expect(matchShortcut(key('k', { metaKey: true }), modK, 'other')).toBe(false);
  });

  it('requires modifiers to match exactly', () => {
    expect(matchShortcut(key('k', { ctrlKey: true, shiftKey: true }), modK, 'other')).toBe(false);
    expect(matchShortcut(key('k', { ctrlKey: true, altKey: true }), modK, 'other')).toBe(false);
    expect(matchShortcut(key('k'), modK, 'other')).toBe(false);
  });

  it('matches letters case-insensitively (Caps Lock)', () => {
    expect(matchShortcut(key('K', { ctrlKey: true }), modK, 'other')).toBe(true);
  });

  it('falls back to the physical key when Option changes the character on macOS', () => {
    const shortcut = parseShortcut('Mod+Alt+B');
    const event = key('∫', { metaKey: true, altKey: true, code: 'KeyB' });
    expect(matchShortcut(event, shortcut, 'mac')).toBe(true);
    expect(matchShortcut({ ...event, code: 'KeyN' }, shortcut, 'mac')).toBe(false);
  });

  it('ignores Shift for symbols typed with Shift', () => {
    const help = parseShortcut('?');
    expect(matchShortcut(key('?', { shiftKey: true }), help, 'other')).toBe(true);
    expect(matchShortcut(key('?'), help, 'other')).toBe(true);
    expect(matchShortcut(key('/', { shiftKey: true }), help, 'other')).toBe(false);
  });

  it('treats = and + (and - and _) as the same zoom key', () => {
    const zoomIn = parseShortcut('Mod+=');
    expect(matchShortcut(key('=', { ctrlKey: true }), zoomIn, 'other')).toBe(true);
    expect(matchShortcut(key('+', { ctrlKey: true, shiftKey: true }), zoomIn, 'other')).toBe(true);
    const zoomOut = parseShortcut('Mod+-');
    expect(matchShortcut(key('_', { ctrlKey: true, shiftKey: true }), zoomOut, 'other')).toBe(true);
  });

  it('keeps digits strict about Shift but accepts the physical digit', () => {
    const one = parseShortcut('1');
    expect(matchShortcut(key('1'), one, 'other')).toBe(true);
    expect(matchShortcut(key('!', { shiftKey: true, code: 'Digit1' }), one, 'other')).toBe(false);
    expect(matchShortcut(key('&', { code: 'Digit1' }), one, 'other')).toBe(false);
  });

  it('matches named keys', () => {
    expect(matchShortcut(key('Escape'), parseShortcut('Esc'), 'mac')).toBe(true);
    expect(matchShortcut(key('Delete'), parseShortcut('Del'), 'other')).toBe(true);
    expect(matchShortcut(key('Delete', { shiftKey: true }), parseShortcut('Del'), 'other')).toBe(
      false,
    );
  });
});

describe('formatting', () => {
  it('renders platform keycaps in platform order', () => {
    const shortcut = parseShortcut('Mod+Shift+Alt+K');
    expect(formatShortcut(shortcut, 'mac')).toEqual(['⌥', '⇧', '⌘', 'K']);
    expect(formatShortcut(shortcut, 'other')).toEqual(['Ctrl', 'Alt', 'Shift', 'K']);
    expect(formatShortcut(parseShortcut('?'), 'mac')).toEqual(['?']);
    expect(formatShortcut(parseShortcut('Escape'), 'other')).toEqual(['Esc']);
  });

  it('produces aria-keyshortcuts values', () => {
    expect(toAriaKeyShortcut(parseShortcut('Mod+K'), 'mac')).toBe('Meta+K');
    expect(toAriaKeyShortcut(parseShortcut('Mod+Alt+B'), 'other')).toBe('Control+Alt+B');
    expect(toAriaKeyShortcut(parseShortcut('Space'), 'other')).toBe('Space');
  });

  it('detects Apple platforms', () => {
    expect(detectPlatform({ platform: 'MacIntel' } as Navigator)).toBe('mac');
    expect(detectPlatform({ platform: 'Win32' } as Navigator)).toBe('other');
    expect(
      detectPlatform({
        platform: '',
        userAgentData: { platform: 'macOS' },
      } as unknown as Navigator),
    ).toBe('mac');
    expect(detectPlatform(undefined)).toBe('other');
  });
});
