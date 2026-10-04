/**
 * The Highlighter's commit on a real page (craft spec §5.4, §9): a stroke along a line of
 * `text-edit-fonts.pdf` becomes a Highlight and is said by the lines it covers, "Highlighted
 * 1 line on page 1", which is also its History label. Vitest browser mode, PDFium.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import fontsUrl from '../../../../../test/fixtures/text-edit-fonts.pdf?url';
import { enterEditMode, fixtureFile } from '../../../test/store-harness';
import { m } from '../../i18n';
import { useAnnouncer } from '../../shell/announcer';
import { resetWorkspace, useWorkspaceStore } from '../../state/workspace-store';
import { resetToolStore, useToolStore } from '../../viewer/tool-store';
import type { PageTarget } from '../annotation-store';
import { resetAnnotationStore } from '../annotation-store';
import { readAnnotations, resetEditRunner, whenIdle } from '../edit-runner';
import { type PageFrame, userToCss } from '../geometry';
import { pageText } from '../page-text';
import type { ToolDefinition } from '../tools';
import { activateHighlighter, commitHighlighterStroke } from './highlighter';
import { PEN_PRESETS_STORAGE_KEY } from './presets';

const FOX = 'The quick brown fox jumps over the lazy dog';
const FRAME: PageFrame = {
  size: { width: 612, height: 792 },
  originX: 0,
  originY: 0,
  rotation: 0,
  scale: 1,
};

async function open(): Promise<PageTarget> {
  await useWorkspaceStore.getState().openFiles([await fixtureFile(fontsUrl, 'fonts.pdf')]);
  enterEditMode();
  const { workspace } = useWorkspaceStore.getState();
  const doc = workspace.activeDocument ? workspace.documents[workspace.activeDocument] : undefined;
  const first = doc?.pages[0];
  if (first?.ref.kind !== 'source') throw new Error('no source page');
  return { source: first.ref.source, pageIndex: 0, pageId: first.id, position: 1 };
}

describe('the Highlighter on a page', () => {
  beforeEach(() => {
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetWorkspace();
    resetEditRunner();
    resetAnnotationStore();
    resetToolStore();
    useAnnouncer.setState({ message: '' });
  });
  afterEach(async () => {
    await whenIdle();
    localStorage.removeItem(PEN_PRESETS_STORAGE_KEY);
    resetAnnotationStore();
    resetToolStore();
    resetWorkspace();
  });

  it('says "Highlighted 1 line on page 1" for a stroke along a line', async () => {
    const target = await open();
    await activateHighlighter((tool: ToolDefinition) => {
      useToolStore.getState().setMode(tool.mode);
      return Promise.resolve();
    });
    const line = (await pageText(target.source, 0)).find((run) => run.text.startsWith(FOX));
    if (!line) throw new Error('no line');
    const y = line.rect.y + line.rect.height / 2;
    const points = Array.from({ length: 16 }, (_, i) =>
      userToCss(FRAME, { x: line.rect.x + 2 + ((line.rect.width - 4) * i) / 15, y }),
    );
    const done = commitHighlighterStroke(
      {
        points,
        widths: points.map(() => 12),
        pointerType: 'mouse',
        widthSource: 'constant',
        straight: false,
      },
      () => () => undefined,
      FRAME,
      target,
      { downAt: 0, upAt: 100 },
      false,
    );
    expect(done).toBeDefined();
    await done;
    await whenIdle();

    const highlights = (await readAnnotations(target.source, 0)).filter(
      (a) => a.kind === 'highlight',
    );
    expect(highlights).toHaveLength(1);
    expect(useAnnouncer.getState().message).toBe('Highlighted 1 line on page 1');
    const { history } = useWorkspaceStore.getState();
    expect(history.present.label).toBe('Highlighted 1 line on page 1');
    // Two lines in one stroke read in the plural.
    expect(m.highlighter_highlighted_lines({ count: 2, page: 3 })).toBe(
      'Highlighted 2 lines on page 3',
    );
  });
});
