/**
 * Dialogs for the section operations (spec §5): Split…, Merge into…, Merge all open
 * documents, Interleave with…, and the image-size question for "Insert images". Styled as
 * the export dialog (ShortcutOverlay popup + ExportDialog form parts). Every dialog shows
 * a live preview of what it will create, and commits one history entry.
 */
import { Dialog } from '@base-ui/react/dialog';
import type { DocumentId, InterleaveMode, SplitSpec } from '@pdf-editor/document-model';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import {
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
  useId,
  useRef,
  useState,
} from 'react';

import styles from '../export/ExportDialog.module.css';
import { A4, type ImageSizing, imagePageSize } from '../files/images';
import { formatNumber, m } from '../i18n';
import overlay from '../shell/ShortcutOverlay.module.css';
import { useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import {
  pagesPhrase,
  type TabItem,
  useTabItems,
  useWorkspaceStore,
} from '../state/workspace-store';
import { IconButton } from '../ui/IconButton';
import { useRetained } from '../ui/use-retained';
import local from './OperationDialogs.module.css';
import {
  answerImageSizing,
  closeOperationDialog,
  type OperationDialog,
  useOperationDialogStore,
} from './operation-dialogs-store';
import {
  defaultChunkSize,
  moveItem,
  outlineCuts,
  parsePageRanges,
  previewInterleave,
  previewSplit,
  type RangeProblem,
  type SplitPreview,
  selectionCuts,
  validateTitle,
} from './operation-plans';
import {
  interleaveWith,
  mergeAll,
  mergeInto,
  splitSection,
  titleProblemMessage,
} from './section-operations';

export function OperationDialogs() {
  const dialog = useOperationDialogStore((s) => s.dialog);
  // Keep the popup mounted while it animates closed (see useRetained).
  const [shown, release] = useRetained(dialog);
  return (
    <Dialog.Root
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open) closeOperationDialog();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) release();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={overlay.backdrop} />
        {shown === null ? null : <DialogContent key={dialogKey(shown)} dialog={shown} />}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function dialogKey(dialog: OperationDialog): string {
  return 'documentId' in dialog ? `${dialog.kind}:${dialog.documentId}` : dialog.kind;
}

function DialogContent({ dialog }: { readonly dialog: OperationDialog }) {
  switch (dialog.kind) {
    case 'split':
      return <SplitDialog documentId={dialog.documentId} />;
    case 'merge-into':
      return <MergeIntoDialog documentId={dialog.documentId} />;
    case 'merge-all':
      return <MergeAllDialog />;
    case 'interleave':
      return <InterleaveDialog documentId={dialog.documentId} />;
    case 'image-size':
      return <ImageSizeDialog count={dialog.count} largest={dialog.largest} />;
  }
}

function Frame({
  title,
  testId,
  initialFocus,
  wide = false,
  children,
}: {
  readonly title: string;
  readonly testId: string;
  readonly initialFocus?: RefObject<HTMLElement | null>;
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Dialog.Popup
      className={`${overlay.popup} ${styles.popup} ${wide ? local.wide : ''}`}
      data-testid={testId}
      {...(initialFocus ? { initialFocus } : {})}
    >
      <div className={overlay.header}>
        <Dialog.Title className={overlay.title}>{title}</Dialog.Title>
        <Dialog.Close className={overlay.close} aria-label={m.common_close()}>
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>
      {children}
    </Dialog.Popup>
  );
}

function Actions({ confirm, disabled }: { readonly confirm: string; readonly disabled: boolean }) {
  return (
    <div className={styles.actions}>
      <Dialog.Close className={styles.secondary}>{m.common_cancel()}</Dialog.Close>
      <button type="submit" className={styles.primary} disabled={disabled}>
        {confirm}
      </button>
    </div>
  );
}

/** Splits a message at a placeholder so a control can sit inside the sentence. */
function around(message: (marker: string) => string): readonly [string, string] {
  const marker = '\u0000';
  const [before = '', after = ''] = message(marker).split(marker);
  return [before, after];
}

function sizesList(parts: readonly number[]): string {
  const shown = parts.slice(0, 12).map((n) => formatNumber(n));
  return parts.length > 12 ? `${shown.join(', ')}, …` : shown.join(', ');
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

type SplitMode = 'every' | 'ranges' | 'outline' | 'selection';

export function rangeProblemMessage(problem: RangeProblem): string {
  switch (problem.kind) {
    case 'empty':
      return m.range_error_empty();
    case 'syntax':
      return m.range_error_syntax({ token: problem.token });
    case 'zero':
      return m.range_error_zero({ token: problem.token });
    case 'reversed':
      return m.range_error_reversed({ token: problem.token });
    case 'out-of-bounds':
      return m.range_error_out_of_bounds({ token: problem.token, count: problem.pageCount });
    case 'overlap':
      return m.range_error_overlap({ first: problem.first, second: problem.second });
  }
}

function SplitDialog({ documentId }: { readonly documentId: DocumentId }) {
  const live = useWorkspaceStore((s) => s.workspace.documents[documentId]);
  // The split consumes the document; keep showing it while the dialog closes.
  const [initial] = useState(live);
  const doc = live ?? initial;
  const selected = useSelectionStore((s) => s.selected);
  const pageCount = doc?.pages.length ?? 0;
  const [mode, setMode] = useState<SplitMode>('every');
  const [every, setEvery] = useState(() => String(defaultChunkSize(pageCount)));
  const [ranges, setRanges] = useState('');
  const everyRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<HTMLInputElement>(null);
  const problemsId = useId();

  if (doc === undefined) return null;
  const outline = outlineCuts(doc);
  const selectedCuts = selectionCuts(doc, selected);
  const parsedRanges = parsePageRanges(ranges, pageCount);
  const n = Number(every);

  let preview: SplitPreview;
  let spec: SplitSpec | undefined;
  let titles: (string | undefined)[] | undefined;
  switch (mode) {
    case 'every':
      preview = previewSplit(pageCount, { mode: 'every', n });
      spec = { mode: 'every', n };
      break;
    case 'ranges':
      preview = parsedRanges.ok
        ? previewSplit(pageCount, { mode: 'ranges', ranges: parsedRanges.ranges })
        : { ok: false, reason: 'invalid' };
      spec = parsedRanges.ok ? { mode: 'ranges', ranges: parsedRanges.ranges } : undefined;
      break;
    case 'outline':
      preview = previewSplit(pageCount, { mode: 'cuts', cuts: outline.cuts });
      spec = {
        mode: 'at-pages',
        pageIds: outline.cuts.flatMap((i) => doc.pages[i]?.id ?? []),
      };
      titles = [...outline.titles];
      break;
    case 'selection':
      preview = previewSplit(pageCount, { mode: 'cuts', cuts: selectedCuts });
      spec = {
        mode: 'at-pages',
        pageIds: selectedCuts.flatMap((i) => doc.pages[i]?.id ?? []),
      };
      break;
  }

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!preview.ok || spec === undefined) return;
    const created = splitSection(documentId, spec, titles);
    if (created.length > 0) closeOperationDialog();
  };

  const [everyBefore, everyAfter] = around((marker) => m.split_mode_every({ n: marker }));
  const showRangeProblems = mode === 'ranges' && ranges.trim().length > 0 && !parsedRanges.ok;

  return (
    <Frame
      title={m.split_title({ title: doc.title })}
      testId="split-dialog"
      initialFocus={everyRef}
    >
      <form className={styles.body} onSubmit={submit}>
        <p className={styles.description}>
          {m.split_description({ pages: pagesPhrase(pageCount) })}
        </p>
        <fieldset className={local.options}>
          <legend className={local.legend}>{m.split_mode_label()}</legend>

          <label className={local.option} data-inline="">
            <input
              type="radio"
              name="split-mode"
              checked={mode === 'every'}
              onChange={() => setMode('every')}
            />
            <span className={local.optionTitle}>
              {everyBefore}
              <input
                ref={everyRef}
                type="number"
                min={1}
                max={Math.max(1, pageCount - 1)}
                inputMode="numeric"
                className={`${styles.input} ${local.number}`}
                aria-label={m.split_every_input_label()}
                value={every}
                onFocus={() => setMode('every')}
                onChange={(event) => {
                  setMode('every');
                  setEvery(event.target.value);
                }}
              />
              {everyAfter}
            </span>
          </label>

          <label className={local.option}>
            <input
              type="radio"
              name="split-mode"
              checked={mode === 'ranges'}
              onChange={() => {
                setMode('ranges');
                requestAnimationFrame(() => rangesRef.current?.focus());
              }}
            />
            <span className={local.optionTitle}>{m.split_mode_ranges()}</span>
            <input
              ref={rangesRef}
              className={`${styles.input} ${local.rangeInput}`}
              aria-label={m.split_ranges_input_label()}
              placeholder={m.split_ranges_placeholder()}
              spellCheck={false}
              autoComplete="off"
              value={ranges}
              aria-invalid={showRangeProblems || undefined}
              aria-describedby={showRangeProblems ? problemsId : undefined}
              data-testid="split-ranges"
              onFocus={() => setMode('ranges')}
              onChange={(event) => {
                setMode('ranges');
                setRanges(event.target.value);
              }}
            />
            <span className={local.optionHint}>{m.split_ranges_hint({ title: doc.title })}</span>
            {showRangeProblems && !parsedRanges.ok ? (
              <ul id={problemsId} className={local.problems} data-testid="split-range-errors">
                {parsedRanges.problems.map((problem, i) => (
                  <li key={i}>{rangeProblemMessage(problem)}</li>
                ))}
              </ul>
            ) : null}
          </label>

          <label className={local.option} data-disabled={outline.bookmarks === 0 || undefined}>
            <input
              type="radio"
              name="split-mode"
              checked={mode === 'outline'}
              disabled={outline.bookmarks === 0}
              onChange={() => setMode('outline')}
            />
            <span className={local.optionTitle}>{m.split_mode_outline()}</span>
            <span className={local.optionHint}>
              {outline.bookmarks === 0
                ? m.split_outline_none()
                : m.split_outline_hint({ count: outline.bookmarks })}
            </span>
          </label>

          <label className={local.option} data-disabled={selectedCuts.length === 0 || undefined}>
            <input
              type="radio"
              name="split-mode"
              checked={mode === 'selection'}
              disabled={selectedCuts.length === 0}
              onChange={() => setMode('selection')}
            />
            <span className={local.optionTitle}>{m.split_mode_selection()}</span>
            <span className={local.optionHint}>
              {selectedCuts.length === 0
                ? m.split_selection_none()
                : m.split_selection_hint({ count: selectedCuts.length })}
            </span>
          </label>
        </fieldset>

        <p
          className={local.preview}
          role="status"
          data-testid="split-preview"
          data-ok={preview.ok || undefined}
        >
          {splitPreviewText(preview, mode, doc.title, ranges).map((line) => (
            <span key={line} className={local.previewLine}>
              {line}
            </span>
          ))}
        </p>
        <Actions confirm={m.split_confirm()} disabled={!preview.ok} />
      </form>
    </Frame>
  );
}

function splitPreviewText(
  preview: SplitPreview,
  mode: SplitMode,
  title: string,
  ranges: string,
): string[] {
  if (preview.ok) {
    const created = m.split_preview({
      count: preview.parts.length,
      sizes: sizesList(preview.parts),
    });
    return preview.remaining > 0
      ? [created, m.split_preview_remaining({ pages: pagesPhrase(preview.remaining), title })]
      : [created];
  }
  if (preview.reason === 'single-part') {
    return [mode === 'outline' ? m.split_outline_single() : m.split_single_part()];
  }
  if (mode === 'ranges') {
    return [ranges.trim().length === 0 ? m.range_error_empty() : m.split_fix_ranges()];
  }
  return [m.split_invalid_every()];
}

// ---------------------------------------------------------------------------
// Merge into…
// ---------------------------------------------------------------------------

function DocumentOption({
  tab,
  name,
  checked,
  onChange,
}: {
  readonly tab: TabItem;
  readonly name: string;
  readonly checked: boolean;
  readonly onChange: () => void;
}) {
  return (
    <label className={local.docOption}>
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span className={local.tag} data-tag={tab.colorIndex} aria-hidden="true" />
      <span className={local.docTitle}>{tab.title}</span>
      <span className={local.docMeta}>{pagesPhrase(tab.pageCount)}</span>
    </label>
  );
}

function MergeIntoDialog({ documentId }: { readonly documentId: DocumentId }) {
  const liveTabs = useTabItems();
  // The merge consumes the documents; keep showing them while the dialog closes.
  const [initialTabs] = useState(liveTabs);
  const tabs = liveTabs.some((t) => t.id === documentId) ? liveTabs : initialTabs;
  const source = tabs.find((t) => t.id === documentId);
  const others = tabs.filter((t) => t.id !== documentId);
  const [target, setTarget] = useState<DocumentId | undefined>(others[0]?.id);
  if (source === undefined) return null;
  const chosen = others.find((t) => t.id === target);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (chosen === undefined) return;
    if (mergeInto(documentId, chosen.id) !== undefined) closeOperationDialog();
  };

  return (
    <Frame title={m.merge_into_title({ title: source.title })} testId="merge-into-dialog">
      <form className={styles.body} onSubmit={submit}>
        <p className={styles.description}>{m.merge_into_description({ title: source.title })}</p>
        {others.length === 0 ? (
          <p className={styles.description}>{m.hint_needs_other_document()}</p>
        ) : (
          <fieldset className={local.options}>
            <legend className={local.legend}>{m.merge_into_target()}</legend>
            {others.map((tab) => (
              <DocumentOption
                key={tab.id}
                tab={tab}
                name="merge-target"
                checked={tab.id === target}
                onChange={() => setTarget(tab.id)}
              />
            ))}
          </fieldset>
        )}
        <p className={local.preview} role="status" data-ok={chosen !== undefined || undefined}>
          {chosen === undefined
            ? m.hint_needs_other_document()
            : m.merge_into_preview({
                title: chosen.title,
                pages: pagesPhrase(chosen.pageCount + source.pageCount),
              })}
        </p>
        <Actions confirm={m.merge_confirm()} disabled={chosen === undefined} />
      </form>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Merge all open documents
// ---------------------------------------------------------------------------

function MergeAllDialog() {
  const liveTabs = useTabItems();
  const [initialTabs] = useState(liveTabs);
  const tabs = liveTabs.length > 1 ? liveTabs : initialTabs;
  const [order, setOrder] = useState<readonly DocumentId[]>(() => tabs.map((t) => t.id));
  const [title, setTitle] = useState(() => tabs[0]?.title ?? '');
  const [touched, setTouched] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const titleId = useId();
  const errorId = useId();

  const rows = order.flatMap((id) => tabs.find((t) => t.id === id) ?? []);
  const total = rows.reduce((sum, t) => sum + t.pageCount, 0);
  const checked = validateTitle(title);
  const ready = rows.length >= 2 && checked.ok;

  const move = (index: number, direction: -1 | 1) => {
    setOrder((current) => moveItem(current, index, direction));
    // Keep focus on the moved row's same button so repeated presses keep moving it.
    const buttonIndex = direction < 0 ? 0 : 1;
    requestAnimationFrame(() => {
      const target = listRef.current?.children[index + direction];
      const button = target?.querySelectorAll('button')[buttonIndex];
      if (button && !button.disabled) button.focus();
      else target?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!ready) return;
    if (
      mergeAll(
        rows.map((r) => r.id),
        title,
      ) !== undefined
    )
      closeOperationDialog();
  };

  return (
    <Frame title={m.merge_all_title()} testId="merge-all-dialog" wide>
      <form className={styles.body} onSubmit={submit}>
        <p className={styles.description}>{m.merge_all_description()}</p>
        <ol ref={listRef} className={local.list} aria-label={m.merge_all_order_label()}>
          {rows.map((tab, index) => (
            <li key={tab.id} className={local.listRow} data-testid="merge-row">
              <span className={local.rowIndex}>{formatNumber(index + 1)}</span>
              <span className={local.tag} data-tag={tab.colorIndex} aria-hidden="true" />
              <span className={local.docTitle}>{tab.title}</span>
              <span className={local.docMeta}>{pagesPhrase(tab.pageCount)}</span>
              <span className={local.rowButtons}>
                <IconButton
                  label={m.merge_move_up({ title: tab.title })}
                  icon={<ArrowUp />}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                />
                <IconButton
                  label={m.merge_move_down({ title: tab.title })}
                  icon={<ArrowDown />}
                  disabled={index === rows.length - 1}
                  onClick={() => move(index, 1)}
                />
              </span>
            </li>
          ))}
        </ol>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={titleId}>
            {m.merge_all_name_label()}
          </label>
          <input
            id={titleId}
            className={styles.input}
            value={title}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={(touched && !checked.ok) || undefined}
            aria-describedby={touched && !checked.ok ? errorId : undefined}
            onChange={(event) => {
              setTitle(event.target.value);
              setTouched(true);
            }}
          />
          {touched && !checked.ok ? (
            <span id={errorId} className={local.fieldError}>
              {titleProblemMessage(checked.problem)}
            </span>
          ) : null}
        </div>
        <p className={local.preview} role="status" data-ok={ready || undefined}>
          {m.merge_all_preview({ count: rows.length, pages: pagesPhrase(total) })}
        </p>
        <Actions confirm={m.merge_confirm()} disabled={!ready} />
      </form>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Interleave with…
// ---------------------------------------------------------------------------

function InterleaveDialog({ documentId }: { readonly documentId: DocumentId }) {
  const liveTabs = useTabItems();
  const [initialTabs] = useState(liveTabs);
  const tabs = liveTabs.some((t) => t.id === documentId) ? liveTabs : initialTabs;
  const pinned = new Set(useUiStore((s) => s.arrangePinned));
  const first = tabs.find((t) => t.id === documentId);
  // Shown documents first (the light table's sections), then the other open tabs.
  const others = tabs
    .filter((t) => t.id !== documentId)
    .sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
  const [second, setSecond] = useState<DocumentId | undefined>(others[0]?.id);
  const [mode, setMode] = useState<InterleaveMode>('alternate');
  if (first === undefined) return null;
  const other = others.find((t) => t.id === second);
  const slots =
    other === undefined ? [] : previewInterleave(first.pageCount, other.pageCount, mode, 6);
  const total = first.pageCount + (other?.pageCount ?? 0);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (other === undefined) return;
    if (interleaveWith(documentId, other.id, mode) !== undefined) closeOperationDialog();
  };

  return (
    <Frame title={m.interleave_title({ title: first.title })} testId="interleave-dialog" wide>
      <form className={styles.body} onSubmit={submit}>
        <div className={local.columns}>
          <fieldset className={local.options}>
            <legend className={local.legend}>{m.interleave_second_label()}</legend>
            {others.map((tab) => (
              <DocumentOption
                key={tab.id}
                tab={tab}
                name="interleave-second"
                checked={tab.id === second}
                onChange={() => setSecond(tab.id)}
              />
            ))}
          </fieldset>
          <fieldset className={local.options}>
            <legend className={local.legend}>{m.interleave_mode_label()}</legend>
            <label className={local.option}>
              <input
                type="radio"
                name="interleave-mode"
                checked={mode === 'alternate'}
                onChange={() => setMode('alternate')}
              />
              <span className={local.optionTitle}>{m.interleave_mode_alternate()}</span>
              <span className={local.optionHint}>{m.interleave_mode_alternate_hint()}</span>
            </label>
            <label className={local.option}>
              <input
                type="radio"
                name="interleave-mode"
                checked={mode === 'duplex-reverse-b'}
                onChange={() => setMode('duplex-reverse-b')}
              />
              <span className={local.optionTitle}>{m.interleave_mode_duplex()}</span>
              <span className={local.optionHint}>{m.interleave_mode_duplex_hint()}</span>
            </label>
          </fieldset>
        </div>

        {other === undefined ? (
          <p className={local.preview}>{m.hint_needs_other_document()}</p>
        ) : (
          <div className={local.previewBlock}>
            <span className={local.legend}>{m.interleave_preview_label()}</span>
            <ol className={local.chips} data-testid="interleave-preview">
              {slots.map((slot, i) => {
                const tab = slot.from === 'a' ? first : other;
                return (
                  <li
                    key={i}
                    className={local.chip}
                    data-tag={tab.colorIndex}
                    aria-label={m.interleave_slot_label({ title: tab.title, page: slot.page })}
                  >
                    <span className={local.chipLetter} aria-hidden="true">
                      {slot.from === 'a' ? 'A' : 'B'}
                    </span>
                    {formatNumber(slot.page)}
                  </li>
                );
              })}
              {total > slots.length ? (
                <li className={local.chipMore}>
                  {m.interleave_more({ count: total - slots.length })}
                </li>
              ) : null}
            </ol>
            <p className={local.legendLine}>
              <span className={local.chipLetter}>A</span> {first.title}
              <span className={local.legendGap} />
              <span className={local.chipLetter}>B</span> {other.title}
            </p>
            <p className={local.preview} role="status" data-ok="">
              {m.interleave_preview({
                title: `${first.title} + ${other.title}`,
                pages: pagesPhrase(total),
              })}
            </p>
          </div>
        )}
        <Actions confirm={m.interleave_confirm()} disabled={other === undefined} />
      </form>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Image size question
// ---------------------------------------------------------------------------

function ImageSizeDialog({
  count,
  largest,
}: {
  readonly count: number;
  readonly largest: { readonly width: number; readonly height: number };
}) {
  const [choice, setChoice] = useState<ImageSizing>('fit-a4');
  const fitted = imagePageSize(largest.width, largest.height, 'fit-a4');
  const cm = (points: number) => formatNumber(Math.round((points / 72) * 2.54 * 10) / 10);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    answerImageSizing(choice);
  };

  return (
    <Frame title={m.image_size_title({ count })} testId="image-size-dialog">
      <form className={styles.body} onSubmit={submit}>
        <p className={styles.description}>{m.image_size_description()}</p>
        <fieldset className={local.options}>
          <legend className={local.legend}>{m.image_size_label()}</legend>
          <label className={local.option}>
            <input
              type="radio"
              name="image-size"
              checked={choice === 'fit-a4'}
              onChange={() => setChoice('fit-a4')}
            />
            <span className={local.optionTitle}>{m.image_size_fit()}</span>
            <span className={local.optionHint}>
              {m.image_size_fit_hint({
                width: cm(Math.min(fitted.width, A4.width)),
                height: cm(fitted.height),
              })}
            </span>
          </label>
          <label className={local.option}>
            <input
              type="radio"
              name="image-size"
              checked={choice === 'original'}
              onChange={() => setChoice('original')}
            />
            <span className={local.optionTitle}>{m.image_size_original()}</span>
            <span className={local.optionHint}>
              {m.image_size_original_hint({ width: cm(largest.width), height: cm(largest.height) })}
            </span>
          </label>
        </fieldset>
        <Actions confirm={m.image_size_confirm()} disabled={false} />
      </form>
    </Frame>
  );
}
