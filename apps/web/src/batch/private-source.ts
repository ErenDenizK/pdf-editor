/**
 * Files the batch runner opens privately (spec §5: "files never become tabs"): straight in
 * the PDFium worker through the engine proxy's public methods (`open`, `close`, `save`,
 * `verify`), never through the engine service's `open`, which registers the source for the
 * viewer and asks the app-wide password dialog. The runner therefore owns everything about
 * such a source: its id, the copy of its original bytes (the `File` itself, which the
 * browser may keep on disk), the password prompt and the close.
 *
 * Passwords typed for encrypted inputs are held in memory for the run only: the runner
 * tries the ones already given in this batch before asking again (many batches share one
 * password), and forgets them when the run ends.
 */
import {
  createRandomIdGenerator,
  type Rect,
  type SourceId,
  type SourceInput,
} from '@pdf-editor/document-model';
import type { OpenedDocument, PdfEditor, PdfRenderer, PdfVerifier } from '@pdf-editor/engine';

import { type EngineFailureCode, getEngineService, toFailure } from '../engine/engine-service';

/** The engine surface the batch needs (the PDFium worker proxy satisfies it). */
export type BatchEngine = Pick<PdfRenderer, 'open' | 'close'> &
  Pick<PdfEditor, 'save'> &
  PdfVerifier;

/** The app's PDFium worker proxy (the engine service's adapter), as a `BatchEngine`. */
export async function appBatchEngine(): Promise<BatchEngine> {
  const engine = (await getEngineService().editor()) as unknown as Partial<BatchEngine>;
  if (
    typeof engine.open !== 'function' ||
    typeof engine.close !== 'function' ||
    typeof engine.save !== 'function' ||
    typeof engine.verify !== 'function'
  ) {
    throw new Error('The rendering engine cannot run batches');
  }
  return engine as BatchEngine;
}

/** Asks for the password of an encrypted input; null skips the file. */
export type SourcePasswordPrompt = (request: {
  readonly fileName: string;
  /** A password was tried for this file and rejected. */
  readonly incorrect: boolean;
}) => Promise<string | null>;

export class SourceOpenError extends Error {
  constructor(
    readonly code: EngineFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'SourceOpenError';
  }
}

export interface PrivateSource {
  readonly id: SourceId;
  readonly name: string;
  readonly document: OpenedDocument;
  /** The password that opened it (memory only), if one was needed. */
  readonly password: string | undefined;
  /** What the document model needs to add it to a workspace. */
  readonly input: SourceInput;
  /** A fresh copy of the original bytes (the caller may transfer it). */
  bytes(): Promise<ArrayBuffer>;
  /** The engine's CropBox of a page (unrotated user space), when it reports one. */
  cropBox(index: number): Rect | undefined;
  /** Closes it in the engine; idempotent, never rejects. */
  close(): Promise<void>;
}

const ids = createRandomIdGenerator();

/** A source id no tab uses (`src_…`, random). */
export function newPrivateSourceId(): SourceId {
  return ids.source();
}

function isLocked(code: EngineFailureCode): boolean {
  return code === 'password-required' || code === 'password-incorrect';
}

/**
 * Opens `file` in `engine` under a new id. Encrypted files try `knownPasswords` first, then
 * `ask` (again after a wrong password) until they open or the user skips the file, which
 * fails with `password-cancelled`. Other failures keep the engine's code (`corrupt`,
 * `unsupported-encryption`, …). Throws `SourceOpenError`.
 */
export async function openPrivateSource(
  engine: BatchEngine,
  file: File,
  options: {
    readonly id?: SourceId;
    readonly ask?: SourcePasswordPrompt;
    readonly knownPasswords?: readonly string[];
    readonly signal?: AbortSignal;
  } = {},
): Promise<PrivateSource> {
  const id = options.id ?? newPrivateSourceId();
  const known = [...(options.knownPasswords ?? [])];
  let attempt: string | undefined;
  let askedAndRejected = false;
  let asked = false;
  for (;;) {
    if (options.signal?.aborted) throw new SourceOpenError('aborted', 'Cancelled');
    let bytes: ArrayBuffer;
    try {
      // Read per attempt: the proxy transfers the buffer to its worker.
      bytes = await file.arrayBuffer();
    } catch (error) {
      throw new SourceOpenError('read-failed', toFailure(error).message);
    }
    try {
      const document = await engine.open(
        id,
        bytes,
        attempt === undefined ? {} : { password: attempt },
      );
      return privateSource(engine, id, file, document, attempt);
    } catch (error) {
      const failure = toFailure(error);
      if (!isLocked(failure.code)) throw new SourceOpenError(failure.code, failure.message);
      if (asked) askedAndRejected = true;
      const next = known.shift();
      if (next !== undefined) {
        attempt = next;
        continue;
      }
      if (options.ask === undefined) throw new SourceOpenError(failure.code, failure.message);
      let answer: string | null;
      try {
        answer = await options.ask({ fileName: file.name, incorrect: askedAndRejected });
      } catch {
        answer = null;
      }
      if (answer === null) {
        throw new SourceOpenError('password-cancelled', `${file.name} needs a password`);
      }
      attempt = answer;
      asked = true;
    }
  }
}

function privateSource(
  engine: BatchEngine,
  id: SourceId,
  file: File,
  document: OpenedDocument,
  password: string | undefined,
): PrivateSource {
  let closed = false;
  return {
    id,
    name: file.name,
    document,
    password,
    input: {
      name: file.name,
      byteLength: file.size,
      pageCount: document.pageCount,
      pages: document.pages,
      fingerprint: document.fingerprint,
      flags: document.flags,
      metadata: document.metadata,
      outline: document.outline,
    },
    bytes: () => file.arrayBuffer(),
    cropBox: (index) => {
      const box = document.pages[index]?.cropBox;
      return box !== undefined && Number.isFinite(box.x) && Number.isFinite(box.y)
        ? box
        : undefined;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await engine.close(id).catch(() => undefined);
    },
  };
}
