import type { ReconciliationReport } from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import { sourceNoteWarnings } from './export-service';
import { summarizeReport } from './summary';

const empty: ReconciliationReport = {
  outlineNodesKept: 0,
  outlineNodesDropped: 0,
  linksRewritten: 0,
  linksDropped: 0,
  formFieldsRenamed: [],
  formFieldsUnified: [],
  structureTreeRemoved: false,
  xfaRemoved: false,
  warnings: [],
};

describe('summarizeReport', () => {
  it('says nothing about features the document does not have', () => {
    expect(summarizeReport(empty)).toEqual([]);
  });

  it('reports kept, dropped, renamed and removed items without duplicating warnings', () => {
    const items = summarizeReport({
      ...empty,
      outlineNodesKept: 10,
      outlineNodesDropped: 2,
      linksRewritten: 2,
      linksDropped: 1,
      formFieldsRenamed: [{ from: 'name', to: 'forms-b.name' }],
      structureTreeRemoved: true,
      xfaRemoved: true,
      warnings: [
        'Tagged PDF structure was removed; the output is not tagged',
        'XFA form data was removed; only the AcroForm fields were kept',
        'Some overlay characters are not supported',
      ],
    });
    expect(items.map((i) => i.id)).toEqual([
      'outline',
      'links',
      'renamed',
      'tags',
      'xfa',
      'warning-0',
    ]);
    expect(items[0]?.text).toBe(
      'Bookmarks: 10 kept, 2 dropped because their pages are not in this document.',
    );
    expect(items[2]?.details).toEqual(['name → forms-b.name']);
    expect(items[5]?.text).toBe('Some overlay characters are not supported');
  });

  it('says when password protection was removed and files were repaired, once each', () => {
    const notes = { securityRemoved: ['locked.pdf', 'owner.pdf'], repaired: ['broken.pdf'] };
    const warnings = sourceNoteWarnings(notes);
    expect(warnings).toEqual([
      'Password protection from 2 files was removed; set a new password in Export options',
      '1 file had to be repaired when opened; the output was built from the repaired copy',
    ]);
    const items = summarizeReport({ ...empty, warnings }, notes);
    expect(items).toEqual([
      {
        id: 'security',
        tone: 'changed',
        text: 'Password protection from 2 files was removed; set a new password in Export options.',
        details: ['locked.pdf', 'owner.pdf'],
      },
      {
        id: 'repaired',
        tone: 'changed',
        text: '1 damaged file was repaired when opened; the output is built from the repaired copy.',
        details: ['broken.pdf'],
      },
    ]);
    expect(
      summarizeReport(
        { ...empty, warnings: sourceNoteWarnings({ securityRemoved: ['a.pdf'], repaired: [] }) },
        { securityRemoved: ['a.pdf'], repaired: [] },
      ).map((i) => i.text),
    ).toEqual([
      'Password protection from 1 file was removed; set a new password in Export options.',
    ]);
  });

  it('marks a clean outline as kept', () => {
    expect(summarizeReport({ ...empty, outlineNodesKept: 1 })[0]).toMatchObject({
      tone: 'kept',
      text: 'Bookmarks: all 1 bookmark kept.',
    });
  });
});
