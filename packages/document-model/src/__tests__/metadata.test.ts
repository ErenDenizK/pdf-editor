import { describe, expect, it } from 'vitest';

import {
  ALL_PERMISSIONS,
  customKeyProblem,
  isLanguageTag,
  removePassword,
  STRIP_ALL,
  setMetadata,
  setMetadataStrip,
  setSecurity,
} from '../metadata';
import { deserializeWorkspace, serializeWorkspace } from '../serialize';
import { getDocument } from '../selectors';
import { addSource } from '../workspace';
import type { Workspace } from '../types';
import { check, expectCode, must, open, sourceInput } from './fixtures';

const policy = {
  algorithm: 'aes-256' as const,
  userPassword: 'open sesame',
  permissions: { ...ALL_PERMISSIONS, copy: false },
};

describe('setMetadata', () => {
  it('sets, trims and removes fields and switches the policy to explicit', () => {
    const { ws, docs } = open(['A', 1]);
    const doc = must(docs[0]);
    const next = check(setMetadata(ws, doc, { title: '  New title ', author: null }));
    const meta = getDocument(next, doc).metadata;
    expect(meta.title).toBe('New title');
    expect(meta.author).toBeUndefined();
    expect(getDocument(next, doc).clean).toBe(false);
  });

  it('turns an inherited policy into an explicit one on the first edit', () => {
    const input = { ...sourceInput('A', 1), metadata: { policy: 'inherit-first-source' as const } };
    const added = addSource(open().ws, input, open().ids);
    expect(getDocument(added.workspace, added.documentId).metadata.policy).toBe(
      'inherit-first-source',
    );
    const next = setMetadata(added.workspace, added.documentId, { subject: 'S' });
    expect(getDocument(next, added.documentId).metadata).toMatchObject({
      subject: 'S',
      policy: 'explicit',
    });
  });

  it('returns the same workspace when nothing changes', () => {
    const { ws, docs } = open(['A', 1]);
    const doc = must(docs[0]);
    expect(setMetadata(ws, doc, { title: 'A title' })).toBe(ws);
    expect(setMetadata(ws, doc, {})).toBe(ws);
    expect(setMetadata(ws, doc, { keywords: '' })).toBe(ws);
  });

  it('validates language tags and custom keys', () => {
    const { ws, docs } = open(['A', 1]);
    const doc = must(docs[0]);
    expect(getDocument(setMetadata(ws, doc, { language: 'tr-TR' }), doc).metadata.language).toBe(
      'tr-TR',
    );
    expectCode(() => setMetadata(ws, doc, { language: 'not a tag' }), 'invalid-argument');
    expectCode(() => setMetadata(ws, doc, { custom: { 'bad key': 'x' } }), 'invalid-argument');
    expectCode(() => setMetadata(ws, doc, { custom: { Title: 'x' } }), 'invalid-argument');
    const custom = setMetadata(ws, doc, { custom: { Department: 'Legal', 'Case.No': '42' } });
    expect(getDocument(custom, doc).metadata.custom).toEqual({
      Department: 'Legal',
      'Case.No': '42',
    });
    expect(setMetadata(custom, doc, { custom: { Department: 'Legal', 'Case.No': '42' } })).toBe(
      custom,
    );
    expect(getDocument(setMetadata(custom, doc, { custom: {} }), doc).metadata.custom).toBe(
      undefined,
    );
  });

  it('language tag and key helpers', () => {
    for (const tag of ['en', 'en-US', 'zh-Hant-TW', 'x-private', 'sr-Latn']) {
      expect(isLanguageTag(tag), tag).toBe(true);
    }
    for (const tag of ['', 'e', 'en_US', 'en-', 'en-toolongsubtag']) {
      expect(isLanguageTag(tag), tag).toBe(false);
    }
    expect(customKeyProblem('')).toBe('empty');
    expect(customKeyProblem('9lives')).toBe('invalid');
    expect(customKeyProblem('producer')).toBe('reserved');
    expect(customKeyProblem('xmlThing')).toBe('reserved');
    expect(customKeyProblem('Dept', ['dept'])).toBe('duplicate');
    expect(customKeyProblem('a'.repeat(65))).toBe('too-long');
    expect(customKeyProblem('Project_ID')).toBeUndefined();
  });
});

describe('setMetadataStrip', () => {
  it('stores the selection, clears Info fields and custom keys, keeps /Lang', () => {
    const { ws, docs } = open(['A', 1]);
    const doc = must(docs[0]);
    const prepared = setMetadata(ws, doc, { language: 'en', custom: { Dept: 'x' } });
    const stripped = check(setMetadataStrip(prepared, doc, STRIP_ALL));
    const meta = getDocument(stripped, doc).metadata;
    expect(meta).toEqual({ language: 'en', policy: 'explicit', strip: STRIP_ALL });
    expect(setMetadataStrip(stripped, doc, STRIP_ALL)).toBe(stripped);
    const cleared = setMetadataStrip(stripped, doc, undefined);
    expect(getDocument(cleared, doc).metadata.strip).toBeUndefined();
  });

  it('keeps Info fields when only attachments are stripped', () => {
    const { ws, docs } = open(['A', 1]);
    const doc = must(docs[0]);
    const strip = { ...STRIP_ALL, info: false, customKeys: false, xmp: false };
    const meta = getDocument(setMetadataStrip(ws, doc, strip), doc).metadata;
    expect(meta.title).toBe('A title');
    expect(meta.strip?.attachments).toBe(true);
  });
});

describe('security', () => {
  it('sets, replaces and clears a policy', () => {
    const { ws, docs } = open(['A', 1]);
    const doc = must(docs[0]);
    const secured = check(setSecurity(ws, doc, policy));
    expect(getDocument(secured, doc).security).toEqual(policy);
    expect(setSecurity(secured, doc, { ...policy })).toBe(secured);
    expect(getDocument(setSecurity(secured, doc, undefined), doc).security).toBeUndefined();
    expectCode(
      () => setSecurity(ws, doc, { ...policy, userPassword: '', ownerPassword: '' }),
      'invalid-argument',
    );
  });

  it('removePassword marks encrypted sources as deliberately unprotected', () => {
    const base = open().ws;
    const input = {
      ...sourceInput('Locked', 1),
      flags: { ...sourceInput('Locked', 1).flags, encrypted: true, passwordProtected: true },
    };
    const { ids } = open();
    const added = addSource(base, input, ids);
    const doc = added.documentId;
    const removed = check(removePassword(added.workspace, doc));
    expect(getDocument(removed, doc).passwordRemoved).toBe(true);
    expect(removePassword(removed, doc)).toBe(removed);
    const reset = setSecurity(removed, doc, policy);
    expect(getDocument(reset, doc).passwordRemoved).toBeUndefined();
    // Without encrypted sources or a policy there is nothing to remove.
    const plain = open(['A', 1]);
    expect(removePassword(plain.ws, must(plain.docs[0]))).toBe(plain.ws);
  });

  it('round-trips the new fields through serialization', () => {
    const { ids } = open();
    const input = {
      ...sourceInput('Locked', 1),
      flags: {
        ...sourceInput('Locked', 1).flags,
        encrypted: true,
        passwordProtected: false,
        securityHandler: 'aes-256' as const,
        permissions: { ...ALL_PERMISSIONS, modify: false },
      },
    };
    const added = addSource(open().ws, input, ids);
    let ws: Workspace = setMetadata(added.workspace, added.documentId, { custom: { K: 'v' } });
    ws = setMetadataStrip(ws, added.documentId, { ...STRIP_ALL, customKeys: false });
    ws = removePassword(ws, added.documentId);
    const restored = deserializeWorkspace(JSON.stringify(serializeWorkspace(ws)));
    expect(restored).toEqual(ws);
  });
});
