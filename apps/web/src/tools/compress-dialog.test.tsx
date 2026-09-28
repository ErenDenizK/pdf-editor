/**
 * Compress dialog presets (spec document-tools.md §5; DESIGN.md §5 focus ring): a preset
 * reached with the keyboard shows the shared focus ring on its card, distinct from the
 * accent border that marks the checked preset.
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import { render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import imagesUrl from '../../../../test/fixtures/images.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { disposeCompressor } from './compress-client';
import CompressDialog from './CompressDialog';
import { closeToolDialog, openToolDialog } from './tools-store';

beforeEach(() => {
  resetWorkspace();
  closeToolDialog();
});
afterEach(() => {
  closeToolDialog();
  resetWorkspace();
});
afterAll(async () => {
  await disposeCompressor();
});

describe('Compress presets', () => {
  it('draw the focus ring on the preset focused with the keyboard', async () => {
    await useWorkspaceStore.getState().openFiles([await fixtureFile(imagesUrl, 'images.pdf')]);
    const id = useWorkspaceStore.getState().workspace.documentOrder[0];
    if (id === undefined) throw new Error('not opened');
    openToolDialog('compress', id);
    render(<CompressDialog documentId={id} />);

    const dialog = await screen.findByTestId('compress-dialog');
    const screenPreset = await within(dialog).findByRole(
      'radio',
      { name: /Screen/ },
      { timeout: 30_000 },
    );
    const ebook = within(dialog).getByRole('radio', { name: /E-book/ });
    const card = (radio: HTMLElement) => {
      const label = radio.closest('label');
      if (!label) throw new Error('no preset card');
      return label;
    };

    screenPreset.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(ebook).toHaveFocus();
    expect(ebook).toBeChecked();

    const focused = getComputedStyle(card(ebook));
    expect(focused.outlineStyle).toBe('solid');
    expect(focused.outlineWidth).toBe('2px');
    expect(focused.outlineOffset).toBe('1px');
    // The unfocused preset draws no ring.
    expect(getComputedStyle(card(screenPreset)).outlineStyle).toBe('none');
  }, 60_000);
});
