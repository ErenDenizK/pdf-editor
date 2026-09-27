/**
 * Compress dialog (spec §5): the document is assembled as it would be exported, analyzed
 * in the compress worker (images with encoding, colour space and effective DPI; the
 * lossless size measured by a real qpdf pass), and the user picks a preset with an
 * estimate shown *before* running (and a notice when under 3 %). The run reports progress;
 * the result screen shows before → after per page and in total, skipped images with the
 * reason, and a Compare view rendering the same page before and after at 200 %.
 * "Apply to export" stores the preset for this document; the export pipeline then
 * compresses the assembled bytes. "Download copy" saves the compressed PDF directly.
 */
import { Dialog } from '@base-ui/react/dialog';
import type { DocumentId } from '@pdf-editor/document-model';
import {
  COMPRESSION_PRESETS,
  type CompressionPresetId,
  type CompressionResult,
  planImage,
} from '@pdf-editor/engine';
import { X } from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';

import { deliverPdf } from '../export/deliver';
import { exportFileName } from '../export/filename';
import { formatBytes } from '../files/file-filters';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import overlay from '../shell/ShortcutOverlay.module.css';
import { useWorkspaceStore } from '../state/workspace-store';
import { getCompressor } from './compress-client';
import {
  type CompressState,
  compressReducer,
  currentEstimate,
  deltaPercent,
  INITIAL_COMPRESS_STATE,
  progressShare,
} from './compress-model';
import { openScratch, type ScratchDocument, toolRenderer } from './engine-access';
import { presetName, skipReason } from './labels';
import { toolSourceBytes } from './tool-source';
import styles from './ToolDialog.module.css';
import { verifyCopy } from './verify-copy';
import {
  closeToolDialog,
  exportCompressionFor,
  setExportCompression,
  useToolsStore,
} from './tools-store';

const PRESETS: readonly CompressionPresetId[] = ['screen', 'ebook', 'print', 'custom'];

export default function CompressDialog({ documentId }: { readonly documentId: DocumentId }) {
  const open = useToolsStore((s) => s.dialog?.kind === 'compress');
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) closeToolDialog();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={overlay.backdrop} />
        <CompressFlow documentId={documentId} />
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CompressFlow({ documentId }: { readonly documentId: DocumentId }) {
  const title = useWorkspaceStore((s) => s.workspace.documents[documentId]?.title) ?? '';
  const [state, dispatch] = useReducer(compressReducer, INITIAL_COMPRESS_STATE);
  const [source, setSource] = useState<ArrayBuffer | null>(null);
  const controller = useRef<AbortController | null>(null);
  const applied = useToolsStore((s) => s.exportCompression[documentId]);

  // Stage 1: assemble (as exported, without compression) and analyze.
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    void (async () => {
      try {
        const bytes = await toolSourceBytes(documentId, abort.signal);
        if (abort.signal.aborted) return;
        setSource(bytes);
        const compressor = await getCompressor();
        const analysis = await compressor.analyze(bytes.slice(0));
        if (abort.signal.aborted) return;
        const initial = exportCompressionFor(documentId);
        dispatch({ type: 'analyzed', analysis, ...(initial ? { initial } : {}) });
      } catch (error) {
        if (!abort.signal.aborted) dispatch({ type: 'failed', message: reasonOf(error) });
      }
    })();
    return () => abort.abort();
  }, [documentId]);

  const run = async () => {
    if (state.step !== 'choose' || source === null) return;
    const settings = state.settings;
    dispatch({ type: 'run' });
    const abort = new AbortController();
    controller.current = abort;
    try {
      const compressor = await getCompressor();
      const result = await compressor.compress(source.slice(0), settings, {
        signal: abort.signal,
        onProgress: (progress) => {
          if (!abort.signal.aborted) dispatch({ type: 'progress', progress });
        },
      });
      if (abort.signal.aborted) return;
      dispatch({ type: 'finished', result });
      announce(
        m.announce_compressed({
          before: formatBytes(result.before),
          after: formatBytes(result.after),
        }),
      );
    } catch (error) {
      if (!abort.signal.aborted) dispatch({ type: 'failed', message: reasonOf(error) });
    }
  };

  const cancel = () => {
    controller.current?.abort();
    dispatch({ type: 'cancel' });
  };

  const apply = () => {
    if (state.step !== 'result' && state.step !== 'choose') return;
    setExportCompression(documentId, state.settings);
    announce(m.announce_compression_applied({ preset: presetName(state.settings.preset) }));
    closeToolDialog();
  };

  const download = async (result: CompressionResult) => {
    const name = exportFileName(`${title}-compressed`);
    try {
      // Only verified bytes are offered (ARCHITECTURE.md §4): same pages as the source.
      if (source === null) return;
      const problems = await verifyCopy(source, result.bytes);
      if (problems.length > 0) {
        dispatch({ type: 'failed', message: problems.join('; ') });
        return;
      }
      const outcome = await deliverPdf(result.bytes.slice(0), name);
      if (outcome === 'cancelled') return;
      announce(outcome === 'saved' ? m.announce_saved({ name }) : m.announce_downloaded({ name }));
    } catch (error) {
      dispatch({ type: 'failed', message: reasonOf(error) });
    }
  };

  const wide = state.step === 'choose' || state.step === 'result';
  return (
    <Dialog.Popup
      className={`${overlay.popup} ${styles.popup} ${wide ? styles.wide : ''}`}
      data-testid="compress-dialog"
    >
      <div className={overlay.header}>
        <Dialog.Title className={overlay.title}>{m.compress_title()}</Dialog.Title>
        <Dialog.Close className={overlay.close} aria-label={m.common_close()}>
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>
      {state.step === 'analyzing' ? (
        <div className={styles.body}>
          <p className={styles.description} role="status">
            {m.compress_preparing()}
          </p>
          <progress className={styles.progress} aria-label={m.compress_progress_label()} />
        </div>
      ) : null}
      {state.step === 'choose' ? (
        <ChooseStep
          state={state}
          dispatch={dispatch}
          applied={applied !== undefined}
          onRun={() => void run()}
          onRemove={() => {
            setExportCompression(documentId, null);
            announce(m.announce_compression_removed());
          }}
        />
      ) : null}
      {state.step === 'running' ? (
        <div className={styles.body}>
          <p className={styles.description} role="status">
            {phaseText(state)}
          </p>
          <progress
            className={styles.progress}
            max={100}
            value={progressShare(state.progress)}
            aria-label={m.compress_progress_label()}
          />
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={cancel}>
              {m.common_cancel()}
            </button>
          </div>
        </div>
      ) : null}
      {state.step === 'result' && source ? (
        <ResultStep
          state={state}
          source={source}
          dispatch={dispatch}
          onApply={apply}
          onDownload={() => void download(state.result)}
        />
      ) : null}
      {state.step === 'failed' ? (
        <div className={styles.body}>
          <p className={styles.error} role="alert">
            {m.compress_failed({ reason: state.message })}
          </p>
          <div className={styles.actions}>
            <Dialog.Close className={styles.secondary}>{m.common_close()}</Dialog.Close>
            {state.back ? (
              <button
                type="button"
                className={styles.primary}
                onClick={() => dispatch({ type: 'back' })}
              >
                {m.common_back()}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Dialog.Popup>
  );
}

function phaseText(state: Extract<CompressState, { step: 'running' }>): string {
  const p = state.progress;
  if (p === null || p.phase === 'analyzing') return m.compress_phase_analyzing();
  if (p.phase === 'images') {
    return m.compress_phase_images({ done: Math.min(p.done + 1, p.total), total: p.total });
  }
  if (p.phase === 'lossless') return m.compress_phase_lossless();
  return m.compress_phase_finishing();
}

function ChooseStep({
  state,
  dispatch,
  applied,
  onRun,
  onRemove,
}: {
  readonly state: Extract<CompressState, { step: 'choose' }>;
  readonly dispatch: (action: Parameters<typeof compressReducer>[1]) => void;
  readonly applied: boolean;
  readonly onRun: () => void;
  readonly onRemove: () => void;
}) {
  const { analysis, settings, custom } = state;
  const estimate = currentEstimate(state);
  const runRef = useRef<HTMLButtonElement>(null);
  useEffect(() => runRef.current?.focus(), []);
  return (
    <form
      className={styles.body}
      onSubmit={(event) => {
        event.preventDefault();
        onRun();
      }}
    >
      <Dialog.Description className={styles.description}>
        {m.compress_summary({
          size: formatBytes(analysis.totalBytes),
          images: m.tools_images_count({ count: analysis.images.length }),
          fonts: m.tools_fonts_count({ count: analysis.fonts.length }),
          objects: analysis.objectCount,
        })}
      </Dialog.Description>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{m.compress_preset_label()}</legend>
        <div className={styles.presets}>
          {PRESETS.map((preset) => (
            <label key={preset} className={styles.preset}>
              <input
                type="radio"
                name="compress-preset"
                value={preset}
                checked={settings.preset === preset}
                disabled={!settings.images}
                onChange={() => dispatch({ type: 'preset', preset })}
              />
              <span className={styles.presetName}>{presetName(preset)}</span>
              <span className={styles.hint}>
                {preset === 'custom'
                  ? m.compress_preset_values({ dpi: custom.dpi, quality: custom.quality })
                  : m.compress_preset_values(COMPRESSION_PRESETS[preset])}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {settings.preset === 'custom' && settings.images ? (
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>{m.compress_custom_dpi()}</span>
            <input
              className={styles.input}
              type="number"
              min={36}
              max={1200}
              value={custom.dpi}
              onChange={(event) => dispatch({ type: 'custom', dpi: Number(event.target.value) })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{m.compress_custom_quality()}</span>
            <input
              className={styles.input}
              type="number"
              min={1}
              max={100}
              value={custom.quality}
              onChange={(event) =>
                dispatch({ type: 'custom', quality: Number(event.target.value) })
              }
            />
          </label>
        </div>
      ) : null}
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={settings.images}
          onChange={(event) => dispatch({ type: 'images', enabled: event.target.checked })}
        />
        <span>
          {m.compress_images_toggle()}
          <span className={styles.hint}>{m.compress_images_hint()}</span>
        </span>
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={settings.flattenAlpha}
          disabled={!settings.images}
          onChange={(event) => dispatch({ type: 'flatten-alpha', enabled: event.target.checked })}
        />
        <span>
          {m.compress_flatten_alpha()}
          <span className={styles.hint}>{m.compress_flatten_alpha_hint()}</span>
        </span>
      </label>
      {estimate ? (
        <div className={styles.estimate} data-testid="compress-estimate">
          {m.compress_estimate({
            before: formatBytes(estimate.before),
            after: formatBytes(estimate.after),
            delta: deltaPercent(estimate.before, estimate.after),
          })}
          {!estimate.worthwhile ? (
            <p className={styles.notice} role="note">
              {m.compress_estimate_low()}
            </p>
          ) : null}
        </div>
      ) : null}
      {analysis.images.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>{m.compress_table_label()}</caption>
            <thead>
              <tr>
                <th scope="col">{m.compress_col_page()}</th>
                <th scope="col">{m.compress_col_pixels()}</th>
                <th scope="col">{m.compress_col_colour()}</th>
                <th scope="col">{m.compress_col_encoding()}</th>
                <th scope="col">{m.compress_col_dpi()}</th>
                <th scope="col">{m.compress_col_bytes()}</th>
                <th scope="col">{m.compress_col_plan()}</th>
              </tr>
            </thead>
            <tbody>
              {analysis.images.map((image) => {
                const plan = settings.images ? planImage(image, settings) : null;
                return (
                  <tr key={image.ref}>
                    <td>{image.page === null ? '–' : image.page + 1}</td>
                    <td>
                      {image.width}×{image.height}
                    </td>
                    <td>
                      {image.colorSpace}
                      {image.hasSMask ? ' + α' : ''}
                    </td>
                    <td>{image.filter}</td>
                    <td>{image.dpi ? Math.min(image.dpi.x, image.dpi.y) : m.compress_unknown()}</td>
                    <td>{formatBytes(image.bytes)}</td>
                    <td data-skip={plan?.action === 'skip' || plan === null || undefined}>
                      {plan === null
                        ? '–'
                        : plan.action === 'skip'
                          ? skipReason(plan.reason)
                          : plan.downsample
                            ? m.compress_plan_downsample({ width: plan.width, height: plan.height })
                            : m.compress_plan_recompress()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={styles.description}>{m.compress_no_images()}</p>
      )}
      <div className={styles.actions}>
        {applied ? (
          <button type="button" className={styles.secondary} onClick={onRemove}>
            {m.compress_remove()}
          </button>
        ) : null}
        <span className={styles.spacer} />
        <Dialog.Close className={styles.secondary}>{m.common_cancel()}</Dialog.Close>
        <button ref={runRef} type="submit" className={styles.primary}>
          {m.compress_run()}
        </button>
      </div>
    </form>
  );
}

function ResultStep({
  state,
  source,
  dispatch,
  onApply,
  onDownload,
}: {
  readonly state: Extract<CompressState, { step: 'result' }>;
  readonly source: ArrayBuffer;
  readonly dispatch: (action: Parameters<typeof compressReducer>[1]) => void;
  readonly onApply: () => void;
  readonly onDownload: () => void;
}) {
  const { result } = state;
  const skipped = result.images.filter((r) => r.action === 'skipped');
  const applyRef = useRef<HTMLButtonElement>(null);
  useEffect(() => applyRef.current?.focus(), []);
  return (
    <div className={styles.body}>
      <p className={styles.strong} data-testid="compress-result" role="status">
        {result.unchanged
          ? m.compress_result_unchanged()
          : m.compress_result({
              before: formatBytes(result.before),
              after: formatBytes(result.after),
              delta: deltaPercent(result.before, result.after),
            })}
      </p>
      {!result.unchanged ? (
        <p className={styles.description}>
          {result.imagesSaved > 0
            ? m.compress_result_breakdown({
                images: formatBytes(result.imagesSaved),
                lossless: formatBytes(result.losslessSaved),
              })
            : m.compress_result_structure_only({ lossless: formatBytes(result.losslessSaved) })}
        </p>
      ) : null}
      {result.pages.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>{m.compress_pages_label()}</caption>
            <thead>
              <tr>
                <th scope="col">{m.compress_col_page()}</th>
                <th scope="col">{m.compress_compare_before()}</th>
                <th scope="col">{m.compress_compare_after()}</th>
                <th scope="col">{m.compress_col_result()}</th>
              </tr>
            </thead>
            <tbody>
              {result.pages.map((page) => (
                <tr key={page.page}>
                  <td>{page.page + 1}</td>
                  <td>{formatBytes(page.before)}</td>
                  <td>{formatBytes(page.after)}</td>
                  <td>{deltaPercent(page.before, page.after)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {skipped.length > 0 ? (
        <details>
          <summary className={styles.description}>
            {m.compress_skipped_label({ count: skipped.length })}
          </summary>
          <ul className={styles.list}>
            {skipped.map((report) => (
              <li key={report.ref}>
                {report.page === null
                  ? ''
                  : `${m.compress_page_number({ page: report.page + 1 })}: `}
                {report.width}×{report.height}, {formatBytes(report.before)} —{' '}
                {report.reason ? skipReason(report.reason) : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={state.compare}
          onChange={(event) => dispatch({ type: 'compare', enabled: event.target.checked })}
        />
        <span>{m.compress_compare()}</span>
      </label>
      {state.compare ? (
        <CompareView
          before={source}
          after={result.bytes}
          page={state.comparePage}
          pageCount={state.analysis.pageCount}
          onPage={(page) => dispatch({ type: 'compare-page', page })}
        />
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => dispatch({ type: 'back' })}
        >
          {m.common_back()}
        </button>
        <span className={styles.spacer} />
        <button type="button" className={styles.secondary} onClick={onDownload}>
          {m.compress_download()}
        </button>
        <button
          ref={applyRef}
          type="button"
          className={styles.primary}
          onClick={onApply}
          disabled={result.unchanged}
        >
          {m.compress_apply()}
        </button>
      </div>
    </div>
  );
}

/** Same page before and after at 200 %, scrolled together. */
function CompareView({
  before,
  after,
  page,
  pageCount,
  onPage,
}: {
  readonly before: ArrayBuffer;
  readonly after: ArrayBuffer;
  readonly page: number;
  readonly pageCount: number;
  readonly onPage: (page: number) => void;
}) {
  const [docs, setDocs] = useState<readonly ScratchDocument[] | null>(null);
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const rendering = renderedPage !== page;

  useEffect(() => {
    let cancelled = false;
    let opened: ScratchDocument[] = [];
    void Promise.all([openScratch(before.slice(0)), openScratch(after.slice(0))]).then((pair) => {
      opened = pair;
      if (cancelled) {
        for (const d of pair) void d.close();
        return;
      }
      setDocs(pair);
    });
    return () => {
      cancelled = true;
      for (const d of opened) void d.close();
    };
  }, [before, after]);

  useEffect(() => {
    if (!docs) return;
    const controller = new AbortController();
    void (async () => {
      const renderer = await toolRenderer();
      for (const [doc, host] of [
        [docs[0], left.current],
        [docs[1], right.current],
      ] as const) {
        if (!doc || !host || controller.signal.aborted) continue;
        const rendered = await renderer.renderPage(doc.id, page, {
          scale: 2,
          signal: controller.signal,
        });
        const canvas = document.createElement('canvas');
        canvas.width = rendered.width;
        canvas.height = rendered.height;
        canvas.getContext('2d')?.drawImage(rendered.bitmap, 0, 0);
        rendered.bitmap.close();
        canvas.style.width = `${rendered.width / (window.devicePixelRatio || 1)}px`;
        host.replaceChildren(canvas);
      }
      if (!controller.signal.aborted) setRenderedPage(page);
    })().catch(() => {
      if (!controller.signal.aborted) setRenderedPage(page);
    });
    return () => controller.abort();
  }, [docs, page]);

  const sync = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to) return;
    to.scrollTop = from.scrollTop;
    to.scrollLeft = from.scrollLeft;
  };

  return (
    <div className={styles.fieldset} data-testid="compress-compare">
      <label className={styles.field}>
        <span className={styles.label}>
          {m.compress_compare_page()} · {m.compress_compare_zoom()}
          {rendering ? ` · ${m.compress_compare_rendering()}` : ''}
        </span>
        <select
          className={styles.select}
          value={page}
          onChange={(event) => onPage(Number(event.target.value))}
        >
          {Array.from({ length: pageCount }, (_, i) => (
            <option key={i} value={i}>
              {i + 1}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.compare}>
        <div className={styles.pane}>
          <span className={styles.paneLabel}>{m.compress_compare_before()}</span>
          <div
            ref={left}
            className={styles.viewport}
            // A scrollable region must be reachable by keyboard (WCAG 2.1.1).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="img"
            aria-label={m.compress_compare_before()}
            onScroll={() => sync(left.current, right.current)}
          />
        </div>
        <div className={styles.pane}>
          <span className={styles.paneLabel}>{m.compress_compare_after()}</span>
          <div
            ref={right}
            className={styles.viewport}
            // A scrollable region must be reachable by keyboard (WCAG 2.1.1).
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="img"
            aria-label={m.compress_compare_after()}
            onScroll={() => sync(right.current, left.current)}
          />
        </div>
      </div>
    </div>
  );
}
