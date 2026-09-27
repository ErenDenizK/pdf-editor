/**
 * JSON persistence of a Workspace (crash recovery, session restore). Bytes are never
 * included: sources are persisted separately by the app and matched by SourceId.
 * Input is validated field by field and rebuilt, so unknown properties are dropped.
 */
import { DocumentModelError } from './errors';
import { checkWorkspaceInvariants } from './invariants';
import { PAGE_LABEL_STYLES } from './labels';
import type {
  Anchor,
  BlobId,
  Destination,
  DestinationView,
  DocumentId,
  DocumentMetadata,
  EngineEdit,
  FontSpec,
  FormMergePolicy,
  OutlineNode,
  OverlayOp,
  PageId,
  PageLabelRange,
  PageLabelStyle,
  PageRef,
  PermissionFlags,
  Rect,
  RgbColor,
  Rotation,
  SecurityPolicy,
  Size,
  SourceDocument,
  SourceFlags,
  SourceId,
  SourcePageInfo,
  VirtualDocument,
  VirtualPage,
  Workspace,
} from './types';

export const SERIALIZATION_VERSION = 1;

export interface SerializedWorkspaceV1 {
  readonly version: 1;
  readonly sources: readonly SourceDocument[];
  /** In tab order. */
  readonly documents: readonly VirtualDocument[];
  readonly activeDocument?: DocumentId;
  readonly engineEdits: readonly EngineEdit[];
}

/** Returns a JSON-safe value; pass it to JSON.stringify for storage. */
export function serializeWorkspace(ws: Workspace): SerializedWorkspaceV1 {
  const base = {
    version: 1 as const,
    sources: Object.values<SourceDocument>(ws.sources),
    documents: ws.documentOrder.map((id) => {
      const doc = ws.documents[id];
      if (doc === undefined) {
        throw new DocumentModelError('invariant-violation', `Tab ${id} has no document`);
      }
      return doc;
    }),
    engineEdits: ws.engineEdits,
  };
  return ws.activeDocument === undefined ? base : { ...base, activeDocument: ws.activeDocument };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

type Obj = Readonly<Record<string, unknown>>;

function fail(path: string, expected: string): never {
  throw new DocumentModelError('invalid-serialized', `${path}: expected ${expected}`);
}

function obj(value: unknown, path: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'an object');
  return value as Obj;
}

function arr(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, 'an array');
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'a string');
  return value;
}

function nonEmpty(value: unknown, path: string): string {
  const s = str(value, path);
  if (s.length === 0) fail(path, 'a non-empty string');
  return s;
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a finite number');
  return value;
}

function int(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value)) fail(path, 'an integer');
  return value as number;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'a boolean');
  return value;
}

function oneOf<T extends string | number>(value: unknown, options: readonly T[], path: string): T {
  if (!options.includes(value as T)) fail(path, `one of ${options.join(', ')}`);
  return value as T;
}

/** Reads an optional property; returns a spreadable object ({} when absent). */
function opt<K extends string, T>(
  o: Obj,
  key: K,
  path: string,
  read: (value: unknown, path: string) => T,
): Partial<Record<K, T>> {
  const value = o[key];
  if (value === undefined) return {};
  return { [key]: read(value, `${path}.${key}`) } as Partial<Record<K, T>>;
}

function jsonValue(value: unknown, path: string, depth = 0): unknown {
  if (depth > 64) fail(path, 'JSON nested at most 64 levels');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return num(value, path);
  if (Array.isArray(value)) return value.map((v, i) => jsonValue(v, `${path}[${i}]`, depth + 1));
  const o = obj(value, path);
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, jsonValue(v, `${path}.${k}`, depth + 1)]),
  );
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];
const ANCHORS: readonly Anchor[] = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

function readSize(value: unknown, path: string): Size {
  const o = obj(value, path);
  return { width: num(o.width, `${path}.width`), height: num(o.height, `${path}.height`) };
}

function readRect(value: unknown, path: string): Rect {
  const o = obj(value, path);
  return {
    x: num(o.x, `${path}.x`),
    y: num(o.y, `${path}.y`),
    width: num(o.width, `${path}.width`),
    height: num(o.height, `${path}.height`),
  };
}

function readRotation(value: unknown, path: string): Rotation {
  return oneOf(value, ROTATIONS, path);
}

function readSourcePage(value: unknown, path: string): SourcePageInfo {
  const o = obj(value, path);
  return {
    size: readSize(o.size, `${path}.size`),
    rotation: readRotation(o.rotation, `${path}.rotation`),
    ...opt(o, 'label', path, str),
  };
}

function readFlags(value: unknown, path: string): SourceFlags {
  const o = obj(value, path);
  const flag = (key: keyof SourceFlags): boolean => bool(o[key], `${path}.${key}`);
  return {
    encrypted: flag('encrypted'),
    repaired: flag('repaired'),
    hasAcroForm: flag('hasAcroForm'),
    hasXfa: flag('hasXfa'),
    hasSignatures: flag('hasSignatures'),
    tagged: flag('tagged'),
    linearized: flag('linearized'),
  };
}

function readSource(value: unknown, path: string): SourceDocument {
  const o = obj(value, path);
  return {
    id: nonEmpty(o.id, `${path}.id`) as SourceId,
    name: str(o.name, `${path}.name`),
    byteLength: int(o.byteLength, `${path}.byteLength`),
    pageCount: int(o.pageCount, `${path}.pageCount`),
    pages: arr(o.pages, `${path}.pages`).map((p, i) => readSourcePage(p, `${path}.pages[${i}]`)),
    fingerprint: str(o.fingerprint, `${path}.fingerprint`),
    flags: readFlags(o.flags, `${path}.flags`),
  };
}

function readPageRef(value: unknown, path: string): PageRef {
  const o = obj(value, path);
  switch (o.kind) {
    case 'source':
      return {
        kind: 'source',
        source: nonEmpty(o.source, `${path}.source`) as SourceId,
        index: int(o.index, `${path}.index`),
      };
    case 'blank':
      return { kind: 'blank', size: readSize(o.size, `${path}.size`) };
    case 'image':
      return {
        kind: 'image',
        blob: nonEmpty(o.blob, `${path}.blob`) as BlobId,
        size: readSize(o.size, `${path}.size`),
      };
    default:
      return fail(`${path}.kind`, "'source', 'blank' or 'image'");
  }
}

function readOffset(value: unknown, path: string): { x: number; y: number } {
  const o = obj(value, path);
  return { x: num(o.x, `${path}.x`), y: num(o.y, `${path}.y`) };
}

function readFont(value: unknown, path: string): FontSpec {
  const o = obj(value, path);
  return {
    family: str(o.family, `${path}.family`),
    size: num(o.size, `${path}.size`),
    ...opt(o, 'weight', path, (v, p) => oneOf(v, [400, 700] as const, p)),
    ...opt(o, 'italic', path, bool),
  };
}

function readColor(value: unknown, path: string): RgbColor {
  const o = obj(value, path);
  return { r: num(o.r, `${path}.r`), g: num(o.g, `${path}.g`), b: num(o.b, `${path}.b`) };
}

function readOverlay(value: unknown, path: string): OverlayOp {
  const o = obj(value, path);
  const common = {
    layer: oneOf(o.layer, ['behind', 'over'] as const, `${path}.layer`),
    anchor: oneOf(o.anchor, ANCHORS, `${path}.anchor`),
    offset: readOffset(o.offset, `${path}.offset`),
    opacity: num(o.opacity, `${path}.opacity`),
    ...opt(o, 'rotate', path, num),
  };
  if (o.kind === 'text') {
    return {
      kind: 'text',
      ...common,
      template: str(o.template, `${path}.template`),
      font: readFont(o.font, `${path}.font`),
      color: readColor(o.color, `${path}.color`),
    };
  }
  if (o.kind === 'image') {
    return {
      kind: 'image',
      ...common,
      blob: nonEmpty(o.blob, `${path}.blob`) as BlobId,
      scale: num(o.scale, `${path}.scale`),
      ...opt(o, 'tile', path, (v, p) => readTile(v, p)),
    };
  }
  return fail(`${path}.kind`, "'text' or 'image'");
}

function readTile(value: unknown, path: string): { gapX: number; gapY: number } {
  const o = obj(value, path);
  return { gapX: num(o.gapX, `${path}.gapX`), gapY: num(o.gapY, `${path}.gapY`) };
}

function readPage(value: unknown, path: string): VirtualPage {
  const o = obj(value, path);
  return {
    id: nonEmpty(o.id, `${path}.id`) as PageId,
    ref: readPageRef(o.ref, `${path}.ref`),
    rotation: readRotation(o.rotation, `${path}.rotation`),
    ...opt(o, 'cropBox', path, readRect),
    overlays: arr(o.overlays, `${path}.overlays`).map((v, i) =>
      readOverlay(v, `${path}.overlays[${i}]`),
    ),
  };
}

function readView(value: unknown, path: string): DestinationView {
  const o = obj(value, path);
  return {
    fit: oneOf(o.fit, ['xyz', 'fit', 'fit-h', 'fit-v', 'fit-r'] as const, `${path}.fit`),
    ...opt(o, 'left', path, num),
    ...opt(o, 'top', path, num),
    ...opt(o, 'zoom', path, num),
    ...opt(o, 'rect', path, readRect),
  };
}

function readDestination(value: unknown, path: string): Destination {
  const o = obj(value, path);
  switch (o.kind) {
    case 'page':
      return {
        kind: 'page',
        page: nonEmpty(o.page, `${path}.page`) as PageId,
        ...opt(o, 'view', path, readView),
      };
    case 'uri':
      return { kind: 'uri', uri: str(o.uri, `${path}.uri`) };
    case 'unresolved':
      return {
        kind: 'unresolved',
        reason: str(o.reason, `${path}.reason`),
        ...opt(o, 'previous', path, (v, p) => {
          const prev = obj(v, p);
          return {
            page: nonEmpty(prev.page, `${p}.page`) as PageId,
            ...opt(prev, 'view', p, readView),
          };
        }),
      };
    default:
      return fail(`${path}.kind`, "'page', 'uri' or 'unresolved'");
  }
}

function readOutlineNode(value: unknown, path: string, depth: number): OutlineNode {
  if (depth > 256) fail(path, 'an outline nested at most 256 levels');
  const o = obj(value, path);
  return {
    title: str(o.title, `${path}.title`),
    ...opt(o, 'destination', path, readDestination),
    open: bool(o.open, `${path}.open`),
    children: arr(o.children, `${path}.children`).map((c, i) =>
      readOutlineNode(c, `${path}.children[${i}]`, depth + 1),
    ),
    ...opt(o, 'origin', path, (v, p) => ({
      source: nonEmpty(obj(v, p).source, `${p}.source`) as SourceId,
    })),
  };
}

function readLabelRange(value: unknown, path: string): PageLabelRange {
  const o = obj(value, path);
  return {
    startIndex: int(o.startIndex, `${path}.startIndex`),
    style: oneOf<PageLabelStyle>(o.style, PAGE_LABEL_STYLES, `${path}.style`),
    ...opt(o, 'prefix', path, str),
    ...opt(o, 'firstNumber', path, int),
  };
}

function readMetadata(value: unknown, path: string): DocumentMetadata {
  const o = obj(value, path);
  return {
    ...opt(o, 'title', path, str),
    ...opt(o, 'author', path, str),
    ...opt(o, 'subject', path, str),
    ...opt(o, 'keywords', path, str),
    ...opt(o, 'creator', path, str),
    ...opt(o, 'producer', path, str),
    ...opt(o, 'creationDate', path, str),
    ...opt(o, 'modificationDate', path, str),
    ...opt(o, 'language', path, str),
    policy: oneOf(o.policy, ['inherit-first-source', 'explicit'] as const, `${path}.policy`),
  };
}

function readPermissions(value: unknown, path: string): PermissionFlags {
  const o = obj(value, path);
  const flag = (key: keyof PermissionFlags): boolean => bool(o[key], `${path}.${key}`);
  return {
    print: flag('print'),
    printHighQuality: flag('printHighQuality'),
    modify: flag('modify'),
    copy: flag('copy'),
    annotate: flag('annotate'),
    fillForms: flag('fillForms'),
    accessibility: flag('accessibility'),
    assemble: flag('assemble'),
  };
}

function readSecurity(value: unknown, path: string): SecurityPolicy {
  const o = obj(value, path);
  return {
    algorithm: oneOf(o.algorithm, ['aes-256'] as const, `${path}.algorithm`),
    ...opt(o, 'userPassword', path, str),
    ...opt(o, 'ownerPassword', path, str),
    permissions: readPermissions(o.permissions, `${path}.permissions`),
  };
}

const FORM_POLICIES: readonly FormMergePolicy[] = [
  'namespace-by-source',
  'rename-collisions',
  'unify-same-name',
];

function readDocument(value: unknown, path: string): VirtualDocument {
  const o = obj(value, path);
  return {
    id: nonEmpty(o.id, `${path}.id`) as DocumentId,
    title: str(o.title, `${path}.title`),
    pages: arr(o.pages, `${path}.pages`).map((p, i) => readPage(p, `${path}.pages[${i}]`)),
    outline: arr(o.outline, `${path}.outline`).map((n, i) =>
      readOutlineNode(n, `${path}.outline[${i}]`, 0),
    ),
    labels: arr(o.labels, `${path}.labels`).map((r, i) =>
      readLabelRange(r, `${path}.labels[${i}]`),
    ),
    metadata: readMetadata(o.metadata, `${path}.metadata`),
    ...opt(o, 'security', path, readSecurity),
    formMergePolicy: oneOf(o.formMergePolicy, FORM_POLICIES, `${path}.formMergePolicy`),
    clean: bool(o.clean, `${path}.clean`),
  };
}

const EDIT_KINDS: readonly EngineEdit['kind'][] = [
  'annotation.create',
  'annotation.update',
  'annotation.delete',
  'form.set-value',
  'redaction.mark',
  'redaction.apply',
];

function readEdit(value: unknown, path: string, depth = 0): EngineEdit {
  if (depth > 8) fail(path, 'inverse edits nested at most 8 levels');
  const o = obj(value, path);
  return {
    id: nonEmpty(o.id, `${path}.id`),
    source: nonEmpty(o.source, `${path}.source`) as SourceId,
    pageIndex: int(o.pageIndex, `${path}.pageIndex`),
    kind: oneOf(o.kind, EDIT_KINDS, `${path}.kind`),
    payload: jsonValue(o.payload ?? null, `${path}.payload`),
    ...opt(o, 'inverse', path, (v, p) => readEdit(v, p, depth + 1)),
  };
}

function uniqueRecord<K extends string, V extends { readonly id: K }>(
  items: readonly V[],
  what: string,
): Record<K, V> {
  const entries = items.map((item) => [item.id, item] as const);
  if (new Set(entries.map(([id]) => id)).size !== entries.length) {
    throw new DocumentModelError('invalid-serialized', `Duplicate ${what} id`);
  }
  return Object.fromEntries(entries) as Record<K, V>;
}

/**
 * Validates and rebuilds a workspace from `serializeWorkspace` output (or its JSON text).
 * Throws `invalid-serialized` on malformed input and `unsupported-version` for unknown
 * versions.
 */
export function deserializeWorkspace(input: unknown): Workspace {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (cause) {
      throw new DocumentModelError('invalid-serialized', 'Input is not valid JSON', { cause });
    }
  }
  const root = obj(value, '$');
  if (root.version !== SERIALIZATION_VERSION) {
    throw new DocumentModelError(
      'unsupported-version',
      `Unsupported workspace version: ${String(root.version)}`,
    );
  }
  const sources = arr(root.sources, '$.sources').map((s, i) => readSource(s, `$.sources[${i}]`));
  const documents = arr(root.documents, '$.documents').map((d, i) =>
    readDocument(d, `$.documents[${i}]`),
  );
  const engineEdits = arr(root.engineEdits, '$.engineEdits').map((e, i) =>
    readEdit(e, `$.engineEdits[${i}]`),
  );
  const base: Workspace = {
    sources: uniqueRecord<SourceId, SourceDocument>(sources, 'source'),
    documents: uniqueRecord<DocumentId, VirtualDocument>(documents, 'document'),
    documentOrder: documents.map((d) => d.id),
    engineEdits,
  };
  const workspace: Workspace =
    root.activeDocument === undefined
      ? base
      : {
          ...base,
          activeDocument: nonEmpty(root.activeDocument, '$.activeDocument') as DocumentId,
        };
  const problems = checkWorkspaceInvariants(workspace);
  if (problems.length > 0) {
    throw new DocumentModelError(
      'invalid-serialized',
      `Inconsistent workspace: ${problems.join('; ')}`,
    );
  }
  return workspace;
}
