/**
 * PDF → images dialog (spec §6): format (PNG, JPEG, WebP), resolution (72/150/300/600 dpi
 * or custom), quality, background (white, or transparent for PNG/WebP), page range and a
 * file-name template. One page downloads as an image (or goes to the clipboard as PNG);
 * several pages come as a ZIP built in the compress worker.
 */
import { Dialog } from '@base-ui/react/dialog';
import type { DocumentId } from '@pdf-editor/document-model';
import {
  MAX_RASTER_DPI,
  MIN_RASTER_DPI,
  parsePageRange,
  RASTER_DPI_PRESETS,
  type RasterBackground,
  type RasterFormat,
  rasterSize,
} from '@pdf-editor/engine';
import { X } from 'lucide-react';
import { type SyntheticEvent, useEffect, useId, useRef, useState } from 'react';

import { m } from '../i18n';
import { displaySize } from '../pages/page-geometry';
import { announce } from '../shell/announcer';
import overlay from '../shell/ShortcutOverlay.module.css';
import { useWorkspaceStore } from '../state/workspace-store';
import { canCopyImage, copyImage, deliverFile } from './deliver-file';
import { RasterError, type RasterOptions, rasterizeDocument } from './rasterize';
import styles from './ToolDialog.module.css';
import { closeToolDialog, useToolsStore } from './tools-store';

const FORMATS: readonly { readonly id: RasterFormat; readonly label: string }[] = [
  { id: 'png', label: 'PNG' },
  { id: 'jpeg', label: 'JPEG' },
  { id: 'webp', label: 'WebP' },
];

type Step =
  | { readonly kind: 'form' }
  | { readonly kind: 'working'; readonly done: number; readonly total: number }
  | { readonly kind: 'failed'; readonly message: string };

export default function ImageExportDialog({ documentId }: { readonly documentId: DocumentId }) {
  const open = useToolsStore((s) => s.dialog?.kind === 'images');
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) closeToolDialog();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={overlay.backdrop} />
        <ImageExportFlow documentId={documentId} />
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function failureText(error: unknown): string {
  if (error instanceof RasterError && error.code === 'too-large') {
    return m.images_too_large({ size: error.message });
  }
  return m.images_failed({ reason: error instanceof Error ? error.message : String(error) });
}

function ImageExportFlow({ documentId }: { readonly documentId: DocumentId }) {
  const doc = useWorkspaceStore((s) => s.workspace.documents[documentId]);
  const ws = useWorkspaceStore((s) => s.workspace);
  const pageCount = doc?.pages.length ?? 0;
  const [format, setFormat] = useState<RasterFormat>('png');
  const [dpiChoice, setDpiChoice] = useState<number | 'custom'>(150);
  const [customDpi, setCustomDpi] = useState(200);
  const [quality, setQuality] = useState(90);
  const [background, setBackground] = useState<RasterBackground>('white');
  const [range, setRange] = useState('');
  const [template, setTemplate] = useState('{title}-{page}');
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const controller = useRef<AbortController | null>(null);
  const formatName = useId();
  const dpiName = useId();

  useEffect(() => () => controller.current?.abort(), []);

  const dpi =
    dpiChoice === 'custom'
      ? Math.min(MAX_RASTER_DPI, Math.max(MIN_RASTER_DPI, Math.round(customDpi) || MIN_RASTER_DPI))
      : dpiChoice;
  const pages = parsePageRange(range, pageCount);
  const transparentAllowed = format !== 'jpeg';
  const firstPage = pages?.[0] !== undefined ? doc?.pages[pages[0]] : undefined;
  const firstSize = firstPage ? rasterSize(...sizeOf(ws, firstPage), dpi) : null;
  const options = (overrides: Partial<RasterOptions> = {}): RasterOptions => ({
    format,
    dpi,
    quality,
    background: transparentAllowed ? background : 'white',
    pages: pages ?? [],
    template,
    ...overrides,
  });

  const run = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (!pages) return;
    const abort = new AbortController();
    controller.current = abort;
    setStep({ kind: 'working', done: 0, total: pages.length });
    try {
      const file = await rasterizeDocument(documentId, options(), {
        signal: abort.signal,
        onProgress: ({ done, total }) => {
          if (!abort.signal.aborted) setStep({ kind: 'working', done, total });
        },
      });
      if (abort.signal.aborted) return;
      const outcome = await deliverFile(file.bytes, file.name, file.type);
      if (outcome === 'cancelled') {
        setStep({ kind: 'form' });
        return;
      }
      announce(
        outcome === 'saved'
          ? m.announce_saved({ name: file.name })
          : m.announce_downloaded({ name: file.name }),
      );
      closeToolDialog();
    } catch (error) {
      if (!abort.signal.aborted) setStep({ kind: 'failed', message: failureText(error) });
    }
  };

  const copy = () => {
    if (pages?.length !== 1) return;
    const abort = new AbortController();
    controller.current = abort;
    setStep({ kind: 'working', done: 0, total: 1 });
    // The clipboard item is created synchronously in the click, with a promise of the PNG.
    const png = rasterizeDocument(documentId, options({ format: 'png' }), {
      signal: abort.signal,
    }).then((file) => new Blob([file.bytes], { type: 'image/png' }));
    copyImage(png)
      .then(() => {
        announce(m.announce_image_copied());
        closeToolDialog();
      })
      .catch((error: unknown) => setStep({ kind: 'failed', message: failureText(error) }));
  };

  return (
    <Dialog.Popup className={`${overlay.popup} ${styles.popup}`} data-testid="images-dialog">
      <div className={overlay.header}>
        <Dialog.Title className={overlay.title}>{m.images_title()}</Dialog.Title>
        <Dialog.Close className={overlay.close} aria-label={m.common_close()}>
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>
      {step.kind === 'form' ? (
        <form className={styles.body} onSubmit={(event) => void run(event)}>
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{m.images_format()}</legend>
            <div className={styles.presets}>
              {FORMATS.map((f) => (
                <label key={f.id} className={styles.preset}>
                  <input
                    type="radio"
                    name={formatName}
                    value={f.id}
                    checked={format === f.id}
                    onChange={() => setFormat(f.id)}
                  />
                  <span className={styles.presetName}>{f.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{m.images_resolution()}</legend>
            <div className={styles.row}>
              {[...RASTER_DPI_PRESETS, 'custom' as const].map((value) => (
                <label key={value} className={styles.check}>
                  <input
                    type="radio"
                    name={dpiName}
                    value={value}
                    checked={dpiChoice === value}
                    onChange={() => setDpiChoice(value)}
                  />
                  <span>
                    {value === 'custom'
                      ? m.images_dpi_custom()
                      : m.images_dpi_value({ dpi: value })}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className={styles.row}>
            {dpiChoice === 'custom' ? (
              <label className={styles.field}>
                <span className={styles.label}>{m.images_custom_dpi()}</span>
                <input
                  className={styles.input}
                  type="number"
                  min={MIN_RASTER_DPI}
                  max={MAX_RASTER_DPI}
                  value={customDpi}
                  onChange={(event) => setCustomDpi(Number(event.target.value))}
                />
              </label>
            ) : null}
            {format !== 'png' ? (
              <label className={styles.field}>
                <span className={styles.label}>{m.images_quality()}</span>
                <input
                  className={styles.input}
                  type="number"
                  min={1}
                  max={100}
                  value={quality}
                  onChange={(event) =>
                    setQuality(
                      Math.min(100, Math.max(1, Math.round(Number(event.target.value)) || 1)),
                    )
                  }
                />
              </label>
            ) : null}
            {transparentAllowed ? (
              <label className={styles.field}>
                <span className={styles.label}>{m.images_background()}</span>
                <select
                  className={styles.select}
                  value={background}
                  onChange={(event) => setBackground(event.target.value as RasterBackground)}
                >
                  <option value="white">{m.images_background_white()}</option>
                  <option value="transparent">{m.images_background_transparent()}</option>
                </select>
              </label>
            ) : null}
          </div>
          <div className={styles.row}>
            <label className={styles.field}>
              <span className={styles.label}>{m.images_pages()}</span>
              <input
                className={styles.input}
                value={range}
                placeholder={`1-${pageCount}`}
                aria-invalid={pages === null}
                aria-describedby="images-pages-hint"
                onChange={(event) => setRange(event.target.value)}
              />
              <span id="images-pages-hint" className={styles.hint}>
                {pages === null
                  ? m.images_pages_invalid({ count: pageCount })
                  : m.images_pages_hint()}
              </span>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{m.images_names()}</span>
              <input
                className={styles.input}
                value={template}
                spellCheck={false}
                onChange={(event) => setTemplate(event.target.value)}
              />
              <span className={styles.hint}>
                {m.images_names_hint({ title: '{title}', page: '{page}', label: '{label}' })}
              </span>
            </label>
          </div>
          <p className={styles.description} data-testid="images-output">
            {pages === null
              ? ''
              : pages.length === 1 && firstSize
                ? m.images_output_single({ width: firstSize.width, height: firstSize.height })
                : m.images_output_zip({ count: pages.length })}
          </p>
          <div className={styles.actions}>
            {pages?.length === 1 && canCopyImage() ? (
              <button type="button" className={styles.secondary} onClick={copy}>
                {m.images_copy()}
              </button>
            ) : null}
            <span className={styles.spacer} />
            <Dialog.Close className={styles.secondary}>{m.common_cancel()}</Dialog.Close>
            <button type="submit" className={styles.primary} disabled={pages === null}>
              {m.images_export()}
            </button>
          </div>
        </form>
      ) : null}
      {step.kind === 'working' ? (
        <div className={styles.body}>
          <p className={styles.description} role="status">
            {m.images_progress({ done: Math.min(step.done + 1, step.total), total: step.total })}
          </p>
          <progress
            className={styles.progress}
            max={Math.max(1, step.total)}
            value={step.done}
            aria-label={m.images_progress_label()}
          />
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                controller.current?.abort();
                setStep({ kind: 'form' });
              }}
            >
              {m.common_cancel()}
            </button>
          </div>
        </div>
      ) : null}
      {step.kind === 'failed' ? (
        <div className={styles.body}>
          <p className={styles.error} role="alert">
            {step.message}
          </p>
          <div className={styles.actions}>
            <Dialog.Close className={styles.secondary}>{m.common_close()}</Dialog.Close>
            <button
              type="button"
              className={styles.primary}
              onClick={() => setStep({ kind: 'form' })}
            >
              {m.common_back()}
            </button>
          </div>
        </div>
      ) : null}
    </Dialog.Popup>
  );
}

function sizeOf(
  ws: Parameters<typeof displaySize>[0],
  page: Parameters<typeof displaySize>[1],
): [number, number] {
  const size = displaySize(ws, page);
  return [size.width, size.height];
}
