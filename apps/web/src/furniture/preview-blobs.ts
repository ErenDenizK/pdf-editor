/**
 * Image bytes for the furniture preview: committed blobs come from the workspace store;
 * an image picked in the watermark dialog lives here, under a temporary id, until Apply
 * stores it in the workspace. Object URLs are created once per blob and revoked when a
 * preview image is dropped.
 */
import type { BlobId } from '@pdf-editor/document-model';

import type { StoredBlob } from '../state/workspace-store';
import { useWorkspaceStore } from '../state/workspace-store';

const previewBlobs = new Map<BlobId, StoredBlob>();
const urls = new Map<BlobId, string>();

export const PREVIEW_BLOB_PREFIX = 'furniture-preview:';

export function putPreviewBlob(blob: StoredBlob): BlobId {
  const id = `${PREVIEW_BLOB_PREFIX}${crypto.randomUUID()}` as BlobId;
  previewBlobs.set(id, blob);
  return id;
}

export function takePreviewBlob(id: BlobId): StoredBlob | undefined {
  return previewBlobs.get(id);
}

export function dropPreviewBlob(id: BlobId): void {
  previewBlobs.delete(id);
  const url = urls.get(id);
  if (url !== undefined) {
    URL.revokeObjectURL(url);
    urls.delete(id);
  }
}

export function isPreviewBlob(id: BlobId): boolean {
  return id.startsWith(PREVIEW_BLOB_PREFIX);
}

export function blobInfo(id: BlobId): StoredBlob | undefined {
  return previewBlobs.get(id) ?? useWorkspaceStore.getState().blobs[id];
}

/** An object URL for a blob's image (created once, kept for the session). */
export function blobUrl(id: BlobId): string | undefined {
  const existing = urls.get(id);
  if (existing !== undefined) return existing;
  const blob = blobInfo(id);
  if (!blob || typeof URL.createObjectURL !== 'function') return undefined;
  const url = URL.createObjectURL(new Blob([blob.bytes], { type: blob.type }));
  urls.set(id, url);
  return url;
}
