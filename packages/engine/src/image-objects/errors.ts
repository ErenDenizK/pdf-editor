/**
 * Failures of image-object edits, with a machine-readable reason that survives the worker
 * boundary (the proxy rebuilds `EngineError(code, message)`, so the reason travels as a
 * message prefix `[image-edit:<reason>]`, as for text edits).
 */
import { EngineError, type EngineErrorCode } from '../types';

/**
 * - `stale-image`: the page no longer has the image as located (no image at the path, or a
 *   different pixel size or bounds): the page changed since, or a replay runs onto
 *   different bytes. Locate the images again.
 * - `invalid-target`: a transform to a degenerate matrix or rect.
 * - `invalid-replacement`: replacement pixels PDFium cannot take (bad size, undecodable
 *   JPEG or PNG).
 * - `verification-failed`: the page, located again after the edit, does not show it.
 * - `replay-required`: the inverse of a removal or replacement was applied; undo is
 *   reopen + replay.
 */
export type ImageEditFailure =
  | 'stale-image'
  | 'invalid-target'
  | 'invalid-replacement'
  | 'verification-failed'
  | 'replay-required';

const CODES: Readonly<Record<ImageEditFailure, EngineErrorCode>> = {
  'stale-image': 'internal',
  'invalid-target': 'internal',
  'invalid-replacement': 'unsupported',
  'verification-failed': 'internal',
  'replay-required': 'unsupported',
};

/** An `EngineError` carrying an `ImageEditFailure` reason. */
export function imageEditError(reason: ImageEditFailure, message: string): EngineError {
  return new EngineError(CODES[reason], `[image-edit:${reason}] ${message}`);
}

const PATTERN = /^\[image-edit:([a-z-]+)\]/;

/** The reason of an image-edit failure (also after it crossed the worker), or undefined. */
export function imageEditFailureReason(error: unknown): ImageEditFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  const reason = PATTERN.exec(error.message)?.[1];
  return reason !== undefined && reason in CODES ? (reason as ImageEditFailure) : undefined;
}
