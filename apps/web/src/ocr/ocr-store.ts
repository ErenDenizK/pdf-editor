/**
 * OCR state outside the dialog (spec recognize-and-compare §1.5): whether the dialog is open
 * (and on which view: the run form or the language manager), the run in progress, and the
 * word the OCR section has focused.
 *
 * The run lives here, not in the dialog: it continues when the dialog closes, the status bar
 * shows its progress, and a dialog opened again shows the progress or the result. Cancelling
 * aborts recognition; nothing is committed until every page is recognised, so a cancelled run
 * leaves the document as it was. The run code (and tesseract.js) loads on the first run.
 */
import type { DocumentId, PageId, Rect, SourceId } from '@pdf-editor/document-model';
import type { OcrQuality } from '@pdf-editor/engine';
import { create } from 'zustand';

import type { FactsBySource, OcrTarget } from './ocr-model';

export type OcrDialogView = 'run' | 'languages';

/** What the run is doing (the dialog's and the status bar's progress). */
/** `recheck`: pages whose source changed during the run are recognised again (ocr-run.ts). */
export type OcrPhase = 'prepare' | 'download' | 'start' | 'recognize' | 'recheck' | 'write';

/** A finished run, for the dialog's result and the announcement. */
export interface OcrRunResult {
  readonly label: string;
  readonly pages: number;
  readonly languages: readonly string[];
  readonly byQuality: Readonly<Record<OcrQuality, number>>;
  readonly words: number;
  readonly lowConfidence: number;
  readonly timedOut: number;
  /** Pages the 40 MP cap rendered below the asked resolution. */
  readonly reducedDpi: number;
}

export type OcrRun =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly documentId: DocumentId;
      readonly phase: OcrPhase;
      /** Pages recognised. */
      readonly done: number;
      readonly total: number;
      /** Languages of the run (the download message). */
      readonly languages: number;
      /** Bytes of language data received / expected while downloading. */
      readonly download?: { readonly done: number; readonly total: number };
    }
  | { readonly kind: 'done'; readonly documentId: DocumentId; readonly result: OcrRunResult }
  | { readonly kind: 'failed'; readonly documentId: DocumentId; readonly message: string }
  | { readonly kind: 'cancelled'; readonly documentId: DocumentId };

/** The word the OCR section focused (J / K): ringed on its page. */
export interface OcrFocus {
  readonly pageId: PageId;
  readonly source: SourceId;
  readonly pageIndex: number;
  /** Index into the page's stored words. */
  readonly word: number;
  readonly rect: Rect;
}

interface OcrState {
  readonly dialog: {
    readonly view: OcrDialogView;
    readonly documentId: DocumentId | undefined;
  } | null;
  readonly run: OcrRun;
  readonly focus: OcrFocus | null;
}

const IDLE: OcrRun = { kind: 'idle' };

export const useOcrStore = create<OcrState>()(() => ({ dialog: null, run: IDLE, focus: null }));

export function openOcrDialog(documentId: DocumentId | undefined, view: OcrDialogView = 'run') {
  useOcrStore.setState({ dialog: { view, documentId } });
}

export function setOcrDialogView(view: OcrDialogView): void {
  const dialog = useOcrStore.getState().dialog;
  if (dialog) useOcrStore.setState({ dialog: { ...dialog, view } });
}

/** Closes the dialog; a run continues. A finished run's result is forgotten. */
export function closeOcrDialog(): void {
  const { run } = useOcrStore.getState();
  useOcrStore.setState({
    dialog: null,
    ...(run.kind === 'running' ? {} : { run: IDLE }),
  });
}

export function isOcrRunning(): boolean {
  return useOcrStore.getState().run.kind === 'running';
}

export function setOcrFocus(focus: OcrFocus | null): void {
  useOcrStore.setState({ focus });
}

/** What the dialog hands to a run. */
export interface OcrRunRequest {
  readonly documentId: DocumentId;
  readonly targets: readonly OcrTarget[];
  readonly facts: FactsBySource;
  readonly languages: readonly string[];
  readonly quality: 'standard' | 'high';
  readonly replace: boolean;
}

let controller: AbortController | undefined;

/** Starts a run (ignored while one runs). Never rejects; the outcome lands in `run`. */
export async function startOcrRun(request: OcrRunRequest): Promise<void> {
  if (isOcrRunning()) return;
  const abort = new AbortController();
  controller = abort;
  const { documentId } = request;
  useOcrStore.setState({
    run: {
      kind: 'running',
      documentId,
      phase: 'prepare',
      done: 0,
      total: request.targets.length,
      languages: request.languages.length,
    },
  });
  let next: OcrRun;
  try {
    const { recognizeAndApply } = await import('./ocr-run');
    const result = await recognizeAndApply(request, {
      signal: abort.signal,
      onProgress: (progress) => {
        const current = useOcrStore.getState().run;
        if (current.kind !== 'running' || abort.signal.aborted) return;
        useOcrStore.setState({ run: { ...current, ...progress } });
      },
    });
    next = result ? { kind: 'done', documentId, result } : { kind: 'cancelled', documentId };
  } catch (error) {
    next = abort.signal.aborted
      ? { kind: 'cancelled', documentId }
      : {
          kind: 'failed',
          documentId,
          message: error instanceof Error ? error.message : String(error),
        };
  } finally {
    if (controller === abort) controller = undefined;
  }
  useOcrStore.setState({ run: next });
}

/**
 * Cancels the running recognition. Writing the layer (the last step, one engine edit) is not
 * interrupted: the dialog disables Cancel then.
 */
export function cancelOcrRun(): void {
  controller?.abort();
}

/** Tests: nothing open, nothing running. */
export function resetOcrStore(): void {
  controller?.abort();
  controller = undefined;
  useOcrStore.setState({ dialog: null, run: IDLE, focus: null });
}
