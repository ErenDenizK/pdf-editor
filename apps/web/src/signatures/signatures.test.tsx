/**
 * Signatures in the app (spec recognize-and-compare §3, ADR-0013) against the real engines:
 * validation on open through the engine service and the signature worker, the Inspector
 * section's statuses for every signed fixture, "View signed version", the full rewrite of an
 * edited signed source (no signatures left), signing as the last export step, the refusals,
 * and the shared worker's idle termination.
 */
import { getActiveDocument, type SourceId } from '@pdf-editor/document-model';
import {
  PKCS12_REEXPORT_COMMAND,
  type SignatureProxy,
  SigningError,
  validateSignatures,
} from '@pdf-editor/engine';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands } from 'vitest/browser';

import approvalUrl from '../../../../test/fixtures/signed-approval.pdf?url';
import emptyFieldUrl from '../../../../test/fixtures/signed-empty-field.pdf?url';
import sha1Url from '../../../../test/fixtures/signed-sha1.pdf?url';
import tamperedUrl from '../../../../test/fixtures/signed-tampered.pdf?url';
import changedUrl from '../../../../test/fixtures/signed-then-changed.pdf?url';
import modifiedUrl from '../../../../test/fixtures/signed-then-modified.pdf?url';
import twiceUrl from '../../../../test/fixtures/signed-twice.pdf?url';
import simpleUrl from '../../../../test/fixtures/simple-text.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { createAnnotations } from '../annotations/actions';
import { resetAnnotationStore } from '../annotations/annotation-store';
import { resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { getSignatureWorkers, SignatureWorkerHost } from '../engine/engine-service';
import { prepareExport } from '../export/export-service';
import { summarizeReport } from '../export/summary';
import { m } from '../i18n';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { stripSignatures } from './pdf-pass';
import { setSignatureDependencies, startSignatureValidation } from './signature-store';
import { SignaturesSection } from './SignaturesSection';
import { checkIdentity, type SignDraft, signingFailureText, signingReason } from './signing';

const model = () => useWorkspaceStore.getState();
const PASSWORD = 'test-only';
/**
 * The test PKI's .p12 files (Vite 8 refuses to serve *.p12, so they are read through the
 * browser command, relative to the project root).
 */
async function p12(name: string): Promise<ArrayBuffer> {
  const b64 = await commands.readFile(`../../test/fixtures/pki/${name}`, 'base64');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
const rsaP12 = () => p12('signer-rsa.p12');
const fetchPdf = async (url: string) => (await fetch(url)).arrayBuffer();
const legacyP12 = () => p12('signer-rsa-legacy-3des.p12');

let stop: (() => void) | undefined;

beforeEach(() => {
  resetWorkspace();
  resetEditRunner();
  resetAnnotationStore();
  setSignatureDependencies(undefined);
  stop = startSignatureValidation();
});
afterEach(async () => {
  await whenIdle();
  stop?.();
  resetWorkspace();
  setSignatureDependencies(undefined);
});
afterAll(() => {
  getSignatureWorkers().terminate();
});

async function openFixture(url: string, name: string) {
  const report = await model().openFiles([await fixtureFile(url, name)]);
  expect(report.skipped).toEqual([]);
  const doc = getActiveDocument(model().workspace);
  const first = doc?.pages[0];
  if (!doc || first?.ref.kind !== 'source') throw new Error(`${name} did not open`);
  return { doc, source: first.ref.source };
}

async function shownStatuses(): Promise<string[]> {
  const statuses = await screen.findAllByTestId('signature-status', {}, { timeout: 20_000 });
  return statuses.map((node) => node.textContent);
}

describe('validation on open', () => {
  const cases: readonly (readonly [string, string, readonly string[]])[] = [
    ['signed-approval.pdf', approvalUrl, ['Intact']],
    ['signed-then-modified.pdf', modifiedUrl, ['Intact, changed later']],
    ['signed-then-changed.pdf', changedUrl, ['Changed after signing']],
    ['signed-tampered.pdf', tamperedUrl, ['Broken']],
    ['signed-twice.pdf', twiceUrl, ['Intact, changed later', 'Intact']],
    ['signed-sha1.pdf', sha1Url, ['Intact']],
    ['signed-empty-field.pdf', emptyFieldUrl, ['Intact']],
  ];

  for (const [name, url, expected] of cases) {
    it(`${name}: ${expected.join(', ')}`, async () => {
      await openFixture(url, name);
      render(<SignaturesSection />);
      expect(await shownStatuses()).toEqual(expected);
      const cards = screen.getAllByTestId('signature-card');
      for (const card of cards) {
        expect(within(card).getByTestId('signature-honesty')).toHaveTextContent(
          'Checked on this device against the certificates in the file. Signer identity, trust and revocation are not verified.',
        );
        expect(card.textContent).not.toMatch(/\bvalid\b/i);
      }
      if (name === 'signed-sha1.pdf') {
        expect(screen.getByTestId('signature-weak').textContent).toMatch(/Weak algorithm: .*SHA-1/);
      } else {
        expect(screen.queryByTestId('signature-weak')).toBeNull();
      }
      if (name === 'signed-then-modified.pdf') {
        expect(screen.getByTestId('signature-changes')).toHaveTextContent(
          'Revision 3: annotations, page 1',
        );
        expect(screen.getByText(/\(claimed by the signer\)/)).toBeVisible();
        expect(screen.getByText('pdf-editor Test Signer')).toBeVisible();
      }
      if (name === 'signed-then-changed.pdf') {
        expect(screen.getByTestId('signature-changes').textContent).toMatch(/page content, page 1/);
      }
      // Unedited: the plain statement about export.
      expect(screen.getByTestId('signature-export-notice')).toHaveTextContent(
        m.signature_export_notice(),
      );
    });
  }

  it('does not check unsigned files', async () => {
    await openFixture(simpleUrl, 'simple-text.pdf');
    render(<SignaturesSection />);
    expect(screen.queryByTestId('signatures-section')).toBeNull();
  });

  it('"View signed version" opens revision 2 as a new document that is Intact', async () => {
    await openFixture(modifiedUrl, 'signed-then-modified.pdf');
    render(<SignaturesSection />);
    await shownStatuses();
    screen.getByRole('button', { name: 'View signed version' }).click();
    await waitFor(() => expect(model().workspace.documentOrder).toHaveLength(2), {
      timeout: 20_000,
    });
    const view = getActiveDocument(model().workspace);
    expect(view?.title).toBe('signed-then-modified (signed version, revision 2)');
    expect(
      await screen.findByTestId('signed-version-notice', {}, { timeout: 20_000 }),
    ).toHaveTextContent('Signed version (revision 2) of signed-then-modified.pdf');
    await waitFor(async () => expect(await shownStatuses()).toEqual(['Intact']), {
      timeout: 20_000,
    });
  });
});

describe('export and signatures', () => {
  it('an edited signed source exports as a full rewrite without signatures', async () => {
    const { doc, source } = await openFixture(modifiedUrl, 'signed-then-modified.pdf');
    render(<SignaturesSection />);
    await shownStatuses();
    const page = doc.pages[0];
    if (!page) throw new Error('no page');
    await createAnnotations({ source, pageIndex: 0, pageId: page.id, position: 1 }, [
      {
        kind: 'free-text',
        pageIndex: 0,
        rect: { x: 72, y: 500, width: 200, height: 20 },
        text: 'Edited after signing',
        fontSize: 12,
        textColor: '#000000',
      },
    ]);
    // The plain statement: the rewrite removes the signatures.
    await waitFor(() =>
      expect(screen.getByTestId('signature-export-notice')).toHaveTextContent(
        m.signature_export_notice_edited(),
      ),
    );
    const prepared = await prepareExport(doc.id, { compression: null });
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.verification).toEqual({ ok: true, problems: [] });
    expect(prepared.value.signaturesRemoved).toEqual({
      files: ['signed-then-modified.pdf'],
      count: 1,
    });
    expect(await validateSignatures(prepared.value.bytes.slice(0))).toEqual([]);
    const items = summarizeReport(prepared.value.report, prepared.value.sourceNotes, undefined, {
      ...(prepared.value.signaturesRemoved
        ? { signaturesRemoved: prepared.value.signaturesRemoved }
        : {}),
    });
    expect(items.find((item) => item.id === 'signatures-removed')?.text).toBe(
      '1 existing signature was removed: the exported file is new and cannot keep it.',
    );
  });

  it('stripSignatures removes every signature value (signed-twice: two), unsigned files untouched', async () => {
    const twice = await fetchPdf(twiceUrl);
    expect((await validateSignatures(twice.slice(0))).length).toBe(2);
    const stripped = await stripSignatures(twice);
    expect(stripped.removed).toBe(2);
    expect(await validateSignatures(stripped.bytes.slice(0))).toEqual([]);
    const simple = await fetchPdf(simpleUrl);
    const same = await stripSignatures(simple);
    expect(same).toEqual({ bytes: simple, removed: 0 });
  });

  it('signs the verified export as its last step (invisible and visible)', async () => {
    const { doc } = await openFixture(simpleUrl, 'simple-text.pdf');
    const pkcs12 = await rsaP12();
    const signer = await checkIdentity(pkcs12, PASSWORD);
    expect(signer.commonName).toBe('pdf-editor Test Signer');
    // The check works on a copy: the bytes are still ours.
    expect(pkcs12.byteLength).toBeGreaterThan(0);
    const draft: SignDraft = {
      pkcs12,
      fileName: 'signer-rsa.p12',
      password: PASSWORD,
      reason: 'Approved',
      signer,
    };
    const phases: string[] = [];
    const prepared = await prepareExport(doc.id, {
      compression: null,
      sign: draft,
      onProgress: (p) => phases.push(p.phase),
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(phases.at(-1)).toBe('signing');
    expect(prepared.value.verification.ok).toBe(true);
    expect(prepared.value.signature).toMatchObject({
      signer: 'pdf-editor Test Signer',
      algorithm: 'RSASSA-PKCS1-v1_5 with SHA-256',
      fieldName: 'Signature1',
    });
    const reports = await validateSignatures(prepared.value.bytes.slice(0));
    expect(reports.map((r) => [r.status, r.reason, r.coversWholeFile])).toEqual([
      ['intact', 'Approved', true],
    ]);
    const items = summarizeReport(prepared.value.report, prepared.value.sourceNotes, undefined, {
      ...(prepared.value.signature ? { signature: prepared.value.signature } : {}),
    });
    expect(items.find((item) => item.id === 'signature')?.text).toBe(
      'Signed by pdf-editor Test Signer (RSASSA-PKCS1-v1_5 with SHA-256), field “Signature1”: approval signature; identity and trust not verified.',
    );

    const visible = await prepareExport(doc.id, {
      compression: null,
      sign: { ...draft, visible: { pageIndex: 1, corner: 'bottom-right' } },
    });
    if (!visible.ok) throw new Error(visible.error.message);
    const [report] = await validateSignatures(visible.value.bytes.slice(0));
    expect(report?.status).toBe('intact');
    expect(report?.pageIndex).toBe(1);
    expect(report?.rect).toMatchObject({ width: 200, height: 50 });
  });

  it('refuses to sign an encrypted output, before any work', async () => {
    const { doc } = await openFixture(simpleUrl, 'simple-text.pdf');
    const pkcs12 = await rsaP12();
    const signer = await checkIdentity(pkcs12, PASSWORD);
    model().applyOperation(
      (ws) => ({
        ...ws,
        documents: {
          ...ws.documents,
          [doc.id]: {
            ...doc,
            security: {
              userPassword: 'open',
              ownerPassword: 'owner',
              permissions: {
                print: true,
                printHighQuality: true,
                modify: true,
                copy: true,
                annotate: true,
                fillForms: true,
                extract: true,
                assemble: true,
              },
            },
          },
        },
      }),
      'Set password',
    );
    const result = await prepareExport(doc.id, {
      compression: null,
      sign: { pkcs12, fileName: 'signer-rsa.p12', password: PASSWORD, signer },
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal', message: m.sign_refused_encrypted() },
    });
  });

  it('refuses a legacy 3DES .p12 with the re-export command, and a wrong password', async () => {
    const legacy = await checkIdentity(await legacyP12(), PASSWORD).catch((e: unknown) => e);
    expect(legacy).toBeInstanceOf(SigningError);
    expect(signingReason(legacy)).toBe('legacy-pkcs12');
    expect(signingFailureText(legacy)).toBe(m.sign_refused_legacy());
    expect(PKCS12_REEXPORT_COMMAND).toContain('-keypbe AES-256-CBC');
    const wrong = await checkIdentity(await rsaP12(), 'nope').catch((e: unknown) => e);
    expect(signingReason(wrong)).toBe('bad-password');
    expect(signingFailureText(wrong)).toBe(
      'The password is wrong, or the certificate file is damaged.',
    );
  });
});

describe('SignatureWorkerHost', () => {
  it('keeps one worker for calls and terminates it when idle', async () => {
    const terminated: number[] = [];
    let created = 0;
    const host = new SignatureWorkerHost(() => {
      const id = ++created;
      return Promise.resolve({
        terminate: () => terminated.push(id),
      } as unknown as SignatureProxy);
    }, 30);
    await host.run(() => Promise.resolve(1));
    await host.run(() => Promise.resolve(2));
    expect(created).toBe(1);
    expect(host.alive).toBe(true);
    await vi.waitFor(() => expect(terminated).toEqual([1]));
    expect(host.alive).toBe(false);
    await host.run(() => Promise.resolve(3));
    expect(created).toBe(2);
    // A dedicated worker is new every time and left to the caller.
    await host.dedicated();
    expect(created).toBe(3);
    host.terminate();
    await vi.waitFor(() => expect(terminated).toEqual([1, 2]));
  });

  it('does not terminate while a call is running', async () => {
    const terminated: number[] = [];
    const host = new SignatureWorkerHost(
      () => Promise.resolve({ terminate: () => terminated.push(1) } as unknown as SignatureProxy),
      10,
    );
    let finish!: () => void;
    const running = host.run(() => new Promise<void>((resolve) => (finish = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(terminated).toEqual([]);
    finish();
    await running;
    await vi.waitFor(() => expect(terminated).toEqual([1]));
  });
});

// Source ids are branded strings; keep the import used for type checks in helpers.
export type { SourceId };
