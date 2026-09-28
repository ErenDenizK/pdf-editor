/**
 * The Compare view end to end in the browser (spec recognize-and-compare §2): compare-a.pdf
 * against compare-b.pdf through the real PDFium and analysis workers, then the Changes panel
 * and the view against the manifest's `expect.compare` (page map, the changed word, the moved
 * image, the title fact), the heat map, the changes as text, and release on leaving the view.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import manifest from '../../../../test/fixtures/manifest.json';
import aUrl from '../../../../test/fixtures/compare-a.pdf?url';
import bUrl from '../../../../test/fixtures/compare-b.pdf?url';
import { fixtureFile } from '../../test/store-harness';
import { commandRegistry } from '../commands/registry';
import { getAnalysisWorkers } from '../engine/engine-service';
import { useUiStore } from '../state/ui-store';
import { resetWorkspace, useWorkspaceStore } from '../state/workspace-store';
import { buildChangeList } from './changes';
import { changesMarkdown } from './changes-text';
import ChangesPanel from './ChangesPanel';
import { registerCompareCommands } from './compare-commands';
import { hasActiveCompare, releaseCompare, startCompare } from './compare-runner';
import { resetCompareStore, useCompareStore } from './compare-store';
import CompareView from './CompareView';

interface CompareExpect {
  readonly pageMap: readonly { a: number | null; b: number | null }[];
  readonly changes: readonly {
    kind: string;
    aPage?: number;
    bPage?: number;
    a?: unknown;
    b?: unknown;
    key?: string;
    heading?: string;
    words?: number;
    delta?: readonly number[];
    lineB?: string;
  }[];
  readonly identicalPairs: readonly { a: number; b: number }[];
}

const expected = (
  manifest.fixtures.find((f) => f.file === 'compare-a.pdf')?.expect as unknown as {
    compare: CompareExpect;
  }
).compare;

let unregister: (() => void) | undefined;

beforeEach(() => {
  resetWorkspace();
  resetCompareStore();
  useUiStore.setState({ viewMode: 'read', leftPanelOpen: true, leftPanelView: 'pages' });
  unregister = registerCompareCommands(commandRegistry);
});

afterEach(async () => {
  await releaseCompare();
  useUiStore.setState({ viewMode: 'read' });
  unregister?.();
  resetWorkspace();
});

afterAll(() => getAnalysisWorkers().terminate());

function enabled(id: string): boolean {
  const command = commandRegistry.get(id);
  return command !== undefined && commandRegistry.isEnabled(command);
}

async function openPair() {
  const report = await useWorkspaceStore
    .getState()
    .openFiles([
      await fixtureFile(aUrl, 'compare-a.pdf'),
      await fixtureFile(bUrl, 'compare-b.pdf'),
    ]);
  const [a, b] = report.opened.map((o) => o.documentId);
  if (!a || !b) throw new Error('fixtures did not open');
  return { a, b };
}

describe('compare-a.pdf against compare-b.pdf', () => {
  it('lists the seeded changes and shows the page map', async () => {
    const { a, b } = await openPair();
    useUiStore.getState().setViewMode('compare');
    // Entering the view picks the active tab and the next one, and opens the Changes panel.
    expect(useUiStore.getState().leftPanelView).toBe('changes');
    useCompareStore.setState({ a, b });
    const phases: string[] = [];
    const off = useCompareStore.subscribe((s) => {
      const phase = s.progress?.phase;
      if (phase && phases[phases.length - 1] !== phase) phases.push(phase);
    });
    await startCompare();
    off();
    const { result, status } = useCompareStore.getState();
    expect(status).toBe('done');
    expect(phases).toEqual(['text', 'align', 'visual', 'text-diff', 'facts']);
    if (!result) throw new Error('no result');

    // Page map (manifest pages are 1-based, null = missing).
    expect(result.pages.map((p) => ({ a: p.pair.a ?? null, b: p.pair.b ?? null }))).toEqual(
      expected.pageMap.map((p) => ({
        a: p.a === null ? null : p.a - 1,
        b: p.b === null ? null : p.b - 1,
      })),
    );
    for (const pair of expected.identicalPairs) {
      const row = result.pages.find((p) => p.pair.a === pair.a - 1 && p.pair.b === pair.b - 1);
      expect(row?.status).toBe('identical');
    }

    const list = buildChangeList(result);
    const text = expected.changes.find((c) => c.kind === 'text-changed') as {
      a: { text: string };
      b: { text: string };
      bPage: number;
      lineB: string;
    };
    const moved = expected.changes.find((c) => c.kind === 'image-moved') as {
      bPage: number;
      a: readonly number[];
      b: readonly number[];
    };
    const title = expected.changes.find((c) => c.kind === 'metadata') as {
      key: string;
      a: string;
      b: string;
    };

    render(<ChangesPanel />);
    const panel = await screen.findByTestId('changes-panel');
    // The honesty line leads the header.
    expect(within(panel).getByTestId('changes-honesty')).toHaveTextContent(
      'Pixel differences at 100 dpi',
    );
    expect(within(panel).getByTestId('changes-honesty')).toHaveTextContent(
      'a pixel diff cannot tell intent',
    );
    expect(within(panel).getByTestId('changes-summary')).toHaveTextContent(
      'Pages: 2 changed · 1 inserted · 1 deleted · 1 unchanged',
    );

    // The changed word, on the first page pair.
    const word = within(panel).getByRole('button', {
      name: `Changed: “${text.a.text}” → “${text.b.text}” ${text.lineB}`,
    });
    expect(word.closest('section')).toHaveAccessibleName(`Page 1 ↔ ${text.bPage}`);

    // The moved image: changed areas on the second pair, around the old and new places.
    const visual = list.flat.find((i) => i.kind === 'visual' && i.row === 1);
    expect(visual?.kind).toBe('visual');
    const second = within(panel).getByRole('region', { name: `Page 2 ↔ ${moved.bPage}` });
    expect(
      within(second).getByRole('button', { name: /^Changed: \d+ changed areas? .* of the page$/ }),
    ).toBeVisible();
    if (visual?.kind === 'visual') {
      const [ax, ay, aw, ah] = moved.a as [number, number, number, number];
      const [bx, , bw] = moved.b as [number, number, number, number];
      const rect = visual.rect;
      if (!rect) throw new Error('no rect');
      // The bounds cover the image's old and new place (within the 8 px grid at 100 dpi).
      expect(rect.x).toBeLessThanOrEqual(ax + 1);
      expect(rect.x + rect.width).toBeGreaterThanOrEqual(bx + bw - 1);
      expect(rect.y).toBeLessThanOrEqual(ay + 1);
      expect(rect.y + rect.height).toBeGreaterThanOrEqual(ay + ah - 1);
      expect(rect.width).toBeLessThan(aw + 20 + 12);
    }

    // Deleted and inserted pages with their headings and word counts.
    const deleted = expected.changes.find((c) => c.kind === 'page-deleted');
    const inserted = expected.changes.find((c) => c.kind === 'page-inserted');
    expect(
      within(panel).getByRole('button', {
        name: `Removed: Page ${deleted?.aPage} deleted “${deleted?.heading}” · ${deleted?.words} words`,
      }),
    ).toBeVisible();
    expect(
      within(panel).getByRole('button', {
        name: `Added: Page ${inserted?.bPage} inserted “${inserted?.heading}” · ${inserted?.words} words`,
      }),
    ).toBeVisible();

    // The title fact, in the Document group.
    const fact = within(panel).getByRole('button', {
      name: `Changed: Document info: ${title.key} “${title.a}” → “${title.b}”`,
    });
    expect(fact.closest('section')).toHaveAccessibleName('Document');

    // Exactly those changes: the title; on page 1 the word (and its pixels); the image's
    // pixels on page 2; the deleted and the inserted page. Page 4 ↔ 3 is identical.
    expect(list.flat.map((i) => i.id)).toEqual([
      'fact:0',
      'visual:0',
      'text:0',
      'visual:1',
      'page:2',
      'page:4',
    ]);

    // The same list as text.
    const markdown = changesMarkdown(result, list);
    expect(markdown).toContain('# Changes: compare-a → compare-b');
    expect(markdown).toContain('## Document');
    expect(markdown).toContain(
      '- ~ Document info: Title — “Quarterly report” → “Quarterly report (revised)”',
    );
    expect(markdown).toContain('- ~ “Monday” → “Tuesday”');
    expect(markdown).toContain('> Pixel differences at 100 dpi');
  }, 60_000);

  it('renders the pages side by side, reveals a change and draws the heat map', async () => {
    const { a, b } = await openPair();
    useUiStore.getState().setViewMode('compare');
    useCompareStore.setState({ a, b });
    render(
      <div style={{ width: 1000, height: 700, display: 'flex' }}>
        <CompareView dragging={false} />
      </div>,
    );
    expect(await screen.findByTestId('compare-setup')).toBeVisible();
    await startCompare();
    const view = await screen.findByTestId('compare-view');
    await waitFor(() => expect(view).toHaveAttribute('data-status', 'done'));
    // Page map strip: = identical, ~ changed, + inserted, − deleted.
    const strip = screen.getByTestId('compare-page-map');
    expect(
      within(strip)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['~', '~', '−', '=', '+']);
    expect(within(strip).getAllByRole('button')[2]).toHaveAccessibleName('Page 3 of A: deleted');
    // The changed word is marked on both pages of the first row.
    const markers = view.querySelectorAll('[data-change="text:0"]');
    expect(markers.length).toBe(2);
    // Heat map on: a canvas over B's page of each changed row.
    const toggle = screen.getByTestId('compare-heatmap-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    toggle.click();
    await waitFor(() =>
      expect(
        view.querySelector('[data-testid="compare-heatmap"][data-state="rendered"]'),
      ).not.toBeNull(),
    );
    // J reveals the next change and marks it current.
    await commandRegistry.execute('compare.next');
    expect(useCompareStore.getState().current).toBe('fact:0');
    await commandRegistry.execute('compare.next');
    expect(useCompareStore.getState().current).toBe('visual:0');
    await commandRegistry.execute('compare.next');
    expect(useCompareStore.getState().current).toBe('text:0');
    await waitFor(() =>
      expect(view.querySelector('[data-change="text:0"][data-current]')).not.toBeNull(),
    );
  }, 60_000);

  it('keeps the comparison when the view is left; New comparison releases it', async () => {
    const { a, b } = await openPair();
    useUiStore.getState().setViewMode('compare');
    useCompareStore.setState({ a, b });
    await startCompare();
    expect(hasActiveCompare()).toBe(true);
    const { result } = useCompareStore.getState();
    useUiStore.getState().setViewMode('read');
    expect(useUiStore.getState().leftPanelView).toBe('pages');
    // Read-only view: nothing to lose by leaving, so the result waits for the return.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hasActiveCompare()).toBe(true);
    expect(useCompareStore.getState()).toMatchObject({ status: 'done', result });
    useUiStore.getState().setViewMode('compare');
    expect(useUiStore.getState().leftPanelView).toBe('changes');
    expect(useCompareStore.getState().result).toBe(result);

    render(<CompareView dragging={false} />);
    (await screen.findByRole('button', { name: 'New comparison' })).click();
    await waitFor(() => expect(useCompareStore.getState().result).toBeNull());
    expect(hasActiveCompare()).toBe(false);
    // The choices stay for the next time.
    expect(useCompareStore.getState().a).toBe(a);
  }, 60_000);

  it('releases the comparison when a compared tab closes', async () => {
    const { a, b } = await openPair();
    useUiStore.getState().setViewMode('compare');
    useCompareStore.setState({ a, b });
    await startCompare();
    useUiStore.getState().setViewMode('read');
    useWorkspaceStore.getState().closeDocument(b);
    await waitFor(() =>
      expect(useCompareStore.getState()).toMatchObject({ status: 'setup', result: null }),
    );
    expect(hasActiveCompare()).toBe(false);
  }, 60_000);

  it('says the result is out of date after a compared document changes', async () => {
    const { a, b } = await openPair();
    useUiStore.getState().setViewMode('compare');
    useCompareStore.setState({ a, b });
    await startCompare();
    render(<ChangesPanel />);
    const panel = await screen.findByTestId('changes-panel');
    const report = within(panel).getByRole('button', { name: 'Export report' });
    expect(report).toBeEnabled();
    expect(enabled('compare.exportReport')).toBe(true);
    expect(within(panel).queryByTestId('changes-stale')).toBeNull();

    // A page command on B (the palette works in any view): the result no longer describes it.
    const page = useWorkspaceStore.getState().workspace.documents[b]?.pages[0];
    if (!page) throw new Error('no page');
    useWorkspaceStore.getState().rotatePages([page.id], 90);
    const notice = await within(panel).findByTestId('changes-stale');
    expect(notice).toHaveTextContent('The documents changed since this comparison');
    expect(within(notice).getByRole('button', { name: 'Run again' })).toBeVisible();
    expect(report).toBeDisabled();
    expect(enabled('compare.exportReport')).toBe(false);
    // The list stays (it describes the compared documents) and so does its text export.
    expect(enabled('compare.exportChanges')).toBe(true);

    // Undo: the documents are what was compared again.
    useWorkspaceStore.getState().undo();
    await waitFor(() => expect(within(panel).queryByTestId('changes-stale')).toBeNull());
    expect(report).toBeEnabled();

    // Run again from the notice compares the documents as they are now.
    const before = useCompareStore.getState().result;
    useWorkspaceStore.getState().rotatePages([page.id], 90);
    (await within(panel).findByRole('button', { name: 'Run again' })).click();
    await waitFor(() => expect(useCompareStore.getState().status).toBe('running'));
    await waitFor(() => expect(useCompareStore.getState().status).toBe('done'), {
      timeout: 30_000,
    });
    expect(useCompareStore.getState().stale).toBe(false);
    expect(within(panel).queryByTestId('changes-stale')).toBeNull();
    expect(useCompareStore.getState().result).not.toBe(before);
  }, 90_000);
});
