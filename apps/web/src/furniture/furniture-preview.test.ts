import type { DocumentId, OverlayOp, TextOverlay } from '@pdf-editor/document-model';
import { layoutOverlay } from '@pdf-editor/engine/overlay-geometry';
import { describe, expect, it } from 'vitest';

import { defaultPageNumbers, pageNumberOverlay } from './furniture-model';
import {
  batesFor,
  boxContains,
  boxTransform,
  layoutPage,
  overlaysForPage,
  roleAt,
} from './furniture-preview';

const measure = {
  textWidth: (t: string) => t.length * 6,
  imageSize: () => ({ width: 100, height: 50 }),
};
const page = { width: 600, height: 800 };
const input = { index: 0, count: 3, page, label: '1', title: 'Doc', date: new Date(2026, 0, 1) };

describe('preview math', () => {
  it('uses the shared layout: same boxes as the assembler would compute', () => {
    const overlay = pageNumberOverlay({
      ...defaultPageNumbers(3),
      template: 'Page {page} of {pages}',
    });
    const [laid] = layoutPage([overlay], input, measure);
    const direct = layoutOverlay(overlay, { index: 0, count: 3, page, text: input }, measure);
    expect(laid).toEqual(direct);
    expect(laid?.kind === 'text' && laid.text).toBe('Page 1 of 3');
  });

  it('flips display space to SVG and rotates counter-clockwise around the centre', () => {
    const box = { x: 100, y: 50, width: 40, height: 10, rotate: 0 };
    expect(boxTransform(box, 800)).toBe('translate(100 750)');
    expect(boxTransform({ ...box, rotate: 45 }, 800)).toBe(
      'rotate(-45 120 745) translate(100 750)',
    );
    expect(boxTransform(box, 800, true)).toBe('translate(100 750) skewX(-12)');
  });

  it('hit-tests rotated boxes', () => {
    const box = { x: 0, y: 0, width: 100, height: 10, rotate: 90 };
    // Turned upright around its centre (50, 5): spans x 45…55, y -45…55.
    expect(boxContains(box, { x: 50, y: 50 }, 0)).toBe(true);
    expect(boxContains(box, { x: 90, y: 5 }, 0)).toBe(false);
    const overlay = pageNumberOverlay(defaultPageNumbers(3));
    const laid = layoutPage([overlay], input, measure);
    const b = laid[0]?.boxes[0];
    expect(b && roleAt(laid, { x: b.x + 1, y: b.y + 1 })).toBe('page-number');
    expect(roleAt(laid, { x: 5, y: 790 })).toBeUndefined();
  });

  it('swaps in the dialog preview only on the previewed documents', () => {
    const committed: TextOverlay = { ...pageNumberOverlay(defaultPageNumbers(3)), template: 'old' };
    const draft: OverlayOp = { ...committed, template: 'new' };
    const a = 'a' as DocumentId;
    const b = 'b' as DocumentId;
    const preview = { kind: 'page-numbers' as const, documents: [a], overlays: [draft] };
    expect(overlaysForPage([committed], a, preview)).toEqual([draft]);
    expect(overlaysForPage([committed], b, preview)).toEqual([committed]);
    const bates = { prefix: 'Z', width: 2, start: 5, suffix: '' };
    expect(batesFor({ id: a }, { ...preview, bates: { [a]: bates } })).toBe(bates);
    expect(batesFor({ id: b, bates }, null)).toBe(bates);
  });
});
