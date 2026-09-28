/**
 * Failures of text edits, with a machine-readable reason that survives the worker boundary
 * (the proxy rebuilds `EngineError(code, message)`, so the reason travels as a message
 * prefix `[text-edit:<reason>]`).
 */
import { EngineError, type EngineErrorCode } from '../types';

/**
 * - `stale-run`: the page no longer has the run as located (edited since, or replay onto
 *   different bytes); locate the runs again.
 * - `not-editable`: Type3, paths, invisible, vertical or nested-form text, or a tier that
 *   was requested explicitly and cannot take the replacement.
 * - `does-not-fit`: `fit: 'keep'` and the replacement is wider than the free space, or
 *   `fit: 'shrink'` would go below the shrink floor.
 * - `unsupported-chars`: no bundled face has glyphs for every character.
 * - `verification-failed`: the read-back after the edit did not match (nothing changed).
 * - `invalid-range`: `start`/`end` outside the run or inside a character.
 * - `replay-required`: the inverse of a `text.edit` was applied; undo is reopen + replay.
 */
export type TextEditFailure =
  | 'stale-run'
  | 'not-editable'
  | 'does-not-fit'
  | 'unsupported-chars'
  | 'verification-failed'
  | 'invalid-range'
  | 'replay-required';

const CODES: Readonly<Record<TextEditFailure, EngineErrorCode>> = {
  'stale-run': 'internal',
  'not-editable': 'unsupported',
  'does-not-fit': 'unsupported',
  'unsupported-chars': 'unsupported',
  'verification-failed': 'internal',
  'invalid-range': 'internal',
  'replay-required': 'unsupported',
};

/** An `EngineError` carrying a `TextEditFailure` reason. */
export function textEditError(reason: TextEditFailure, message: string): EngineError {
  return new EngineError(CODES[reason], `[text-edit:${reason}] ${message}`);
}

const PATTERN = /^\[text-edit:([a-z-]+)\]/;

/** The reason of a text-edit failure (also after it crossed the worker), or undefined. */
export function textEditFailureReason(error: unknown): TextEditFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = PATTERN.exec(error.message);
  const reason = match?.[1];
  return reason !== undefined && reason in CODES ? (reason as TextEditFailure) : undefined;
}
