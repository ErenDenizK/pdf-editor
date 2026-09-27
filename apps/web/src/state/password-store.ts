/**
 * Pending password requests from the engine service (encrypted files). Requests queue up
 * when several locked files are opened at once; the dialog answers them one at a time.
 */
import { create } from 'zustand';

export interface PasswordRequest {
  readonly id: number;
  readonly fileName: string;
  /** A password was already tried and rejected. */
  readonly incorrect: boolean;
}

interface PasswordState {
  readonly queue: readonly PasswordRequest[];
}

export const usePasswordStore = create<PasswordState>()(() => ({ queue: [] }));

const resolvers = new Map<number, (password: string | null) => void>();
let counter = 0;

/** Asks the user for a password; resolves to null when they skip the file. */
export function requestPassword(request: {
  readonly fileName: string;
  readonly incorrect: boolean;
}): Promise<string | null> {
  counter += 1;
  const id = counter;
  return new Promise((resolve) => {
    resolvers.set(id, resolve);
    // A retry after a wrong password goes first, so the user stays on the same file.
    const entry: PasswordRequest = { id, ...request };
    usePasswordStore.setState((s) => ({
      queue: request.incorrect ? [entry, ...s.queue] : [...s.queue, entry],
    }));
  });
}

export function answerPassword(id: number, password: string | null): void {
  const resolve = resolvers.get(id);
  resolvers.delete(id);
  usePasswordStore.setState((s) => ({ queue: s.queue.filter((r) => r.id !== id) }));
  resolve?.(password);
}
