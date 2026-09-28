/**
 * Cooperative time slicing for the analysis worker. Long computations call `slicer.tick()`
 * often; it yields to the event loop (a MessageChannel round trip, which unlike a nested
 * `setTimeout` is not clamped to 4 ms) once the current slice has run for `sliceMs`, so the
 * worker reads abort messages and new requests between slices and no task runs long.
 * Slice lengths are recorded for the performance check (spec §8.5: no task over 200 ms).
 */
import { EngineError } from '../types';

/** Default slice length. Well under the 200 ms task budget, large enough to keep overhead low. */
export const SLICE_MS = 12;

export interface SliceStats {
  /** Longest synchronous stretch between two yields, milliseconds. */
  readonly maxSliceMs: number;
  readonly slices: number;
  /** Where the longest slice ended (the label passed to `tick`). */
  readonly maxSliceLabel: string;
}

const stats = { maxSliceMs: 0, slices: 0, maxSliceLabel: '' };

export function sliceStats(): SliceStats {
  return { ...stats };
}

export function resetSliceStats(): void {
  stats.maxSliceMs = 0;
  stats.slices = 0;
  stats.maxSliceLabel = '';
}

function record(ms: number, label: string): void {
  stats.slices++;
  if (ms > stats.maxSliceMs) {
    stats.maxSliceMs = ms;
    stats.maxSliceLabel = label;
  }
}

let channel: MessageChannel | undefined;
const waiting: (() => void)[] = [];

/** Resolves in a new task (after messages already queued, abort messages included). */
export function yieldTask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => {
      waiting.shift()?.();
    };
  }
  const port = channel.port2;
  return new Promise((resolve) => {
    waiting.push(resolve);
    port.postMessage(null);
  });
}

export function abortedError(op: string, cause?: unknown): EngineError {
  return new EngineError('aborted', `${op} aborted`, cause === undefined ? undefined : { cause });
}

export function throwIfAborted(signal: AbortSignal | undefined, op: string): void {
  if (signal?.aborted) throw abortedError(op, signal.reason);
}

/** One computation's slicer: `tick()` yields when the slice is used up, then checks abort. */
export class Slicer {
  private start = performance.now();

  constructor(
    private readonly op: string,
    private readonly signal?: AbortSignal,
    private readonly sliceMs = SLICE_MS,
  ) {
    throwIfAborted(signal, op);
  }

  /** Time spent in the current slice. */
  elapsed(): number {
    return performance.now() - this.start;
  }

  /** Whether the slice is used up (callers with cheap steps check before `tick`). */
  due(): boolean {
    return performance.now() - this.start >= this.sliceMs;
  }

  /** Yields if the slice is used up; throws `aborted` when the signal fired meanwhile. */
  async tick(label = this.op): Promise<void> {
    if (!this.due()) return;
    await this.yieldNow(label);
  }

  /** Always yields (end of a unit of work). */
  async yieldNow(label = this.op): Promise<void> {
    record(performance.now() - this.start, label);
    await yieldTask();
    this.start = performance.now();
    throwIfAborted(this.signal, this.op);
  }

  /** Records the last slice (call when the computation ends). */
  done(label = this.op): void {
    record(performance.now() - this.start, label);
    this.start = performance.now();
  }
}
