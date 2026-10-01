/**
 * F6 / Shift+F6 cycle the app's regions (experience-redesign §10): title bar, navigator,
 * stage, tool bar and the inspector when it is open; focus lands on each region's current
 * item. Dialogs keep their own keyboard.
 */
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { cycleRegion, useRegionCycling } from './LeftRail.regions';

function Shell({ inspector = true }: { readonly inspector?: boolean }) {
  const anchor = useRef<HTMLElement>(null);
  useRegionCycling(anchor);
  return (
    <div data-testid="app-shell">
      <header>
        <button type="button" role="tab" tabIndex={-1}>
          other.pdf
        </button>
        <button type="button" role="tab" tabIndex={0}>
          report.pdf
        </button>
      </header>
      <aside ref={anchor} data-region="navigator">
        <button type="button" role="tab" tabIndex={-1}>
          Pages
        </button>
        <button type="button" role="tab" tabIndex={0}>
          Review
        </button>
      </aside>
      <main>
        <div data-read-viewport="" tabIndex={-1}>
          page
        </div>
        <div role="toolbar">
          <button type="button" tabIndex={-1}>
            Select
          </button>
          <button type="button" aria-pressed="true" tabIndex={0}>
            Pen
          </button>
        </div>
      </main>
      {inspector ? (
        <aside id="right-panel">
          <button type="button">History entry</button>
        </aside>
      ) : null}
      <div role="dialog">
        <input aria-label="In a dialog" />
      </div>
    </div>
  );
}

const focused = () => {
  const el = document.activeElement;
  return el?.hasAttribute('data-read-viewport') ? 'page' : (el?.textContent ?? '');
};

describe('F6 regions', () => {
  it('cycles title bar, navigator, stage, tool bar and inspector, and back', async () => {
    render(<Shell />);
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      await userEvent.keyboard('{F6}');
      seen.push(focused());
    }
    expect(seen).toEqual(['report.pdf', 'Review', 'page', 'Pen', 'History entry', 'report.pdf']);
    await userEvent.keyboard('{Shift>}{F6}{/Shift}');
    expect(focused()).toBe('History entry');
    await userEvent.keyboard('{Shift>}{F6}{/Shift}');
    expect(focused()).toBe('Pen');
  });

  it('skips the inspector when it is closed', () => {
    const { container } = render(<Shell inspector={false} />);
    const shell = container.querySelector('[data-testid="app-shell"]') as Element;
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      cycleRegion(shell, 1);
      seen.push(focused());
    }
    expect(seen).toEqual(['report.pdf', 'Review', 'page', 'Pen', 'report.pdf']);
  });

  it('leaves F6 to a dialog that has focus', async () => {
    const { getByLabelText } = render(<Shell />);
    const input = getByLabelText('In a dialog');
    input.focus();
    await userEvent.keyboard('{F6}');
    expect(input).toHaveFocus();
  });
});
