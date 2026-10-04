/**
 * The docked frame's paint (craft spec §7; Vitest browser mode, real style sheets): with
 * "Glass panels" off it is exactly the old opaque --surface-1 frame; with it on, every frame
 * surface is the tier-2 glass (no geometry gate, review F7), and "Reduce transparency" makes
 * them solid again. The palette offers both settings, titled with their state.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../app';
import { commandRegistry } from '../commands/registry';
import { DEFAULT_APPEARANCE, useAppearanceStore } from '../state/appearance-store';
import { useUiStore } from '../state/ui-store';
import { resetWorkspace } from '../state/workspace-store';

const SURFACE_1 = 'rgb(24, 26, 31)';

function frame() {
  const shell = screen.getByTestId('app-shell');
  const pick = (selector: string) => {
    const el = shell.querySelector<HTMLElement>(`:scope > ${selector}`);
    if (!el) throw new Error(`no ${selector}`);
    return getComputedStyle(el);
  };
  return {
    shell,
    title: pick('header'),
    navigator: pick('[data-region="navigator"]'),
    status: pick('footer'),
  };
}

const blurOf = (style: CSSStyleDeclaration) =>
  style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter');

describe('the docked frame', () => {
  beforeEach(() => {
    useUiStore.setState({ viewMode: 'read', paletteOpen: false, shortcutsOpen: false });
    useAppearanceStore.setState(DEFAULT_APPEARANCE);
    resetWorkspace();
  });
  afterEach(() => {
    useAppearanceStore.setState(DEFAULT_APPEARANCE);
  });

  it('stays the opaque --surface-1 frame with Glass panels off', () => {
    render(<App />);
    const { shell, title, navigator, status } = frame();
    expect(shell).toHaveAttribute('data-stage-bleed');
    for (const style of [title, navigator, status]) {
      expect(style.backgroundColor).toBe(SURFACE_1);
      expect(['', 'none']).toContain(blurOf(style));
      expect(style.boxShadow).toBe('none');
    }
    // The stage sits under the frame.
    expect(title.zIndex).toBe('1');
  });

  it('makes every frame surface glass while Glass panels is on, with no page near too', async () => {
    render(<App />);
    act(() => useAppearanceStore.getState().setGlassPanels(true));
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-glass-panels'));
    const { shell, title, navigator, status } = frame();
    // Nothing is open: no page anywhere, and the frame is glass all the same (review F7).
    expect(shell.hasAttribute('data-glass-near')).toBe(false);
    for (const style of [title, navigator, status]) {
      expect(blurOf(style)).toBe('blur(40px) saturate(1.4) brightness(0.6)');
      expect(style.backgroundColor).toBe('rgba(29, 31, 37, 0.8)');
    }
    // No shadow on docked glass: the inner top highlight only, on every surface.
    for (const style of [title, navigator, status]) {
      expect(style.boxShadow).toMatch(/^rgba\(255, 255, 255, 0\.06\) 0px 1px 0px 0px inset$/);
    }
    // Text steps up to the glass ladder at once, so nothing jumps when the blur turns on.
    expect(status.getPropertyValue('--text-secondary').trim()).toBe('#bcc0c6');

    act(() => useAppearanceStore.getState().setReduceTransparency(true));
    await waitFor(() =>
      expect(document.documentElement).toHaveAttribute('data-transparency', 'reduced'),
    );
    const reduced = frame();
    expect(['', 'none']).toContain(blurOf(reduced.title));
    expect(reduced.title.backgroundColor).toBe(SURFACE_1);
    expect(reduced.title.boxShadow).not.toBe('none');
  });

  it('lists both settings in the palette with their state, and they toggle', async () => {
    render(<App />);
    const title = (id: string) => commandRegistry.get(id)?.title;
    expect(title('view.glassPanels')).toBe('Glass panels: off');
    expect(title('view.reduceTransparency')).toBe('Reduce transparency: off');
    await act(async () => {
      await commandRegistry.execute('view.glassPanels');
    });
    expect(useAppearanceStore.getState().glassPanels).toBe(true);
    expect(title('view.glassPanels')).toBe('Glass panels: on');
    await act(async () => {
      await commandRegistry.execute('view.reduceTransparency');
    });
    expect(useAppearanceStore.getState().reduceTransparency).toBe(true);
    expect(title('view.reduceTransparency')).toBe('Reduce transparency: on');
    // Changed elsewhere (the Document menu): the palette follows.
    act(() => useAppearanceStore.getState().setGlassPanels(false));
    expect(title('view.glassPanels')).toBe('Glass panels: off');
    // Still found by the old wording.
    expect(commandRegistry.get('view.glassPanels')?.keywords).toContain('toggle');
  });
});
