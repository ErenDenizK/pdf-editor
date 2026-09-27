/**
 * Inspector: shows only what applies to the current selection (DESIGN.md §2). With no
 * selection it shows document info and history. Selection, properties and history come
 * from the document model; until then each section shows its empty state.
 */
import type { ReactNode } from 'react';

import { formatBytes } from '../files/file-filters';
import { RIGHT_PANEL_WIDTH, useUiStore } from '../state/ui-store';
import { useActiveDocument, useWorkspaceStore } from '../state/workspace-store';
import { ResizeHandle } from '../ui/ResizeHandle';
import { EmptyNote } from './EmptyNote';
import styles from './RightPanel.module.css';

const PANEL_ID = 'right-panel';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function RightPanel() {
  const open = useUiStore((s) => s.rightPanelOpen);
  const width = useUiStore((s) => s.rightPanelWidth);
  const setWidth = useUiStore((s) => s.setRightPanelWidth);
  const doc = useActiveDocument();
  const hasDocuments = useWorkspaceStore((s) => s.documents.length > 0);
  // With nothing open there is nothing to inspect; the empty state gets the whole stage.
  if (!open || !hasDocuments) return null;

  return (
    <aside id={PANEL_ID} aria-label="Inspector" className={styles.panel} style={{ width }}>
      <ResizeHandle
        label="Resize inspector"
        controls={PANEL_ID}
        value={width}
        min={RIGHT_PANEL_WIDTH.min}
        max={RIGHT_PANEL_WIDTH.max}
        direction={-1}
        onChange={setWidth}
      />
      <div className={styles.scroll}>
        <Section title="Selection">
          <EmptyNote title="Nothing selected" body="Select pages or annotations to act on them." />
        </Section>
        <Section title="Properties">
          <EmptyNote title="No properties" body="Properties of the selection appear here." />
        </Section>
        <Section title="History">
          <EmptyNote title="No changes yet" body="Every edit is recorded here and can be undone." />
        </Section>
        <Section title="Info">
          {doc ? (
            <dl className={styles.facts}>
              <dt>Name</dt>
              <dd title={doc.name}>{doc.name}</dd>
              <dt>Size</dt>
              <dd className={styles.numeric}>{formatBytes(doc.size)}</dd>
              <dt>Pages</dt>
              <dd className={styles.muted}>Not read yet</dd>
              <dt>Modified</dt>
              <dd className={styles.numeric}>
                {doc.lastModified > 0 ? dateFormat.format(doc.lastModified) : '—'}
              </dd>
            </dl>
          ) : (
            <EmptyNote title="No document open" />
          )}
        </Section>
      </div>
    </aside>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = `inspector-${title.toLowerCase()}`;
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className={styles.sectionTitle}>
        {title}
      </h2>
      {children}
    </section>
  );
}
