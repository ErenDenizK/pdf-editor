/**
 * Document-level settings the export applies: metadata (Info / XMP), "Strip metadata" and
 * the security policy (spec document-tools.md §3, §4). Each function returns the workspace
 * unchanged when nothing changes, so a no-op edit never becomes a history entry.
 */
import { DocumentModelError } from './errors';
import { putDocuments, requireDocument, withWorkspace } from './internal';
import type {
  DocumentId,
  DocumentMetadata,
  MetadataStrip,
  PermissionFlags,
  SecurityPolicy,
  VirtualDocument,
  Workspace,
} from './types';

/** Text fields of the Info dictionary the user can edit. */
export const METADATA_TEXT_FIELDS = [
  'title',
  'author',
  'subject',
  'keywords',
  'creator',
  'language',
] as const;

export type MetadataTextField = (typeof METADATA_TEXT_FIELDS)[number];

/**
 * A metadata change: a string sets a field (an empty string after trimming removes it),
 * `null` removes it, an absent key leaves it. `custom` replaces the whole custom-key map.
 */
export type MetadataPatch = Readonly<Partial<Record<MetadataTextField, string | null>>> & {
  readonly custom?: Readonly<Record<string, string>> | null;
};

/** Info keys the PDF standard defines; they cannot be used as custom keys. */
export const STANDARD_INFO_KEYS: readonly string[] = [
  'Title',
  'Author',
  'Subject',
  'Keywords',
  'Creator',
  'Producer',
  'CreationDate',
  'ModDate',
  'Trapped',
];

export const MAX_CUSTOM_KEY_LENGTH = 64;

export type CustomKeyProblem = 'empty' | 'invalid' | 'reserved' | 'duplicate' | 'too-long';

/**
 * Why `key` cannot be a custom Info key, or undefined when it can. Keys are restricted to
 * names that are also valid XML names, so they can be mirrored in XMP (`pdfx:` namespace)
 * without escaping: a letter or underscore, then letters, digits, `_`, `-` or `.`.
 */
export function customKeyProblem(
  key: string,
  existing: readonly string[] = [],
): CustomKeyProblem | undefined {
  if (key.length === 0) return 'empty';
  if (key.length > MAX_CUSTOM_KEY_LENGTH) return 'too-long';
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) return 'invalid';
  if (STANDARD_INFO_KEYS.some((k) => k.toLowerCase() === key.toLowerCase())) return 'reserved';
  if (key.toLowerCase().startsWith('xml')) return 'reserved';
  if (existing.some((k) => k.toLowerCase() === key.toLowerCase())) return 'duplicate';
  return undefined;
}

/**
 * Well-formedness of a BCP 47 language tag (RFC 5646 §2.1, simplified): a 2–3 letter
 * primary language (or 4–8 letters, or `i`/`x` private use), then subtags of 1–8
 * alphanumerics. Not a registry lookup.
 */
export function isLanguageTag(tag: string): boolean {
  return /^(?:[A-Za-z]{2,3}|[A-Za-z]{4,8}|[xXiI])(?:-[A-Za-z0-9]{1,8})*$/.test(tag);
}

/** Drops keys whose value is undefined (the model omits absent optional fields). */
function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function put(ws: Workspace, next: VirtualDocument): Workspace {
  return withWorkspace(ws, { documents: putDocuments(ws.documents, [{ ...next, clean: false }]) });
}

function sameRecord(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean {
  const ak = Object.keys(a ?? {});
  const bk = Object.keys(b ?? {});
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(b ?? {}, k) && a?.[k] === b?.[k]);
}

/**
 * Edits metadata fields. Any effective change switches the policy to `explicit`: from then
 * on the export writes what the model holds instead of the first source's Info. Throws
 * `invalid-argument` for a malformed language tag or custom key.
 */
export function setMetadata(
  ws: Workspace,
  documentId: DocumentId,
  patch: MetadataPatch,
): Workspace {
  const doc = requireDocument(ws, documentId);
  const current = doc.metadata;
  const next: Record<string, unknown> = { ...current };
  for (const field of METADATA_TEXT_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue;
    const raw = patch[field];
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      throw new DocumentModelError('invalid-argument', `Metadata ${field} must be a string`);
    }
    const value = raw?.trim() ?? '';
    if (value === '') {
      next[field] = undefined;
      continue;
    }
    if (field === 'language' && !isLanguageTag(value)) {
      throw new DocumentModelError('invalid-argument', `Not a language tag: ${value}`);
    }
    next[field] = value;
  }
  if (Object.hasOwn(patch, 'custom')) {
    const custom = patch.custom ?? {};
    const keys: string[] = [];
    for (const [key, value] of Object.entries(custom)) {
      const problem = customKeyProblem(key, keys);
      if (problem !== undefined) {
        throw new DocumentModelError('invalid-argument', `Custom key "${key}": ${problem}`);
      }
      if (typeof value !== 'string') {
        throw new DocumentModelError('invalid-argument', `Custom key "${key}" needs a string`);
      }
      keys.push(key);
    }
    if (keys.length === 0) delete next.custom;
    else next.custom = { ...custom };
  }
  const changed =
    METADATA_TEXT_FIELDS.some((f) => next[f] !== current[f]) ||
    !sameRecord(next.custom as DocumentMetadata['custom'], current.custom);
  if (!changed) return ws;
  const metadata = withoutUndefined({ ...next, policy: 'explicit' }) as unknown as DocumentMetadata;
  return put(ws, { ...doc, metadata });
}

/** Everything "Strip metadata" can remove, selected. */
export const STRIP_ALL: MetadataStrip = {
  info: true,
  xmp: true,
  attachments: true,
  javascript: true,
  pieceInfo: true,
  thumbnails: true,
  annotationAuthors: true,
  customKeys: true,
};

/** Whether a strip configuration removes anything. */
export function stripsAnything(strip: MetadataStrip | undefined): boolean {
  return strip !== undefined && Object.values(strip).some(Boolean);
}

/**
 * Applies "Strip metadata": stores what the assembler removes at export. With `info` the
 * standard fields (not /Lang) are cleared in the model too, and with `customKeys` the
 * custom keys, so the Info panel shows what the export writes; the policy becomes
 * `explicit`. `undefined` (or nothing selected) clears a previous strip.
 */
export function setMetadataStrip(
  ws: Workspace,
  documentId: DocumentId,
  strip: MetadataStrip | undefined,
): Workspace {
  const doc = requireDocument(ws, documentId);
  const current = doc.metadata;
  if (!stripsAnything(strip)) {
    if (current.strip === undefined) return ws;
    const { strip: _removed, ...rest } = current;
    return put(ws, { ...doc, metadata: rest });
  }
  const selected = strip as MetadataStrip;
  const next: Record<string, unknown> = { ...current, policy: 'explicit', strip: { ...selected } };
  if (selected.info) {
    for (const key of [
      'title',
      'author',
      'subject',
      'keywords',
      'creator',
      'producer',
      'creationDate',
      'modificationDate',
    ]) {
      next[key] = undefined;
    }
  }
  if (selected.customKeys) next.custom = undefined;
  const metadata = withoutUndefined(next) as unknown as DocumentMetadata;
  const same =
    current.policy === 'explicit' &&
    current.strip !== undefined &&
    (Object.keys(selected) as (keyof MetadataStrip)[]).every(
      (k) => current.strip?.[k] === selected[k],
    ) &&
    Object.keys(metadata).length === Object.keys(current).length;
  if (same) return ws;
  return put(ws, { ...doc, metadata });
}

export const ALL_PERMISSIONS: PermissionFlags = {
  print: true,
  printHighQuality: true,
  modify: true,
  copy: true,
  annotate: true,
  fillForms: true,
  accessibility: true,
  assemble: true,
};

function samePolicy(a: SecurityPolicy | undefined, b: SecurityPolicy | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.algorithm === b.algorithm &&
    a.userPassword === b.userPassword &&
    a.ownerPassword === b.ownerPassword &&
    (Object.keys(ALL_PERMISSIONS) as (keyof PermissionFlags)[]).every(
      (k) => a.permissions[k] === b.permissions[k],
    )
  );
}

/**
 * Sets (or with `undefined` clears) the password policy applied at export. A policy needs a
 * user or an owner password; empty strings count as absent. Setting a policy clears
 * `passwordRemoved`.
 */
export function setSecurity(
  ws: Workspace,
  documentId: DocumentId,
  policy: SecurityPolicy | undefined,
): Workspace {
  const doc = requireDocument(ws, documentId);
  if (policy === undefined) {
    if (doc.security === undefined) return ws;
    const { security: _removed, ...rest } = doc;
    return put(ws, rest);
  }
  if (policy.algorithm !== 'aes-256') {
    throw new DocumentModelError(
      'unsupported',
      `Unsupported algorithm: ${JSON.stringify(policy.algorithm)}`,
    );
  }
  const user = policy.userPassword ?? '';
  const owner = policy.ownerPassword ?? '';
  if (user === '' && owner === '') {
    throw new DocumentModelError('invalid-argument', 'A user or an owner password is required');
  }
  const next: SecurityPolicy = {
    algorithm: 'aes-256',
    ...(user === '' ? {} : { userPassword: user }),
    ...(owner === '' ? {} : { ownerPassword: owner }),
    permissions: { ...policy.permissions },
  };
  if (samePolicy(doc.security, next) && doc.passwordRemoved !== true) return ws;
  const { passwordRemoved: _cleared, ...rest } = doc;
  return put(ws, { ...rest, security: next });
}

/**
 * "Remove password": clears the policy and records that encrypted sources are meant to be
 * exported without protection (`passwordRemoved`). Unchanged when there is neither a
 * policy nor an encrypted source.
 */
export function removePassword(ws: Workspace, documentId: DocumentId): Workspace {
  const doc = requireDocument(ws, documentId);
  const encrypted = doc.pages.some(
    (p) => p.ref.kind === 'source' && ws.sources[p.ref.source]?.flags.encrypted === true,
  );
  if (doc.security === undefined && (!encrypted || doc.passwordRemoved === true)) return ws;
  const { security: _removed, ...rest } = doc;
  return put(ws, encrypted ? { ...rest, passwordRemoved: true } : rest);
}
