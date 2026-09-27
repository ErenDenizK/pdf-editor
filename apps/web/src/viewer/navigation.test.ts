import { afterEach, describe, expect, it } from 'vitest';

import { hasCustomLabels, parseGoTo, recallPosition, rememberPosition } from './navigation';

// page-labels.pdf: i, ii, iii, 1, 2, 3, A-1, A-2
const LABELS = ['i', 'ii', 'iii', '1', '2', '3', 'A-1', 'A-2'];

describe('parseGoTo', () => {
  it('resolves labels first, as the document numbers its pages', () => {
    expect(parseGoTo('iii', LABELS)).toEqual({ kind: 'page', index: 2, via: 'label' });
    expect(parseGoTo('1', LABELS)).toEqual({ kind: 'page', index: 3, via: 'label' });
    expect(parseGoTo(' A-2 ', LABELS)).toEqual({ kind: 'page', index: 7, via: 'label' });
  });

  it('matches labels case-insensitively when there is no exact match', () => {
    expect(parseGoTo('II', LABELS)).toEqual({ kind: 'page', index: 1, via: 'label' });
    expect(parseGoTo('a-1', LABELS)).toEqual({ kind: 'page', index: 6, via: 'label' });
  });

  it('falls back to the physical page number, and # forces it', () => {
    expect(parseGoTo('8', LABELS)).toEqual({ kind: 'page', index: 7, via: 'number' });
    expect(parseGoTo('#1', LABELS)).toEqual({ kind: 'page', index: 0, via: 'number' });
    expect(parseGoTo('# 3', LABELS)).toEqual({ kind: 'page', index: 2, via: 'number' });
  });

  it('rejects what matches nothing', () => {
    expect(parseGoTo('', LABELS)).toEqual({ kind: 'empty' });
    expect(parseGoTo('   ', LABELS)).toEqual({ kind: 'empty' });
    expect(parseGoTo('9', LABELS)).toEqual({ kind: 'invalid' });
    expect(parseGoTo('0', LABELS)).toEqual({ kind: 'invalid' });
    expect(parseGoTo('iv', LABELS)).toEqual({ kind: 'invalid' });
    expect(parseGoTo('#x', LABELS)).toEqual({ kind: 'invalid' });
    expect(parseGoTo('2.5', ['1', '2', '3'])).toEqual({ kind: 'invalid' });
  });

  it('reads plain numbers in documents without labels', () => {
    const plain = ['1', '2', '3'];
    expect(parseGoTo('3', plain)).toEqual({ kind: 'page', index: 2, via: 'label' });
    expect(hasCustomLabels(plain)).toBe(false);
    expect(hasCustomLabels(LABELS)).toBe(true);
  });
});

describe('remembered position', () => {
  const KEY = 'pdf-editor:viewer:positions:v1';
  afterEach(() => localStorage.removeItem(KEY));

  it('stores the page per fingerprint and keeps the most recent 50', () => {
    rememberPosition('abc', 4, 1);
    expect(recallPosition('abc')).toBe(4);
    for (let i = 0; i < 60; i++) rememberPosition(`doc-${i}`, i, 10 + i);
    expect(recallPosition('abc')).toBeUndefined();
    expect(recallPosition('doc-59')).toBe(59);
  });

  it('survives garbage in storage', () => {
    localStorage.setItem(KEY, '{"x": {"page": -1, "at": 1}, "y": "nope"');
    expect(recallPosition('x')).toBeUndefined();
    localStorage.setItem(KEY, '{"x": {"page": -1, "at": 1}, "y": {"page": 2, "at": 3}}');
    expect(recallPosition('x')).toBeUndefined();
    expect(recallPosition('y')).toBe(2);
  });
});
