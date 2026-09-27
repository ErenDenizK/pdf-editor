import { describe, expect, it } from 'vitest';
import { setLabelRanges } from '../labels';
import { deletePages, mergeDocuments, setPageCropBox, setPageOverlays } from '../pages';
import { deserializeWorkspace, type SerializedWorkspaceV1, serializeWorkspace } from '../serialize';
import type { BlobId, DocumentId, PageId, SourceId, Workspace } from '../types';
import { check, expectCode, must, open, pageIds, pageOutline } from './fixtures';

function richWorkspace(): Workspace {
  const { ws, docs, ids } = open(
    ['A', 3, { outline: pageOutline('A', 3), labels: ['i', 'ii', '1'] }],
    ['B', 2],
  );
  const [a, b] = docs as [DocumentId, DocumentId];
  const [a1, a2] = pageIds(ws, a) as [PageId, PageId];
  let next = setPageCropBox(ws, a1, { x: 1, y: 2, width: 300, height: 400 });
  next = setPageOverlays(
    next,
    [a1],
    [
      {
        kind: 'image',
        layer: 'behind',
        blob: 'wm' as BlobId,
        anchor: 'center',
        offset: { x: 0, y: 0 },
        scale: 0.5,
        opacity: 0.2,
        tile: { gapX: 10, gapY: 10 },
      },
    ],
  );
  next = setLabelRanges(next, b, [
    { startIndex: 0, style: 'alpha-upper', prefix: 'B-', firstNumber: 1 },
  ]);
  next = deletePages(next, [a2]);
  next = mergeDocuments(next, { documentIds: [a, b], title: 'Merged' }, ids);
  const src = Object.keys(next.sources)[0] as SourceId;
  return check({
    ...next,
    engineEdits: [
      {
        id: 'e1',
        source: src,
        pageIndex: 0,
        kind: 'annotation.create',
        payload: { rect: [1, 2, 3, 4], note: 'x' },
        inverse: {
          id: 'e1-inv',
          source: src,
          pageIndex: 0,
          kind: 'annotation.delete',
          payload: null,
        },
      },
    ],
  });
}

type DeepMutable<T> = T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T;
type Data = DeepMutable<SerializedWorkspaceV1>;

/** Serializes the rich workspace through JSON and lets a test damage the copy. */
function corrupt(edit: (data: Data) => void): unknown {
  const data = JSON.parse(JSON.stringify(serializeWorkspace(richWorkspace()))) as Data;
  edit(data);
  return data;
}

function set(target: object, key: string, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

const firstDocument = (d: Data): Data['documents'][number] => must(d.documents[0]);
const firstPage = (d: Data): Data['documents'][number]['pages'][number] =>
  must(firstDocument(d).pages[0]);

describe('serialize / deserialize', () => {
  it('round-trips through JSON text', () => {
    const ws = richWorkspace();
    const json = JSON.stringify(serializeWorkspace(ws));
    const restored = deserializeWorkspace(json);
    expect(restored).toEqual(ws);
    expect(deserializeWorkspace(JSON.parse(json))).toEqual(ws);
  });

  it('is versioned and contains no bytes', () => {
    const serialized = serializeWorkspace(richWorkspace());
    expect(serialized.version).toBe(1);
    expect(JSON.stringify(serialized)).not.toMatch(/ArrayBuffer|bytes/);
  });

  it('drops unknown properties', () => {
    const data = corrupt((d) => {
      set(firstDocument(d), 'extra', 'ignored');
      set(firstPage(d), 'bytes', [1, 2, 3]);
    });
    expect(deserializeWorkspace(data)).toEqual(richWorkspace());
  });

  it('rejects malformed input with a path', () => {
    expectCode(() => deserializeWorkspace('{'), 'invalid-serialized');
    expectCode(() => deserializeWorkspace(null), 'invalid-serialized');
    expectCode(
      () => deserializeWorkspace(corrupt((d) => set(d, 'version', 2))),
      'unsupported-version',
    );

    const badRotation = corrupt((d) => set(firstPage(d), 'rotation', 45));
    expect(() => deserializeWorkspace(badRotation)).toThrow(/documents\[0\]\.pages\[0\]\.rotation/);

    const cases: ((d: Data) => void)[] = [
      (d) => set(firstPage(d), 'ref', { kind: 'source', source: 'missing', index: 0 }),
      (d) => firstDocument(d).pages.push(firstPage(d)),
      (d) => set(must(must(d.sources[0]).pages[0]).size, 'width', 'wide'),
      (d) => set(d, 'activeDocument', 'nope'),
      (d) => d.documents.push(firstDocument(d)),
      (d) => set(firstDocument(d), 'labels', [{ startIndex: 0, style: 'hex' }]),
      (d) => set(firstDocument(d), 'outline', [{ title: 'x', open: 'yes', children: [] }]),
    ];
    for (const edit of cases)
      expectCode(() => deserializeWorkspace(corrupt(edit)), 'invalid-serialized');
  });
});
