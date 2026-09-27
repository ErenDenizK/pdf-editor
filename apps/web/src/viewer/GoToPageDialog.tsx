/**
 * "Go to page" (Mod+G): accepts a page number or a page label ("iv", "A-1"), as the
 * document's effective labels read. The field previews where Enter goes.
 */
import { Dialog } from '@base-ui/react/dialog';
import type { VirtualDocument } from '@pdf-editor/document-model';
import { X } from 'lucide-react';
import { type SyntheticEvent, useId, useRef, useState } from 'react';
import { create } from 'zustand';

import { m } from '../i18n';
import overlay from '../shell/ShortcutOverlay.module.css';
import { useViewStore } from '../state/view-store';
import { useWorkspaceStore } from '../state/workspace-store';
import styles from './GoToPageDialog.module.css';
import { documentLabels, hasCustomLabels, parseGoTo } from './navigation';

export const useGoToStore = create<{ open: boolean }>()(() => ({ open: false }));

export function openGoToPage(): void {
  useGoToStore.setState({ open: true });
}

export function GoToPageDialog({ doc }: { readonly doc: VirtualDocument }) {
  const open = useGoToStore((s) => s.open);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => useGoToStore.setState({ open: next })}>
      <Dialog.Portal>
        <Dialog.Backdrop className={overlay.backdrop} />
        {open ? <GoToForm doc={doc} /> : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Back to the pages on close, so PageDown / Home / End act on them again. */
const returnFocus = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-read-viewport]');

function GoToForm({ doc }: { readonly doc: VirtualDocument }) {
  const ws = useWorkspaceStore((s) => s.workspace);
  const currentPage = useViewStore((s) => s.currentPage);
  const labels = documentLabels(ws, doc);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const target = parseGoTo(value, labels);
  const custom = hasCustomLabels(labels);

  let hint: string;
  if (target.kind === 'page') {
    const label = labels[target.index] ?? '';
    hint =
      custom && label !== String(target.index + 1)
        ? m.goto_preview_label({ number: target.index + 1, total: doc.pages.length, label })
        : m.goto_preview({ number: target.index + 1, total: doc.pages.length });
  } else if (target.kind === 'invalid') hint = m.goto_invalid({ value: value.trim() });
  else {
    hint = custom
      ? m.goto_hint_labels({ first: labels[0] ?? '1', last: labels[labels.length - 1] ?? '' })
      : m.goto_hint({ total: doc.pages.length });
  }

  const onSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (target.kind !== 'page') return;
    const page = doc.pages[target.index];
    if (!page) return;
    useGoToStore.setState({ open: false });
    useViewStore.getState().scrollToPage(page.id);
  };

  return (
    <Dialog.Popup
      className={`${overlay.popup} ${styles.popup}`}
      initialFocus={inputRef}
      finalFocus={returnFocus}
    >
      <div className={overlay.header}>
        <Dialog.Title className={overlay.title}>{m.goto_title()}</Dialog.Title>
        <Dialog.Close className={overlay.close} aria-label={m.common_close()}>
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>
      <form className={styles.body} onSubmit={onSubmit}>
        <input
          ref={inputRef}
          className={styles.input}
          aria-label={m.goto_label()}
          aria-describedby={hintId}
          aria-invalid={target.kind === 'invalid' || undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={labels[currentPage] ?? String(currentPage + 1)}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <p
          id={hintId}
          className={styles.hint}
          data-invalid={target.kind === 'invalid'}
          aria-live="polite"
        >
          {hint}
        </p>
        <div className={styles.actions}>
          <Dialog.Close className={styles.secondary}>{m.common_cancel()}</Dialog.Close>
          <button type="submit" className={styles.primary} disabled={target.kind !== 'page'}>
            {m.goto_go()}
          </button>
        </div>
      </form>
    </Dialog.Popup>
  );
}
