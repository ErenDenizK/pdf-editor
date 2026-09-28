/**
 * Export hooks (part b, deliverable 4): `planExport` flags sources with applied redactions
 * and maps their plans to output pages, and `verifyRedactedOutput` checks the exact final
 * bytes (after assembly, and after encryption) against every plan.
 */

import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import {
  addSource,
  createSequentialIdGenerator,
  createWorkspace,
  type EngineEdit,
  type SecurityPolicy,
  type SourceId,
  type VirtualPage,
  type Workspace,
} from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import textRunsUrl from '../../../../test/fixtures/redact-text-runs.pdf?url';
import { vpage } from '../../test/helpers';
import { planExport } from '../export-plan';
import { createHostedEngine, type HostedEngine } from '../pdfium/host';
import { PdfiumAdapter } from '../pdfium/pdfium-adapter';
import { PdfLibAssembler } from '../pdflib/pdflib-assembler';
import type { ApplyRedactionsResult, RedactionPlan } from '../types';
import { applyRedactions } from './apply';
import { withForensicDeps } from './engine-session';
import { redactionExportPlan, redactionPlanOf } from './export-hooks';
import { verifyRedactedOutput } from './verify-output';

const S = 'redacted-src' as SourceId;
const rect = (x: number, y: number) => ({ x, y, width: 94.58, height: 17.85 });
const PLAN: RedactionPlan = {
  areas: [
    { pageIndex: 0, rect: rect(163.61, 675.7) },
    { pageIndex: 0, rect: rect(165.93, 635.7) },
    { pageIndex: 0, rect: rect(168.27, 595.7) },
  ],
  strings: [],
  fillColor: '#1a237e',
};
const POLICY: SecurityPolicy = {
  algorithm: 'aes-256',
  userPassword: 'redacted-pw',
  permissions: {
    print: true,
    printHighQuality: true,
    modify: true,
    copy: true,
    annotate: true,
    fillForms: true,
    accessibility: true,
    assemble: true,
  },
};

let host: HostedEngine;
let applied: ApplyRedactionsResult;
let original: ArrayBuffer;
let ws: Workspace;
let documentId: string;

beforeAll(async () => {
  host = await createHostedEngine({ wasm: wasmUrl });
  original = await (await fetch(textRunsUrl)).arrayBuffer();
  applied = await applyRedactions(host, original, PLAN);
  const adapter = new PdfiumAdapter({ wasmUrl, engineFactory: () => host.engine });
  const opened = await adapter.open(S, applied.bytes.slice(0));
  await adapter.close(S);
  const added = addSource(
    createWorkspace(),
    { ...opened, name: 'redacted.pdf', byteLength: applied.bytes.byteLength },
    createSequentialIdGenerator('r'),
    { sourceId: S },
  );
  documentId = added.documentId;
  const edit: EngineEdit = {
    id: 'apply-1',
    source: S,
    pageIndex: 0,
    kind: 'redaction.apply',
    payload: { plan: applied.plan },
  };
  const doc = added.workspace.documents[added.documentId]!;
  const ref = { kind: 'source', source: S, index: 0 } as const;
  // The page twice: as is, and rotated (areas stay in unrotated user space).
  const pages: VirtualPage[] = [vpage(ref), vpage(ref, { rotation: 90 })];
  ws = {
    ...added.workspace,
    documents: { ...added.workspace.documents, [added.documentId]: { ...doc, pages } },
    engineEdits: [edit],
  };
});
afterAll(async () => {
  await host.engine.destroy?.().toPromise();
});

async function assemble(sourceBytes: ArrayBuffer, security?: SecurityPolicy) {
  const plan = planExport(ws, documentId as never, security ? { security } : {});
  const { bytes } = await new PdfLibAssembler().assemble(
    { document: plan.document, sources: new Map([[S, sourceBytes.slice(0)]]), blobs: new Map() },
    security ? { security } : {},
  );
  return { plan, bytes };
}

async function verify(bytes: ArrayBuffer, plans: readonly RedactionPlan[], password?: string) {
  const options = password === undefined ? {} : { password };
  return withForensicDeps(
    host,
    bytes,
    (deps) => verifyRedactedOutput(bytes, plans, deps, options),
    options,
  );
}

describe('export plan', () => {
  test('flags the redacted source and maps its areas to every output page using it', () => {
    const plan = planExport(ws, documentId as never);
    console.warn(
      'DBG',
      JSON.stringify(ws.engineEdits).slice(0, 300),
      JSON.stringify(ws.documents[documentId as never]?.pages.map((p) => p.ref)),
      JSON.stringify(Object.keys(plan)),
    );
    expect(plan.redaction?.sources).toEqual([S]);
    expect(plan.redaction?.unmappedAreas).toBe(0);
    const [mapped] = plan.redaction?.plans ?? [];
    expect(mapped?.areas.map((a) => a.pageIndex)).toEqual([0, 0, 0, 1, 1, 1]);
    expect(mapped?.strings).toEqual(['SECRET-7731']); // captured at apply
    expect(mapped?.fillColor).toBe('#1a237e');
    const clean = { ...ws, engineEdits: [] };
    expect(planExport(clean, documentId as never).redaction).toBeUndefined();
  });

  test('areas on a resized page are not mapped but counted', () => {
    const doc = ws.documents[documentId as never]!;
    const resized = {
      ...doc.pages[1]!,
      resize: { width: 300, height: 300 },
    } as unknown as VirtualPage;
    const hooks = redactionExportPlan(ws, { ...doc, pages: [doc.pages[0]!, resized] });
    expect(hooks?.plans[0]?.areas).toHaveLength(3);
    expect(hooks?.unmappedAreas).toBe(3);
  });

  test('only well-formed redaction.apply payloads count', () => {
    const edit = (kind: EngineEdit['kind'], payload: unknown): EngineEdit => ({
      id: 'x',
      source: S,
      pageIndex: 0,
      kind,
      payload,
    });
    expect(redactionPlanOf(edit('redaction.apply', { plan: PLAN }))).toBe(PLAN);
    expect(redactionPlanOf(edit('redaction.mark', { plan: PLAN }))).toBeUndefined();
    expect(
      redactionPlanOf(
        edit('redaction.apply', { plan: { areas: [{ pageIndex: 0 }], strings: [] } }),
      ),
    ).toBeUndefined();
    expect(redactionPlanOf(edit('redaction.apply', null))).toBeUndefined();
  });
});

describe('verifyRedactedOutput on the exact final bytes', () => {
  test('the assembled export of the redacted source passes', async () => {
    const { plan, bytes } = await assemble(applied.bytes);
    const report = await verify(bytes, plan.redaction?.plans ?? []);
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.checks).toHaveLength(9);
  });

  test('and so does the encrypted export, opened with its password', async () => {
    const { plan, bytes } = await assemble(applied.bytes, POLICY);
    const report = await verify(bytes, plan.redaction?.plans ?? [], POLICY.userPassword);
    expect(report.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual([]);
  });

  test('an export built from the original bytes (passthrough) is caught', async () => {
    const { plan, bytes } = await assemble(original);
    const report = await verify(bytes, plan.redaction?.plans ?? []);
    expect(report.ok).toBe(false);
    const failing = report.checks.filter((c) => !c.passed).map((c) => c.id);
    for (const id of ['no-text-in-areas', 'no-search-hits', 'byte-grep', 'fill-pixels'] as const) {
      expect(failing).toContain(id);
    }
    // Findings of both output pages are merged into one report.
    const pages = report.checks
      .find((c) => c.id === 'fill-pixels')
      ?.findings.map((f) => f.pageIndex);
    expect(new Set(pages)).toEqual(new Set([0, 1]));
  });
});
