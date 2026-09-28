/**
 * OCR commands (spec recognize-and-compare §1.5): "Recognize text (OCR)…" in the palette and,
 * with the Document group, the tab bar's Document menu; "OCR languages…" (the language
 * manager: the app has no Settings screen); J / K through the OCR section's low-confidence
 * words. No shortcut opens the dialog (docs/DESIGN.md §4: every action is in the palette;
 * the single-key shortcuts are taken).
 */
import { getActiveDocument } from '@pdf-editor/document-model';

import type { CommandRegistry } from '../commands/registry';
import { m } from '../i18n';
import { useWorkspaceStore } from '../state/workspace-store';
import { documentTargets } from './ocr-model';
import { reviewingOcr, stepOcrWord } from './ocr-review';
import { openOcrDialog, useOcrStore } from './ocr-store';

const activeDocument = () => getActiveDocument(useWorkspaceStore.getState().workspace);

export function registerOcrCommands(registry: CommandRegistry): () => void {
  const disposers = [
    registry.register({
      id: 'document.ocr',
      title: m.ocr_cmd(),
      group: m.group_document(),
      keywords: ['ocr', 'recognize', 'text', 'scan', 'searchable', 'tesseract', 'metin', 'tanı'],
      when: () => {
        const doc = activeDocument();
        return doc !== undefined && documentTargets(doc).length > 0;
      },
      run: () => {
        const doc = activeDocument();
        if (!doc) return;
        const { run } = useOcrStore.getState();
        // While a run works, the dialog shows it (whichever document it is on).
        openOcrDialog(run.kind === 'running' ? run.documentId : doc.id);
      },
    }),
    registry.register({
      id: 'document.ocrLanguages',
      title: m.ocr_cmd_languages(),
      group: m.group_tools(),
      keywords: ['ocr', 'language', 'languages', 'offline', 'download', 'traineddata', 'import'],
      run: () => openOcrDialog(activeDocument()?.id, 'languages'),
    }),
    registry.register({
      id: 'ocr.nextWord',
      title: m.ocr_cmd_next_word(),
      group: m.group_tools(),
      shortcut: 'J',
      keywords: ['ocr', 'review', 'word', 'confidence'],
      when: reviewingOcr,
      run: () => {
        stepOcrWord(1);
      },
    }),
    registry.register({
      id: 'ocr.previousWord',
      title: m.ocr_cmd_previous_word(),
      group: m.group_tools(),
      shortcut: 'K',
      keywords: ['ocr', 'review', 'word', 'confidence'],
      when: reviewingOcr,
      run: () => {
        stepOcrWord(-1);
      },
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
