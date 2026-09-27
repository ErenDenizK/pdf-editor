/**
 * Annotation fixtures shared by the engine tests: one annotation of every kind the spec
 * lists (viewer-annotations.md §3). tools/qa/make-annotation-sample.ts builds its own,
 * labelled layout of the same kinds.
 */

import type { NewAnnotation } from '../src/types';

/** A 1×1 red PNG. */
export function pngBlob(): Blob {
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  return new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' });
}

export const quad = { x: 72, y: 700, width: 200, height: 14 };
export const quad2 = { x: 72, y: 684, width: 120, height: 14 };

/** One of each kind, as the UI would create them. */
export function oneOfEach(pageIndex: number): NewAnnotation[] {
  return [
    {
      kind: 'highlight',
      pageIndex,
      rect: quad,
      quads: [quad, quad2],
      color: '#FFEB3B',
      contents: 'Check this',
    },
    { kind: 'underline', pageIndex, rect: quad, quads: [{ ...quad, y: 660 }], color: '#1E88E5' },
    { kind: 'strikeout', pageIndex, rect: quad, quads: [{ ...quad, y: 640 }], color: '#E53935' },
    { kind: 'squiggly', pageIndex, rect: quad, quads: [{ ...quad, y: 620 }], color: '#43A047' },
    {
      kind: 'ink',
      pageIndex,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      paths: [
        [
          { x: 80, y: 500 },
          { x: 120, y: 560 },
          { x: 160, y: 510 },
        ],
        [
          { x: 90, y: 480 },
          { x: 170, y: 480 },
        ],
      ],
      strokeWidth: 2,
      color: '#1E88E5',
    },
    {
      kind: 'square',
      pageIndex,
      rect: { x: 220, y: 480, width: 80, height: 60 },
      strokeWidth: 2,
      color: '#E53935',
      interiorColor: '#FFF59D',
    },
    {
      kind: 'circle',
      pageIndex,
      rect: { x: 320, y: 480, width: 80, height: 60 },
      strokeWidth: 1.5,
      color: '#43A047',
    },
    {
      kind: 'line',
      pageIndex,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      strokeWidth: 2,
      vertices: [
        { x: 420, y: 480 },
        { x: 520, y: 540 },
      ],
      lineEndings: { end: 'open-arrow' },
      color: '#000000',
    },
    {
      kind: 'polygon',
      pageIndex,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      strokeWidth: 1,
      vertices: [
        { x: 80, y: 380 },
        { x: 160, y: 380 },
        { x: 120, y: 440 },
      ],
      color: '#6A1B9A',
      interiorColor: '#E1BEE7',
    },
    {
      kind: 'polyline',
      pageIndex,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      strokeWidth: 1,
      vertices: [
        { x: 200, y: 380 },
        { x: 240, y: 440 },
        { x: 280, y: 380 },
        { x: 320, y: 440 },
      ],
      color: '#00897B',
    },
    {
      kind: 'free-text',
      pageIndex,
      rect: { x: 340, y: 380, width: 180, height: 40 },
      text: 'Typed text, café',
      fontSize: 14,
      textColor: '#C62828',
    },
    {
      kind: 'text',
      pageIndex,
      rect: { x: 540, y: 700, width: 20, height: 20 },
      contents: 'A note with a popup',
      icon: 'Comment',
      open: true,
      color: '#FFEB3B',
    },
    { kind: 'stamp', pageIndex, rect: { x: 80, y: 250, width: 150, height: 50 }, name: 'Approved' },
    {
      kind: 'stamp',
      pageIndex,
      rect: { x: 260, y: 250, width: 50, height: 50 },
      imageBlob: pngBlob(),
      opacity: 0.6,
    },
    {
      kind: 'link',
      pageIndex,
      rect: { x: 340, y: 250, width: 120, height: 20 },
      uri: 'https://example.org/',
    },
  ];
}
