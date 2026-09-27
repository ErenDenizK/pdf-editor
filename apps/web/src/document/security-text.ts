/**
 * Words for passwords and permissions (spec document-tools.md §4), shared by the Info
 * panel, the dialogs and the export summary. Message functions are called at render time.
 */
import type {
  PermissionFlags,
  SecurityHandler,
  SecurityPolicy,
  SourceDocument,
  VirtualDocument,
  Workspace,
} from '@pdf-editor/document-model';

import { m } from '../i18n';

export const PERMISSION_KEYS: readonly (keyof PermissionFlags)[] = [
  'print',
  'printHighQuality',
  'modify',
  'copy',
  'annotate',
  'fillForms',
  'accessibility',
  'assemble',
];

export function permissionLabel(key: keyof PermissionFlags): string {
  switch (key) {
    case 'print':
      return m.permission_print();
    case 'printHighQuality':
      return m.permission_print_high();
    case 'modify':
      return m.permission_modify();
    case 'copy':
      return m.permission_copy();
    case 'annotate':
      return m.permission_annotate();
    case 'fillForms':
      return m.permission_fill_forms();
    case 'accessibility':
      return m.permission_accessibility();
    case 'assemble':
      return m.permission_assemble();
  }
}

/** Permissions the flags do not grant, in display order. */
export function restrictedPermissions(flags: PermissionFlags): (keyof PermissionFlags)[] {
  return PERMISSION_KEYS.filter((key) => !flags[key]);
}

/** "printing, copying" — the restricted permissions as a list in the current language. */
export function restrictionList(flags: PermissionFlags): string {
  return restrictedPermissions(flags)
    .map((key) => permissionLabel(key).toLocaleLowerCase())
    .join(', ');
}

export function handlerLabel(handler: SecurityHandler | undefined): string {
  switch (handler) {
    case 'rc4-40':
      return 'RC4 40-bit';
    case 'rc4-128':
      return 'RC4 128-bit';
    case 'aes-128':
      return 'AES-128';
    case 'aes-256':
      return 'AES-256';
    default:
      return m.security_handler_unknown();
  }
}

/** Sources of a document, in order of first use. */
export function sourcesOf(ws: Workspace, doc: VirtualDocument): SourceDocument[] {
  const seen = new Set<string>();
  const out: SourceDocument[] = [];
  for (const page of doc.pages) {
    if (page.ref.kind !== 'source' || seen.has(page.ref.source)) continue;
    seen.add(page.ref.source);
    const source = ws.sources[page.ref.source];
    if (source) out.push(source);
  }
  return out;
}

/** Owner-only encrypted sources that restrict something (open without a password). */
export function restrictedSources(ws: Workspace, doc: VirtualDocument): SourceDocument[] {
  return sourcesOf(ws, doc).filter(
    (s) =>
      s.flags.encrypted &&
      s.flags.passwordProtected !== true &&
      s.flags.permissions !== undefined &&
      restrictedPermissions(s.flags.permissions).length > 0,
  );
}

/** Encrypted sources that needed a password to open. */
export function passwordSources(ws: Workspace, doc: VirtualDocument): SourceDocument[] {
  return sourcesOf(ws, doc).filter((s) => s.flags.encrypted && s.flags.passwordProtected === true);
}

/** One sentence: what export does about passwords with `policy` (undefined: none). */
export function securityOutcome(
  policy: SecurityPolicy | undefined,
  encryptedSources: number,
): string {
  if (policy === undefined) {
    return encryptedSources > 0
      ? m.security_outcome_removed({ count: encryptedSources })
      : m.security_outcome_none();
  }
  const restricted = restrictionList(policy.permissions);
  if (policy.userPassword) {
    return restricted
      ? m.security_outcome_password_restricted({ restricted })
      : m.security_outcome_password();
  }
  return m.security_outcome_owner_only({ restricted: restricted || m.security_nothing() });
}
