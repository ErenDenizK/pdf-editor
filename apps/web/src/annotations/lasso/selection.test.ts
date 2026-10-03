/**
 * The lasso's selection in the annotation store (craft spec §5.5): ink paths and whole
 * annotations together, one selection of both, active only while the two agree.
 */
import type { PageId, SourceId } from '@pdf-editor/document-model';
import { afterEach, describe, expect, it } from 'vitest';

import {
  activePathSelection,
  type PageTarget,
  resetAnnotationStore,
  useAnnotationStore,
} from '../annotation-store';

const target: PageTarget = {
  source: 'src' as SourceId,
  pageIndex: 0,
  pageId: 'page' as PageId,
  position: 1,
};

const store = () => useAnnotationStore.getState();

describe('lasso selection (paths and whole annotations)', () => {
  afterEach(() => resetAnnotationStore());

  it('selects ink paths and whole annotations as one selection', () => {
    store().selectPaths(target, { ink: [0, 2] }, undefined, ['arrow', 'note']);
    expect(store().selection?.ids).toEqual(['ink', 'arrow', 'note']);
    const active = activePathSelection(store());
    expect(active?.paths).toEqual({ ink: [0, 2] });
    expect(active?.whole).toEqual(['arrow', 'note']);
  });

  it('a lasso that took only whole annotations is a lasso selection too', () => {
    store().selectPaths(target, {}, undefined, ['arrow']);
    expect(store().selection?.ids).toEqual(['arrow']);
    expect(activePathSelection(store())?.whole).toEqual(['arrow']);
    expect(activePathSelection(store())?.paths).toEqual({});
  });

  it('drops empty path lists, duplicates, and ids given both ways', () => {
    store().selectPaths(target, { ink: [1], empty: [] }, undefined, ['note', 'note', 'ink']);
    expect(store().selection?.ids).toEqual(['ink', 'note']);
    expect(activePathSelection(store())?.whole).toEqual(['note']);
  });

  it('selects nothing when the lasso took nothing', () => {
    store().selectPaths(target, {}, undefined, []);
    expect(store().selection).toBeNull();
    expect(store().pathSelection).toBeNull();
  });

  it('keeps its key across a selection with new ids (a split)', () => {
    store().selectPaths(target, { ink: [1] }, 'k1', ['arrow']);
    store().selectPaths(target, { split: [0] }, 'k1', ['arrow']);
    expect(activePathSelection(store())?.key).toBe('k1');
    expect(store().selection?.ids).toEqual(['split', 'arrow']);
  });

  it('is not active once the selection differs (the Select tool, a narrowed selection)', () => {
    store().selectPaths(target, { ink: [0] }, undefined, ['arrow']);
    useAnnotationStore.setState((s) => ({
      selection: s.selection ? { ...s.selection, ids: ['ink'] } : null,
    }));
    expect(activePathSelection(store())).toBeNull();
    useAnnotationStore.setState((s) => ({
      selection: s.selection ? { ...s.selection, ids: ['ink', 'other'] } : null,
    }));
    expect(activePathSelection(store())).toBeNull();
    store().select({ ...target, ids: ['ink', 'arrow'] });
    expect(store().pathSelection).toBeNull();
    expect(activePathSelection(store())).toBeNull();
  });

  it('follows its paths to where an edit put them; whole ids stay', () => {
    store().selectPaths(target, { ink: [1] }, 'k', ['arrow']);
    store().followPaths('k', { split: [0] });
    expect(store().pathSelection?.next).toEqual({ split: [0] });
    expect(store().pathSelection?.whole).toEqual(['arrow']);
    store().followPaths('other', undefined);
    expect(store().pathSelection?.next).toEqual({ split: [0] });
  });
});
