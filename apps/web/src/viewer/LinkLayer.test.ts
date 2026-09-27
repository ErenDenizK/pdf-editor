import type { SourceId } from '@pdf-editor/document-model';
import type { PdfEditor } from '@pdf-editor/engine';
import { describe, expect, it, vi } from 'vitest';

import { getEngineService } from '../engine/engine-service';
import { clearLinksForSource, pageLinks } from './LinkLayer';

describe('link cache', () => {
  it('memoizes per source page and forgets a closed source', async () => {
    const listAnnotations = vi.fn<PdfEditor['listAnnotations']>(() =>
      Promise.resolve([
        {
          id: 'l',
          kind: 'link',
          pageIndex: 0,
          rect: { x: 0, y: 0, width: 1, height: 1 },
          uri: 'https://a.test/',
        },
        {
          id: 'h',
          kind: 'highlight',
          pageIndex: 0,
          rect: { x: 0, y: 0, width: 1, height: 1 },
          quads: [],
        },
      ]),
    );
    const spy = vi
      .spyOn(getEngineService(), 'editor')
      .mockResolvedValue({ listAnnotations } as unknown as PdfEditor);
    try {
      const a = 'cache-a' as SourceId;
      const b = 'cache-b' as SourceId;
      expect((await pageLinks(a, 0)).map((l) => l.id)).toEqual(['l']);
      await pageLinks(a, 0);
      await pageLinks(b, 0);
      expect(listAnnotations).toHaveBeenCalledTimes(2);
      clearLinksForSource(a);
      await pageLinks(a, 0);
      await pageLinks(b, 0);
      expect(listAnnotations).toHaveBeenCalledTimes(3);
      clearLinksForSource(b);
    } finally {
      spy.mockRestore();
    }
  });
});
