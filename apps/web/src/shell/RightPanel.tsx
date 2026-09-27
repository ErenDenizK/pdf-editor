/**
 * Inspector: shows only what applies to the current selection (DESIGN.md §2). Selection
 * and history come from the document model; Info shows the active document's file facts
 * and the engine-reported honesty badges (light-table spec §6).
 */
import {
  effectiveLabel,
  findPageLocation,
  historyEntries,
  type PageId,
  type SourceFlags,
  type Workspace,
} from '@pdf-editor/document-model';
import { type ReactNode, useEffect, useRef } from 'react';

import { formatBytes } from '../files/file-filters';
import { useSelectionStore } from '../state/selection-store';
import { RIGHT_PANEL_WIDTH, useUiStore } from '../state/ui-store';
import {
  documentSources,
  pagesPhrase,
  useActiveDocument,
  useHasDocuments,
  useWorkspaceStore,
} from '../state/workspace-store';
import { ResizeHandle } from '../ui/ResizeHandle';
import { Tooltip } from '../ui/Tooltip';
import { EmptyNote } from './EmptyNote';
import styles from './RightPanel.module.css';

const PANEL_ID = 'right-panel';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/** Honesty badges: engine facts about a source and what export will do about them. */
export const SOURCE_BADGES: readonly {
  readonly flag: keyof SourceFlags;
  readonly label: string;
  readonly explanation: string;
}[] = [
  {
    flag: 'encrypted',
    label: 'encrypted',
    explanation:
      'Encrypted: opened with its password. Exporting writes an unencrypted copy unless you set a password.',
  },
  {
    flag: 'repaired',
    label: 'repaired',
    explanation:
      'Repaired: the file was damaged and rebuilt on open. Exporting writes a repaired copy, never an incremental save onto the broken file.',
  },
  {
    flag: 'hasAcroForm',
    label: 'has form',
    explanation:
      'Has form: fields and values are kept on export; fields from different files are renamed by source when names collide.',
  },
  {
    flag: 'hasXfa',
    label: 'XFA',
    explanation:
      'XFA: this form uses XFA, which is not supported. Exporting keeps the regular form fields and removes the XFA data.',
  },
  {
    flag: 'hasSignatures',
    label: 'signed',
    explanation: 'Signed: exporting will invalidate the signature unless saved incrementally.',
  },
  {
    flag: 'tagged',
    label: 'tagged',
    explanation:
      'Tagged: exporting keeps the accessibility structure when it can; if it cannot stay intact it is removed and you are told.',
  },
];

export function RightPanel() {
  const open = useUiStore((s) => s.rightPanelOpen);
  const width = useUiStore((s) => s.rightPanelWidth);
  const setWidth = useUiStore((s) => s.setRightPanelWidth);
  const hasDocuments = useHasDocuments();
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
          <SelectionSection />
        </Section>
        <Section title="Properties">
          <EmptyNote title="No properties" body="Properties of the selection appear here." />
        </Section>
        <Section title="History">
          <HistorySection />
        </Section>
        <Section title="Info">
          <InfoSection />
        </Section>
      </div>
    </aside>
  );
}

/** Where the selected pages live: labels in the active document, and how many documents. */
function describeSelection(ws: Workspace, selected: ReadonlySet<PageId>) {
  const documents = new Set<string>();
  const labels: string[] = [];
  const active = ws.activeDocument;
  for (const id of selected) {
    const location = findPageLocation(ws, id);
    if (!location) continue;
    documents.add(location.document);
    const doc = ws.documents[location.document];
    if (doc && location.document === active) labels.push(effectiveLabel(ws, doc, location.index));
  }
  return { documents: documents.size, labels };
}

function SelectionSection() {
  const selected = useSelectionStore((s) => s.selected);
  const ws = useWorkspaceStore((s) => s.workspace);
  if (selected.size === 0) {
    return (
      <EmptyNote title="Nothing selected" body="Select pages or annotations to act on them." />
    );
  }
  const { documents, labels } = describeSelection(ws, selected);
  const shown = labels.slice(0, 12).join(', ') + (labels.length > 12 ? ', …' : '');
  return (
    <dl className={styles.facts}>
      <dt>Selected</dt>
      <dd className={styles.numeric}>
        {pagesPhrase(selected.size)}
        {documents > 1 ? <span className={styles.muted}> from {documents} documents</span> : null}
      </dd>
      {labels.length > 0 ? (
        <>
          <dt>Pages</dt>
          <dd className={styles.numeric} title={labels.join(', ')}>
            {shown}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function HistorySection() {
  const history = useWorkspaceStore((s) => s.history);
  const jumpTo = useWorkspaceStore((s) => s.jumpTo);
  const listRef = useRef<HTMLOListElement>(null);
  const entries = historyEntries(history);
  const presentIndex = history.past.length;
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="step"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [presentIndex, entries.length]);
  if (entries.length <= 1) {
    return (
      <EmptyNote title="No changes yet" body="Every edit is recorded here and can be undone." />
    );
  }
  return (
    <ol ref={listRef} className={styles.history} aria-label="Undo history">
      {entries.map((entry) => (
        <li key={`${entry.index}-${entry.at}`}>
          <button
            type="button"
            className={styles.historyRow}
            data-state={entry.state}
            aria-current={entry.state === 'present' ? 'step' : undefined}
            onClick={() => jumpTo(entry.index)}
          >
            <span className={styles.historyLabel}>{entry.label}</span>
            <span className={styles.historyTime}>{timeFormat.format(entry.at)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function InfoSection() {
  const doc = useActiveDocument();
  const ws = useWorkspaceStore((s) => s.workspace);
  const files = useWorkspaceStore((s) => s.files);
  if (!doc) return <EmptyNote title="No document open" />;
  const sources = documentSources(doc);
  const first = sources[0];
  const file = first === undefined ? undefined : files[first];
  const name = file?.name ?? (first === undefined ? doc.title : ws.sources[first]?.name);
  const size = sources.reduce((sum, id) => sum + (ws.sources[id]?.byteLength ?? 0), 0);
  const badges = SOURCE_BADGES.filter((badge) =>
    sources.some((id) => ws.sources[id]?.flags[badge.flag] === true),
  );
  return (
    <dl className={styles.facts}>
      <dt>Name</dt>
      <dd title={name}>{name}</dd>
      {sources.length > 1 ? (
        <>
          <dt>Files</dt>
          <dd className={styles.numeric}>{sources.length}</dd>
        </>
      ) : null}
      <dt>Size</dt>
      <dd className={styles.numeric}>{formatBytes(size)}</dd>
      <dt>Pages</dt>
      <dd className={styles.numeric}>{doc.pages.length}</dd>
      <dt>Modified</dt>
      <dd className={styles.numeric}>
        {file && file.lastModified > 0 ? dateFormat.format(file.lastModified) : '—'}
      </dd>
      {badges.length > 0 ? (
        <>
          <dt>Notes</dt>
          <dd className={styles.badges}>
            {badges.map((badge) => (
              <Tooltip key={badge.flag} label={badge.explanation} side="left">
                <button type="button" className={styles.badge} aria-label={badge.explanation}>
                  {badge.label}
                </button>
              </Tooltip>
            ))}
          </dd>
        </>
      ) : null}
    </dl>
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
