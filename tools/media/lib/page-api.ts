/**
 * What the harness injects into the page (cursor, drag ghost, OS file drag), as one typed
 * object on `window`. Injected functions run in the page and are serialised, so they cannot
 * close over Node values; they reach each other through this object and through the
 * `media:pointer` event the cursor dispatches on every move.
 */
export interface MediaPageApi {
  /** Moves the drawn pointer (and anything following it) to viewport coordinates. */
  pointer(x: number, y: number): void;
  /** Shows the pointer pressed (mouse down) or released. */
  press(down: boolean): void;
}

export type MediaWindow = Window & { __media?: MediaPageApi };

/** Detail of the `media:pointer` event: the pointer's viewport coordinates. */
export interface PointerDetail {
  readonly x: number;
  readonly y: number;
}

export const POINTER_EVENT = 'media:pointer';
