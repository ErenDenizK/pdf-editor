/**
 * The engine edit log through the real PDFium adapter: inverses, id stability (/NM) and
 * crash-recovery replay.
 */

import type { EngineEdit, SourceId } from '@pdf-editor/document-model';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  annotationIdsOfEdits,
  applyEngineEdit,
  applyEngineEditWithResult,
  replayEngineEdits,
  serializeAnnotation,
} from '../src/edits';
import { PdfLibAssembler } from '../src/pdflib/pdflib-assembler';
import { PdfiumAdapter } from '../src/pdfium/pdfium-adapter';
import type { Annotation, NewAnnotation } from '../src/types';
import { pngBlob } from './annotation-helpers';
import { makePdf, sid, wasmUrl } from './helpers';

let adapter: PdfiumAdapter;
let blank: ArrayBuffer;
let counter = 0;

beforeAll(async () => {
  adapter = new PdfiumAdapter({ wasmUrl, inspector: new PdfLibAssembler() });
  blank = await makePdf([
    { size: [612, 792], text: 'Page one' },
    { size: [612, 792], text: 'Page two' },
  ]);
});

afterAll(async () => {
  await adapter.destroy();
});

async function open(): Promise<SourceId> {
  const id = sid(`edits-${++counter}`);
  await adapter.open(id, blank.slice(0));
  return id;
}

async function createEdit(source: SourceId, annotation: NewAnnotation, id = `e${++counter}`) {
  return {
    id,
    source,
    pageIndex: annotation.pageIndex,
    kind: 'annotation.create',
    payload: { annotation: await serializeAnnotation(annotation) },
  } satisfies EngineEdit;
}

/** Listing without volatile fields, for comparing two documents. */
function comparable(list: readonly Annotation[]) {
  return list.map(({ modified: _m, ...rest }) => rest);
}

const square: NewAnnotation = {
  kind: 'square',
  pageIndex: 0,
  rect: { x: 100, y: 500, width: 80, height: 40 },
  strokeWidth: 2,
  color: '#E53935',
};

describe('applyEngineEdit', () => {
  test('create → inverse delete → redo recreates the same /NM', async () => {
    const source = await open();
    const { applied, inverse, annotation } = await applyEngineEditWithResult(
      adapter,
      await createEdit(source, square),
    );
    const createdId = annotation?.id as string;
    expect(createdId).toBeTruthy();
    expect((applied.payload as { annotation: { id: string } }).annotation.id).toBe(createdId);
    expect(inverse).toMatchObject({
      kind: 'annotation.delete',
      payload: { annotationId: createdId },
    });

    const redo = await applyEngineEdit(adapter, inverse); // undo
    expect(await adapter.listAnnotations(source, 0)).toEqual([]);
    expect(redo.kind).toBe('annotation.create');

    await applyEngineEdit(adapter, redo); // redo
    const listed = await adapter.listAnnotations(source, 0);
    expect(listed.map((a) => a.id)).toEqual([createdId]);
    expect(listed[0]?.rect).toEqual(square.rect);
    await adapter.close(source);
  });

  test('update inverse restores the previous state; delete inverse restores a stamp', async () => {
    const source = await open();
    const created = await adapter.createAnnotation(source, square);
    const update: EngineEdit = {
      id: 'u1',
      source,
      pageIndex: 0,
      kind: 'annotation.update',
      payload: {
        annotation: await serializeAnnotation({ ...created, color: '#1E88E5', contents: 'moved' }),
      },
    };
    const undoUpdate = await applyEngineEdit(adapter, update);
    expect((await adapter.listAnnotations(source, 0))[0]).toMatchObject({ color: '#1E88E5' });
    await applyEngineEdit(adapter, undoUpdate);
    const undone = (await adapter.listAnnotations(source, 0))[0];
    expect(undone?.color).toBe('#E53935');
    expect(undone?.contents).toBeUndefined();

    const stamp = await adapter.createAnnotation(source, {
      kind: 'stamp',
      pageIndex: 1,
      rect: { x: 50, y: 50, width: 40, height: 40 },
      imageBlob: pngBlob(),
    });
    const undoDelete = await applyEngineEdit(adapter, {
      id: 'd1',
      source,
      pageIndex: 1,
      kind: 'annotation.delete',
      payload: { annotationId: stamp.id },
    });
    expect(await adapter.listAnnotations(source, 1)).toEqual([]);
    // The inverse is plain JSON (it goes into the serialized workspace).
    const roundtripped = JSON.parse(JSON.stringify(undoDelete)) as EngineEdit;
    await applyEngineEdit(adapter, roundtripped);
    const restored = await adapter.listAnnotations(source, 1);
    expect(restored.map((a) => [a.id, a.kind])).toEqual([[stamp.id, 'stamp']]);
    await adapter.close(source);
  });

  test('form value inverse reads the previous value back', async () => {
    const bytes = await makePdf([{ size: [300, 200] }], (doc) => {
      const field = doc.getForm().createTextField('customer.name');
      field.setText('Ada');
      field.addToPage(doc.getPage(0), { x: 20, y: 100, width: 150, height: 24 });
    });
    const source = sid('form-edits');
    await adapter.open(source, bytes);
    const undo = await applyEngineEdit(adapter, {
      id: 'f1',
      source,
      pageIndex: 0,
      kind: 'form.set-value',
      payload: { name: 'customer.name', value: 'Grace' },
    });
    expect(undo.payload).toEqual({ name: 'customer.name', value: 'Ada' });
    expect((await adapter.listFormFields(source))[0]?.value).toBe('Grace');
    await applyEngineEdit(adapter, undo);
    expect((await adapter.listFormFields(source))[0]?.value).toBe('Ada');
    await adapter.close(source);
  });

  test('redaction edits are refused clearly', async () => {
    const source = await open();
    await expect(
      applyEngineEdit(adapter, {
        id: 'r',
        source,
        pageIndex: 0,
        kind: 'redaction.apply',
        payload: null,
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await adapter.close(source);
  });
});

describe('replayEngineEdits', () => {
  test('replaying the recorded edits on a fresh open gives the same annotations', async () => {
    const first = await open();
    const log: EngineEdit[] = [];
    const record = async (edit: EngineEdit) => {
      log.push((await applyEngineEditWithResult(adapter, edit)).applied);
    };
    await record(await createEdit(first, square, 'c1'));
    await record(
      await createEdit(
        first,
        {
          kind: 'highlight',
          pageIndex: 1,
          rect: { x: 72, y: 700, width: 100, height: 14 },
          quads: [{ x: 72, y: 700, width: 100, height: 14 }],
          contents: 'Replay me',
        },
        'c2',
      ),
    );
    await record(
      await createEdit(
        first,
        {
          kind: 'text',
          pageIndex: 0,
          rect: { x: 300, y: 300, width: 20, height: 20 },
          contents: 'Note',
          open: true,
        },
        'c3',
      ),
    );
    const squareId = (log[0]?.payload as { annotation: { id: string } }).annotation.id;
    const current = (await adapter.listAnnotations(first, 0)).find(
      (a) => a.id === squareId,
    ) as Annotation;
    await record({
      id: 'u1',
      source: first,
      pageIndex: 0,
      kind: 'annotation.update',
      payload: { annotation: await serializeAnnotation({ ...current, opacity: 0.5 }) },
    });
    const noteId = (log[2]?.payload as { annotation: { id: string } }).annotation.id;
    await record({
      id: 'd1',
      source: first,
      pageIndex: 0,
      kind: 'annotation.delete',
      payload: { annotationId: noteId },
    });

    // "Crash": a fresh adapter opens the original bytes and replays the (JSON) log.
    const recovered = new PdfiumAdapter({ wasmUrl });
    try {
      const second = sid('recovered');
      await recovered.open(second, blank.slice(0));
      const json = JSON.parse(
        JSON.stringify(log.map((e) => ({ ...e, source: second }))),
      ) as EngineEdit[];
      const result = await replayEngineEdits(recovered, json);
      expect(result.failed).toEqual([]);
      expect(result.applied).toHaveLength(5);
      for (const page of [0, 1]) {
        expect(comparable(await recovered.listAnnotations(second, page))).toEqual(
          comparable(await adapter.listAnnotations(first, page)),
        );
      }
      const ids = annotationIdsOfEdits(json).get(second);
      expect(ids && [...ids].sort()).toEqual(
        log
          .slice(0, 3)
          .map((e) => (e.payload as { annotation: { id: string } }).annotation.id)
          .sort(),
      );
      // A failing edit stops the replay by default and is skipped on request.
      const broken: EngineEdit = {
        id: 'bad',
        source: second,
        pageIndex: 0,
        kind: 'annotation.delete',
        payload: { annotationId: 'does-not-exist' },
      };
      const stopped = await replayEngineEdits(recovered, [broken, json[0] as EngineEdit]);
      expect(stopped.failed.map((f) => f.edit.id)).toEqual(['bad']);
      expect(stopped.applied).toHaveLength(0);
    } finally {
      await recovered.destroy();
    }
    await adapter.close(first);
  });
});
