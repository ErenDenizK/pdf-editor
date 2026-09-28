/**
 * Signature statuses as the UI words them (spec recognize-and-compare §3.1, ADR-0013): the
 * five labels, the honesty line verbatim, the badge summary and state, change lines, the
 * corner placement of a visible signature, and no "valid" anywhere in the signature texts.
 */
import type { SourceDocument, SourceId } from '@pdf-editor/document-model';
import { SIGNATURE_HONESTY_LINE, type SignatureReport } from '@pdf-editor/engine';
import { afterEach, describe, expect, it } from 'vitest';

import en from '../../messages/en.json';
import { m, setLocale } from '../i18n';
import { cornerRect, unrotatedCorner } from './pdf-pass';
import { badgeText } from './SignatureBadge';
import {
  changeLine,
  hasSignedVersion,
  honestyLine,
  STATUS_SEVERITY,
  statusLabel,
  statusTone,
  summarize,
} from './status';
import { signatureStateOf } from './use-signatures';

const report = (overrides: Partial<SignatureReport> = {}): SignatureReport => ({
  fieldName: 'Approval',
  subFilter: 'ETSI.CAdES.detached',
  byteRange: [0, 10, 20, 30],
  revision: 2,
  revisionCount: 2,
  coversWholeFile: true,
  status: 'intact',
  honesty: SIGNATURE_HONESTY_LINE,
  checks: [],
  laterChanges: [],
  chain: [],
  signedAttributes: [],
  weak: false,
  weakReasons: [],
  ...overrides,
});

const source = (id: string): SourceDocument =>
  ({ id: id as SourceId, name: `${id}.pdf`, flags: { hasSignatures: true } }) as SourceDocument;

afterEach(() => {
  setLocale('en');
});

describe('status words', () => {
  it('names the five statuses (never "valid")', () => {
    expect(STATUS_SEVERITY.map(statusLabel)).toEqual([
      'Broken',
      'Changed after signing',
      'Cannot check',
      'Intact, changed later',
      'Intact',
    ]);
    expect(STATUS_SEVERITY.map(statusTone)).toEqual([
      'problem',
      'problem',
      'problem',
      'note',
      'ok',
    ]);
  });

  it('carries the engine’s honesty line verbatim in English, translated in Turkish', () => {
    expect(honestyLine()).toBe(SIGNATURE_HONESTY_LINE);
    expect(m.signature_honesty()).toBe(SIGNATURE_HONESTY_LINE);
    setLocale('tr');
    expect(honestyLine()).not.toBe(SIGNATURE_HONESTY_LINE);
    expect(statusLabel('broken')).toBe('Bozuk');
  });

  it('uses no form of the word "valid" in any signature text', () => {
    const texts = Object.entries(en as Record<string, unknown>)
      .filter(([key]) =>
        /^(signature_|sign_|export_sign|summary_signature|inspector_signatures)/.test(key),
      )
      .map(([, value]) => JSON.stringify(value));
    expect(texts.length).toBeGreaterThan(50);
    for (const text of texts) expect(text).not.toMatch(/\bvalid(ly|ated|ation)?\b/i);
  });

  it('lists later changes by revision, kind and 1-based pages', () => {
    expect(changeLine({ revision: 3, kind: 'annotations', pages: [0], objects: [] })).toBe(
      'Revision 3: annotations, page 1',
    );
    expect(changeLine({ revision: 4, kind: 'content', pages: [0, 2], objects: [] })).toBe(
      'Revision 4: page content, pages 1, 3',
    );
    expect(changeLine({ revision: 3, kind: 'metadata', pages: [], objects: [] })).toBe(
      'Revision 3: metadata',
    );
  });

  it('offers the signed version only for signatures over an earlier revision', () => {
    expect(hasSignedVersion(report())).toBe(false);
    expect(hasSignedVersion(report({ revisionCount: 3, status: 'intact-changed-later' }))).toBe(
      true,
    );
    const { revision: _r, ...noRevision } = report({ status: 'broken' });
    expect(hasSignedVersion(noRevision)).toBe(false);
  });
});

describe('badge state', () => {
  it('summarizes to the worst status and flags weak algorithms', () => {
    expect(summarize([])).toEqual({ count: 0, weak: false });
    expect(
      summarize([
        report({ status: 'intact' }),
        report({ status: 'intact-changed-later', weak: true }),
      ]),
    ).toEqual({ count: 2, status: 'intact-changed-later', weak: true });
    expect(
      summarize([report({ status: 'broken' }), report({ status: 'cannot-check' })]).status,
    ).toBe('broken');
  });

  it('maps entries to the badge: checking, the worst status, failures and edits', () => {
    const a = source('a');
    const b = source('b');
    const none = () => false;
    expect(badgeText(signatureStateOf([], {}, none))).toBeNull();
    expect(badgeText(signatureStateOf([a], {}, none))).toBe('Checking signatures…');
    const entries = {
      a: { status: 'ready' as const, reports: [report({ status: 'intact' })] },
      b: { status: 'ready' as const, reports: [report({ status: 'changed-after-signing' })] },
    };
    const state = signatureStateOf([a, b], entries, (id) => id === 'b');
    expect(badgeText(state)).toBe('Changed after signing');
    expect(state.edited).toBe(true);
    expect(signatureStateOf([a], entries, (id) => id === 'b').edited).toBe(false);
    expect(badgeText(signatureStateOf([a], { a: { status: 'failed', message: 'x' } }, none))).toBe(
      'Cannot check',
    );
    // A signed field without a value (only empty signature fields): no status word.
    expect(
      badgeText(signatureStateOf([a], { a: { status: 'ready', reports: [] } }, none)),
    ).toBeNull();
  });
});

describe('visible signature placement', () => {
  const box = { x: 0, y: 0, width: 612, height: 792 };

  it('puts the box at the displayed corner on unrotated pages', () => {
    expect(cornerRect(box, 0, 'bottom-right')).toEqual({ x: 376, y: 36, width: 200, height: 50 });
    expect(cornerRect(box, 0, 'top-left')).toEqual({ x: 36, y: 706, width: 200, height: 50 });
    expect(cornerRect({ x: 10, y: 20, width: 612, height: 792 }, 0, 'bottom-left')).toEqual({
      x: 46,
      y: 56,
      width: 200,
      height: 50,
    });
  });

  it('maps displayed corners through /Rotate (viewers turn pages clockwise)', () => {
    // Rotate 90: the displayed bottom right is the unrotated top right, the box turned.
    expect(unrotatedCorner('bottom-right', 90)).toEqual(['max', 'max']);
    expect(unrotatedCorner('top-left', 90)).toEqual(['min', 'min']);
    expect(unrotatedCorner('bottom-right', 180)).toEqual(['min', 'max']);
    expect(unrotatedCorner('bottom-right', 270)).toEqual(['min', 'min']);
    expect(cornerRect(box, 90, 'bottom-right')).toEqual({ x: 526, y: 556, width: 50, height: 200 });
  });

  it('shrinks the box on small pages', () => {
    const small = cornerRect({ x: 0, y: 0, width: 100, height: 60 }, 0, 'bottom-right');
    expect(small.width).toBeLessThanOrEqual(100);
    expect(small.x).toBeGreaterThanOrEqual(0);
    expect(small.y).toBeGreaterThanOrEqual(0);
  });
});
