/**
 * Document tools in the app (spec document-tools.md §3, §4, §7): the Info metadata editor
 * (one history entry per change, policy switch), the Set password dialog's validation and
 * result, Strip metadata's checklist, and diagnostics rendered from a fixture.
 */
import { getActiveDocument, type SourceId } from '@pdf-editor/document-model';
import { diagnoseSource } from '@pdf-editor/engine';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import imagesUrl from '../../../../test/fixtures/images.pdf?url';
import metadataUrl from '../../../../test/fixtures/metadata-xmp.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { resetWorkspace, useActiveDocument, useWorkspaceStore } from '../state/workspace-store';
import { DiagnosticsDetails, DiagnosticsView } from './Diagnostics';
import { setDiagnosticsDependencies } from './diagnostics';
import { closeDocumentDialog, openDocumentDialog } from './document-store';
import { DocumentDialogs } from './DocumentDialogs';
import { MetadataEditor } from './MetadataEditor';
import { validatePasswordForm } from './password-form';
import { passwordStrength } from './password-strength';
import { ALL_PERMISSIONS } from '@pdf-editor/document-model';

const labels = () => {
  const { past, present } = useWorkspaceStore.getState().history;
  return [...past, present].map((e) => e.label);
};
const activeDoc = () => {
  const doc = getActiveDocument(useWorkspaceStore.getState().workspace);
  if (!doc) throw new Error('no document');
  return doc;
};

function ActiveMetadata() {
  const doc = useActiveDocument();
  return doc ? <MetadataEditor doc={doc} /> : null;
}

async function openMetadataFixture() {
  await useWorkspaceStore
    .getState()
    .openFiles([await fixtureFile(metadataUrl, 'metadata-xmp.pdf')]);
}

/** Diagnostics computed on the main thread from the engine service's kept bytes. */
function useLocalDiagnostics() {
  setDiagnosticsDependencies({
    bytes: async (id: SourceId) => {
      const { getEngineService } = await import('../engine/engine-service');
      return getEngineService().sourceBytes(id);
    },
    password: () => undefined,
    diagnose: (bytes, password) =>
      diagnoseSource(bytes, password === undefined ? {} : { password }),
    onSourceClosed: () => () => undefined,
    structuralWarnings: () => Promise.resolve([]),
  });
}

beforeEach(() => {
  resetWorkspace();
  closeDocumentDialog();
});
afterEach(() => {
  closeDocumentDialog();
  setDiagnosticsDependencies(undefined);
  resetWorkspace();
});

describe('Info metadata editor', () => {
  it('shows the file’s metadata and makes each edit one history entry', async () => {
    await openMetadataFixture();
    render(<ActiveMetadata />);
    const title = screen.getByLabelText('Title');
    expect(title).toHaveValue('Metadata and XMP fixture');
    expect(screen.getByLabelText('Author')).toHaveValue('Jane Q. Fixture');
    expect(screen.getByTestId('metadata-created')).not.toHaveTextContent('—');
    expect(activeDoc().metadata.policy).toBe('inherit-first-source');
    const before = labels().length;

    await userEvent.fill(title, 'Annual report');
    await userEvent.keyboard('{Enter}');
    expect(activeDoc().metadata).toMatchObject({ title: 'Annual report', policy: 'explicit' });
    expect(labels().slice(before)).toEqual(['Change Title']);
    expect(screen.getByTestId('metadata-policy')).toHaveTextContent('Edited');

    // Blur commits too; an unchanged field adds nothing.
    await userEvent.fill(screen.getByLabelText('Author'), 'Ada Lovelace');
    await userEvent.click(screen.getByLabelText('Subject'));
    await userEvent.click(screen.getByLabelText('Keywords'));
    expect(labels().slice(before)).toEqual(['Change Title', 'Change Author']);

    // Undo restores the previous value in the field.
    act(() => {
      useWorkspaceStore.getState().undo();
    });
    expect(screen.getByLabelText('Author')).toHaveValue('Jane Q. Fixture');
  });

  it('refuses a malformed language tag and accepts a BCP 47 one', async () => {
    await openMetadataFixture();
    render(<ActiveMetadata />);
    const before = labels().length;
    const language = screen.getByLabelText('Language');
    await userEvent.fill(language, 'english please');
    await userEvent.keyboard('{Enter}');
    expect(language).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Use a language tag/)).toBeVisible();
    expect(labels().length).toBe(before);
    await userEvent.fill(language, 'tr-TR');
    await userEvent.keyboard('{Enter}');
    expect(activeDoc().metadata.language).toBe('tr-TR');
    expect(labels().slice(before)).toEqual(['Change Language']);
  });

  it('adds, validates, edits and removes custom keys', async () => {
    await openMetadataFixture();
    render(<ActiveMetadata />);
    const key = screen.getByRole('textbox', { name: 'Key' });
    const value = screen.getByRole('textbox', { name: 'Value' });
    await userEvent.fill(key, 'Author');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('standard key');
    await userEvent.fill(key, 'bad key');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Use letters');
    await userEvent.fill(key, 'Department');
    await userEvent.fill(value, 'Legal');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(activeDoc().metadata.custom).toEqual({ Department: 'Legal' });
    expect(labels().at(-1)).toBe('Add metadata key Department');

    await userEvent.fill(screen.getByLabelText('Department'), 'Finance');
    await userEvent.keyboard('{Enter}');
    expect(activeDoc().metadata.custom).toEqual({ Department: 'Finance' });
    await userEvent.click(screen.getByRole('button', { name: 'Remove Department' }));
    expect(activeDoc().metadata.custom).toBeUndefined();
    expect(labels().slice(-3)).toEqual([
      'Add metadata key Department',
      'Change Department',
      'Remove metadata key Department',
    ]);
  });
});

describe('Set password dialog', () => {
  it('validates the form', () => {
    const base = { userPassword: '', ownerPassword: '', permissions: ALL_PERMISSIONS };
    expect(validatePasswordForm(base).problem).toBe('no-password');
    expect(validatePasswordForm({ ...base, userPassword: 'a', ownerPassword: 'a' }).problem).toBe(
      'same-passwords',
    );
    expect(validatePasswordForm({ ...base, userPassword: 'é'.repeat(64) }).problem).toBe(
      'too-long',
    );
    expect(validatePasswordForm({ ...base, ownerPassword: 'owner' })).toEqual({
      randomOwner: false,
    });
    expect(
      validatePasswordForm({
        ...base,
        userPassword: 'user',
        permissions: { ...ALL_PERMISSIONS, copy: false },
      }),
    ).toEqual({ randomOwner: true });
  });

  it('rates passwords from very weak to strong', () => {
    expect(passwordStrength('').score).toBe(0);
    expect(passwordStrength('password1').score).toBe(0);
    expect(passwordStrength('aaaaaaaaaaaa').score).toBe(0);
    expect(passwordStrength('abcdef123').score).toBeLessThanOrEqual(1);
    expect(passwordStrength('Tr0ub4dor&3').score).toBeGreaterThanOrEqual(2);
    expect(passwordStrength('correct horse battery staple').score).toBe(4);
  });

  it('shows errors, the strength meter, and stores the policy as one history entry', async () => {
    await openMetadataFixture();
    render(<DocumentDialogs />);
    act(() => openDocumentDialog('set-password', activeDoc().id));
    const dialog = await screen.findByTestId('set-password-dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set password' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Enter a password to open, a password to change permissions, or both.',
    );
    const open = within(dialog).getByLabelText('Password to open');
    expect(open).toHaveAttribute('type', 'password');
    await userEvent.fill(open, 'same');
    await userEvent.fill(within(dialog).getByLabelText('Password to change permissions'), 'same');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set password' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Use a different password');
    expect(within(dialog).getAllByText(/^Strength: /).length).toBe(2);

    await userEvent.click(within(dialog).getByLabelText(/Show passwords/));
    expect(open).toHaveAttribute('type', 'text');
    await userEvent.fill(
      within(dialog).getByLabelText('Password to change permissions'),
      'a different owner secret',
    );
    await userEvent.click(within(dialog).getByLabelText('Copying text and images'));
    // High-quality printing depends on printing.
    await userEvent.click(within(dialog).getByLabelText('Printing'));
    expect(within(dialog).getByLabelText('High-quality printing')).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set password' }));
    expect(activeDoc().security).toEqual({
      algorithm: 'aes-256',
      userPassword: 'same',
      ownerPassword: 'a different owner secret',
      permissions: { ...ALL_PERMISSIONS, copy: false, print: false, printHighQuality: false },
    });
    expect(labels().at(-1)).toBe('Set password');
  });

  it('removes a password it set', async () => {
    await openMetadataFixture();
    render(<DocumentDialogs />);
    act(() => openDocumentDialog('set-password', activeDoc().id));
    const dialog = await screen.findByTestId('set-password-dialog');
    await userEvent.fill(within(dialog).getByLabelText('Password to open'), 'secret-123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set password' }));
    expect(activeDoc().security?.userPassword).toBe('secret-123');
    act(() => openDocumentDialog('remove-password', activeDoc().id));
    const remove = await screen.findByTestId('remove-password-dialog');
    await userEvent.click(within(remove).getByRole('button', { name: 'Remove password' }));
    expect(activeDoc().security).toBeUndefined();
    expect(labels().slice(-2)).toEqual(['Set password', 'Remove password']);
  });
});

describe('Strip metadata and diagnostics', () => {
  it('lists what was found and stores the selection', async () => {
    useLocalDiagnostics();
    await openMetadataFixture();
    render(<DocumentDialogs />);
    act(() => openDocumentDialog('strip-metadata', activeDoc().id));
    // The dialog shows a checking state first, then the checklist (a new popup).
    await screen.findByTestId('strip-count-attachments', {}, { timeout: 10_000 });
    const dialog = screen.getByTestId('strip-dialog');
    expect(within(dialog).getByTestId('strip-count-attachments')).toHaveTextContent('1 found');
    expect(within(dialog).getByTestId('strip-count-xmp')).toHaveTextContent('1 found');
    expect(within(dialog).getByTestId('strip-count-javascript')).toHaveTextContent('none found');
    expect(within(dialog).getByText(/attachment\.txt/)).toBeVisible();
    // Annotation authors are optional: not selected by default.
    expect(within(dialog).getByLabelText(/Annotation authors and dates/)).not.toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Strip on export' }));
    const meta = activeDoc().metadata;
    expect(meta.strip).toMatchObject({ info: true, xmp: true, attachments: true });
    expect(meta.author).toBeUndefined();
    expect(labels().at(-1)).toBe('Strip metadata');
  });

  it('renders the facts of a fixture', async () => {
    const bytes = await (await fetch(imagesUrl)).arrayBuffer();
    const diagnostics = await diagnoseSource(bytes);
    render(<DiagnosticsView diagnostics={diagnostics} />);
    const facts = screen.getByTestId('diagnostics-facts');
    const row = (term: string) => within(facts).getByText(term).nextElementSibling;
    expect(row('Pages')).toHaveTextContent('3');
    expect(row('Encryption')).toHaveTextContent('None');
    expect(row('Images')?.textContent).toMatch(/^3; \d+–\d+ dpi \(lowest–median, approximate\)$/);
    expect(row('Fonts')?.textContent).toMatch(/not embedded/);
    expect(row('Form')).toHaveTextContent('None');
    await userEvent.click(screen.getByText('Show 3 images'));
    expect(screen.getAllByText(/× \d+ px/).length).toBe(3);
  });

  it('computes diagnostics lazily when Details opens', async () => {
    let calls = 0;
    let checks = 0;
    setDiagnosticsDependencies({
      bytes: async () => ({ ok: true, value: await (await fetch(metadataUrl)).arrayBuffer() }),
      password: () => undefined,
      diagnose: (bytes) => {
        calls += 1;
        return diagnoseSource(bytes);
      },
      onSourceClosed: () => () => undefined,
      structuralWarnings: () => {
        checks += 1;
        return Promise.resolve(['qpdf: object 12 0: expected endobj']);
      },
    });
    await openMetadataFixture();
    const ws = useWorkspaceStore.getState().workspace;
    const sources = Object.values(ws.sources);
    render(<DiagnosticsDetails sources={sources} />);
    expect(calls).toBe(0);
    await userEvent.click(screen.getByText('Details'));
    await screen.findByTestId('diagnostics-facts', {}, { timeout: 10_000 });
    expect(calls).toBe(1);
    const facts = screen.getByTestId('diagnostics-facts');
    expect(within(facts).getByText('Attachments').nextElementSibling).toHaveTextContent(
      '1 (attachment.txt)',
    );

    // qpdf's structural check runs only on request and joins the warnings list.
    const structural = screen.getByTestId('structural-warnings');
    expect(checks).toBe(0);
    await userEvent.click(within(structural).getByRole('button', { name: 'Run structural check' }));
    await within(structural).findByText('qpdf: object 12 0: expected endobj');
    expect(checks).toBe(1);
    expect(within(structural).queryByRole('button')).toBeNull();
  });
});
