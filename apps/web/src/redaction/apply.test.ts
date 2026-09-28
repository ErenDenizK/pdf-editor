/**
 * Applying redactions through the real engine (Vitest browser mode, the PDFium worker) on
 * `redact-text-runs.pdf` (SECRET-7731 on lines 1–3): the ticked marks become one
 * `redaction.apply` edit and one history entry, the page text loses the token, unticked
 * marks stay marks, undo reopens and replays (the mark and the text come back), redo applies
 * again; a self-check failure leaves the document and the history as they were; the export
 * reads the redacted source and passes the self-check on its final bytes.
 */
import {
  getActiveDocument,
  historyEntries,
  type PageId,
  type SourceId,
} from '@pdf-editor/document-model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import metadataUrl from '../../../../test/fixtures/redact-metadata.pdf?url';
import redactUrl from '../../../../test/fixtures/redact-text-runs.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { deleteAnnotations } from '../annotations/actions';
import { type PageTarget, resetAnnotationStore } from '../annotations/annotation-store';
import {
  appliedEditIds,
  readAnnotations,
  resetEditRunner,
  whenIdle,
} from '../annotations/edit-runner';
import { pageText } from '../annotations/page-text';
import { getEngineService } from '../engine/engine-service';
import { prepareExport } from '../export/export-service';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import {
  type ApplyOutcome,
  applyTickedRedactions,
  DEFAULT_CHOICES,
  markAreas,
  resetRedactionApply,
} from './apply';
import { createMarks, isRedactMark } from './marks';
import { markKeyOf, resetRedactionStore, useRedactionStore } from './redaction-store';
import { indexPageText, quadsForTextRange } from './text-index';

const TOKEN = 'SECRET-7731';
const model = () => useWorkspaceStore.getState();

async function open(
  url = redactUrl,
  name = 'redact-text-runs.pdf',
): Promise<{ source: SourceId; pages: PageId[]; target: PageTarget }> {
  const report = await model().openFiles([await fixtureFile(url, name)]);
  expect(report.skipped).toEqual([]);
  const doc = getActiveDocument(model().workspace);
  const first = doc?.pages[0];
  if (!doc || first?.ref.kind !== 'source') throw new Error('no document');
  const source = first.ref.source;
  return {
    source,
    pages: doc.pages.map((p) => p.id),
    target: { source, pageIndex: 0, pageId: first.id, position: 1 },
  };
}

/** Quads of every occurrence of the token on page 1 (lines 1, 2, 3). */
async function tokenQuads(source: SourceId) {
  const runs = await pageText(source, 0);
  const index = indexPageText(runs);
  const out = [];
  for (let at = index.text.indexOf(TOKEN); at >= 0; at = index.text.indexOf(TOKEN, at + 1)) {
    out.push(quadsForTextRange(runs, index, at, at + TOKEN.length));
  }
  return out;
}

async function lines(source: SourceId): Promise<string[]> {
  return (await pageText(source, 0)).map((run) => run.text);
}

const line = (all: readonly string[], n: number) =>
  all.find((text) => text.startsWith(`Line ${n}`)) ?? '';

async function marks(source: SourceId) {
  return (await readAnnotations(source, 0)).filter(isRedactMark);
}

function labels(): string[] {
  return historyEntries(model().history).map((e) => e.label);
}

function applied(outcome: ApplyOutcome) {
  if (outcome.kind !== 'applied') {
    throw new Error(`expected an applied outcome, got ${JSON.stringify(outcome).slice(0, 400)}`);
  }
  return outcome;
}

describe('markAreas', () => {
  it('joins the quads of one line and keeps lines apart', () => {
    const a = { x: 100, y: 600, width: 40, height: 12 };
    const b = { x: 150, y: 600.5, width: 30, height: 12 };
    const next = { x: 72, y: 580, width: 50, height: 12 };
    expect(markAreas([a, b, next])).toEqual([{ x: 100, y: 600, width: 80, height: 12.5 }, next]);
  });
});

describe('applying redactions', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetRedactionStore();
    resetRedactionApply();
  });
  afterEach(async () => {
    await whenIdle();
    resetWorkspace();
  });

  it('area only on line 1: the text goes, one history entry, undo restores, redo re-applies', async () => {
    const { source, target } = await open();
    const [first] = await tokenQuads(source);
    await createMarks([{ target, marks: [first ?? []] }]);
    const [mark] = await marks(source);
    expect(mark).toBeDefined();
    expect(line(await lines(source), 1)).toContain(TOKEN);

    const outcome = applied(await applyTickedRedactions({ ...DEFAULT_CHOICES, areaOnly: true }));
    expect(outcome.label).toBe('Redactions applied (1 area)');
    const [result] = outcome.sources;
    expect(result?.result.forensic.ok).toBe(true);
    expect(result?.result.forensic.checks).toHaveLength(9);
    expect(result?.result.gate.ok).toBe(true);
    expect(result?.result.plan.strings).toEqual([]); // area only: nothing captured
    expect(result?.marks).toBe(1);

    // The page text no longer has the token on line 1; lines 2 and 3 keep theirs.
    let text = await lines(source);
    expect(line(text, 1)).not.toContain(TOKEN);
    expect(line(text, 1)).toContain('stays');
    expect(line(text, 2).replace(/\s/g, '')).toContain(TOKEN);
    expect(await marks(source)).toEqual([]);
    expect(labels().at(-1)).toBe('Redactions applied (1 area)');
    const edit = model().workspace.engineEdits.find((e) => e.kind === 'redaction.apply');
    expect(edit?.payload).toMatchObject({ plan: { areas: [{ pageIndex: 0 }], strings: [] } });
    expect(appliedEditIds(source)).toContain(edit?.id);
    expect(model().dirtySources.has(source)).toBe(true);

    // Undo: reopen + replay. The mark and the text are back.
    expect(model().undo()).toBe('Redactions applied (1 area)');
    await whenIdle();
    text = await lines(source);
    expect(line(text, 1)).toContain(TOKEN);
    const back = await marks(source);
    expect(back.map((a) => a.id)).toEqual([mark?.id]);
    expect(model().workspace.engineEdits.some((e) => e.kind === 'redaction.apply')).toBe(false);

    // Redo applies it again.
    model().redo();
    await whenIdle();
    text = await lines(source);
    expect(line(text, 1)).not.toContain(TOKEN);
    expect(await marks(source)).toEqual([]);
    expect(appliedEditIds(source)).toContain(edit?.id);
  });

  it('a self-check failure changes nothing: the unmarked copies of the token stop it', async () => {
    const { source, target } = await open();
    const [first] = await tokenQuads(source);
    await createMarks([{ target, marks: [first ?? []] }]);
    const before = labels();
    // Capture on (the default): lines 2 and 3 still show the captured string.
    const outcome = await applyTickedRedactions(DEFAULT_CHOICES);
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(outcome.stage).toBe('forensic');
    const search = outcome.failure.forensic?.checks.find((c) => c.id === 'no-search-hits');
    expect(search?.passed).toBe(false);
    expect(search?.findings.length).toBe(2);
    await whenIdle();
    expect(labels()).toEqual(before);
    expect(await marks(source)).toHaveLength(1);
    expect(line(await lines(source), 1)).toContain(TOKEN);
    expect(model().workspace.engineEdits.some((e) => e.kind === 'redaction.apply')).toBe(false);
  });

  it('every occurrence marked, one unticked: that mark stays and blocks export until deleted', async () => {
    const { source, target } = await open();
    const occurrences = await tokenQuads(source);
    // An area mark over the innocuous line, left unticked.
    const spare = [{ x: 71, y: 555.7, width: 60, height: 17.85 }];
    await createMarks([{ target, marks: [...occurrences, spare] }]);
    const all = await marks(source);
    expect(all).toHaveLength(4);
    const kept = all.find((a) => a.quads[0]?.y === 555.7) ?? all[3];
    useRedactionStore.getState().setIncluded([markKeyOf(source, kept?.id ?? '')], false);

    const outcome = applied(
      await applyTickedRedactions({ ...DEFAULT_CHOICES, fill: 'white', overlayText: 'X' }),
    );
    expect(outcome.label).toBe('Redactions applied (3 areas)');
    const [result] = outcome.sources;
    expect(result?.keptMarks).toBe(1);
    expect(result?.result.plan.strings).toEqual([TOKEN]);
    expect(result?.result.plan.fillColor).toBe('#ffffff');
    const left = await marks(source);
    expect(left.map((a) => a.id)).toEqual([kept?.id]);
    expect((await lines(source)).join('\n')).not.toContain(TOKEN);
    const hits = await getEngineService().search(source, TOKEN);
    expect(hits.ok && hits.value).toEqual([]);

    // The export reads the redacted source and runs the self-check on its final bytes. The
    // unapplied mark is a pending /Redact in a redacted file: the check blocks it.
    const doc = getActiveDocument(model().workspace);
    if (!doc) throw new Error('no document');
    const blocked = await prepareExport(doc.id, { compression: null });
    if (!blocked.ok) throw new Error(blocked.error.message);
    expect(blocked.value.redaction?.report.ok).toBe(false);
    expect(blocked.value.verification.ok).toBe(false);
    expect(blocked.value.verification.problems[0]).toMatch(/marks that were not applied/);

    await deleteAnnotations({ ...target }, [kept?.id ?? '']);
    const prepared = await prepareExport(doc.id, { compression: null });
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.verification).toEqual({ ok: true, problems: [] });
    expect(prepared.value.redaction?.areas).toBe(3);
    expect(prepared.value.redaction?.report.ok).toBe(true);
    expect(prepared.value.redaction?.report.checks).toHaveLength(9);
    const bytes = new Uint8Array(prepared.value.bytes);
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain(TOKEN);
  });

  it('the model copies (metadata, bookmark titles) are scrubbed in the same history entry', async () => {
    const { source, target } = await open(metadataUrl, 'redact-metadata.pdf');
    const titles = () => {
      const doc = getActiveDocument(model().workspace);
      const out: string[] = [];
      const walk = (nodes: NonNullable<typeof doc>['outline']) => {
        for (const node of nodes) {
          out.push(node.title);
          walk(node.children);
        }
      };
      walk(doc?.outline ?? []);
      return { metadata: doc?.metadata, outline: out };
    };
    const before = titles();
    expect(JSON.stringify(before)).toContain(TOKEN);
    await createMarks([{ target, marks: await tokenQuads(source) }]);
    const entries = labels().length;

    const outcome = applied(await applyTickedRedactions(DEFAULT_CHOICES));
    expect(outcome.sources[0]?.result.redaction.attachments.removed).toBeGreaterThan(0);
    expect(labels()).toHaveLength(entries + 1);
    expect(labels().at(-1)).toBe('Redactions applied (1 area)');
    const after = titles();
    expect(JSON.stringify(after)).not.toContain(TOKEN);
    expect(after.metadata?.title).toContain('[redacted]');
    expect(after.metadata?.policy).toBe(before.metadata?.policy);

    // The export passes its self-check on the final bytes.
    const doc = getActiveDocument(model().workspace);
    if (!doc) throw new Error('no document');
    const prepared = await prepareExport(doc.id, { compression: null });
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.verification.problems).toEqual([]);
    expect(prepared.value.redaction?.report.ok).toBe(true);

    // One undo brings back the text, the marks and the model's strings.
    model().undo();
    await whenIdle();
    expect(titles()).toEqual(before);
    expect((await lines(source)).join(' ')).toContain(TOKEN);
  });
});
