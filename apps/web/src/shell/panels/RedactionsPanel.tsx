/**
 * Redaction marks in the Review tab (redaction spec §1.1–§1.2, experience-redesign §4.1):
 * the mark rows (text under the mark, a tick for a later "apply selected", reveal on click,
 * J / K review and delete) and the Marks filter's header. The header states honestly, in
 * one line with a "Why?" disclosure, what a mark is (only a mark until applied; applying
 * is irreversible after export) and holds the sensitive-data finder, whose matches are
 * reviewed here before "Mark selected". "Apply redactions" is enabled while a listed mark
 * is ticked and opens the confirmation dialog (redaction/ApplyRedactionsDialog.tsx), which
 * applies the ticked marks.
 */
import type { Rect, SourceId } from '@pdf-editor/document-model';
import { EyeOff, ScanSearch, ShieldAlert, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';

import { useAnnotationStore } from '../../annotations/annotation-store';
import { pageText } from '../../annotations/page-text';
import { getEngineService } from '../../engine/engine-service';
import { formatNumber, m } from '../../i18n';
import {
  clearFinder,
  deleteMark,
  findSensitiveData,
  isStaleMatch,
  markCheckedFinds,
  revealMark,
} from '../../redaction';
import type { PatternId } from '../../redaction/patterns';
import { PATTERN_IDS } from '../../redaction/patterns';
import { ApplyRedactionsDialog } from '../../redaction/ApplyRedactionsDialog';
import { useApplyDialogStore } from '../../redaction/apply-store';
import {
  type FinderMatch,
  type MarkEntry,
  useRedactionStore,
} from '../../redaction/redaction-store';
import { textUnderQuads } from '../../redaction/text-index';
import { useUiStore } from '../../state/ui-store';
import { useViewStore } from '../../state/view-store';
import { useActiveDocument, useWorkspaceStore } from '../../state/workspace-store';
import { IconButton } from '../../ui/IconButton';
import { Tooltip } from '../../ui/Tooltip';
import styles from './RedactionsPanel.module.css';

const PATTERN_NAMES: Readonly<Record<PatternId, () => string>> = {
  email: m.redaction_pattern_email,
  phone: m.redaction_pattern_phone,
  iban: m.redaction_pattern_iban,
  tckn: m.redaction_pattern_tckn,
  card: m.redaction_pattern_card,
  date: m.redaction_pattern_date,
};

/** Display order of the finder's groups. */
const GROUP_ORDER: readonly PatternId[] = ['email', 'phone', 'iban', 'tckn', 'card', 'date'];

/**
 * The Review tab's Marks filter header: the honesty line, "Find sensitive data", "Apply
 * redactions", the summary of ticked marks and the finder's results. `entries` are the
 * marks the list shows (every open document's).
 */
export function RedactionTools({ entries }: { readonly entries: readonly MarkEntry[] }) {
  const excluded = useRedactionStore((s) => s.excluded);
  const included = new Set(entries.filter((e) => !excluded.has(e.markKey)).map((e) => e.markKey));
  const total = new Set(entries.map((e) => e.markKey)).size;
  return (
    <>
      <div className={styles.header} data-redaction-tools="">
        <Honesty />
        <Actions ticked={included.size} />
        {total > 0 ? (
          <p className={styles.summary} data-testid="redaction-summary">
            {m.redaction_summary({
              count: total,
              countText: formatNumber(total),
              selectedText: formatNumber(included.size),
            })}
          </p>
        ) : null}
      </div>
      <Finder />
    </>
  );
}

/** "Marks hide nothing until you apply them. Why?": one line, the full text on demand. */
function Honesty() {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  return (
    <div className={styles.honesty} role="note" data-testid="redaction-honesty">
      <ShieldAlert aria-hidden="true" />
      <div className={styles.honestyText}>
        <p>
          {m.redaction_honesty_short()}{' '}
          <button
            type="button"
            className={styles.honestyMore}
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen(!open)}
          >
            {m.redaction_honesty_more()}
          </button>
        </p>
        <p id={detailId} className={styles.honestyDetail} hidden={!open}>
          {m.redaction_honesty()}
        </p>
      </div>
    </div>
  );
}

function Actions({ ticked }: { readonly ticked: number }) {
  const doc = useActiveDocument();
  const noteId = useId();
  const status = useRedactionStore((s) => s.finder.status);
  const openApply = useApplyDialogStore((s) => s.setOpen);
  const disabled = ticked === 0;
  return (
    <div className={styles.actions}>
      <button
        type="button"
        className={styles.button}
        disabled={!doc || status === 'running'}
        onClick={() => {
          if (doc) void findSensitiveData(doc);
        }}
      >
        <ScanSearch aria-hidden="true" />
        {m.redaction_find()}
      </button>
      {disabled ? (
        <Tooltip label={m.redaction_apply_none()} side="bottom">
          <button
            type="button"
            className={styles.apply}
            aria-disabled="true"
            aria-describedby={noteId}
            data-testid="redaction-apply"
          >
            {m.redaction_apply()}
          </button>
        </Tooltip>
      ) : (
        <button
          type="button"
          className={styles.apply}
          data-testid="redaction-apply"
          onClick={() => openApply(true)}
        >
          {m.redaction_apply()}
        </button>
      )}
      {disabled ? (
        <span id={noteId} className="visually-hidden">
          {m.redaction_apply_none()}
        </span>
      ) : null}
      <ApplyRedactionsDialog />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

/**
 * Snippets per source page, content revision and quads: a text edit (or an applied
 * redaction) changes the text under a mark and bumps the page's revision (`pageText` is
 * keyed the same way).
 */
const snippets = new Map<string, string>();

function snippetKey(
  source: SourceId,
  pageIndex: number,
  revision: number,
  quads: readonly Rect[],
): string {
  return `${source}:${pageIndex}:${revision}:${JSON.stringify(quads)}`;
}

function useSnippet(entry: MarkEntry): string | undefined {
  const service = getEngineService();
  const revision = useSyncExternalStore(service.subscribeRevisions, () =>
    service.pageRevision(entry.source, entry.sourceIndex),
  );
  const key = snippetKey(entry.source, entry.sourceIndex, revision, entry.mark.quads);
  const [loaded, setLoaded] = useState<{ key: string; text: string } | undefined>();
  useEffect(() => {
    if (snippets.has(key)) return;
    let live = true;
    void pageText(entry.source, entry.sourceIndex).then((runs) => {
      const text = textUnderQuads(runs, entry.mark.quads);
      if (snippets.size > 500) snippets.clear();
      snippets.set(key, text);
      if (live) setLoaded({ key, text });
    });
    return () => {
      live = false;
    };
  }, [key, entry.source, entry.sourceIndex, entry.mark.quads]);
  return loaded?.key === key ? loaded.text : snippets.get(key);
}

/** Longest snippet quoted in a checkbox's accessible name. */
const LABEL_SNIPPET = 40;

/**
 * One mark: the text under it (or "Area without text"), reveal on click, delete, and in the
 * Marks filter the tick for "Apply redactions". The current mark of J / K review scrolls
 * into view.
 */
export function MarkRow({
  entry,
  index,
  checkable,
}: {
  readonly entry: MarkEntry;
  /** 1-based number of the mark on its page (names the checkbox). */
  readonly index: number;
  readonly checkable: boolean;
}) {
  const snippet = useSnippet(entry);
  const checked = useRedactionStore((s) => !s.excluded.has(entry.markKey));
  const current = useRedactionStore((s) => s.current === entry.key);
  const setIncluded = useRedactionStore((s) => s.setIncluded);
  const selected = useAnnotationStore(
    (s) => s.selection?.pageId === entry.pageId && s.selection.ids.includes(entry.mark.id),
  );
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (current) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const label = snippet === undefined ? '' : snippet === '' ? m.redaction_area() : snippet;
  // Unique per row: the mark's number on its page, and the text under it when there is some.
  const quoted =
    snippet === undefined || snippet === ''
      ? undefined
      : snippet.length > LABEL_SNIPPET
        ? `${snippet.slice(0, LABEL_SNIPPET - 1)}…`
        : snippet;
  const checkLabel =
    quoted === undefined
      ? m.redaction_include_index({ index, page: entry.position })
      : m.redaction_include_text({ index, page: entry.position, text: quoted });
  return (
    <li
      ref={rowRef}
      className={styles.row}
      data-review-kind="mark"
      aria-current={current || selected ? 'true' : undefined}
    >
      {checkable ? (
        <input
          type="checkbox"
          className={styles.check}
          checked={checked}
          aria-label={checkLabel}
          onChange={(e) => setIncluded([entry.markKey], e.target.checked)}
        />
      ) : null}
      <button
        type="button"
        className={styles.item}
        data-redaction-row={entry.mark.id}
        onClick={() => revealMark(entry)}
      >
        <span className={styles.glyph} aria-hidden="true">
          <EyeOff />
        </span>
        <span
          className={snippet === '' ? styles.noText : styles.snippet}
          data-testid="redaction-snippet"
        >
          {label}
        </span>
      </button>
      <IconButton
        label={m.redaction_delete()}
        icon={<Trash2 />}
        tooltipSide="left"
        className={styles.delete}
        onClick={() => void deleteMark(entry)}
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Sensitive data finder
// ---------------------------------------------------------------------------

function revealMatch(match: FinderMatch): void {
  const ui = useUiStore.getState();
  if (ui.viewMode !== 'read') ui.setViewMode('read');
  const first = match.quads[0];
  useViewStore.getState().scrollToPage(match.pageId, first ? { reveal: first } : undefined);
}

function Finder() {
  const finder = useRedactionStore((s) => s.finder);
  const setChecked = useRedactionStore((s) => s.setMatchesChecked);
  const workspace = useWorkspaceStore((s) => s.workspace);
  const activeDocument = workspace.activeDocument;
  const [busy, setBusy] = useState(false);
  if (finder.status === 'idle') return null;
  // Results belong to the document they were found in.
  if (finder.documentId !== activeDocument) return null;

  // Matches on pages whose text changed since the search (a text edit, an applied
  // redaction) no longer say where the text is: hidden until the next search.
  const current = finder.matches.filter((match) => !isStaleMatch(workspace, match));
  const stalePages = new Set(
    finder.matches
      .filter((match) => isStaleMatch(workspace, match))
      .map((match) => `${match.source}:${match.sourceIndex}`),
  ).size;
  const byPattern = new Map<PatternId, FinderMatch[]>();
  for (const match of current) {
    const list = byPattern.get(match.pattern) ?? [];
    list.push(match);
    byPattern.set(match.pattern, list);
  }
  const chosen = current.filter((match) => finder.checked.has(match.id)).length;
  let status = '';
  if (finder.status === 'running') {
    status = m.redaction_find_progress({
      done: formatNumber(finder.progress.done),
      total: formatNumber(finder.progress.total),
    });
  } else if (finder.status === 'error') status = m.redaction_find_failed();
  else if (current.length === 0 && stalePages === 0) status = m.redaction_find_none();

  return (
    <section className={styles.finder} aria-label={m.redaction_find_title()}>
      <div className={styles.finderHeader}>
        <h3 className={styles.finderTitle}>{m.redaction_find_title()}</h3>
        <IconButton
          label={m.redaction_find_close()}
          icon={<X />}
          className={styles.close}
          onClick={clearFinder}
        />
      </div>
      {status !== '' ? (
        <p className={styles.finderStatus} role="status" data-testid="redaction-find-status">
          {status}
        </p>
      ) : null}
      {stalePages > 0 ? (
        <p className={styles.finderStatus} data-testid="redaction-find-stale">
          {m.redaction_find_stale({ count: stalePages })}
        </p>
      ) : null}
      {GROUP_ORDER.filter((id) => PATTERN_IDS.includes(id) && byPattern.has(id)).map((id) => {
        const matches = byPattern.get(id) ?? [];
        const ticked = matches.filter((match) => finder.checked.has(match.id)).length;
        return (
          <fieldset key={id} className={styles.patternGroup} data-pattern={id}>
            <legend className={styles.patternLegend}>
              <label className={styles.patternLabel}>
                <input
                  type="checkbox"
                  className={styles.check}
                  checked={ticked === matches.length}
                  ref={(el) => {
                    if (el) el.indeterminate = ticked > 0 && ticked < matches.length;
                  }}
                  onChange={(e) =>
                    setChecked(
                      matches.map((match) => match.id),
                      e.target.checked,
                    )
                  }
                />
                <span>{PATTERN_NAMES[id]()}</span>
                <span className={styles.count}>{formatNumber(matches.length)}</span>
              </label>
            </legend>
            <ul className={styles.list}>
              {matches.map((match) => (
                <li key={match.id} className={styles.row}>
                  <input
                    type="checkbox"
                    className={styles.check}
                    checked={finder.checked.has(match.id)}
                    aria-label={m.redaction_find_include({
                      text: match.text,
                      page: match.position,
                    })}
                    onChange={(e) => setChecked([match.id], e.target.checked)}
                  />
                  <button
                    type="button"
                    className={styles.item}
                    data-finder-match={match.pattern}
                    onClick={() => revealMatch(match)}
                  >
                    <span className={styles.snippet}>{match.text}</span>
                    <span className={styles.page}>
                      {m.redaction_page_short({ page: match.position })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </fieldset>
        );
      })}
      {current.length > 0 ? (
        <div className={styles.finderActions}>
          <button
            type="button"
            className={styles.primary}
            disabled={chosen === 0 || busy}
            onClick={() => {
              setBusy(true);
              void markCheckedFinds().finally(() => setBusy(false));
            }}
          >
            {m.redaction_mark_selected({ count: chosen, countText: formatNumber(chosen) })}
          </button>
        </div>
      ) : null}
    </section>
  );
}
