/**
 * "Export as Markdown / text…" (spec recognize-and-compare §4): format, pages (whole
 * document, current page or a range), page breaks, running headers and footers, line-end
 * hyphens, and images (in a ZIP next to `document.md`, or left out). The dialog converts as
 * soon as it opens and again after each change (the previous run is cancelled), shows the
 * first 40 lines in a monospace preview and the report's honesty notes (reading order is a
 * heuristic, tables are not detected, pages without text need OCR first), and downloads
 * exactly what it previewed.
 */
import { Dialog } from '@base-ui/react/dialog';
import type { DocumentId } from '@pdf-editor/document-model';
import { type ConvertPageBreak, type ConvertResult, parsePageRange } from '@pdf-editor/engine';
import { X } from 'lucide-react';
import { type SyntheticEvent, useEffect, useId, useRef, useState } from 'react';

import { m } from '../i18n';
import { announce } from '../shell/announcer';
import overlay from '../shell/ShortcutOverlay.module.css';
import { useViewStore } from '../state/view-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { deliverFile } from '../tools/deliver-file';
import toolStyles from '../tools/ToolDialog.module.css';
import { closeToolDialog, useToolsStore } from '../tools/tools-store';
import styles from './ConvertDialog.module.css';
import {
  type ConvertChoice,
  choicePages,
  convertDocumentPages,
  DEFAULT_CHOICE,
  outputFile,
  previewLines,
} from './convert-run';

/** Wait after a change before converting again (typing a range). */
const DEBOUNCE_MS = 250;

/** A run's state, for the choices it was made with (`key`). */
type Step = { readonly key: string } & (
  | { readonly kind: 'working'; readonly done: number; readonly total: number }
  | { readonly kind: 'ready'; readonly result: ConvertResult; readonly title: string }
  | { readonly kind: 'failed'; readonly message: string }
);

export default function ConvertDialog({ documentId }: { readonly documentId: DocumentId }) {
  const open = useToolsStore((s) => s.dialog?.kind === 'markdown');
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) closeToolDialog();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={overlay.backdrop} />
        <ConvertFlow documentId={documentId} />
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const PAGE_BREAKS: readonly { readonly id: ConvertPageBreak; readonly label: () => string }[] = [
  { id: 'none', label: m.convert_break_none },
  { id: 'rule', label: m.convert_break_rule },
  { id: 'comment', label: m.convert_break_comment },
];

function ConvertFlow({ documentId }: { readonly documentId: DocumentId }) {
  const doc = useWorkspaceStore((s) => s.workspace.documents[documentId]);
  const currentPage = useViewStore((s) => s.currentPage);
  const pageCount = doc?.pages.length ?? 0;
  const title = doc?.title ?? 'document';
  const [choice, setChoice] = useState<ConvertChoice>(DEFAULT_CHOICE);
  const [latest, setStep] = useState<Step | null>(null);
  const [delivering, setDelivering] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const formatName = useId();
  const scopeName = useId();
  const imagesName = useId();
  const rangeHint = useId();
  const pages = choicePages(choice, pageCount, currentPage, parsePageRange);
  const pagesKey = pages?.join(',') ?? '';
  const markdown = choice.format === 'markdown';
  const runKey = `${documentId}|${JSON.stringify(choice)}|${pagesKey}|${title}`;
  // Until a run for the current choices reports, the dialog shows it as starting.
  const step: Step =
    latest?.key === runKey
      ? latest
      : { key: runKey, kind: 'working', done: 0, total: (pages?.length ?? 0) + 1 };

  useEffect(() => () => controller.current?.abort(), []);

  // Convert on open and after every change (debounced; the previous run is cancelled).
  useEffect(() => {
    controller.current?.abort();
    if (pagesKey === '') return;
    const abort = new AbortController();
    controller.current = abort;
    const list = pagesKey.split(',').map(Number);
    const key = runKey;
    const timer = window.setTimeout(() => {
      convertDocumentPages(documentId, list, choice, {
        signal: abort.signal,
        onProgress: (done, total) => {
          if (!abort.signal.aborted) setStep({ key, kind: 'working', done, total });
        },
      }).then(
        (result) => {
          if (!abort.signal.aborted) setStep({ key, kind: 'ready', result, title });
        },
        (error: unknown) => {
          if (abort.signal.aborted) return;
          setStep({
            key,
            kind: 'failed',
            message: m.convert_failed({
              reason: error instanceof Error ? error.message : String(error),
            }),
          });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [documentId, choice, pagesKey, title, runKey]);

  const update = (patch: Partial<ConvertChoice>) => setChoice((c) => ({ ...c, ...patch }));

  const download = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (step.kind !== 'ready') return;
    const file = outputFile(step.result, step.title);
    setDelivering(true);
    try {
      const outcome = await deliverFile(
        new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type }),
        file.name,
        file.type,
      );
      if (outcome === 'cancelled') return;
      announce(
        outcome === 'saved'
          ? m.announce_saved({ name: file.name })
          : m.announce_downloaded({ name: file.name }),
      );
      closeToolDialog();
    } catch (error) {
      setStep({
        key: runKey,
        kind: 'failed',
        message: m.convert_failed({
          reason: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      setDelivering(false);
    }
  };

  const result = step.kind === 'ready' ? step.result : null;
  const preview = result ? previewLines(result.text) : null;
  const output = result ? outputFile(result, title) : null;
  const without = result?.report.pagesWithoutText ?? [];

  return (
    <Dialog.Popup
      className={`${overlay.popup} ${toolStyles.popup} ${toolStyles.wide}`}
      data-testid="convert-dialog"
    >
      <div className={overlay.header}>
        <Dialog.Title className={overlay.title}>{m.convert_title()}</Dialog.Title>
        <Dialog.Close className={overlay.close} aria-label={m.common_close()}>
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>
      <form className={`${toolStyles.body} ${styles.layout}`} onSubmit={(e) => void download(e)}>
        <div className={styles.options}>
          <fieldset className={toolStyles.fieldset}>
            <legend className={toolStyles.legend}>{m.convert_format()}</legend>
            <div className={styles.presets2}>
              {(['markdown', 'text'] as const).map((format) => (
                <label key={format} className={toolStyles.preset}>
                  <input
                    type="radio"
                    name={formatName}
                    value={format}
                    checked={choice.format === format}
                    onChange={() => update({ format })}
                  />
                  <span className={toolStyles.presetName}>
                    {format === 'markdown' ? m.convert_format_markdown() : m.convert_format_text()}
                  </span>
                  <span className={toolStyles.hint}>
                    {format === 'markdown'
                      ? m.convert_format_markdown_hint()
                      : m.convert_format_text_hint()}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className={toolStyles.fieldset}>
            <legend className={toolStyles.legend}>{m.convert_scope()}</legend>
            <div className={styles.stack}>
              {(['document', 'page', 'range'] as const).map((scope) => (
                <label key={scope} className={toolStyles.check}>
                  <input
                    type="radio"
                    name={scopeName}
                    value={scope}
                    checked={choice.scope === scope}
                    onChange={() => update({ scope })}
                  />
                  <span>
                    {scope === 'document'
                      ? m.convert_scope_document()
                      : scope === 'page'
                        ? m.convert_scope_page({ page: Math.min(currentPage, pageCount - 1) + 1 })
                        : m.convert_scope_range()}
                  </span>
                </label>
              ))}
            </div>
            {choice.scope === 'range' ? (
              <label className={toolStyles.field}>
                <span className="visually-hidden">{m.convert_scope_range()}</span>
                <input
                  className={toolStyles.input}
                  value={choice.range}
                  placeholder={`1-${pageCount}`}
                  aria-invalid={pages === null}
                  aria-describedby={rangeHint}
                  onChange={(event) => update({ range: event.target.value })}
                />
                <span id={rangeHint} className={toolStyles.hint}>
                  {pages === null
                    ? m.images_pages_invalid({ count: pageCount })
                    : m.images_pages_hint()}
                </span>
              </label>
            ) : null}
          </fieldset>
          <label className={toolStyles.field}>
            <span className={toolStyles.label}>{m.convert_page_breaks()}</span>
            <select
              className={toolStyles.select}
              value={choice.pageBreak}
              onChange={(event) => update({ pageBreak: event.target.value as ConvertPageBreak })}
            >
              {PAGE_BREAKS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label()}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.stack}>
            <label className={toolStyles.check}>
              <input
                type="checkbox"
                checked={choice.keepHeadersFooters}
                onChange={(event) => update({ keepHeadersFooters: event.target.checked })}
              />
              <span>{m.convert_keep_headers()}</span>
            </label>
            <label className={toolStyles.check}>
              <input
                type="checkbox"
                checked={choice.joinHyphens}
                onChange={(event) => update({ joinHyphens: event.target.checked })}
              />
              <span>{m.convert_join_hyphens()}</span>
            </label>
          </div>
          {markdown ? (
            <fieldset className={toolStyles.fieldset}>
              <legend className={toolStyles.legend}>{m.convert_images()}</legend>
              <div className={styles.stack}>
                {([true, false] as const).map((images) => (
                  <label key={String(images)} className={toolStyles.check}>
                    <input
                      type="radio"
                      name={imagesName}
                      checked={choice.images === images}
                      onChange={() => update({ images })}
                    />
                    <span>{images ? m.convert_images_zip() : m.convert_images_omit()}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
        </div>
        <div className={styles.side}>
          <div className={styles.previewHeader}>
            <span className={toolStyles.label}>{m.convert_preview()}</span>
            {step.kind === 'working' ? (
              <span className={toolStyles.hint} role="status">
                {m.convert_progress({
                  done: Math.min(step.done, step.total),
                  total: step.total,
                })}
              </span>
            ) : null}
          </div>
          <pre
            className={styles.preview}
            data-testid="convert-preview"
            aria-label={m.convert_preview()}
            data-state={step.kind}
          >
            {preview ? preview.text : ''}
            {preview?.more ? `\n${m.convert_preview_more()}` : ''}
            {result?.text === '' ? m.convert_preview_empty() : ''}
          </pre>
          {result ? (
            <div className={styles.notes} data-testid="convert-notes">
              <p>{m.convert_note_order()}</p>
              <p>
                {result.report.suspectedTables > 0
                  ? m.convert_note_tables_found({ count: result.report.suspectedTables })
                  : m.convert_note_tables()}
              </p>
              {result.report.dropped.length > 0 && !choice.keepHeadersFooters ? (
                <p>{m.convert_note_dropped({ count: result.report.dropped.length })}</p>
              ) : null}
              {without.length > 0 ? (
                <div className={styles.ocr}>
                  <p>
                    {m.convert_note_without_text({
                      pages: without.map((p) => p + 1).join(', '),
                    })}
                  </p>
                  <button
                    type="button"
                    className={toolStyles.secondary}
                    disabled
                    aria-describedby="convert-ocr-hint"
                  >
                    {m.convert_ocr_first()}
                  </button>
                  <span id="convert-ocr-hint" className={toolStyles.hint}>
                    {m.convert_ocr_unavailable()}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
          {step.kind === 'failed' ? (
            <p className={toolStyles.error} role="alert">
              {step.message}
            </p>
          ) : null}
        </div>
        <div className={`${toolStyles.actions} ${styles.actions}`}>
          <span className={toolStyles.hint} data-testid="convert-output">
            {output ? m.convert_output({ name: output.name }) : ''}
          </span>
          <span className={toolStyles.spacer} />
          <Dialog.Close className={toolStyles.secondary}>{m.common_cancel()}</Dialog.Close>
          <button
            type="submit"
            className={toolStyles.primary}
            disabled={step.kind !== 'ready' || delivering}
          >
            {m.convert_download()}
          </button>
        </div>
      </form>
    </Dialog.Popup>
  );
}
