/**
 * The signature status word with a shield glyph (spec recognize-and-compare §3.4): in the
 * status bar for the active document (a button that opens the Inspector's Signatures
 * section) and as a glyph in each signed document's tab. When a signed source carries edits
 * the status bar adds that export removes the signatures (ADR-0013; no incremental output).
 */
import type { DocumentId } from '@pdf-editor/document-model';

import { m } from '../i18n';
import { useUiStore } from '../state/ui-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { StatusGlyph } from './SignaturesSection';
import styles from './Signatures.module.css';
import { statusLabel, statusTone } from './status';
import { type DocumentSignatureState, useDocumentSignatureState } from './use-signatures';

export const SIGNATURES_SECTION_ID = 'inspector-signatures';

/** The status word of a document's signatures (the worst one), or the checking state. */
export function badgeText(state: DocumentSignatureState): string | null {
  if (state.sources.length === 0) return null;
  if (state.summary.status !== undefined) return statusLabel(state.summary.status);
  if (state.checking) return m.signature_checking();
  if (state.failed) return statusLabel('cannot-check');
  return null;
}

/** Opens the right panel and scrolls to the Signatures section. */
export function showSignatures(): void {
  if (!useUiStore.getState().rightPanelOpen) useUiStore.getState().toggleRightPanel();
  requestAnimationFrame(() => {
    document.getElementById(SIGNATURES_SECTION_ID)?.scrollIntoView?.({ block: 'start' });
  });
}

/** Status bar item for the active document. */
export function SignatureStatusBadge({ separator }: { readonly separator: string | undefined }) {
  const active = useWorkspaceStore((s) => s.workspace.activeDocument);
  const state = useDocumentSignatureState(active);
  const text = badgeText(state);
  if (text === null) return null;
  const tone = state.summary.status ? statusTone(state.summary.status) : undefined;
  return (
    <>
      <span className={separator} aria-hidden="true">
        ·
      </span>
      <button
        type="button"
        className={styles.badge}
        data-tone={tone}
        data-testid="status-signatures"
        aria-label={`${m.signature_badge_label({ status: text })}${
          state.edited ? `, ${m.signature_badge_edited()}` : ''
        }. ${m.signature_badge_show()}`}
        onClick={showSignatures}
      >
        <StatusGlyph tone={tone} />
        <span>{text}</span>
        {state.edited ? (
          <span className={styles.badgeMuted}>· {m.signature_badge_edited()}</span>
        ) : null}
      </button>
    </>
  );
}

/** A decorative shield in a signed document's tab (the status bar carries the words). */
export function SignatureTabGlyph({ documentId }: { readonly documentId: DocumentId }) {
  const state = useDocumentSignatureState(documentId);
  if (state.sources.length === 0) return null;
  const tone = state.summary.status ? statusTone(state.summary.status) : undefined;
  return (
    <span
      className={styles.tabGlyph}
      data-tone={tone}
      data-testid="tab-signature-glyph"
      data-status={state.summary.status}
      aria-hidden="true"
    >
      <StatusGlyph tone={tone} />
    </span>
  );
}
