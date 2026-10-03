/**
 * JSON payloads of `EngineEdit`s (document-model types.ts) as this engine writes and reads
 * them. `EngineEdit.payload` is engine-neutral JSON, so annotation image blobs travel as
 * base64 and `undefined` form values as `null`.
 *
 * | kind                | payload                                        | inverse            |
 * | ------------------- | ---------------------------------------------- | ------------------ |
 * | `annotation.create` | `{ annotation: SerializedNewAnnotation }`      | `annotation.delete`|
 * | `annotation.update` | `{ annotation: SerializedAnnotation }` (full)  | update to before   |
 * | `annotation.delete` | `{ annotationId: string }`                     | create with the id |
 * | `form.set-value`    | `{ name: string, value: FormValueJson }`       | the previous value |
 *
 * `EngineEdit.pageIndex` is the annotation's page (forms: the field's first widget page).
 */

import {
  type Annotation,
  type DistributiveOmit,
  EngineError,
  type FormField,
  type NewAnnotation,
} from '../types';

export interface SerializedImage {
  /** MIME type: image/png, image/jpeg or application/pdf (a stamp appearance). */
  readonly type: string;
  readonly base64: string;
}

/** An `Annotation` as JSON: a stamp's `imageBlob` becomes `image`. */
export type SerializedAnnotation = DistributiveOmit<Annotation, 'imageBlob'> & {
  readonly image?: SerializedImage;
};

/** A `NewAnnotation` as JSON; `id`, when present, is the /NM to create it with. */
export type SerializedNewAnnotation = DistributiveOmit<SerializedAnnotation, 'id'> & {
  readonly id?: string;
};

export type FormValueJson = string | readonly string[] | boolean | null;

export interface AnnotationCreatePayload {
  readonly annotation: SerializedNewAnnotation;
}
export interface AnnotationUpdatePayload {
  readonly annotation: SerializedAnnotation;
  /**
   * A pen burst append (craft spec §5.3 item 8): `annotation` is an Ink that is `before` plus
   * one path at the end. The editor appends that path in place (`PdfEditor.appendInkPath`)
   * and the inverse is `before`, so the page is not listed. Only on the way in: the applied
   * (recorded) edit carries `annotation` alone, which replays as an ordinary update.
   */
  readonly inkAppend?: { readonly before: SerializedAnnotation };
}
export interface AnnotationDeletePayload {
  readonly annotationId: string;
}
export interface FormSetValuePayload {
  readonly name: string;
  readonly value: FormValueJson;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** JSON copy of an annotation (drops `undefined`s; the blob is read and encoded). */
export async function serializeAnnotation(
  annotation: NewAnnotation | Annotation,
): Promise<SerializedNewAnnotation> {
  const { imageBlob, ...rest } = annotation as NewAnnotation & { imageBlob?: Blob };
  const json = JSON.parse(JSON.stringify(rest)) as SerializedNewAnnotation;
  if (!imageBlob) return json;
  const bytes = new Uint8Array(await imageBlob.arrayBuffer());
  return {
    ...json,
    image: { type: imageBlob.type || 'application/octet-stream', base64: toBase64(bytes) },
  };
}

/** Back to an engine annotation (the image becomes a Blob again). */
export function deserializeAnnotation(json: SerializedNewAnnotation): NewAnnotation {
  const { image, ...rest } = json;
  if (!image) return rest;
  return {
    ...rest,
    imageBlob: new Blob([fromBase64(image.base64)], { type: image.type }),
  } as NewAnnotation;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(kind: string, why: string): EngineError {
  return new EngineError('internal', `Invalid ${kind} payload: ${why}`);
}

export function readAnnotationPayload(kind: string, payload: unknown): SerializedNewAnnotation {
  if (!isObject(payload) || !isObject(payload.annotation)) {
    throw invalid(kind, 'expected { annotation }');
  }
  const annotation = payload.annotation;
  if (typeof annotation.kind !== 'string' || !isObject(annotation.rect)) {
    throw invalid(kind, 'annotation needs kind and rect');
  }
  return annotation as unknown as SerializedNewAnnotation;
}

export function readDeletePayload(payload: unknown): AnnotationDeletePayload {
  if (
    !isObject(payload) ||
    typeof payload.annotationId !== 'string' ||
    payload.annotationId === ''
  ) {
    throw invalid('annotation.delete', 'expected { annotationId }');
  }
  return { annotationId: payload.annotationId };
}

export function readFormPayload(payload: unknown): FormSetValuePayload {
  if (!isObject(payload) || typeof payload.name !== 'string') {
    throw invalid('form.set-value', 'expected { name, value }');
  }
  const value = payload.value ?? null;
  const ok =
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((v) => typeof v === 'string'));
  if (!ok) throw invalid('form.set-value', 'value must be a string, string[], boolean or null');
  return { name: payload.name, value };
}

export function formValueToJson(value: FormField['value']): FormValueJson {
  return value ?? null;
}

export function formValueFromJson(value: FormValueJson): FormField['value'] {
  return value ?? undefined;
}
