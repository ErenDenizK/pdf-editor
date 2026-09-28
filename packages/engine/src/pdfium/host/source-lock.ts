/**
 * Per-source reader/writer lock for the PDFium host (ADR-0011 §2).
 *
 * Orchestrated adapter calls (render, text, annotations, save, …) take the lock *shared*:
 * they run concurrently and interleave on EmbedPDF's queue as before. Raw edits take it
 * *exclusive*: they start only after every adapter call on that source that started earlier
 * has finished, including calls made of several queued tasks (`getPageText` reads glyphs and
 * runs in two tasks; `open` and `save` in more), and adapter calls that arrive meanwhile wait
 * until the edit is done. Waiters are served in arrival order and a waiting exclusive request
 * holds back later shared ones, so an edit is not starved by a stream of renders.
 *
 * The lock is not re-entrant: code holding it exclusively must not wait for another request
 * on the same source (it would wait for itself).
 */
import { abortedError } from '../task-bridge';

export type LockMode = 'shared' | 'exclusive';

interface Waiter {
  readonly mode: LockMode;
  grant(): void;
}

interface LockState {
  readers: number;
  writer: boolean;
  readonly waiting: Waiter[];
}

export class SourceLocks {
  private readonly states = new Map<string, LockState>();

  /**
   * Resolves to a release function once the lock is held. Rejects with
   * `EngineError('aborted')` when `signal` fires first (the request is withdrawn).
   */
  acquire(sourceId: string, mode: LockMode, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortedError('lock', signal.reason));
    const state = this.state(sourceId);
    return new Promise((resolve, reject) => {
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        if (mode === 'shared') state.readers--;
        else state.writer = false;
        this.pump(sourceId, state);
      };
      if (state.waiting.length === 0 && grantable(state, mode)) {
        take(state, mode);
        resolve(release);
        return;
      }
      let onAbort: (() => void) | undefined;
      const waiter: Waiter = {
        mode,
        grant: () => {
          if (onAbort) signal?.removeEventListener('abort', onAbort);
          take(state, mode);
          resolve(release);
        },
      };
      state.waiting.push(waiter);
      if (signal) {
        onAbort = () => {
          const at = state.waiting.indexOf(waiter);
          if (at === -1) return;
          state.waiting.splice(at, 1);
          reject(abortedError('lock', signal.reason));
          this.pump(sourceId, state);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /** Runs `fn` while holding the lock in `mode`; the lock is released when `fn` settles. */
  async run<R>(
    sourceId: string,
    mode: LockMode,
    fn: () => R | Promise<R>,
    signal?: AbortSignal,
  ): Promise<R> {
    const release = await this.acquire(sourceId, mode, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Whether anything holds or waits for the lock of `sourceId` (tests, diagnostics). */
  busy(sourceId: string): boolean {
    return this.states.has(sourceId);
  }

  private state(sourceId: string): LockState {
    let state = this.states.get(sourceId);
    if (!state) {
      state = { readers: 0, writer: false, waiting: [] };
      this.states.set(sourceId, state);
    }
    return state;
  }

  private pump(sourceId: string, state: LockState): void {
    for (let head = state.waiting[0]; head; head = state.waiting[0]) {
      if (!grantable(state, head.mode)) break;
      state.waiting.shift();
      head.grant();
      if (head.mode === 'exclusive') break;
    }
    if (state.readers === 0 && !state.writer && state.waiting.length === 0) {
      if (this.states.get(sourceId) === state) this.states.delete(sourceId);
    }
  }
}

function grantable(state: LockState, mode: LockMode): boolean {
  return mode === 'shared' ? !state.writer : !state.writer && state.readers === 0;
}

function take(state: LockState, mode: LockMode): void {
  if (mode === 'shared') state.readers++;
  else state.writer = true;
}
