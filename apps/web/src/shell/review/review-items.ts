/**
 * The Review tab's one list (experience-redesign §4.1): the active document's comments and
 * other annotations, the redaction marks of every open document (they are applied and
 * stepped with J / K across the workspace, as the Redactions panel listed them), and the
 * active document's form fields, in document order, then page order. Pure functions over
 * the stores, plus the hooks the rail (counts) and the panel (rows) share.
 */
import type {
  DocumentId,
  PageId,
  SourceId,
  VirtualDocument,
  Workspace,
} from '@pdf-editor/document-model';
import type { Annotation } from '@pdf-editor/engine';
import { useEffect, useMemo } from 'react';

import { pageKey, useAnnotationStore } from '../../annotations/annotation-store';
import { documentSources, type FieldStop, fieldStops, useFormStore } from '../../forms/form-store';
import { isRedactMark } from '../../redaction/marks';
import { markKeyOf, type MarkEntry } from '../../redaction/redaction-store';
import type { ReviewFilter } from '../../state/ui-store';
import { useWorkspaceStore } from '../../state/workspace-store';

interface ItemBase {
  /** Unique in the list. */
  readonly key: string;
  readonly documentId: DocumentId;
  readonly documentTitle: string;
  readonly pageId: PageId;
  /** 1-based position of the page in its document. */
  readonly position: number;
}

export interface CommentItem extends ItemBase {
  readonly kind: 'comment';
  readonly source: SourceId;
  readonly sourceIndex: number;
  readonly annotation: Annotation;
}

export interface MarkItem extends ItemBase {
  readonly kind: 'mark';
  readonly entry: MarkEntry;
}

export interface FieldItem extends ItemBase {
  readonly kind: 'field';
  readonly stop: FieldStop;
}

export type ReviewItem = CommentItem | MarkItem | FieldItem;
export type ReviewKind = ReviewItem['kind'];

export interface ReviewData {
  readonly items: readonly ReviewItem[];
  /** Some pages or form fields have not been read yet. */
  readonly loading: boolean;
}

type FormSources = Parameters<typeof fieldStops>[1];

interface PageEntryLike {
  readonly annotations: readonly Annotation[];
}

const FILTER_KIND: Readonly<Record<Exclude<ReviewFilter, 'all'>, ReviewKind>> = {
  comments: 'comment',
  redactions: 'mark',
  fields: 'field',
};

/** Form rows: one per field and page (a field with several widgets on a page is one row). */
export function fieldRows(doc: VirtualDocument, sources: FormSources): FieldStop[] {
  const rows: FieldStop[] = [];
  for (const stop of fieldStops(doc, sources)) {
    if (
      !rows.some(
        (r) =>
          r.source === stop.source &&
          r.fieldId === stop.fieldId &&
          r.name === stop.name &&
          r.pageId === stop.pageId,
      )
    ) {
      rows.push(stop);
    }
  }
  return rows;
}

/** Every review item of the workspace, in tab order, then page order (fields last on a page). */
export function collectReviewItems(
  workspace: Workspace,
  pages: Readonly<Record<string, PageEntryLike | undefined>>,
  formSources: FormSources,
): ReviewData {
  const items: ReviewItem[] = [];
  let loading = false;
  for (const documentId of workspace.documentOrder) {
    const doc = workspace.documents[documentId];
    if (!doc) continue;
    const active = documentId === workspace.activeDocument;
    const fields = active ? fieldRows(doc, formSources) : [];
    if (active && documentSources(doc).some((id) => formSources[id]?.loaded !== true)) {
      loading = true;
    }
    doc.pages.forEach((page, i) => {
      const base = { documentId, documentTitle: doc.title, pageId: page.id, position: i + 1 };
      if (page.ref.kind === 'source') {
        const { source, index } = page.ref;
        const entry = pages[pageKey(source, index)];
        if (!entry) loading = true;
        for (const a of entry?.annotations ?? []) {
          if (a.flags?.hidden || a.kind === 'link') continue;
          if (isRedactMark(a)) {
            const key = `${page.id}\u0000${a.id}`;
            items.push({
              ...base,
              kind: 'mark',
              key: `mark:${key}`,
              entry: {
                key,
                markKey: markKeyOf(source, a.id),
                documentId,
                documentTitle: doc.title,
                pageId: page.id,
                position: i + 1,
                source,
                sourceIndex: index,
                mark: a,
              },
            });
          } else if (active) {
            items.push({
              ...base,
              kind: 'comment',
              key: `comment:${page.id}\u0000${a.id}`,
              source,
              sourceIndex: index,
              annotation: a,
            });
          }
        }
      }
      for (const stop of fields) {
        if (stop.pageId !== page.id) continue;
        items.push({
          ...base,
          kind: 'field',
          key: `field:${page.id}\u0000${stop.source ?? stop.fieldId ?? ''}\u0000${stop.name}`,
          stop,
        });
      }
    });
  }
  return { items, loading };
}

export function filterItems(items: readonly ReviewItem[], filter: ReviewFilter): ReviewItem[] {
  if (filter === 'all') return [...items];
  const kind = FILTER_KIND[filter];
  return items.filter((item) => item.kind === kind);
}

export type ReviewCounts = Readonly<Record<ReviewFilter, number>>;

export function countItems(items: readonly ReviewItem[]): ReviewCounts {
  let comments = 0;
  let redactions = 0;
  let fields = 0;
  for (const item of items) {
    if (item.kind === 'comment') comments++;
    else if (item.kind === 'mark') redactions++;
    else fields++;
  }
  return { all: items.length, comments, redactions, fields };
}

export interface ReviewGroup {
  readonly key: string;
  readonly documentId: DocumentId;
  readonly documentTitle: string;
  /** The first group of a document, when the list spans several documents. */
  readonly showDocument: boolean;
  readonly pageId: PageId;
  readonly position: number;
  readonly items: ReviewItem[];
}

/** Consecutive items of one page form a group; documents are named when there are several. */
export function groupItems(items: readonly ReviewItem[]): ReviewGroup[] {
  const several = new Set(items.map((item) => item.documentId)).size > 1;
  const groups: ReviewGroup[] = [];
  let lastDocument: DocumentId | undefined;
  for (const item of items) {
    const key = `${item.documentId}\u0000${item.pageId}`;
    const last = groups[groups.length - 1];
    if (last?.key === key) {
      last.items.push(item);
      continue;
    }
    groups.push({
      key,
      documentId: item.documentId,
      documentTitle: item.documentTitle,
      showDocument: several && item.documentId !== lastDocument,
      pageId: item.pageId,
      position: item.position,
      items: [item],
    });
    lastDocument = item.documentId;
  }
  return groups;
}

/** The review items of the open documents, from what the stores have read so far. */
export function useReviewData(): ReviewData {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const pages = useAnnotationStore((s) => s.pages);
  const formSources = useFormStore((s) => s.sources);
  return useMemo(
    () => collectReviewItems(workspace, pages, formSources),
    [workspace, pages, formSources],
  );
}

/**
 * Reads what the list needs: the annotations of every page of every open document and the
 * active document's form fields (each read once; the stores cache them).
 */
export function useReadReviewData(): void {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const ensurePage = useAnnotationStore((s) => s.ensurePage);
  const ensureSource = useFormStore((s) => s.ensureSource);
  useEffect(() => {
    for (const id of workspace.documentOrder) {
      const doc = workspace.documents[id];
      if (!doc) continue;
      for (const page of doc.pages) {
        if (page.ref.kind === 'source') ensurePage(page.ref.source, page.ref.index);
      }
      if (id === workspace.activeDocument) {
        for (const source of documentSources(doc)) ensureSource(source);
      }
    }
  }, [workspace, ensurePage, ensureSource]);
}
