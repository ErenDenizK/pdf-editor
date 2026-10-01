/**
 * F6 / Shift+F6 move focus between the app's regions (experience-redesign §10): title bar,
 * navigator, stage, tool bar and, when open, the inspector. Focus lands on the region's
 * current item (the selected tab, the page viewport, the armed tool) or its first control.
 * Not while a dialog or menu has focus: those keep their own keyboard.
 */
import { useEffect } from 'react';

/** Region selectors in F6 order, within the app shell. */
const REGIONS = [
  ':scope > header',
  ':scope > [data-region="navigator"]',
  ':scope > main',
  ':scope > main [role="toolbar"]',
  ':scope > #right-panel',
] as const;

/** Where focus lands in a region, best first. */
const TARGETS = [
  '[role="tab"][tabindex="0"]',
  '[data-read-viewport]',
  '[aria-pressed="true"][tabindex="0"]',
  '[tabindex="0"]',
  'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
] as const;

function regionsOf(shell: Element): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const selector of REGIONS) {
    const el = shell.querySelector<HTMLElement>(selector);
    if (el && !found.includes(el) && el.getClientRects().length > 0) found.push(el);
  }
  return found;
}

function focusRegion(region: HTMLElement): void {
  for (const selector of TARGETS) {
    const target = region.querySelector<HTMLElement>(selector);
    if (target && target.getClientRects().length > 0) {
      target.focus();
      return;
    }
  }
  if (!region.hasAttribute('tabindex')) region.setAttribute('tabindex', '-1');
  region.focus();
}

/** Cycles focus to the next (+1) or previous (-1) region; returns whether it moved. */
export function cycleRegion(shell: Element, direction: 1 | -1): boolean {
  const regions = regionsOf(shell);
  if (regions.length === 0) return false;
  const active = document.activeElement;
  // The innermost region holding focus (the tool bar sits inside the stage).
  let at = -1;
  regions.forEach((region, i) => {
    if (active && region.contains(active) && (at < 0 || regions[at]?.contains(region))) at = i;
  });
  const next =
    at < 0
      ? direction > 0
        ? 0
        : regions.length - 1
      : (at + direction + regions.length) % regions.length;
  const region = regions[next];
  if (!region) return false;
  focusRegion(region);
  return true;
}

/** Installs the F6 handler for the shell around `anchor` while mounted. */
export function useRegionCycling(anchor: { readonly current: HTMLElement | null }): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F6' || event.altKey || event.ctrlKey || event.metaKey) return;
      const active = document.activeElement;
      if (active?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      const shell = anchor.current?.closest('[data-testid="app-shell"]');
      if (!shell) return;
      if (cycleRegion(shell, event.shiftKey ? -1 : 1)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [anchor]);
}
