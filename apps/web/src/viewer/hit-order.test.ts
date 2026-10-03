/**
 * The one hit order and the Edit policy's pointer rules (craft spec §3.5, §10): the order
 * itself, which targets are live per tool, the winner among stacked targets whatever their
 * stacking, and the pointer roles (double-click entry, idle hover, pen eraser and barrel).
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  createPointerLog,
  HIT_ORDER,
  type HitKind,
  hitAt,
  hitKindOf,
  hoverAllowed,
  isLive,
  liveHitKinds,
  opensTextOnDoubleClick,
  penButtonOf,
  topHit,
  watchPointers,
} from './hit-order';
import type { ToolMode } from './tool-store';

/** One element per kind, marked as the layers mark their targets. */
function target(kind: HitKind | 'paper'): HTMLElement {
  const element = document.createElement(kind === 'text-run' ? 'button' : 'div');
  switch (kind) {
    case 'annotation':
      element.setAttribute('data-annotation-id', 'a1');
      break;
    case 'form-widget':
      element.setAttribute('data-field-name', 'name');
      break;
    case 'image':
      element.setAttribute('data-image-object', '');
      break;
    case 'text-run':
      element.setAttribute('data-text-run', 'Hello');
      break;
    case 'text-selection': {
      const layer = document.createElement('div');
      layer.setAttribute('data-text-layer', '0');
      const span = document.createElement('span');
      layer.appendChild(span);
      document.body.appendChild(layer);
      return span;
    }
    default:
      break;
  }
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('the hit order', () => {
  it('is annotation, form widget, image, text run, text selection', () => {
    expect(HIT_ORDER).toEqual(['annotation', 'form-widget', 'image', 'text-run', 'text-selection']);
  });

  it('knows each kind by its marks, and nothing else', () => {
    for (const kind of HIT_ORDER) expect(hitKindOf(target(kind))).toBe(kind);
    expect(hitKindOf(target('paper'))).toBeUndefined();
    expect(hitKindOf(null)).toBeUndefined();
    // A child of a target belongs to it (the rects of a markup's <g>).
    const annotation = target('annotation');
    const child = document.createElement('span');
    annotation.appendChild(child);
    expect(hitKindOf(child)).toBe('annotation');
  });

  it('picks the earliest kind among stacked targets, whatever their stacking', () => {
    const text = target('text-selection');
    const image = target('image');
    const widget = target('form-widget');
    const annotation = target('annotation');
    const paper = target('paper');
    // Top-most first, as elementsFromPoint lists them.
    expect(topHit([paper, text, image, widget, annotation])).toEqual({
      kind: 'annotation',
      element: annotation,
    });
    expect(topHit([text, image, widget])?.kind).toBe('form-widget');
    expect(topHit([text, image])?.kind).toBe('image');
    expect(topHit([text, target('text-run')])?.kind).toBe('text-run');
    expect(topHit([paper, text])?.kind).toBe('text-selection');
    expect(topHit([paper])).toBeUndefined();
    // Within a kind, the top-most element.
    const upper = target('annotation');
    expect(topHit([upper, annotation])?.element).toBe(upper);
  });

  it('resolves a point through elementsFromPoint (live targets only)', () => {
    const style = 'position: fixed; left: 10px; top: 10px; width: 50px; height: 20px;';
    const text = target('text-selection');
    text.parentElement?.setAttribute('style', style);
    text.setAttribute('style', 'display: block; width: 50px; height: 20px;');
    expect(hitAt(20, 15)?.kind).toBe('text-selection');
    const annotation = target('annotation');
    annotation.setAttribute('style', `${style} z-index: -1;`);
    // Below the text in the stacking, first in the order.
    expect(hitAt(20, 15)?.kind).toBe('annotation');
    // A root that lets the pointer through is not a target.
    annotation.style.pointerEvents = 'none';
    expect(hitAt(20, 15)?.kind).toBe('text-selection');
  });
});

describe('live targets per tool (craft spec §3.5)', () => {
  const kinds = (mode: ToolMode, editable = true) => [...liveHitKinds(mode, editable)].sort();

  it('Read: text selection only, whatever the tool', () => {
    expect(kinds('select', false)).toEqual(['text-selection']);
    expect(kinds('edit-text', false)).toEqual(['text-selection']);
    expect(kinds('ink', false)).toEqual(['text-selection']);
  });

  it('Select: annotations, form widgets and text selection', () => {
    expect(kinds('select')).toEqual(['annotation', 'form-widget', 'text-selection']);
  });

  it('Edit text takes text runs only; Image images only', () => {
    expect(kinds('edit-text')).toEqual(['text-run']);
    expect(isLive('annotation', 'edit-text', true)).toBe(false);
    expect(kinds('image')).toEqual(['image']);
    expect(isLive('annotation', 'image', true)).toBe(false);
  });

  it('a drawing tool captures the page itself: no target is live', () => {
    for (const mode of ['ink', 'eraser', 'lasso', 'highlight', 'rectangle', 'text-box'] as const) {
      expect(kinds(mode)).toEqual([]);
      expect(isLive('text-run', mode, true)).toBe(false);
    }
  });
});

describe('pointer roles', () => {
  it('a double-click opens the text editor from a mouse or a pen as a pointer, never touch', () => {
    expect(opensTextOnDoubleClick('mouse', false)).toBe(true);
    expect(opensTextOnDoubleClick('mouse', true)).toBe(true);
    expect(opensTextOnDoubleClick('pen', false)).toBe(true);
    expect(opensTextOnDoubleClick('pen', true)).toBe(false);
    expect(opensTextOnDoubleClick('touch', false)).toBe(false);
    expect(opensTextOnDoubleClick('touch', true)).toBe(false);
    // Unknown (synthetic) presses count as a mouse.
    expect(opensTextOnDoubleClick('', true)).toBe(true);
  });

  it('the idle hover: mouse or hovering pen, no button, not within 300 ms of a pen stroke', () => {
    const now = 10_000;
    const never = Number.NEGATIVE_INFINITY;
    expect(hoverAllowed({ pointerType: 'mouse', buttons: 0 }, now, never)).toBe(true);
    expect(hoverAllowed({ pointerType: 'pen', buttons: 0 }, now, never)).toBe(true);
    expect(hoverAllowed({ pointerType: 'touch', buttons: 0 }, now, never)).toBe(false);
    expect(hoverAllowed({ pointerType: 'mouse', buttons: 1 }, now, never)).toBe(false);
    expect(hoverAllowed({ pointerType: 'pen', buttons: 0 }, now, now - 299)).toBe(false);
    expect(hoverAllowed({ pointerType: 'mouse', buttons: 0 }, now, now - 100)).toBe(false);
    expect(hoverAllowed({ pointerType: 'mouse', buttons: 0 }, now, now - 300)).toBe(true);
  });

  it("the pen's eraser end and barrel button", () => {
    expect(penButtonOf({ pointerType: 'pen', button: 0, buttons: 1 })).toBe('tip');
    expect(penButtonOf({ pointerType: 'pen', button: 5, buttons: 32 })).toBe('eraser');
    expect(penButtonOf({ pointerType: 'pen', button: -1, buttons: 32 })).toBe('eraser');
    expect(penButtonOf({ pointerType: 'pen', button: 2, buttons: 2 })).toBe('barrel');
    expect(penButtonOf({ pointerType: 'pen', button: 0, buttons: 3 })).toBe('barrel');
    expect(penButtonOf({ pointerType: 'mouse', button: 2, buttons: 2 })).toBeUndefined();
    expect(penButtonOf({ pointerType: 'touch', button: 0, buttons: 1 })).toBeUndefined();
  });

  it('the pointer log follows presses and pen lifts in the capture phase', () => {
    const log = createPointerLog();
    const host = new EventTarget() as unknown as Window;
    let pens = 0;
    let clock = 500;
    const dispose = watchPointers(
      host,
      log,
      () => {
        pens += 1;
      },
      () => clock,
    );
    host.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse' }));
    expect(log.lastDownType).toBe('mouse');
    expect(pens).toBe(0);
    host.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'pen' }));
    expect(pens).toBe(1);
    host.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'pen' }));
    expect(log.lastDownType).toBe('pen');
    clock = 800;
    host.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'pen' }));
    expect(log.lastPenUpAt).toBe(800);
    host.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse' }));
    expect(log.lastPenUpAt).toBe(800);
    dispose();
    host.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch' }));
    expect(log.lastDownType).toBe('pen');
  });
});
