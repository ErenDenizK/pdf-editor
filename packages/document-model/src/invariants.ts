/**
 * Structural invariants of a Workspace. Every operation must preserve them; tests assert
 * them after each step and deserialization checks them on load.
 */
import { DocumentModelError } from './errors';
import { isPositiveFinite, isRotation, lookup } from './internal';
import { documentFieldProblems } from './fields';
import { PAGE_LABEL_STYLES } from './labels';
import { walkOutline } from './outline';
import { resizeProblem } from './resize';
import type { DocumentId, PageId, SourceDocument, VirtualDocument, Workspace } from './types';

/** Returns a list of human-readable violations (empty when the workspace is valid). */
export function checkWorkspaceInvariants(ws: Workspace): string[] {
  const problems: string[] = [];
  const report = (message: string): void => {
    problems.push(message);
  };

  // Sources
  for (const [key, source] of Object.entries<SourceDocument>(ws.sources)) {
    if (source.id !== key) report(`source record key ${key} holds source ${source.id}`);
    if (source.pages.length !== source.pageCount) {
      report(`source ${key}: pageCount ${source.pageCount} != pages.length ${source.pages.length}`);
    }
    source.pages.forEach((page, i) => {
      if (!isRotation(page.rotation)) report(`source ${key} page ${i}: invalid rotation`);
      if (!isPositiveFinite(page.size.width) || !isPositiveFinite(page.size.height)) {
        report(`source ${key} page ${i}: invalid size`);
      }
    });
  }

  // Documents and tab order
  const keys = Object.keys(ws.documents) as DocumentId[];
  const orderSet = new Set(ws.documentOrder);
  if (orderSet.size !== ws.documentOrder.length) report('documentOrder contains duplicates');
  if (orderSet.size !== keys.length || !keys.every((k) => orderSet.has(k))) {
    report('documentOrder is not a permutation of documents');
  }
  if (ws.activeDocument !== undefined && lookup(ws.documents, ws.activeDocument) === undefined) {
    report(`activeDocument ${ws.activeDocument} does not exist`);
  }

  const owner = new Map<PageId, DocumentId>();
  const fieldOwner = new Map<string, DocumentId>();
  for (const [key, doc] of Object.entries<VirtualDocument>(ws.documents)) {
    if (doc.id !== key) report(`document record key ${key} holds document ${doc.id}`);
    const where = `document ${key}`;
    const ownPages = new Set<PageId>();
    doc.pages.forEach((page, i) => {
      const previous = owner.get(page.id);
      if (previous !== undefined) {
        report(`page ${page.id} appears in ${previous} and ${key}`);
      }
      owner.set(page.id, doc.id);
      ownPages.add(page.id);
      if (!isRotation(page.rotation)) report(`${where} page ${i}: invalid rotation`);
      const ref = page.ref;
      if (ref.kind === 'source') {
        const source = lookup(ws.sources, ref.source);
        if (source === undefined) {
          report(`${where} page ${i}: dangling source ${ref.source}`);
        } else if (!Number.isInteger(ref.index) || ref.index < 0 || ref.index >= source.pageCount) {
          report(`${where} page ${i}: source index ${ref.index} out of range`);
        }
      } else if (!isPositiveFinite(ref.size.width) || !isPositiveFinite(ref.size.height)) {
        report(`${where} page ${i}: invalid ${ref.kind} size`);
      }
      if (
        page.cropBox !== undefined &&
        (!isPositiveFinite(page.cropBox.width) || !isPositiveFinite(page.cropBox.height))
      ) {
        report(`${where} page ${i}: invalid crop box`);
      }
      if (page.resize !== undefined) {
        const problem = resizeProblem(page.resize);
        if (problem !== undefined) report(`${where} page ${i}: ${problem}`);
      }
    });

    walkOutline(doc.outline, (node) => {
      const dest = node.destination;
      if (dest?.kind === 'page' && !ownPages.has(dest.page)) {
        report(`${where}: outline "${node.title}" targets page ${dest.page} outside the document`);
      }
      if (dest?.kind === 'unresolved' && dest.previous && ownPages.has(dest.previous.page)) {
        report(`${where}: outline "${node.title}" is unresolved although its page is present`);
      }
    });

    // Created form fields: unique names and ids, valid properties, widgets on own pages.
    for (const problem of documentFieldProblems(ws, doc)) report(problem);
    for (const field of doc.fields ?? []) {
      const previous = fieldOwner.get(field.id);
      if (previous !== undefined && previous !== doc.id) {
        report(`field ${field.id} appears in ${previous} and ${key}`);
      }
      fieldOwner.set(field.id, doc.id);
    }

    let previousStart = -1;
    for (const range of doc.labels) {
      if (
        !Number.isInteger(range.startIndex) ||
        range.startIndex <= previousStart ||
        range.startIndex >= doc.pages.length
      ) {
        report(`${where}: label range at ${range.startIndex} out of order or out of range`);
      }
      if (!PAGE_LABEL_STYLES.includes(range.style)) report(`${where}: invalid label style`);
      if (
        range.firstNumber !== undefined &&
        (!Number.isSafeInteger(range.firstNumber) || range.firstNumber < 1)
      ) {
        report(`${where}: label firstNumber must be >= 1`);
      }
      previousStart = range.startIndex;
    }
  }

  for (const edit of ws.engineEdits) {
    const source = lookup(ws.sources, edit.source);
    if (source === undefined) report(`engine edit ${edit.id}: dangling source ${edit.source}`);
    else if (edit.pageIndex < 0 || edit.pageIndex >= source.pageCount) {
      report(`engine edit ${edit.id}: page index out of range`);
    }
  }
  return problems;
}

/** Throws `invariant-violation` listing every problem found. */
export function assertWorkspaceInvariants(ws: Workspace): void {
  const problems = checkWorkspaceInvariants(ws);
  if (problems.length > 0) {
    throw new DocumentModelError(
      'invariant-violation',
      `Workspace invariants violated:\n- ${problems.join('\n- ')}`,
    );
  }
}
