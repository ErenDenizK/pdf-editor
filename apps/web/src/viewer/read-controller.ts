/**
 * Imperative handle on the mounted Read view, for commands that act on the viewport
 * (PageUp / PageDown / Space). Null while Read mode is not shown.
 */
export interface ReadController {
  /** Scrolls about one screen down (+1) or up (-1); in single-page layout, turns pages at the ends. */
  scrollByScreen(direction: 1 | -1): void;
  /** Whether keyboard focus is in or around the pages (not in a panel or control). */
  ownsFocus(): boolean;
}

let current: ReadController | null = null;

export function setReadController(controller: ReadController | null): void {
  current = controller;
}

export function readController(): ReadController | null {
  return current;
}
