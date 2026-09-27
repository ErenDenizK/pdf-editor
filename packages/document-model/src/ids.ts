import { DocumentModelError } from './errors';
import type { BlobId, DocumentId, PageId, SourceId } from './types';

function brand<T extends string>(kind: string, value: string): T {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DocumentModelError('invalid-argument', `${kind} must be a non-empty string`);
  }
  return value as T;
}

/** Branded id constructors. They only validate that the value is a non-empty string. */
export const sourceId = (value: string): SourceId => brand<SourceId>('SourceId', value);
export const documentId = (value: string): DocumentId => brand<DocumentId>('DocumentId', value);
export const pageId = (value: string): PageId => brand<PageId>('PageId', value);
export const blobId = (value: string): BlobId => brand<BlobId>('BlobId', value);

/**
 * Source of fresh ids. Operations that create entities take one explicitly so the model
 * stays deterministic under test; the app injects the random generator.
 */
export interface IdGenerator {
  source(): SourceId;
  document(): DocumentId;
  page(): PageId;
  blob(): BlobId;
}

/**
 * Deterministic generator: `${prefix}-page-1`, `${prefix}-page-2`, `${prefix}-doc-1`, …
 * One counter per kind. Intended for tests and reproducible fixtures.
 */
export function createSequentialIdGenerator(prefix = 'id'): IdGenerator {
  const counters = { source: 0, document: 0, page: 0, blob: 0 };
  const next = (kind: keyof typeof counters, label: string): string => {
    counters[kind] += 1;
    return `${prefix}-${label}-${counters[kind]}`;
  };
  return {
    source: () => sourceId(next('source', 'src')),
    document: () => documentId(next('document', 'doc')),
    page: () => pageId(next('page', 'page')),
    blob: () => blobId(next('blob', 'blob')),
  };
}

type RandomUuid = () => string;

function platformRandomUuid(): string {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoLike === undefined || typeof cryptoLike.randomUUID !== 'function') {
    throw new DocumentModelError(
      'unsupported',
      'crypto.randomUUID is not available in this environment; inject a uuid function',
    );
  }
  return cryptoLike.randomUUID();
}

/**
 * Random generator backed by `crypto.randomUUID` (available in browsers, workers, Node and
 * Tauri webviews). A custom uuid function can be injected for other runtimes.
 */
export function createRandomIdGenerator(randomUuid: RandomUuid = platformRandomUuid): IdGenerator {
  return {
    source: () => sourceId(`src_${randomUuid()}`),
    document: () => documentId(`doc_${randomUuid()}`),
    page: () => pageId(`page_${randomUuid()}`),
    blob: () => blobId(`blob_${randomUuid()}`),
  };
}
