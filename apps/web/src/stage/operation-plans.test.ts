import {
  addSource,
  createSequentialIdGenerator,
  createWorkspace,
  type PageId,
  type SourceInput,
} from '@pdf-editor/document-model';
import { describe, expect, it } from 'vitest';

import {
  defaultChunkSize,
  moveItem,
  outlineCuts,
  parsePageRanges,
  previewInterleave,
  previewSplit,
  selectionCuts,
  validateTitle,
} from './operation-plans';

describe('parsePageRanges', () => {
  it('converts 1-based ranges to 0-based inclusive pairs in typed order', () => {
    expect(parsePageRanges('1-3, 5, 8-10', 10)).toEqual({
      ok: true,
      ranges: [
        [0, 2],
        [4, 4],
        [7, 9],
      ],
    });
    expect(parsePageRanges(' 8-10 ;1', 10)).toEqual({
      ok: true,
      ranges: [
        [7, 9],
        [0, 0],
      ],
    });
  });

  it('accepts open ends, en dashes and stray separators', () => {
    expect(parsePageRanges('-2, 4 – 5, 9-', 10)).toEqual({
      ok: true,
      ranges: [
        [0, 1],
        [3, 4],
        [8, 9],
      ],
    });
    expect(parsePageRanges('3,,', 4)).toEqual({ ok: true, ranges: [[2, 2]] });
  });

  it('reports every problem with the token that caused it', () => {
    const result = parsePageRanges('a, 0, 5-3, 12, 1-4, 3-6, 2-x', 10);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      { kind: 'syntax', token: 'a' },
      { kind: 'zero', token: '0' },
      { kind: 'reversed', token: '5-3' },
      { kind: 'out-of-bounds', token: '12', pageCount: 10 },
      { kind: 'syntax', token: '2-x' },
      { kind: 'overlap', first: '1-4', second: '3-6' },
    ]);
  });

  it('asks for input when nothing was typed', () => {
    expect(parsePageRanges(' , ', 5)).toEqual({ ok: false, problems: [{ kind: 'empty' }] });
    expect(parsePageRanges('-', 5)).toEqual({
      ok: false,
      problems: [{ kind: 'syntax', token: '-' }],
    });
  });
});

describe('previewSplit', () => {
  it('chunks every n pages', () => {
    expect(previewSplit(10, { mode: 'every', n: 4 })).toEqual({
      ok: true,
      parts: [4, 4, 2],
      remaining: 0,
    });
    expect(previewSplit(3, { mode: 'every', n: 1 })).toEqual({
      ok: true,
      parts: [1, 1, 1],
      remaining: 0,
    });
  });

  it('refuses a single part and invalid sizes', () => {
    expect(previewSplit(4, { mode: 'every', n: 4 })).toEqual({ ok: false, reason: 'single-part' });
    expect(previewSplit(4, { mode: 'every', n: 0 })).toEqual({ ok: false, reason: 'invalid' });
    expect(previewSplit(4, { mode: 'every', n: 1.5 })).toEqual({ ok: false, reason: 'invalid' });
    expect(previewSplit(0, { mode: 'every', n: 1 })).toEqual({
      ok: false,
      reason: 'empty-document',
    });
  });

  it('counts range parts and the pages that stay behind', () => {
    const parsed = parsePageRanges('1-3, 5, 8-10', 12);
    if (!parsed.ok) throw new Error('expected valid ranges');
    expect(previewSplit(12, { mode: 'ranges', ranges: parsed.ranges })).toEqual({
      ok: true,
      parts: [3, 1, 3],
      remaining: 5,
    });
    expect(previewSplit(5, { mode: 'ranges', ranges: [[0, 5]] })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('splits at cut points, ignoring the first page, duplicates and out-of-range cuts', () => {
    expect(previewSplit(10, { mode: 'cuts', cuts: [6, 0, 3, 3, 12] })).toEqual({
      ok: true,
      parts: [3, 3, 4],
      remaining: 0,
    });
    expect(previewSplit(10, { mode: 'cuts', cuts: [0] })).toEqual({
      ok: false,
      reason: 'single-part',
    });
  });

  it('defaults to two parts', () => {
    expect(defaultChunkSize(10)).toBe(5);
    expect(defaultChunkSize(7)).toBe(4);
    expect(defaultChunkSize(1)).toBe(1);
  });
});

describe('outline and selection cuts', () => {
  const input: SourceInput = {
    name: 'book.pdf',
    byteLength: 1,
    pageCount: 6,
    pages: Array.from({ length: 6 }, () => ({
      size: { width: 100, height: 100 },
      rotation: 0 as const,
    })),
    fingerprint: 'f',
    flags: {
      encrypted: false,
      repaired: false,
      hasAcroForm: false,
      hasXfa: false,
      hasSignatures: false,
      tagged: false,
      linearized: false,
    },
    metadata: { policy: 'inherit-first-source' },
    outline: [
      {
        title: 'Intro',
        destination: { kind: 'page', pageIndex: 0 },
        open: true,
        children: [
          {
            title: 'Nested',
            destination: { kind: 'page', pageIndex: 1 },
            open: true,
            children: [],
          },
        ],
      },
      { title: 'Part 2', destination: { kind: 'page', pageIndex: 2 }, open: true, children: [] },
      {
        title: 'Link',
        destination: { kind: 'uri', uri: 'https://example.org' },
        open: true,
        children: [],
      },
      { title: 'Part 3', destination: { kind: 'page', pageIndex: 4 }, open: true, children: [] },
    ],
  };
  const { workspace, documentId } = addSource(
    createWorkspace(),
    input,
    createSequentialIdGenerator('t'),
  );
  const doc = workspace.documents[documentId];
  if (doc === undefined) throw new Error('document missing');

  it('cuts at top-level bookmarks and names the parts after them', () => {
    expect(outlineCuts(doc)).toEqual({
      cuts: [2, 4],
      titles: ['Intro', 'Part 2', 'Part 3'],
      bookmarks: 3,
    });
    expect(previewSplit(6, { mode: 'cuts', cuts: outlineCuts(doc).cuts })).toMatchObject({
      parts: [2, 2, 2],
    });
  });

  it('cuts before each selected page except the first', () => {
    const ids = doc.pages.map((p) => p.id);
    const selected = new Set<PageId>([ids[0], ids[3], ids[5]].filter((id) => id !== undefined));
    expect(selectionCuts(doc, selected)).toEqual([3, 5]);
  });
});

describe('previewInterleave', () => {
  it('alternates pages and appends leftovers', () => {
    expect(previewInterleave(2, 4, 'alternate')).toEqual([
      { from: 'a', page: 1 },
      { from: 'b', page: 1 },
      { from: 'a', page: 2 },
      { from: 'b', page: 2 },
      { from: 'b', page: 3 },
      { from: 'b', page: 4 },
    ]);
  });

  it('reverses the second document in duplex mode and stops at the limit', () => {
    expect(previewInterleave(3, 3, 'duplex-reverse-b', 5)).toEqual([
      { from: 'a', page: 1 },
      { from: 'b', page: 3 },
      { from: 'a', page: 2 },
      { from: 'b', page: 2 },
      { from: 'a', page: 3 },
    ]);
  });
});

describe('validateTitle', () => {
  it('trims and rejects empty, overlong and control-character titles', () => {
    expect(validateTitle('  Report  ')).toEqual({ ok: true, title: 'Report' });
    expect(validateTitle('   ')).toEqual({ ok: false, problem: 'empty' });
    expect(validateTitle('x'.repeat(201))).toEqual({ ok: false, problem: 'too-long' });
    expect(validateTitle('a\tb')).toEqual({ ok: false, problem: 'control' });
  });
});

describe('moveItem', () => {
  it('moves one step and ignores moves past the ends', () => {
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});
