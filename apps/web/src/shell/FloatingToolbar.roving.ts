/**
 * Roving tabindex for the tool bar and its options tier (DESIGN.md §5, experience-redesign
 * spec §10): one Tab stop per toolbar; Left/Right move between its controls and Home/End go
 * to the ends. It works on the DOM, so controls a plug-in renders (the pen presets) take
 * part without wiring.
 *
 * In the options tier a slider or a select keeps Up/Down (and Home/End) for its value, as
 * in the APG toolbar pattern; Left/Right still move between controls. Keys a control has
 * claimed (`preventDefault`) are left alone.
 */
import {
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
} from 'react';

const ITEMS = 'button:not([disabled]), input:not([disabled]), select:not([disabled])';

function isValueControl(element: Element | null): boolean {
  return (
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLInputElement && element.type === 'range')
  );
}

function itemsOf(container: HTMLElement | null): HTMLElement[] {
  return Array.from(container?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
}

/**
 * Gives the Tab stop to the focused control, else the remembered one, else the first that
 * matches `preferred`, else the first; returns the chosen control.
 */
function applyRoving(
  container: HTMLElement | null,
  remembered: HTMLElement | null,
  preferred: string,
): HTMLElement | null {
  const list = itemsOf(container);
  if (list.length === 0) return remembered;
  const active = document.activeElement;
  const chosen =
    list.find((el) => el === active) ??
    (remembered && list.includes(remembered) ? remembered : undefined) ??
    (preferred === '' ? undefined : list.find((el) => el.matches(preferred))) ??
    list[0];
  for (const el of list) {
    const tabIndex = el === chosen ? 0 : -1;
    if (el.tabIndex !== tabIndex) el.tabIndex = tabIndex;
  }
  return chosen ?? null;
}

/**
 * @param preferred selector of the control that takes the Tab stop when the remembered one
 *   is gone (the armed tool, the group chip).
 */
export function useRovingTabindex(ref: RefObject<HTMLElement | null>, preferred = '') {
  const current = useRef<HTMLElement | null>(null);

  // After every render, and whenever controls come and go inside (plug-ins, menus).
  useLayoutEffect(() => {
    current.current = applyRoving(ref.current, current.current, preferred);
  });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new MutationObserver(() => {
      current.current = applyRoving(element, current.current, preferred);
    });
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [ref, preferred]);

  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.matches(ITEMS)) {
      current.current = applyRoving(ref.current, target, preferred);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const list = itemsOf(ref.current);
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    const valueControl = isValueControl(list[index] ?? null);
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % list.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + list.length) % list.length;
    else if (event.key === 'Home' && !valueControl) next = 0;
    else if (event.key === 'End' && !valueControl) next = list.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = list[next];
    if (!target) return;
    target.focus();
    current.current = applyRoving(ref.current, target, preferred);
  };

  return { onFocus, onKeyDown };
}
