/**
 * The engine edit log (ARCHITECTURE.md §4, spec viewer-annotations.md §5): applies
 * `EngineEdit`s to an open source through `PdfEditor` and computes their inverses, so
 * history can undo and redo content edits without byte snapshots, and a workspace
 * restored after a crash can replay its edits onto freshly opened sources.
 *
 * Id policy: annotation creates carry the /NM to use (`annotation.id`). The PDFium adapter
 * honours it (EmbedPDF writes the given id as /NM; covered by the tests), so an undone
 * delete, a redone create and a replay all restore the same id. A create without an id
 * gets one from the engine; `applyEngineEditWithResult` returns the edit with that id
 * filled in (`applied`), which is what the caller records. Should an engine ever answer
 * with a different id than requested, `applied` carries the engine's id and callers remap.
 */

import type { EngineEdit } from '@pdf-editor/document-model';

import { type Annotation, type EngineCallOptions, EngineError, type PdfEditor } from '../types';
import {
  type AnnotationCreatePayload,
  type AnnotationDeletePayload,
  type AnnotationUpdatePayload,
  deserializeAnnotation,
  type FormSetValuePayload,
  formValueFromJson,
  formValueToJson,
  readAnnotationPayload,
  readDeletePayload,
  readFormPayload,
  type SerializedAnnotation,
  serializeAnnotation,
} from './payloads';

/** The parts of `PdfEditor` edits use (`getAnnotationAppearance` for stamps). */
export type EditTarget = Pick<
  PdfEditor,
  | 'listAnnotations'
  | 'createAnnotation'
  | 'updateAnnotation'
  | 'deleteAnnotation'
  | 'listFormFields'
  | 'setFormFieldValue'
  | 'getAnnotationAppearance'
>;

export interface AppliedEdit {
  /** The edit as applied: a create's payload carries the annotation id actually used. */
  readonly applied: EngineEdit;
  /** Undoes `applied`; its own `inverse` is `applied` (redo). */
  readonly inverse: EngineEdit;
  /** The annotation after the edit (creates and updates). */
  readonly annotation?: Annotation;
}

const UNDO_SUFFIX = ':undo';

function inverseId(id: string): string {
  return id.endsWith(UNDO_SUFFIX) ? id.slice(0, -UNDO_SUFFIX.length) : `${id}${UNDO_SUFFIX}`;
}

function inverseOf(applied: EngineEdit, kind: EngineEdit['kind'], payload: unknown): EngineEdit {
  const { inverse: _drop, ...forward } = applied;
  return {
    id: inverseId(applied.id),
    source: applied.source,
    pageIndex: applied.pageIndex,
    kind,
    payload,
    inverse: forward,
  };
}

async function findAnnotation(
  editor: EditTarget,
  edit: EngineEdit,
  annotationId: string,
  options: EngineCallOptions,
): Promise<Annotation> {
  const listed = await editor.listAnnotations(edit.source, edit.pageIndex, options);
  const found = listed.find((a) => a.id === annotationId);
  if (!found) {
    throw new EngineError(
      'internal',
      `Edit ${edit.id}: annotation ${annotationId} not found on page ${edit.pageIndex}`,
    );
  }
  return found;
}

/** The current state of an annotation, with a stamp's appearance so it can be recreated. */
async function snapshot(
  editor: EditTarget,
  edit: EngineEdit,
  annotation: Annotation,
  options: EngineCallOptions,
): Promise<Annotation> {
  if (annotation.kind !== 'stamp' || !editor.getAnnotationAppearance) return annotation;
  const imageBlob = await editor.getAnnotationAppearance(
    edit.source,
    edit.pageIndex,
    annotation.id,
    options,
  );
  return { ...annotation, imageBlob };
}

/** Applies `edit` and returns the applied edit and its inverse. */
export async function applyEngineEditWithResult(
  editor: EditTarget,
  edit: EngineEdit,
  options: EngineCallOptions = {},
): Promise<AppliedEdit> {
  switch (edit.kind) {
    case 'annotation.create': {
      const json = readAnnotationPayload(edit.kind, edit.payload);
      const annotation = deserializeAnnotation(json);
      if (annotation.pageIndex !== edit.pageIndex) {
        throw new EngineError('internal', `Edit ${edit.id}: page index mismatch`);
      }
      const created = await editor.createAnnotation(edit.source, annotation, options);
      const payload: AnnotationCreatePayload = { annotation: { ...json, id: created.id } };
      const applied: EngineEdit = { ...edit, payload };
      const inverse: AnnotationDeletePayload = { annotationId: created.id };
      return {
        applied,
        inverse: inverseOf(applied, 'annotation.delete', inverse),
        annotation: created,
      };
    }
    case 'annotation.update': {
      const json = readAnnotationPayload(edit.kind, edit.payload) as SerializedAnnotation;
      if (typeof json.id !== 'string') {
        throw new EngineError('internal', `Edit ${edit.id}: an update needs the annotation id`);
      }
      const before = await findAnnotation(editor, edit, json.id, options);
      // The old image is only needed when the update replaces it.
      const previous =
        'image' in json && json.image ? await snapshot(editor, edit, before, options) : before;
      const next = deserializeAnnotation(json) as Annotation;
      const updated = await editor.updateAnnotation(edit.source, next, options);
      const inverse: AnnotationUpdatePayload = {
        annotation: (await serializeAnnotation(previous)) as SerializedAnnotation,
      };
      return {
        applied: edit,
        inverse: inverseOf(edit, 'annotation.update', inverse),
        annotation: updated,
      };
    }
    case 'annotation.delete': {
      const { annotationId } = readDeletePayload(edit.payload);
      const before = await snapshot(
        editor,
        edit,
        await findAnnotation(editor, edit, annotationId, options),
        options,
      );
      await editor.deleteAnnotation(edit.source, edit.pageIndex, annotationId, options);
      const inverse: AnnotationCreatePayload = {
        annotation: await serializeAnnotation(before),
      };
      return { applied: edit, inverse: inverseOf(edit, 'annotation.create', inverse) };
    }
    case 'form.set-value': {
      const { name, value } = readFormPayload(edit.payload);
      const fields = await editor.listFormFields(edit.source, options);
      const field = fields.find((f) => f.name === name);
      if (!field)
        throw new EngineError('internal', `Edit ${edit.id}: form field ${name} not found`);
      await editor.setFormFieldValue(edit.source, name, formValueFromJson(value), options);
      const inverse: FormSetValuePayload = { name, value: formValueToJson(field.value) };
      return { applied: edit, inverse: inverseOf(edit, 'form.set-value', inverse) };
    }
    case 'redaction.mark':
    case 'redaction.apply':
      throw new EngineError(
        'unsupported',
        `${edit.kind} edits are not replayable yet (redaction is M4); use PdfEditor directly`,
      );
  }
}

/** Applies `edit`; resolves to its inverse (whose `inverse` is the applied edit). */
export async function applyEngineEdit(
  editor: EditTarget,
  edit: EngineEdit,
  options: EngineCallOptions = {},
): Promise<EngineEdit> {
  return (await applyEngineEditWithResult(editor, edit, options)).inverse;
}

export interface ReplayResult {
  /** Edits applied, in order, as `applyEngineEditWithResult` reported them. */
  readonly applied: readonly AppliedEdit[];
  /** Edits that failed (with `onError: 'skip'`; with 'stop' at most one, the last). */
  readonly failed: readonly { readonly edit: EngineEdit; readonly error: EngineError }[];
}

export interface ReplayOptions extends EngineCallOptions {
  /** `stop` (default) ends the replay at the first failure; `skip` continues. */
  readonly onError?: 'stop' | 'skip';
}

/**
 * Re-applies a workspace's recorded edits, in order, onto freshly opened sources (crash
 * recovery). Never rejects for a failing edit (see `onError`); rejects only when aborted.
 */
export async function replayEngineEdits(
  editor: EditTarget,
  edits: readonly EngineEdit[],
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const applied: AppliedEdit[] = [];
  const failed: { edit: EngineEdit; error: EngineError }[] = [];
  for (const edit of edits) {
    if (options.signal?.aborted) throw new EngineError('aborted', 'replay aborted');
    try {
      applied.push(await applyEngineEditWithResult(editor, edit, options));
    } catch (cause) {
      const error =
        cause instanceof EngineError
          ? cause
          : new EngineError('internal', cause instanceof Error ? cause.message : String(cause), {
              cause,
            });
      if (error.code === 'aborted') throw error;
      failed.push({ edit, error });
      if ((options.onError ?? 'stop') === 'stop') break;
    }
  }
  return { applied, failed };
}

/**
 * Annotation ids (/NM) the edits create or change, per source: what export verification
 * holds to the conformance rules. Unknown payloads are ignored.
 */
export function annotationIdsOfEdits(edits: readonly EngineEdit[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const edit of edits) {
    if (edit.kind !== 'annotation.create' && edit.kind !== 'annotation.update') continue;
    const payload = edit.payload as { annotation?: { id?: unknown } } | null;
    const id = payload?.annotation?.id;
    if (typeof id !== 'string' || id === '') continue;
    let ids = out.get(edit.source);
    if (!ids) {
      ids = new Set();
      out.set(edit.source, ids);
    }
    ids.add(id);
  }
  return out;
}
