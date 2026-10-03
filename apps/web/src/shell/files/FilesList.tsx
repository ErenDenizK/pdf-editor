/**
 * The navigator's Files tab (experience-redesign §4.1, §8): the open documents in tab order
 * as compact rows, with Home's selection (a checkbox per row), the same "Combine N files"
 * as Home at the bottom and a "Show Home" link. A row makes its document active; × closes
 * it (one history entry, as the tab's ×). Combining always goes through the merge dialog
 * (`home/home-actions.ts`).
 */
import { useMemo } from 'react';

import { combine, selectOnHome, showHome, showTab } from '../../home/home-actions';
import { combineScope, liveSelection, toggleSelection } from '../../home/home-model';
import { m } from '../../i18n';
import { useUiStore } from '../../state/ui-store';
import { documentSources, useWorkspaceStore } from '../../state/workspace-store';
import { announce } from '../announcer';
import { EmptyNote } from '../EmptyNote';
import { FileRow } from './FileRow';
import styles from './FilesList.module.css';

export function FilesList() {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const files = useWorkspaceStore((s) => s.files);
  const colors = useWorkspaceStore((s) => s.documentColors);
  const rawSelection = useUiStore((s) => s.homeSelection);
  const anchor = useUiStore((s) => s.homeAnchor);
  const order = workspace.documentOrder;
  const selection = useMemo(() => liveSelection(order, rawSelection), [order, rawSelection]);
  const docs = order.flatMap((id) => {
    const doc = workspace.documents[id];
    return doc ? [doc] : [];
  });
  if (docs.length === 0) {
    return <EmptyNote title={m.files_empty_title()} body={m.files_empty_body()} />;
  }
  const scope = combineScope(order, selection);
  return (
    <div className={styles.panel} data-selecting={selection.length > 0 || undefined}>
      <ul className={styles.list} aria-label={m.nav_files_list()}>
        {docs.map((doc) => (
          <FileRow
            key={doc.id}
            name={doc.title}
            pages={doc.pages.length}
            size={documentSources(doc).reduce(
              (sum, id) => sum + (files[id]?.size ?? workspace.sources[id]?.byteLength ?? 0),
              0,
            )}
            tag={colors[doc.id] ?? 0}
            active={doc.id === workspace.activeDocument}
            selected={selection.includes(doc.id)}
            onToggle={() => {
              const next = toggleSelection(order, { selection, anchor }, doc.id);
              selectOnHome(next.selection, next.anchor);
            }}
            onOpen={() => showTab(doc.id)}
            onClose={() => {
              useWorkspaceStore.getState().closeDocument(doc.id);
              announce(m.announce_closed({ name: doc.title }));
            }}
          />
        ))}
      </ul>
      <div className={styles.footer}>
        {scope !== null ? (
          <button
            type="button"
            className={styles.combine}
            data-testid="files-combine"
            onClick={() => combine(scope.ids)}
          >
            {scope.all
              ? m.home_combine_all({ count: scope.ids.length })
              : m.home_combine_count({ count: scope.ids.length })}
          </button>
        ) : null}
        <button type="button" className={styles.link} onClick={showHome}>
          {m.nav_files_show_home()}
        </button>
      </div>
    </div>
  );
}
