import type { EngineEdit } from '@pdf-editor/document-model';
import type { ReconciliationReport } from '@pdf-editor/engine';
import { describe, expect, it } from 'vitest';

import {
  type RedactionExportSummary,
  sourceNoteWarnings,
  type TextEditExportSummary,
  textEditFontsOf,
} from './export-service';
import { notSearchedKind, summarizeReport } from './summary';

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

  it('states the encryption algorithm and the metadata policy', () => {
    const permissions = {
      print: true,
      printHighQuality: true,
      modify: false,
      copy: false,
      annotate: true,
      fillForms: true,
      accessibility: true,
      assemble: true,
    };
    const items = summarizeReport(
      empty,
      { securityRemoved: ['a.pdf'], repaired: [] },
      {
        security: { algorithm: 'aes-256', userPassword: 'x', permissions },
        passwordRemoved: false,
        metadata: { policy: 'explicit' },
      },
    );
    expect(items.map((i) => [i.id, i.text])).toEqual([
      [
        'encryption',
        'Encrypted with AES-256; a password is needed to open it; restricted: changing content, copying text and images.',
      ],
      [
        'security',
        'Password protection from 1 file was removed; set a new password in Export options.',
      ],
      ['metadata', 'Metadata written as edited; XMP rewritten to match.'],
    ]);
    const requested = summarizeReport(
      {
        ...empty,
        metadataStripped: {
          infoKeys: 6,
          xmpPackets: 1,
          attachments: 1,
          javascript: 0,
          pieceInfo: 0,
          thumbnails: 0,
          annotationAuthors: 0,
          applied: {
            info: true,
            xmp: true,
            attachments: true,
            javascript: false,
            pieceInfo: false,
            thumbnails: false,
            annotationAuthors: false,
            customKeys: true,
          },
        },
      },
      { securityRemoved: ['a.pdf'], repaired: [] },
      { passwordRemoved: true, metadata: { policy: 'explicit' } },
    );
    expect(requested[0]).toMatchObject({
      tone: 'kept',
      text: 'Password protection from 1 file was removed, as you asked.',
    });
    expect(requested[1]).toMatchObject({
      id: 'metadata',
      tone: 'changed',
      details: [
        'Document information: 6 removed',
        'XMP metadata: 1 removed',
        'Attachments: 1 removed',
      ],
    });
  });

  it('marks a clean outline as kept', () => {
    expect(summarizeReport({ ...empty, outlineNodesKept: 1 })[0]).toMatchObject({
      tone: 'kept',
      text: 'Bookmarks: all 1 bookmark kept.',
    });
  });
});

/** A recorded `text.edit` with the outcome fields the edit runner adds. */
function recorded(payload: Record<string, unknown>): EngineEdit {
  return {
    id: globalThis.crypto.randomUUID(),
    source: 'a' as EngineEdit['source'],
    pageIndex: 0,
    kind: 'text.edit',
    payload,
  };
}

describe('text edits by font outcome (spec §2.1, §5.3)', () => {
  it('counts same font, substituted per face, fell back per face and moved out of form', () => {
    const fonts = textEditFontsOf([
      recorded({ tier: 2, honesty: 'same-font', fellBack: false }),
      recorded({ tier: 2, honesty: 'same-font-not-embedded', fellBack: false }),
      recorded({ tier: 1, face: 'NotoSans-Regular', honesty: 'font-substituted', fellBack: false }),
      recorded({ tier: 1, face: 'NotoSans-Regular', honesty: 'font-substituted', fellBack: false }),
      recorded({ tier: 1, face: 'NotoSerif-Bold', honesty: 'font-substituted', fellBack: true }),
      recorded({
        tier: 1,
        face: 'NotoSans-Regular',
        honesty: 'moved-out-of-form',
        fellBack: false,
      }),
      // Recorded without an outcome: counted by tier.
      recorded({ tier: 2 }),
      recorded({ tier: 1, face: 'JetBrainsMono-Regular' }),
      { ...recorded({ tier: 2 }), kind: 'annotation.create' },
    ]);
    expect(fonts).toEqual({
      sameFont: 2,
      sameFontNotEmbedded: 1,
      substituted: { 'NotoSans-Regular': 2, 'JetBrainsMono-Regular': 1 },
      fellBack: { 'NotoSerif-Bold': 1 },
      movedOutOfForm: 1,
    });
  });

  it('says per source how every text edit was typeset', () => {
    const textEdits: TextEditExportSummary = {
      edits: 7,
      fontsRenamed: 2,
      mcidsReassigned: 0,
      unreachableRemoved: 3,
      sources: [
        {
          name: 'a.pdf',
          edits: 6,
          fontsRenamed: 2,
          mcidsReassigned: 0,
          unreachableRemoved: 3,
          fonts: {
            sameFont: 1,
            sameFontNotEmbedded: 0,
            substituted: { 'NotoSans-Regular': 2, 'JetBrainsMono-Regular': 1 },
            fellBack: { 'NotoSerif-Bold': 1 },
            movedOutOfForm: 1,
          },
        },
        {
          name: 'b.pdf',
          edits: 1,
          fontsRenamed: 0,
          mcidsReassigned: 0,
          unreachableRemoved: 0,
          fonts: {
            sameFont: 1,
            sameFontNotEmbedded: 0,
            substituted: {},
            fellBack: {},
            movedOutOfForm: 0,
          },
        },
      ],
    };
    const items = summarizeReport(empty, undefined, undefined, { textEdits });
    expect(items.map((i) => i.id)).toEqual([
      'text-edits',
      'text-edit-fonts-0',
      'text-edit-fonts-1',
    ]);
    expect(items[0]?.details).toEqual(['a.pdf: 6', 'b.pdf: 1']);
    expect(items[1]).toEqual({
      id: 'text-edit-fonts-0',
      tone: 'changed',
      text:
        'a.pdf: 1 in the original font; 3 with a substituted font (JetBrains Mono: 1, Noto Sans: 2); ' +
        '1 fell back from the original font to Noto Serif Bold; 1 moved out of its form.',
    });
    expect(items[2]).toEqual({
      id: 'text-edit-fonts-1',
      tone: 'kept',
      text: 'b.pdf: 1 in the original font.',
    });
  });
});

describe('redaction self-check limits', () => {
  const redaction = (
    notSearched: readonly string[],
    areaOnlyStrings: readonly string[],
  ): RedactionExportSummary => ({
    areas: 1,
    areasByPage: { 0: 1 },
    unmappedAreas: 0,
    report: { ok: true, checks: [], notSearched, unverifiedAttachments: [] },
    areaOnlyStrings,
  });

  it('groups the streams it could not search by filter', () => {
    expect(notSearchedKind('object 12 (JBIG2Decode)')).toBe('jbig2');
    expect(notSearchedKind('object 13 (FlateDecode, CCITTFaxDecode)')).toBe('ccitt');
    expect(notSearchedKind('object 14 (JPXDecode)')).toBe('jpx');
    expect(notSearchedKind('object 15 (DCTDecode)')).toBe('dct');
    expect(notSearchedKind('object 16 (LZWDecode)')).toBe('undecodable');
    expect(notSearchedKind('object 17 (unreadable)')).toBe('undecodable');
    // With the reason the stream could not be decoded.
    expect(notSearchedKind('object 18 (FlateDecode, JPXDecode not decodable here)')).toBe('jpx');
    expect(notSearchedKind('object 19 (FlateDecode: corrupt data (incorrect header check))')).toBe(
      'undecodable',
    );

    const items = summarizeReport(empty, undefined, undefined, {
      redaction: redaction(
        [
          'object 16 (unreadable)',
          'object 12 (JBIG2Decode)',
          'object 15 (DCTDecode)',
          'object 14 (JBIG2Decode)',
          'object 13 (CCITTFaxDecode)',
          'object 18 (JPXDecode)',
        ],
        [],
      ),
    });
    expect(items.map((i) => i.id)).toEqual(['redaction', 'redaction-not-searched']);
    expect(items[1]).toEqual({
      id: 'redaction-not-searched',
      tone: 'changed',
      text:
        '6 streams could not be checked for the redacted strings, because their encoding cannot ' +
        'be searched (JBIG2 images: 2, CCITT fax images: 1, JPEG 2000 images: 1, JPEG images: 1, ' +
        'streams that could not be decoded: 1).',
      details: [
        'object 12 (JBIG2Decode)',
        'object 14 (JBIG2Decode)',
        'object 13 (CCITTFaxDecode)',
        'object 18 (JPXDecode)',
        'object 15 (DCTDecode)',
        'object 16 (unreadable)',
      ],
    });
  });

  it('lists the short strings removed inside the marked areas only', () => {
    const items = summarizeReport(empty, undefined, undefined, {
      redaction: redaction(['object 12 (JBIG2Decode)'], ['ab', '12']),
    });
    expect(items.map((i) => i.id)).toEqual([
      'redaction',
      'redaction-not-searched',
      'redaction-area-only',
    ]);
    expect(items[1]?.text).toBe(
      '1 stream could not be checked for the redacted strings, because its encoding cannot be ' +
        'searched (JBIG2 images: 1).',
    );
    expect(items[2]).toEqual({
      id: 'redaction-area-only',
      tone: 'changed',
      text:
        '2 short redacted strings (under 4 characters) were removed inside the marked areas ' +
        'only; they were not searched for elsewhere in the document.',
      details: ['“ab”', '“12”'],
    });
  });

  it('says nothing more when every stream was searched and every string checked', () => {
    const items = summarizeReport(empty, undefined, undefined, { redaction: redaction([], []) });
    expect(items.map((i) => i.id)).toEqual(['redaction']);
  });
});
