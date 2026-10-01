/**
 * The comment author name is asked once, inline, when the document has its first comment
 * (experience-redesign §4.1), not kept as a standing field. Save or Skip both mark it as
 * asked (persisted); "Set comment author name…" in the palette asks again.
 */
import { create } from 'zustand';

import { useAnnotationStore } from '../annotations/annotation-store';
import { readJson, writeJson } from '../state/safe-storage';

export const AUTHOR_ASKED_STORAGE_KEY = 'pdf-editor:annotations:author-asked:v1';

interface AuthorPromptState {
  /** The question was answered (Save or Skip), or a name was set before it existed. */
  readonly asked: boolean;
  /** Asked again from the palette: shown even before the first comment. */
  readonly editing: boolean;
  /** Records an answer and closes the prompt. */
  answer: () => void;
  /** Opens the prompt again ("Set comment author name…"). */
  edit: () => void;
}

function initiallyAsked(): boolean {
  return readJson(AUTHOR_ASKED_STORAGE_KEY) === true || useAnnotationStore.getState().author !== '';
}

export const useAuthorPrompt = create<AuthorPromptState>()((set) => ({
  asked: initiallyAsked(),
  editing: false,
  answer: () => {
    writeJson(AUTHOR_ASKED_STORAGE_KEY, true);
    set({ asked: true, editing: false });
  },
  edit: () => set({ editing: true }),
}));

/** Test helper: back to the first-run state (reads storage again). */
export function resetAuthorPrompt(): void {
  useAuthorPrompt.setState({ asked: initiallyAsked(), editing: false });
}
