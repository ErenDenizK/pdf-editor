/**
 * Redaction across the PDFium worker (ADR-0011 §3, `PdfRedactor` on `PdfiumProxy`): the
 * apply replaces the open source with the verified bytes (transferred to the caller too),
 * a `RedactionFailedError` keeps its stage and reports across the boundary and leaves the
 * open document as it was, and `verifyRedactedOutput` checks bytes in the worker.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import metadataUrl from '../../../test/fixtures/redact-metadata.pdf?url';
import textRunsUrl from '../../../test/fixtures/redact-text-runs.pdf?url';
import { PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import { RedactionFailedError } from '../src/redaction/apply';
import type { RedactionPlan } from '../src/types';
import { createPdfiumProxy, type PdfiumProxy } from '../src/worker/pdfium-proxy';
import { sid, wasmUrl } from './helpers';

const TOKEN = 'SECRET-7731';
/** Line 1 of redact-text-runs.pdf (test/fixtures/README.md, `tj-single` area). */
const LINE1: RedactionPlan = {
  areas: [{ pageIndex: 0, rect: { x: 163.61, y: 675.7, width: 94.58, height: 17.85 } }],
  strings: [],
};

async function fixture(url: string): Promise<ArrayBuffer> {
  return (await fetch(url)).arrayBuffer();
}

async function pageText(engine: PdfiumProxy, id: string): Promise<string[]> {
  return (await engine.getPageText(sid(id), 0)).map((r) => r.text);
}

let engine: PdfiumProxy;

beforeAll(() => {
  const worker = new Worker(new URL('../src/worker/pdfium.worker.ts', import.meta.url), {
    type: 'module',
    name: 'pdfium redaction test',
  });
  engine = createPdfiumProxy(worker, { wasmUrl, inspector: new PdfLibAssembler() });
});

afterAll(async () => {
  await engine.destroy();
});

describe('PdfiumProxy redaction', () => {
  test('applyRedactionPlan replaces the open source and transfers the verified bytes', async () => {
    await engine.open(sid('r-apply'), await fixture(textRunsUrl));
    expect((await pageText(engine, 'r-apply')).join('\n')).toContain(`Line 1, one Tj: ${TOKEN}`);

    const result = await engine.applyRedactionPlan(sid('r-apply'), LINE1, {
      captureStrings: false,
    });
    expect(result.bytes).toBeInstanceOf(ArrayBuffer);
    expect(result.bytes.byteLength).toBeGreaterThan(500);
    expect(result.forensic.ok).toBe(true);
    expect(result.forensic.checks).toHaveLength(9);
    expect(result.gate.ok).toBe(true);
    expect(result.engine.areas).toBe(1);
    expect(result.plan.areas).toEqual(LINE1.areas);
    // Area only: the token elsewhere is not a redacted string.
    expect(result.plan.strings).toEqual([]);

    // The open document is the redacted one now, under the same id.
    const lines = await pageText(engine, 'r-apply');
    expect(lines.find((l) => l.startsWith('Line 1'))).not.toContain(TOKEN);
    expect(lines.find((l) => l.startsWith('Line 1'))).toContain('stays');
    expect(lines.join('\n')).toContain('The quick brown fox');
    // Lines 2 and 3 still hold the token: only the area was redacted.
    expect((await engine.search(sid('r-apply'), TOKEN)).length).toBe(2);
    const saved = await engine.save(sid('r-apply'));
    expect(saved.byteLength).toBeGreaterThan(500);

    // The export check runs in the worker on bytes the caller keeps.
    const copy = result.bytes.slice(0);
    const report = await engine.verifyRedactedOutput(copy, [result.plan]);
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
    expect(copy.byteLength).toBe(result.bytes.byteLength);
    // The original bytes do not pass the same plan.
    const original = await engine.verifyRedactedOutput(await fixture(textRunsUrl), [
      { ...result.plan, strings: [TOKEN] },
    ]);
    expect(original.ok).toBe(false);
    expect(original.checks.filter((c) => !c.passed).map((c) => c.id)).toContain('no-text-in-areas');
    await engine.close(sid('r-apply'));
  });

  test('captured strings are searched document-wide: an unmarked copy stops the apply', async () => {
    await engine.open(sid('r-capture'), await fixture(textRunsUrl));
    // Only line 1 marked, capture on: lines 2 and 3 still show the token.
    const error = await engine.applyRedactionPlan(sid('r-capture'), LINE1).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RedactionFailedError);
    const failed = error as RedactionFailedError;
    expect(failed.stage).toBe('forensic');
    expect(failed.failure.captured.strings).toEqual([TOKEN]);
    const hits = failed.failure.forensic?.checks.find((c) => c.id === 'no-search-hits');
    expect(hits?.passed).toBe(false);
    expect(hits?.findings.map((f) => f.pageIndex)).toEqual([0, 0]);

    // Every occurrence marked: the apply passes and the plan carries the string.
    const all = await engine.applyRedactionPlan(sid('r-capture'), {
      strings: [],
      areas: [
        LINE1.areas[0]!,
        { pageIndex: 0, rect: { x: 165.93, y: 635.7, width: 94.86, height: 17.85 } },
        { pageIndex: 0, rect: { x: 168.27, y: 595.7, width: 94.58, height: 17.85 } },
      ],
    });
    expect(all.plan.strings).toEqual([TOKEN]);
    expect(all.forensic.ok).toBe(true);
    expect(await engine.search(sid('r-capture'), TOKEN)).toEqual([]);
    await engine.close(sid('r-capture'));
  });

  test('a RedactionFailedError keeps its stage and reports; the source is unchanged', async () => {
    await engine.open(sid('r-fail'), await fixture(metadataUrl));
    const plan: RedactionPlan = {
      areas: [{ pageIndex: 0, rect: { x: 193.96, y: 675.7, width: 94.58, height: 17.85 } }],
      strings: [],
      keepAttachments: true,
    };
    const error = await engine.applyRedactionPlan(sid('r-fail'), plan).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RedactionFailedError);
    const failed = error as RedactionFailedError;
    expect(failed.stage).toBe('forensic');
    expect(failed.code).toBe('internal');
    expect(failed.failure.plan.keepAttachments).toBe(true);
    expect(failed.failure.captured.strings).toEqual([TOKEN]);
    expect(failed.failure.redaction?.attachments.unverified).toEqual(['notes.txt']);
    const failing = failed.failure.forensic?.checks.filter((c) => !c.passed).map((c) => c.id);
    expect(failing).toEqual(['object-strings', 'byte-grep']);
    expect(failed.failure.forensic?.unverifiedAttachments).toEqual(['notes.txt']);
    // Nothing was replaced: the token is still on the page.
    expect((await pageText(engine, 'r-fail')).join('\n')).toContain(TOKEN);
    await engine.close(sid('r-fail'));
  });
});
