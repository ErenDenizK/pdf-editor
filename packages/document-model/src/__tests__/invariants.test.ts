import { describe, expect, it } from 'vitest';
import { createHistory, pushHistory, undo } from '../history';
import { assertWorkspaceInvariants, checkWorkspaceInvariants } from '../invariants';
import { setLabelRanges } from '../labels';
import {
  deletePages,
  duplicatePages,
  insertBlankPage,
  interleave,
  mergeDocuments,
  movePages,
  reversePages,
  rotatePages,
  splitDocument,
} from '../pages';
import { deserializeWorkspace, serializeWorkspace } from '../serialize';
import type { DocumentId, PageId, Workspace } from '../types';
import { closeDocument, newEmptyDocument } from '../workspace';
import { check, expectCode, open, pageOutline, must } from './fixtures';

describe('checkWorkspaceInvariants', () => {
  const { ws, docs } = open(['A', 2, { outline: pageOutline('A', 2) }], ['B', 1]);
  const [a, b] = docs as [DocumentId, DocumentId];
  const docA = must(ws.documents[a]);
  const docB = must(ws.documents[b]);

  it('accepts a valid workspace', () => {
    expect(checkWorkspaceInvariants(ws)).toEqual([]);
  });

  it('detects a page in two documents', () => {
    const broken: Workspace = {
      ...ws,
      documents: { ...ws.documents, [b]: { ...docB, pages: [...docB.pages, must(docA.pages[0])] } },
    };
    expect(checkWorkspaceInvariants(broken).join()).toMatch(/appears in/);
    expectCode(() => assertWorkspaceInvariants(broken), 'invariant-violation');
  });

  it('detects dangling sources, bad order and cross-document outline targets', () => {
    const noSources: Workspace = { ...ws, sources: {} };
    expect(checkWorkspaceInvariants(noSources).join()).toMatch(/dangling source/);
    const badOrder: Workspace = { ...ws, documentOrder: [a] };
    expect(checkWorkspaceInvariants(badOrder).join()).toMatch(/permutation/);
    const crossTarget: Workspace = {
      ...ws,
      documents: { ...ws.documents, [b]: { ...docB, outline: docA.outline } },
    };
    expect(checkWorkspaceInvariants(crossTarget).join()).toMatch(/outside the document/);
    const badLabels: Workspace = {
      ...ws,
      documents: {
        ...ws.documents,
        [b]: { ...docB, labels: [{ startIndex: 5, style: 'decimal' }] },
      },
    };
    expect(checkWorkspaceInvariants(badLabels).join()).toMatch(/label range/);
  });
});

/** Deterministic pseudo-random operation sequences; invariants must hold after each. */
describe('random operation sequences', () => {
  it('preserve every invariant, survive serialization and undo', () => {
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return n <= 0 ? 0 : seed % n;
    };
    const pick = <T>(items: readonly T[]): T | undefined => items[rand(items.length)];

    for (let run = 0; run < 25; run++) {
      const fx = open(
        ['A', 5, { outline: pageOutline('A', 5), labels: ['i', 'ii', '1', '2', '3'] }],
        ['B', 4, { outline: pageOutline('B', 4) }],
        ['C', 3],
      );
      const { ids } = fx;
      let ws = setLabelRanges(fx.ws, must(fx.docs[1]), [{ startIndex: 1, style: 'roman-upper' }]);
      const initial = ws;
      let history = createHistory(ws);
      for (let step = 0; step < 30; step++) {
        const docIds = ws.documentOrder;
        const allPages = docIds.flatMap((d) => ws.documents[d]?.pages.map((p) => p.id) ?? []);
        const selection = [
          ...new Set(Array.from({ length: 1 + rand(3) }, () => pick(allPages))),
        ].filter((p): p is PageId => p !== undefined);
        const doc = pick(docIds);
        const other = pick(docIds.filter((d) => d !== doc));
        const docPages = doc === undefined ? [] : (ws.documents[doc]?.pages ?? []);
        try {
          switch (rand(11)) {
            case 0:
              if (doc)
                ws = movePages(ws, {
                  pageIds: selection,
                  target: { document: doc, index: rand(docPages.length + 1) },
                });
              break;
            case 1:
              ws = deletePages(ws, selection);
              break;
            case 2:
              ws = duplicatePages(ws, selection, ids);
              break;
            case 3:
              ws = rotatePages(ws, selection, 90 * (rand(7) - 3));
              break;
            case 4:
              if (doc) ws = reversePages(ws, doc);
              break;
            case 5:
              if (doc && other)
                ws = interleave(
                  ws,
                  { a: doc, b: other, mode: rand(2) ? 'alternate' : 'duplex-reverse-b' },
                  ids,
                );
              break;
            case 6:
              if (doc) ws = splitDocument(ws, doc, { mode: 'every', n: 1 + rand(3) }, ids);
              break;
            case 7:
              if (doc && other)
                ws = mergeDocuments(ws, { documentIds: [doc, other], title: 'M' }, ids);
              break;
            case 8:
              if (doc)
                ws = insertBlankPage(ws, { document: doc, index: rand(docPages.length + 1) }, ids);
              break;
            case 9:
              if (doc && docIds.length > 1) ws = closeDocument(ws, doc);
              else ws = newEmptyDocument(ws, ids).workspace;
              break;
            case 10:
              if (doc && docPages.length > 2) {
                const start = rand(docPages.length - 1);
                ws = splitDocument(ws, doc, { mode: 'ranges', ranges: [[start, start + 1]] }, ids);
              }
              break;
          }
        } catch (error) {
          // Operations may legitimately refuse (e.g. empty selection, single-part split).
          if (!(error instanceof Error && 'code' in error)) throw error;
          expect(error.code).not.toBe('invariant-violation');
        }
        check(ws);
        history = pushHistory(history, ws, `step ${step}`, { now: step * 1000 });
      }
      expect(deserializeWorkspace(JSON.stringify(serializeWorkspace(ws)))).toEqual(ws);
      while (history.past.length > 0) {
        history = undo(history);
        check(history.present.workspace);
      }
      expect(history.present.workspace).toBe(initial);
    }
  });
});
