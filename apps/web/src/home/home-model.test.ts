/**
 * Home's pure rules (experience-redesign §3, §11): combine scope and order, card drop order,
 * click and keyboard selection, grid steps, size formatting and middle truncation.
 */
import type { DocumentId } from '@pdf-editor/document-model';
import { describe, expect, it } from 'vitest';

import {
  clickSelection,
  combineScope,
  dropOrder,
  formatFileSize,
  gridStep,
  liveSelection,
  middleTruncate,
  rangeBetween,
  relativeTime,
  toggleSelection,
  visibleRecents,
} from './home-model';

const [a, b, c, d] = ['a', 'b', 'c', 'd'] as DocumentId[] as [
  DocumentId,
  DocumentId,
  DocumentId,
  DocumentId,
];
const order = [a, b, c, d];

describe('combine scope', () => {
  it('combines the selection in the order it was made', () => {
    expect(combineScope(order, [c, a])).toEqual({ ids: [c, a], all: false });
  });

  it('combines every open document in tab order when nothing is selected', () => {
    expect(combineScope(order, [])).toEqual({ ids: order, all: true });
  });

  it('has nothing to combine with one card selected or one document open', () => {
    expect(combineScope(order, [b])).toBeNull();
    expect(combineScope([a], [])).toBeNull();
  });

  it('ignores closed documents in the selection', () => {
    expect(liveSelection([a, b], [d, b, a])).toEqual([b, a]);
    expect(combineScope([a, b], [d, b])).toBeNull();
  });
});

describe('card drop order', () => {
  it('puts the target first and the dragged card after it', () => {
    expect(dropOrder(b, d)).toEqual([b, d]);
    expect(dropOrder(d, b)).toEqual([d, b]);
  });

  it('is one card when a card is dropped on itself', () => {
    expect(dropOrder(a, a)).toEqual([a]);
  });
});

describe('selection', () => {
  const none = { selection: [], anchor: null };

  it('selects only the clicked card', () => {
    expect(clickSelection(order, { selection: [a, b], anchor: a }, c, plain)).toEqual({
      selection: [c],
      anchor: c,
    });
  });

  it('toggles with Mod and keeps the selection order', () => {
    const one = clickSelection(order, none, c, mod);
    const two = clickSelection(order, one, a, mod);
    expect(two).toEqual({ selection: [c, a], anchor: a });
    expect(clickSelection(order, two, c, mod)).toEqual({ selection: [a], anchor: c });
  });

  it('selects a range from the anchor with Shift, in either direction', () => {
    expect(clickSelection(order, { selection: [b], anchor: b }, d, shift)).toEqual({
      selection: [b, c, d],
      anchor: b,
    });
    expect(clickSelection(order, { selection: [d], anchor: d }, b, shift).selection).toEqual([
      d,
      c,
      b,
    ]);
  });

  it('adds the range to the selection with Shift+Mod', () => {
    expect(
      clickSelection(order, { selection: [a, c], anchor: c }, d, { shift: true, mod: true }),
    ).toEqual({ selection: [a, c, d], anchor: c });
  });

  it('treats Shift without an anchor as a plain click', () => {
    expect(clickSelection(order, none, b, shift)).toEqual({ selection: [b], anchor: b });
  });

  it('toggles one card (Space)', () => {
    expect(toggleSelection(order, { selection: [a], anchor: a }, b)).toEqual({
      selection: [a, b],
      anchor: b,
    });
    expect(toggleSelection(order, { selection: [a, b], anchor: b }, a)).toEqual({
      selection: [b],
      anchor: a,
    });
  });

  it('lists the cards between two cards', () => {
    expect(rangeBetween(order, a, c)).toEqual([a, b, c]);
    expect(rangeBetween(order, c, a)).toEqual([c, b, a]);
    expect(rangeBetween(order, 'gone' as DocumentId, b)).toEqual([b]);
  });
});

describe('grid steps', () => {
  it('moves by one sideways and by a row up and down, clamped', () => {
    expect(gridStep(1, 'ArrowRight', 7, 3)).toBe(2);
    expect(gridStep(0, 'ArrowLeft', 7, 3)).toBe(0);
    expect(gridStep(1, 'ArrowDown', 7, 3)).toBe(4);
    expect(gridStep(5, 'ArrowDown', 7, 3)).toBe(6);
    expect(gridStep(4, 'ArrowUp', 7, 3)).toBe(1);
    expect(gridStep(1, 'ArrowUp', 7, 3)).toBe(0);
    expect(gridStep(3, 'Home', 7, 3)).toBe(0);
    expect(gridStep(3, 'End', 7, 3)).toBe(6);
  });

  it('ignores other keys and empty grids', () => {
    expect(gridStep(0, 'Enter', 3, 3)).toBeNull();
    expect(gridStep(0, 'ArrowRight', 0, 3)).toBeNull();
  });
});

describe('file size', () => {
  it('reads like the export dialog, in the UI language', () => {
    expect(formatFileSize(812, 'en')).toBe('812 B');
    expect(formatFileSize(48 * 1024, 'en')).toBe('48.0 KB');
    expect(formatFileSize(2.8 * 1024 * 1024, 'en')).toBe('2.8 MB');
    expect(formatFileSize(2.8 * 1024 * 1024, 'tr')).toBe('2,8 MB');
    expect(formatFileSize(150 * 1024 * 1024, 'en')).toBe('150 MB');
    expect(formatFileSize(3 * 1024 ** 3, 'en')).toBe('3.0 GB');
  });

  it('shows nothing for a size it cannot read', () => {
    expect(formatFileSize(Number.NaN, 'en')).toBe('');
    expect(formatFileSize(-1, 'en')).toBe('');
  });
});

describe('middle truncation', () => {
  it('keeps both ends of a long name', () => {
    expect(middleTruncate('Quarterly report final version 2026-09.pdf', 22)).toBe(
      'Quarterly …2026-09.pdf',
    );
    expect(
      Array.from(middleTruncate('Quarterly report final version 2026-09.pdf', 20)),
    ).toHaveLength(20);
  });

  it('leaves short names alone', () => {
    expect(middleTruncate('report.pdf', 20)).toBe('report.pdf');
  });
});

const plain = { shift: false, mod: false };
const mod = { shift: false, mod: true };
const shift = { shift: true, mod: false };

describe('Recents', () => {
  const now = Date.UTC(2026, 9, 3, 12);
  const ago = (seconds: number) => now - seconds * 1000;

  it('says how long ago a file was opened, in the active language', () => {
    expect(relativeTime(ago(10), now, 'en')).toBe('now');
    expect(relativeTime(ago(50), now, 'en')).toBe('1 minute ago');
    expect(relativeTime(ago(5 * 60), now, 'en')).toBe('5 minutes ago');
    expect(relativeTime(ago(3 * 3600 + 100), now, 'en')).toBe('3 hours ago');
    expect(relativeTime(ago(30 * 3600), now, 'en')).toBe('yesterday');
    expect(relativeTime(ago(3 * 86_400), now, 'en')).toBe('3 days ago');
    expect(relativeTime(ago(10 * 86_400), now, 'en')).toBe('last week');
    expect(relativeTime(ago(65 * 86_400), now, 'en')).toBe('2 months ago');
    expect(relativeTime(ago(800 * 86_400), now, 'en')).toBe('2 years ago');
    // A clock set back reads "now", never "in 5 minutes".
    expect(relativeTime(now + 300_000, now, 'en')).toBe('now');
    expect(relativeTime(ago(10), now, 'tr')).toBe('şimdi');
    expect(relativeTime(ago(30 * 3600), now, 'tr')).toBe('dün');
    expect(relativeTime(ago(5 * 60), now, 'tr')).toBe('5 dakika önce');
  });

  it('leaves out the files open right now, by name and size', () => {
    const entries = [
      { id: '1', name: 'a.pdf', size: 10 },
      { id: '2', name: 'b.pdf', size: 20 },
      { id: '3', name: 'a.pdf', size: 11 },
    ];
    expect(visibleRecents(entries, [{ name: 'a.pdf', size: 10 }]).map((e) => e.id)).toEqual([
      '2',
      '3',
    ]);
    expect(visibleRecents(entries, [])).toEqual(entries);
  });
});
