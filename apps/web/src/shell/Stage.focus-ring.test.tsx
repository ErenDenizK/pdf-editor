/**
 * The page view's focus ring (review finding 23): it shows only when the focus reached the
 * pages by Tab or F6, never after a click on them or a key such as `2` pressed while they have
 * the focus (`watchStageFocusRing`, stage/ReadView.module.css). Vitest browser mode, with real
 * keyboard and pointer input so `:focus-visible` behaves as in the app.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import readStyles from '../stage/ReadView.module.css';
import { STAGE_FOCUS_RING_ATTR, watchStageFocusRing } from './Stage';
import { STAGE_ID } from './TabBar';

function Fixture() {
  return (
    <>
      <button type="button">Before</button>
      <main id={STAGE_ID}>
        <div className={readStyles.frame} data-testid="frame" style={{ height: 200 }}>
          <div
            className={readStyles.viewport}
            data-testid="viewport"
            role="region"
            aria-label="Pages"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            style={{ inset: 0 }}
          />
        </div>
      </main>
    </>
  );
}

/** The ring drawn around the frame (its `::after`), or none. */
const ring = () => getComputedStyle(screen.getByTestId('frame'), '::after').content;
const stage = () => document.getElementById(STAGE_ID) as HTMLElement;

describe('the stage focus ring', () => {
  let dispose: () => void = () => undefined;
  afterEach(() => {
    dispose();
    cleanup();
  });

  it('shows after Tab, not after a click or a mode key; F6 counts as Tab', async () => {
    render(<Fixture />);
    dispose = watchStageFocusRing();
    screen.getByRole('button', { name: 'Before' }).focus();
    await userEvent.keyboard('{Tab}');
    expect(screen.getByTestId('viewport')).toHaveFocus();
    expect(stage()).toHaveAttribute(STAGE_FOCUS_RING_ATTR);
    expect(ring()).not.toBe('none');

    // A click on the pages: no ring, and a key pressed then does not bring it back.
    await userEvent.click(screen.getByTestId('viewport'));
    expect(stage()).not.toHaveAttribute(STAGE_FOCUS_RING_ATTR);
    expect(ring()).toBe('none');
    await userEvent.keyboard('2');
    expect(ring()).toBe('none');
    expect(getComputedStyle(screen.getByTestId('viewport')).outlineStyle).toBe('none');

    // Focus moved there by code after another key (a mode switch): no ring.
    screen.getByRole('button', { name: 'Before' }).focus();
    await userEvent.keyboard('1');
    screen.getByTestId('viewport').focus();
    expect(stage()).not.toHaveAttribute(STAGE_FOCUS_RING_ATTR);

    // F6 moves the focus between regions: the ring shows.
    screen.getByRole('button', { name: 'Before' }).focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', bubbles: true }));
    screen.getByTestId('viewport').focus();
    expect(stage()).toHaveAttribute(STAGE_FOCUS_RING_ATTR);
  });
});
