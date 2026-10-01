/**
 * The navigator's Pages tab (experience-redesign §4.1): the active document's thumbnails,
 * or with the "Pages · Bookmarks" switch its outline ("Add bookmark" lives in the
 * Bookmarks view only). The choice is remembered (`pagesView` in `ui:v2`).
 */
import { m } from '../../i18n';
import { type PagesView, useUiStore } from '../../state/ui-store';
import { useActiveDocument } from '../../state/workspace-store';
import { EmptyNote } from '../EmptyNote';
import { OutlinePanel } from '../OutlinePanel';
import { PagesPanel } from '../PagesPanel';
import styles from './PagesTab.module.css';
import { RadioChips } from './RadioChips';

export function PagesTab() {
  const view = useUiStore((s) => s.pagesView);
  const setView = useUiStore((s) => s.setPagesView);
  return (
    <div className={styles.tab} data-pages-view={view}>
      <RadioChips<PagesView>
        label={m.nav_pages_view_label()}
        className={styles.switch}
        value={view}
        onChange={setView}
        chips={[
          { value: 'thumbnails', label: m.nav_pages_thumbnails() },
          { value: 'bookmarks', label: m.nav_pages_bookmarks() },
        ]}
      />
      <div className={styles.body}>{view === 'bookmarks' ? <OutlinePanel /> : <Thumbnails />}</div>
    </div>
  );
}

function Thumbnails() {
  const doc = useActiveDocument();
  if (!doc) {
    return (
      <div className={styles.empty}>
        <EmptyNote title={m.no_document_title()} body={m.pages_empty_body()} />
      </div>
    );
  }
  if (doc.pages.length === 0) {
    return (
      <div className={styles.empty}>
        <EmptyNote title={m.pages_none_title()} body={m.pages_none_body()} />
      </div>
    );
  }
  return <PagesPanel doc={doc} />;
}
