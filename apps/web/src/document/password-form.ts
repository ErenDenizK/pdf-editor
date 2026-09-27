/**
 * Validation of the Set password dialog (spec document-tools.md §4). AES-256 (revision 6)
 * uses at most 127 bytes of a UTF-8 password; longer ones are refused rather than silently
 * truncated.
 */
import {
  ALL_PERMISSIONS,
  type PermissionFlags,
  type SecurityPolicy,
} from '@pdf-editor/document-model';

export const MAX_PASSWORD_BYTES = 127;

export interface PasswordFormValues {
  readonly userPassword: string;
  readonly ownerPassword: string;
  readonly permissions: PermissionFlags;
}

export type PasswordFormProblem = 'no-password' | 'same-passwords' | 'too-long';

export interface PasswordFormCheck {
  readonly problem?: PasswordFormProblem;
  /**
   * Restrictions without an owner password: a random owner password is generated at
   * export, so nobody can lift them with a password later.
   */
  readonly randomOwner: boolean;
}

export function validatePasswordForm(values: PasswordFormValues): PasswordFormCheck {
  const user = values.userPassword;
  const owner = values.ownerPassword;
  const restricted = Object.values(values.permissions).some((allowed) => !allowed);
  const randomOwner = owner === '' && user !== '' && restricted;
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  if (user === '' && owner === '') return { problem: 'no-password', randomOwner };
  if (bytes(user) > MAX_PASSWORD_BYTES || bytes(owner) > MAX_PASSWORD_BYTES) {
    return { problem: 'too-long', randomOwner };
  }
  if (user !== '' && user === owner) return { problem: 'same-passwords', randomOwner };
  return { randomOwner };
}

/** High-quality printing needs printing; forms can be filled whenever annotating is allowed. */
export function normalizePermissions(p: PermissionFlags): PermissionFlags {
  return {
    ...p,
    printHighQuality: p.print && p.printHighQuality,
    fillForms: p.fillForms || p.annotate,
  };
}

export function toPolicy(values: PasswordFormValues): SecurityPolicy {
  return {
    algorithm: 'aes-256',
    ...(values.userPassword === '' ? {} : { userPassword: values.userPassword }),
    ...(values.ownerPassword === '' ? {} : { ownerPassword: values.ownerPassword }),
    permissions: normalizePermissions(values.permissions),
  };
}

export function initialValues(policy: SecurityPolicy | undefined): PasswordFormValues {
  return {
    userPassword: policy?.userPassword ?? '',
    ownerPassword: policy?.ownerPassword ?? '',
    permissions: policy?.permissions ?? ALL_PERMISSIONS,
  };
}
