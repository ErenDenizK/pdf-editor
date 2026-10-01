/**
 * Redaction header folding (experience-redesign §4.1): the honesty warning of the Review
 * tab's Marks filter is one line, "Marks hide nothing until you apply them. Why?", and
 * "Why?" discloses the full text.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { resetWorkspace } from '../../state/workspace-store';
import { RedactionTools } from './RedactionsPanel';

const FULL =
  'Marks are only marks: the text under them stays in the file, and anyone can remove a mark, until redactions are applied. Applying cannot be undone once the file is exported.';

describe('Redaction warning', () => {
  beforeEach(() => {
    resetWorkspace();
  });

  it('shows one line and discloses the full text on demand', async () => {
    render(<RedactionTools entries={[]} />);
    const note = screen.getByTestId('redaction-honesty');
    expect(note).toHaveTextContent('Marks hide nothing until you apply them.');
    const why = screen.getByRole('button', { name: 'Why?' });
    expect(why).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(FULL)).not.toBeVisible();

    await userEvent.click(why);
    expect(why).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(FULL)).toBeVisible();
    expect(document.getElementById(why.getAttribute('aria-controls') ?? '')).toHaveTextContent(
      FULL,
    );

    await userEvent.click(why);
    expect(screen.getByText(FULL)).not.toBeVisible();
  });
});
