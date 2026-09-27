/**
 * Passwords in the Info section (spec document-tools.md §4): the restriction notice for
 * owner-only sources (inline, expandable; this app does not enforce the author's
 * restrictions and says so), what export will do, and the Set / Remove password actions.
 */
import type { PermissionFlags, VirtualDocument } from '@pdf-editor/document-model';

import { m } from '../i18n';
import { useWorkspaceStore } from '../state/workspace-store';
import { openDocumentDialog } from './document-store';
import styles from './DocumentTools.module.css';
import {
  handlerLabel,
  passwordSources,
  restrictedSources,
  restrictionList,
  securityOutcome,
  sourcesOf,
} from './security-text';

export function SecurityInfo({ doc }: { readonly doc: VirtualDocument }) {
  const ws = useWorkspaceStore((s) => s.workspace);
  const restricted = restrictedSources(ws, doc);
  const encrypted = sourcesOf(ws, doc).filter((s) => s.flags.encrypted);
  const locked = passwordSources(ws, doc);
  const canRemove = doc.security !== undefined || (encrypted.length > 0 && !doc.passwordRemoved);
  return (
    <div className={styles.security} data-testid="security-info">
      {restricted.map((source) => (
        <details key={source.id} className={styles.notice} data-testid="restricted-notice">
          <summary>
            <span className={styles.badge}>{m.badge_restricted()}</span>{' '}
            {m.restricted_summary({
              // restrictedSources only lists sources with permissions.
              restricted: restrictionList(source.flags.permissions as PermissionFlags),
            })}
          </summary>
          <p>
            {m.restricted_explanation({
              name: source.name,
              handler: handlerLabel(source.flags.securityHandler),
            })}
          </p>
        </details>
      ))}
      <dl className={styles.facts}>
        {encrypted.length > 0 ? (
          <>
            <dt>{m.security_source()}</dt>
            <dd>
              {encrypted
                .map((s) =>
                  m.security_source_line({
                    handler: handlerLabel(s.flags.securityHandler),
                    kind:
                      s.flags.passwordProtected === true
                        ? m.security_kind_password()
                        : m.security_kind_owner(),
                  }),
                )
                .join('; ')}
            </dd>
          </>
        ) : null}
        <dt>{m.security_on_export()}</dt>
        <dd data-testid="security-outcome" className={styles.wrap}>
          {doc.passwordRemoved && doc.security === undefined
            ? m.security_outcome_removed_requested()
            : securityOutcome(doc.security, encrypted.length)}
        </dd>
      </dl>
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.small}
          onClick={() => openDocumentDialog('set-password', doc.id)}
        >
          {doc.security ? m.cmd_change_password() : m.cmd_set_password()}
        </button>
        {canRemove ? (
          <button
            type="button"
            className={styles.small}
            onClick={() => openDocumentDialog('remove-password', doc.id)}
          >
            {m.cmd_remove_password()}
          </button>
        ) : null}
      </div>
      {locked.length > 0 && doc.security === undefined && !doc.passwordRemoved ? (
        <p className={styles.note}>{m.security_reapply_hint()}</p>
      ) : null}
    </div>
  );
}
