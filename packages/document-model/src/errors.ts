/** Error codes raised by document-model operations on misuse or invalid input. */
export type DocumentModelErrorCode =
  | 'invalid-argument'
  | 'invalid-index'
  | 'invalid-range'
  | 'unknown-document'
  | 'unknown-page'
  | 'unknown-source'
  | 'duplicate-id'
  | 'invalid-serialized'
  | 'unsupported-version'
  | 'invariant-violation'
  | 'unsupported';

export class DocumentModelError extends Error {
  readonly code: DocumentModelErrorCode;

  constructor(code: DocumentModelErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = 'DocumentModelError';
  }
}

/** Type guard that also narrows on a specific code when one is given. */
export function isDocumentModelError(
  value: unknown,
  code?: DocumentModelErrorCode,
): value is DocumentModelError {
  return value instanceof DocumentModelError && (code === undefined || value.code === code);
}
