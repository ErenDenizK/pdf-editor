/**
 * The navigator's Files tab (experience-redesign §4.1): the open documents in tab order as
 * compact rows. A row makes its document active; × closes it (one history entry, as the
 * tab's ×). Built on the workspace store directly.
 */
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
  const docs = workspace.documentOrder.flatMap((id) => {
    const doc = workspace.documents[id];
    return doc ? [doc] : [];
  });
  if (docs.length === 0) {
    return <EmptyNote title={m.files_empty_title()} body={m.files_empty_body()} />;
  }
  return (
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
          onOpen={() => {
            useWorkspaceStore.getState().setActive(doc.id);
            const ui = useUiStore.getState();
            if (ui.viewMode === 'home') ui.setViewMode('read');
          }}
          onClose={() => {
            useWorkspaceStore.getState().closeDocument(doc.id);
            announce(m.announce_closed({ name: doc.title }));
          }}
        />
      ))}
    </ul>
  );
}
