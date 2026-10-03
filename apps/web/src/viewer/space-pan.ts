/**
 * Holding Space pans the page view (craft spec §3.5, ADR-0019 §5), in Read and in Edit and
 * with any tool armed: while Space is down the page shows the grab cursor, and a press
 * anywhere on the pages drags the view (grabbing) instead of reaching a tool, a field or
 * the text. Space tapped without a drag still moves one screen down, on release
 * (`nav.screenDown`); key repeats while held are swallowed.
 *
 * Only while the pages own the keyboard (`ReadController.ownsFocus`): a focused button,
 * field or menu keeps its own Space. The keydown is claimed in the capture phase with
 * `preventDefault()`, which the global shortcuts skip.
 */
import { commandRegistry } from '../commands/registry';
import { isEditableTarget } from '../commands/use-shortcuts';
import { readController } from './read-controller';

/** On the viewport while Space is held: the grab cursor. */
export const SPACE_PAN_ATTR = 'data-space-pan';
/** On the viewport while a Space drag is in progress: the grabbing cursor. */
export const SPACE_PANNING_ATTR = 'data-space-panning';

function viewportOf(root: Document): HTMLElement | null {
  return root.querySelector<HTMLElement>('[data-read-viewport]');
}

function plainSpace(event: KeyboardEvent): boolean {
  return event.key === ' ' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

/** Installs the Space pan on `win`; returns the disposer. */
export function installSpacePan(win: Window = window): () => void {
  const root = win.document;
  let held: HTMLElement | null = null;
  let panned = false;
  let drag: {
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    readonly left: number;
    readonly top: number;
  } | null = null;

  const endDrag = () => {
    drag = null;
    held?.removeAttribute(SPACE_PANNING_ATTR);
    win.removeEventListener('pointermove', onMove, true);
    win.removeEventListener('pointerup', onUp, true);
    win.removeEventListener('pointercancel', onUp, true);
  };

  const release = () => {
    endDrag();
    held?.removeAttribute(SPACE_PAN_ATTR);
    held = null;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!plainSpace(event) || event.defaultPrevented || event.isComposing) return;
    if (held) {
      // Repeats while held: no screen steps, no native scroll.
      event.preventDefault();
      return;
    }
    if (isEditableTarget(event.target)) return;
    if (event.target instanceof Element && event.target.closest('[aria-modal="true"]')) return;
    const viewport = viewportOf(root);
    if (!viewport || !readController()?.ownsFocus()) return;
    event.preventDefault();
    held = viewport;
    panned = false;
    viewport.setAttribute(SPACE_PAN_ATTR, '');
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key !== ' ' || !held) return;
    event.preventDefault();
    const tapped = !panned && drag === null;
    release();
    if (tapped) void commandRegistry.execute('nav.screenDown');
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!held || drag || !(event.target instanceof Node) || !held.contains(event.target)) return;
    // The press is the pan's: no tool, field or text sees it.
    event.preventDefault();
    event.stopPropagation();
    panned = true;
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: held.scrollLeft,
      top: held.scrollTop,
    };
    held.setAttribute(SPACE_PANNING_ATTR, '');
    win.addEventListener('pointermove', onMove, true);
    win.addEventListener('pointerup', onUp, true);
    win.addEventListener('pointercancel', onUp, true);
  };

  const onMove = (event: PointerEvent) => {
    if (!drag || !held || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    held.scrollLeft = drag.left - (event.clientX - drag.x);
    held.scrollTop = drag.top - (event.clientY - drag.y);
  };

  const onUp = (event: PointerEvent) => {
    if (drag?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    endDrag();
  };

  // Space released elsewhere (another window took the focus): stop holding.
  const onBlur = () => release();

  win.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('keyup', onKeyUp, true);
  win.addEventListener('pointerdown', onPointerDown, true);
  win.addEventListener('blur', onBlur);
  return () => {
    release();
    win.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('keyup', onKeyUp, true);
    win.removeEventListener('pointerdown', onPointerDown, true);
    win.removeEventListener('blur', onBlur);
  };
}
