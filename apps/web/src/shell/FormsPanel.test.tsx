/**
 * Forms panel folding (experience-redesign §4.1): Highlight fields, Edit fields, Clear all
 * and Flatten on export show only when the document has fields; otherwise one sentence
 * says so and "Add field" stays.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import formsAUrl from '../../../../test/fixtures/forms-a.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { resetAnnotationStore } from '../annotations/annotation-store';
import { resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { resetFormStore } from '../forms/form-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { FormsPanel } from './FormsPanel';
import '../forms/index';

async function open(url: string, name: string): Promise<void> {
  const report = await useWorkspaceStore.getState().openFiles([await fixtureFile(url, name)]);
  expect(report.skipped).toEqual([]);
}

describe('Forms panel folding', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetFormStore();
  });
  afterEach(async () => {
    await whenIdle();
    resetWorkspace();
  });

  it('hides the field controls when the document has no fields, and says so', async () => {
    await open(simpleUrl, 'simple-text.pdf');
    render(<FormsPanel />);
    expect(await screen.findByText('No form fields')).toBeVisible();
    expect(
      screen.getByText('This document has no form fields. Add one with “Add field”.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: /Add field/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Highlight fields' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit fields' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Flatten on export' })).toBeNull();
  });

  it('shows them once the document has fields', async () => {
    await open(formsAUrl, 'forms-a.pdf');
    render(<FormsPanel />);
    expect(await screen.findByRole('button', { name: 'Highlight fields' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit fields' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Flatten on export' })).toBeVisible();
    expect(screen.queryByText('No form fields')).toBeNull();
  });
});
