/**
 * OCR in the app (spec recognize-and-compare §1): the dialog and its run, the right panel's
 * OCR section, the language manager and the commands. Importing this module registers the
 * page layer that rings the focused word, and refreshes a source's pages whenever the OCR
 * runs it holds change (apply, undo, redo): the layer replaces the source's document, so
 * bitmaps, text, annotations and links of every page are read again.
 */
import type { SourceId, Workspace } from '@pdf-editor/document-model';

import { onPagesChanged } from '../annotations/edit-runner';
import { getEngineService } from '../engine/engine-service';
import { refreshSource } from '../redaction/apply';
import { registerPageOverlay } from '../stage/page-overlays';
import { useWorkspaceStore } from '../state/workspace-store';
import { OcrLayer } from './OcrLayer';

export { registerOcrCommands } from './ocr-commands';
export { OcrDialogHost } from './OcrDialogHost';
export { OcrSection, useHasOcrSection } from './OcrSection';
export { OcrStatus } from './OcrStatus';

registerPageOverlay(Object.assign(OcrLayer, { displayName: 'OcrLayer' }));

/** OCR edit ids per source as last seen by the page listener. */
const seen = new Map<SourceId, string>();

function ocrSignature(ws: Workspace, source: SourceId): string {
  return ws.engineEdits
    .filter((edit) => edit.source === source && edit.kind === 'ocr.apply')
    .map((edit) => edit.id)
    .join(',');
}

onPagesChanged((pages) => {
  const ws = useWorkspaceStore.getState().workspace;
  for (const source of new Set(pages.map((p) => p.source))) {
    const signature = ocrSignature(ws, source);
    if ((seen.get(source) ?? '') === signature) continue;
    if (signature === '') seen.delete(source);
    else seen.set(source, signature);
    refreshSource(source);
  }
});

getEngineService().onSourceClosed((source) => {
  seen.delete(source);
});
