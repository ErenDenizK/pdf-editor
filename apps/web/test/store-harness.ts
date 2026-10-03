/**
 * Store test harness (Vitest browser mode). Tests drive the real workspace store and the
 * real engine service (PDFium) with the shared fixtures; `gateEngine` holds chosen files at
 * the end of their open, as if they were large, so a test can interleave other operations
 * with an open that is still in flight, and records every source the store closes.
 *
 * Call `vi.restoreAllMocks()` after each test to take the gates down.
 */
import type { SourceId } from '@pdf-editor/document-model';
import { vi } from 'vitest';

import { getEngineService } from '../src/engine/engine-service';
import { useUiStore } from '../src/state/ui-store';
import { type StoredBlob, useWorkspaceStore } from '../src/state/workspace-store';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A fixture PDF (import it with `?url`) as a dropped file named `name`. */
export async function fixtureFile(url: string, name: string): Promise<File> {
  const bytes = await (await fetch(url)).arrayBuffer();
  return new File([bytes], name, { type: 'application/pdf' });
}

async function pngBytes(width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.fillStyle = '#2a6';
  context.fillRect(0, 0, width, height);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** A small PNG file (smaller than A4, so inserting it asks no sizing question). */
export async function pngFile(name: string, width = 120, height = 80): Promise<File> {
  return new File([await pngBytes(width, height)], name, { type: 'image/png' });
}

/** PNG bytes as the store keeps them for an image page. */
export async function pngBlob(name: string, width = 120, height = 80): Promise<StoredBlob> {
  const bytes = await (await pngBytes(width, height)).arrayBuffer();
  return { bytes, type: 'image/png', width, height, name };
}

export interface EngineGates {
  /** Lets a held file finish opening. */
  release(name: string): void;
  /** Resolves with the engine's id once `name` is open and waiting at its gate. */
  opened(name: string): Promise<SourceId>;
  /** Sources the store asked the engine to close, in order. */
  readonly closed: readonly SourceId[];
}

/** Holds `held` files at the end of their open until `release`; tracks closes. */
export function gateEngine(held: readonly string[]): EngineGates {
  const service = getEngineService();
  const open = service.open.bind(service);
  const close = service.close.bind(service);
  const gates = new Map(held.map((name) => [name, deferred()]));
  const openedIds = new Map(held.map((name) => [name, deferred<SourceId>()]));
  const closed: SourceId[] = [];
  vi.spyOn(service, 'open').mockImplementation(async (file, password) => {
    const result = await open(file, password);
    if (result.ok) openedIds.get(file.name)?.resolve(result.value.id);
    await gates.get(file.name)?.promise;
    return result;
  });
  vi.spyOn(service, 'close').mockImplementation((id) => {
    closed.push(id);
    return close(id);
  });
  return {
    release: (name) => gates.get(name)?.resolve(),
    opened: (name) => openedIds.get(name)?.promise ?? Promise.reject(new Error(`${name} not held`)),
    closed,
  };
}

/**
 * Puts the active document in Edit (ADR-0019 §3): a file opens in Read, where nothing on the
 * page can be selected, drawn on or filled.
 */
export function enterEditMode(): void {
  const id = useWorkspaceStore.getState().workspace.activeDocument;
  if (id !== undefined) useUiStore.getState().setDocumentMode(id, 'edit');
}
