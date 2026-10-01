/**
 * Keeps keyboard focus when a surface that holds it goes away (DESIGN.md §5): the
 * contextual bar after Esc or Delete, the options tier after Esc disarms its tool. Without
 * this, focus falls to `<body>` and the next Tab starts over from the top of the page.
 *
 * Call it in the component that mounts and unmounts with the surface: its layout cleanup
 * runs while the surface is still in the document, so it can tell that focus was inside.
 */
import { type RefObject, useLayoutEffect } from 'react';

/**
 * `target` (a stable, module-level function) is called when the surface leaves: where focus
 * goes (e.g. the page viewport).
 */
export function useFocusRescue(
  ref: RefObject<HTMLElement | null>,
  target: (surface: HTMLElement) => HTMLElement | null | undefined,
): void {
  useLayoutEffect(() => {
    const surface = ref.current;
    if (!surface) return;
    return () => {
      if (!surface.contains(document.activeElement)) return;
      const next = target(surface);
      if (!next) return;
      // After the surface has left the document.
      queueMicrotask(() => {
        const active = document.activeElement;
        if ((active === null || active === document.body) && next.isConnected) {
          next.focus({ preventScroll: true });
        }
      });
    };
  }, [ref, target]);
}
