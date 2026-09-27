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
import { getLocale, m } from '../i18n';
import { useSelectionStore } from '../state/selection-store';
import { RIGHT_PANEL_WIDTH, useUiStore } from '../state/ui-store';
import {
  documentSources,
  useActiveDocument,
  useHasDocuments,
  useWorkspaceStore,
} from '../state/workspace-store';
import { ResizeHandle } from '../ui/ResizeHandle';
import { Tooltip } from '../ui/Tooltip';
import { EmptyNote } from './EmptyNote';
import styles from './RightPanel.module.css';

const PANEL_ID = 'right-panel';

const dateFormat = (value: number) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(value);
const timeFormat = (value: number) =>
  new Intl.DateTimeFormat(getLocale(), { timeStyle: 'short' }).format(value);

/**
 * Honesty badges: engine facts about a source and what export will do about them. `label`
 * and `explanation` are getters, so they read the active language on every access.
 */
function badge(
  flag: keyof SourceFlags,
  label: () => string,
  explanation: () => string,
): { readonly flag: keyof SourceFlags; readonly label: string; readonly explanation: string } {
  return {
    flag,
    get label() {
      return label();
    },
    get explanation() {
      return explanation();
    },
  };
}

export const SOURCE_BADGES: readonly {
  readonly flag: keyof SourceFlags;
  readonly label: string;
  readonly explanation: string;
}[] = [
  badge('encrypted', m.badge_encrypted, m.badge_encrypted_explanation),
  badge('repaired', m.badge_repaired, m.badge_repaired_explanation),
  badge('hasAcroForm', m.badge_form, m.badge_form_explanation),
  badge('hasXfa', m.badge_xfa, m.badge_xfa_explanation),
  badge('hasSignatures', m.badge_signed, m.badge_signed_explanation),
  badge('tagged', m.badge_tagged, m.badge_tagged_explanation),
];

export function RightPanel() {
  const open = useUiStore((s) => s.rightPanelOpen);
  const width = useUiStore((s) => s.rightPanelWidth);
  const setWidth = useUiStore((s) => s.setRightPanelWidth);
  const hasDocuments = useHasDocuments();
  // With nothing open there is nothing to inspect; the empty state gets the whole stage.
  if (!open || !hasDocuments) return null;

  return (
    <aside
      id={PANEL_ID}
      aria-label={m.inspector_label()}
      className={styles.panel}
      style={{ width }}
    >
      <ResizeHandle
        label={m.inspector_resize()}
        controls={PANEL_ID}
        value={width}
        min={RIGHT_PANEL_WIDTH.min}
        max={RIGHT_PANEL_WIDTH.max}
        direction={-1}
        onChange={setWidth}
      />
      <div className={styles.scroll}>
        <Section id="selection" title={m.inspector_selection()}>
          <SelectionSection />
        </Section>
        <Section id="properties" title={m.inspector_properties()}>
          <EmptyNote
            title={m.inspector_no_properties_title()}
            body={m.inspector_no_properties_body()}
          />
        </Section>
        <Section id="history" title={m.inspector_history()}>
          <HistorySection />
        </Section>
        <Section id="info" title={m.inspector_info()}>
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
      <EmptyNote
        title={m.inspector_nothing_selected_title()}
        body={m.inspector_nothing_selected_body()}
      />
    );
  }
  const { documents, labels } = describeSelection(ws, selected);
  const shown = labels.slice(0, 12).join(', ') + (labels.length > 12 ? ', …' : '');
  return (
    <dl className={styles.facts}>
      <dt>{m.inspector_selected()}</dt>
      <dd className={styles.numeric}>
        {m.pages_count({ count: selected.size })}
        {documents > 1 ? (
          <span className={styles.muted}>{m.inspector_from_documents({ count: documents })}</span>
        ) : null}
      </dd>
      {labels.length > 0 ? (
        <>
          <dt>{m.inspector_pages()}</dt>
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
      <EmptyNote title={m.inspector_no_changes_title()} body={m.inspector_no_changes_body()} />
    );
  }
  return (
    <ol ref={listRef} className={styles.history} aria-label={m.inspector_history_label()}>
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
            <span className={styles.historyTime}>{timeFormat(entry.at)}</span>
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
  if (!doc) return <EmptyNote title={m.no_document_title()} />;
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
      <dt>{m.info_name()}</dt>
      <dd title={name}>{name}</dd>
      {sources.length > 1 ? (
        <>
          <dt>{m.info_files()}</dt>
          <dd className={styles.numeric}>{sources.length}</dd>
        </>
      ) : null}
      <dt>{m.info_size()}</dt>
      <dd className={styles.numeric}>{formatBytes(size)}</dd>
      <dt>{m.info_pages()}</dt>
      <dd className={styles.numeric}>{doc.pages.length}</dd>
      <dt>{m.info_modified()}</dt>
      <dd className={styles.numeric}>
        {file && file.lastModified > 0 ? dateFormat(file.lastModified) : '—'}
      </dd>
      {badges.length > 0 ? (
        <>
          <dt>{m.info_notes()}</dt>
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

function Section({
  id: key,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  const id = `inspector-${key}`;
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className={styles.sectionTitle}>
        {title}
      </h2>
      {children}
    </section>
  );
}
