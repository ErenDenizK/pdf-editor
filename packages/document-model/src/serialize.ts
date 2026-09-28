/**
 * JSON persistence of a Workspace (crash recovery, session restore). Bytes are never
 * included: sources are persisted separately by the app and matched by SourceId.
 * Input is validated field by field and rebuilt, so unknown properties are dropped.
 */
import { DocumentModelError } from './errors';
import { CREATED_FIELD_KINDS, FIELD_ALIGNS, FIELD_COLOR_KEYS } from './fields';
import { checkWorkspaceInvariants } from './invariants';
import { PAGE_LABEL_STYLES } from './labels';
import { RESIZE_MODES, resizeProblem } from './resize';
import type {
  Anchor,
  BatesConfig,
  BlobId,
  CreatedField,
  CreatedFieldValue,
  CreatedFieldWidget,
  Destination,
  DestinationView,
  DocumentId,
  DocumentMetadata,
  EngineEdit,
  FieldId,
  FontSpec,
  FormMergePolicy,
  OutlineNode,
  OverlayOp,
  OverlayPageRange,
  OverlayRole,
  PageId,
  PageLabelRange,
  PageLabelStyle,
  PageRef,
  PageResize,
  MetadataStrip,
  PermissionFlags,
  Rect,
  RgbColor,
  Rotation,
  SecurityHandler,
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
    ...opt(o, 'permissions', path, readPermissions),
    ...opt(o, 'securityHandler', path, (v, p) => oneOf(v, SECURITY_HANDLERS, p)),
    ...opt(o, 'passwordProtected', path, bool),
  };
}

const SECURITY_HANDLERS: readonly SecurityHandler[] = [
  'rc4-40',
  'rc4-128',
  'aes-128',
  'aes-256',
  'unknown',
];

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
    ...opt(o, 'tile', path, (v, p) => readTile(v, p)),
    ...opt(o, 'pages', path, readOverlayPages),
    ...opt(o, 'mirror', path, bool),
    ...opt(o, 'role', path, (v, p) => oneOf(v, OVERLAY_ROLES, p)),
  };
  if (o.kind === 'text') {
    return {
      kind: 'text',
      ...common,
      template: str(o.template, `${path}.template`),
      font: readFont(o.font, `${path}.font`),
      color: readColor(o.color, `${path}.color`),
      ...opt(o, 'startNumber', path, int),
    };
  }
  if (o.kind === 'image') {
    return {
      kind: 'image',
      ...common,
      blob: nonEmpty(o.blob, `${path}.blob`) as BlobId,
      scale: num(o.scale, `${path}.scale`),
    };
  }
  return fail(`${path}.kind`, "'text' or 'image'");
}

const OVERLAY_ROLES: readonly OverlayRole[] = [
  'page-number',
  'header',
  'footer',
  'bates',
  'watermark',
];

function readOverlayPages(value: unknown, path: string): OverlayPageRange {
  const o = obj(value, path);
  return {
    ...opt(o, 'from', path, int),
    ...opt(o, 'to', path, int),
    ...opt(o, 'parity', path, (v, p) => oneOf(v, ['odd', 'even'] as const, p)),
  };
}

function readBates(value: unknown, path: string): BatesConfig {
  const o = obj(value, path);
  return {
    prefix: str(o.prefix, `${path}.prefix`),
    width: int(o.width, `${path}.width`),
    start: int(o.start, `${path}.start`),
    suffix: str(o.suffix, `${path}.suffix`),
    ...opt(o, 'run', path, (v, p) => {
      const run = obj(v, p);
      return {
        id: nonEmpty(run.id, `${p}.id`),
        documents: arr(run.documents, `${p}.documents`).map(
          (d, i) => nonEmpty(d, `${p}.documents[${i}]`) as DocumentId,
        ),
      };
    }),
  };
}

function readTile(value: unknown, path: string): { gapX: number; gapY: number } {
  const o = obj(value, path);
  return { gapX: num(o.gapX, `${path}.gapX`), gapY: num(o.gapY, `${path}.gapY`) };
}

function readResize(value: unknown, path: string): PageResize {
  const o = obj(value, path);
  const resize: PageResize = {
    width: num(o.width, `${path}.width`),
    height: num(o.height, `${path}.height`),
    mode: oneOf(o.mode, RESIZE_MODES, `${path}.mode`),
    anchor: oneOf(o.anchor, ANCHORS, `${path}.anchor`),
    ...opt(o, 'stretch', path, bool),
  };
  const problem = resizeProblem(resize);
  if (problem !== undefined) fail(path, `a valid resize (${problem})`);
  return resize;
}

function readPage(value: unknown, path: string): VirtualPage {
  const o = obj(value, path);
  return {
    id: nonEmpty(o.id, `${path}.id`) as PageId,
    ref: readPageRef(o.ref, `${path}.ref`),
    rotation: readRotation(o.rotation, `${path}.rotation`),
    ...opt(o, 'cropBox', path, readRect),
    ...opt(o, 'resize', path, readResize),
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
    ...opt(o, 'custom', path, readStringRecord),
    policy: oneOf(o.policy, ['inherit-first-source', 'explicit'] as const, `${path}.policy`),
    ...opt(o, 'strip', path, readStrip),
  };
}

function readStringRecord(value: unknown, path: string): Record<string, string> {
  const o = obj(value, path);
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, str(v, `${path}.${k}`)]));
}

function readStrip(value: unknown, path: string): MetadataStrip {
  const o = obj(value, path);
  const flag = (key: keyof MetadataStrip): boolean => bool(o[key], `${path}.${key}`);
  return {
    info: flag('info'),
    xmp: flag('xmp'),
    attachments: flag('attachments'),
    javascript: flag('javascript'),
    pieceInfo: flag('pieceInfo'),
    thumbnails: flag('thumbnails'),
    annotationAuthors: flag('annotationAuthors'),
    customKeys: flag('customKeys'),
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
    ...opt(o, 'passwordRemoved', path, bool),
    formMergePolicy: oneOf(o.formMergePolicy, FORM_POLICIES, `${path}.formMergePolicy`),
    ...opt(o, 'bates', path, readBates),
    ...opt(o, 'furniture', path, (v, p) =>
      arr(v, p).map((overlay, i) => readOverlay(overlay, `${p}[${i}]`)),
    ),
    ...opt(o, 'fields', path, (v, p) => arr(v, p).map((f, i) => readField(f, `${p}[${i}]`))),
    clean: bool(o.clean, `${path}.clean`),
  };
}

function readFieldValue(value: unknown, path: string): CreatedFieldValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return arr(value, path).map((v, i) => str(v, `${path}[${i}]`));
}

function readFieldWidget(value: unknown, path: string): CreatedFieldWidget {
  const o = obj(value, path);
  return {
    page: nonEmpty(o.page, `${path}.page`) as PageId,
    rect: readRect(o.rect, `${path}.rect`),
    ...opt(o, 'exportValue', path, str),
  };
}

/** A created form field; semantic checks (options, values, names) run in the invariants. */
function readField(value: unknown, path: string): CreatedField {
  const o = obj(value, path);
  return {
    id: nonEmpty(o.id, `${path}.id`) as FieldId,
    kind: oneOf(o.kind, CREATED_FIELD_KINDS, `${path}.kind`),
    name: str(o.name, `${path}.name`),
    widgets: arr(o.widgets, `${path}.widgets`).map((w, i) =>
      readFieldWidget(w, `${path}.widgets[${i}]`),
    ),
    ...opt(o, 'tooltip', path, str),
    fontSize: o.fontSize === 'auto' ? 'auto' : num(o.fontSize, `${path}.fontSize`),
    border: oneOf(o.border, FIELD_COLOR_KEYS, `${path}.border`),
    background: oneOf(o.background, FIELD_COLOR_KEYS, `${path}.background`),
    required: bool(o.required, `${path}.required`),
    readOnly: bool(o.readOnly, `${path}.readOnly`),
    align: oneOf(o.align, FIELD_ALIGNS, `${path}.align`),
    ...opt(o, 'multiline', path, bool),
    ...opt(o, 'comb', path, bool),
    ...opt(o, 'maxLength', path, int),
    ...opt(o, 'options', path, (v, p) => arr(v, p).map((x, i) => str(x, `${p}[${i}]`))),
    ...opt(o, 'multiSelect', path, bool),
    ...opt(o, 'editable', path, bool),
    ...opt(o, 'label', path, str),
    ...opt(o, 'defaultValue', path, readFieldValue),
    ...opt(o, 'value', path, readFieldValue),
  };
}

const EDIT_KINDS: readonly EngineEdit['kind'][] = [
  'annotation.create',
  'annotation.update',
  'annotation.delete',
  'form.set-value',
  'redaction.mark',
  'redaction.apply',
  'text.edit',
  'image.transform',
  'image.remove',
  'image.replace',
  'ocr.apply',
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
