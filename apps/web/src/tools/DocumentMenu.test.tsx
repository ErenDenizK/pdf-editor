/**
 * The Document menu (experience-redesign spec §5.3), Vitest browser mode: sections with
 * headings in order, Merge files…, Split…, Compare with… and Rotate pages in "Combine and
 * split", no disabled "Remove …" twins (an item that removes appears only when there is
 * something to remove), unnamed Document commands join the last section, Rotate pages
 * turns every page when none is selected, and the Appearance group toggles Glass panels,
 * Reduce transparency (craft spec §7) and Pen draws in Edit (§3.5).
 */
import '../styles/tokens.css';
import '../styles/reset.css';
import '../styles/global.css';

import { getActiveDocument } from '@pdf-editor/document-model';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { resetPenSession } from '../annotations/pen/ink-input';
import { registerAppCommands } from '../commands/app-commands';
import { type Command, commandRegistry } from '../commands/registry';
import { registerDocumentCommands } from '../document/document-commands';
import { m, setLocale } from '../i18n';
import { registerOutlineCommands } from '../outline/outline-commands';
import { registerSignatureCommands } from '../signatures/signature-commands';
import { registerArrangeCommands } from '../stage/arrange-commands';
import { DEFAULT_APPEARANCE, useAppearanceStore } from '../state/appearance-store';
import { resetEditPolicyStore, useEditPolicyStore } from '../state/edit-policy-store';
import { useSelectionStore } from '../state/selection-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { DocumentMenu, shownDocumentMenu } from './DocumentMenu';

function fake(id: string, available: boolean, title = id): Command {
  return {
    id,
    title,
    group: m.group_document(),
    shortcuts: [],
    when: () => available,
    run: () => undefined,
  };
}

describe('Document menu sections (model)', () => {
  it('shows a "Remove …" item only when there is something to remove', () => {
    const commands = [
      fake('document.pageNumbers', true),
      fake('document.pageNumbers.remove', false),
      fake('document.watermark', true),
      fake('document.watermark.remove', true),
      fake('document.setPassword', true),
      fake('document.removePassword', false),
      fake('outline.removeDeadLinks', false),
      fake('document.saveRepaired', false),
      // Unavailable but not a "Remove …": stays, disabled.
      fake('document.compress', false),
      fake('document.someNewTool', true, 'Some new tool…'),
    ];
    const shown = shownDocumentMenu(commands);
    const ids = Object.fromEntries(
      shown.map(({ section, entries }) => [section.id, entries.map((e) => e.key)]),
    );
    expect(ids).toEqual({
      combine: ['merge', 'rotate'],
      add: ['document.pageNumbers', 'document.watermark', 'document.watermark.remove'],
      protect: ['document.setPassword'],
      convert: ['document.compress'],
      // Commands no section names join the last one.
      document: ['document.someNewTool'],
    });
    const compress = shown.flatMap((s) => s.entries).find((e) => e.key === 'document.compress');
    expect(compress?.enabled).toBe(false);
  });
});

describe('Document menu', () => {
  const disposers: (() => void)[] = [];
  beforeAll(() => {
    disposers.push(
      registerAppCommands(),
      registerArrangeCommands(),
      registerDocumentCommands(commandRegistry),
      registerOutlineCommands(commandRegistry),
      registerSignatureCommands(commandRegistry),
    );
  });
  afterAll(() => {
    for (const dispose of disposers) dispose();
  });
  beforeEach(async () => {
    await page.viewport(1280, 800);
    resetWorkspace();
    useSelectionStore.getState().apply({ selected: new Set(), anchor: null, focused: null });
    await useWorkspaceStore.getState().openFiles([await fixtureFile(simpleUrl, 'simple.pdf')]);
  });
  afterEach(() => {
    resetWorkspace();
  });

  it('lists its sections with headings and no disabled twins', async () => {
    render(<DocumentMenu visible />);
    const trigger = screen.getByTestId('document-menu');
    expect(trigger).toHaveAccessibleName('Document');
    await userEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    const headings = [...menu.querySelectorAll('[data-section]')].map(
      (group) => group.firstElementChild?.textContent,
    );
    expect(headings).toEqual([
      'Combine and split',
      'Add to pages',
      'Protect and sign',
      'Convert and export',
      'Document',
    ]);
    const combine = menu.querySelector<HTMLElement>('[data-section="combine"]');
    if (!combine) throw new Error('no Combine and split section');
    expect(
      within(combine)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Merge files…', 'Split…', 'Compare with…', 'Rotate pages']);
    // Nothing to remove in a plain file: no "Remove …" item at all, enabled or not.
    const names = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent ?? '');
    expect(names.filter((name) => name.startsWith('Remove'))).toEqual([]);
    expect(names).toContain('Page numbers…');
    expect(names).toContain('Set password…');
  });

  it('rotates every page when none is selected', async () => {
    render(<DocumentMenu visible />);
    await userEvent.click(screen.getByTestId('document-menu'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rotate pages' }));
    const right = await screen.findByRole('menuitem', { name: 'Right 90°' });
    expect(screen.getByText('All 3 pages')).toBeInTheDocument();
    await userEvent.click(right);
    await waitFor(() => {
      const doc = getActiveDocument(useWorkspaceStore.getState().workspace);
      expect(doc?.pages.map((p) => p.rotation)).toEqual([90, 90, 90]);
    });
  });
  it('toggles the appearance settings from checkbox items, keeping the menu open', async () => {
    useAppearanceStore.setState(DEFAULT_APPEARANCE);
    resetPenSession();
    resetEditPolicyStore();
    try {
      render(<DocumentMenu visible />);
      await userEvent.click(screen.getByTestId('document-menu'));
      const menu = await screen.findByRole('menu', { name: 'Document' });
      // One row in the Document section, just before "About this app".
      const document = menu.querySelector<HTMLElement>('[data-section="document"]');
      if (!document) throw new Error('no Document section');
      const rows = within(document)
        .getAllByRole('menuitem')
        .map((item) => item.textContent);
      expect(rows.slice(-2)).toEqual(['Appearance', 'About this app']);
      await userEvent.click(within(document).getByRole('menuitem', { name: 'Appearance' }));
      const glass = await screen.findByRole('menuitemcheckbox', { name: 'Glass panels' });
      const reduce = screen.getByRole('menuitemcheckbox', { name: 'Reduce transparency' });
      expect(glass).toHaveAttribute('aria-checked', 'false');
      expect(reduce).toHaveAttribute('aria-checked', 'false');
      // Every switch shows a box, off as well as on (review F21).
      const box = (item: HTMLElement) => item.querySelector<HTMLElement>('[data-on], span');
      for (const item of screen.getAllByRole('menuitemcheckbox')) {
        const indicator = box(item);
        expect(indicator).not.toBeNull();
        expect(indicator?.hasAttribute('data-on')).toBe(false);
        const style = getComputedStyle(indicator as HTMLElement);
        expect(style.width).toBe('14px');
        expect(style.borderTopStyle).toBe('solid');
      }

      await userEvent.click(glass);
      expect(useAppearanceStore.getState().glassPanels).toBe(true);
      await waitFor(() => expect(glass).toHaveAttribute('aria-checked', 'true'));
      expect(box(glass)?.hasAttribute('data-on')).toBe(true);
      expect(box(glass)?.querySelector('svg')).not.toBeNull();
      await userEvent.click(reduce);
      expect(useAppearanceStore.getState().reduceTransparency).toBe(true);
      expect(screen.getByRole('menuitemcheckbox', { name: 'Glass panels' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Glass panels' }));
      expect(useAppearanceStore.getState().glassPanels).toBe(false);

      // "Pen draws in Edit" (craft spec §3.5): "auto" before any pen shows off; a click chooses.
      const pen = screen.getByRole('menuitemcheckbox', { name: 'Pen draws in Edit' });
      expect(pen).toHaveAttribute('aria-checked', 'false');
      await userEvent.click(pen);
      expect(useEditPolicyStore.getState().penDrawsInEdit).toBe(true);
      await waitFor(() => expect(pen).toHaveAttribute('aria-checked', 'true'));
      await userEvent.click(pen);
      expect(useEditPolicyStore.getState().penDrawsInEdit).toBe(false);
    } finally {
      useAppearanceStore.setState(DEFAULT_APPEARANCE);
      resetEditPolicyStore();
    }
  });

  it('names the submenu "Görünüş" in Turkish, not "Görünüm" (View) (review F24)', () => {
    setLocale('tr');
    try {
      expect(m.appearance_heading()).toBe('Görünüş');
      expect(m.group_view()).toBe('Görünüm');
      // The Edit button is a verb; the mode is a noun.
      expect(m.mode_edit_button()).toBe('Düzenle');
      // The mode control keeps its nouns: Okuma · Düzenleme · Sıralama.
      expect([m.mode_read(), m.mode_edit(), m.mode_arrange()]).toEqual([
        'Okuma',
        'Düzenleme',
        'Sıralama',
      ]);
    } finally {
      setLocale('en');
    }
  });
});
