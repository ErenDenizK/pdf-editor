/**
 * Redaction marks through the real engine (Vitest browser mode, PDFium) on the M4 fixture
 * `redact-text-runs.pdf` (test/fixtures/README.md: SECRET-7731 in one Tj, split across
 * two TJ arrays, split across two text objects): text index and snippets, marks as
 * /Redact annotations in one history entry with undo, duplicates skipped, the store's
 * listing, J / K stepping and the finder's search over page text.
 */
import {
  getActiveDocument,
  historyEntries,
  type PageId,
  type SourceId,
} from '@pdf-editor/document-model';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import redactUrl from '../../../../test/fixtures/redact-text-runs.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import {
  type PageTarget,
  resetAnnotationStore,
  useAnnotationStore,
} from '../annotations/annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from '../annotations/edit-runner';
import { pageText } from '../annotations/page-text';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { useSearchStore } from '../viewer/search';
import { alreadyMarked, createMarks, isRedactMark, MARK_FILL, MARK_OUTLINE } from './marks';
import {
  collectMarks,
  markKeyOf,
  resetRedactionStore,
  stepKey,
  useRedactionStore,
} from './redaction-store';
import {
  findSensitiveData,
  isStaleMatch,
  markCheckedFinds,
  markSearchHits,
  stepMark,
} from './review';
import { indexPageText, quadsForTextRange, textUnderQuads } from './text-index';

const TOKEN = 'SECRET-7731';
const model = () => useWorkspaceStore.getState();

async function open(): Promise<{ source: SourceId; pages: PageId[]; target: PageTarget }> {
  const report = await model().openFiles([await fixtureFile(redactUrl, 'redact-text-runs.pdf')]);
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

/** Quads of every occurrence of `needle` on page 1, through the text index. */
async function tokenQuads(source: SourceId, needle = TOKEN) {
  const runs = await pageText(source, 0);
  const index = indexPageText(runs);
  const out = [];
  for (let at = index.text.indexOf(needle); at >= 0; at = index.text.indexOf(needle, at + 1)) {
    out.push(quadsForTextRange(runs, index, at, at + needle.length));
  }
  return { runs, index, occurrences: out };
}

function labels(): string[] {
  return historyEntries(model().history).map((e) => e.label);
}

describe('stepKey', () => {
  it('wraps both ways and starts at an end', () => {
    const keys = ['a', 'b', 'c'];
    expect(stepKey(keys, null, 1)).toBe('a');
    expect(stepKey(keys, null, -1)).toBe('c');
    expect(stepKey(keys, 'c', 1)).toBe('a');
    expect(stepKey(keys, 'a', -1)).toBe('c');
    expect(stepKey(keys, 'gone', 1)).toBe('a');
    expect(stepKey([], 'a', 1)).toBeNull();
  });
});

describe('redaction marks through the engine', () => {
  beforeEach(() => {
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetRedactionStore();
  });
  afterEach(async () => {
    await whenIdle();
    resetWorkspace();
    useSearchStore.setState({ hits: [], documentId: null, query: '' });
  });

  it('indexes the fixture text: the token is found on all three lines, whatever its runs', async () => {
    const { source } = await open();
    const { runs, occurrences } = await tokenQuads(source);
    expect(occurrences).toHaveLength(3);
    // Documented boxes (README): x 164.61 / 166.93 / 169.27, baselines 680 / 640 / 600.
    const xs = occurrences.map((quads) => quads[0]?.x ?? 0);
    expect(xs[0]).toBeCloseTo(164.61, 0);
    expect(xs[1]).toBeCloseTo(166.93, 0);
    expect(xs[2]).toBeCloseTo(169.27, 0);
    for (const quads of occurrences) {
      expect(quads).toHaveLength(1);
      expect(textUnderQuads(runs, quads)).toBe(TOKEN);
    }
  });

  it('marks are /Redact annotations with /IC black, in one history entry, undoable', async () => {
    const { source, target } = await open();
    const { occurrences } = await tokenQuads(source);
    const created = await createMarks([{ target, marks: occurrences }]);
    expect(created).toHaveLength(3);
    expect(labels()).toContain('Mark 3 areas for redaction');
    const listed = (await readAnnotations(source, 0)).filter(isRedactMark);
    expect(listed).toHaveLength(3);
    for (const mark of listed) {
      expect(mark.interiorColor).toBe(MARK_FILL);
      expect(mark.color).toBe(MARK_OUTLINE);
    }
    expect(model().dirtySources.has(source)).toBe(true);

    // The same areas again: nothing new, no history entry.
    const entries = historyEntries(model().history).length;
    expect(alreadyMarked(listed, occurrences[0] ?? [])).toBe(true);
    expect(await createMarks([{ target, marks: occurrences }])).toBeUndefined();
    expect(historyEntries(model().history).length).toBe(entries);

    model().undo();
    await whenIdle();
    expect((await readAnnotations(source, 0)).filter(isRedactMark)).toHaveLength(0);
    model().redo();
    await whenIdle();
    const again = (await readAnnotations(source, 0)).filter(isRedactMark);
    expect(again.map((a) => a.id).sort()).toEqual(listed.map((a) => a.id).sort());
  });

  it('a single mark is labelled by page and selected; the store lists it with its snippet', async () => {
    const { source, target } = await open();
    const { runs, occurrences } = await tokenQuads(source);
    const [mark] = (await createMarks([{ target, marks: [occurrences[1] ?? []] }])) ?? [];
    expect(labels()).toContain('Redaction mark on page 1');
    expect(useAnnotationStore.getState().selection?.ids).toEqual([mark?.id]);

    await useAnnotationStore.getState().reloadPage(source, 0);
    const { entries, loading } = collectMarks(
      model().workspace,
      useAnnotationStore.getState().pages,
    );
    expect(loading).toBe(false);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.position).toBe(1);
    expect(entry?.markKey).toBe(markKeyOf(source, mark?.id ?? ''));
    expect(textUnderQuads(runs, entry?.mark.quads ?? [])).toBe(TOKEN);

    // Ticks: all marks start included.
    expect(useRedactionStore.getState().excluded.size).toBe(0);
    useRedactionStore.getState().setIncluded([entry?.markKey ?? ''], false);
    expect(useRedactionStore.getState().excluded.has(entry?.markKey ?? '')).toBe(true);
  });

  it('J / K step through the marks in page order and select them', async () => {
    const { source, target } = await open();
    const { occurrences } = await tokenQuads(source);
    await createMarks([{ target, marks: occurrences }]);
    await useAnnotationStore.getState().reloadPage(source, 0);
    const ids = (useAnnotationStore.getState().pages[`${source}:0`]?.annotations ?? []).map(
      (a) => a.id,
    );
    expect(stepMark(1)).toBe(true);
    expect(useAnnotationStore.getState().selection?.ids).toEqual([ids[0]]);
    stepMark(1);
    expect(useAnnotationStore.getState().selection?.ids).toEqual([ids[1]]);
    stepMark(-1);
    stepMark(-1);
    expect(useAnnotationStore.getState().selection?.ids).toEqual([ids[2]]);
  });

  it('the finder finds nothing sensitive in the fixture; search hits become marks', async () => {
    const { source, pages } = await open();
    const doc = getActiveDocument(model().workspace);
    if (!doc) throw new Error('no document');
    await findSensitiveData(doc);
    expect(useRedactionStore.getState().finder.status).toBe('done');
    expect(useRedactionStore.getState().finder.progress).toEqual({ done: 1, total: 1 });
    expect(await markCheckedFinds()).toBe(0);

    const { occurrences } = await tokenQuads(source);
    useSearchStore.setState({
      documentId: doc.id,
      hits: occurrences.map((rects, i) => ({
        seq: i,
        pageIndex: 0,
        pageId: pages[0] as PageId,
        sourceId: source,
        rects,
        context: TOKEN,
      })),
    });
    expect(await markSearchHits()).toBe(3);
    expect(labels()).toContain('Mark 3 search matches for redaction');
  });

  it('the finder lists validated matches with quads; "Mark selected" marks the ticked ones', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const lines = [
      'Contact: ali.veli@example.com',
      'IBAN: TR33 0006 1005 1978 6457 8413 26',
      'Issued on 12.03.2024, reference 12345678901',
    ];
    lines.forEach((line, i) => page.drawText(line, { x: 72, y: 700 - i * 30, size: 12, font }));
    const file = new File([await pdf.save()], 'pii.pdf', { type: 'application/pdf' });
    await model().openFiles([file]);
    const doc = getActiveDocument(model().workspace);
    const first = doc?.pages[0];
    if (!doc || first?.ref.kind !== 'source') throw new Error('no document');
    const source = first.ref.source;

    await findSensitiveData(doc);
    const { finder } = useRedactionStore.getState();
    expect(finder.matches.map((m) => [m.pattern, m.text])).toEqual([
      ['email', 'ali.veli@example.com'],
      ['iban', 'TR33 0006 1005 1978 6457 8413 26'],
      ['date', '12.03.2024'],
    ]);
    // Dates start unticked; the 11-digit reference fails the TCKN checksum and is not listed.
    expect(finder.checked.size).toBe(2);
    const runs = await pageText(source, 0);
    for (const match of finder.matches) {
      expect(textUnderQuads(runs, match.quads)).toBe(match.text);
    }

    expect(await markCheckedFinds()).toBe(2);
    expect(labels()).toContain('Mark 2 sensitive matches for redaction');
    expect(useRedactionStore.getState().finder.matches.map((m) => m.pattern)).toEqual(['date']);
    const marks = (await readAnnotations(source, 0)).filter(isRedactMark);
    expect(marks.map((a) => textUnderQuads(runs, a.quads)).sort()).toEqual([
      'IBAN: TR33 0006 1005 1978 6457 8413 26'.slice(6),
      'ali.veli@example.com',
    ]);

    // Results are tied to the page's text: marks keep them current, a text edit on the
    // page (or an applied redaction in the source) makes them stale; other pages do not.
    const [date] = useRedactionStore.getState().finder.matches;
    if (!date) throw new Error('no match');
    const ws = model().workspace;
    expect(ws.engineEdits.some((e) => e.kind === 'annotation.create')).toBe(true);
    expect(isStaleMatch(ws, date)).toBe(false);
    const withEdit = (kind: 'text.edit' | 'redaction.apply', pageIndex: number) => ({
      ...ws,
      engineEdits: [...ws.engineEdits, { id: `x-${kind}`, source, pageIndex, kind, payload: {} }],
    });
    expect(isStaleMatch(withEdit('text.edit', 0), date)).toBe(true);
    expect(isStaleMatch(withEdit('text.edit', 1), date)).toBe(false);
    expect(isStaleMatch(withEdit('redaction.apply', 1), date)).toBe(true);
  });
});
