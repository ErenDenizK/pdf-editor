import { expect } from 'vitest';
import { type DocumentModelErrorCode, isDocumentModelError } from '../errors';
import { addSource, type SourceInput, type SourceOutlineNode } from '../workspace';
import { createSequentialIdGenerator, type IdGenerator } from '../ids';
import { assertWorkspaceInvariants } from '../invariants';
import { effectiveLabels } from '../labels';
import { getDocument } from '../selectors';
import { createWorkspace } from '../workspace';
import type { DocumentId, PageId, Rotation, Workspace } from '../types';

export const LETTER = { width: 612, height: 792 } as const;

export const NO_FLAGS = {
  encrypted: false,
  repaired: false,
  hasAcroForm: false,
  hasXfa: false,
  hasSignatures: false,
  tagged: false,
  linearized: false,
} as const;

export function sourceInput(
  name: string,
  pageCount: number,
  options: {
    readonly labels?: readonly string[];
    readonly outline?: readonly SourceOutlineNode[];
    readonly rotations?: readonly Rotation[];
  } = {},
): SourceInput {
  return {
    name,
    byteLength: 1000 * pageCount,
    pageCount,
    pages: Array.from({ length: pageCount }, (_, i) => {
      const label = options.labels?.[i];
      const base = { size: LETTER, rotation: options.rotations?.[i] ?? 0 };
      return label === undefined ? base : { ...base, label };
    }),
    fingerprint: `fp-${name}`,
    flags: NO_FLAGS,
    metadata: { title: `${name} title`, author: 'Author', policy: 'explicit' },
    outline: options.outline ?? [],
  };
}

/** Outline with one node per page: "<prefix> p<n>" pointing at page n (0-based). */
export function pageOutline(prefix: string, pageCount: number): SourceOutlineNode[] {
  return Array.from({ length: pageCount }, (_, i) => ({
    title: `${prefix} p${i + 1}`,
    destination: { kind: 'page', pageIndex: i },
    open: false,
    children: [],
  }));
}

export interface Fixture {
  readonly ws: Workspace;
  readonly ids: IdGenerator;
  readonly docs: readonly DocumentId[];
}

/** Opens one document per spec: [name, pageCount, options?]. */
export function open(
  ...specs: readonly (
    | readonly [string, number]
    | readonly [string, number, Parameters<typeof sourceInput>[2]]
  )[]
): Fixture {
  const ids = createSequentialIdGenerator('t');
  let ws = createWorkspace();
  const docs: DocumentId[] = [];
  for (const [name, count, options] of specs) {
    const result = addSource(ws, sourceInput(name, count, options ?? {}), ids);
    ws = result.workspace;
    docs.push(result.documentId);
  }
  return { ws: check(ws), ids, docs };
}

export function check(ws: Workspace): Workspace {
  assertWorkspaceInvariants(ws);
  return ws;
}

export function pageIds(ws: Workspace, doc: DocumentId): PageId[] {
  return getDocument(ws, doc).pages.map((p) => p.id);
}

/** Short page names: source name + 1-based source page, e.g. "A1", "B3", "blank". */
export function names(ws: Workspace, doc: DocumentId): string[] {
  return getDocument(ws, doc).pages.map((p) => {
    if (p.ref.kind !== 'source') return p.ref.kind;
    const source = ws.sources[p.ref.source];
    return `${source?.name ?? '?'}${p.ref.index + 1}`;
  });
}

export function labelsOf(ws: Workspace, doc: DocumentId): string[] {
  return effectiveLabels(ws, getDocument(ws, doc));
}

export function outlineTitles(ws: Workspace, doc: DocumentId): string[] {
  const out: string[] = [];
  const walk = (nodes: ReturnType<typeof getDocument>['outline'], depth: number): void => {
    for (const n of nodes) {
      const status = n.destination?.kind === 'unresolved' ? ' (unresolved)' : '';
      out.push(`${'  '.repeat(depth)}${n.title}${status}`);
      walk(n.children, depth + 1);
    }
  };
  walk(getDocument(ws, doc).outline, 0);
  return out;
}

/** Asserts that `fn` throws a DocumentModelError with `code`. */
export function expectCode(fn: () => unknown, code: DocumentModelErrorCode): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(
    isDocumentModelError(thrown),
    `expected DocumentModelError(${code}), got ${String(thrown)}`,
  ).toBe(true);
  expect((thrown as { code: string }).code).toBe(code);
}

type Tuple<N extends number, R extends PageId[] = []> = R['length'] extends N
  ? R
  : Tuple<N, [...R, PageId]>;

/** Page ids of a document as a fixed-length tuple (asserts the length). */
export function pageTuple<N extends number>(ws: Workspace, doc: DocumentId, n: N): Tuple<N> {
  const ids = pageIds(ws, doc);
  if (ids.length !== n) throw new Error(`expected ${n} pages, found ${ids.length}`);
  return ids as Tuple<N>;
}

/** Unwraps a value that the test setup guarantees to exist. */
export function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}
